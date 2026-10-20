const test = require('node:test');
const assert = require('node:assert/strict');
const api = Promise.all([
  import('../src/host/app-server-usage.mjs'),
  import('../src/core/message-usage.mjs'),
]);
const usage = (n) => ({
  inputTokens: n,
  outputTokens: n / 10,
  totalTokens: n + n / 10,
  cachedInputTokens: n / 2,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: n / 20,
});
const sum = (...values) =>
  Object.fromEntries(
    Object.keys(values[0]).map((field) => [
      field,
      values.reduce((n, value) => n + value[field], 0),
    ]),
  );
const a = usage(1000),
  b = usage(2000),
  c = usage(3000);
const local = (responseId, value = a, turnTotal = value, total = turnTotal, extra = {}) => ({
  threadId: 'A',
  turnId: 't1',
  responseId,
  usage: value,
  checkpoint: { total, turnTotal },
  replay: false,
  ...extra,
});
async function fixture(options = {}) {
  const [{ createAppServerUsageCollector }, schema] = await api;
  const diagnostics = [];
  let clock = 0,
    saved = 0;
  const collector = createAppServerUsageCollector({
    now: () => clock,
    onDiagnostic: ({ code }) => diagnostics.push(code),
    onChange: () => saved++,
    ...options,
  });
  const send = (method, params, hostId = 'local') => collector.ingest({ hostId, method, params });
  return {
    collector,
    schema,
    diagnostics,
    clock: (n) => {
      clock = n;
    },
    saved: () => saved,
    start: (threadId = 'A', turnId = 't1', hostId) =>
      send('turn/started', { threadId, turn: { id: turnId } }, hostId),
    report: (last = a, total = last) =>
      send('thread/tokenUsage/updated', {
        threadId: 'A',
        turnId: 't1',
        tokenUsage: { total, last },
      }),
    disk: (records, caughtUp = ['A']) => collector.ingestLocalRecords(records, caughtUp),
    finish: () =>
      send('turn/completed', {
        threadId: 'A',
        turn: { id: 't1', status: 'completed', items: [{ type: 'agentMessage', id: 'm1' }] },
      }),
    active: () => collector.getActive()[0],
    get: () => schema.getMessageUsage(collector.getIndex(), 'A', 'm1', 'local'),
  };
}

test('local record updates before the tool returns; later notification only confirms it', async () => {
  const f = await fixture({
    getConfiguredModel: () => ({ id: 'test-model', basis: 'configured' }),
  });
  f.start();
  f.clock(1000);
  f.disk([
    local('r1', a, a, a, { body: 'PRIVATE_BODY', usage: { ...a, credential: 'PRIVATE_KEY' } }),
  ]);
  assert.equal(f.active().usage.total.totalTokens, 1100);
  assert.equal(f.active().source.requestCount, 1);
  assert.equal(f.active().modelTiming.samples, 1);
  const measured = f.active().modelTiming;
  assert.equal(f.saved(), 0, 'active usage is not persisted');
  f.clock(5000);
  f.report();
  assert.deepEqual(f.active().modelTiming, measured);
  assert.equal(f.active().source.requestCount, 1);
  f.finish();
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
  assert.equal(f.get().requestReports[0].responseId, 'r1');
  assert.equal(f.get().requestReports[0].model.id, 'test-model');
  const restored = f.schema.parseMessageUsage(
    f.schema.serializeMessageUsage(f.collector.getIndex()),
  );
  assert.deepEqual(restored.records[0], f.get());
  assert.doesNotMatch(f.schema.serializeMessageUsage(restored), /PRIVATE_|credential|body/);
});

test('notification first is upgraded with exact local identity without a second timer sample', async () => {
  const f = await fixture();
  f.start();
  f.clock(1000);
  f.report();
  const measured = f.active().modelTiming;
  f.clock(4000);
  f.disk([local('r1', a, a, a, { replay: true })]);
  f.disk([local('r1')]);
  assert.equal(f.active().source.requestCount, 1);
  assert.deepEqual(f.active().modelTiming, measured);
  f.finish();
  assert.equal(f.get().requestReports[0].responseId, 'r1');
});

