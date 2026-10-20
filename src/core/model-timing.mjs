// 仅保存客户端生命周期的计时元数据，不读取命令、参数或响应正文。
// 工具区间取并集，避免并行工具被重复扣除。结果是请求阶段估算，不是服务端生成耗时。
// v1 把上下文压缩误当工具扣除；旧样本缺少分类明细，不能在修复后继续复用。
export const MODEL_TIMING_VERSION = 2;
export function createModelRequestTimer({ now, started = false } = {}) {
  let baseline = now(),
    valid = started,
    partial = !started;
  let blockedStart = null,
    blockedMs = 0;
  let durationMs = 0,
    outputTokens = 0,
    samples = 0,
    excludedToolMs = 0;
  const tools = new Set(),
    completed = new Set();
  const invalidate = () => {
    valid = false;
    partial = true;
  };
  return {
    invalidate,
    disconnect() {
      invalidate();
      tools.clear();
      blockedStart = null;
      blockedMs = 0;
    },
    toolStarted(itemId) {
      if (tools.has(itemId) || completed.has(itemId)) return;
      if (tools.size + completed.size >= 10000) {
        invalidate();
        return;
      }
      if (!tools.size) blockedStart = now();
      tools.add(itemId);
    },
    toolCompleted(itemId) {
      if (completed.has(itemId)) return;
      if (completed.size >= 10000) {
        invalidate();
        return;
      }
      completed.add(itemId);
      if (!tools.delete(itemId)) {
        invalidate();
        return;
      }
      if (!tools.size) {
        blockedMs += Math.max(0, now() - blockedStart);
        blockedStart = null;
      }
    },
    report(tokens) {
      const end = now();
      const excluded = blockedMs + (blockedStart === null ? 0 : Math.max(0, end - blockedStart));
      const elapsed = end - baseline - excluded;
      if (
        valid &&
        Number.isFinite(elapsed) &&
        elapsed > 0 &&
        Number.isSafeInteger(tokens) &&
        tokens >= 0 &&
        Number.isSafeInteger(outputTokens + tokens) &&
        Number.isFinite(durationMs + elapsed)
      ) {
        durationMs += elapsed;
        outputTokens += tokens;
        excludedToolMs += excluded;
        samples++;
      } else partial = true;
      // 缺少开始或发生断线时，首个报告只建立新基线，不计入它之前的输出或耗时。
      baseline = end;
      blockedMs = 0;
      blockedStart = tools.size ? end : null;
      valid = true;
    },
    snapshot(coverage = 'turn') {
      return Object.freeze({
        algorithmVersion: MODEL_TIMING_VERSION,
        scope: 'model-request-windows',
        basis: 'client-lifecycle',
        excludesTools: true,
        durationMs,
        outputTokens,
        samples,
        excludedToolMs,
        coverage: partial || coverage === 'partial' ? 'partial' : 'turn',
      });
    },
  };
}
