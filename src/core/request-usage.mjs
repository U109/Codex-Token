// 请求级白名单及双来源对账。客户端没有 responseId，只能用同一请求的累计检查点核对。
export const USAGE_FIELDS = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
];
export const usageId = (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
export const equalUsage = (a, b) => USAGE_FIELDS.every((field) => a?.[field] === b?.[field]);
export const emptyUsage = () => Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
const cleanRequestModel = (raw) => {
  if (typeof raw?.id !== 'string' || !/^[\w./:-]{1,200}$/.test(raw.id)) return Object.freeze({});
  return Object.freeze({
    id: raw.id,
    ...(usageId(raw.provider) ? { provider: raw.provider } : {}),
    ...(['configured', 'reported', 'turn-context'].includes(raw.basis) ? { basis: raw.basis } : {}),
  });
};
/** 实际路由优先于历史配置，历史配置优先于界面选择；补全模型不改变请求身份或用量。 */
export function mergeRequestModel(previous, incoming) {
  const rank = (model) =>
    !model.id ? 0 : model.basis === 'reported' ? 3 : model.basis === 'turn-context' ? 2 : 1;
  const before = cleanRequestModel(previous),
    after = cleanRequestModel(incoming);
  return rank(after) > rank(before) ? after : before;
}
export function cleanUsage(raw) {
  if (!raw || !USAGE_FIELDS.every((field) => Number.isSafeInteger(raw[field]) && raw[field] >= 0))
    return null;
  if (
    raw.totalTokens !== raw.inputTokens + raw.outputTokens ||
    raw.cachedInputTokens + raw.cacheWriteInputTokens > raw.inputTokens ||
    raw.reasoningOutputTokens > raw.outputTokens
  )
    return null;
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, raw[field]]));
}
export function addUsage(a, b) {
  const result = Object.fromEntries(USAGE_FIELDS.map((field) => [field, a[field] + b[field]]));
  return USAGE_FIELDS.every((field) => Number.isSafeInteger(result[field])) ? result : null;
}
export function sumRequests(reports) {
  return reports.reduce((total, report) => total && addUsage(total, report.usage), emptyUsage());
}
export function cleanCheckpoint(raw) {
  const total = cleanUsage(raw?.total);
  const turnTotal = raw?.turnTotal === undefined ? undefined : cleanUsage(raw.turnTotal);
  if (!total || turnTotal === null) return null;
  return Object.freeze({
    total: Object.freeze(total),
    ...(turnTotal ? { turnTotal: Object.freeze(turnTotal) } : {}),
  });
}
export function cleanLocalUsage(raw) {
  if (!['threadId', 'turnId', 'responseId'].every((field) => usageId(raw?.[field]))) return null;
  const usage = cleanUsage(raw.usage),
    checkpoint = cleanCheckpoint(raw.checkpoint);
  if (!usage || !checkpoint?.turnTotal) return null;
  // 请求不能超过本轮累计，本轮累计不能超过线程累计。
  if (
    !USAGE_FIELDS.every(
      (field) =>
        usage[field] <= checkpoint.turnTotal[field] &&
        checkpoint.turnTotal[field] <= checkpoint.total[field],
    )
  )
    return null;
  return {
    threadId: raw.threadId,
    turnId: raw.turnId,
    responseId: raw.responseId,
    usage,
    checkpoint,
    model: cleanRequestModel(raw.model?.basis === 'turn-context' ? raw.model : null),
    replay: raw.replay !== false,
  };
}

