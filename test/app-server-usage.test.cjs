const test = require('node:test');
const assert = require('node:assert/strict');
const api = Promise.all([
  import('../src/host/app-server-usage.mjs'),
  import('../src/core/message-usage.mjs'),
]);
const usage = (inputTokens) => ({
  inputTokens,
  outputTokens: inputTokens / 10,
  totalTokens: inputTokens + inputTokens / 10,
  cachedInputTokens: inputTokens / 2,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: inputTokens / 20,
});
const sum = (...values) =>
  Object.fromEntries(
    Object.keys(values[0]).map((field) => [field, values.reduce((n, v) => n + v[field], 0)]),
  );
async function fixture(options) {
  const [{ createAppServerUsageCollector }, records] = await api;
  const diagnostics = [];
  const collector = createAppServerUsageCollector({
    onDiagnostic: (d) => diagnostics.push(d),
    ...options,
  });
  const send = (method, params, hostId = 'local') => collector.ingest({ hostId, method, params });
  return {
    collector,
    diagnostics,
    send,
    records,
    start: (threadId = 'A', turnId = 't1', host) =>
      send('turn/started', { threadId, turn: { id: turnId } }, host),
    report: (last, total = last, threadId = 'A', turnId = 't1', host) =>
      send('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last, total } }, host),
    finish: (threadId = 'A', turnId = 't1', itemId = 'm1', status = 'completed', host) =>
      send(
        'turn/completed',
        {
          threadId,
          turn: {
            id: turnId,
            status,
            durationMs: 999999,
            items: [{ type: 'agentMessage', id: itemId, text: 'PRIVATE_RESPONSE' }],
          },
        },
        host,
      ),
    get: (threadId = 'A', itemId = 'm1', hostId = 'local') =>
      records.getMessageUsage(collector.getIndex(), threadId, itemId, hostId),
  };
}

test('model request speed excludes overlapping local tools once and freezes between usage reports', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock }),
    a = usage(1000);
  const tool = (method, type, id) =>
    f.send(method, {
      threadId: 'A',
      turnId: 't1',
      item: { type, id, command: 'PRIVATE_COMMAND', arguments: { text: 'PRIVATE_ARGS' } },
    });
  f.start();
  clock = 1000;
  f.report(a);
  const first = f.collector.getActive()[0].modelTiming;
  tool('item/started', 'commandExecution', 'cmd');
  tool('item/started', 'commandExecution', 'cmd');
  clock = 2000;
  tool('item/started', 'mcpToolCall', 'mcp');
  clock = 5000;
  tool('item/completed', 'commandExecution', 'cmd');
  tool('item/completed', 'commandExecution', 'cmd');
  clock = 6000;
  f.collector.tick();
  assert.deepEqual(f.collector.getActive()[0].modelTiming, first);
  clock = 7000;
  tool('item/completed', 'mcpToolCall', 'mcp');
  clock = 8000;
  f.report(a, sum(a, a));
  f.report(a, sum(a, a));
  const measured = f.collector.getActive()[0].modelTiming;
  assert.equal(measured.durationMs, 2000);
  assert.equal(measured.outputTokens, 200);
  assert.equal(measured.samples, 2);
  assert.equal(measured.excludedToolMs, 6000);
  assert.equal(measured.excludesTools, true);
  clock = 20000;
  f.finish();
  assert.deepEqual(f.get().modelTiming, measured);
  const restored = f.records.parseMessageUsage(
    f.records.serializeMessageUsage(f.collector.getIndex()),
  );
  assert.deepEqual(restored.records[0].modelTiming, measured);
  assert.doesNotMatch(f.records.serializeMessageUsage(restored), /PRIVATE_/);
});

