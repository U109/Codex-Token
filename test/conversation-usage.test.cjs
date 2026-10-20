const test = require('node:test');
const assert = require('node:assert/strict');
const api = Promise.all([
  import('../src/host/app-server-usage.mjs'),
  import('../src/core/message-usage.mjs'),
  import('../src/core/pricing.mjs'),
]);
const usage = (n) => ({
  totalTokens: n * 1100,
  inputTokens: n * 1000,
  outputTokens: n * 100,
  cachedInputTokens: n * 500,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: n * 50,
});
const row = (responseId, turnId, n, cumulative, threadId = 'A') => ({
  threadId,
  turnId,
  responseId,
  usage: usage(n),
  checkpoint: { turnTotal: usage(n), total: usage(cumulative) },
  replay: true,
});
const send = (c, method, params, hostId = 'local') =>
  c.ingest({ hostId, method, params: { threadId: 'A', ...params } });

test('conversation backfill includes offscreen turns without creating messages and counts a multi-message turn once', async () => {
  const [{ createAppServerUsageCollector }, schema, prices] = await api;
  const c = createAppServerUsageCollector({
    getConfiguredModel: () => ({ id: 'gpt-6.1-sol', basis: 'configured' }),
  });
  c.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  send(c, 'turn/started', { turn: { id: 't1' } });
  send(c, 'thread/tokenUsage/updated', {
    turnId: 't1',
    tokenUsage: { last: usage(2), total: usage(3) },
  });
  c.ingestLocalRecords([row('old', 't0', 1, 1), row('new', 't1', 2, 3)], ['A']);
  const summary = c.getConversations()[0];
  assert.deepEqual(summary.total, usage(3));
  assert.equal(summary.coverage, 'complete');
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.cost.pricedRequestCount, 1);
  assert.equal(summary.cost.unpricedRequestCount, 1);
  assert.equal(summary.cost.partial, true);
  assert.equal(
    summary.cost.amountUSD,
    prices.estimateStandardReference({
      model: { id: 'gpt-6.1-sol' },
      usage: usage(2),
      requestCount: 1,
    }).amountUSD,
  );
  assert.equal(c.getIndex().records.length, 0, 'log rows do not fabricate assistant messages');
  send(c, 'turn/completed', {
    turn: {
      id: 't1',
      status: 'completed',
      items: [
        { type: 'agentMessage', id: 'm1' },
        { type: 'agentMessage', id: 'm2' },
      ],
    },
  });
  assert.equal(c.getIndex().records.length, 2);
  assert.equal(c.getConversations()[0].requestCount, 2);
  assert.deepEqual(c.getConversations()[0].total, usage(3));
  const restored = createAppServerUsageCollector({
    index: schema.parseMessageUsage(schema.serializeMessageUsage(c.getIndex(), { compact: true })),
  });
  restored.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  restored.ingestLocalRecords([row('old', 't0', 1, 1), row('new', 't1', 2, 3)], ['A']);
  assert.deepEqual(restored.getConversations()[0], c.getConversations()[0]);
});

test('live and finished conversation requests reconcile across both sources without a transient double count', async () => {
  const [{ createAppServerUsageCollector }] = await api;
  const c = createAppServerUsageCollector({
    getConfiguredModel: () => ({ id: 'gpt-6.1-sol', basis: 'configured' }),
  });
  c.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  for (const [turnId, n, total] of [
    ['t0', 1, 1],
    ['t1', 2, 3],
  ]) {
    send(c, 'turn/started', { turn: { id: turnId } });
    send(c, 'thread/tokenUsage/updated', {
      turnId,
      tokenUsage: { last: usage(n), total: usage(total) },
    });
    c.ingestLocalRecords([row('r-' + turnId, turnId, n, total)], ['A']);
    assert.equal(c.getConversations()[0].total.totalTokens, usage(total).totalTokens);
    send(c, 'turn/completed', {
      turn: {
        id: turnId,
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'm-' + turnId }],
      },
    });
  }
  const summary = c.getConversations()[0];
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.cost.partial, false);
  c.ingestLocalRecords([row('r-t0', 't0', 1, 1), row('r-t1', 't1', 2, 3)], ['A']);
  assert.deepEqual(c.getConversations()[0], summary);
});

test('conversation switching isolates host identities and remote history cannot borrow local records', async () => {
  const [{ createAppServerUsageCollector }] = await api;
  const c = createAppServerUsageCollector();
  c.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  c.ingestLocalRecords([row('a', 't0', 1, 1)], ['A']);
  c.observeConversations([{ hostId: 'local', threadId: 'B' }]);
  assert.equal(c.getConversations()[0].total, null);
  c.ingestLocalRecords([row('b', 't0', 2, 2, 'B')], ['B']);
  assert.deepEqual(c.getConversations()[0].total, usage(2));
  c.observeConversations([{ hostId: 'remote', threadId: 'A' }]);
  assert.equal(c.getConversations()[0].total, null);
  c.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  assert.deepEqual(c.getConversations()[0].total, usage(1));
  c.observeConversations([]);
  assert.deepEqual(c.getConversations(), []);
});

