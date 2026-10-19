const test = require('node:test');
const assert = require('node:assert/strict');
const api = Promise.all([
  import('../src/storage/usage-store.mjs'),
  import('../src/core/message-usage.mjs'),
]);
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
};
const record = (mode, threadId = 'A', turnId = 't1', itemId = 'm1') => ({
  mode,
  scope: mode === 'app-server-reported' ? 'turn-reported' : 'turn-fixture',
  hostId: 'local',
  threadId,
  turnId,
  itemId,
  usage: { total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
  text: 'PRIVATE_BODY',
  credentials: 'PRIVATE_KEY',
});
test('live metadata survives reconstruction and retains multiple conversations without private bodies', async () => {
  const [{ createUsageStore }, r] = await api;
  const memory = storage();
  const first = createUsageStore({ storage: memory });
  first.seed(
    r.createMessageUsageIndex(
      [record('app-server-reported'), record('app-server-reported', 'B', 't2', 'm2')],
      { mode: 'app-server-reported' },
    ),
  );
  const restored = createUsageStore({ storage: memory });
  assert.equal(restored.getIndex().records.length, 2);
  assert.equal(r.getMessageUsage(restored.getIndex(), 'A', 'm1').usage.total.totalTokens, 120);
  assert.equal(restored.getHealth().state, 'ready');
  assert.doesNotMatch([...memory.values.values()].join(''), /PRIVATE_|credentials|text/);
});
test('lab and live have separate storage namespaces and cannot borrow each other records', async () => {
  const [{ createUsageStore }, r] = await api;
  const memory = storage();
  const lab = createUsageStore({ storage: memory, mode: 'local-mock-provider' });
  lab.seed(r.createMessageUsageIndex([record('local-mock-provider')]));
  const live = createUsageStore({ storage: memory });
  assert.equal(live.getIndex().records.length, 0);
  assert.throws(() => live.seed(lab.getIndex()), /source/);
});

test('startup restores old partial counts from requests and the next save preserves the recovered record', async () => {
  const [{ createUsageStore }, r] = await api,
    memory = storage(),
    mode = 'app-server-reported',
    key = 'codex-token.usage.v1.' + mode;
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  const raw = {
    ...record(mode),
    source: { coverage: 'unknown', requestCount: 1, status: 'completed' },
    usage: { total: {} },
    requestReports: [{ sequence: 1, usage }],
  };
  const saved = JSON.stringify({ version: 1, mode, scope: 'message-usage-index', records: [raw] });
  memory.setItem(key, saved);
  const store = createUsageStore({ storage: memory });
  assert.equal(store.getHealth().state, 'ready');
  assert.deepEqual(r.getMessageUsage(store.getIndex(), 'A', 'm1').usage.total, usage);
  assert.equal(r.getMessageUsage(store.getIndex(), 'A', 'm1').source.coverage, 'partial');
  assert.equal(
    memory.getItem(key),
    saved,
    'Loading does not overwrite the original persisted document',
  );
  store.seed(r.createMessageUsageIndex([record(mode, 'B', 't2', 'm2')], { mode }));
  const restored = createUsageStore({ storage: memory });
  assert.equal(restored.getIndex().records.length, 2);
  assert.deepEqual(r.getMessageUsage(restored.getIndex(), 'A', 'm1').usage.total, usage);
  assert.equal(r.getMessageUsage(restored.getIndex(), 'A', 'm1').source.coverage, 'partial');
});
test('corrupt or wrong-source history stays unknown and is preserved for explicit recovery', async () => {
  const [{ createUsageStore }, r] = await api;
  for (const saved of ['not-json', JSON.stringify(r.createMessageUsageIndex([]))]) {
    const memory = storage(),
      key = 'codex-token.usage.v1.app-server-reported';
    memory.setItem(key, saved);
    const store = createUsageStore({ storage: memory });
    assert.equal(store.getHealth().state, 'corrupt');
    assert.equal(store.getIndex().records.length, 0);
    store.seed(
      r.createMessageUsageIndex([record('app-server-reported')], { mode: 'app-server-reported' }),
    );
    assert.equal(memory.getItem(key), saved);
    assert.equal(store.getHealth().state, 'corrupt');
  }
});
test('storage denial or quota errors are explicit while in-memory records remain available', async () => {
  const [{ createUsageStore }, r] = await api;
  for (const memory of [
    undefined,
    {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('quota');
      },
    },
  ]) {
    const store = createUsageStore({ storage: memory });
    store.seed(
      r.createMessageUsageIndex([record('app-server-reported')], { mode: 'app-server-reported' }),
    );
    assert.equal(store.getHealth().state, 'unavailable');
    assert.equal(store.getIndex().records.length, 1);
  }
});
