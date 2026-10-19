// 被动适配 app-server 通知，只处理元数据，不发起 RPC 或模型调用，不读取正文或凭据。
// last 代表单次请求；回合用量只累加已观测的独立请求，累计量仅用于校验连续性。
import {
  createMessageUsageIndex,
  getMessageUsage,
  mergeMessageUsage,
} from '../core/message-usage.mjs';
import { createModelRequestTimer } from '../core/model-timing.mjs';

const FIELDS = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
];
const id = (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
const key = (...parts) => JSON.stringify(parts);
const same = (a, b) => FIELDS.every((field) => a?.[field] === b?.[field]);
const counts = (raw) => {
  if (!raw || !FIELDS.every((field) => Number.isSafeInteger(raw[field]) && raw[field] >= 0))
    return null;
  if (
    raw.totalTokens !== raw.inputTokens + raw.outputTokens ||
    raw.cachedInputTokens > raw.inputTokens ||
    raw.cachedInputTokens + raw.cacheWriteInputTokens > raw.inputTokens ||
    raw.reasoningOutputTokens > raw.outputTokens
  )
    return null;
  return Object.fromEntries(FIELDS.map((field) => [field, raw[field]]));
};
const add = (a, b) => {
  const result = Object.fromEntries(FIELDS.map((field) => [field, a[field] + b[field]]));
  return FIELDS.every((field) => Number.isSafeInteger(result[field])) ? result : null;
};
const empty = () => Object.fromEntries(FIELDS.map((field) => [field, 0]));
const TOOL_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
  'contextCompaction',
]);
const modelConfig = (raw) => {
  if (typeof raw?.model !== 'string' || !/^[\w./:-]{1,200}$/.test(raw.model)) return {};
  return {
    id: raw.model,
    ...(id(raw.modelProvider) ? { provider: raw.modelProvider } : {}),
    basis: 'configured',
  };
};

/**
 * 被动消费宿主通知，按 host/thread/turn 聚合已观测的独立请求。
 * 线程累计量仅用于检查连续性；缺少起始事件、断线或跳报会降低覆盖完整性。
 * 完成时将本轮统计绑定到明确出现的助手消息，不采集消息正文。
 */