test('context compaction output retains its model time in both native and local timing', async () => {
  for (const source of ['native', 'local']) {
    let clock = 0;
    const f = await fixture({ now: () => clock }),
      first = usage(4000),
      compacted = usage(56000);
    const report = (value, total, responseId) =>
      source === 'native'
        ? f.report(value, total)
        : f.collector.ingestLocalRecords([
            {
              threadId: 'A',
              turnId: 't1',
              responseId,
              usage: value,
              checkpoint: { total, turnTotal: total },
              replay: false,
            },
          ]);
    const item = (method, type, id) =>
      f.send(method, { threadId: 'A', turnId: 't1', item: { type, id } });
    f.start();
    clock = 10000;
    report(first, first, 'r1');
    item('item/started', 'commandExecution', 'tool');
    clock = 18000;
    item('item/completed', 'commandExecution', 'tool');
    item('item/started', 'contextCompaction', 'compaction');
    clock = 158000;
    report(compacted, sum(first, compacted), 'r2');
    item('item/completed', 'contextCompaction', 'compaction');
    const measured = f.collector.getActive()[0].modelTiming;
    assert.equal(measured.durationMs, 150000, source);
    assert.equal(measured.outputTokens, 6000, source);
    assert.equal(measured.excludedToolMs, 8000, source);
    assert.equal(measured.samples, 2, source);
    const { calculateModelSpeed } = await import('../src/core/usage-metrics.mjs');
    assert.equal(calculateModelSpeed(measured), 40, source);
    f.finish();
    assert.deepEqual(f.get().modelTiming, measured, source);
  }
});

test('missing starts, unmatched tools and disconnects skip uncertain model timing without losing valid samples', async () => {
  let clock = 1000;
  const f = await fixture({ now: () => clock }),
    a = usage(1000);
  f.report(a, usage(5000));
  assert.equal(f.collector.getActive()[0].modelTiming.samples, 0);
  clock = 2000;
  f.send('item/completed', {
    threadId: 'A',
    turnId: 't1',
    item: { type: 'commandExecution', id: 'missed' },
  });
  clock = 3000;
  f.report(a, usage(6000));
  assert.equal(f.collector.getActive()[0].modelTiming.samples, 0);
  clock = 4000;
  f.report(a, usage(7000));
  assert.equal(f.collector.getActive()[0].modelTiming.durationMs, 1000);
  clock = 5000;
  f.collector.disconnect('local');
  clock = 6000;
  f.report(a, usage(8000));
  clock = 8000;
  f.report(a, usage(9000));
  f.finish();
  assert.equal(f.get().modelTiming.durationMs, 3000);
  assert.equal(f.get().modelTiming.outputTokens, 200);
  assert.equal(f.get().modelTiming.samples, 2);
  assert.equal(f.get().modelTiming.coverage, 'partial');
});
test('sums distinct request reports within a turn, not thread total or last request alone', async () => {
  const f = await fixture();
  const a = usage(1000),
    b = usage(2000);
  f.send('thread/started', {
    thread: {
      id: 'A',
      model: 'configured-model',
      modelProvider: 'provider',
      preview: 'PRIVATE_PROMPT',
    },
  });
  f.start();
  f.report(a);
  f.report(a);
  f.report(b, sum(a, b));
  f.finish();
  assert.deepEqual(f.get().usage.total, sum(a, b));
  assert.equal(f.get().source.requestCount, 2);
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
  assert.equal(f.get().model.basis, 'configured');
  assert.deepEqual(f.get().timing, {});
  assert.deepEqual(f.get().pricing, {});
  assert.equal(f.get().observation.scope, 'turn-observed-window');
  assert.notEqual(
    f.get().observation.durationMs,
    999999,
    'Do not reuse the server turn duration as generation timing',
  );
  assert.doesNotMatch(
    f.records.serializeMessageUsage(f.collector.getIndex()),
    /PRIVATE_|preview|text/,
  );
});
test('retains every turn and separates hosts and threads with identical message IDs', async () => {
  const f = await fixture();
  const a = usage(1000),
    b = usage(2000);
  f.start();
  f.report(a);
  f.finish();
  f.start('A', 't2');
  f.report(b, sum(a, b), 'A', 't2');
  f.finish('A', 't2', 'm2');
  f.start('B', 't1');
  f.report(b, b, 'B');
  f.finish('B');
  f.start('A', 't1', 'remote');
  f.report(b, b, 'A', 't1', 'remote');
  f.finish('A', 't1', 'm1', 'completed', 'remote');
  assert.equal(f.get().usage.total.totalTokens, 1100);
  assert.equal(f.get('A', 'm2').usage.total.totalTokens, 2200);
  assert.equal(f.get('B').usage.total.totalTokens, 2200);
  assert.equal(f.get('A', 'm1', 'remote').usage.total.totalTokens, 2200);
});
test('explicit zero reports remain zero even after a prior nonzero turn', async () => {
  const f = await fixture(),
    a = usage(1000),
    zero = usage(0);
  f.start();
  f.report(a);
  f.finish();
  f.start('A', 't2');
  f.report(zero, a, 'A', 't2');
  f.finish('A', 't2', 'm2');
  assert.equal(f.get('A', 'm2').usage.total.totalTokens, 0);
});
test('incomplete turns retain observed reports without claiming a complete round total', async () => {
  for (const scenario of ['no-start', 'no-usage', 'failed', 'interrupted']) {
    const f = await fixture();
    if (scenario !== 'no-start') f.start();
    if (scenario !== 'no-usage') f.report(usage(1000));
    f.finish(
      'A',
      't1',
      'm1',
      ['failed', 'interrupted'].includes(scenario) ? scenario : 'completed',
    );
    assert.equal(f.get().usage.total.totalTokens, scenario === 'no-usage' ? null : 1100, scenario);
    assert.equal(f.get().source.coverage, scenario === 'no-usage' ? 'unknown' : 'partial');
  }
});
test('counter resets and skipped reports retain only observed requests with partial coverage', async () => {
  for (const secondTotal of [usage(100), usage(3000)]) {
    const f = await fixture();
    f.start();
    f.report(usage(1000));
    f.report(usage(1000), secondTotal);
    f.finish();
    assert.equal(f.get().usage.total.totalTokens, 2200);
    assert.equal(f.get().source.coverage, 'partial');
    assert.ok(f.diagnostics.some((d) => d.code === 'request-report-gap'));
  }
});
test('invalid or conflicting reports are excluded from the observed subtotal', async () => {
  for (const last of [
    { ...usage(1000), inputTokens: -1 },
    { ...usage(1000), cachedInputTokens: 9999 },
    { ...usage(1000), totalTokens: null },
  ]) {
    const f = await fixture();
    f.start();
    f.report(last);
    f.finish();
    assert.equal(f.get().usage.total.totalTokens, null);
  }
  const f = await fixture();
  f.start();
  f.report(usage(1000));
  f.report(usage(500), usage(1000));
  f.finish();
  assert.equal(f.get().usage.total.totalTokens, 1100);
  assert.equal(f.get().source.requestCount, 1);
  assert.equal(f.get().source.coverage, 'partial');
});
test('connection gaps invalidate active turns without erasing already completed history', async () => {
  const f = await fixture();
  f.start();
  f.report(usage(1000));
  f.finish();
  f.start('A', 't2');
  f.report(usage(1000), usage(2000), 'A', 't2');
  f.collector.disconnect('local');
  f.finish('A', 't2', 'm2');
  assert.equal(f.get().usage.total.totalTokens, 1100);
  assert.equal(f.get('A', 'm2').usage.total.totalTokens, 1100);
  assert.equal(f.get('A', 'm2').source.coverage, 'partial');
});
test('joining an existing cumulative history mid-turn keeps the missed start partial', async () => {
  const f = await fixture();
  f.report(usage(1000), usage(5000));
  f.finish();
  assert.equal(f.get().usage.total.totalTokens, 1100);
  assert.equal(f.get().source.coverage, 'partial');
  f.start('A', 't2');
  f.report(usage(1000), usage(6000), 'A', 't2');
  f.finish('A', 't2', 'm2');
  assert.equal(f.get('A', 'm2').usage.total.totalTokens, 1100);
  assert.equal(f.get('A', 'm2').source.coverage, 'observed-turn-reports');
});

