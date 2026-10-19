// 使用带版本的离线 API 文本 Token 公开价，只作参考，不代表账单或 Codex 订阅额度。
// 不访问网络、认证或本地配置，也不调用模型。
export const PRICE_VERSION = 'official-usd-2026-10-15';
export const VERIFIED_ON = '2026-10-15';
const FIRST_INSTANT = Date.parse('2026-10-14T16:00:00Z'); // 上海时区的日期分界点。
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const DEEPSEEK = 'https://api-docs.deepseek.com/quick_start/pricing';
const GOOGLE = 'https://ai.google.dev/gemini-api/docs/pricing';

// 单价抄录自官方表格，单位为美元/百万 Token，列顺序为未缓存输入、缓存读取、缓存写入、输出。
// 缓存和推理量已分别包含在输入、输出中，不额外累加。各服务档位有独立价表，
// 不能根据 Fast 图标统一乘倍数。
const rates = (input, cachedRead, cachedWrite, output) => ({
  input,
  cachedRead,
  cachedWrite,
  output,
});
const catalog = {
  openai: {
    'gpt-6-astra': {
      threshold: 272000,
      writeBilling: 'separate',
      source: OPENAI,
      tiers: {
        standard: [rates(10, 1, 12.5, 50), rates(20, 2, 25, 75)],
        batch: [rates(5, 0.5, 6.25, 25), rates(10, 1, 12.5, 37.5)],
        flex: [rates(5, 0.5, 6.25, 25), rates(10, 1, 12.5, 37.5)],
        fast: [rates(20, 2, 25, 100), rates(40, 4, 50, 150)],
        ultrafast: [rates(60, 6, 75, 300), rates(120, 12, 150, 450)],
      },
    },
    'gpt-6.1-sol': {
      threshold: 272000,
      writeBilling: 'separate',
      source: OPENAI,
      tiers: {
        standard: [rates(2, 0.1, 2.5, 10), rates(4, 0.2, 5, 15)],
        batch: [rates(1, 0.05, 1.25, 5), rates(2, 0.1, 2.5, 7.5)],
        flex: [rates(1, 0.05, 1.25, 5), rates(2, 0.1, 2.5, 7.5)],
        fast: [rates(4, 0.2, 5, 20), rates(8, 0.4, 10, 30)],
        ultrafast: [rates(12, 0.6, 15, 60), rates(24, 1.2, 30, 90)],
      },
    },
    'gpt-6-luna': {
      threshold: 272000,
      writeBilling: 'separate',
      source: OPENAI,
      tiers: {
        standard: [rates(0.1, 0.01, 0.125, 0.5), rates(0.2, 0.02, 0.25, 0.75)],
        batch: [rates(0.05, 0.005, 0.0625, 0.25), rates(0.1, 0.01, 0.125, 0.375)],
        flex: [rates(0.05, 0.005, 0.0625, 0.25), rates(0.1, 0.01, 0.125, 0.375)],
        fast: [rates(0.2, 0.02, 0.25, 1), rates(0.4, 0.04, 0.5, 1.5)],
      },
    },
  },
  deepseek: {
    'deepseek-flash': {
      source: DEEPSEEK,
      writeBilling: 'input',
      periods: { peak: rates(0.3, 0.006, null, 1.2), 'off-peak': rates(0.15, 0.003, null, 0.6) },
    },
    'deepseek-v4-pro': {
      source: DEEPSEEK,
      writeBilling: 'input',
      periods: { peak: rates(1.32, 0.044, null, 3.96), 'off-peak': rates(0.66, 0.022, null, 1.98) },
    },
  },
  google: {
    'gemini-4-argon': {
      source: GOOGLE,
      writeBilling: 'unsupported',
      schedule: [
        {
          before: '2026-12-01T00:00:00Z',
          tiers: { standard: [rates(2, 0.1, null, 10)], priority: [rates(3.6, 0.18, null, 18)] },
        },
        { tiers: { standard: [rates(4, 0.2, null, 20)], priority: [rates(7.2, 0.36, null, 36)] } },
      ],
    },
    'gemini-3.8-flash': {
      source: GOOGLE,
      writeBilling: 'input',
      schedule: [
        {
          before: '2027-01-01T00:00:00Z',
          tiers: {
            standard: [rates(0.75, 0.075, null, 3.75)],
            priority: [rates(1.35, 0.135, null, 6.75)],
          },
        },
        {
          tiers: {
            standard: [rates(1.5, 0.15, null, 7.5)],
            priority: [rates(2.7, 0.27, null, 13.5)],
          },
        },
      ],
    },
    'gemini-2.5-pro': {
      source: GOOGLE,
      threshold: 200000,
      writeBilling: 'input',
      tiers: { standard: [rates(1.25, 0.125, null, 10), rates(2.5, 0.25, null, 15)] },
    },
  },
};

