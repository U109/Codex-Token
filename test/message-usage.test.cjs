const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../src/core/message-usage.mjs');
const record = (threadId, turnId, itemId, totalTokens, revision = 0) => ({
  mode: 'local-mock-provider',
  scope: 'turn-fixture',
  threadId,
  turnId,
  itemId,
  revision,
  usage: { total: { totalTokens, inputTokens: totalTokens - 20, outputTokens: 20 } },
});

test('each turn and thread keeps its own exact message record, never the newest value', async () => {
  const { createMessageUsageIndex, getMessageUsage } = await api;
  const index = createMessageUsageIndex([
    record('A', 't1', 'm1', 100),
    record('A', 't2', 'm2', 200),
    record('B', 't1', 'm1', 300),
  ]);
  for (const [thread, message, expected] of [
    ['A', 'm1', 100],
    ['B', 'm1', 300],
    ['A', 'm2', 200],
    ['A', 'm1', 100],
  ]) {
    assert.equal(getMessageUsage(index, thread, message).usage.total.totalTokens, expected);
  }
  assert.equal(getMessageUsage(index, 'A', 'missing'), null);
  assert.equal(getMessageUsage(index, 'missing', 'm1'), null);
});
test('new replies and updates retain every older reply without mutating snapshots', async () => {
  const { createMessageUsageIndex, mergeMessageUsage, getMessageUsage } = await api;
  const first = createMessageUsageIndex([record('A', 't1', 'm1', 100)]);
  const second = mergeMessageUsage(first, record('A', 't2', 'm2', 200));
  const third = mergeMessageUsage(second, record('A', 't1', 'm1', 120, 1));
  assert.equal(first.records.length, 1);
  assert.equal(third.records.length, 2);
  assert.equal(getMessageUsage(first, 'A', 'm1').usage.total.totalTokens, 100);
  assert.equal(getMessageUsage(third, 'A', 'm1').usage.total.totalTokens, 120);
  assert.equal(getMessageUsage(third, 'A', 'm2').usage.total.totalTokens, 200);
  assert.ok(Object.isFrozen(third.records[0].usage.total));
});
test('history survives JSON persistence and reconstruction, not just a global latest value', async () => {
  const { createMessageUsageIndex, serializeMessageUsage, parseMessageUsage, getMessageUsage } =
    await api;
  const restored = parseMessageUsage(
    serializeMessageUsage(
      createMessageUsageIndex([
        record('A', 't1', 'm1', 100),
        record('A', 't2', 'm2', 200),
        record('B', 't3', 'm3', 300),
      ]),
    ),
  );
  assert.equal(restored.records.length, 3);
  assert.equal(getMessageUsage(restored, 'A', 'm1').usage.total.totalTokens, 100);
  assert.equal(getMessageUsage(restored, 'B', 'm3').usage.total.totalTokens, 300);
});
test('missing values stay unknown while explicitly reported zero survives persistence', async () => {
  const { createMessageUsageIndex, serializeMessageUsage, parseMessageUsage } = await api;
  const value = record('A', 't1', 'm1', 0);
  value.usage.total = { totalTokens: 0, outputTokens: null, inputTokens: '0' };
  const [saved] = parseMessageUsage(
    serializeMessageUsage(createMessageUsageIndex([value])),
  ).records;
  assert.equal(saved.usage.total.totalTokens, 0);
  assert.equal(saved.usage.total.outputTokens, null);
  assert.equal(saved.usage.total.inputTokens, null);
});
test('stale or duplicate revisions cannot overwrite a newer reply', async () => {
  const { createMessageUsageIndex, mergeMessageUsage } = await api;
  const index = createMessageUsageIndex([record('A', 't1', 'm1', 200, 2)]);
  assert.equal(mergeMessageUsage(index, record('A', 't1', 'm1', 100, 1)), index);
  assert.equal(mergeMessageUsage(index, record('A', 't1', 'm1', 200, 2)), index);
  assert.throws(() => mergeMessageUsage(index, record('A', 't1', 'm1', 300, 2)), /Conflicting/);
});
test('message identities cannot be rebound, collide across concatenated keys or accept missing turn IDs', async () => {
  const { createMessageUsageIndex, mergeMessageUsage, getMessageUsage } = await api;
  const index = createMessageUsageIndex([
    record('A:B', 't1', 'C', 100),
    record('A', 't2', 'B:C', 200),
  ]);
  assert.equal(getMessageUsage(index, 'A:B', 'C').usage.total.totalTokens, 100);
  assert.throws(() => mergeMessageUsage(index, record('A:B', 'other-turn', 'C', 300)), /rebound/);
  assert.throws(() => createMessageUsageIndex([record('A', '', 'm1', 100)]), /binding/);
  assert.throws(
    () => createMessageUsageIndex([{ ...record('A', 't1', 'm1', 100), scope: 'thread' }]),
    /binding/,
  );
});
test('persistent records whitelist metadata and never retain response text or credentials', async () => {
  const { createMessageUsageIndex, serializeMessageUsage } = await api;
  const raw = {
    ...record('A', 't1', 'm1', 100),
    text: 'private-response',
    apiKey: 'private-key',
    model: { id: 'ct-lab', prompt: 'private-prompt' },
    pricing: { provider: 'openai', authorization: 'private-header' },
  };
  assert.doesNotMatch(
    serializeMessageUsage(createMessageUsageIndex([raw])),
    /private-|apiKey|authorization|prompt/,
  );
});
test('per-request persistence validates counts, freezes metadata and excludes unrelated nested fields', async () => {
  const { createMessageUsageIndex, serializeMessageUsage, parseMessageUsage } = await api;
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 5,
  };
  const raw = {
    ...record('A', 't1', 'm1', 120),
    source: { requestCount: 1 },
    requestReports: [
      {
        sequence: 1,
        model: { id: 'gpt-6.1-sol', basis: 'configured', prompt: 'private-prompt' },
        usage: { ...usage, text: 'private-body' },
        response: 'private-response',
      },
    ],
    observation: {
      scope: 'turn-observed-window',
      durationMs: 2000,
      outputTokens: 20,
      samples: 1,
      coverage: 'turn',
      includesWaiting: true,
      apiKey: 'private-key',
    },
  };
  const index = createMessageUsageIndex([raw]),
    text = serializeMessageUsage(index),
    saved = parseMessageUsage(text).records[0];
  assert.doesNotMatch(text, /private-|apiKey|prompt|response/);
  assert.deepEqual(saved.requestReports[0].usage, usage);
  assert.equal(saved.observation.durationMs, 2000);
  assert.equal(Object.isFrozen(saved.requestReports[0].model), true);
  for (const change of [
    { sequence: 2 },
    { usage: { ...usage, totalTokens: 1 } },
    { usage: { ...usage, cachedInputTokens: 100, cacheWriteInputTokens: 1 } },
    { usage: { ...usage, reasoningOutputTokens: 21 } },
  ]) {
    assert.throws(
      () =>
        createMessageUsageIndex([
          { ...raw, requestReports: [{ ...raw.requestReports[0], ...change }] },
        ]),
      /request report/,
    );
  }
});