test('a fresh collector with an observed start does not confuse old cumulative history with a gap in the current turn', async () => {
  const before = await fixture();
  before.report(usage(1000), usage(5000));
  before.finish();
  const restored = before.records.parseMessageUsage(
    before.records.serializeMessageUsage(before.collector.getIndex()),
  );
  let clock = 0;
  const f = await fixture({ index: restored, now: () => clock });
  const last = {
    inputTokens: 25661,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 8,
    reasoningOutputTokens: 0,
    totalTokens: 25669,
  };
  f.start('A', 't2');
  clock = 2531;
  f.report(last, sum(usage(5000), last), 'A', 't2');
  const live = f.collector.getActive()[0];
  assert.deepEqual(live.usage.total, last);
  assert.equal(live.source.coverage, 'observed-so-far');
  assert.equal(live.source.requestCount, 1);
  assert.equal(live.modelTiming.coverage, 'turn');
  assert.equal(live.modelTiming.durationMs, 2531);
  assert.equal(live.modelTiming.outputTokens, 8);
  assert.equal(f.get().source.coverage, 'partial', 'Older partial records are not promoted');
  const next = usage(1000);
  clock = 4000;
  f.report(next, sum(usage(5000), last, next), 'A', 't2');
  f.finish('A', 't2', 'm2');
  const saved = f.get('A', 'm2');
  assert.deepEqual(saved.usage.total, sum(last, next));
  assert.equal(saved.source.coverage, 'observed-turn-reports');
  assert.equal(saved.source.requestCount, 2);
  assert.equal(saved.observation.coverage, 'turn');
  assert.equal(saved.modelTiming.coverage, 'turn');
  const reloaded = f.records.parseMessageUsage(
    f.records.serializeMessageUsage(f.collector.getIndex()),
  );
  assert.deepEqual(f.records.getMessageUsage(reloaded, 'A', 'm2'), saved);
  assert.deepEqual(f.records.getMessageUsage(reloaded, 'A', 'm1'), restored.records[0]);
  assert.deepEqual(f.diagnostics, []);
});