// 只接受有文档依据的请求别名，不按前缀、日期或相似名称模糊匹配。
const deepseekAliases = new Map([
  ['deepseek-v4-flash', 'deepseek-flash'],
  ['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
]);
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const lookup = (object, key) =>
  typeof key === 'string' && Object.hasOwn(object, key) ? object[key] : null;
const reasons = {
  'price-version': '请求未绑定此费率版本，暂无法估算',
  'request-time': '请求开始时间缺失或早于此价格快照，暂无法估算',
  'billing-mode': '不是已确认的 API 按量计费，暂无法估算',
  endpoint: '端点或地区加价条件未确认，暂无法估算',
  modality: '仅支持已确认的文本 Token 费用，暂无法估算',
  model: '官方模型单价未匹配，暂无法估算',
  tier: '实际服务档位未确认或未收录，暂无法估算',
  period: 'DeepSeek 峰谷计费时段未确认，暂无法估算',
  schedule: '官方调价日期的切换时区未确认，暂无法估算',
  usage: '必要用量未上报或口径不一致，暂无法估算',
  writes: '缓存写入口径未确认，暂无法估算',
};

/** 按明确的供应商、计费档位、日期与单次请求用量计价；缺少依据时返回未知。 */
export function estimateRequestCost(request) {
  const fast = request?.fastEnabled === true;
  const unknown = (reason) => ({
    status: 'unknown',
    amountUSD: null,
    fast,
    reason,
    message: reasons[reason],
    priceVersion: PRICE_VERSION,
    verifiedOn: VERIFIED_ON,
  });
  if (request?.priceVersion !== PRICE_VERSION) return unknown('price-version');
  // 必须提供无歧义的绝对时间，不能用当前时间给历史重新计价。
  const timestamp = request.startedAt;
  const dateParts =
    typeof timestamp === 'string' &&
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(timestamp);
  if (!dateParts) return unknown('request-time');
  const [, year, month, day, hour, minute, second] = dateParts.map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return unknown('request-time');
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant) || instant < FIRST_INSTANT) return unknown('request-time');
  if (request.billingMode !== 'api') return unknown('billing-mode');
  if (request.endpoint !== 'global') return unknown('endpoint');
  if (request.modality !== 'text') return unknown('modality');
  const models = lookup(catalog, request.provider);
  const model =
    request.provider === 'deepseek'
      ? (deepseekAliases.get(request.model) ?? request.model)
      : request.model;
  const entry = models && lookup(models, model);
  if (!entry) return unknown('model');
  // OpenAI 已将旧 Priority 名称改为 Fast；这是有文档依据的别名，
  // 不能根据用户选择的 Fast 设置或观测速度推断实际档位。
  const tier =
    request.provider === 'openai' && request.serviceTier === 'priority'
      ? 'fast'
      : request.serviceTier;
  const usage = request.usage;
  if (
    !usage ||
    !['input', 'cachedRead', 'output'].every((field) => validCount(usage[field])) ||
    usage.cachedRead > usage.input
  )
    return unknown('usage');
  if (usage.reasoning != null && (!validCount(usage.reasoning) || usage.reasoning > usage.output))
    return unknown('usage');
  if (
    usage.total != null &&
    (!validCount(usage.total) ||
      !Number.isSafeInteger(usage.input + usage.output) ||
      usage.total !== usage.input + usage.output)
  )
    return unknown('usage');
  let write = 0;
  if (entry.writeBilling === 'separate') {
    if (!validCount(usage.cachedWrite)) return unknown('writes');
    write = usage.cachedWrite;
    if (write > usage.input - usage.cachedRead) return unknown('writes');
  } else if (usage.cachedWrite != null) {
    if (
      !validCount(usage.cachedWrite) ||
      usage.cachedWrite > usage.input - usage.cachedRead ||
      (entry.writeBilling === 'unsupported' && usage.cachedWrite !== 0)
    )
      return unknown('writes');
  }
  let selectedRates,
    contextBand = 'flat';
  if (entry.periods) {
    if (tier !== 'standard') return unknown('tier');
    // 涉及节假日的高峰时段必须由适配器确认，不能仅凭本机时间、时区或工作日猜测。
    selectedRates = lookup(entry.periods, request.billingPeriod);
    if (!selectedRates) return unknown('period');
  } else {
    // Google 价目页给出的切换日期没有明确时区，因此将临近的一天保留为未知，
    // 覆盖各地民用时区，不虚构精确的 UTC 切换时刻。
    if (
      entry.schedule?.some(
        (row) => row.before && Math.abs(instant - Date.parse(row.before)) < 86400000,
      )
    )
      return unknown('schedule');
    const schedule = entry.schedule?.find((row) => !row.before || instant < Date.parse(row.before));
    const tierRates = lookup(schedule?.tiers ?? entry.tiers, tier);
    if (!tierRates) return unknown('tier');
    const long = entry.threshold != null && usage.input > entry.threshold;
    contextBand = entry.threshold == null ? 'flat' : long ? 'long' : 'short';
    selectedRates = tierRates[long ? 1 : 0];
    if (!selectedRates) return unknown('tier');
  }
  const tokens = {
    input: usage.input - usage.cachedRead - write,
    cachedRead: usage.cachedRead,
    cachedWrite: write,
    output: usage.output,
  };
  // 使用整数皮美元，避免多次请求累计二进制浮点误差。
  const parts = Object.fromEntries(
    Object.entries(tokens).map(([field, count]) => [
      field,
      BigInt(count) * BigInt(Math.round((selectedRates[field] ?? 0) * 1e6)),
    ]),
  );
  const picoUSD = Object.values(parts).reduce((sum, value) => sum + value, 0n);
  return {
    status: 'estimated',
    amountUSD: Number(picoUSD) / 1e12,
    picoUSD: String(picoUSD),
    fast,
    priceVersion: PRICE_VERSION,
    verifiedOn: VERIFIED_ON,
    provider: request.provider,
    model,
    serviceTier: tier,
    contextBand,
    billingPeriod: request.billingPeriod ?? null,
    rates: { ...selectedRates },
    tokens,
    source: entry.source,
    breakdownUSD: Object.fromEntries(
      Object.entries(parts).map(([field, value]) => [field, Number(value) / 1e12]),
    ),
    message: 'API 文本 Token 单价估算；不含工具、缓存存储、地区加价和税费，不是账单',
  };
}

