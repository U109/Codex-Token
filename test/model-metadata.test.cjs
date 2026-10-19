const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../src/host/model-metadata.mjs');
const route = 'api-subagents/custom/0123456789abcdef0123456789abcdef';
const query = (host = 'local', name = 'Configured Model') => ({
  queryKey: ['models', 'list', host, 'apikey', 100],
  state: {
    status: 'success',
    data: {
      data: [{ id: 'catalog-id', model: route, displayName: name, secret: 'PRIVATE_CATALOG' }],
    },
  },
});
function scopeFixture(queries = [query()]) {
  const listeners = new Set(),
    watchers = new Map(),
    values = new Map();
  const cache = {
    getAll: () => queries,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const scope = {
    queryClient: { getQueryCache: () => cache },
    watch(cb) {
      let key;
      const get = (_atom, identity) => {
        key = JSON.stringify([identity.hostId, identity.threadId]);
        return values.get(key);
      };
      cb({ get });
      watchers.set(key, { cb, get });
      return () => watchers.delete(key);
    },
  };
  return {
    scope,
    queries,
    listeners,
    watchers,
    set(model, host = 'local', thread = 'A') {
      const key = JSON.stringify([host, thread]);
      values.set(key, model === null ? null : { model, text: 'PRIVATE_MESSAGE' });
      const w = watchers.get(key);
      w?.cb({ get: w.get });
    },
    change() {
      for (const cb of listeners) cb({ query: queries[0] });
    },
  };
}
test('native cached catalog and exact thread settings hydrate without new notifications or model/transcript RPCs', async () => {
  const { createModelMetadataBridge, sessionModelPresentation } = await api;
  const target = new EventTarget(),
    f = scopeFixture();
  f.set(route);
  const bridge = createModelMetadataBridge(target),
    detach = bridge.attachScope(f.scope, {}, 'local', 'A');
  const { model, names } = sessionModelPresentation(
    target.__ctTokenModelMetadata,
    'local',
    'A',
    {},
  );
  assert.deepEqual(model, { id: route, basis: 'configured' });
  assert.equal(names[route], 'Configured Model');
  assert.equal(names['catalog-id'], 'Configured Model');
  assert.doesNotMatch(
    JSON.stringify(target.__ctTokenModelMetadata),
    /PRIVATE_|text|secret|reasoningEffort/,
  );
  detach();
  bridge.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.watchers.size, 0);
  assert.equal(target.__ctTokenModelMetadata, undefined);
});
test('percent-encoded provider routes retain their explicit readable catalog name', async () => {
  const { createModelMetadataBridge, sessionModelPresentation } = await api;
  const encoded = 'api-subagents/%E8%B4%BE%E7%BB%B4%E6%96%AF/0123456789abcdef0123456789abcdef';
  const q = query();
  q.state.data.data = [{ id: encoded, model: encoded, displayName: '自定义连接 · Model' }];
  const target = new EventTarget(),
    f = scopeFixture([q]);
  f.set(encoded);
  const bridge = createModelMetadataBridge(target);
  bridge.attachScope(f.scope, {}, 'local', 'A');
  const { model, names } = sessionModelPresentation(
    target.__ctTokenModelMetadata,
    'local',
    'A',
    {},
  );
  assert.equal(model.id, encoded);
  assert.equal(names[encoded], '自定义连接 · Model');
  bridge.dispose();
});
test('catalog labels and model settings stay isolated by host and thread, and update live', async () => {
  const { createModelMetadataBridge, sessionModelPresentation } = await api;
  const target = new EventTarget(),
    f = scopeFixture([query(), query('remote', 'Remote Model')]);
  f.set(route);
  f.set(route, 'remote');
  const bridge = createModelMetadataBridge(target);
  const a = bridge.attachScope(f.scope, {}, 'local', 'A'),
    b = bridge.attachScope(f.scope, {}, 'remote', 'A');
  const read = (host, thread = 'A') =>
    sessionModelPresentation(target.__ctTokenModelMetadata, host, thread, {});
  assert.equal(read('local').names[route], 'Configured Model');
  assert.equal(read('remote').names[route], 'Remote Model');
  assert.equal(read('local', 'B').model, null);
  f.set('new-model');
  assert.equal(read('local').model.id, 'new-model');
  assert.equal(read('remote').model.id, route);
  f.queries[0].state.data.data[0].displayName = 'Updated Name';
  f.change();
  assert.equal(read('local').names[route], 'Updated Name');
  f.set(null);
  assert.equal(read('local').model, null);
  a();
  b();
  bridge.dispose();
});
test('multiple message badges share native subscriptions and detach without affecting another badge', async () => {
  const { createModelMetadataBridge } = await api;
  const f = scopeFixture(),
    bridge = createModelMetadataBridge(new EventTarget());
  const a = bridge.attachScope(f.scope, {}, 'local', 'A'),
    b = bridge.attachScope(f.scope, {}, 'local', 'A');
  assert.equal(f.listeners.size, 1);
  assert.equal(f.watchers.size, 1);
  a();
  a();
  assert.equal(f.watchers.size, 1);
  b();
  assert.equal(f.watchers.size, 0);
  assert.equal(f.listeners.size, 0);
  bridge.dispose();
});
test('per-component native scope facades share the underlying node subscription even after the first facade unmounts', async () => {
  const { createModelMetadataBridge } = await api;
  const target = new EventTarget(),
    f = scopeFixture(),
    node = {};
  const bridge = createModelMetadataBridge(target);
  const first = bridge.attachScope({ ...f.scope, node }, {}, 'local', 'A');
  const second = bridge.attachScope({ ...f.scope, node }, {}, 'local', 'A');
  assert.deepEqual(bridge.getHealth(), { scopes: 1, catalogs: 1, threads: 1 });
  assert.equal(f.listeners.size, 1);
  assert.equal(f.watchers.size, 1);
  first();
  f.set(route);
  assert.equal(target.__ctTokenModelMetadata.threads['["local","A"]'].id, route);
  second();
  assert.equal(f.watchers.size, 0);
  assert.equal(f.listeners.size, 0);
  bridge.dispose();
});
test('ambiguous or unsafe native labels are omitted rather than guessed from another auth cache', async () => {
  const { createModelMetadataBridge } = await api;
  const target = new EventTarget(),
    f = scopeFixture([query(), query('local', 'Conflicting Label'), query('remote', '<script>')]);
  f.queries[1].queryKey[3] = 'another-auth';
  const unrelated = {
    queryKey: ['messages'],
    get state() {
      throw Error('Must not read unrelated query bodies');
    },
  };
  f.queries.push(unrelated);
  const bridge = createModelMetadataBridge(target);
  bridge.attachScope(f.scope, {}, 'local', 'A');
  assert.equal(target.__ctTokenModelMetadata.catalogs.local[route], undefined);
  assert.equal(target.__ctTokenModelMetadata.catalogs.remote?.[route], undefined);
  bridge.dispose();
});
test('current model presentation never rewrites historical model or usage and does not use unscoped live names', async () => {
  const { createModelMetadataBridge, sessionModelPresentation } = await api;
  const target = new EventTarget(),
    f = scopeFixture();
  f.set('new-model');
  const historical = Object.freeze({ id: route, basis: 'configured' });
  const bridge = createModelMetadataBridge(target);
  bridge.attachScope(f.scope, {}, 'local', 'A');
  assert.equal(
    sessionModelPresentation(target.__ctTokenModelMetadata, 'local', 'A', historical).model.id,
    'new-model',
  );
  assert.equal(historical.id, route);
  assert.deepEqual(
    sessionModelPresentation(
      target.__ctTokenModelMetadata,
      'unknown-host',
      'A',
      {},
      { [route]: 'Wrong Host' },
    ).names,
    {},
  );
  assert.equal(
    sessionModelPresentation(target.__ctTokenModelMetadata, 'local', 'unwatched', historical).model,
    null,
  );
  assert.equal(sessionModelPresentation(null, 'local', 'A', historical).model, historical);
  bridge.dispose();
});
test('missing or throwing native caches remain unknown without disrupting the usage runtime', async () => {
  const { createModelMetadataBridge } = await api;
  const target = new EventTarget(),
    bridge = createModelMetadataBridge(target);
  assert.doesNotThrow(() => bridge.attachScope({}, {}, 'local', 'A')());
  assert.doesNotThrow(() =>
    bridge.attachScope(
      {
        watch() {},
        get queryClient() {
          throw Error('PRIVATE_ERROR');
        },
      },
      {},
      'local',
      'A',
    )(),
  );
  assert.deepEqual(bridge.getHealth(), { scopes: 0, catalogs: 0, threads: 0 });
  bridge.dispose();
  bridge.dispose();
});
test('cleared and conflicting current settings remain unknown instead of reviving a historical model', async () => {
  const { createModelMetadataBridge, sessionModelPresentation } = await api;
  const target = new EventTarget(),
    a = scopeFixture(),
    b = scopeFixture();
  const bridge = createModelMetadataBridge(target),
    historical = { id: 'old-model', basis: 'configured' };
  const read = () =>
    sessionModelPresentation(target.__ctTokenModelMetadata, 'local', 'A', historical).model;
  a.set(route);
  b.set('different-model');
  bridge.attachScope(a.scope, {}, 'local', 'A');
  const detachB = bridge.attachScope(b.scope, {}, 'local', 'A');
  assert.equal(read(), null);
  detachB();
  assert.equal(read().id, route);
  a.set(null);
  assert.equal(read(), null);
  bridge.dispose();
});
test('throwing optional thread watchers do not leak cache subscriptions or retain errors', async () => {
  const { createModelMetadataBridge } = await api;
  const target = new EventTarget(),
    f = scopeFixture();
  f.scope.watch = () => {
    throw Error('PRIVATE_WATCH_ERROR');
  };
  const bridge = createModelMetadataBridge(target);
  const detach = bridge.attachScope(f.scope, {}, 'local', 'A');
  assert.equal(f.listeners.size, 1);
  assert.doesNotMatch(JSON.stringify(target.__ctTokenModelMetadata), /PRIVATE_WATCH_ERROR/);
  detach();
  assert.equal(f.listeners.size, 0);
  bridge.dispose();
});
