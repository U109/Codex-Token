// 组件通过已识别的宿主 React 操作槽挂载，每条消息只使用自己的记录。
// 历史缺失时显示未知，不借用最新回复的数值；没有明确用量索引时不渲染。
import {
  estimateRequestCost,
  formatCost,
  estimateReportedReference,
  formatReferenceCost,
} from '../core/pricing.mjs';
import {
  calculateTokenSpeed,
  calculateModelSpeed,
  tokenBreakdown,
  formatTokenSpeed,
} from '../core/usage-metrics.mjs';
import { getMessageUsage, isMessageUsageIndex } from '../core/message-usage.mjs';
import { modelDisplayName } from '../core/model-label.mjs';
import { sessionModelPresentation } from '../host/model-metadata.mjs';
const EMPTY_NAMES = Object.freeze({});
const EMPTY_ACTIVE = Object.freeze([]);

/**
 * 使用宿主 React 创建用量按钮。只消费统计索引及型号快照，不主动调用业务接口。
 * 运行中读取内存快照；完成后按消息身份读取历史。缺失数据保留未知状态。
 */
export function createTokenBadge(React, ActionButton = 'button') {
  const h = React.createElement;
  const subscribe = (callback) => {
    globalThis.addEventListener('ct-lab-usage', callback);
    globalThis.addEventListener('ct-token-usage', callback);
    globalThis.addEventListener('ct-token-model-names', callback);
    globalThis.addEventListener('ct-token-model-metadata', callback);
    globalThis.addEventListener('ct-token-active-usage', callback);
    return () => {
      globalThis.removeEventListener('ct-lab-usage', callback);
      globalThis.removeEventListener('ct-token-usage', callback);
      globalThis.removeEventListener('ct-token-model-names', callback);
      globalThis.removeEventListener('ct-token-model-metadata', callback);
      globalThis.removeEventListener('ct-token-active-usage', callback);
    };
  };
  const snapshot = () => globalThis.__ctTokenLabUsage ?? globalThis.__ctTokenUsageIndex ?? null;
  const number = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—';
  const compact = (value) =>
    Number.isSafeInteger(value) && value >= 0
      ? value >= 1_000_000
        ? `${+(value / 1_000_000).toFixed(2)}M`
        : value >= 1000
          ? `${+(value / 1000).toFixed(2)}K`
          : String(value)
      : '—';
  // 复制图标轮廓位于 16px 画布内约 1 CSS px 处；匹配其线宽和视觉高度，竖边与像素对齐。
  const databaseGlyph = (size = '16px') =>
    h(
      'svg',
      {
        width: 16,
        height: 16,
        style: { display: 'block', width: size, height: size, flexShrink: 0 },
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('ellipse', { cx: 8, cy: 4, rx: 5.5, ry: 1.5, vectorEffect: 'non-scaling-stroke' }),
      h('path', {
        d: 'M2.5 4v8c0 .828 2.462 1.5 5.5 1.5s5.5-.672 5.5-1.5V4M2.5 8c0 .828 2.462 1.5 5.5 1.5s5.5-.672 5.5-1.5',
        vectorEffect: 'non-scaling-stroke',
      }),
    );
  return function TokenBadge({
    threadId,
    itemId,
    hostId = 'local',
    turnId,
    running = false,
    actionPresentation = {},
  }) {
    const index = React.useSyncExternalStore(subscribe, snapshot, () => null);
    const names = React.useSyncExternalStore(
      subscribe,
      () => globalThis.__ctTokenModelNames ?? EMPTY_NAMES,
      () => EMPTY_NAMES,
    );
    const metadata = React.useSyncExternalStore(
      subscribe,
      () => globalThis.__ctTokenModelMetadata ?? null,
      () => null,
    );
    const active = React.useSyncExternalStore(
      subscribe,
      () => globalThis.__ctTokenActiveUsage ?? EMPTY_ACTIVE,
      () => EMPTY_ACTIVE,
    );
    const matches = running
      ? active.filter(
          (r) =>
            r.scope === 'active-turn-reports' &&
            r.hostId === hostId &&
            r.threadId === threadId &&
            r.turnId === turnId,
        )
      : [];
    const data = running
      ? matches.length === 1
        ? matches[0]
        : null
      : getMessageUsage(index, threadId, itemId, hostId, turnId);
    const id = 'ct-token-' + React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const [open, setOpen] = React.useState(false);
    const trigger = React.useRef(null);
    const tooltip = React.useRef(null);
    const restoreFocus = React.useRef(false);
    if (isMessageUsageIndex(index) && index.mode === 'local-mock-provider') {
      const key = JSON.stringify({
        hostId,
        threadId,
        turnId,
        itemId,
        matchedTurnId: data?.turnId ?? null,
      });
      const records = (globalThis.__ctTokenLabRenders ??= []);
      if (!records.includes(key) && records.length < 10) records.push(key);
    }
    if (
      !isMessageUsageIndex(index) ||
      ![hostId, threadId, running ? turnId : itemId].every(
        (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value),
      )
    )
      return null;
    const lab = index.mode === 'local-mock-provider';
    const sourceLabel = lab ? '本地模拟' : '客户端已上报';
    const health = globalThis.__ctTokenUsageHealth;
    const counts = data?.usage?.total ?? {};
    const hasTotal = Number.isSafeInteger(counts.totalTokens) && counts.totalTokens >= 0;
    const partial = data?.source?.coverage === 'partial';
    const estimate = estimateRequestCost({
      ...data?.pricing,
      usage: {
        input: counts.inputTokens,
        cachedRead: counts.cachedInputTokens,
        cachedWrite: counts.cacheWriteInputTokens,
        output: counts.outputTokens,
        reasoning: counts.reasoningOutputTokens,
        total: counts.totalTokens,
      },
    });
    const reference =
      !lab && estimate.status !== 'estimated' ? estimateReportedReference(data) : null;
    const referencePrice = reference?.status === 'reference';
    const costLabel = referencePrice ? formatReferenceCost(reference) : formatCost(estimate);
    const modelSpeed = !lab ? calculateModelSpeed(data?.modelTiming) : null;
    const breakdown = tokenBreakdown(counts);
    const hitRate =
      breakdown.hitRate !== null
        ? breakdown.hitRate.toLocaleString('en-US', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }) + '%'
        : counts.inputTokens === 0 && breakdown.cached === 0
          ? '暂无输入'
          : '未上报';
    const speedLabel = lab
      ? formatTokenSpeed(calculateTokenSpeed(counts.outputTokens, data?.timing))
      : modelSpeed !== null
        ? formatTokenSpeed(modelSpeed)
        : data?.modelTiming
          ? running
            ? '等待后续上报'
            : '采样不足'
          : '未记录耗时';
    const speedName = lab ? 'Token 速度' : '输出速度（估算）';
    const speedHint = lab
      ? '输出 token（含推理）÷ 单次模型请求耗时。'
      : '已计时请求的输出 Token（含推理）÷ 模型交互阶段耗时；扣除工具执行区间，包含请求输入处理和首 Token 响应。根据客户端事件估算；缺少起始或发生断线时，从后续完整采样计算。';
    const priceHint = lab
      ? `模拟 API 单价参考 ${data?.pricing?.provider ?? '—'}/${data?.pricing?.model ?? '—'}；${estimate.message}`
      : referencePrice
        ? reference.message
        : `仅凭会话配置模型不能确定请求费率或真实账单；${reference?.message ?? estimate.message}`;
    const presentation = sessionModelPresentation(metadata, hostId, threadId, data?.model, names);
    const displayModel = modelDisplayName(presentation.model, presentation.names);
    const referenceModels =
      reference?.groups?.map((group) => modelDisplayName(group.model, presentation.names).label) ??
      (data?.model?.id ? [modelDisplayName(data.model, presentation.names).label] : []);
    const referenceModelLabel = [...new Set(referenceModels)].join('、') || '待确认';
    const modelLabel = lab
      ? data?.model?.id
        ? `${data.model.provider ? data.model.provider + '/' : ''}${data.model.id}${data.model.basis === 'configured' ? '（配置）' : ''}`
        : '未上报'
      : displayModel.label;
    const anchor = '--' + id;
    const hideTooltip = () => {
      try {
        tooltip.current?.hidePopover();
      } catch {}
    };
    const showTooltip = () => {
      if (!open) {
        try {
          tooltip.current?.showPopover();
        } catch {}
      }
    };
    const detailRow = (label, value, hint) =>
      h(
        'div',
        {
          key: label,
          style: {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            alignItems: 'baseline',
            gap: '16px',
            padding: '4px 0',
          },
          title: hint,
          'data-ct-detail-row': label,
        },
        h('dt', { style: { flexShrink: 0 } }, label),
        h(
          'dd',
          {
            style: {
              margin: 0,
              minWidth: 0,
              maxWidth: '190px',
              textAlign: 'right',
              overflowWrap: 'anywhere',
              fontVariantNumeric: 'tabular-nums',
            },
          },
          value,
        ),
      );
    const row = (label, value, hint) =>
      detailRow(
        label,
        Number.isSafeInteger(value) && value >= 0 ? number(value) + ' token' : '未上报',
        hint,
      );
    const fastGlyph = () =>
      h(
        'span',
        {
          className: 'ct-native-fast text-tertiary',
          'data-ct-fast': 'price',
          title: 'Fast',
          role: 'img',
          'aria-label': 'Fast 已开启',
        },
        h(
          'svg',
          {
            width: 12,
            height: 12,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            'aria-hidden': true,
          },
          h('path', { d: 'M13 2 3 14h9l-1 8L21 10h-9l1-8Z' }),
        ),
      );
    return h(
      'span',
      {
        'data-ct-native-usage': '',
        'data-host-id': hostId,
        'data-thread-id': threadId,
        'data-turn-id': data?.turnId ?? turnId,
        'data-item-id': itemId,
        'data-ct-running': running ? '' : undefined,
        'data-ct-usage-state': hasTotal ? 'known' : 'unknown',
        style: { display: 'inline-flex', alignItems: 'center' },
      },
      h(
        'style',
        null,
        // 原生工具类位于 CSS layer 内；无条件的背景声明会盖过原生 hover 和打开状态。
        // 用 :popover-open 保持所属操作区可见，关闭、卸载或切换消息后由浏览器自动恢复。
        '.ct-native-token[data-ct-action-skin="fallback"]{background:transparent}' +
          '.ct-native-token[data-ct-action-skin="fallback"]:is(:hover,[data-state="open"]){background:color-mix(in srgb,currentColor 8%,transparent)}' +
          '.ct-native-token[data-ct-action-skin="fallback"]:focus-visible{outline:2px solid currentColor;outline-offset:2px}' +
          '.turn-action-controls:has([data-ct-cdp-root] .ct-native-popover:popover-open),.turn-action-controls > :has(> [data-ct-cdp-root] .ct-native-popover:popover-open){opacity:1}' +
          '.ct-native-popover::backdrop{background:transparent}.ct-native-fast{display:inline-flex;align-items:center}.ct-native-tooltip{pointer-events:none}',
      ),
      h(
        ActionButton,
        {
          ...(ActionButton === 'button' ? {} : { color: 'ghost', size: 'icon' }),
          ref: trigger,
          type: 'button',
          className: 'ct-native-token text-tertiary ' + (actionPresentation.className ?? ''),
          'data-ct-action-skin': actionPresentation.className ? 'native' : 'fallback',
          'data-state': open ? 'open' : 'closed',
          popovertarget: id,
          'aria-controls': id,
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          'aria-label': hasTotal
            ? `查看用量 ${number(counts.totalTokens)} token（${sourceLabel}）`
            : '查看用量明细（暂未取得用量）',
          'aria-describedby': id + '-tip',
          onPointerEnter: showTooltip,
          onPointerLeave: hideTooltip,
          onFocus: showTooltip,
          onBlur: hideTooltip,
          onClick: hideTooltip,
          onKeyDown: (event) => {
            if (event.key === 'Escape') hideTooltip();
          },
          style: {
            anchorName: anchor,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px',
            padding: running ? 0 : '0 4px',
            height: running ? '20px' : '24px',
            minHeight: 0,
            minWidth: 0,
            border: 0,
            borderRadius: '5px',
            fontFamily: 'inherit',
            fontSize: '12px',
            fontWeight: 400,
            lineHeight: '16px',
            ...actionPresentation.style,
            width: 'auto',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          },
        },
        databaseGlyph(actionPresentation.iconSize ?? '16px'),
        hasTotal
          ? h(
              'span',
              { 'data-ct-total': '' },
              compact(counts.totalTokens) + (running ? ' token' : ''),
            )
          : running
            ? h('span', { 'data-ct-waiting': '' }, '等待回复')
            : null,
      ),
      h(
        'div',
        {
          id,
          popover: 'auto',
          role: 'dialog',
          tabIndex: -1,
          'aria-label': `本轮用量（${sourceLabel}）`,
          className: 'ct-native-popover',
          onBeforeToggle: (event) => {
            if (event.newState === 'closed')
              restoreFocus.current = event.currentTarget.contains(document.activeElement);
            else if (trigger.current) {
              hideTooltip();
              // 固定在原来的左上锚点；详情增多时在可用空间内滚动，避免卡片翻到按钮下方。
              event.currentTarget.style.maxHeight =
                Math.max(0, trigger.current.getBoundingClientRect().top - 14) + 'px';
            }
          },
          onToggle: (event) => {
            const expanded = event.newState === 'open';
            setOpen(expanded);
            if (expanded) {
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.scrollTop = 0;
            } else if (restoreFocus.current) trigger.current?.focus({ preventScroll: true });
            restoreFocus.current = false;
          },
          onKeyDown: (event) => {
            if (event.key !== 'Escape' && event.key !== 'Tab') return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
            }
            event.currentTarget.hidePopover();
            trigger.current?.focus({ preventScroll: true });
            if (event.key === 'Tab') restoreFocus.current = false;
          },
          style: {
            position: 'fixed',
            positionAnchor: anchor,
            top: 'auto',
            right: 'auto',
            bottom: 'anchor(top)',
            left: 'clamp(8px, anchor(left), calc(100vw - 348px))',
            margin: '0 0 6px',
            width: '340px',
            maxWidth: 'calc(100vw - 16px)',
            overflowY: 'auto',
            padding: '14px 16px',
            color: 'CanvasText',
            background: 'Canvas',
            border: '1px solid color-mix(in srgb,CanvasText 15%,Canvas)',
            borderRadius: '9px',
            boxShadow: '0 4px 18px #0002',
            fontSize: '12px',
            lineHeight: 1.6,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              paddingBottom: '8px',
              marginBottom: '6px',
              borderBottom: '1px solid color-mix(in srgb,CanvasText 12%,Canvas)',
            },
          },
          h(
            'strong',
            {
              'data-ct-detail-heading': '',
              style: { display: 'inline-flex', alignItems: 'center', gap: '7px' },
            },
            databaseGlyph(),
            '本轮用量',
          ),
          h(
            'span',
            { 'data-ct-detail-total': '', style: { fontVariantNumeric: 'tabular-nums' } },
            hasTotal ? number(counts.totalTokens) + ' token' : running ? '等待回复' : '未记录用量',
          ),
        ),
        h(
          'dl',
          { style: { margin: 0 } },
          running
            ? detailRow(
                '统计状态',
                data?.source?.status === 'disconnected'
                  ? '连接中断'
                  : !hasTotal
                    ? '等待回复'
                    : partial
                      ? '运行中 · 数据不完整'
                      : '运行中',
              )
            : partial && hasTotal
              ? detailRow('统计状态', '数据不完整', '当前数值只包含已收到的请求，完整用量未确认。')
              : null,
          detailRow(
            '当前会话模型',
            h(
              'span',
              { 'data-ct-model': '', title: lab ? undefined : displayModel.title },
              modelLabel,
            ),
          ),
          !lab
            ? detailRow(
                '本轮参考模型',
                h('span', { 'data-ct-reference-model': '' }, referenceModelLabel),
              )
            : null,
          detailRow(
            referencePrice ? (reference.partial ? '已知部分标准价参考' : '标准价参考') : '价格估算',
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
              estimate.fast && fastGlyph(),
              h('span', { 'data-ct-cost': '', title: priceHint }, costLabel),
            ),
          ),
          reference?.groups?.length > 1
            ? reference.groups.map((group) =>
                detailRow(
                  modelDisplayName(group.model, presentation.names).label,
                  formatCost({ status: 'estimated', amountUSD: group.amountUSD }),
                ),
              )
            : null,
          reference?.unpricedRequestCount
            ? detailRow('未计价请求', `${reference.unpricedRequestCount} 次，模型或单价待确认`)
            : null,
          row(
            '输入',
            breakdown.input,
            '未命中缓存的输入；与输出、缓存相加等于总 Token。缓存写入仍计入输入。',
          ),
          row('输出', breakdown.output),
          row('缓存', breakdown.cached, '命中缓存读取的输入 Token，已从上方输入中分离。'),
          detailRow(
            '缓存命中率',
            h('span', { 'data-ct-cache-hit-rate': '' }, hitRate),
            '缓存读取 Token ÷ 全部输入 Token（含缓存）× 100%。',
          ),
          detailRow(speedName, h('span', { 'data-ct-speed': '', title: speedHint }, speedLabel)),
          health && health.state !== 'ready'
            ? detailRow('记录保存', '当前无法持久化，重启后可能丢失')
            : null,
        ),
      ),
      h(
        'span',
        {
          id: id + '-tip',
          ref: tooltip,
          popover: 'manual',
          role: 'tooltip',
          className: 'ct-native-tooltip',
          style: {
            position: 'fixed',
            positionAnchor: anchor,
            top: 'auto',
            right: 'auto',
            bottom: 'anchor(top)',
            left: 'clamp(8px, calc(anchor(center) - 34px), calc(100vw - 76px))',
            margin: '0 0 6px',
            padding: 'var(--tooltip-padding-block, 6px) var(--tooltip-padding-inline, 10px)',
            border: '1px solid var(--tooltip-border-color, transparent)',
            borderRadius: 'var(--tooltip-border-radius, 10px)',
            cornerShape: 'var(--tooltip-corner-shape, round)',
            background: 'var(--tooltip-background-color, #171717)',
            color: 'var(--tooltip-text-color, #fff)',
            boxShadow: 'var(--tooltip-box-shadow, 0 8px 18px #0f172a33)',
            fontFamily: 'inherit',
            fontSize: 'var(--tooltip-font-size, 12px)',
            fontWeight: 'var(--tooltip-font-weight, 400)',
            lineHeight: 'var(--tooltip-line-height, 16px)',
            whiteSpace: 'nowrap',
          },
        },
        '用量统计',
      ),
    );
  };
}