export function formatCost(estimate) {
  if (
    estimate?.status !== 'estimated' ||
    !Number.isFinite(estimate.amountUSD) ||
    estimate.amountUSD < 0
  )
    return '暂无法估算';
  if (estimate.amountUSD > 0 && estimate.amountUSD < 0.000001) return '≈ <$0.000001';
  const digits = estimate.amountUSD > 0 && estimate.amountUSD < 0.0001 ? 6 : 4;
  return (
    '≈ $' +
    estimate.amountUSD.toLocaleString('en-US', {
      minimumFractionDigits: 4,
      maximumFractionDigits: digits,
    })
  );
}

// 明确标注与 OpenAI 标准文本公开价的对比，独立于上方要求完整依据的计价器。
// 自定义供应商、Codex 订阅和界面所选型号均不能证明实际 API 计费档位。
// 型号属于被记录的回合，不能采用当前会话选择。
/** 标准公开价参考；聚合历史缺少逐请求上下文时保留区间，不推断实际扣款。 */
export function estimateStandardReference({ model, usage, requestCount } = {}) {
  const unknown = (reason) => ({
    status: 'unknown',
    amountUSD: null,
    reason,
    message:
      reason === 'model'
        ? '本轮配置模型没有匹配的公开参考单价'
        : '本轮可归属用量不足，暂无法计算参考金额',
  });
  const entry = lookup(catalog.openai, model?.id);
  if (!entry?.tiers?.standard) return unknown('model');
  if (
    !usage ||
    ![
      'inputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'outputTokens',
      'totalTokens',
    ].every((k) => validCount(usage[k])) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens ||
    !Number.isSafeInteger(requestCount) ||
    requestCount < 1
  )
    return unknown('usage');
  const tokens = {
    input: usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
    cachedRead: usage.cachedInputTokens,
    cachedWrite: usage.cacheWriteInputTokens,
    output: usage.outputTokens,
  };
  const tiers = entry.tiers.standard;
  // 输入总量无法判断单次请求是否越过上下文阈值，因此给出区间，不把长上下文单价套到总和上。
  const ratesToUse =
    entry.threshold == null || usage.inputTokens <= entry.threshold
      ? [tiers[0]]
      : requestCount === 1
        ? [tiers[1]]
        : tiers;
  const amounts = ratesToUse.map((r) =>
    Object.entries(tokens).reduce(
      (sum, [k, count]) => sum + BigInt(count) * BigInt(Math.round((r[k] ?? 0) * 1e6)),
      0n,
    ),
  );
  const low = amounts.reduce((a, b) => (a < b ? a : b)),
    high = amounts.reduce((a, b) => (a > b ? a : b));
  return {
    status: 'reference',
    amountUSD: Number(low) / 1e12,
    maxAmountUSD: Number(high) / 1e12,
    picoUSD: String(low),
    maxPicoUSD: String(high),
    model: model.id,
    serviceTier: 'standard',
    priceVersion: PRICE_VERSION,
    verifiedOn: VERIFIED_ON,
    source: entry.source,
    message: `按本轮配置模型 ${model.id} 的 OpenAI 标准档文本 Token 公开价参考（${VERIFIED_ON} 快照）；不代表当前供应商实际扣费或订阅额度。${ratesToUse.length > 1 ? '缺少逐请求上下文长度，显示短、长上下文价格范围。' : ''}`,
  };
}

