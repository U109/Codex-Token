const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = import('../src/core/pricing.mjs');
function request(overrides = {}) {
  return {
    provider: 'openai',
    model: 'gpt-6.1-sol',
    priceVersion: 'official-usd-2026-10-15',
    startedAt: '2026-10-15T04:30:00Z',
    billingMode: 'api',
    endpoint: 'global',
    modality: 'text',
    serviceTier: 'standard',
    fastEnabled: false,
    usage: {
      input: 3600,
      cachedRead: 2400,
      cachedWrite: 0,
      output: 520,
      reasoning: 120,
      total: 4120,
    },
    ...overrides,
  };
}
test('official standard price subtracts cache from input and never re-adds reasoning', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  const result = estimate(request());
  assert.equal(result.status, 'estimated');
  assert.equal(result.amountUSD, 0.00784);
  assert.deepEqual(result.tokens, { input: 1200, cachedRead: 2400, cachedWrite: 0, output: 520 });
  assert.equal(
    estimate(request({ usage: { ...request().usage, reasoning: 520 } })).amountUSD,
    result.amountUSD,
  );
});
test('explicit public standard reference supports configured custom-provider models without asserting API billing', async () => {
  const { estimateStandardReference, formatReferenceCost, estimateRequestCost } = await pricing;
  const value = {
    model: { id: 'gpt-6.1-sol', provider: 'cpa', basis: 'configured' },
    requestCount: 1,
    usage: {
      inputTokens: 25272,
      cachedInputTokens: 18048,
      cacheWriteInputTokens: 0,
      outputTokens: 14,
      totalTokens: 25286,
    },
  };
  const result = estimateStandardReference(value);
  assert.equal(result.status, 'reference');
  assert.equal(result.amountUSD, 0.0163928);
  assert.equal(formatReferenceCost(result), '≈ $0.0164');
  assert.match(result.message, /标准档.*不代表/);
  assert.equal(
    estimateRequestCost({ ...value.model, usage: value.usage }).status,
    'unknown',
    'The strict billing estimator remains unchanged',
  );
  for (const altered of [
    { ...value, model: { id: 'opaque/0123456789' } },
    { ...value, usage: { ...value.usage, cachedInputTokens: null } },
    { ...value, requestCount: 0 },
    { ...value, usage: { ...value.usage, totalTokens: 1 } },
  ])
    assert.equal(estimateStandardReference(altered).status, 'unknown');
});
test('multi-request reference bounds do not apply the long-context rate to an aggregate input as a known per-request rate', async () => {
  const { estimateStandardReference, formatReferenceCost } = await pricing;
  const value = {
    model: { id: 'gpt-6.1-sol' },
    requestCount: 2,
    usage: {
      inputTokens: 300000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      totalTokens: 300100,
    },
  };
  const range = estimateStandardReference(value);
  assert.equal(range.amountUSD, 0.601);
  assert.equal(range.maxAmountUSD, 1.2015);
  assert.match(formatReferenceCost(range), /–/);
  assert.match(range.message, /逐请求/);
  const single = estimateStandardReference({ ...value, requestCount: 1 });
  assert.equal(single.amountUSD, 1.2015);
  assert.equal(single.maxAmountUSD, single.amountUSD);
});
test('request reports choose context tiers individually and validate their aggregate', async () => {
  const { estimateReportedReference, formatReferenceCost } = await pricing;
  const one = {
    inputTokens: 150000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 50,
    reasoningOutputTokens: 0,
    totalTokens: 150050,
  };
  const value = {
    model: { id: 'gpt-6.1-sol' },
    source: { requestCount: 2, coverage: 'observed-turn-reports' },
    usage: { total: { ...one, inputTokens: 300000, outputTokens: 100, totalTokens: 300100 } },
    requestReports: [1, 2].map((sequence) => ({
      sequence,
      model: { id: 'gpt-6.1-sol', basis: 'configured' },
      usage: one,
    })),
  };
  const result = estimateReportedReference(value);
  assert.equal(result.amountUSD, 0.601);
  assert.equal(result.maxAmountUSD, 0.601);
  assert.equal(result.partial, false);
  assert.equal(formatReferenceCost(result), '≈ $0.6010');
  assert.equal(
    estimateReportedReference({
      ...value,
      usage: { total: { ...value.usage.total, inputTokens: 300001 } },
    }).status,
    'unknown',
  );
  const legacy = { ...value };
  delete legacy.requestReports;
  assert.match(formatReferenceCost(estimateReportedReference(legacy)), /–/);
});

