// API 登录复用宿主设置与请求通道；不改变认证方式，不接触 API 密钥。
const validId = (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
const validModel = (value) => typeof value === 'string' && /^[\w./:%+-]{1,200}$/.test(value);
const isFast = (tier) => tier === 'priority' || tier === 'fast';
const requestMethods = new Set(['thread/start', 'thread/resume', 'turn/start', 'turn/steer']);
export const EMPTY_FAST_MODE = Object.freeze({ available: false, enabled: false, pending: false });

/** 仅使用模型目录明确公布的 Fast 档位，不能根据型号名称猜测支持情况。 */
export function apiFastTier(model) {
  return model?.serviceTiers?.find((tier) => isFast(tier?.id))?.id ?? null;
}

function readConversation(manager, threadId) {
  if (!validId(threadId)) return null;
  try {
    const conversation = manager.getConversation(threadId);
    return {
      model: conversation?.latestModel,
      tier: conversation?.latestThreadSettings?.serviceTier,
    };
  } catch {
    return null;
  }
}

/** 可撤销的单宿主管理器适配器；设置持久化交给宿主，不另存认证或聊天数据。 */
export function createApiFastModeController(manager, { now = Date.now, queryCache } = {}) {
  if (
    ![
      'sendRequest',
      'getAuthMethod',
      'getConversation',
      'updateThreadSettingsForNextTurn',
      'setDefaultServiceTierConfig',
    ].every((name) => typeof manager?.[name] === 'function')
  )
    throw new Error('api-fast-native-contract-mismatch');
  const listeners = new Set(),
    bindings = new Map(),
    policies = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(manager, 'sendRequest');
  const original = manager.sendRequest;
  let stopped = false,
    saving = false,
    error = false,
    generation = 0;
  const invoke = (method, params, options) => original.call(manager, method, params, options);
  const contextFor = (identity) => {
    const threadId = validId(identity.threadId) ? identity.threadId : null;
    return {
      threadId,
      cwd:
        identity.cwd ?? (threadId == null ? null : manager.getConversationCwd?.(threadId)) ?? null,
    };
  };
  const policyKey = (identity) => {
    const { threadId, cwd } = contextFor(identity);
    return JSON.stringify([threadId, cwd]);
  };
  const contextKey = (identity) => JSON.stringify([policyKey(identity), identity.model]);
  const selectedTier = (identity, policy) => {
    const conversation = readConversation(manager, identity.threadId);
    return conversation?.tier === undefined
      ? identity.threadId == null
        ? (policy.managedTier ?? policy.tier)
        : policy.tier
      : conversation.tier;
  };
  const stateFor = (identity, policy) => {
    const model = policy?.models.find(
      (entry) => entry.model === identity.model || entry.id === identity.model,
    );
    const tier = apiFastTier(model);
    return {
      available: !!(policy?.api && policy.allowed && tier),
      enabled: isFast(selectedTier(identity, policy ?? {})),
      pending: saving,
      locked: identity.threadId == null && policy?.managedTier != null,
      error,
    };
  };
  const emit = () => {
    if (stopped) return;
    for (const binding of bindings.values()) {
      const policy = policies.get(policyKey(binding.identity))?.value;
      const next = stateFor(binding.identity, policy);
      if (JSON.stringify(next) !== JSON.stringify(binding.snapshot))
        binding.snapshot = Object.freeze(next);
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* 展示订阅失败不能影响宿主请求。 */
      }
    }
  };
  const load = async (identity, force = false) => {
    if (stopped) return null;
    const context = contextFor(identity),
      key = policyKey(context);
    let entry = policies.get(key);
    if (!force && entry?.promise) return entry.promise;
    if (!force && entry?.value && now() - entry.at < 5000) return entry.value;
    const epoch = generation;
    entry = { value: entry?.value, at: 0, promise: null, epoch };
    if (!policies.has(key) && policies.size >= 128) {
      const pinned = new Set([...bindings.values()].map((binding) => policyKey(binding.identity)));
      const oldest = [...policies.keys()].find((id) => !pinned.has(id));
      if (oldest !== undefined) policies.delete(oldest);
    }
    policies.set(key, entry);
    entry.promise = (async () => {
      const auth = await manager.getAuthMethod();
      if (auth !== 'apikey') return { api: false, allowed: false, models: [] };
      const [config, requirements, catalog] = await Promise.all([
        invoke('config/read', { includeLayers: false, cwd: context.cwd }),
        invoke('configRequirements/read', undefined),
        invoke('model/list', { includeHidden: true, cursor: null, limit: 100 }),
      ]);
      // 只保留开关所需的白名单字段；配置对象可能包含凭据，不能缓存或输出整个响应。
      const value = {
        api: true,
        allowed:
          requirements?.requirements?.featureRequirements?.fast_mode !== false &&
          config?.config?.features?.fast_mode !== false,
        tier: config?.config?.service_tier ?? null,
        model: config?.config?.model,
        profile: config?.config?.profile ?? null,
        managedTier: requirements?.requirements?.models?.newThread?.serviceTier ?? null,
        models: (catalog?.data ?? [])
          .filter((m) => validModel(m?.model))
          .map((m) => ({
            id: validModel(m.id) ? m.id : m.model,
            model: m.model,
            serviceTiers: (m.serviceTiers ?? [])
              .filter((tier) => isFast(tier?.id))
              .map((tier) => ({ id: tier.id })),
          })),
      };
      return value;
    })().then(
      (value) => {
        if (stopped) return null;
        // 已等待旧读取的请求也要跟随最新配置，不能因失效退回宿主过滤后的空档位。
        if (generation !== epoch || policies.get(key) !== entry) return load(context);
        entry.value = value;
        entry.at = now();
        entry.promise = null;
        emit();
        return entry.value;
      },
      () => {
        if (stopped) return null;
        if (generation !== epoch || policies.get(key) !== entry) return load(context);
        entry.value = { api: false, allowed: false, models: [] };
        entry.at = now();
        entry.promise = null;
        emit();
        return null;
      },
    );
    return entry.promise;
  };
  const invalidate = () => {
    generation++;
    for (const entry of policies.values()) {
      entry.at = -Infinity;
      entry.promise = null;
    }
    emit();
    for (const binding of bindings.values()) void load(binding.identity);
  };
  // 原生前端在 API 登录下会过滤 Fast，导致 serviceTier 为 null。
  // 在原生请求通道末端按该线程已保存的设置补齐，只处理服务档位字段。
  const wrapped = async function (method, params, options) {
    if (
      stopped ||
      !requestMethods.has(method) ||
      params == null ||
      params.serviceTier != null ||
      (method !== 'thread/start' && !validId(params.threadId))
    )
      return original.call(this, method, params, options);
    try {
      const threadId = validId(params.threadId) ? params.threadId : null;
      // 认证切换不能复用先前 API 身份；此调用不请求令牌。
      if ((await manager.getAuthMethod()) === 'apikey') {
        const identity = { threadId, cwd: params.cwd };
        while (!stopped) {
          const context = contextFor(identity),
            key = policyKey(context),
            policy = await load(context);
          if (!policy?.api || stopped) break;
          if ((await manager.getAuthMethod()) !== 'apikey' || stopped) break;
          const entry = policies.get(key);
          // 最后的认证检查同样会让出执行权；配置或目录变化后必须重新核对。
          if (
            entry?.value !== policy ||
            entry.epoch !== generation ||
            entry.promise ||
            policyKey(identity) !== key
          )
            continue;
          const conversation = readConversation(manager, threadId);
          const modelId =
            params.collaborationMode?.settings?.model ??
            params.model ??
            conversation?.model ??
            policy.model;
          const model = policy.models.find((m) => m.model === modelId || m.id === modelId);
          const selected = params.config?.service_tier ?? selectedTier(context, policy);
          if (isFast(selected)) {
            params = {
              ...params,
              serviceTier: policy.allowed ? (apiFastTier(model) ?? 'default') : 'default',
            };
          } else if (selected === 'default' || conversation?.tier === null) {
            // 显式关闭必须覆盖全局 Fast 默认值，null 会让服务端继续继承默认档位。
            params = { ...params, serviceTier: 'default' };
          }
          break;
        }
      }
    } catch {
      // 发现或读取失败时保留宿主原始请求，不能阻断发送。
    }
    return original.call(this, method, params, options);
  };
  Object.defineProperty(manager, 'sendRequest', {
    configurable: true,
    writable: true,
    value: wrapped,
  });
  let unsubscribe = null;
  try {
    unsubscribe = manager.addNotificationCallback?.(
      ['account/updated', 'account/login/completed', 'thread/settings/updated'],
      invalidate,
    );
  } catch {
    /* 可选订阅不可用时，发送前仍重新检查认证与设置。 */
  }
  let unsubscribeCache = null;
  try {
    unsubscribeCache = queryCache?.subscribe((event) => {
      const key = event?.query?.queryKey;
      if (key?.[0] === 'config' && key.includes('local') && event.type === 'updated') invalidate();
    });
  } catch {}
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(identity) {
      return bindings.get(contextKey(identity))?.snapshot ?? EMPTY_FAST_MODE;
    },
    attach(identity) {
      if (
        stopped ||
        !validModel(identity.model) ||
        (identity.threadId != null && !validId(identity.threadId))
      )
        return () => {};
      const key = contextKey(identity);
      let binding = bindings.get(key);
      if (!binding) {
        binding = {
          identity: { ...contextFor(identity), model: identity.model },
          refs: 0,
          snapshot: EMPTY_FAST_MODE,
        };
        bindings.set(key, binding);
      }
      binding.refs++;
      void load(binding.identity);
      emit();
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        if (--binding.refs === 0) bindings.delete(key);
      };
    },
    invalidate,
    async setEnabled(identity, enabled) {
      if (stopped || saving || typeof enabled !== 'boolean') return false;
      saving = true;
      error = false;
      emit();
      let previousTier,
        changedThread = false;
      try {
        const policy = await load(identity, true);
        const state = stateFor(identity, policy);
        if (stopped || !state.available || state.locked) return false;
        const currentModel = readConversation(manager, identity.threadId)?.model;
        if (currentModel && currentModel !== identity.model) return false;
        const model = policy.models.find(
          (m) => m.model === identity.model || m.id === identity.model,
        );
        const tier = enabled ? apiFastTier(model) : 'default';
        previousTier = selectedTier(identity, policy) ?? 'default';
        if (identity.threadId != null) {
          const applied = await manager.updateThreadSettingsForNextTurn(identity.threadId, {
            serviceTier: tier,
          });
          if (applied === false) throw new Error();
          changedThread = true;
        }
        if (stopped || (await manager.getAuthMethod()) !== 'apikey') throw new Error();
        await manager.setDefaultServiceTierConfig(tier, policy.profile);
        // 与原生开关一样，新会话预热需要按新的默认档位重新建立。
        try {
          await manager.clearPrewarmedThreads?.();
        } catch {}
        invalidate();
        await load(identity);
        return true;
      } catch {
        if (changedThread) {
          try {
            await manager.updateThreadSettingsForNextTurn(identity.threadId, {
              serviceTier: previousTier,
            });
          } catch {}
        }
        error = true;
        return false;
      } finally {
        saving = false;
        emit();
      }
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      generation++;
      try {
        unsubscribe?.();
        unsubscribeCache?.();
      } catch {}
      if (manager.sendRequest === wrapped) {
        if (descriptor) Object.defineProperty(manager, 'sendRequest', descriptor);
        else delete manager.sendRequest;
      }
      listeners.clear();
      bindings.clear();
      policies.clear();
    },
  };
}
