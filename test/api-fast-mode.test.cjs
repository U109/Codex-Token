// Synthetic regression data only. No API credentials, user configuration or network requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../src/host/api-fast-mode.mjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const identity = { threadId: 'A', model: 'synthetic-model' };
function environment() {
  const state = {
    auth: 'apikey',
    tier: null,
    allowed: true,
    feature: true,
    profile: 'work',
    configs: new Map(),
    configReads: [],
    models: [{ id: identity.model, model: identity.model, serviceTiers: [{ id: 'priority' }] }],
    conversations: new Map([
      ['A', { latestModel: identity.model, latestThreadSettings: {} }],
      ['B', { latestModel: identity.model, latestThreadSettings: { serviceTier: 'default' } }],
    ]),
    requests: [],
    writes: [],
    updates: [],
    failSave: false,
    failRead: false,
    clears: 0,
  };
  const manager = {
    async getAuthMethod() {
      return state.auth;
    },
    getConversation(id) {
      return state.conversations.get(id);
    },
    getConversationCwd(id) {
      return state.conversations.get(id)?.cwd ?? null;
    },
    async sendRequest(method, params, options) {
      if (state.failRead && method === 'config/read') throw new Error('PRIVATE_ERROR');
      if (method === 'config/read') {
        state.configReads.push(params);
        await state.beforeConfigRead?.(params);
        return {
          config: {
            service_tier: state.tier,
            model: identity.model,
            profile: state.profile,
            features: { fast_mode: state.feature },
            PRIVATE_SECRET: 'never-cache',
            ...state.configs.get(params.cwd),
          },
        };
      }
      if (method === 'configRequirements/read')
        return {
          requirements: {
            featureRequirements: { fast_mode: state.allowed },
            models: { newThread: { serviceTier: state.managedTier } },
          },
        };
      if (method === 'model/list') return { data: state.models };
      state.requests.push({ method, params, options, receiver: this });
      return { accepted: true };
    },
    async updateThreadSettingsForNextTurn(id, settings) {
      state.updates.push({ id, ...settings });
      Object.assign(state.conversations.get(id).latestThreadSettings, settings);
      return true;
    },
    async setDefaultServiceTierConfig(tier, profile) {
      if (state.failSave) throw new Error('PRIVATE_ERROR');
      state.writes.push({ tier, profile });
      state.tier = tier;
    },
    async clearPrewarmedThreads() {
      state.clears++;
    },
    addNotificationCallback(methods, callback) {
      state.notify = callback;
      return () => {
        state.notify = null;
      };
    },
  };
  return { state, manager };
}

test('Fast saves through native thread and profile settings; closing sends default explicitly', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  const controller = createApiFastModeController(manager);
  const detach = controller.attach(identity);
  await tick();
  assert.equal(controller.getSnapshot(identity).available, true);
  assert.equal(await controller.setEnabled(identity, true), true);
  assert.deepEqual(state.writes, [{ tier: 'priority', profile: 'work' }]);
  assert.equal(controller.getSnapshot(identity).enabled, true);
  const input = [{ type: 'text', text: 'SYNTHETIC_PRIVATE_INPUT' }];
  const params = { threadId: 'A', input, serviceTier: null },
    options = { trace: 'untouched' };
  await manager.sendRequest('turn/start', params, options);
  assert.equal(state.requests.at(-1).params.serviceTier, 'priority');
  assert.equal(state.requests.at(-1).params.input, input);
  assert.equal(state.requests.at(-1).options, options);
  assert.equal(state.requests.at(-1).receiver, manager);
  assert.equal(params.serviceTier, null);
  assert.equal(await controller.setEnabled(identity, false), true);
  await manager.sendRequest('turn/start', { threadId: 'A', serviceTier: null });
  assert.equal(state.requests.at(-1).params.serviceTier, 'default');
  assert.equal(controller.getSnapshot(identity).enabled, false);
  assert.equal(state.clears, 2);
  detach();
  controller.dispose();
});

test('thread identity and its own off selection override the global Fast default', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.tier = 'priority';
  const controller = createApiFastModeController(manager);
  const b = { ...identity, threadId: 'B' };
  controller.attach(identity);
  controller.attach(b);
  await tick();
  assert.equal(controller.getSnapshot(identity).enabled, true);
  assert.equal(controller.getSnapshot(b).enabled, false);
  await manager.sendRequest('turn/start', { threadId: 'B' });
  assert.equal(state.requests.at(-1).params.serviceTier, 'default');
  await manager.sendRequest('turn/start', { threadId: 'A' });
  assert.equal(state.requests.at(-1).params.serviceTier, 'priority');
  controller.dispose();
});