test('corrupt or unsupported persistence fails closed rather than supplying another record', async () => {
  const { parseMessageUsage, getMessageUsage } = await api;
  for (const text of [
    'not-json',
    'null',
    '{"version":2,"records":[]}',
    '{"version":1,"records":{}}',
  ]) {
    assert.throws(() => parseMessageUsage(text));
  }
  assert.equal(getMessageUsage({ records: [] }, 'A', 'm1'), null);
});

test('0.4.11 missing aggregates are recovered only from the exact saved request reports as partial usage', async () => {
  const { createMessageUsageIndex, parseMessageUsage, serializeMessageUsage, getMessageUsage } =
    await api;
  const usage = {
    inputTokens: 25535,
    cachedInputTokens: 25216,
    cacheWriteInputTokens: 0,
    outputTokens: 52,
    reasoningOutputTokens: 37,
    totalTokens: 25587,
  };
  const raw = {
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    threadId: 'A',
    turnId: 't1',
    itemId: 'm1',
    source: { coverage: 'unknown', requestCount: 1, status: 'completed' },
    usage: { total: {} },
    requestReports: [{ sequence: 1, model: { id: 'gpt-6.1-sol', basis: 'configured' }, usage }],
  };
  const document = JSON.stringify({
    version: 1,
    mode: raw.mode,
    scope: 'message-usage-index',
    records: [raw, { ...raw, hostId: 'remote', requestReports: undefined }],
  });
  const index = parseMessageUsage(document),
    saved = getMessageUsage(index, 'A', 'm1');
  assert.deepEqual(saved.usage.total, usage);
  assert.equal(saved.source.coverage, 'partial');
  assert.deepEqual(saved.requestReports, raw.requestReports);
  assert.equal(getMessageUsage(index, 'A', 'm1', 'remote').usage.total.totalTokens, null);
  assert.equal(getMessageUsage(index, 'A', 'm1', 'local', 'other-turn'), null);
  assert.ok(Object.isFrozen(saved.usage.total));
  assert.deepEqual(
    parseMessageUsage(serializeMessageUsage(index)),
    index,
    'Recovery remains stable across repeated loads',
  );
  assert.deepEqual(
    createMessageUsageIndex([raw], { mode: raw.mode }).records[0],
    saved,
    'Duplicate normalization uses the same canonical record',
  );
});