test('an observed start without old history still preserves actual gaps and disconnects', async () => {
  for (const scenario of [
    'disconnect-before-report',
    'disconnect-after-report',
    'gap-after-report',
  ]) {
    const f = await fixture();
    f.start();
    if (scenario === 'disconnect-before-report') f.collector.disconnect('local');
    f.report(usage(1000), usage(5000));
    if (scenario === 'disconnect-after-report') f.collector.disconnect('local');
    if (scenario === 'gap-after-report') f.report(usage(1000), usage(8000));
    assert.equal(f.collector.getActive()[0].source.coverage, 'partial', scenario);
    f.finish();
    assert.equal(f.get().source.coverage, 'partial', scenario);
    assert.equal(
      f.get().usage.total.totalTokens,
      scenario === 'gap-after-report' ? 2200 : 1100,
      scenario,
    );
  }
});

test('an initial cumulative report must contain a valid history before its last request', async () => {
  const invalidHistories = [
    [usage(2000), usage(1000)],
    [
      { ...usage(1000), cachedInputTokens: 0 },
      { ...usage(2000), cachedInputTokens: 1800 },
    ],
    [
      { ...usage(1000), reasoningOutputTokens: 0 },
      { ...usage(2000), reasoningOutputTokens: 180 },
    ],
  ];
  for (const [last, total] of invalidHistories) {
    const f = await fixture();
    f.start();
    f.report(last, total);
    assert.equal(f.collector.getActive()[0].source.coverage, 'partial');
    f.finish();
    assert.equal(f.get().source.coverage, 'partial');
    assert.ok(f.diagnostics.some((d) => d.code === 'request-report-gap'));
  }
});
test('duplicate completion and replay after restoration cannot erase a known historical value', async () => {
  const f = await fixture();
  f.start();
  f.report(usage(1000));
  f.finish();
  f.finish();
  assert.equal(f.get().usage.total.totalTokens, 1100);
  const restored = f.records.parseMessageUsage(
    f.records.serializeMessageUsage(f.collector.getIndex()),
  );
  const g = await fixture({ index: restored });
  g.start();
  g.report(usage(1000));
  g.finish();
  assert.equal(g.get().usage.total.totalTokens, 1100);
  assert.equal(g.get().revision, 0);
});
test('every assistant item binds to its own exact host/thread/turn identity without storing its body', async () => {
  const f = await fixture();
  f.start();
  f.send('item/completed', {
    threadId: 'A',
    turnId: 't1',
    item: { type: 'agentMessage', id: 'commentary', text: 'PRIVATE_BODY' },
  });
  f.report(usage(1000));
  f.finish();
  assert.equal(f.get('A', 'commentary').turnId, 't1');
  assert.equal(
    f.records.getMessageUsage(f.collector.getIndex(), 'A', 'm1', 'local', 'wrong-turn'),
    null,
  );
  assert.doesNotMatch(f.records.serializeMessageUsage(f.collector.getIndex()), /PRIVATE_|text/);
});
test('mock origin cannot be mixed into live records, malformed events and capacity failures are bounded', async () => {
  const f = await fixture({ maxActiveTurns: 1 });
  f.start();
  assert.equal(f.start('B', 't2').status, 'rejected');
  for (const value of [
    undefined,
    null,
    {},
    { hostId: 'local', method: 'turn/started', params: {} },
  ]) {
    assert.doesNotThrow(() => f.collector.ingest(value));
  }
  const mock = f.records.createMessageUsageIndex([]);
  assert.throws(() => f.collector.mergeIndex(mock), /source/);
  const g = await fixture({ mode: 'local-mock-provider' });
  g.start();
  g.report(usage(1000));
  g.finish();
  assert.equal(g.get().mode, 'local-mock-provider');
});
test('running snapshots update from distinct request reports, preserve zero, and never persist before completion', async () => {
  const updates = [],
    f = await fixture({ onActiveChange: (v) => updates.push(v) }),
    a = usage(1000),
    b = usage(2000);
  f.start();
  assert.deepEqual(f.collector.getActive()[0].usage.total, {});
  f.report(usage(0));
  assert.equal(f.collector.getActive()[0].usage.total.totalTokens, 0);
  f.report(a);
  const first = f.collector.getActive();
  f.report(a);
  assert.equal(
    f.collector.getActive(),
    first,
    'A duplicate notification does not even publish a new snapshot',
  );
  f.report(b, sum(a, b));
  assert.equal(f.collector.getActive()[0].usage.total.totalTokens, 3300);
  assert.equal(f.collector.getActive()[0].source.coverage, 'observed-so-far');
  assert.equal(f.collector.getIndex().records.length, 0);
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_|text/);
  f.finish();
  assert.deepEqual(f.collector.getActive(), []);
  assert.equal(f.get().usage.total.totalTokens, 3300);
});
test('partial live counts remain labeled and available after completion', async () => {
  const f = await fixture();
  f.report(usage(1000), usage(5000));
  assert.equal(f.collector.getActive()[0].source.coverage, 'partial');
  assert.equal(f.collector.getActive()[0].usage.total.totalTokens, 1100);
  f.collector.disconnect('local');
  assert.equal(f.collector.getActive()[0].source.status, 'disconnected');
  f.report(usage(2000), usage(7000));
  assert.equal(f.collector.getActive()[0].source.status, 'inProgress');
  f.finish();
  assert.equal(f.get().usage.total.totalTokens, 3300);
  assert.equal(f.get().source.coverage, 'partial');
  assert.deepEqual(f.collector.getActive(), []);
});

