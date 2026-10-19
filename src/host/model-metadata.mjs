import { isReadableModelName } from '../core/model-label.mjs';

// 只处理展示元数据，复用宿主 modelSettings 订阅，不发起型号或会话正文 RPC，
// 也不用当前配置改写历史用量。
const validId = (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
const validModel = (value) =>
  typeof value === 'string' && /^[\w./:%+-]{1,200}$/.test(value) && !value.includes('://');
const threadKey = (hostId, threadId) => JSON.stringify([hostId, threadId]);
export const EMPTY_MODEL_METADATA = Object.freeze({
  catalogs: Object.freeze({}),
  threads: Object.freeze({}),
});

/** 当前配置与历史型号分别展示；已启用宿主元数据时，缺失配置不能由历史记录填补。 */
export function sessionModelPresentation(
  metadata,
  hostId,
  threadId,
  historicalModel,
  legacyNames = {},
) {
  const key = threadKey(hostId, threadId);
  // 启用宿主当前配置元数据后，历史记录不能证明当前选择；只有旧版或模拟场景允许回退。
  const model = metadata
    ? Object.hasOwn(metadata.threads ?? {}, key)
      ? metadata.threads[key]
      : null
    : historicalModel;
  // 旧名称表仅属于原来的单宿主模拟环境；真实快照不能回退到其他宿主未限定作用域的目录。
  const names = metadata
    ? Object.hasOwn(metadata.catalogs ?? {}, hostId)
      ? metadata.catalogs[hostId]
      : {}
    : legacyNames;
  return { model, names };
}

/** 复用宿主已有的型号缓存和配置订阅；按作用域引用计数，在最后一个使用方离开时退订。 */
export function createModelMetadataBridge(target) {
  const scopes = new Map();
  let stopped = false,
    snapshot = EMPTY_MODEL_METADATA,
    signature = '';
  const emit = () => {
    if (stopped) return;
    const catalogs = new Map(),
      threadModels = new Map(),
      visitedCaches = new Set();
    for (const entry of scopes.values()) {
      if (!visitedCaches.has(entry.cache)) {
        visitedCaches.add(entry.cache);
        try {
          for (const query of entry.cache.getAll()) {
            const key = query.queryKey;
            if (
              !Array.isArray(key) ||
              key[0] !== 'models' ||
              key[1] !== 'list' ||
              !validId(key[2]) ||
              query.state?.status !== 'success' ||
              !Array.isArray(query.state.data?.data)
            )
              continue;
            const models = query.state.data.data;
            if (models.length > 10000) continue;
            let catalog = catalogs.get(key[2]);
            if (!catalog) {
              catalog = new Map();
              catalogs.set(key[2], catalog);
            }
            for (const model of models) {
              if (!isReadableModelName(model?.displayName)) continue;
              for (const id of new Set([model.id, model.model].filter(validModel))) {
                // 多份认证或会话缓存可能并存，名称冲突时保持未知，不能擅自选择最新缓存。
                if (!catalog.has(id)) catalog.set(id, model.displayName);
                else if (catalog.get(id) !== model.displayName) catalog.set(id, null);
              }
            }
          }
        } catch {
          /* 宿主缓存缺失或过期不能影响 Token 按钮。 */
        }
      }
      for (const [key, thread] of entry.threads) {
        if (!threadModels.has(key)) threadModels.set(key, thread.model);
        else if (threadModels.get(key)?.id !== thread.model?.id) threadModels.set(key, null);
      }
    }
    const next = {
      catalogs: Object.freeze(
        Object.fromEntries(
          [...catalogs].map(([host, entries]) => [
            host,
            Object.freeze(Object.fromEntries([...entries].filter(([, label]) => label !== null))),
          ]),
        ),
      ),
      // 已监听但不可用或被清空的配置应明确标记未知，不能在清空后恢复历史型号。
      threads: Object.freeze(Object.fromEntries(threadModels)),
    };
    const nextSignature = JSON.stringify(next);
    if (signature === nextSignature) return;
    signature = nextSignature;
    snapshot = Object.freeze(next);
    target.__ctTokenModelMetadata = snapshot;
    try {
      target.dispatchEvent(new Event('ct-token-model-metadata'));
    } catch {
      /* 增强订阅失败时，宿主原有订阅方仍须正常工作。 */
    }
  };
  emit();
  return {
    attachScope(scope, atom, hostId, threadId) {
      if (stopped || !validId(hostId) || !validId(threadId) || typeof scope?.watch !== 'function')
        return () => {};
      // 宿主 useScope 为每个组件返回独立封装，node 才是共享作用域标识；
      // 仅把该引用用作键，不检查内部状态。
      const scopeKey = scope.node !== null && typeof scope.node === 'object' ? scope.node : scope;
      let entry = scopes.get(scopeKey);
      if (!entry) {
        try {
          const cache = scope.queryClient.getQueryCache();
          if (typeof cache.getAll !== 'function' || typeof cache.subscribe !== 'function')
            return () => {};
          entry = { cache, threads: new Map(), unsubscribe: null };
          scopes.set(scopeKey, entry);
          entry.unsubscribe = cache.subscribe((event) => {
            const key = event?.query?.queryKey;
            if (key?.[0] === 'models' && key?.[1] === 'list') emit();
          });
        } catch {
          scopes.delete(scopeKey);
          return () => {};
        }
      }
      const key = threadKey(hostId, threadId);
      let thread = entry.threads.get(key);
      if (!thread) {
        if (entry.threads.size >= 1000) return () => {};
        thread = { refs: 0, model: null, unsubscribe: null };
        entry.threads.set(key, thread);
        try {
          thread.unsubscribe = scope.watch(({ get }) => {
            // 已识别的宿主原子仅按确定的 host 和 thread 订阅 modelSettings，
            // 内容为 {model, reasoningEffort}。
            const settings = get(atom, { hostId, threadId });
            thread.model = validModel(settings?.model)
              ? Object.freeze({ id: settings.model, basis: 'configured' })
              : null;
            emit();
          });
        } catch {
          thread.model = null;
        }
      }
      thread.refs++;
      emit();
      let detached = false;
      return () => {
        if (detached || stopped) return;
        detached = true;
        if (--thread.refs === 0) {
          try {
            thread.unsubscribe?.();
          } catch {}
          entry.threads.delete(key);
        }
        if (entry.threads.size === 0) {
          try {
            entry.unsubscribe?.();
          } catch {}
          scopes.delete(scopeKey);
        }
        emit();
      };
    },
    getHealth: () => ({
      scopes: scopes.size,
      catalogs: Object.keys(snapshot.catalogs).length,
      threads: Object.keys(snapshot.threads).length,
    }),
    dispose() {
      if (stopped) return;
      stopped = true;
      for (const entry of scopes.values()) {
        try {
          entry.unsubscribe?.();
        } catch {}
        for (const thread of entry.threads.values()) {
          try {
            thread.unsubscribe?.();
          } catch {}
        }
      }
      scopes.clear();
      if (target.__ctTokenModelMetadata === snapshot) {
        delete target.__ctTokenModelMetadata;
        try {
          target.dispatchEvent(new Event('ct-token-model-metadata'));
        } catch {}
      }
    },
  };
}