test('equal-sized requests stay distinct, including zero-token response IDs', async () => {
  const f = await fixture();
  f.start();
  f.clock(1000);
  f.disk([local('r1'), local('r2', a, sum(a, a))]);
  f.report(a, sum(a, a));
  f.report(a, a);
  assert.equal(f.active().source.requestCount, 2);
  assert.deepEqual(f.active().usage.total, sum(a, a));
  const zero = usage(0);
  f.disk([local('r3', zero, sum(a, a)), local('r4', zero, sum(a, a))]);
  assert.equal(f.active().source.requestCount, 4);
  assert.deepEqual(f.active().usage.total, sum(a, a));
  f.finish();
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
});

test('out-of-order local backfill fills gaps without summing the two sources', async () => {
  const f = await fixture();
  f.start();
  f.clock(1000);
  f.disk([local('r2', b, sum(a, b), sum(a, b), { replay: true })]);
  assert.equal(f.active().source.coverage, 'partial');
  f.report(b, sum(a, b));
  f.disk([local('r1', a, a, a, { replay: true })]);
  assert.deepEqual(f.active().usage.total, sum(a, b));
  assert.equal(f.active().source.requestCount, 2);
  assert.equal(f.active().source.coverage, 'observed-so-far');
  assert.equal(f.active().modelTiming.samples, 0);
  f.clock(5000);
  f.report(a, a);
  f.clock(6000);
  f.disk([local('r3', c, sum(a, b, c))]);
  f.report(c, sum(a, b, c));
  f.finish();
  assert.equal(f.get().source.requestCount, 3);
  assert.deepEqual(f.get().usage.total, sum(a, b, c));
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
});

test('a local chain repairs a missing native report and preserves valid early timing', async () => {
  const f = await fixture();
  f.start();
  f.clock(1000);
  f.disk([local('r1')]);
  f.clock(2000);
  f.disk([local('r2', b, sum(a, b))]);
  const measured = f.active().modelTiming;
  f.clock(9000);
  f.report(b, sum(a, b));
  assert.deepEqual(f.active().modelTiming, measured);
  f.finish();
  assert.deepEqual(f.get().usage.total, sum(a, b));
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
});

test('conflicting local identity or checkpoint is rejected without changing valid totals', async () => {
  const f = await fixture();
  f.start();
  f.disk([local('r1')]);
  f.disk([local('r1', b), local('r2', b, b, a), local('r3', b, b, a, { hostId: 'remote' })]);
  assert.deepEqual(f.active().usage.total, a);
  assert.equal(f.active().source.requestCount, 1);
  assert.ok(f.diagnostics.includes('conflicting-local-request'));
  f.finish();
  assert.equal(f.get().source.coverage, 'partial');
});

test('completed exact history can be corrected after restart without reopening the turn', async () => {
  const first = await fixture();
  first.start();
  first.clock(1000);
  first.report();
  first.finish();
  const index = first.schema.parseMessageUsage(
    first.schema.serializeMessageUsage(first.collector.getIndex()),
  );
  const f = await fixture({
    index,
    getConfiguredModel: () => ({ id: 'CURRENT_NOT_HISTORICAL', basis: 'configured' }),
  });
  f.disk([
    local('r1', a, a, a, { replay: true }),
    local('r2', b, sum(a, b), sum(a, b), { replay: true }),
  ]);
  assert.deepEqual(f.get().usage.total, sum(a, b));
  assert.equal(f.get().source.requestCount, 2);
  assert.equal(f.collector.getActive().length, 0);
  assert.equal(
    f.get().modelTiming,
    undefined,
    'changed historical totals cannot acquire a fabricated duration',
  );
  assert.deepEqual(f.get().requestReports[1].model, {});
  const revision = f.get().revision,
    writes = f.saved();
  f.disk([
    local('r1', a, a, a, { replay: true }),
    local('r2', b, sum(a, b), sum(a, b), { replay: true }),
  ]);
  assert.equal(f.get().revision, revision);
  assert.equal(f.saved(), writes);
});