/** 不按相同用量猜请求；同 ID 冲突拒绝，跨来源只有累计检查点和请求用量都一致才合并。 */
export function mergeRequest(reports, incoming) {
  let match = incoming.responseId
    ? reports.findIndex((report) => report.responseId === incoming.responseId)
    : -1;
  if (match >= 0) {
    const previous = reports[match];
    if (
      !equalUsage(previous.usage, incoming.usage) ||
      !equalUsage(previous.checkpoint?.total, incoming.checkpoint?.total) ||
      !equalUsage(previous.checkpoint?.turnTotal, incoming.checkpoint?.turnTotal)
    )
      return { status: 'conflict' };
    const model = mergeRequestModel(previous.model, incoming.model);
    if (JSON.stringify(model) === JSON.stringify(previous.model ?? {}))
      return { status: 'duplicate', reports, added: false };
    const next = [...reports];
    next[match] = Object.freeze({ ...previous, model });
    return { status: 'updated', reports: next, added: false };
  }
  const atCheckpoint = reports.filter(
    (report) =>
      incoming.checkpoint &&
      report.checkpoint &&
      equalUsage(report.checkpoint.total, incoming.checkpoint.total),
  );
  const conflicting =
    incoming.usage.totalTokens > 0 &&
    atCheckpoint.some(
      (report) => report.usage.totalTokens > 0 && !equalUsage(report.usage, incoming.usage),
    );
  if (conflicting) return { status: 'conflict' };
  const counterpart = atCheckpoint.find(
    (report) =>
      equalUsage(report.usage, incoming.usage) && (!incoming.responseId || !report.responseId),
  );
  if (counterpart) {
    if (!incoming.responseId) {
      const model = mergeRequestModel(counterpart.model, incoming.model);
      if (JSON.stringify(model) === JSON.stringify(counterpart.model ?? {}))
        return { status: 'duplicate', reports, added: false };
      const next = [...reports];
      next[next.indexOf(counterpart)] = Object.freeze({ ...counterpart, model });
      return { status: 'updated', reports: next, added: false };
    }
    match = reports.indexOf(counterpart);
  } else if (
    incoming.usage.totalTokens > 0 &&
    atCheckpoint.some((report) => report.usage.totalTokens > 0)
  ) {
    // 不同非零请求不能占用同一累计检查点。
    return { status: 'conflict' };
  }
  const next = [...reports];
  if (match >= 0)
    next[match] = { ...incoming, model: mergeRequestModel(reports[match].model, incoming.model) };
  else next.push(incoming);
  if (next.length > 10000 || !sumRequests(next)) return { status: 'overflow' };
  // turnTotal 在完整本地序列中给出顺序；客户端报告使用线程检查点。
  next.sort(
    (a, b) => (a.checkpoint?.total.totalTokens ?? 0) - (b.checkpoint?.total.totalTokens ?? 0),
  );
  return {
    status: 'accepted',
    added: match < 0,
    reports: next.map((report, index) => Object.freeze({ ...report, sequence: index + 1 })),
  };
}

/** 从零开始逐请求验证本轮累计；不能用一份累计量代替漏掉的请求明细。 */
export function completeLocalRequests(reports) {
  if (
    !reports.length ||
    reports.some((report) => !report.responseId || !report.checkpoint?.turnTotal)
  )
    return false;
  let total = emptyUsage();
  for (const report of [...reports].sort(
    (a, b) => a.checkpoint.turnTotal.totalTokens - b.checkpoint.turnTotal.totalTokens,
  )) {
    total = addUsage(total, report.usage);
    if (!total || !equalUsage(total, report.checkpoint.turnTotal)) return false;
  }
  return true;
}

/** 已读完且从零核对完整的本地序列覆盖其前缀；较新的通知仍作为兜底保留。 */
export function reconcileLocalPrefix(reports, localReports) {
  const latest = Math.max(...localReports.map((report) => report.checkpoint.total.totalTokens));
  const identities = new Set(localReports.map((report) => report.responseId));
  if (
    reports.some(
      (report) =>
        report.responseId &&
        !identities.has(report.responseId) &&
        report.checkpoint.total.totalTokens <= latest,
    )
  )
    return null;
  let next = localReports.map((report) => {
    const previous = reports.find(
      (old) =>
        equalUsage(old.usage, report.usage) &&
        equalUsage(old.checkpoint?.total, report.checkpoint.total) &&
        (!old.responseId || old.responseId === report.responseId),
    );
    return previous
      ? { ...report, model: mergeRequestModel(previous.model, report.model) }
      : report;
  });
  for (const report of reports) {
    if (!report.checkpoint || report.checkpoint.total.totalTokens <= latest) continue;
    const merged = mergeRequest(next, report);
    if (!merged.reports) return null;
    next = merged.reports;
  }
  return next.map((report, index) => Object.freeze({ ...report, sequence: index + 1 }));
}
