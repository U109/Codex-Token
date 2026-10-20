const test = require('node:test');
const assert = require('node:assert/strict');

// 测试不使用桌面、DOM、网络、凭据或真实聊天数据。
async function render(
  data,
  props = { threadId: 'fixture-thread', itemId: 'fixture-item' },
  modelNames,
  ActionButton,
  metadata,
  active,
  hooks = {},
) {
  const { createTokenBadge } = await import('../src/ui/token-badge.mjs');
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  globalThis.__ctTokenLabUsage =
    data?.scope === 'turn-fixture' && data.mode === 'local-mock-provider'
      ? createMessageUsageIndex([data])
      : data;
  if (modelNames) globalThis.__ctTokenModelNames = modelNames;
  if (metadata) globalThis.__ctTokenModelMetadata = metadata;
  if (active) globalThis.__ctTokenActiveUsage = active;
  try {
    const React = {
      createElement: (tag, props, ...children) => ({ tag, props, children }),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      useId: () => ':fixture:',
      useState: () => [false, () => {}],
      useRef: () => ({ current: null }),
      ...hooks,
    };
    return createTokenBadge(React, ActionButton)(props);
  } finally {
    delete globalThis.__ctTokenLabUsage;
    delete globalThis.__ctTokenLabRenders;
    delete globalThis.__ctTokenModelNames;
    delete globalThis.__ctTokenModelMetadata;
    delete globalThis.__ctTokenActiveUsage;
  }
}
function fixture() {
  return {
    mode: 'local-mock-provider',
    scope: 'turn-fixture',
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
    itemId: 'fixture-item',
    model: { provider: 'token-lab', id: 'ct-lab' },
    timing: { scope: 'single-model-request', durationMs: 2000, origin: 'unit-test-fixture' },
    usage: {
      total: {
        totalTokens: 4120,
        inputTokens: 3600,
        cachedInputTokens: 2400,
        cacheWriteInputTokens: 0,
        outputTokens: 520,
        reasoningOutputTokens: 120,
      },
    },
    pricing: {
      provider: 'openai',
      model: 'gpt-6.1-sol',
      priceVersion: 'official-usd-2026-10-15',
      startedAt: '2026-10-15T04:30:00Z',
      billingMode: 'api',
      endpoint: 'global',
      modality: 'text',
      serviceTier: 'fast',
      fastEnabled: true,
    },
  };
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...(tree.children ?? []).flatMap((child) => nodes(child, predicate)),
  ];
}
const byData = (tree, name, value = '') => nodes(tree, (node) => node.props?.[name] === value);
test('Token typography and glyph inherit the neighboring native action without conspicuous custom hover overrides', async () => {
  const tree = await render(fixture(), {
    threadId: 'fixture-thread',
    itemId: 'fixture-item',
    actionPresentation: {
      className: 'native-ghost text-tertiary native-hover',
      iconSize: '12px',
      style: { height: '24px', fontSize: '12px', fontWeight: '400' },
    },
  });
  const button = nodes(tree, (node) => node.tag === 'button')[0];
  assert.match(button.props.className, /native-ghost/);
  assert.equal(button.props.style.height, '24px');
  assert.equal(button.props.style.fontSize, '12px');
  assert.equal(button.props.style.width, 'auto');
  assert.equal(button.props.style.color, undefined);
  assert.equal(button.props['data-ct-action-skin'], 'native');
  const icon = nodes(button, (node) => node.tag === 'svg')[0];
  assert.equal(icon.props.style.width, '12px');
  assert.equal(icon.props['aria-hidden'], true);
  assert.doesNotMatch(
    nodes(tree, (node) => node.tag === 'style')[0].children.join(''),
    /!important|transition:\s*all/,
  );
});
test('usage tooltip is available on hover and keyboard focus, and the default icon is a native-sized vector', async () => {
  const tree = await render(fixture()),
    button = nodes(tree, (n) => n.tag === 'button')[0],
    tip = nodes(tree, (n) => n.props?.role === 'tooltip')[0];
  assert.equal(tip.children[0], '用量统计');
  assert.equal(tip.props.popover, 'manual');
  assert.equal(button.props['aria-describedby'], tip.props.id);
  for (const event of ['onPointerEnter', 'onPointerLeave', 'onFocus', 'onBlur', 'onClick'])
    assert.equal(typeof button.props[event], 'function');
  const icon = nodes(button, (n) => n.tag === 'svg')[0];
  assert.equal(icon.props.viewBox, '0 0 16 16');
  assert.equal(icon.props.style.width, '16px');
});