test('request-level references preserve multiple models and expose unpriced requests as a partial subtotal', async () => {
  const { estimateReportedReference } = await pricing;
  const one = {
    inputTokens: 150000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 50,
    reasoningOutputTokens: 0,
    totalTokens: 150050,
  };
  const value = {
    source: { requestCount: 2, coverage: 'observed-turn-reports' },
    usage: { total: { ...one, inputTokens: 300000, outputTokens: 100, totalTokens: 300100 } },
    requestReports: [
      { sequence: 1, model: { id: 'gpt-6.1-sol' }, usage: one },
      { sequence: 2, model: { id: 'gpt-6-astra' }, usage: one },
    ],
  };
  const mixed = estimateReportedReference(value);
  assert.equal(mixed.amountUSD, 1.803);
  assert.equal(mixed.groups.length, 2);
  assert.deepEqual(
    mixed.groups.map((g) => g.model.id),
    ['gpt-6.1-sol', 'gpt-6-astra'],
  );
  const unknown = {
    ...value,
    requestReports: [value.requestReports[0], { ...value.requestReports[1], model: {} }],
  };
  const partial = estimateReportedReference(unknown);
  assert.equal(partial.amountUSD, 0.3005);
  assert.equal(partial.partial, true);
  assert.equal(partial.pricedRequestCount, 1);
  assert.equal(partial.unpricedRequestCount, 1);
  assert.equal(
    estimateReportedReference({ ...value, source: { ...value.source, coverage: 'partial' } })
      .partial,
    true,
  );
  assert.equal(
    estimateReportedReference({
      ...value,
      requestReports: [value.requestReports[0], value.requestReports[0]],
    }).status,
    'unknown',
  );
});

