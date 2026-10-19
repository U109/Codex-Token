const test = require('node:test');
const assert = require('node:assert/strict');
const metrics = import('../src/core/usage-metrics.mjs');
const timing = (durationMs) => ({ scope: 'single-model-request', durationMs });

test('speed uses output tokens divided by the timed request seconds', async () => {
  const { calculateTokenSpeed } = await metrics;
  assert.equal(calculateTokenSpeed(520, timing(2000)), 260);
  assert.equal(calculateTokenSpeed(2967, timing(10000)), 296.7);
  assert.equal(calculateTokenSpeed(0, timing(2000)), 0);
});
test('speed never treats missing or invalid output as zero', async () => {
  const { calculateTokenSpeed } = await metrics;
  for (const value of [
    undefined,
    null,
    -1,
    1.5,
    '520',
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(calculateTokenSpeed(value, timing(2000)), null);
  }
});
test('speed requires a finite positive duration with an explicit unit', async () => {
  const { calculateTokenSpeed } = await metrics;
  for (const value of [undefined, null, 0, -1, '2000', NaN, Infinity]) {
    assert.equal(calculateTokenSpeed(520, timing(value)), null);
  }
  assert.equal(calculateTokenSpeed(520, { scope: 'single-model-request', duration: 2 }), null);
});
test('speed rejects whole-turn, multi-request, unscoped and absent timing', async () => {
  const { calculateTokenSpeed } = await metrics;
  for (const value of [
    null,
    {},
    { durationMs: 2000 },
    { scope: 'turn', durationMs: 2000 },
    { scope: 'model-requests', durationMs: 2000 },
  ]) {
    assert.equal(calculateTokenSpeed(520, value), null);
  }
});
test('speed guards against division underflow and infinite results', async () => {
  const { calculateTokenSpeed } = await metrics;
  assert.equal(calculateTokenSpeed(520, timing(Number.MIN_VALUE)), null);
});
test('speed formats one decimal place and preserves unknown versus zero', async () => {
  const { formatTokenSpeed } = await metrics;
  assert.equal(formatTokenSpeed(260), '260.0 token/s');
  assert.equal(formatTokenSpeed(12.34), '12.3 token/s');
  assert.equal(formatTokenSpeed(0), '0.0 token/s');
  for (const value of [null, undefined, -1, '260', NaN, Infinity])
    assert.equal(formatTokenSpeed(value), '— token/s');
});

test('observed averages require their distinct scope and at least one timed report', async () => {
  const { calculateObservedSpeed, calculateTokenSpeed } = await metrics;
  const o = {
    scope: 'turn-observed-window',
    durationMs: 5000,
    outputTokens: 100,
    samples: 1,
    coverage: 'partial',
    includesWaiting: true,
  };
  assert.equal(calculateObservedSpeed(o), 20);
  assert.equal(calculateObservedSpeed({ ...o, outputTokens: 0 }), 0);
  assert.equal(
    calculateTokenSpeed(100, o),
    null,
    'An observed average cannot become generation speed',
  );
  for (const change of [
    { samples: 0 },
    { includesWaiting: false },
    { durationMs: 0 },
    { durationMs: NaN },
    { outputTokens: null },
    { scope: 'turn' },
    { coverage: 'unknown' },
  ])
    assert.equal(calculateObservedSpeed({ ...o, ...change }), null);
});

test('model speed uses only timed request windows and never reuses the old wall clock average', async () => {
  const { calculateModelSpeed } = await metrics;
  const timing = {
    scope: 'model-request-windows',
    basis: 'client-lifecycle',
    excludesTools: true,
    coverage: 'turn',
    samples: 2,
    durationMs: 2000,
    outputTokens: 200,
  };
  assert.equal(calculateModelSpeed(timing), 100);
  assert.equal(calculateModelSpeed({ ...timing, outputTokens: 0 }), 0);
  for (const change of [
    { scope: 'turn-observed-window' },
    { basis: 'unknown' },
    { excludesTools: false },
    { coverage: 'unknown' },
    { samples: 0 },
    { durationMs: 0 },
    { durationMs: Infinity },
    { outputTokens: null },
  ])
    assert.equal(calculateModelSpeed({ ...timing, ...change }), null);
});

test('input, output and cached reads are mutually exclusive and cache hits use all input', async () => {
  const { tokenBreakdown } = await metrics;
  const result = tokenBreakdown({
    inputTokens: 880157,
    outputTokens: 9412,
    cachedInputTokens: 680320,
  });
  assert.equal(result.input, 199837);
  assert.equal(result.output, 9412);
  assert.equal(result.cached, 680320);
  assert.equal(result.input + result.output + result.cached, 889569);
  assert.equal(result.hitRate.toFixed(1), '77.3');
  assert.deepEqual(tokenBreakdown({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }), {
    input: 0,
    output: 0,
    cached: 0,
    hitRate: null,
  });
  for (const cachedInputTokens of [undefined, null, -1, 101, '50']) {
    assert.equal(tokenBreakdown({ inputTokens: 100, cachedInputTokens }).input, null);
    assert.equal(tokenBreakdown({ inputTokens: 100, cachedInputTokens }).hitRate, null);
  }
});
