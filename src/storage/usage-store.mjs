// Storage 由调用方显式传入，导入模块时不读取用户档案。
import {
  createMessageUsageIndex,
  parseMessageUsage,
  serializeMessageUsage,
} from '../core/message-usage.mjs';
import { createAppServerUsageCollector } from '../host/app-server-usage.mjs';

/**
 * 连接采集器与注入的 Storage 接口。
 * 仅完成记录落盘；运行中快照通过回调发布。损坏历史保留原文以便恢复，
 * 存储不可用时继续提供内存统计，并通过 getHealth 暴露状态。
 */
export function createUsageStore({
  storage,
  mode = 'app-server-reported',
  onUpdate = () => {},
  onActiveUpdate = () => {},
  getConfiguredModel,
  now,
} = {}) {
  const storageKey = 'codex-token.usage.v1.' + mode;
  let index = createMessageUsageIndex([], { mode });
  let state = 'ready',
    writable = true,
    diagnostic = null;
  try {
    if (!storage?.getItem || !storage?.setItem) throw new Error('Storage unavailable');
    const saved = storage.getItem(storageKey);
    if (saved !== null) {
      try {
        index = parseMessageUsage(saved);
        if (index.mode !== mode) throw new Error('Source mismatch');
      } catch {
        // 保留损坏文档以便主动恢复，不能用空文件覆盖仍可能恢复的历史记录。
        index = createMessageUsageIndex([], { mode });
        state = 'corrupt';
        writable = false;
      }
    }
  } catch {
    state = 'unavailable';
  }
  const health = () =>
    Object.freeze({ state, diagnostic, records: collector.getIndex().records.length });
  const notify = (current) => {
    if (writable) {
      try {
        storage.setItem(storageKey, serializeMessageUsage(current));
        state = 'ready';
      } catch {
        state = 'unavailable';
      }
    }
    try {
      onUpdate(current, health());
    } catch {
      /* 订阅方异常不能中断宿主的通知处理。 */
    }
  };
  const collector = createAppServerUsageCollector({
    mode,
    index,
    onChange: notify,
    getConfiguredModel,
    now,
    onActiveChange: (active) => {
      try {
        onActiveUpdate(active);
      } catch {}
    },
    onDiagnostic: (value) => {
      diagnostic = value.code;
    },
  });
  return {
    storageKey,
    getIndex: collector.getIndex,
    getActive: collector.getActive,
    getHealth: health,
    ingest: collector.ingest,
    ingestLocalRecords: collector.ingestLocalRecords,
    observeLocalIdentities: collector.observeLocalIdentities,
    getLocalUsageTargets: collector.getLocalUsageTargets,
    disconnect: collector.disconnect,
    tick: collector.tick,
    configuredModelsChanged: collector.configuredModelsChanged,
    seed(value) {
      const next = collector.mergeIndex(value);
      notify(next);
      return next;
    },
  };
}