test('usage trigger tracks native open styling and accessibility until the details close', async () => {
  let open = false;
  const hooks = {
    useState: () => [open, (next) => (open = next)],
  };
  const renderState = () =>
    render(fixture(), undefined, undefined, undefined, undefined, undefined, hooks);
  const buttonIn = (tree) => nodes(tree, (node) => node.tag === 'button')[0];
  const dialogIn = (tree) => nodes(tree, (node) => node.props?.role === 'dialog')[0];
  const target = { focus() {}, scrollTop: 0 };
  let tree = await renderState();
  assert.equal(buttonIn(tree).props['data-state'], 'closed');
  assert.equal(buttonIn(tree).props['aria-expanded'], false);
  dialogIn(tree).props.onToggle({ newState: 'open', currentTarget: target });
  tree = await renderState();
  assert.equal(buttonIn(tree).props['data-state'], 'open');
  assert.equal(buttonIn(tree).props['aria-expanded'], true);
  buttonIn(tree).props.onPointerLeave();
  assert.equal(open, true, 'Leaving the trigger must not close its details');
  dialogIn(tree).props.onToggle({ newState: 'closed', currentTarget: target });
  tree = await renderState();
  assert.equal(buttonIn(tree).props['data-state'], 'closed');
  assert.equal(buttonIn(tree).props['aria-expanded'], false);
});
test('running control shows only its exact live turn without an extra left inset or observed prefix', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const index = createMessageUsageIndex([], { mode: 'app-server-reported' });
  const props = { hostId: 'local', threadId: 'A', turnId: 't1', running: true };
  const active = [
    {
      scope: 'active-turn-reports',
      hostId: 'local',
      threadId: 'A',
      turnId: 't1',
      source: { coverage: 'partial', status: 'inProgress' },
      usage: { total: { totalTokens: 120 } },
    },
  ];
  const tree = await render(index, props, undefined, undefined, undefined, active);
  assert.equal(byData(tree, 'data-ct-total')[0].children[0], '120 token');
  const button = nodes(tree, (n) => n.tag === 'button')[0];
  assert.equal(button.props.style.padding, 0);
  assert.equal(button.props.style.height, '20px');
  assert.equal(nodes(button, (n) => n.tag === 'svg')[0].props.style.display, 'block');
  assert.doesNotMatch(JSON.stringify(tree), /已观测|随客户端上报刷新|随上报刷新/);
  for (const different of [
    { ...props, turnId: 't2' },
    { ...props, hostId: 'remote' },
    { ...props, threadId: 'B' },
  ]) {
    const other = await render(index, different, undefined, undefined, undefined, active);
    assert.equal(byData(other, 'data-ct-total').length, 0);
    assert.equal(byData(other, 'data-ct-waiting')[0].children[0], '等待回复');
    assert.equal(byData(other, 'data-ct-detail-total')[0].children[0], '等待回复');
  }
});