test('new chats inherit the persisted tier and invalidate preheated threads after changing it', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  const controller = createApiFastModeController(manager),
    draft = { ...identity, threadId: null };
  controller.attach(draft);
  await tick();
  assert.equal(await controller.setEnabled(draft, true), true);
  assert.equal(state.updates.length, 0);
  await manager.sendRequest('thread/start', { model: identity.model });
  assert.equal(state.requests.at(-1).params.serviceTier, 'priority');
  controller.dispose();
});

test('new-chat requests and controls isolate project service tiers and Fast restrictions', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.tier = 'priority';
  state.configs.set('C:/standard-project', { service_tier: 'default' });
  state.configs.set('C:/restricted-project', { features: { fast_mode: false } });
  const controller = createApiFastModeController(manager);
  const drafts = [null, 'C:/standard-project', 'C:/restricted-project'].map((cwd) => ({
    ...identity,
    threadId: null,
    cwd,
  }));
  for (const draft of drafts) controller.attach(draft);
  await tick();
  assert.equal(controller.getSnapshot(drafts[0]).enabled, true);
  assert.equal(controller.getSnapshot(drafts[1]).enabled, false);
  assert.equal(controller.getSnapshot(drafts[2]).available, false);
  assert.equal(await controller.setEnabled(drafts[2], true), false);
  for (const [index, draft] of drafts.entries()) {
    const params = { model: identity.model, cwd: draft.cwd, serviceTier: null };
    await manager.sendRequest('thread/start', params);
    assert.equal(state.requests.at(-1).params.serviceTier, index === 0 ? 'priority' : 'default');
    assert.equal(params.serviceTier, null);
  }
  assert.deepEqual(
    new Set(state.configReads.map((read) => read.cwd)),
    new Set(drafts.map((d) => d.cwd)),
  );
  assert.equal(state.writes.length, 0);
  controller.dispose();
});

test('explicit request cwd overrides an existing conversation cwd without reusing its cached policy', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.tier = 'priority';
  state.conversations.get('A').cwd = 'C:/fast-project';
  state.configs.set('C:/standard-project', { features: { fast_mode: false } });
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  await manager.sendRequest('thread/resume', { threadId: 'A', cwd: 'C:/standard-project' });
  assert.equal(state.requests.at(-1).params.serviceTier, 'default');
  await manager.sendRequest('turn/start', { threadId: 'A' });
  assert.equal(state.requests.at(-1).params.serviceTier, 'priority');
  assert.deepEqual(
    state.configReads.map((read) => read.cwd),
    ['C:/fast-project', 'C:/standard-project'],
  );
  controller.dispose();
});

test('requests follow a refreshed policy when an in-flight configuration read is superseded', async () => {
  const { createApiFastModeController } = await api;
  for (const outcome of ['stale-first', 'current-first', 'stale-rejection']) {
    const { state, manager } = environment();
    state.conversations.get('A').latestThreadSettings.serviceTier = 'priority';
    const reads = [];
    state.beforeConfigRead = () =>
      new Promise((resolve, reject) => reads.push({ resolve, reject }));
    const controller = createApiFastModeController(manager);
    controller.attach(identity);
    await tick();
    const pending = manager.sendRequest('turn/start', { threadId: 'A', serviceTier: null });
    await tick();
    state.notify({ method: 'thread/settings/updated', params: { threadId: 'B' } });
    await tick();
    assert.equal(reads.length, 2);
    if (outcome === 'current-first') {
      reads[1].resolve();
      await tick();
      reads[0].resolve();
    } else {
      if (outcome === 'stale-rejection') reads[0].reject(new Error('PRIVATE_STALE_ERROR'));
      else reads[0].resolve();
      await tick();
      const sentBeforeRefresh = state.requests.length;
      reads[1].resolve();
      await pending;
      assert.equal(sentBeforeRefresh, 0, outcome);
    }
    await pending;
    assert.equal(state.requests.length, 1, outcome);
    assert.equal(state.requests[0].params.serviceTier, 'priority', outcome);
    assert.equal(controller.getSnapshot(identity).enabled, true);
    controller.dispose();
  }
});

test('a policy invalidated during the final auth check is reloaded before the request is forwarded', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.tier = 'priority';
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  const auth = manager.getAuthMethod;
  let calls = 0,
    release;
  manager.getAuthMethod = async () => {
    if (++calls === 2)
      await new Promise((resolve) => {
        release = resolve;
      });
    return auth();
  };
  const pending = manager.sendRequest('turn/start', { threadId: 'A', serviceTier: null });
  await tick();
  assert.equal(typeof release, 'function');
  state.feature = false;
  state.notify({ method: 'thread/settings/updated', params: { threadId: 'B' } });
  await tick();
  release();
  await pending;
  assert.equal(state.requests.at(-1).params.serviceTier, 'default');
  controller.dispose();
});

