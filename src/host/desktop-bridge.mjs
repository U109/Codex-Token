import { createUsageStore } from '../storage/usage-store.mjs';
const METHODS = new Set([
  'thread/started',
  'thread/settings/updated',
  'turn/started',
  'turn/completed',
  'thread/tokenUsage/updated',
  'item/started',
  'item/completed',
  'model/rerouted',
]);

// 窗口与存储依赖显式传入，便于测试初始化顺序，无需打开客户端、读取档案或调用模型。
/** 将通知接入存储，并以只含统计元数据的窗口事件通知界面；dispose 清理订阅和计时器。 */
export function createDesktopBridge({ mode, storage, target }) {
  let timer = null,
    disposed = false;
  const prior = mode === 'local-mock-provider' ? target.__ctTokenLabUsage : null;
  if (mode !== 'local-mock-provider') delete target.__ctTokenLabUsage;
  const publish = (index, health) => {
    target.__ctTokenUsageIndex = index;
    target.__ctTokenUsageHealth = health;
    if (mode === 'local-mock-provider') target.__ctTokenLabUsage = index;
    try {
      target.dispatchEvent?.(new Event('ct-token-usage'));
    } catch {
      /* 事件分发失败不能中断宿主。 */
    }
  };
  const publishActive = (active) => {
    target.__ctTokenActiveUsage = active;
    try {
      target.dispatchEvent?.(new Event('ct-token-active-usage'));
    } catch {}
    if (!disposed && active.length && timer === null && target.setInterval)
      timer = target.setInterval(() => store.tick(), 1000);
    if ((!active.length || disposed) && timer !== null) {
      target.clearInterval?.(timer);
      timer = null;
    }
  };
  const store = createUsageStore({
    storage,
    mode,
    onUpdate: publish,
    onActiveUpdate: publishActive,
    getConfiguredModel: (hostId, threadId) =>
      target.__ctTokenModelMetadata?.threads?.[JSON.stringify([hostId, threadId])],
  });
  const onModelChange = () => store.configuredModelsChanged();
  target.addEventListener?.('ct-token-model-metadata', onModelChange);
  publishActive(store.getActive());
  const seedIndex = (index) => store.seed(index);
  const onSeed = (event) => {
    try {
      seedIndex(event.detail);
    } catch {
      /* 无效的模拟数据保持未知。 */
    }
  };
  if (mode === 'local-mock-provider') target.addEventListener?.('ct-token-seed', onSeed);
  // did-finish-load 可能早于渲染模块的延迟导入；保留提前到达的模拟数据，避免依赖已错过的一次性事件。
  if (prior) {
    try {
      seedIndex(prior);
    } catch {
      publish(store.getIndex(), store.getHealth());
    }
  } else publish(store.getIndex(), store.getHealth());
  return {
    captureNotification(hostId, method, params) {
      if (!METHODS.has(method)) return;
      try {
        store.ingest({ hostId, method, params });
      } catch {
        /* 采集失败后宿主仍须继续处理通知。 */
      }
    },
    connectionChanged(event) {
      if (event?.state !== 'connected') store.disconnect(event?.hostId);
    },
    seedIndex,
    getHealth: store.getHealth,
    dispose() {
      disposed = true;
      target.removeEventListener?.('ct-token-seed', onSeed);
      target.removeEventListener?.('ct-token-model-metadata', onModelChange);
      publishActive(Object.freeze([]));
    },
  };
}