test('missing request details keep price partial while a thread checkpoint still supplies the conversation total', async () => {
  const [{ createAppServerUsageCollector }] = await api;
  const c = createAppServerUsageCollector({
    getConfiguredModel: () => ({ id: 'gpt-6.1-sol', basis: 'configured' }),
  });
  c.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  send(c, 'turn/started', { turn: { id: 't1' } });
  send(c, 'thread/tokenUsage/updated', {
    turnId: 't1',
    tokenUsage: { last: usage(2), total: usage(10) },
  });
  const summary = c.getConversations()[0];
  assert.deepEqual(summary.total, usage(10));
  assert.equal(summary.coverage, 'partial');
  assert.equal(summary.requestCount, 1);
  assert.equal(summary.cost.partial, true);
});

test('recorded turn models restore the full historical conversation price and survive replay and restart', async () => {
  const [{ createAppServerUsageCollector }, schema, prices] = await api;
  const first = createAppServerUsageCollector();
  send(first, 'turn/started', { turn: { id: 't1' } });
  send(first, 'thread/tokenUsage/updated', {
    turnId: 't1',
    tokenUsage: { last: usage(50), total: usage(250) },
  });
  send(first, 'turn/completed', {
    turn: { id: 't1', status: 'completed', items: [{ type: 'agentMessage', id: 'm1' }] },
  });
  const collector = createAppServerUsageCollector({
    index: first.getIndex(),
    getConfiguredModel: () => ({ id: 'gpt-6-luna', basis: 'configured' }),
  });
  collector.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  const records = [
    {
      ...row('r0', 't0', 200, 200),
      model: { id: 'gpt-6.1-sol', basis: 'turn-context', text: 'PRIVATE_BODY' },
    },
    { ...row('r1', 't1', 50, 250), model: { id: 'gpt-6.1-sol', basis: 'turn-context' } },
    {
      ...row('r2', 't1', 75, 325),
      checkpoint: { turnTotal: usage(125), total: usage(325) },
      model: { id: 'gpt-6-astra', basis: 'turn-context' },
    },
  ];
  collector.ingestLocalRecords(records, ['A']);
  const summary = collector.getConversations()[0];
  const expected = records.reduce(
    (pico, report) =>
      pico +
      BigInt(
        prices.estimateStandardReference({
          model: report.model,
          usage: report.usage,
          requestCount: 1,
        }).picoUSD,
      ),
    0n,
  );
  assert.deepEqual(summary.total, usage(325));
  assert.equal(summary.coverage, 'complete');
  assert.equal(summary.requestCount, 3);
  assert.equal(summary.cost.pricedRequestCount, 3);
  assert.equal(summary.cost.unpricedRequestCount, 0);
  assert.equal(summary.cost.partial, false);
  assert.equal(summary.cost.amountUSD, Number(expected) / 1e12);
  const saved = collector.getIndex();
  assert.deepEqual(
    saved.records[0].requestReports.map((r) => r.model.id),
    ['gpt-6.1-sol', 'gpt-6-astra'],
  );
  assert.doesNotMatch(schema.serializeMessageUsage(saved), /PRIVATE_BODY|gpt-6-luna/);
  collector.ingestLocalRecords(records, ['A']);
  assert.deepEqual(collector.getIndex(), saved);
  assert.deepEqual(collector.getConversations()[0], summary);
  const restored = createAppServerUsageCollector({
    index: schema.parseMessageUsage(schema.serializeMessageUsage(saved, { compact: true })),
  });
  restored.observeConversations([{ hostId: 'local', threadId: 'A' }]);
  restored.ingestLocalRecords(records, ['A']);
  assert.deepEqual(restored.getConversations()[0], summary);
  const missing = {
    ...row('r3', 't2', 1, 326),
    model: { id: 'not-in-price-table', basis: 'turn-context' },
  };
  collector.ingestLocalRecords([missing], ['A']);
  assert.equal(collector.getConversations()[0].cost.partial, true);
  assert.equal(collector.getConversations()[0].cost.unpricedRequestCount, 1);
  assert.equal(collector.getConversations()[0].cost.amountUSD, summary.cost.amountUSD);
});

test('conversation bar presents cache hit rate after cached input and keeps unknown values isolated', async () => {
  const { createConversationBar } = await import('../src/ui/conversation-bar.mjs');
  const target = Object.assign(new EventTarget(), {
    __ctTokenConversationUsage: [
      {
        hostId: 'local',
        threadId: 'A',
        total: usage(1000),
        cost: { status: 'reference', amountUSD: 1.2, partial: true },
      },
    ],
  });
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const Bar = createConversationBar(React, target);
  const tree = Bar({ hostId: 'local', threadId: 'A' });
  const fields = tree.children[0].children;
  assert.deepEqual(
    fields.map((f) => f.children[0].children[0]),
    ['会话总用量', '输入', '输出', '缓存', '命中率', '花费'],
  );
  assert.deepEqual(
    fields.map((f) => f.children[1].children[0]),
    ['1.1M', '500K', '100K', '500K', '50%', '≈ $1.20+'],
  );
  assert.equal(fields[0].props.title, '1,100,000');
  assert.equal(fields[3].props.title, '500,000');
  assert.equal(fields[4].props.title, undefined);
  assert.equal(fields[5].props.title, undefined);
  const unknown = Bar({ hostId: 'remote', threadId: 'A' });
  assert.ok(unknown.children[0].children.every((f) => f.children[1].children[0] === '—'));
  target.__ctTokenConversationUsage[0].total = usage(0);
  const zero = Bar({ hostId: 'local', threadId: 'A' });
  assert.equal(zero.children[0].children[3].children[1].children[0], '0');
  assert.equal(zero.children[0].children[4].children[1].children[0], '—');
});
