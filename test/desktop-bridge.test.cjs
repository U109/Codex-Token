const test = require('node:test');
const assert = require('node:assert/strict');
const api = Promise.all([
  import('../src/host/desktop-bridge.mjs'),
  import('../src/core/message-usage.mjs'),
]);
const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
};
async function fixture() {
  const [bridge, records] = await api;
  const value = records.createMessageUsageIndex([
    {
      mode: 'local-mock-provider',
      scope: 'turn-fixture',
      threadId: 'A',
      turnId: 't1',
      itemId: 'm1',
      usage: { total: { totalTokens: 120 } },
    },
  ]);
  return { ...bridge, ...records, value };
}
test('a fixture delivered before the lazy renderer import is not erased by initialization', async () => {
  const f = await fixture(),
    target = new EventTarget();
  target.__ctTokenLabUsage = f.value;
  const bridge = f.createDesktopBridge({ mode: 'local-mock-provider', storage: memory(), target });
  assert.equal(f.getMessageUsage(target.__ctTokenLabUsage, 'A', 'm1').usage.total.totalTokens, 120);
  assert.equal(bridge.getHealth().records, 1);
  bridge.dispose();
});
test('a fixture delivered after initialization is persisted and reconstructed on reload', async () => {
  const f = await fixture(),
    storage = memory(),
    target = new EventTarget();
  const bridge = f.createDesktopBridge({ mode: 'local-mock-provider', storage, target });
  const event = new Event('ct-token-seed');
  event.detail = f.value;
  target.dispatchEvent(event);
  const reloaded = new EventTarget();
  const second = f.createDesktopBridge({ mode: 'local-mock-provider', storage, target: reloaded });
  assert.equal(
    f.getMessageUsage(reloaded.__ctTokenLabUsage, 'A', 'm1').usage.total.totalTokens,
    120,
  );
  bridge.dispose();
  second.dispose();
});
test('live mode does not subscribe to fixture seeding or import mock records', async () => {
  const f = await fixture(),
    target = new EventTarget();
  target.__ctTokenLabUsage = f.value;
  const bridge = f.createDesktopBridge({ mode: 'app-server-reported', storage: memory(), target });
  const event = new Event('ct-token-seed');
  event.detail = f.value;
  target.dispatchEvent(event);
  assert.equal(target.__ctTokenUsageIndex.records.length, 0);
  assert.equal(target.__ctTokenLabUsage, undefined);
  assert.equal(bridge.getHealth().records, 0);
  bridge.dispose();
});
test('running notifications publish live snapshots immediately without persisting them and clear them on dispose', async () => {
  const f = await fixture(),
    target = new EventTarget(),
    storage = memory();
  let events = 0;
  target.addEventListener('ct-token-active-usage', () => events++);
  const bridge = f.createDesktopBridge({ mode: 'app-server-reported', storage, target });
  const send = (method, params) => bridge.captureNotification('local', method, params);
  send('turn/started', { threadId: 'A', turn: { id: 't1' } });
  const n = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  send('thread/tokenUsage/updated', {
    threadId: 'A',
    turnId: 't1',
    tokenUsage: { last: n, total: n },
  });
  assert.equal(target.__ctTokenActiveUsage[0].usage.total.totalTokens, 120);
  assert.equal(target.__ctTokenUsageIndex.records.length, 0);
  assert.ok(events >= 3);
  const other = new EventTarget(),
    second = f.createDesktopBridge({ mode: 'app-server-reported', storage, target: other });
  assert.deepEqual(other.__ctTokenActiveUsage, []);
  bridge.dispose();
  assert.deepEqual(target.__ctTokenActiveUsage, []);
  second.dispose();
});

test('one active interval refreshes observation and stops on completion or disposal; metadata changes preserve attribution', async () => {
  const f = await fixture(),
    target = new EventTarget(),
    timers = new Map();
  let starts = 0,
    stops = 0;
  target.setInterval = (callback, delay) => {
    assert.equal(delay, 1000);
    timers.set(++starts, callback);
    return starts;
  };
  target.clearInterval = (id) => {
    stops++;
    timers.delete(id);
  };
  target.__ctTokenModelMetadata = {
    threads: { '["local","A"]': { id: 'gpt-6.1-sol', basis: 'configured' } },
  };
  const bridge = f.createDesktopBridge({ mode: 'app-server-reported', storage: memory(), target });
  const send = (method, params) => bridge.captureNotification('local', method, params);
  send('turn/started', { threadId: 'A', turn: { id: 't1' } });
  assert.equal(starts, 1);
  const before = target.__ctTokenActiveUsage;
  timers.get(1)();
  assert.notEqual(target.__ctTokenActiveUsage, before);
  assert.equal(starts, 1);
  target.__ctTokenModelMetadata.threads['["local","A"]'] = {
    id: 'gpt-6-astra',
    basis: 'configured',
  };
  target.dispatchEvent(new Event('ct-token-model-metadata'));
  assert.deepEqual(target.__ctTokenActiveUsage[0].model, {});
  send('turn/completed', { threadId: 'A', turn: { id: 't1', status: 'completed', items: [] } });
  assert.equal(stops, 1);
  assert.equal(timers.size, 0);
  send('turn/started', { threadId: 'A', turn: { id: 't2' } });
  assert.equal(starts, 2);
  bridge.dispose();
  assert.equal(stops, 2);
  assert.equal(timers.size, 0);
  target.dispatchEvent(new Event('ct-token-model-metadata'));
  assert.deepEqual(target.__ctTokenActiveUsage, []);
});