test('legacy history is replaced only after complete local replay; gaps cannot overwrite it', async () => {
  const first = await fixture();
  first.start();
  first.report();
  first.report(a, sum(a, a));
  first.report(a, sum(a, a, a));
  first.finish();
  const raw = JSON.parse(first.schema.serializeMessageUsage(first.collector.getIndex()));
  raw.records[0].requestReports.forEach((report) => {
    delete report.checkpoint;
  });
  const index = first.schema.createMessageUsageIndex(raw.records, { mode: 'app-server-reported' });
  const f = await fixture({ index });
  f.disk([local('r2', a, sum(a, a), sum(a, a), { replay: true })]);
  assert.equal(f.get().usage.total.totalTokens, 3300);
  f.disk([local('r1', a, a, a, { replay: true })], []);
  assert.equal(f.get().usage.total.totalTokens, 3300);
  f.disk([]);
  assert.equal(f.get().usage.total.totalTokens, 2200);
  assert.equal(f.get().source.requestCount, 2);
  assert.equal(f.get().modelTiming, undefined);
});

test('mid-turn restart uses exact running identity and skips historical generation timing', async () => {
  const f = await fixture({
    getConfiguredModel: () => ({ id: 'current-model', basis: 'configured' }),
  });
  f.collector.observeLocalIdentities([
    { hostId: 'local', threadId: 'A', turnId: 't1', running: true },
  ]);
  f.clock(50000);
  f.disk([
    local('r1', a, a, a, { replay: true }),
    local('r2', b, sum(a, b), sum(a, b), { replay: true }),
  ]);
  assert.deepEqual(f.active().usage.total, sum(a, b));
  assert.equal(f.active().modelTiming.samples, 0);
  assert.deepEqual(f.active().requestReports[0].model, {});
  assert.equal(f.saved(), 0);
  f.finish();
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
  assert.equal(f.get().modelTiming.coverage, 'partial');
});

test('a usage-only log row cannot invent message ownership, an active turn or remote usage', async () => {
  const f = await fixture();
  f.disk([local('r1')]);
  assert.equal(f.collector.getIndex().records.length, 0);
  assert.equal(f.collector.getActive().length, 0);
  f.collector.observeLocalIdentities([
    { hostId: 'remote', threadId: 'A', turnId: 't1', itemId: 'm1' },
  ]);
  assert.deepEqual(f.collector.getLocalUsageTargets(), []);
  f.collector.observeLocalIdentities([
    { hostId: 'local', threadId: 'A', turnId: 't1', itemId: 'm1' },
  ]);
  const targets = f.collector.getLocalUsageTargets();
  assert.equal(targets[0].threadId, 'A');
  assert.equal(targets[0].revision, 1);
  f.disk([local('r1', a, a, a, { replay: true })]);
  assert.equal(f.get().usage.total.totalTokens, 1100);
  assert.equal(f.get().source.status, 'unknown');
  assert.equal(f.collector.getActive().length, 0);
  f.collector.observeLocalIdentities([
    { hostId: 'local', threadId: 'A', turnId: 't1', itemId: 'm1' },
  ]);
  assert.deepEqual(
    f.collector.getLocalUsageTargets(),
    targets,
    'normal remount does not force another full file scan',
  );
});

test('native fallback continues after a local source gap and remote hosts keep native isolation', async () => {
  const f = await fixture();
  f.start();
  f.disk([local('r1')]);
  f.report();
  f.clock(1000);
  f.report(b, sum(a, b));
  f.finish();
  assert.deepEqual(f.get().usage.total, sum(a, b));
  f.start('A', 't1', 'remote');
  f.disk([local('r1')]);
  assert.equal(f.collector.getActive()[0].hostId, 'remote');
  assert.deepEqual(f.collector.getActive()[0].usage.total, {});
});