test('completion keeps reported counts and frozen timing when the turn start was missed', async () => {
  let clock = 0;
  const f = await fixture({
    now: () => clock,
    getConfiguredModel: () => ({ id: 'gpt-6.1-sol', basis: 'configured' }),
  });
  const last = {
    inputTokens: 25535,
    cachedInputTokens: 25216,
    cacheWriteInputTokens: 0,
    outputTokens: 52,
    reasoningOutputTokens: 37,
    totalTokens: 25587,
  };
  clock = 5435.7;
  f.report(last, sum(usage(1000), last));
  const live = f.collector.getActive()[0];
  f.finish();
  const saved = f.records.parseMessageUsage(f.records.serializeMessageUsage(f.collector.getIndex()))
    .records[0];
  assert.deepEqual(saved.usage.total, live.usage.total);
  assert.deepEqual(saved.usage.total, last);
  assert.deepEqual(saved.requestReports, live.requestReports);
  assert.deepEqual(saved.observation, live.observation);
  assert.equal(saved.source.coverage, 'partial');
  assert.equal(saved.source.status, 'completed');
  assert.ok(f.diagnostics.some((d) => d.code === 'unknown-initial-baseline'));
});

test('overflowing request sums cannot become inconsistent completed subtotals', async () => {
  const f = await fixture(),
    last = {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    };
  const next = { ...last, inputTokens: 1, totalTokens: 1 };
  f.start();
  f.report(last);
  assert.equal(f.report(next).status, 'rejected');
  f.finish();
  assert.deepEqual(f.get().usage.total, last);
  assert.equal(f.get().source.coverage, 'partial');
  assert.equal(f.get().source.requestCount, 1);
  assert.equal(f.get().requestReports.length, 1);
  assert.ok(f.diagnostics.some((d) => d.code === 'usage-overflow'));
});
test('simultaneous running snapshots stay isolated by host, thread and turn and replay cannot reopen a finished turn', async () => {
  const f = await fixture();
  f.start();
  f.start('B');
  f.start('A', 't1', 'remote');
  f.report(usage(1000));
  f.report(usage(2000), usage(2000), 'B');
  f.report(usage(3000), usage(3000), 'A', 't1', 'remote');
  assert.deepEqual(
    f.collector.getActive().map((r) => [r.hostId, r.threadId, r.usage.total.totalTokens]),
    [
      ['local', 'A', 1100],
      ['local', 'B', 2200],
      ['remote', 'A', 3300],
    ],
  );
  f.finish();
  f.report(usage(1000));
  assert.equal(f.collector.getActive().length, 2);
});
test('native model is captured at the observed start and a repeated setting does not invalidate a reference model', async () => {
  let model = 'gpt-6.1-sol';
  const f = await fixture({
    getConfiguredModel: (hostId, threadId) =>
      hostId === 'local' && threadId === 'A' ? { id: model, basis: 'configured' } : null,
  });
  f.start();
  f.report(usage(1000));
  model = 'gpt-6-astra';
  f.send('thread/settings/updated', {
    threadId: 'A',
    threadSettings: { model: 'gpt-6.1-sol', modelProvider: 'cpa' },
  });
  f.finish();
  assert.equal(f.get().model.id, 'gpt-6.1-sol');
  f.start('A', 't2');
  f.report(usage(1000), usage(2000), 'A', 't2');
  f.send('thread/settings/updated', { threadId: 'A', threadSettings: { model: 'gpt-6-luna' } });
  f.finish('A', 't2', 'm2');
  assert.deepEqual(
    f.get('A', 'm2').model,
    {},
    'Mixed configured models must not become one reference price',
  );
});