test('Fast marker is a strict setting flag, not an implicit price multiplier', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  assert.equal(
    estimate(request({ fastEnabled: true })).amountUSD,
    0.00784,
    'Explicit standard billing wins over a requested Fast setting',
  );
  assert.equal(estimate(request({ fastEnabled: true, serviceTier: 'fast' })).amountUSD, 0.01568);
  assert.equal(
    estimate(request({ serviceTier: 'priority' })).amountUSD,
    0.01568,
    'Documented OpenAI tier alias',
  );
  assert.equal(estimate(request({ fastEnabled: true, serviceTier: null })).amountUSD, null);
  assert.equal(estimate(request({ fastEnabled: true, serviceTier: null })).fast, true);
  assert.equal(estimate(request({ fastEnabled: 'true' })).fast, false);
});
test('OpenAI context threshold includes cached input, with exact boundary handling', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
    const short = estimate(
      request({
        model,
        usage: { input: 272000, cachedRead: 271000, cachedWrite: 0, output: 1000 },
      }),
    );
    const long = estimate(
      request({
        model,
        usage: { input: 272001, cachedRead: 271001, cachedWrite: 0, output: 1000 },
      }),
    );
    assert.equal(short.contextBand, 'short');
    assert.equal(long.contextBand, 'long');
    assert.equal(long.rates.input, short.rates.input * 2);
    assert.equal(long.rates.output, short.rates.output * 1.5);
    assert.equal(
      estimate(
        request({
          model,
          serviceTier: 'fast',
          usage: { input: 272001, cachedRead: 271001, cachedWrite: 0, output: 1000 },
        }),
      ).contextBand,
      'long',
    );
  }
});
test('cache writes are charged instead of uncached input, not added twice', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  const result = estimate(
    request({ usage: { input: 3000, cachedRead: 1000, cachedWrite: 500, output: 0 } }),
  );
  assert.deepEqual(result.tokens, { input: 1500, cachedRead: 1000, cachedWrite: 500, output: 0 });
  assert.equal(result.amountUSD, 0.00435);
  for (const cachedWrite of [null, undefined, -1, 2001]) {
    assert.equal(
      estimate(request({ usage: { input: 3000, cachedRead: 1000, cachedWrite, output: 0 } }))
        .reason,
      'writes',
    );
  }
});
test('unmatched models/providers, prototype keys and unpriced tiers cannot fall back', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  for (const change of [
    { model: 'gpt-6.1-sol-unknown' },
    { model: '__proto__' },
    { provider: 'toString' },
    { provider: 'proxy' },
    { model: 'gpt-5.4' },
    { model: 'gpt-6-luna', serviceTier: 'ultrafast' },
  ]) {
    assert.equal(estimate(request(change)).status, 'unknown');
  }
});
test('missing/invalid counts and inconsistent totals stay unknown, unlike real zero', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  for (const field of ['input', 'cachedRead', 'output']) {
    for (const value of [null, undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        estimate(request({ usage: { ...request().usage, [field]: value } })).status,
        'unknown',
      );
    }
  }
  for (const change of [{ cachedRead: 3601 }, { reasoning: 521 }, { total: 1 }]) {
    assert.equal(estimate(request({ usage: { ...request().usage, ...change } })).status, 'unknown');
  }
  const zero = estimate(
    request({ usage: { input: 0, cachedRead: 0, cachedWrite: 0, output: 0, total: 0 } }),
  );
  assert.equal(zero.amountUSD, 0);
});
test('billing, endpoint, modality, request time and price version must be explicit', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  for (const change of [
    { priceVersion: undefined },
    { priceVersion: 'old' },
    { startedAt: null },
    { startedAt: '2026-10-15' },
    { startedAt: '2026-10-15T12:30:00' },
    { startedAt: '2027-02-30T00:00:00Z' },
    { startedAt: '2026-10-13T00:00:00Z' },
    { billingMode: 'subscription' },
    { billingMode: 'free' },
    { endpoint: null },
    { endpoint: 'regional' },
    { modality: 'audio' },
  ]) {
    assert.equal(estimate(request(change)).status, 'unknown', JSON.stringify(change));
  }
});
test('DeepSeek uses confirmed peak/off-peak tables, not clock or holiday guesses', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  const sample = request({
    provider: 'deepseek',
    model: 'deepseek-flash',
    billingPeriod: 'off-peak',
  });
  assert.equal(estimate(sample).amountUSD, 0.0004992);
  assert.equal(estimate({ ...sample, billingPeriod: 'peak' }).amountUSD, 0.0009984);
  assert.equal(estimate({ ...sample, billingPeriod: null }).reason, 'period');
  assert.equal(estimate({ ...sample, model: 'deepseek-v4-flash' }).model, 'deepseek-flash');
  assert.equal(
    estimate({ ...sample, model: 'deepseek-v4.1-flash' }).status,
    'unknown',
    'Version label is not a documented API alias',
  );
  assert.equal(estimate({ ...sample, serviceTier: 'fast', fastEnabled: true }).status, 'unknown');
  assert.equal(estimate({ ...sample, model: 'deepseek-v4-pro' }).rates.output, 1.98);
});
test('Gemini promotion uses request start instant, not render time', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  const sample = request({ provider: 'google', model: 'gemini-4-argon' });
  assert.equal(estimate(sample).amountUSD, 0.00784);
  assert.equal(
    estimate({ ...sample, serviceTier: 'priority', fastEnabled: true }).amountUSD,
    0.014112,
  );
  const before = estimate({ ...sample, startedAt: '2026-11-29T00:00:00Z' });
  const after = estimate({ ...sample, startedAt: '2026-12-02T00:00:00Z' });
  assert.equal(before.amountUSD, 0.00784);
  assert.equal(after.amountUSD, 0.01568);
  for (const startedAt of ['2026-12-01T07:59:59+08:00', '2026-12-01T08:00:00+08:00']) {
    assert.equal(
      estimate({ ...sample, startedAt }).reason,
      'schedule',
      'No invented promotion rollover timezone',
    );
  }
  assert.equal(
    estimate({ ...sample, usage: { ...sample.usage, cachedWrite: 1 } }).reason,
    'writes',
  );
  const flash = { ...sample, model: 'gemini-3.8-flash', serviceTier: 'priority' };
  assert.equal(estimate(flash).rates.input, 1.35);
  assert.equal(estimate({ ...flash, startedAt: '2027-01-02T00:00:00Z' }).rates.input, 2.7);
});
test('Gemini 2.5 Pro long context is selected per request at >200k', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  const sample = request({ provider: 'google', model: 'gemini-2.5-pro' });
  for (const [input, expected] of [
    [200000, 1.25],
    [200001, 2.5],
  ]) {
    assert.equal(
      estimate({ ...sample, usage: { input, cachedRead: 190000, output: 1 } }).rates.input,
      expected,
    );
  }
  assert.equal(estimate({ ...sample, serviceTier: 'priority' }).status, 'unknown');
});
test('formatting distinguishes unknown, zero and tiny nonzero costs', async () => {
  const { formatCost } = await pricing;
  assert.equal(formatCost({ status: 'unknown' }), '暂无法估算');
  assert.equal(formatCost({ status: 'estimated', amountUSD: 0 }), '≈ $0.0000');
  assert.equal(formatCost({ status: 'estimated', amountUSD: 3e-9 }), '≈ <$0.000001');
  assert.equal(formatCost({ status: 'estimated', amountUSD: 0.01568 }), '≈ $0.0157');
});
