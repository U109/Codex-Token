const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const api = import('../src/host/cdp-runtime.mjs');
const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
const config = {
  origin: 'app://-',
  releaseVersion: 'test',
  parserInitExport: 'init',
  parserExport: 'parse',
  reactExport: 'react',
  reactDomExport: 'dom',
  actionRowSelector: 'native-row',
};
function row(props) {
  return {
    __reactFiber$test: { memoizedProps: {}, return: { memoizedProps: props } },
    style: { opacity: '' },
    children: [],
    closest: () => null,
    appendChild(node) {
      this.children = this.children.filter((child) => child !== node);
      this.children.push(node);
      node.parent = this;
      node.parentElement = this;
    },
    contains(node) {
      return (
        node === this || this.children.some((child) => child === node || child.contains?.(node))
      );
    },
  };
}
const identity = (thread = 'A', item = 'm1', hostId = 'local', turn = 't1') => ({
  hostId,
  conversationId: thread,
  sourceTurnId: turn,
  item: { type: 'assistant-message', searchItemId: item, text: 'PRIVATE_BODY' },
});
function environment(rows) {
  let observer,
    renderCount = 0,
    unmountCount = 0;
  const doc = Object.assign(new EventTarget(), {
    body: {},
    readyState: 'complete',
    querySelectorAll: () => rows,
    createElement() {
      return {
        nodeType: 1,
        attrs: {},
        style: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        closest() {
          return this.attrs['data-ct-cdp-root'] === '' ? this : null;
        },
        remove() {
          if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
        },
      };
    },
  });
  const values = new Map();
  const target = Object.assign(new EventTarget(), {
    document: doc,
    location: { origin: 'app://-' },
    setTimeout,
    clearTimeout,
    MutationObserver: class {
      constructor(callback) {
        observer = this;
        this.callback = callback;
      }
      observe() {}
      disconnect() {
        this.closed = true;
      }
    },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  const native = {
    init() {},
    parse: (e) => e.data,
    react: () => ({
      useSyncExternalStore() {},
      useId() {},
      useState() {},
      useRef() {},
      createElement: (tag, props) => ({ tag, props }),
    }),
    dom: () => ({
      createRoot: () => ({
        render() {
          renderCount++;
        },
        unmount() {
          unmountCount++;
        },
      }),
    }),
  };
  const send = (method, params, hostId = 'local') =>
    target.dispatchEvent(
      new MessageEvent('message', { data: { type: 'mcp-notification', hostId, method, params } }),
    );
  return {
    doc,
    target,
    native,
    send,
    values,
    get observer() {
      return observer;
    },
    counts: () => ({ renderCount, unmountCount }),
  };
}
test('CDP mount reads only exact assistant identities, never the URL, ordinal or body', async () => {
  const { messageIdentityForNode } = await api;
  assert.deepEqual(messageIdentityForNode(row(identity())), {
    hostId: 'local',
    threadId: 'A',
    itemId: 'm1',
    turnId: 't1',
  });
  for (const props of [
    {},
    { ...identity(), conversationId: undefined },
    { ...identity(), hostId: 'bad/id' },
    { ...identity(), item: { type: 'user-message', searchItemId: 'm1' } },
    { ...identity(), item: { type: 'assistant-message', id: 'm1' } },
  ]) {
    assert.equal(messageIdentityForNode(row(props)), null);
  }
  assert.deepEqual(messageIdentityForNode(row(identity('A', 'm1', 'local', undefined))), {
    hostId: 'local',
    threadId: 'A',
    itemId: 'm1',
    turnId: 't1',
  });
  const props = identity();
  delete props.sourceTurnId;
  assert.deepEqual(messageIdentityForNode(row(props)), {
    hostId: 'local',
    threadId: 'A',
    itemId: 'm1',
  });
});

test('composer identity requires a consistent native conversation and explicit host', async () => {
  const { composerIdentityForNode } = await api;
  assert.deepEqual(composerIdentityForNode(row({ conversationId: 'A', hostId: 'local' })), {
    hostId: 'local',
    threadId: 'A',
  });
  assert.equal(composerIdentityForNode(row({ conversationId: 'A' })), null);
  assert.equal(composerIdentityForNode(row({ conversationId: 'A', hostId: 'bad/host' })), null);
  const mismatch = row({ conversationId: 'A' });
  mismatch.__reactFiber$test.return.return = {
    memoizedProps: { conversationId: 'B', hostId: 'local' },
  };
  assert.equal(composerIdentityForNode(mismatch), null);
});

test('conversation summary follows the composer identity and cleans up without replacing the input', async () => {
  const { installCdpRuntime } = await api;
  const env = environment([]),
    parent = row({}),
    anchor = row({}),
    body = row({ conversationId: 'A', hostId: 'local' });
  parent.appendChild(anchor);
  anchor.appendChild(body);
  parent.insertBefore = function (node, before) {
    this.children = this.children.filter((n) => n !== node);
    this.children.splice(this.children.indexOf(before), 0, node);
    node.parent = this;
    node.parentElement = this;
    for (let i = 0; i < this.children.length; i++)
      this.children[i].nextSibling = this.children[i + 1] ?? null;
  };
  body.closest = (selector) => (selector === '[data-composer-surface-variant]' ? anchor : null);
  let visible = true;
  env.doc.querySelectorAll = (selector) =>
    selector === '[data-composer-body]' && visible ? [body] : [];
  await installCdpRuntime(config, { target: env.target, native: env.native });
  await wait();
  assert.equal(env.counts().renderCount, 1);
  assert.equal(parent.children.length, 2);
  assert.equal(parent.children[1], anchor);
  assert.deepEqual(
    env.target.__ctTokenConversationUsage.map((v) => v.threadId),
    ['A'],
  );
  body.__reactFiber$test.return.memoizedProps = { conversationId: 'B', hostId: 'local' };
  env.observer.callback([{ type: 'childList', target: body, addedNodes: [], removedNodes: [] }]);
  await wait();
  assert.equal(env.counts().renderCount, 2);
  assert.deepEqual(
    env.target.__ctTokenConversationUsage.map((v) => v.threadId),
    ['B'],
  );
  assert.equal(anchor.children[0], body, 'the native input is retained');
  visible = false;
  env.observer.callback([{ type: 'childList', target: parent, addedNodes: [], removedNodes: [] }]);
  await wait();
  assert.equal(env.counts().unmountCount, 1);
  assert.deepEqual(env.target.__ctTokenConversationUsage, []);
  env.target.__ctTokenCdpRuntimeV1.dispose();
});
test('CDP identity follows the current alternate after native React commits', async () => {
  const { messageIdentityForNode } = await api;
  const node = row(identity('old'));
  const current = { memoizedProps: identity('new'), return: null };
  const root = { stateNode: { current: {} } };
  node.__reactFiber$test.return.return = root;
  node.__reactFiber$test.alternate = { memoizedProps: {}, return: current };
  assert.equal(messageIdentityForNode(node).threadId, 'new');
});
test('native metadata context lookup copies only the exact branded provider and supports both React provider shapes', async () => {
  const { nativeScopeContextForNode } = await api;
  const context = { $$typeof: Symbol.for('react.context'), displayName: 'TestAppScope' };
  context.Provider = context;
  const value = new Map([['test-scope-node', {}]]),
    node = row(identity());
  const provider = { type: context, memoizedProps: { value } };
  node.__reactFiber$test.return.return = provider;
  assert.deepEqual(nativeScopeContextForNode(node, 'TestAppScope'), { Provider: context, value });
  assert.equal(nativeScopeContextForNode(node, 'OtherScope'), null);
  assert.equal(nativeScopeContextForNode(node, ''), null);
  assert.equal(nativeScopeContextForNode({}, 'TestAppScope'), null);
  provider.type = { _context: context };
  assert.deepEqual(nativeScopeContextForNode(node, 'TestAppScope'), { Provider: context, value });
  provider.memoizedProps = { value: { text: 'PRIVATE_CONTEXT' } };
  assert.equal(nativeScopeContextForNode(node, 'TestAppScope'), null);
  provider.memoizedProps = { value };
  const activeValue = new Map();
  node.__reactFiber$test.return.return.return = { stateNode: { current: {} } };
  node.__reactFiber$test.alternate = {
    return: { type: context, memoizedProps: { value: activeValue } },
  };
  assert.equal(nativeScopeContextForNode(node, 'TestAppScope').value, activeValue);
  assert.equal(provider.memoizedProps.value, value, 'Never mutate the native provider');
});
test('native metadata reaches AppScope beyond the official host depth and resolves a deep current alternate', async () => {
  const { nativeScopeContextForNode, messageIdentityForNode } = await api;
  const context = { $$typeof: Symbol.for('react.context'), displayName: 'AppScope' };
  context.Provider = context;
  const value = new Map(),
    node = row(identity('old'));
  let tail = node.__reactFiber$test.return;
  for (let i = 0; i < 240; i++) tail = tail.return = { memoizedProps: {} };
  tail.return = { type: context, memoizedProps: { value } };
  const root = (tail.return.return = { stateNode: { current: {} } });
  node.__reactFiber$test.alternate = { memoizedProps: identity('current'), return: tail.return };
  assert.equal(messageIdentityForNode(node).threadId, 'current');
  assert.equal(nativeScopeContextForNode(node, 'AppScope').value, value);
  root.stateNode.current = root;
  assert.equal(messageIdentityForNode(node).threadId, 'old');
  assert.equal(nativeScopeContextForNode(node, 'AppScope').Provider, context);
});
test('running footer identity requires the native active turn, not an assistant item or latest record', async () => {
  const { runningIdentityForNode } = await api;
  const props = {
    hostId: 'local',
    conversationId: 'A',
    turnId: 'live',
    mcpTurn: { turnId: 'live', status: 'inProgress' },
  };
  assert.deepEqual(runningIdentityForNode(row(props)), {
    hostId: 'local',
    threadId: 'A',
    turnId: 'live',
    running: true,
  });
  for (const invalid of [
    { ...props, hostId: undefined },
    { ...props, mcpTurn: { turnId: 'other', status: 'inProgress' } },
    { ...props, mcpTurn: { turnId: 'live', status: 'completed' } },
    identity(),
  ])
    assert.equal(runningIdentityForNode(row(invalid)), null);
});
test('running content mounts without an assistant message and disappears when the native turn completes', async (t) => {
  const { installCdpRuntime } = await api;
  const props = {
    hostId: 'local',
    conversationId: 'A',
    turnId: 'live',
    mcpTurn: { turnId: 'live', status: 'inProgress' },
  };
  const footer = row(props),
    env = environment([]);
  env.doc.querySelectorAll = (selector) => (selector === 'native-running' ? [footer] : []);
  t.after(() => env.target.__ctTokenCdpRuntimeV1?.dispose());
  await installCdpRuntime({ ...config, runningRowSelector: 'native-running' }, env);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 1);
  props.mcpTurn.status = 'completed';
  env.observer.callback([{ type: 'characterData', target: {} }]);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 0);
});
test('running usage chooses the outer turn body, excludes fixed status, and rejects ambiguous roots', async () => {
  const { runningContentRows } = await api;
  const p = {
    hostId: 'local',
    conversationId: 'A',
    turnId: 't',
    mcpTurn: { turnId: 't', status: 'inProgress' },
  };
  const outer = row(p),
    inner = row(p),
    status = row(p);
  outer.appendChild(inner);
  status.closest = (selector) =>
    selector.includes('[data-above-composer-fixed-content-portal]') ? {} : null;
  assert.deepEqual(runningContentRows([outer, inner, status]), [outer]);
  assert.deepEqual(runningContentRows([outer, row(p)]), []);
  const remote = row({ ...p, hostId: 'remote' });
  assert.deepEqual(runningContentRows([outer, inner, remote]), [outer, remote]);
});
test('a running body owns one usage line and hands it back to the message actions on completion', async (t) => {
  const { installCdpRuntime } = await api;
  const p = {
    hostId: 'local',
    conversationId: 'A',
    turnId: 't1',
    mcpTurn: { turnId: 't1', status: 'inProgress' },
  };
  const content = row(p),
    actions = row(identity());
  content.appendChild(actions);
  const env = environment([]);
  env.doc.querySelectorAll = (s) => (s === 'native-running' ? [content] : [actions]);
  t.after(() => env.target.__ctTokenCdpRuntimeV1?.dispose());
  await installCdpRuntime({ ...config, runningRowSelector: 'native-running' }, env);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 1);
  assert.equal(actions.children.length, 0);
  p.mcpTurn.status = 'completed';
  env.observer.callback([{ type: 'characterData', target: {} }]);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 1);
  assert.equal(actions.children.length, 1);
});
test('an unavailable optional model metadata contract cannot disable Token usage', async (t) => {
  const { installCdpRuntime } = await api;
  for (const metadataRuntime of [
    {},
    { useScope() {}, threadModelAtom: { scope: { __scopeBrand: 'TestAppScope' } } },
  ]) {
    const env = environment([row(identity())]);
    t.after(() => env.target.__ctTokenCdpRuntimeV1?.dispose());
    await installCdpRuntime(config, { ...env, metadataRuntime });
    await wait();
    const health = env.target.__ctTokenCdpRuntimeV1.health();
    assert.equal(health.state, 'ready');
    assert.equal(health.mounted, 1);
    assert.equal(health.modelMetadataState, 'unavailable');
    assert.equal(health.parserReady, true);
  }
});
test('CDP installation is idempotent; virtualized rows rebind and dispose cleanly', async (t) => {
  const { installCdpRuntime } = await api;
  const rows = [row(identity()), row(identity('B'))],
    env = environment(rows);
  t.after(() => env.target.__ctTokenCdpRuntimeV1?.dispose());
  await installCdpRuntime(config, env);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 2);
  await installCdpRuntime(config, env);
  await wait();
  assert.equal(env.counts().renderCount, 2);
  rows[0].__reactFiber$test.return.memoizedProps = identity('A', 'm2');
  env.observer.callback([{ type: 'characterData', target: {} }]);
  await wait();
  assert.equal(env.counts().renderCount, 3);
  rows.pop();
  env.observer.callback([{ type: 'childList', target: {}, addedNodes: [], removedNodes: [{}] }]);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 1);
  env.target.__ctTokenCdpRuntimeV1.dispose();
  assert.equal(env.counts().unmountCount, 2);
  assert.equal(rows[0].style.opacity, '');
  assert.equal(rows[0].children.length, 0);
  assert.equal(env.observer.closed, true);
});
test('CDP mounts only the inner action row when native wrappers also match the selector', async (t) => {
  const { installCdpRuntime } = await api;
  const outer = row(identity()),
    inner = row(identity());
  outer.appendChild(inner);
  const env = environment([outer, inner]);
  t.after(() => env.target.__ctTokenCdpRuntimeV1?.dispose());
  await installCdpRuntime(config, env);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 1);
  assert.equal(
    outer.children.length,
    1,
    'Do not append a second badge beside the native button group',
  );
  assert.equal(inner.children.length, 1);
  assert.equal(outer.style.opacity, '', 'Only make the inner actions visible');
  assert.equal(
    inner.style.opacity,
    '',
    'Retain native hover/focus visibility rather than forcing the action group visible',
  );
  env.observer.callback([{ type: 'characterData', target: {} }]);
  await wait();
  assert.equal(env.counts().renderCount, 1, 'Repeated scans must not duplicate a message badge');
  env.target.__ctTokenCdpRuntimeV1.dispose();
  assert.equal(inner.children.length, 0);
  assert.equal(inner.style.opacity, '');
});
test('CDP mounts immediately after Copy before More, inherits its skin, and never overrides native visibility', async () => {
  const { installCdpRuntime, nativeActionPresentation } = await api;
  const actionRow = row(identity()),
    env = environment([actionRow]);
  const copy = {
    className: 'native-ghost text-tertiary hover:bg-surface',
    parentElement: actionRow,
    getAttribute: (key) => (key === 'aria-label' ? '复制' : null),
    closest: () => null,
    querySelector: () => ({ icon: true }),
  };
  const more = {
    parentElement: actionRow,
    getAttribute: (key) => (key === 'aria-label' ? '更多' : null),
    closest: () => null,
  };
  actionRow.children = [copy, more];
  Object.defineProperty(copy, 'nextSibling', {
    get: () => actionRow.children[actionRow.children.indexOf(copy) + 1] ?? null,
  });
  actionRow.querySelectorAll = () => [copy, more];
  actionRow.insertBefore = (node, before) => {
    actionRow.children = actionRow.children.filter((child) => child !== node);
    actionRow.children.splice(
      before ? actionRow.children.indexOf(before) : actionRow.children.length,
      0,
      node,
    );
    node.parent = node.parentElement = actionRow;
  };
  env.target.getComputedStyle = (element) =>
    element.icon
      ? { width: '16px' }
      : {
          fontSize: '14px',
          lineHeight: '20px',
          fontFamily: 'Native Sans',
          fontWeight: '400',
          height: '24px',
          borderRadius: '4px',
          paddingTop: '4px',
          paddingBottom: '4px',
        };
  const presentation = nativeActionPresentation(actionRow, env.target).presentation;
  assert.equal(presentation.className, copy.className);
  assert.equal(presentation.style.fontSize, '12px');
  assert.equal(presentation.iconSize, '16px');
  assert.equal(presentation.style.lineHeight, '16px');
  assert.equal(presentation.style.height, '24px');
  await installCdpRuntime(config, { target: env.target, document: env.doc, native: env.native });
  await wait();
  assert.equal(actionRow.children[0], copy);
  assert.equal(actionRow.children[2], more);
  assert.equal(actionRow.children[1].attrs['data-ct-cdp-root'], '');
  assert.equal(actionRow.style.opacity, '');
  env.target.__ctTokenCdpRuntimeV1.dispose();
  assert.deepEqual(actionRow.children, [copy, more]);
});
test('CDP native notifications feed the existing per-message collector without retaining body data', async (t) => {
  const { installCdpRuntime } = await api;
  const env = environment([]);
  t.after(() => env.target.__ctTokenCdpRuntimeV1?.dispose());
  await installCdpRuntime(config, env);
  env.send('turn/started', { threadId: 'A', turn: { id: 't1' } });
  const counts = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  env.send('thread/tokenUsage/updated', {
    threadId: 'A',
    turnId: 't1',
    tokenUsage: { last: counts, total: counts },
  });
  env.send('turn/completed', {
    threadId: 'A',
    turn: {
      id: 't1',
      status: 'completed',
      items: [{ type: 'agentMessage', id: 'm1', text: 'PRIVATE_BODY' }],
    },
  });
  const { getMessageUsage } = await import('../src/core/message-usage.mjs');
  assert.equal(
    getMessageUsage(env.target.__ctTokenUsageIndex, 'A', 'm1', 'local').usage.total.totalTokens,
    120,
  );
  assert.equal(getMessageUsage(env.target.__ctTokenUsageIndex, 'B', 'm1', 'local'), null);
  assert.doesNotMatch(
    JSON.stringify([...env.values.values()]),
    /PRIVATE_BODY|text|password|access_token/,
  );
  env.target.__ctTokenCdpRuntimeV1.dispose();
  env.send('turn/started', { threadId: 'A', turn: { id: 't2' } });
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().notifications, 3);
});
test('CDP refuses other origins and missing native exports before mounting', async () => {
  const { installCdpRuntime } = await api;
  const env = environment([row(identity())]);
  assert.equal(
    (await installCdpRuntime({ ...config, origin: 'https://example.test' }, env)).state,
    'wrong-origin',
  );
  assert.equal((await installCdpRuntime(config, { ...env, native: {} })).state, 'unsupported');
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().mounted, 0);
  assert.equal(
    env.target.__ctTokenCdpRuntimeV1.health().errorCode,
    'runtime-parser-contract-mismatch',
  );
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().errorStage, 'native-contract');
});
test('CDP rejects a callable React compiler factory instead of treating export presence as compatibility', async () => {
  const { resolveNativeRuntime } = await api;
  const env = environment([]);
  let initialized = false;
  const compiler = {
    ...env.native,
    init() {
      initialized = true;
    },
    react: () => ({ c() {} }),
  };
  assert.throws(
    () => resolveNativeRuntime(compiler, config),
    /runtime-react-core-contract-mismatch/,
  );
  assert.equal(
    initialized,
    false,
    'Invalid React must fail before collector/parser initialization',
  );
  assert.throws(
    () => resolveNativeRuntime({ ...env.native, dom: () => ({}) }, config),
    /runtime-react-dom-contract-mismatch/,
  );
  assert.equal(typeof resolveNativeRuntime(env.native, config).React.createElement, 'function');
});
test('CDP reports fixed contract diagnostics without retaining exceptions and can retry a failed install', async (t) => {
  const { installCdpRuntime } = await api;
  const env = environment([]);
  t.after(() => env.target.__ctTokenCdpRuntimeV1?.dispose());
  const bad = {
    ...env.native,
    react() {
      throw new Error('PRIVATE_DIAGNOSTIC_BODY');
    },
  };
  const failed = await installCdpRuntime(config, { ...env, native: bad });
  assert.equal(failed.errorCode, 'runtime-react-core-contract-mismatch');
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_DIAGNOSTIC_BODY/);
  await installCdpRuntime(config, env);
  await wait();
  assert.equal(env.target.__ctTokenCdpRuntimeV1.health().state, 'ready');
});
test('CDP ignores its own DOM mutations to avoid observer/render feedback loops', async () => {
  const { isOwnedMutation } = await api;
  const inside = { nodeType: 1, closest: () => ({}) },
    outside = { nodeType: 1, closest: () => null };
  assert.equal(isOwnedMutation({ type: 'characterData', target: { parentElement: inside } }), true);
  assert.equal(
    isOwnedMutation({ type: 'childList', target: outside, addedNodes: [inside], removedNodes: [] }),
    true,
  );
  assert.equal(
    isOwnedMutation({
      type: 'childList',
      target: outside,
      addedNodes: [inside, outside],
      removedNodes: [],
    }),
    false,
  );
});
test('CDP builder emits a standalone script using only project code', () => {
  const script =
    "import sys;sys.path.insert(0,'scripts');from bundle import bundle;print(bundle({'compatibilityMode':'auto','origin':'app://-','releaseVersion':'test'}))";
  const result = spawnSync('python', ['-X', 'utf8', '-c', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    spawnSync(process.execPath, ['--check'], { input: result.stdout, encoding: 'utf8' }).status,
    0,
  );
  assert.match(result.stdout, /installCdpRuntime/);
  assert.doesNotMatch(result.stdout, /Fetch\.enable|rebuild\(|\.vite\/build\/early-bootstrap/);
});
test('new release uses ordinary-user CDP activation and cannot patch or clone official files', () => {
  const cs = fs.readFileSync(path.resolve(__dirname, '../packaging/windows/Runtime.cs'), 'utf8');
  const manager = fs.readFileSync(
    path.resolve(__dirname, '../packaging/windows/Manage.ps1'),
    'utf8',
  );
  const build = fs.readFileSync(path.resolve(__dirname, '../scripts/build.py'), 'utf8');
  assert.match(cs, /ActivateApplication/);
  assert.match(cs, /remote-debugging-address=127\.0\.0\.1/);
  assert.match(cs, /debug-listener-not-owned-loopback/);
  assert.match(cs, /close-codex-first/);
  for (const source of [cs, manager, build])
    assert.doesNotMatch(
      source,
      /takeown|icacls|Set-Acl|Patch-Executable|Build-RewrittenArchive|copytree|--user-data-dir|--inspect/,
    );
  assert.match(
    fs.readFileSync(path.resolve(__dirname, '../packaging/windows/app.manifest'), 'utf8'),
    /level="asInvoker"/,
  );
  assert.match(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'))).scripts.build,
    /python scripts\/build\.py/,
  );
});

test('dedicated local ingress acknowledges only the current page session, deduplicates retries and stops on dispose', async () => {
  const { installCdpRuntime } = await api;
  const env = environment([row(identity())]);
  await installCdpRuntime(config, { target: env.target, native: env.native });
  await wait();
  const runtime = env.target.__ctTokenCdpRuntimeV1;
  const first = runtime.exchangeLocalUsage({});
  assert.deepEqual(first.targets, [{ threadId: 'A', revision: 1 }]);
  const counts = {
    totalTokens: 1100,
    inputTokens: 1000,
    cachedInputTokens: 500,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 50,
  };
  const envelope = {
    session: 'old-page',
    batchId: 1,
    caughtUp: ['A'],
    records: [
      {
        threadId: 'A',
        turnId: 't1',
        responseId: 'r1',
        usage: counts,
        checkpoint: { total: counts, turnTotal: counts },
        replay: true,
        text: 'PRIVATE_LOG_BODY',
      },
    ],
  };
  assert.equal(runtime.exchangeLocalUsage(envelope).ack, null);
  assert.equal(env.target.__ctTokenUsageIndex.records.length, 0);
  envelope.session = first.session;
  assert.equal(runtime.exchangeLocalUsage(envelope).ack, 1);
  assert.equal(env.target.__ctTokenUsageIndex.records[0].usage.total.totalTokens, 1100);
  const revision = env.target.__ctTokenUsageIndex.records[0].revision;
  assert.equal(runtime.exchangeLocalUsage(envelope).ack, 1);
  assert.equal(env.target.__ctTokenUsageIndex.records[0].revision, revision);
  assert.doesNotMatch(JSON.stringify([...env.values]), /PRIVATE_LOG_BODY/);
  assert.equal(
    runtime.exchangeLocalUsage({ ...envelope, records: Array(129).fill(envelope.records[0]) }).ack,
    null,
  );
  runtime.dispose();
  assert.equal(runtime.exchangeLocalUsage(envelope).ack, undefined);
  await installCdpRuntime(config, { target: env.target, native: env.native });
  await wait();
  const second = env.target.__ctTokenCdpRuntimeV1.exchangeLocalUsage(envelope);
  assert.notEqual(second.session, first.session);
  assert.equal(second.ack, null);
  env.target.__ctTokenCdpRuntimeV1.dispose();
});