test('switching between API and account login hides only the custom controls and preserves native tiers', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.tier = 'priority';
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  assert.equal(controller.getSnapshot(identity).available, true);
  for (const auth of ['chatgpt', 'apikey', 'chatgpt']) {
    state.auth = auth;
    state.notify({ method: 'account/updated', params: { authMode: auth } });
    await tick();
    assert.equal(controller.getSnapshot(identity).available, auth === 'apikey');
    if (auth === 'chatgpt') {
      for (const serviceTier of ['priority', 'default', null]) {
        const params = { threadId: 'A', serviceTier };
        await manager.sendRequest('turn/start', params);
        assert.equal(state.requests.at(-1).params, params);
      }
      assert.equal(await controller.setEnabled(identity, false), false);
    }
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.updates.length, 0);
  controller.dispose();
});

test('native account login and unrelated requests preserve their original objects and behavior', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.auth = 'chatgpt';
  state.tier = 'priority';
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  assert.equal(controller.getSnapshot(identity).available, false);
  assert.equal(await controller.setEnabled(identity, true), false);
  const params = { threadId: 'A', serviceTier: null };
  await manager.sendRequest('turn/start', params);
  assert.equal(state.requests.at(-1).params, params);
  state.auth = 'apikey';
  const other = { anything: 'unchanged' };
  await manager.sendRequest('other-method', other);
  assert.equal(state.requests.at(-1).params, other);
  controller.dispose();
});

test('unsupported models and administrator or config feature restrictions cannot inherit Fast', async () => {
  const { createApiFastModeController } = await api;
  for (const restricted of ['model', 'administrator', 'feature']) {
    const { state, manager } = environment();
    state.tier = 'priority';
    if (restricted === 'model') state.models[0].serviceTiers = [];
    if (restricted === 'administrator') state.allowed = false;
    if (restricted === 'feature') state.feature = false;
    const controller = createApiFastModeController(manager);
    controller.attach(identity);
    await tick();
    assert.equal(controller.getSnapshot(identity).available, false);
    assert.equal(await controller.setEnabled(identity, true), false);
    await manager.sendRequest('turn/start', { threadId: 'A' });
    assert.equal(state.requests.at(-1).params.serviceTier, 'default');
    assert.equal(state.writes.length, 0);
    controller.dispose();
  }
});

test('managed new-chat settings are honored and cannot be overwritten through the control', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.managedTier = 'default';
  state.tier = 'priority';
  const controller = createApiFastModeController(manager),
    draft = { ...identity, threadId: null };
  controller.attach(draft);
  await tick();
  assert.equal(controller.getSnapshot(draft).locked, true);
  assert.equal(await controller.setEnabled(draft, true), false);
  await manager.sendRequest('thread/start', { model: identity.model });
  assert.equal(state.requests.at(-1).params.serviceTier, 'default');
  assert.equal(state.writes.length, 0);
  controller.dispose();
});

test('save failure rolls back the thread selection and exposes only a generic error state', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  state.failSave = true;
  assert.equal(await controller.setEnabled(identity, true), false);
  assert.deepEqual(
    state.updates.map((u) => u.serviceTier),
    ['priority', 'default'],
  );
  assert.equal(state.tier, null);
  assert.equal(controller.getSnapshot(identity).enabled, false);
  assert.equal(controller.getSnapshot(identity).error, true);
  assert.equal(JSON.stringify(controller.getSnapshot(identity)).includes('PRIVATE'), false);
  controller.dispose();
});

test('auth changes, explicit service tiers and failed reads do not rewrite native requests', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  state.tier = 'priority';
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  state.auth = 'chatgpt';
  const params = { threadId: 'A', serviceTier: null };
  await manager.sendRequest('turn/start', params);
  assert.equal(state.requests.at(-1).params, params);
  state.auth = 'apikey';
  controller.invalidate();
  await tick();
  const flex = { threadId: 'A', serviceTier: 'flex' };
  await manager.sendRequest('turn/start', flex);
  assert.equal(state.requests.at(-1).params, flex);
  state.failRead = true;
  controller.invalidate();
  await tick();
  await manager.sendRequest('turn/start', params);
  assert.equal(state.requests.at(-1).params, params);
  controller.dispose();
});

test('pending writes reject duplicate clicks and unload restores the original manager method', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  const original = manager.sendRequest;
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  let release;
  manager.setDefaultServiceTierConfig = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = controller.setEnabled(identity, true);
  await tick();
  assert.equal(controller.getSnapshot(identity).pending, true);
  assert.equal(await controller.setEnabled(identity, false), false);
  release();
  await pending;
  controller.dispose();
  assert.equal(manager.sendRequest, original);
  assert.equal(state.notify, null);
});

test('model changes during selection are detected and no default setting is changed', async () => {
  const { createApiFastModeController } = await api,
    { state, manager } = environment();
  const controller = createApiFastModeController(manager);
  controller.attach(identity);
  await tick();
  state.conversations.get('A').latestModel = 'different-synthetic-model';
  assert.equal(await controller.setEnabled(identity, true), false);
  assert.equal(state.writes.length, 0);
  controller.dispose();
});
