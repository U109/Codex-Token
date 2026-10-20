// 被动适配 app-server 通知，只处理元数据，不发起 RPC 或模型调用，不读取正文或凭据。
// last 代表单次请求；回合用量只累加已观测的独立请求，累计量仅用于校验连续性。
import {
  createMessageUsageIndex,
  getMessageUsage,
  mergeMessageUsage,
} from '../core/message-usage.mjs';
import { createModelRequestTimer } from '../core/model-timing.mjs';
import { summarizeConversation } from '../core/conversation-usage.mjs';

import {
  USAGE_FIELDS,
  usageId,
  equalUsage,
  cleanUsage,
  addUsage,
  emptyUsage,
  cleanLocalUsage,
  mergeRequest,
  mergeRequestModel,
  sumRequests,
  completeLocalRequests,
  reconcileLocalPrefix,
} from '../core/request-usage.mjs';
const FIELDS = USAGE_FIELDS,
  id = usageId,
  same = equalUsage,
  counts = cleanUsage,
  add = addUsage,
  empty = emptyUsage;
const key = (...parts) => JSON.stringify(parts);
const isClosed = (record) => ['completed', 'failed', 'interrupted'].includes(record.source.status);
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
  onConversationChange = () => {},
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
  // 历史记录在 current 中；本地请求也必须配合明确的消息身份，不能单凭累计量造历史。
  const turns = new Map(),
    snapshots = new Map(),
    models = new Map();
  let active = Object.freeze([]),
    batch = false,
    activeDirty = false,
    indexDirty = false;
  const localTurns = new Map(),
    watchedThreads = new Map(),
    localResponses = new Map(),
    localHistoryDirty = new Set();
  let localBindings = new Map();
  let conversationBindings = new Map(),
    conversations = Object.freeze([]);
  const publishConversations = () => {
    const next = [...conversationBindings.values()].map((identity) =>
      summarizeConversation({
        ...identity,
        index: current,
        active,
        localTurns: [...localTurns.values()],
      }),
    );
    if (JSON.stringify(next) === JSON.stringify(conversations)) return;
    conversations = Object.freeze(next);
    try {
      onConversationChange(conversations);
    } catch {}
  };
  const notifyIndex = () => {
    if (batch) {
      indexDirty = true;
      return;
    }
    try {
      onChange(current);
    } catch {
      diagnose('persistence-unavailable');
    }
    publishConversations();
  };
  const watch = (threadId, replay = false) => {
    const revision = watchedThreads.get(threadId) ?? 0;
    watchedThreads.delete(threadId);
    watchedThreads.set(threadId, revision + (replay ? 1 : 0));
    if (watchedThreads.size > 128) watchedThreads.delete(watchedThreads.keys().next().value);
  };
  const localState = (threadId, turnId) => {
    const name = key('local', threadId, turnId);
    let state = localTurns.get(name);
    if (!state) {
      if (localTurns.size >= 10000) throw new Error('Local turn capacity reached');
      state = { threadId, turnId, reports: [], caughtUp: false, conflict: false };
      localTurns.set(name, state);
    }
    return state;
  };
  const localComplete = (turn) => {
    const state = localTurns.get(key(turn.hostId, turn.threadId, turn.turnId));
    return (
      state?.caughtUp &&
      !state.conflict &&
      completeLocalRequests(state.reports) &&
      turn.requestReports.length === state.reports.length &&
      same(turn.total, sumRequests(state.reports))
    );
  };
  const incomplete = (turn) => turn.incomplete && !localComplete(turn);
  const replaceReports = (turn, reports) => {
    turn.requestReports = reports;
    turn.requests = reports.length;
    turn.total = sumRequests(reports);
  };
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
      coverage: !incomplete(turn) && (turn.observed || localComplete(turn)) ? 'turn' : 'partial',
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
    if (batch) {
      activeDirty = true;
      return;
    }
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
            coverage: incomplete(turn) ? 'partial' : 'observed-so-far',
            requestCount: turn.requests,
            status: turn.disconnected ? 'disconnected' : 'inProgress',
          }),
          usage: Object.freeze({ total: Object.freeze(turn.requests ? { ...turn.total } : {}) }),
          requestReports: Object.freeze([...turn.requestReports]),
          observation: observation(turn),
          modelTiming: turn.modelTimer.snapshot(incomplete(turn) ? 'partial' : 'turn'),
        }),
      ),
    );
    try {
      onActiveChange(active);
    } catch {
      /* 界面渲染失败不能影响宿主处理。 */
    }
    publishConversations();
  };
  const publish = (turn) => {
    const complete =
      (turn.observed || localComplete(turn)) &&
      !incomplete(turn) &&
      turn.requests > 0 &&
      turn.status === 'completed';
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
    notifyIndex();
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
  // 只修正已有的精确消息绑定；日志本身没有 itemId，不能凭用量补造回复。
  const publishLocalHistory = (state) => {
    const name = key('local', state.threadId, state.turnId);
    if (turns.has(name) || !state.reports.length || state.conflict) return;
    const saved = current.records.filter(
      (record) =>
        record.hostId === 'local' &&
        record.threadId === state.threadId &&
        record.turnId === state.turnId,
    );
    const items = new Set([
      ...saved.map((record) => record.itemId),
      ...(localBindings.get(name)?.items ?? []),
    ]);
    for (const itemId of items) {
      const previous = getMessageUsage(current, state.threadId, itemId, 'local');
      if (previous && previous.turnId !== state.turnId)
        throw new Error('Message identity conflict');
      const oldReports = previous?.requestReports ?? [];
      const legacy =
        previous && (!oldReports.length || oldReports.some((report) => !report.checkpoint));
      if (legacy && (!state.caughtUp || !completeLocalRequests(state.reports))) continue;
      let reports;
      if (state.caughtUp && completeLocalRequests(state.reports)) {
        reports = reconcileLocalPrefix(oldReports, state.reports);
        if (!reports) {
          diagnose('conflicting-local-request');
          return;
        }
      } else {
        reports = oldReports;
        for (const report of state.reports) {
          const result = mergeRequest(reports, report);
          if (!result.reports) {
            diagnose('conflicting-local-request');
            return;
          }
          reports = result.reports;
        }
      }
      const total = sumRequests(reports);
      const complete =
        state.caughtUp && completeLocalRequests(reports) && previous?.source.status === 'completed';
      const unchanged = same(previous?.usage.total, total);
      const record = {
        ...previous,
        mode,
        scope: 'turn-reported',
        hostId: 'local',
        threadId: state.threadId,
        turnId: state.turnId,
        itemId,
        revision: previous?.revision ?? 0,
        model: previous?.model ?? {},
        source: {
          coverage:
            complete || (unchanged && previous?.source.coverage === 'observed-turn-reports')
              ? 'observed-turn-reports'
              : 'partial',
          requestCount: reports.length,
          status: previous?.source.status ?? 'unknown',
        },
        usage: { total },
        requestReports: reports,
        modelTiming: unchanged ? previous?.modelTiming : undefined,
        observation: unchanged ? previous?.observation : undefined,
      };
      const clean = createMessageUsageIndex([record], { mode }).records[0];
      if (previous && JSON.stringify(clean) === JSON.stringify(previous)) continue;
      current = mergeMessageUsage(current, { ...record, revision: (previous?.revision ?? -1) + 1 });
      notifyIndex();
    }
  };
  const applyLocalToTurn = (turn, report, replay) => {
    const result = mergeRequest(turn.requestReports, report);
    if (!result.reports) {
      turn.incomplete = true;
      turn.modelTimer.invalidate();
      diagnose('conflicting-local-request');
      return { status: 'rejected' };
    }
    replaceReports(turn, result.reports);
    if (result.added) {
      if (replay) {
        turn.resetObservation = true;
        turn.modelTimer.invalidate();
      } else {
        turn.modelTimer.report(report.usage.outputTokens);
        if (turn.resetObservation) {
          turn.observationStart = now();
          turn.observationBase = turn.total.outputTokens;
          turn.observationSamples = 0;
          turn.resetObservation = false;
        } else turn.observationSamples++;
      }
    }
    publishActive();
    return { status: result.status, added: result.added };
  };
  const seedLocalTurn = (turn) => {
    const state = localTurns.get(key(turn.hostId, turn.threadId, turn.turnId));
    for (const report of state?.reports ?? []) applyLocalToTurn(turn, report, true);
  };
  const reconcileActiveLocal = (state) => {
    const turn = turns.get(key('local', state.threadId, state.turnId));
    if (!turn || state.conflict || !completeLocalRequests(state.reports)) return;
    const reports = reconcileLocalPrefix(turn.requestReports, state.reports);
    if (!reports) {
      turn.incomplete = true;
      diagnose('conflicting-local-request');
      return;
    }
    const removed = turn.requestReports.some(
      (old) =>
        !reports.some(
          (report) =>
            same(old.usage, report.usage) && same(old.checkpoint?.total, report.checkpoint?.total),
        ),
    );
    if (removed) {
      // 对账纠正误计请求时，旧计时也可能包含该请求，不能继续作为可信采样。
      turn.modelTimer = createModelRequestTimer({ now, started: false });
      turn.resetObservation = true;
      turn.observationStart = now();
      turn.observationBase = sumRequests(reports).outputTokens;
      turn.observationSamples = 0;
    }
    replaceReports(turn, reports);
    publishActive();
  };
  const ingestLocal = (raw) => {
    if (mode !== 'app-server-reported' || (raw?.hostId !== undefined && raw.hostId !== 'local'))
      return { status: 'ignored' };
    const clean = cleanLocalUsage(raw);
    if (!clean) {
      diagnose('invalid-local-request');
      return { status: 'rejected' };
    }
    const name = key('local', clean.threadId, clean.turnId);
    const turn = turns.get(name);
    if (
      !turn &&
      !watchedThreads.has(clean.threadId) &&
      !localTurns.has(name) &&
      !localBindings.has(name) &&
      !current.records.some(
        (record) =>
          record.hostId === 'local' &&
          record.threadId === clean.threadId &&
          record.turnId === clean.turnId,
      )
    )
      return { status: 'ignored', reason: 'unbound-local-turn' };
    const binding = localResponses.get(clean.responseId);
    if (binding && binding !== name) {
      diagnose('conflicting-local-identity');
      return { status: 'rejected' };
    }
    if (!binding && localResponses.size >= 100000)
      throw new Error('Local request capacity reached');
    const state = localState(clean.threadId, clean.turnId);
    if (turn && !clean.replay) syncModel(turn);
    const report = {
      responseId: clean.responseId,
      checkpoint: clean.checkpoint,
      usage: Object.freeze(clean.usage),
      model: mergeRequestModel(
        !clean.replay && turn ? (turn.pendingModel ?? turn.model) : {},
        clean.model,
      ),
    };
    const result = mergeRequest(state.reports, report);
    if (!result.reports) {
      state.conflict = true;
      if (turn) {
        turn.incomplete = true;
        turn.modelTimer.invalidate();
      }
      diagnose('conflicting-local-request');
      return { status: 'rejected' };
    }
    localResponses.set(clean.responseId, name);
    state.reports = result.reports;
    if (result.added) state.caughtUp = false;
    if (turn) {
      if (!completeLocalRequests(state.reports)) {
        turn.incomplete = true;
        turn.modelTimer.invalidate();
      }
      const applied = applyLocalToTurn(turn, report, clean.replay);
      if (applied.added && !clean.replay) turn.pendingModel = null;
      return applied;
    }
    if (batch) localHistoryDirty.add(state);
    else publishLocalHistory(state);
    return { status: result.status };
  };
  return {
    getConversations: () => conversations,
    observeConversations(identities) {
      if (!Array.isArray(identities) || identities.length > 128) return;
      const next = new Map();
      for (const identity of identities) {
        if (!id(identity?.hostId) || !id(identity?.threadId)) continue;
        const value = { hostId: identity.hostId, threadId: identity.threadId };
        next.set(key(value.hostId, value.threadId), value);
        if (
          value.hostId === 'local' &&
          !conversationBindings.has(key(value.hostId, value.threadId))
        )
          watch(value.threadId, true);
      }
      conversationBindings = next;
      publishConversations();
    },
    getLocalUsageTargets() {
      if (mode !== 'app-server-reported') return [];
      const threads = [
        ...new Set([
          ...[...conversationBindings.values()]
            .filter((identity) => identity.hostId === 'local')
            .map((identity) => identity.threadId),
          ...[...turns.values()]
            .filter((turn) => turn.hostId === 'local')
            .map((turn) => turn.threadId),
          ...[...localBindings.values()].map((binding) => binding.threadId),
          ...[...watchedThreads.keys()].reverse(),
        ]),
      ].slice(0, 128);
      return threads.map((threadId) => ({ threadId, revision: watchedThreads.get(threadId) ?? 0 }));
    },
    observeLocalIdentities(identities) {
      if (mode !== 'app-server-reported' || !Array.isArray(identities) || identities.length > 1000)
        return;
      const bindings = new Map();
      for (const identity of identities) {
        if (
          identity?.hostId !== 'local' ||
          !id(identity.threadId) ||
          !id(identity.turnId) ||
          (identity.itemId !== undefined && !id(identity.itemId))
        )
          continue;
        const name = key('local', identity.threadId, identity.turnId);
        const binding = bindings.get(name) ?? { threadId: identity.threadId, items: new Set() };
        if (identity.itemId) binding.items.add(identity.itemId);
        bindings.set(name, binding);
        if (!localTurns.has(name)) {
          localState(identity.threadId, identity.turnId);
          watch(identity.threadId, true);
        }
        let turn = turns.get(name);
        const closed = current.records.some(
          (record) =>
            record.hostId === 'local' &&
            record.threadId === identity.threadId &&
            record.turnId === identity.turnId &&
            isClosed(record),
        );
        if (!turn && identity.running === true && !closed && turns.size < maxActiveTurns) {
          turn = makeTurn('local', identity.threadId, identity.turnId, false);
          turns.set(name, turn);
          seedLocalTurn(turn);
          activeDirty = true;
        }
        if (turn && identity.itemId)
          rememberItems(turn, [{ type: 'agentMessage', id: identity.itemId }]);
      }
      localBindings = bindings;
      for (const name of bindings.keys()) publishLocalHistory(localTurns.get(name));
      if (activeDirty && !batch) {
        activeDirty = false;
        publishActive();
      }
    },
    ingestLocalRecords(records, caughtUp = []) {
      if (
        !Array.isArray(records) ||
        records.length > 128 ||
        !Array.isArray(caughtUp) ||
        caughtUp.length > 128
      )
        return { status: 'rejected' };
      batch = true;
      try {
        for (const raw of records) {
          try {
            ingestLocal(raw);
          } catch {
            diagnose('local-record-capacity-or-identity-conflict');
          }
        }
        for (const threadId of caughtUp.filter(id)) {
          for (const state of localTurns.values())
            if (state.threadId === threadId && !state.caughtUp) {
              state.caughtUp = true;
              try {
                reconcileActiveLocal(state);
                localHistoryDirty.add(state);
              } catch {
                diagnose('local-record-capacity-or-identity-conflict');
              }
            }
        }
      } finally {
        // 同一批中的历史回合只构建一次消息快照，避免补全模型时逐请求重复清洗整个索引。
        for (const state of localHistoryDirty) {
          try {
            publishLocalHistory(state);
          } catch {
            diagnose('local-record-capacity-or-identity-conflict');
          }
        }
        localHistoryDirty.clear();
        batch = false;
        if (indexDirty) {
          indexDirty = false;
          notifyIndex();
        }
        if (activeDirty || caughtUp.length || records.length) {
          activeDirty = false;
          publishActive();
        }
      }
      return { status: 'accepted' };
    },
    getIndex: () => current,
    getActive: () => active,
    tick() {
      if (turns.size) publishActive();
    },
    configuredModelsChanged() {
      for (const turn of turns.values()) syncModel(turn);
      if (turns.size) publishActive();
    },
    // 恢复索引不推断活跃回合；重启后的本地补读另需宿主明确的回合或消息身份。
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
        if (hostId === 'local') watch(threadId);
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
                record.turnId === turnId &&
                isClosed(record),
            )
          ) {
            return { status: 'ignored', reason: 'already-observed-turn' };
          }
          if (turns.size >= maxActiveTurns) throw new Error('Active turn capacity reached');
          turn = makeTurn(hostId, threadId, turnId, true);
          turns.set(turnKey, turn);
          if (hostId === 'local') localState(threadId, turnId);
          seedLocalTurn(turn);
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
                record.turnId === turnId &&
                isClosed(record),
            )
          ) {
            return { status: 'ignored', reason: 'closed-turn-replay' };
          }
          // 不能从最终累计量反推缺失的回合开始状态。
          if (!turn) {
            turn = makeTurn(hostId, threadId, turnId, false);
            seedLocalTurn(turn);
          }
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
        // 额度等事件也会在新回合重发旧快照；身份变了不代表 last 是新请求。
        if (previous && same(previous.total, total) && same(previous.last, last))
          return { status: 'ignored', reason: 'duplicate-snapshot' };
        const reportKey = JSON.stringify([total, last]);
        // 先去重再更新线程基线；旧报告乱序重放不能回退基线或破坏有效计时。
        if (turn?.reports.has(reportKey))
          return { status: 'ignored', reason: 'replayed-request-report' };
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
                record.turnId === turnId &&
                isClosed(record),
            )
          )
            return { status: 'ignored', reason: 'closed-turn-replay' };
          for (const active of turns.values())
            if (active.hostId === hostId && active.threadId === threadId) active.incomplete = true;
          if (turns.size >= maxActiveTurns) throw new Error('Active turn capacity reached');
          turn = makeTurn(hostId, threadId, turnId, false);
          turns.set(turnKey, turn);
          seedLocalTurn(turn);
        }
        if (turn.reports.size >= 10000) throw new Error('Request capacity reached');
        syncModel(turn);
        const local = localTurns.get(turnKey);
        if (local?.caughtUp && !local.conflict && completeLocalRequests(local.reports)) {
          const latest = Math.max(
            ...local.reports.map((report) => report.checkpoint.total.totalTokens),
          );
          if (
            total.totalTokens <= latest &&
            !local.reports.some(
              (report) => same(report.checkpoint.total, total) && same(report.usage, last),
            )
          )
            return { status: 'ignored', reason: 'outside-local-request-sequence' };
        }
        const merged = mergeRequest(turn.requestReports, {
          checkpoint: Object.freeze({ total: Object.freeze(total) }),
          usage: Object.freeze(last),
          model: Object.freeze({ ...(turn.pendingModel ?? turn.model) }),
        });
        if (!merged.reports) {
          turn.incomplete = true;
          turn.modelTimer.invalidate();
          diagnose(merged.status === 'overflow' ? 'usage-overflow' : 'conflicting-request-report');
          publishActive();
          return { status: 'rejected' };
        }
        if (!merged.added) {
          // 本地记录先到时这里只核对；迟到或乱序的通知不回退基线，也不再次采样。
          if (!previous || total.totalTokens >= previous.total.totalTokens)
            rememberThread(snapshots, threadKey, { total, last, turnId });
          turn.reports.add(reportKey);
          replaceReports(turn, merged.reports);
          publishActive();
          return { status: 'ignored', reason: 'local-record-confirmed' };
        }
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
        rememberThread(snapshots, threadKey, { total, last, turnId });
        turn.reports.add(reportKey);
        replaceReports(turn, merged.reports);
        turn.modelTimer.report(last.outputTokens);
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
