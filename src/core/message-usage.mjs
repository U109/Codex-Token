import { cleanCheckpoint, usageId } from './request-usage.mjs';
import { MODEL_TIMING_VERSION } from './model-timing.mjs';
/**
 * 消息用量记录：只接收白名单元数据，集中处理身份、版本和历史恢复。
 * 这里不采集事件；null 表示未知，与实际收到的 0 严格区分。
 */
// 此处只管理展示记录；采集和覆盖检查由适配器负责。
// 每条记录必须归属确定的线程、回合和助手消息，不借用最新记录、相减线程累计量或淘汰旧消息。
const MODE = 'local-mock-provider';
const SCOPES = {
  'local-mock-provider': { index: 'message-fixture-index', record: 'turn-fixture' },
  'app-server-reported': { index: 'message-usage-index', record: 'turn-reported' },
};
const id = (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
const fields = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
];
const pricingFields = [
  'provider',
  'model',
  'priceVersion',
  'startedAt',
  'billingMode',
  'endpoint',
  'modality',
  'serviceTier',
  'fastEnabled',
  'billingPeriod',
  'basis',
];
const pick = (value, names) =>
  Object.freeze(
    Object.fromEntries(
      names
        .filter((name) => {
          const item = value?.[name];
          return (
            item === null ||
            typeof item === 'boolean' ||
            (typeof item === 'string' && item.length <= 300) ||
            (typeof item === 'number' && Number.isFinite(item))
          );
        })
        .map((name) => [name, value[name]]),
    ),
  );
const key = (record) => JSON.stringify([record.hostId ?? 'local', record.threadId, record.itemId]);

function cleanRequestReports(reports) {
  if (!Array.isArray(reports) || reports.length > 10000)
    throw new TypeError('Invalid request report list');
  const responseIds = new Set();
  return Object.freeze(
    reports.map((report, index) => {
      if (
        report?.sequence !== index + 1 ||
        !fields.every(
          (name) => Number.isSafeInteger(report.usage?.[name]) && report.usage[name] >= 0,
        )
      ) {
        throw new TypeError('Invalid request report');
      }
      const usage = Object.fromEntries(fields.map((name) => [name, report.usage[name]]));
      if (
        usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
        usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens ||
        usage.reasoningOutputTokens > usage.outputTokens
      )
        throw new TypeError('Inconsistent request report');
      const checkpoint =
        report.checkpoint === undefined ? undefined : cleanCheckpoint(report.checkpoint);
      if (
        checkpoint === null ||
        (report.responseId !== undefined &&
          (!usageId(report.responseId) ||
            responseIds.has(report.responseId) ||
            !checkpoint?.turnTotal))
      )
        throw new TypeError('Invalid request identity or checkpoint');
      if (report.responseId) responseIds.add(report.responseId);
      return Object.freeze({
        sequence: index + 1,
        ...(report.responseId ? { responseId: report.responseId } : {}),
        ...(checkpoint ? { checkpoint } : {}),
        model: pick(report.model, ['provider', 'id', 'basis']),
        usage: Object.freeze(usage),
      });
    }),
  );
}

function cleanRecord(record, mode) {
  if (
    !Object.hasOwn(SCOPES, mode) ||
    record?.mode !== mode ||
    record.scope !== SCOPES[mode].record ||
    !id(record.hostId ?? (mode === MODE ? 'local' : null)) ||
    !['threadId', 'turnId', 'itemId'].every((field) => id(record[field]))
  ) {
    throw new TypeError('An exact host, thread, turn and message binding is required');
  }
  const revision = record.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new TypeError('Invalid record revision');
  let total = Object.fromEntries(
    fields.map((field) => {
      const value = record.usage?.total?.[field];
      return [field, Number.isSafeInteger(value) && value >= 0 ? value : null];
    }),
  );
  const requestReports =
    record.requestReports !== undefined ? cleanRequestReports(record.requestReports) : undefined;
  let source = pick(record.source, ['coverage', 'requestCount', 'status']);
  // 0.4.11 保留了有效请求明细，却清空了已完成回合的部分小计；仅从同条记录恢复空小计。
  // 覆盖状态仍为部分观测，不能用线程累计量、当前型号或其他记录补历史。
  // 在版本检查前完成稳定的规范化，确保恢复过程可重复执行。
  if (
    mode === 'app-server-reported' &&
    source.coverage === 'unknown' &&
    requestReports?.length > 0 &&
    requestReports.length === source.requestCount &&
    fields.every((field) => record.usage?.total?.[field] == null)
  ) {
    const observed = Object.fromEntries(
      fields.map((field) => [
        field,
        requestReports.reduce((sum, report) => sum + report.usage[field], 0),
      ]),
    );
    if (fields.every((field) => Number.isSafeInteger(observed[field]))) {
      total = observed;
      source = Object.freeze({ ...source, coverage: 'partial' });
    }
  }
  return Object.freeze({
    mode,
    scope: SCOPES[mode].record,
    hostId: record.hostId ?? 'local',
    threadId: record.threadId,
    turnId: record.turnId,
    itemId: record.itemId,
    revision,
    model: pick(record.model, ['provider', 'id', 'basis']),
    timing: pick(record.timing, ['scope', 'durationMs', 'requestId', 'origin']),
    source,
    pricing: pick(record.pricing, pricingFields),
    usage: Object.freeze({ total: Object.freeze(total) }),
    ...(requestReports !== undefined ? { requestReports } : {}),
    ...(record.modelTiming?.algorithmVersion === MODEL_TIMING_VERSION
      ? {
          modelTiming: pick(record.modelTiming, [
            'algorithmVersion',
            'scope',
            'basis',
            'excludesTools',
            'durationMs',
            'outputTokens',
            'samples',
            'excludedToolMs',
            'coverage',
          ]),
        }
      : {}),
    ...(record.observation
      ? {
          observation: pick(record.observation, [
            'scope',
            'durationMs',
            'outputTokens',
            'samples',
            'coverage',
            'includesWaiting',
          ]),
        }
      : {}),
  });
}