test('completed and running totals switch to M at one million while details preserve exact counts', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const index = createMessageUsageIndex([], { mode: 'app-server-reported' });
  const liveProps = { hostId: 'local', threadId: 'A', turnId: 't1', running: true };
  for (const [total, label] of [
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [12340, '12.34K'],
    [999990, '999.99K'],
    [1000000, '1M'],
    [1234567, '1.23M'],
    [4409555, '4.41M'],
  ]) {
    const data = fixture();
    Object.assign(data.usage.total, {
      totalTokens: total,
      inputTokens: total,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    const active = [{ ...data, ...liveProps, scope: 'active-turn-reports' }];
    const completed = await render(data);
    const running = await render(index, liveProps, undefined, undefined, undefined, active);
    for (const [tree, expected] of [
      [completed, label],
      [running, label + ' token'],
    ]) {
      assert.equal(byData(tree, 'data-ct-total')[0].children[0], expected);
      assert.equal(
        byData(tree, 'data-ct-detail-total')[0].children[0],
        total.toLocaleString('en-US') + ' token',
      );
      assert.ok(
        nodes(tree, (node) => node.tag === 'button')[0].props['aria-label'].includes(
          total.toLocaleString('en-US') + ' token',
        ),
      );
    }
  }
});
test('running and completed views distinguish an observed new turn from mid-turn attachment in an existing chat', async () => {
  const { createAppServerUsageCollector } = await import('../src/host/app-server-usage.mjs');
  const last = fixture().usage.total;
  const total = Object.fromEntries(
    Object.entries(last).map(([field, value]) => [field, value * 5]),
  );
  for (const observedStart of [true, false]) {
    let clock = 0;
    const collector = createAppServerUsageCollector({ now: () => clock });
    const send = (method, params) => collector.ingest({ hostId: 'local', method, params });
    const props = { hostId: 'local', threadId: 'A', turnId: 't1' };
    if (observedStart) send('turn/started', { threadId: 'A', turn: { id: 't1' } });
    clock = 2000;
    send('thread/tokenUsage/updated', { threadId: 'A', turnId: 't1', tokenUsage: { last, total } });
    const live = await render(
      collector.getIndex(),
      { ...props, running: true },
      undefined,
      undefined,
      undefined,
      collector.getActive(),
    );
    assert.equal(byData(live, 'data-ct-detail-total')[0].children[0], '4,120 token');
    const status = byData(live, 'data-ct-detail-row', '统计状态')[0];
    assert.equal(status.children[1].children[0], observedStart ? '运行中' : '运行中 · 数据不完整');
    send('turn/completed', {
      threadId: 'A',
      turn: { id: 't1', status: 'completed', items: [{ type: 'agentMessage', id: 'm1' }] },
    });
    const completed = await render(collector.getIndex(), { ...props, itemId: 'm1' });
    assert.equal(byData(completed, 'data-ct-detail-total')[0].children[0], '4,120 token');
    assert.equal(JSON.stringify(completed).includes('数据不完整'), !observedStart);
  }
});

test('standard reference prices use the recorded turn model and do not follow a changed current selection', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const value = {
    ...fixture(),
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    model: { provider: 'cpa', id: 'gpt-6.1-sol', basis: 'configured' },
    pricing: {},
    source: { requestCount: 1 },
  };
  const index = createMessageUsageIndex([value], { mode: value.mode });
  const tree = await render(index, undefined, undefined, undefined, {
    catalogs: {},
    threads: { '["local","fixture-thread"]': { id: 'gpt-6-astra', basis: 'configured' } },
  });
  assert.equal(byData(tree, 'data-ct-model')[0].children[0], 'gpt-6-astra');
  assert.equal(byData(tree, 'data-ct-cost')[0].children[0], '≈ $0.0078');
  assert.match(
    byData(tree, 'data-ct-cost')[0].props.title,
    /本轮配置模型 gpt-6.1-sol.*标准档.*不代表/,
  );
  assert.ok(nodes(tree, (n) => n.tag === 'dt').some((n) => n.children[0] === '标准价参考'));
});
test('badge never renders missing, unsupported or unspecified-scope data', async () => {
  for (const data of [
    null,
    {},
    { ...fixture(), mode: 'live' },
    { ...fixture(), scope: 'thread' },
  ]) {
    assert.equal(await render(data), null);
  }
});
test('live presentation distinguishes configured model, reported usage and unavailable timing/pricing', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const value = {
    ...fixture(),
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    model: { provider: 'provider', id: 'configured', basis: 'configured' },
    timing: {},
    pricing: {},
  };
  const index = createMessageUsageIndex([value], { mode: value.mode });
  const tree = await render(index);
  assert.equal(byData(tree, 'data-ct-total')[0].children[0], '4.12K');
  assert.equal(byData(tree, 'data-ct-model')[0].children[0], 'configured');
  assert.match(byData(tree, 'data-ct-model')[0].props.title, /会话配置/);
  assert.equal(byData(tree, 'data-ct-cost')[0].children[0], '暂无法估算');
  assert.equal(byData(tree, 'data-ct-speed')[0].children[0], '未记录耗时');
  assert.match(nodes(tree, (node) => node.tag === 'button')[0].props['aria-label'], /客户端已上报/);
  assert.doesNotMatch(JSON.stringify(tree), /本地模拟/);
  for (const props of [
    { threadId: 'fixture-thread', itemId: 'fixture-item', hostId: 'remote' },
    { threadId: 'fixture-thread', itemId: 'fixture-item', turnId: 'other-turn' },
  ]) {
    assert.equal(byData(await render(index, props), 'data-ct-total').length, 0);
  }
});
test('live output speed uses model windows and the old wall clock value is not reused', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const value = {
    ...fixture(),
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    timing: {},
    pricing: {},
    modelTiming: {
      scope: 'model-request-windows',
      basis: 'client-lifecycle',
      excludesTools: true,
      durationMs: 2000,
      outputTokens: 520,
      samples: 2,
      coverage: 'turn',
    },
  };
  const tree = await render(createMessageUsageIndex([value], { mode: value.mode }));
  assert.equal(byData(tree, 'data-ct-speed')[0].children[0], '260.0 token/s');
  assert.ok(nodes(tree, (n) => n.tag === 'dt').some((n) => n.children[0] === '输出速度（估算）'));
  assert.doesNotMatch(JSON.stringify(tree), /已观测|含工具和等待时间/);
  assert.equal(byData(tree, 'data-ct-cache-hit-rate')[0].children[0], '66.7%');
  value.modelTiming.samples = 0;
  assert.equal(
    byData(await render(createMessageUsageIndex([value], { mode: value.mode })), 'data-ct-speed')[0]
      .children[0],
    '采样不足',
  );
  delete value.modelTiming;
  value.observation = {
    scope: 'turn-observed-window',
    durationMs: 2000,
    outputTokens: 520,
    samples: 1,
    coverage: 'turn',
    includesWaiting: true,
  };
  assert.equal(
    byData(await render(createMessageUsageIndex([value], { mode: value.mode })), 'data-ct-speed')[0]
      .children[0],
    '未记录耗时',
  );
});