// 新记录保留逐请求明细，可按每次请求和型号选择长上下文单价；旧的汇总历史仍保留参考区间。
/** 新记录按请求型号分别计价；无法确认型号的请求单独保留为未计价部分。 */
export function estimateReportedReference(data) {
  if (!Array.isArray(data?.requestReports))
    return estimateStandardReference({
      model: data?.model,
      usage: data?.usage?.total,
      requestCount: data?.source?.requestCount,
    });
  const reports = data.requestReports;
  const unknown = (message) => ({ status: 'unknown', amountUSD: null, message });
  if (
    !reports.length ||
    reports.length > 10000 ||
    reports.length !== data.source?.requestCount ||
    reports.some((r, i) => r?.sequence !== i + 1)
  )
    return unknown('等待可归属的请求用量');
  for (const field of [
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'totalTokens',
  ]) {
    let sum = 0;
    for (const report of reports) {
      if (!validCount(report.usage?.[field])) return unknown('逐请求用量口径不完整');
      sum += report.usage[field];
    }
    if (!Number.isSafeInteger(sum)) return unknown('逐请求用量超出范围');
    if (data.usage?.total?.[field] != null && data.usage.total[field] !== sum)
      return unknown('逐请求用量与合计不一致');
  }
  const groups = new Map();
  let pico = 0n,
    unpricedRequestCount = 0;
  for (const report of reports) {
    const estimate = estimateStandardReference({
      model: report.model,
      usage: report.usage,
      requestCount: 1,
    });
    if (estimate.status !== 'reference') {
      unpricedRequestCount++;
      continue;
    }
    const value = BigInt(estimate.picoUSD);
    pico += value;
    const id = report.model.id;
    const group = groups.get(id) ?? { model: report.model, requestCount: 0, pico: 0n };
    group.requestCount++;
    group.pico += value;
    groups.set(id, group);
  }
  if (!groups.size)
    return { ...unknown('请求模型或公开单价尚未确认，暂无法计算参考金额'), unpricedRequestCount };
  const partial =
    unpricedRequestCount > 0 || ['partial', 'unknown'].includes(data.source?.coverage);
  return {
    status: 'reference',
    amountUSD: Number(pico) / 1e12,
    maxAmountUSD: Number(pico) / 1e12,
    picoUSD: String(pico),
    maxPicoUSD: String(pico),
    partial,
    unpricedRequestCount,
    pricedRequestCount: reports.length - unpricedRequestCount,
    priceVersion: PRICE_VERSION,
    verifiedOn: VERIFIED_ON,
    groups: [...groups.values()].map(({ model, requestCount, pico }) => ({
      model,
      requestCount,
      amountUSD: Number(pico) / 1e12,
    })),
    message: `按每次请求记录的模型、输入长度和 OpenAI 标准档文本公开价分别计算后合计（${VERIFIED_ON} 快照）；不代表供应商账单。${partial ? '只含已记录且能确认模型的部分。' : ''}${unpricedRequestCount ? `另有 ${unpricedRequestCount} 次请求模型或单价未确认，未计入金额。` : ''}`,
  };
}

export function formatReferenceCost(estimate) {
  if (estimate?.status !== 'reference') return '暂无法估算';
  const low = formatCost({ ...estimate, status: 'estimated' });
  if (estimate.maxAmountUSD === estimate.amountUSD) return low;
  const high = formatCost({ status: 'estimated', amountUSD: estimate.maxAmountUSD });
  return low + '–' + high.replace(/^≈ /, '');
}
