import { MODEL_TIMING_VERSION } from './model-timing.mjs';

// 只计算明确计时的单次模型请求。推理 Token 已包含在输出中，不重复累加。
// 耗时包含首 Token 等待，不包含工具执行或其他回合。
/** 单次模型请求的平均速度；只有明确的请求级有效耗时才能参与计算。 */
export function calculateTokenSpeed(outputTokens, timing) {
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  if (
    timing?.scope !== 'single-model-request' ||
    typeof timing.durationMs !== 'number' ||
    !Number.isFinite(timing.durationMs) ||
    timing.durationMs <= 0
  )
    return null;
  const speed = outputTokens / (timing.durationMs / 1000);
  return Number.isFinite(speed) ? speed : null;
}

export function formatTokenSpeed(speed) {
  return typeof speed === 'number' && Number.isFinite(speed) && speed >= 0
    ? `${speed.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} token/s`
    : '— token/s';
}

/** 仅使用已收齐报告的模型交互窗口；旧的整轮墙钟均速不能冒充此值。 */
export function calculateModelSpeed(timing) {
  if (
    timing?.algorithmVersion !== MODEL_TIMING_VERSION ||
    timing.scope !== 'model-request-windows' ||
    timing.basis !== 'client-lifecycle' ||
    timing.excludesTools !== true ||
    !['turn', 'partial'].includes(timing.coverage) ||
    !Number.isSafeInteger(timing.samples) ||
    timing.samples < 1 ||
    !Number.isSafeInteger(timing.outputTokens) ||
    timing.outputTokens < 0 ||
    !Number.isFinite(timing.durationMs) ||
    timing.durationMs <= 0
  )
    return null;
  const speed = timing.outputTokens / (timing.durationMs / 1000);
  return Number.isFinite(speed) ? speed : null;
}

/** 缓存读取从输入中分离，三类可相加；命中率的分母仍为全部输入。 */
export function tokenBreakdown(counts = {}) {
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  const input = valid(counts.inputTokens) ? counts.inputTokens : null;
  const cached =
    valid(counts.cachedInputTokens) && input !== null && counts.cachedInputTokens <= input
      ? counts.cachedInputTokens
      : null;
  return {
    input: input !== null && cached !== null ? input - cached : null,
    output: valid(counts.outputTokens) ? counts.outputTokens : null,
    cached,
    hitRate: input > 0 && cached !== null ? (cached / input) * 100 : null,
  };
}

// 本地时钟均速单独标注，明确包含工具执行与等待，不能当作模型生成吞吐率。
/** 本轮本地观测均速，包含工具与等待；断线前或接入前的数据不能充当采样。 */
export function calculateObservedSpeed(observation) {
  if (
    observation?.scope !== 'turn-observed-window' ||
    observation.includesWaiting !== true ||
    !['turn', 'partial'].includes(observation.coverage) ||
    !Number.isSafeInteger(observation.samples) ||
    observation.samples < 1 ||
    !Number.isSafeInteger(observation.outputTokens) ||
    observation.outputTokens < 0 ||
    !Number.isFinite(observation.durationMs) ||
    observation.durationMs <= 0
  )
    return null;
  const speed = observation.outputTokens / (observation.durationMs / 1000);
  return Number.isFinite(speed) ? speed : null;
}