test('completed partial replies show the saved counts alongside their price and speed instead of dashes', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const usage = {
    inputTokens: 25535,
    cachedInputTokens: 25216,
    cacheWriteInputTokens: 0,
    outputTokens: 52,
    reasoningOutputTokens: 37,
    totalTokens: 25587,
  };
  const value = {
    ...fixture(),
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    timing: {},
    pricing: {},
    source: { coverage: 'unknown', requestCount: 1, status: 'completed' },
    usage: { total: {} },
    requestReports: [{ sequence: 1, model: { id: 'gpt-6.1-sol', basis: 'configured' }, usage }],
    observation: {
      scope: 'turn-observed-window',
      durationMs: 5435.7,
      outputTokens: 52,
      samples: 1,
      coverage: 'partial',
      includesWaiting: true,
    },
  };
  const tree = await render(createMessageUsageIndex([value], { mode: value.mode }));
  assert.equal(byData(tree, 'data-ct-total')[0].children[0], '25.59K');
  assert.equal(byData(tree, 'data-ct-detail-total')[0].children[0], '25,587 token');
  assert.equal(byData(tree, 'data-ct-cost')[0].children[0], '≈ $0.0037');
  assert.equal(byData(tree, 'data-ct-speed')[0].children[0], '未记录耗时');
  assert.equal(byData(tree, 'data-ct-cache-hit-rate')[0].children[0], '98.8%');
  const text = JSON.stringify(tree);
  for (const expected of ['319 token', '25,216 token', '52 token', '数据不完整', '标准价参考'])
    assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /— token|等待后续上报/);
  assert.match(nodes(tree, (n) => n.tag === 'button')[0].props['aria-label'], /25,587 token/);
  const missing = await render(createMessageUsageIndex([], { mode: value.mode }));
  assert.equal(byData(missing, 'data-ct-total').length, 0);
  assert.equal(byData(missing, 'data-ct-detail-total')[0].children[0], '未记录用量');
  assert.doesNotMatch(JSON.stringify(missing), /— token/);
});