test('request reports retain model attribution before a selection change, leave ambiguity unknown, and survive restoration', async () => {
  let model = 'gpt-6.1-sol';
  const f = await fixture({ getConfiguredModel: () => ({ id: model, basis: 'configured' }) });
  const a = usage(1000),
    b = usage(2000);
  f.start();
  f.report(a);
  f.report(a);
  model = 'gpt-6-astra';
  f.collector.configuredModelsChanged();
  f.report(b, sum(a, b));
  f.finish();
  const reports = f.get().requestReports;
  assert.equal(reports.length, 2);
  assert.equal(reports[0].model.id, 'gpt-6.1-sol');
  assert.deepEqual(reports[1].model, {});
  assert.deepEqual(
    reports.map((r) => r.usage),
    [a, b],
  );
  const restored = f.records.parseMessageUsage(
    f.records.serializeMessageUsage(f.collector.getIndex()),
  );
  assert.deepEqual(restored.records[0].requestReports, reports);
  f.start('A', 't2');
  f.report(a, sum(a, b, a), 'A', 't2');
  f.finish('A', 't2', 'm2');
  assert.equal(f.get('A', 'm2').requestReports[0].model.id, 'gpt-6-astra');
});

test('a server reroute attributes only its exact host/thread/turn request and never rewrites earlier reports', async () => {
  const f = await fixture({
      getConfiguredModel: () => ({ id: 'gpt-6-astra', basis: 'configured' }),
    }),
    a = usage(1000);
  f.start();
  f.report(a);
  f.send(
    'model/rerouted',
    { threadId: 'A', turnId: 't1', fromModel: 'gpt-6-astra', toModel: 'gpt-6.1-sol' },
    'remote',
  );
  f.send('model/rerouted', {
    threadId: 'A',
    turnId: 'other',
    fromModel: 'gpt-6-astra',
    toModel: 'gpt-6.1-sol',
  });
  f.report(a, sum(a, a));
  f.send('model/rerouted', {
    threadId: 'A',
    turnId: 't1',
    fromModel: 'gpt-6-astra',
    toModel: 'gpt-6.1-sol',
  });
  f.report(a, sum(a, a, a));
  f.report(a, sum(a, a, a, a));
  f.finish();
  assert.deepEqual(
    f.get().requestReports.map((r) => r.model.id),
    ['gpt-6-astra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-astra'],
  );
  assert.equal(f.get().requestReports[2].model.basis, 'reported');
});

test('observed average includes tool waiting and freezes on completion without using server timing', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock });
  f.start();
  clock = 1000;
  f.report(usage(1000));
  clock = 5000;
  f.collector.tick();
  let o = f.collector.getActive()[0].observation;
  assert.equal(o.durationMs, 5000);
  assert.equal(o.outputTokens, 100);
  assert.equal(o.coverage, 'turn');
  assert.equal(o.includesWaiting, true);
  f.finish();
  clock = 20000;
  f.collector.tick();
  assert.equal(f.get().observation.durationMs, 5000);
  assert.deepEqual(f.get().timing, {});
});