export function createAppServerUsageCollector({
  mode = 'app-server-reported',
  index = createMessageUsageIndex([], { mode }),
  onChange = () => {},
  onActiveChange = () => {},
  getConfiguredModel = () => null,
  onDiagnostic = () => {},
  maxActiveTurns = 1000,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  // 同时校验来源和所有恢复记录，模拟数据与真实上报不得混用。
  let current = createMessageUsageIndex(index.records, { mode });
  if (index.mode !== mode) throw new TypeError('Usage source mismatch');
  if (!Number.isSafeInteger(maxActiveTurns) || maxActiveTurns < 1)
    throw new TypeError('Invalid active turn limit');
  // turns 保存未结束回合，snapshots 检查同一线程的计数连续性，models 保存配置线索。
  // 历史记录在 current 中，不能从这些临时状态反向补造历史。
  const turns = new Map(),
    snapshots = new Map(),
    models = new Map();
  let active = Object.freeze([]);
  const diagnose = (code) => {
    try {
      onDiagnostic({ code });
    } catch {
      /* 诊断回调不能影响宿主。 */
    }
  };
  const rememberThread = (map, name, value) => {
    if (!map.has(name) && map.size >= 10000) throw new Error('Thread metadata capacity reached');
    map.set(name, value);
  };
  const turnModel = (hostId, threadId, observed) => {
    const notified = models.get(key(hostId, threadId)) ?? {};
    // 仅在观测到回合开始时保存宿主配置，不能事后用当前选择补全历史或漏观测回合的型号。
    if (observed) {
      try {
        const current = getConfiguredModel(hostId, threadId);
        if (current?.basis === 'configured') {
          const clean = modelConfig({ model: current.id });
          if (clean.id) return notified.id === clean.id ? notified : clean;
        }
      } catch {}
    }
    return notified;
  };
  const makeTurn = (hostId, threadId, turnId, observed) => ({
    hostId,
    threadId,
    turnId,
    observed,
    incomplete: !observed,
    disconnected: false,
    requests: 0,
    total: empty(),
    messages: new Set(),
    reports: new Set(),
    model: observed ? turnModel(hostId, threadId, true) : {},
    requestReports: [],
    pendingModel: null,
    observationStart: now(),
    observationBase: 0,
    observationSamples: 0,
    resetObservation: !observed,
    modelTimer: createModelRequestTimer({ now, started: observed }),
  });
  const observation = (turn) =>
    Object.freeze({
      scope: 'turn-observed-window',
      durationMs: Math.max(0, now() - turn.observationStart),
      outputTokens: turn.total.outputTokens - turn.observationBase,
      samples: turn.resetObservation ? 0 : turn.observationSamples,
      coverage: turn.observed && !turn.incomplete ? 'turn' : 'partial',
      includesWaiting: true,
    });
  const syncModel = (turn) => {
    // 切换选择不能证明进行中的请求使用了该型号。已计价报告保持原样，
    // 后续归属需等待下一次观测到的回合，或服务端明确的路由变更通知。
    try {
      const configured = getConfiguredModel(turn.hostId, turn.threadId);
      if (configured?.id && turn.model.id && configured.id !== turn.model.id) turn.model = {};
    } catch {}
  };
  const publishActive = () => {
    // 运行中快照只留在内存；完成后可保存已观测的部分小计，但必须保留覆盖范围说明。
    active = Object.freeze(
      [...turns.values()].map((turn) =>
        Object.freeze({
          hostId: turn.hostId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          scope: 'active-turn-reports',
          model: Object.freeze({ ...turn.model }),
          source: Object.freeze({
            coverage: turn.incomplete ? 'partial' : 'observed-so-far',
            requestCount: turn.requests,
            status: turn.disconnected ? 'disconnected' : 'inProgress',
          }),
          usage: Object.freeze({ total: Object.freeze(turn.requests ? { ...turn.total } : {}) }),
          requestReports: Object.freeze([...turn.requestReports]),
          observation: observation(turn),
          modelTiming: turn.modelTimer.snapshot(turn.incomplete ? 'partial' : 'turn'),
        }),
      ),
    );
    try {
      onActiveChange(active);
    } catch {
      /* 界面渲染失败不能影响宿主处理。 */
    }
  };
  const publish = (turn) => {
    const complete =
      turn.observed && !turn.incomplete && turn.requests > 0 && turn.status === 'completed';
    const completedObservation = Object.freeze({
      ...observation(turn),
      coverage: complete ? 'turn' : 'partial',
    });
    let next = current;
    for (const itemId of turn.messages) {
      const previous = getMessageUsage(next, turn.threadId, itemId, turn.hostId);
      const record = {
        mode,
        scope: mode === 'local-mock-provider' ? 'turn-fixture' : 'turn-reported',
        hostId: turn.hostId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        itemId,
        revision: (previous?.revision ?? -1) + 1,
        model: turn.model,
        source: {
          coverage: complete ? 'observed-turn-reports' : turn.requests ? 'partial' : 'unknown',
          requestCount: turn.requests,
          status: turn.status,
        },
        // 覆盖不完整不能抹掉已经收到的报告；运行中与完成后展示同一份观测小计。
        usage: { total: turn.requests ? turn.total : {} },
        requestReports: turn.requestReports,
        observation: completedObservation,
        modelTiming: turn.modelTimer.snapshot(complete ? 'turn' : 'partial'),
      };
      next = mergeMessageUsage(next, record);
    }
    current = next;
    try {
      onChange(current);
    } catch {
      diagnose('persistence-unavailable');
    }
  };
  const rememberItems = (turn, items) => {
    for (const item of items ?? []) {
      if (item?.type === 'agentMessage' && id(item.id)) {
        if (turn.messages.size >= 10000 && !turn.messages.has(item.id))
          throw new Error('Message capacity reached');
        turn.messages.add(item.id);
      }
    }
  };
  return {
    getIndex: () => current,
    getActive: () => active,
    tick() {
      if (turns.size) publishActive();
    },
    configuredModelsChanged() {
      for (const turn of turns.values()) syncModel(turn);
      if (turns.size) publishActive();
    },
    // 恢复或注入时只接受已校验的展示记录，不从历史推断活跃回合；回合中途重启后仍显示未知。
    mergeIndex(index) {
      if (index.mode !== mode) throw new TypeError('Usage source mismatch');
      let next = current;
      for (const record of createMessageUsageIndex(index.records, { mode }).records)
        next = mergeMessageUsage(next, record);
      current = next;
      return current;
    },
    disconnect(hostId) {
      if (!id(hostId)) return;
      for (const turn of turns.values())
        if (turn.hostId === hostId) {
          turn.incomplete = true;
          turn.disconnected = true;
          turn.resetObservation = true;
          turn.model = {};
          turn.pendingModel = null;
          turn.modelTimer.disconnect();
        }
      for (const name of snapshots.keys())
        if (JSON.parse(name)[0] === hostId) snapshots.delete(name);
      diagnose('connection-gap');
      publishActive();
    },
    ingest(event) {
      const { hostId, method, params } = event ?? {};
      if (!id(hostId) || !params || typeof params !== 'object') return { status: 'ignored' };
      try {
        if (method === 'thread/started') {
          if (id(params.thread?.id))
            rememberThread(models, key(hostId, params.thread.id), modelConfig(params.thread));
          return { status: 'accepted' };
        }
        const threadId = params.threadId;
        if (!id(threadId)) return { status: 'ignored' };
        if (method === 'thread/settings/updated') {
          const model = modelConfig(params.threadSettings);
          rememberThread(models, key(hostId, threadId), model);
          for (const active of turns.values())
            if (active.hostId === hostId && active.threadId === threadId) {
              if (
                active.model.id !== model.id ||
                (active.model.provider &&
                  model.provider &&
                  active.model.provider !== model.provider)
              )
                active.model = {};
            }
          publishActive();
          return { status: 'accepted' };
        }
        const turnId =
          method === 'turn/started' || method === 'turn/completed'
            ? params.turn?.id
            : params.turnId;
        if (!id(turnId)) return { status: 'ignored' };
        const turnKey = key(hostId, threadId, turnId),
          threadKey = key(hostId, threadId);
        let turn = turns.get(turnKey);
        if (method === 'model/rerouted') {
          if (!turn) return { status: 'ignored' };
          const model = modelConfig({ model: params.toModel });
          if (!model.id) return { status: 'ignored' };
          // 此事件只说明单次请求的路由，不改变线程默认型号。
          turn.pendingModel = { ...model, basis: 'reported' };
          return { status: 'accepted' };
        }
        if (method === 'turn/started') {
          if (
            turn ||
            current.records.some(
              (record) =>
                record.hostId === hostId &&
                record.threadId === threadId &&
                record.turnId === turnId,
            )
          ) {
            return { status: 'ignored', reason: 'already-observed-turn' };
          }
          if (turns.size >= maxActiveTurns) throw new Error('Active turn capacity reached');
          turn = makeTurn(hostId, threadId, turnId, true);
          turns.set(turnKey, turn);
          publishActive();
          return { status: 'accepted' };
        }
        if (method === 'turn/completed') {
          if (
            !turn &&
            current.records.some(
              (record) =>
                record.hostId === hostId &&
                record.threadId === threadId &&
                record.turnId === turnId,
            )
          ) {
            return { status: 'ignored', reason: 'closed-turn-replay' };
          }
          // 不能从最终累计量反推缺失的回合开始状态。
          turn ??= makeTurn(hostId, threadId, turnId, false);
          rememberItems(turn, Array.isArray(params.turn?.items) ? params.turn.items : []);
          turn.status = ['completed', 'failed', 'interrupted'].includes(params.turn?.status)
            ? params.turn.status
            : 'unknown';
          try {
            publish(turn);
          } finally {
            turns.delete(turnKey);
            publishActive();
          }
          return { status: 'accepted' };
        }
        if (method === 'item/started' || method === 'item/completed') {
          if (turn) {
            rememberItems(turn, [params.item]);
            if (TOOL_TYPES.has(params.item?.type)) {
              if (!id(params.item.id)) turn.modelTimer.invalidate();
              else if (method === 'item/started') turn.modelTimer.toolStarted(params.item.id);
              else turn.modelTimer.toolCompleted(params.item.id);
              publishActive();
            }
          }
          return { status: turn ? 'accepted' : 'ignored' };
        }
        if (method !== 'thread/tokenUsage/updated') return { status: 'ignored' };
        const total = counts(params.tokenUsage?.total),
          last = counts(params.tokenUsage?.last);
        const previous = snapshots.get(threadKey);
        if (!total || !last) {
          if (turn) {
            turn.incomplete = true;
            turn.resetObservation = true;
            turn.pendingModel = null;
            turn.modelTimer.invalidate();
          }
          diagnose('invalid-request-report');
          publishActive();
          return { status: 'rejected' };
        }
        if (previous?.turnId === turnId && same(previous.total, total)) {
          if (!same(previous.last, last) && turn) {
            turn.incomplete = true;
            turn.modelTimer.invalidate();
            diagnose('conflicting-request-report');
            publishActive();
          }
          return { status: 'ignored', reason: 'duplicate-snapshot' };
        }
        if (!turn) {
          if (
            current.records.some(
              (record) =>
                record.hostId === hostId &&
                record.threadId === threadId &&
                record.turnId === turnId,
            )
          )
            return { status: 'ignored', reason: 'closed-turn-replay' };
          for (const active of turns.values())
            if (active.hostId === hostId && active.threadId === threadId) active.incomplete = true;
          if (turns.size >= maxActiveTurns) throw new Error('Active turn capacity reached');
          turn = makeTurn(hostId, threadId, turnId, false);
          turns.set(turnKey, turn);
        }
        rememberThread(snapshots, threadKey, { total, last, turnId });
        const reportKey = JSON.stringify([total, last]);
        if (turn.reports.has(reportKey)) {
          turn.incomplete = true;
          turn.modelTimer.invalidate();
          publishActive();
          return { status: 'ignored', reason: 'replayed-request-report' };
        }
        if (turn.reports.size >= 10000) throw new Error('Request capacity reached');
        turn.reports.add(reportKey);
        turn.disconnected = false;
        // 首份累计量可以包含旧回合，仅校验它减去本次请求后仍是有效历史；不把历史计入本轮。
        const invalidInitialHistory =
          !previous &&
          !counts(Object.fromEntries(FIELDS.map((field) => [field, total[field] - last[field]])));
        // 相邻快照必须只相差一份请求报告；出现跳报、重置、压缩或乱序时不认定连续。
        if (invalidInitialHistory || (previous && !same(add(previous.total, last), total))) {
          turn.incomplete = true;
          turn.resetObservation = true;
          turn.pendingModel = null;
          turn.modelTimer.invalidate();
          diagnose('request-report-gap');
        }
        // 已观测到本轮开始时，缺少旧聊天的累计基线不能单独证明本轮漏报。
        // 中途接入仍保留部分覆盖，断线、无效报告等已有标记也不能被新基线清除。
        if (!previous && !turn.observed && !same(total, last)) {
          turn.incomplete = true;
          diagnose('unknown-initial-baseline');
        }
        const next = add(turn.total, last);
        if (!next) {
          turn.incomplete = true;
          turn.resetObservation = true;
          turn.pendingModel = null;
          turn.modelTimer.invalidate();
          diagnose('usage-overflow');
          publishActive();
          return { status: 'rejected' };
        }
        turn.total = next;
        turn.requests++;
        turn.modelTimer.report(last.outputTokens);
        syncModel(turn);
        turn.requestReports.push(
          Object.freeze({
            sequence: turn.requests,
            model: Object.freeze({ ...(turn.pendingModel ?? turn.model) }),
            usage: Object.freeze({ ...last }),
          }),
        );
        turn.pendingModel = null;
        if (turn.resetObservation) {
          // 接入或重连后的首份报告可能包含观测前的输出，仅用作计时基线。
          turn.observationStart = now();
          turn.observationBase = turn.total.outputTokens;
          turn.observationSamples = 0;
          turn.resetObservation = false;
        } else turn.observationSamples++;
        publishActive();
        return { status: 'accepted' };
      } catch {
        diagnose('record-capacity-or-identity-conflict');
        return { status: 'rejected' };
      }
    },
  };
}