test('live model row renders the readable catalog label, never the internal route', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const id = 'api-subagents/cpa/0123456789abcdef0123456789abcdef';
  const value = {
    ...fixture(),
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    model: { provider: 'api_subagents', id, basis: 'configured' },
  };
  const index = createMessageUsageIndex([value], { mode: value.mode });
  const tree = await render(index, undefined, { [id]: 'cpa · gpt-6.1-sol' });
  assert.equal(byData(tree, 'data-ct-model')[0].children[0], 'cpa · gpt-6.1-sol');
  assert.doesNotMatch(
    JSON.stringify(tree),
    /0123456789abcdef|api_subagents|api-subagents|（配置）/,
  );
  assert.equal(byData(await render(index), 'data-ct-model')[0].children[0], '未确认');
});
test('current native metadata names an already-open chat without fabricating historical usage', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const route = 'api-subagents/custom/0123456789abcdef0123456789abcdef';
  const value = {
    ...fixture(),
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    model: {},
    timing: {},
    pricing: {},
  };
  const index = createMessageUsageIndex([value], { mode: value.mode });
  const before = JSON.stringify(index);
  const metadata = {
    catalogs: { local: { [route]: 'Native Model' }, remote: { [route]: 'Remote Model' } },
    threads: { '["local","fixture-thread"]': { id: route, basis: 'configured' } },
  };
  const tree = await render(index, undefined, undefined, undefined, metadata);
  assert.equal(byData(tree, 'data-ct-model')[0].children[0], 'Native Model');
  assert.match(byData(tree, 'data-ct-model')[0].props.title, /会话配置.*并非请求级/);
  assert.equal(byData(tree, 'data-ct-total')[0].children[0], '4.12K');
  assert.equal(byData(tree, 'data-ct-cost')[0].children[0], '暂无法估算');
  assert.equal(byData(tree, 'data-ct-speed')[0].children[0], '未记录耗时');
  const missing = await render(
    index,
    { threadId: 'other-thread', itemId: 'unknown' },
    undefined,
    undefined,
    {
      ...metadata,
      threads: { '["local","other-thread"]': { id: route, basis: 'configured' } },
    },
  );
  assert.equal(byData(missing, 'data-ct-model')[0].children[0], 'Native Model');
  assert.equal(byData(missing, 'data-ct-total').length, 0);
  for (const props of [
    { threadId: 'fixture-thread', itemId: 'fixture-item', hostId: 'remote' },
    { threadId: 'other-thread', itemId: 'fixture-item' },
  ]) {
    const other = await render(index, props, { [route]: 'Unscoped Name' }, undefined, metadata);
    assert.equal(byData(other, 'data-ct-model')[0].children[0], '未确认');
  }
  assert.equal(JSON.stringify(index), before);
  assert.doesNotMatch(
    JSON.stringify(tree),
    /api-subagents|0123456789abcdef|Remote Model|Unscoped Name/,
  );
  const historical = createMessageUsageIndex(
    [{ ...value, model: { id: 'Old Model', basis: 'configured' } }],
    { mode: value.mode },
  );
  const unavailable = await render(historical, undefined, undefined, undefined, {
    catalogs: {},
    threads: {},
  });
  assert.equal(
    byData(unavailable, 'data-ct-model')[0].children[0],
    '未确认',
    'Historical model is not the current selection',
  );
});
test('unrecorded messages keep an icon-only badge, never another message usage', async () => {
  for (const props of [
    { threadId: 'other-thread', itemId: 'fixture-item' },
    { threadId: 'fixture-thread', itemId: 'other-item' },
  ]) {
    const tree = await render(fixture(), props);
    assert.equal(byData(tree, 'data-ct-total').length, 0);
    const button = nodes(tree, (node) => node.tag === 'button')[0];
    assert.equal(nodes(button, (node) => node.tag === 'svg').length, 1);
    assert.equal(button.props['aria-label'], '查看用量明细（暂未取得用量）');
    assert.equal(
      button.props.popovertarget,
      nodes(tree, (node) => node.props?.popover === 'auto')[0].props.id,
    );
    assert.equal(byData(tree, 'data-ct-cost')[0].children[0], '暂无法估算');
    assert.equal(byData(tree, 'data-ct-speed')[0].children[0], '— token/s');
    assert.equal(tree.props['data-ct-usage-state'], 'unknown');
  }
});
test('all replies retain separate badges when a new reply or another chat is selected', async () => {
  const { createMessageUsageIndex } = await import('../src/core/message-usage.mjs');
  const first = fixture();
  const second = {
    ...fixture(),
    turnId: 'fixture-turn-2',
    itemId: 'fixture-item-2',
    usage: { total: { totalTokens: 2040, outputTokens: 240 } },
  };
  const other = {
    ...fixture(),
    threadId: 'other-thread',
    turnId: 'other-turn',
    model: { provider: 'history-provider', id: 'history-model' },
    usage: { total: { totalTokens: 990, outputTokens: 90 } },
  };
  const index = createMessageUsageIndex([first, second, other]);
  for (const [data, total] of [
    [first, '4.12K'],
    [second, '2.04K'],
    [other, '990'],
    [first, '4.12K'],
  ]) {
    const tree = await render(index, { threadId: data.threadId, itemId: data.itemId });
    assert.equal(byData(tree, 'data-ct-total')[0].children[0], total);
    assert.equal(tree.props['data-turn-id'], data.turnId);
    assert.equal(
      byData(tree, 'data-ct-model')[0].children[0],
      `${data.model.provider}/${data.model.id}`,
    );
    assert.equal(
      byData(tree, 'data-ct-speed')[0].children[0],
      `${(data.usage.total.outputTokens / 2).toFixed(1)} token/s`,
    );
  }
});
test('remounting a historical reply after persistence restores its own usage', async () => {
  const { createMessageUsageIndex, serializeMessageUsage, parseMessageUsage } =
    await import('../src/core/message-usage.mjs');
  const restored = parseMessageUsage(serializeMessageUsage(createMessageUsageIndex([fixture()])));
  assert.equal(byData(await render(restored), 'data-ct-total')[0].children[0], '4.12K');
});
test('lab badge binds compact details, adds the heading icon, and removes footer prose', async () => {
  const tree = await render(fixture());
  const button = tree.children.find((child) => child.tag === 'button');
  const dialog = tree.children.find((child) => child.tag === 'div');
  assert.equal(byData(button, 'data-ct-total')[0].children[0], '4.12K');
  assert.equal(byData(button, 'data-ct-cost').length, 0, 'Price belongs only in details');
  assert.equal(button.props['aria-controls'], dialog.props.id);
  assert.equal(button.props['aria-expanded'], false);
  assert.equal(dialog.props.role, 'dialog');
  assert.match(dialog.props['aria-label'], /本地模拟/);
  assert.equal(
    nodes(dialog, (node) => node.tag === 'p').length,
    0,
    'No reference, rate or simulation footer paragraphs',
  );
  const heading = byData(dialog, 'data-ct-detail-heading')[0];
  assert.equal(heading.children[0].tag, 'svg', 'Database icon precedes the heading');
  assert.equal(heading.children[0].props['aria-hidden'], true);
  assert.equal(heading.children[1], '本轮用量');
  assert.match(JSON.stringify(dialog), /4,120 token/);
  assert.doesNotMatch(JSON.stringify(dialog), /\btok\b/);
  assert.doesNotMatch(
    nodes(dialog, (node) => node.tag === 'dt')
      .map((node) => node.children.join(''))
      .join('\n'),
    /推理/,
    'No reasoning breakdown after output',
  );
});
test('lab badge keeps known zero and hides unavailable or invalid totals', async () => {
  for (const [value, expected] of [
    [0, '0'],
    [-1, ''],
    [null, ''],
    [1.5, ''],
  ]) {
    const data = fixture();
    data.usage.total.totalTokens = value;
    const tree = await render(data);
    const button = tree.children.find((child) => child.tag === 'button');
    assert.equal(byData(button, 'data-ct-total')[0]?.children[0] ?? '', expected);
    assert.equal(tree.props['data-ct-usage-state'], value === 0 ? 'known' : 'unknown');
  }
});
test('lab badge shows Fast only beside the price in details, never on the footer', async () => {
  const tree = await render(fixture());
  const button = tree.children.find((child) => child.tag === 'button');
  const dialog = tree.children.find((child) => child.tag === 'div');
  assert.equal(nodes(button, (node) => node.props?.['data-ct-fast'] !== undefined).length, 0);
  assert.equal(byData(button, 'data-ct-cost').length, 0);
  assert.equal(byData(dialog, 'data-ct-cost')[0].children[0], '≈ $0.0157');
  assert.equal(byData(dialog, 'data-ct-fast', 'price')[0].props['aria-label'], 'Fast 已开启');
  assert.equal(byData(dialog, 'data-ct-fast', 'price')[0].props.title, 'Fast');
  assert.doesNotMatch(button.props['aria-label'], /Fast/);
  assert.match(
    byData(dialog, 'data-ct-fast', 'price')[0].props.className,
    /\btext-tertiary\b/,
    'Reuse the native ghost-action gray',
  );
  assert.match(
    button.props.className,
    /\btext-tertiary\b/,
    'The CDP HTML fallback uses the native ghost-action color token',
  );
  assert.equal(
    button.props.style.color,
    undefined,
    'Do not override the theme token with the darker action-row text color',
  );
});
test('native action component owns its color while the HTML fallback has no ghost props', async () => {
  const NativeActionButton = () => null;
  const native = await render(fixture(), undefined, undefined, NativeActionButton);
  const button = native.children.find((child) => child.tag === NativeActionButton);
  assert.equal(button.props.color, 'ghost');
  assert.equal(button.props.size, 'icon');
  assert.equal(button.props.style.color, undefined, 'Native ghost button owns the action color');
  const fallback = (await render(fixture())).children.find((child) => child.tag === 'button');
  assert.equal(fallback.props.color, undefined);
  assert.equal(fallback.props.size, undefined);
});
test('lab badge preserves Fast when pricing is unknown, and removes it when disabled', async () => {
  for (const enabled of [true, false]) {
    const data = fixture();
    data.pricing.serviceTier = null;
    data.pricing.fastEnabled = enabled;
    const tree = await render(data);
    const button = tree.children.find((child) => child.tag === 'button');
    const dialog = tree.children.find((child) => child.tag === 'div');
    assert.equal(nodes(button, (node) => node.props?.['data-ct-fast'] !== undefined).length, 0);
    assert.equal(byData(dialog, 'data-ct-fast', 'price').length, Number(enabled));
    assert.equal(byData(dialog, 'data-ct-cost')[0].children[0], '暂无法估算');
    assert.match(JSON.stringify(tree), /实际服务档位未确认/);
  }
});
test('lab details display the actual session model, not the pricing reference model', async () => {
  const tree = await render(fixture());
  assert.equal(byData(tree, 'data-ct-model')[0].children[0], 'token-lab/ct-lab');
  assert.match(
    byData(tree, 'data-ct-cost')[0].props.title,
    /模拟 API 单价参考 openai\/gpt-6.1-sol/,
  );
  const data = fixture();
  delete data.model;
  assert.equal(byData(await render(data), 'data-ct-model')[0].children[0], '未上报');
});
test('lab speed uses output and explicit request timing; missing timing stays unknown', async () => {
  const data = fixture();
  assert.equal(byData(await render(data), 'data-ct-speed')[0].children[0], '260.0 token/s');
  delete data.timing;
  assert.equal(byData(await render(data), 'data-ct-speed')[0].children[0], '— token/s');
  data.timing = { scope: 'turn', durationMs: 2000 };
  assert.equal(byData(await render(data), 'data-ct-speed')[0].children[0], '— token/s');
});
test('lab details preserve the above-left anchor without flipping below the action row', async () => {
  const tree = await render(fixture());
  const dialog = tree.children.find((child) => child.tag === 'div');
  assert.equal(dialog.props.style.bottom, 'anchor(top)');
  assert.equal(dialog.props.style.top, 'auto');
  assert.equal(dialog.props.style.left, 'clamp(8px, anchor(left), calc(100vw - 348px))');
  assert.equal(dialog.props.style.positionTryFallbacks, undefined);
  const target = {
    scrollTop: 120,
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  dialog.props.onToggle({ newState: 'open', currentTarget: target });
  assert.equal(
    target.scrollTop,
    0,
    'Opening starts at the header/model/price, not the bottom of the scroller',
  );
  assert.equal(target.focused, true);
});