test('legacy recovery does not guess missing requests, overwrite conflicting totals or overflow counts', async () => {
  const { createMessageUsageIndex } = await api;
  const usage = {
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
    totalTokens: 120,
  };
  const raw = {
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
    threadId: 'A',
    turnId: 't1',
    itemId: 'm1',
    source: { coverage: 'unknown', requestCount: 1, status: 'completed' },
    usage: { total: {} },
    requestReports: [{ sequence: 1, usage }],
  };
  const large = {
    ...usage,
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
  };
  for (const value of [
    { ...raw, requestReports: undefined },
    { ...raw, requestReports: [] },
    { ...raw, source: { ...raw.source, requestCount: 2 } },
    { ...raw, usage: { total: { inputTokens: 50 } } },
    { ...raw, usage: { total: { totalTokens: -1 } } },
    { ...raw, usage: { total: { totalTokens: '120' } } },
    {
      ...raw,
      source: { ...raw.source, requestCount: 2 },
      requestReports: [
        { sequence: 1, usage: large },
        { sequence: 2, usage: large },
      ],
    },
  ]) {
    const saved = createMessageUsageIndex([value], { mode: raw.mode }).records[0];
    assert.equal(saved.usage.total.totalTokens, null);
    assert.equal(saved.source.coverage, 'unknown');
  }
  const zero = Object.fromEntries(Object.keys(usage).map((k) => [k, 0]));
  const saved = createMessageUsageIndex(
    [{ ...raw, requestReports: [{ sequence: 1, usage: zero }] }],
    { mode: raw.mode },
  ).records[0];
  assert.equal(saved.usage.total.totalTokens, 0);
  assert.equal(saved.source.coverage, 'partial');
});
test('live records require an explicit host and remain isolated from mock records and other hosts/turns', async () => {
  const { createMessageUsageIndex, getMessageUsage, parseMessageUsage, serializeMessageUsage } =
    await api;
  const live = {
    ...record('A', 't1', 'm1', 100),
    mode: 'app-server-reported',
    scope: 'turn-reported',
    hostId: 'local',
  };
  const index = createMessageUsageIndex(
    [live, { ...live, hostId: 'remote', usage: { total: { totalTokens: 200 } } }],
    { mode: live.mode },
  );
  const restored = parseMessageUsage(serializeMessageUsage(index));
  assert.equal(getMessageUsage(restored, 'A', 'm1', 'local', 't1').usage.total.totalTokens, 100);
  assert.equal(getMessageUsage(restored, 'A', 'm1', 'remote').usage.total.totalTokens, 200);
  assert.equal(getMessageUsage(restored, 'A', 'm1', 'local', 'other-turn'), null);
  assert.equal(getMessageUsage(restored, 'A', 'm1', 'missing-host'), null);
  assert.throws(
    () => createMessageUsageIndex([{ ...live, hostId: undefined }], { mode: live.mode }),
    /binding/,
  );
  assert.throws(() => createMessageUsageIndex([live]), /binding/);
});