export function isMessageUsageIndex(index) {
  return (
    index?.version === 1 &&
    Object.hasOwn(SCOPES, index.mode) &&
    index.scope === SCOPES[index.mode].index &&
    Array.isArray(index.records)
  );
}

/** 校验并冻结整个索引；模拟数据与真实上报使用独立的来源命名空间。 */
export function createMessageUsageIndex(records = [], { mode = MODE } = {}) {
  if (!Object.hasOwn(SCOPES, mode)) throw new TypeError('Unsupported usage source');
  if (!Array.isArray(records) || records.length > 10000)
    throw new TypeError('Invalid message record list');
  const unique = new Map();
  for (const raw of records) {
    const record = cleanRecord(raw, mode),
      previous = unique.get(key(record));
    if (previous && previous.turnId !== record.turnId)
      throw new Error('A message cannot be rebound to another turn');
    if (previous && previous.revision > record.revision) continue;
    if (
      previous &&
      previous.revision === record.revision &&
      JSON.stringify(previous) !== JSON.stringify(record)
    ) {
      throw new Error('Conflicting message record revision');
    }
    unique.set(key(record), record);
  }
  return Object.freeze({
    version: 1,
    mode,
    scope: SCOPES[mode].index,
    records: Object.freeze([...unique.values()]),
  });
}

/** 按完整身份匹配记录；可选 turnId 也必须一致，不能借用其他回复的数据。 */
export function getMessageUsage(index, threadId, itemId, hostId = 'local', turnId) {
  if (
    !isMessageUsageIndex(index) ||
    ![hostId, threadId, itemId].every(id) ||
    (turnId !== undefined && !id(turnId))
  )
    return null;
  const matches = index.records.filter(
    (record) =>
      (record.hostId ?? 'local') === hostId &&
      record.threadId === threadId &&
      record.itemId === itemId,
  );
  if (
    matches.length !== 1 ||
    matches[0].mode !== index.mode ||
    matches[0].scope !== SCOPES[index.mode].record ||
    !id(matches[0].turnId) ||
    (turnId !== undefined && matches[0].turnId !== turnId)
  )
    return null;
  return matches[0];
}

/** 用 revision 幂等更新单条记录；旧版本忽略，同版本内容冲突则拒绝。 */
export function mergeMessageUsage(index, record) {
  if (!isMessageUsageIndex(index)) throw new TypeError('Invalid message usage index');
  const next = cleanRecord(record, index.mode),
    previous = getMessageUsage(index, next.threadId, next.itemId, next.hostId);
  if (previous && previous.turnId !== next.turnId)
    throw new Error('A message cannot be rebound to another turn');
  if (previous && previous.revision > next.revision) return index;
  if (previous && previous.revision === next.revision) {
    if (JSON.stringify(previous) !== JSON.stringify(next))
      throw new Error('Conflicting message record revision');
    return index;
  }
  return createMessageUsageIndex(
    [...index.records.filter((item) => key(item) !== key(next)), next],
    { mode: index.mode },
  );
}

export function serializeMessageUsage(index, { compact = false } = {}) {
  if (!isMessageUsageIndex(index)) throw new TypeError('Invalid message usage index');
  const clean = createMessageUsageIndex(index.records, { mode: index.mode });
  if (compact) {
    // 多条助手消息共享同一轮统计；磁盘只存一份快照，消息保留独立身份和版本。
    const snapshots = [],
      lookup = new Map();
    const bindings = clean.records.map(({ itemId, revision, ...snapshot }) => {
      const signature = JSON.stringify(snapshot);
      let reference = lookup.get(signature);
      if (reference === undefined) {
        reference = snapshots.length;
        lookup.set(signature, reference);
        snapshots.push(snapshot);
      }
      return { snapshot: reference, itemId, revision };
    });
    return (
      JSON.stringify({
        version: 2,
        mode: clean.mode,
        scope: 'message-usage-storage',
        snapshots,
        bindings,
      }) + '\n'
    );
  }
  return JSON.stringify(clean, null, 2) + '\n';
}

/** 从有大小上限的 JSON 恢复索引，重新校验每条记录，不信任持久化输入。 */
export function parseMessageUsage(text) {
  if (typeof text !== 'string' || text.length > 10_000_000)
    throw new TypeError('Invalid message usage document');
  const index = JSON.parse(text);
  if (index?.version === 2 && index.scope === 'message-usage-storage') {
    if (
      !Object.hasOwn(SCOPES, index.mode) ||
      !Array.isArray(index.snapshots) ||
      !Array.isArray(index.bindings) ||
      index.snapshots.length > 10000 ||
      index.bindings.length > 10000
    )
      throw new TypeError('Invalid shared usage document');
    let expanded = 0;
    const sizes = index.snapshots.map((snapshot) => JSON.stringify(snapshot).length);
    const records = index.bindings.map((binding) => {
      const reference = binding?.snapshot;
      if (!Number.isSafeInteger(reference) || reference < 0 || reference >= index.snapshots.length)
        throw new TypeError('Invalid usage snapshot reference');
      expanded += sizes[reference];
      if (expanded > 100_000_000) throw new TypeError('Usage document expansion limit');
      return { ...index.snapshots[reference], itemId: binding.itemId, revision: binding.revision };
    });
    return createMessageUsageIndex(records, { mode: index.mode });
  }
  if (!isMessageUsageIndex(index)) throw new TypeError('Unsupported message usage document');
  return createMessageUsageIndex(index.records, { mode: index.mode });
}