test('mid-turn attachment and reconnection exclude pre-observation output from the speed numerator', async () => {
  let clock = 1000;
  const f = await fixture({ now: () => clock }),
    a = usage(1000);
  f.report(a);
  assert.equal(f.collector.getActive()[0].observation.samples, 0);
  clock = 3000;
  f.report(a, sum(a, a));
  let o = f.collector.getActive()[0].observation;
  assert.equal(o.durationMs, 2000);
  assert.equal(o.outputTokens, 100);
  assert.equal(o.coverage, 'partial');
  f.collector.disconnect('local');
  assert.equal(f.collector.getActive()[0].observation.samples, 0);
  clock = 9000;
  f.report(a, sum(a, a, a));
  assert.equal(f.collector.getActive()[0].observation.samples, 0);
  clock = 11000;
  f.report(a, sum(a, a, a, a));
  o = f.collector.getActive()[0].observation;
  assert.equal(o.durationMs, 2000);
  assert.equal(o.outputTokens, 100);
});

test('an unchanged snapshot from the previous turn is not a request in the new turn', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock }),
    a = usage(1000),
    b = usage(2000);
  f.start();
  clock = 1000;
  f.report(a);
  f.finish();
  const history = f.get();
  f.start('A', 't2');
  const waiting = f.collector.getActive();
  clock = 2000;
  f.report(a, a, 'A', 't2');
  f.report(a, a, 'A', 't2');
  assert.equal(f.collector.getActive(), waiting, 'A repeated snapshot is not fresh usage');
  assert.deepEqual(waiting[0].usage.total, {});
  assert.equal(waiting[0].source.requestCount, 0);
  clock = 4000;
  f.report(b, sum(a, b), 'A', 't2');
  const live = f.collector.getActive()[0];
  assert.deepEqual(live.usage.total, b);
  assert.equal(live.source.requestCount, 1);
  assert.equal(live.source.coverage, 'observed-so-far');
  assert.equal(live.modelTiming.durationMs, 3000);
  assert.equal(live.modelTiming.outputTokens, b.outputTokens);
  f.finish('A', 't2', 'm2');
  assert.deepEqual(f.get('A', 'm2').usage.total, b);
  assert.equal(f.get('A', 'm2').source.coverage, 'observed-turn-reports');
  assert.deepEqual(f.get(), history);
  assert.deepEqual(f.diagnostics, []);
  const restored = f.records.parseMessageUsage(
    f.records.serializeMessageUsage(f.collector.getIndex()),
  );
  assert.deepEqual(f.records.getMessageUsage(restored, 'A', 'm2').usage.total, b);
});

test('a repeated previous-turn snapshot cannot invent an active turn or prove a zero request', async () => {
  for (const a of [usage(1000), usage(0)]) {
    const f = await fixture();
    f.start();
    f.report(a);
    f.finish();
    f.report(a, a, 'A', 't2');
    assert.deepEqual(f.collector.getActive(), []);
    f.start('A', 't2');
    f.report(a, a, 'A', 't2');
    f.finish('A', 't2', 'm2');
    assert.equal(f.get('A', 'm2').usage.total.totalTokens, null);
    assert.equal(f.get('A', 'm2').source.requestCount, 0);
    assert.equal(f.get('A', 'm2').source.coverage, 'unknown');
    assert.deepEqual(f.diagnostics, []);
  }
});

test('replaying an earlier report never rewinds the cumulative baseline or changes valid samples', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock }),
    a = usage(1000),
    b = usage(2000),
    c = usage(3000);
  f.start();
  clock = 1000;
  f.report(a);
  clock = 2000;
  f.report(b, sum(a, b));
  const before = f.collector.getActive();
  clock = 2500;
  f.report(a);
  assert.equal(f.collector.getActive(), before);
  f.report(b, sum(a, b));
  assert.equal(f.collector.getActive(), before);
  clock = 3000;
  f.report(c, sum(a, b, c));
  f.finish();
  assert.deepEqual(f.get().usage.total, sum(a, b, c));
  assert.equal(f.get().source.requestCount, 3);
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
  assert.equal(f.get().modelTiming.durationMs, 3000);
  assert.equal(f.get().modelTiming.samples, 3);
  assert.deepEqual(f.diagnostics, []);
});
