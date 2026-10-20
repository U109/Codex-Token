import {
  USAGE_FIELDS,
  cleanUsage,
  emptyUsage,
  addUsage,
  equalUsage,
  completeLocalRequests,
  mergeRequest,
  reconcileLocalPrefix,
} from './request-usage.mjs';
import { estimateStandardReference } from './pricing.mjs';

/** 会话累计与消息归属分开：同一回合的多条消息只取一份，请求按身份和检查点核对。 */
export function summarizeConversation({ hostId, threadId, index, active = [], localTurns = [] }) {
  const turns = new Map();
  for (const record of index.records) {
    if (record.hostId !== hostId || record.threadId !== threadId) continue;
    const previous = turns.get(record.turnId);
    if (!previous || record.revision > previous.revision) turns.set(record.turnId, record);
  }
  for (const record of active) {
    if (record.hostId === hostId && record.threadId === threadId) turns.set(record.turnId, record);
  }
  const local = hostId === 'local' ? localTurns.filter((state) => state.threadId === threadId) : [];
  const states = new Map(local.map((state) => [state.turnId, state]));
  const turnIds = new Set([...turns.keys(), ...states.keys()]);
  let requests = [],
    fallback = emptyUsage(),
    fallbackKnown = false,
    conflict = false;
  let allLocal =
    local.length > 0 &&
    local.every(
      (state) => state.caughtUp && !state.conflict && completeLocalRequests(state.reports),
    );
  for (const turnId of turnIds) {
    const record = turns.get(turnId),
      state = states.get(turnId);
    let reports = record?.requestReports ?? [];
    if (state?.reports.length) {
      if (state.caughtUp && !state.conflict && completeLocalRequests(state.reports)) {
        const reconciled = reconcileLocalPrefix(reports, state.reports);
        if (reconciled) reports = reconciled;
        else {
          conflict = true;
          reports = state.reports;
        }
      } else if (reports.every((report) => report.checkpoint)) {
        for (const report of state.reports) {
          const merged = mergeRequest(reports, report);
          if (merged.reports) reports = merged.reports;
          else conflict = true;
        }
      }
    } else allLocal = false;
    requests.push(...reports);
    const total = cleanUsage(record?.usage.total);
    if (total) {
      fallback = fallback && addUsage(fallback, total);
      fallbackKnown = true;
    }
    if (state?.conflict) conflict = true;
  }
  // 精确的线程累计可以用于会话总量，不能把它拆成虚构的请求或回合明细。
  const checkpoints = [...local.flatMap((state) => state.reports), ...requests]
    .map((report) => report.checkpoint?.total)
    .filter(Boolean);
  const latest = checkpoints.reduce(
    (max, total) => (!max || total.totalTokens > max.totalTokens ? total : max),
    null,
  );
  const total = latest ?? (fallbackKnown ? fallback : null);
  let observed = emptyUsage();
  for (const report of requests) observed = observed && addUsage(observed, report.usage);
  const complete = !!total && allLocal && !conflict && equalUsage(observed, total);
  let pico = 0n,
    priced = 0,
    unpriced = 0;
  for (const report of requests) {
    const estimate = estimateStandardReference({
      model: report.model,
      usage: report.usage,
      requestCount: 1,
    });
    if (estimate.status === 'reference') {
      pico += BigInt(estimate.picoUSD);
      priced++;
    } else unpriced++;
  }
  return Object.freeze({
    hostId,
    threadId,
    total: total
      ? Object.freeze(Object.fromEntries(USAGE_FIELDS.map((field) => [field, total[field]])))
      : null,
    coverage: complete ? 'complete' : total ? 'partial' : 'unknown',
    requestCount: requests.length,
    cost: Object.freeze({
      status: priced ? 'reference' : 'unknown',
      amountUSD: priced ? Number(pico) / 1e12 : null,
      partial: !complete || unpriced > 0,
      pricedRequestCount: priced,
      unpricedRequestCount: unpriced,
    }),
  });
}