test('persistent request identity is validated and arbitrary checkpoint data is removed', async () => {
  const f = await fixture();
  f.start();
  f.disk([local('r1')]);
  f.finish();
  const raw = JSON.parse(f.schema.serializeMessageUsage(f.collector.getIndex()));
  raw.records[0].requestReports[0].checkpoint.secret = 'PRIVATE_SECRET';
  raw.records[0].requestReports[0].checkpoint.total.body = 'PRIVATE_BODY';
  const clean = f.schema.createMessageUsageIndex(raw.records, { mode: 'app-server-reported' });
  assert.doesNotMatch(f.schema.serializeMessageUsage(clean), /PRIVATE_/);
  for (const mutate of [
    (report) => {
      report.responseId = 'bad/id';
    },
    (report) => {
      report.checkpoint.turnTotal.inputTokens = -1;
    },
    (report) => {
      delete report.checkpoint;
    },
  ]) {
    const copy = JSON.parse(JSON.stringify(raw.records));
    mutate(copy[0].requestReports[0]);
    assert.throws(() => f.schema.createMessageUsageIndex(copy, { mode: 'app-server-reported' }));
  }
});

test('a completed local prefix removes an old-turn native replay even without an initial native baseline', async () => {
  const f = await fixture();
  f.start();
  f.report(a, a); // Startup missed the previous thread baseline; old notification carries the new turn ID.
  f.clock(1000);
  f.disk([local('r1', b, b, sum(a, b), { replay: true })]);
  assert.deepEqual(f.active().usage.total, b);
  assert.equal(f.active().source.requestCount, 1);
  assert.equal(f.active().modelTiming.samples, 0);
  f.report(a, a);
  assert.deepEqual(f.active().usage.total, b);
  f.report(c, sum(a, b, c)); // A later request remains available via native fallback.
  assert.deepEqual(f.active().usage.total, sum(b, c));
  f.finish();
});

test('local coverage survives a compaction estimate without counting it or fabricating missing timing', async () => {
  const f = await fixture();
  f.start();
  f.clock(1000);
  f.disk([local('r1')]);
  const invalidEstimate = { ...usage(0), totalTokens: 23280 };
  f.report(invalidEstimate, a);
  assert.deepEqual(f.active().usage.total, a);
  assert.equal(f.active().source.requestCount, 1);
  assert.equal(f.active().source.coverage, 'observed-so-far');
  assert.ok(f.diagnostics.includes('invalid-request-report'));
  f.clock(2000);
  f.disk([local('r2', b, sum(a, b))]);
  f.report(b, sum(a, b));
  f.finish();
  assert.deepEqual(f.get().usage.total, sum(a, b));
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
  assert.equal(f.get().modelTiming.coverage, 'partial');
});

test('steered user items keep one turn and do not reduce complete request coverage', async () => {
  const f = await fixture();
  f.start();
  f.clock(1000);
  f.disk([local('r1')]);
  f.collector.ingest({
    hostId: 'local',
    method: 'item/started',
    params: {
      threadId: 'A',
      turnId: 't1',
      item: { type: 'userMessage', id: 'steering', text: 'PRIVATE_INSERTION' },
    },
  });
  f.clock(2000);
  f.disk([local('r2', b, sum(a, b))]);
  f.finish();
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
  assert.equal(f.get().source.requestCount, 2);
  assert.deepEqual(f.get().usage.total, sum(a, b));
});

test('an exact message backfilled before native completion can still finalize and keep its local usage', async () => {
  const f = await fixture();
  f.collector.observeLocalIdentities([
    { hostId: 'local', threadId: 'A', turnId: 't1', itemId: 'm1' },
  ]);
  f.disk([local('r1', a, a, a, { replay: true })]);
  assert.equal(f.get().source.status, 'unknown');
  f.finish();
  assert.equal(f.get().source.status, 'completed');
  assert.equal(f.get().source.coverage, 'observed-turn-reports');
  assert.deepEqual(f.get().usage.total, a);
});
