import { tokenBreakdown } from '../core/usage-metrics.mjs';
import { formatCost } from '../core/pricing.mjs';

const EMPTY = Object.freeze({ total: null, cost: Object.freeze({ status: 'unknown' }) });
const compact = (value) =>
  Number.isSafeInteger(value) && value >= 0
    ? value >= 1_000_000
      ? `${+(value / 1_000_000).toFixed(2)}M`
      : value >= 1000
        ? `${+(value / 1000).toFixed(2)}K`
        : String(value)
    : '—';
const exact = (value) => (Number.isSafeInteger(value) ? value.toLocaleString('en-US') : undefined);

/** 被动订阅当前 host/thread 的会话累计，数字变化不重建输入框或抢占焦点。 */
export function createConversationBar(React, target = globalThis) {
  const h = React.createElement;
  const subscribe = (callback) => {
    target.addEventListener('ct-token-conversation-usage', callback);
    return () => target.removeEventListener('ct-token-conversation-usage', callback);
  };
  return function ConversationBar({ hostId, threadId }) {
    const snapshot = () =>
      target.__ctTokenConversationUsage?.find(
        (value) => value.hostId === hostId && value.threadId === threadId,
      ) ?? EMPTY;
    const data = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    const breakdown = tokenBreakdown(data.total ?? {});
    const hitRate =
      breakdown.hitRate === null
        ? '—'
        : `${breakdown.hitRate.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
    const cost =
      data.cost?.status === 'reference'
        ? (data.cost.amountUSD >= 0.01
            ? '≈ ' +
              data.cost.amountUSD.toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD',
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : formatCost({ status: 'estimated', amountUSD: data.cost.amountUSD })) +
          (data.cost.partial ? '+' : '')
        : '—';
    const field = (label, value, title, name) =>
      h(
        'div',
        {
          key: name,
          title,
          style: { display: 'flex', alignItems: 'baseline', gap: '6px', whiteSpace: 'nowrap' },
        },
        h('dt', { style: { margin: 0 } }, label),
        h(
          'dd',
          {
            ['data-ct-session-' + name]: '',
            style: { margin: 0, color: 'var(--color-text-primary)', fontWeight: 500 },
          },
          value,
        ),
      );
    return h(
      'section',
      {
        'data-ct-conversation-bar': '',
        'aria-label': '当前会话用量',
        style: {
          boxSizing: 'border-box',
          width: '100%',
          minWidth: 0,
          marginBottom: '-20px',
          padding: '8px 32px 24px',
          borderRadius: '24px 24px 0 0',
          background: 'color-mix(in srgb, var(--color-text-primary) 4%, var(--color-surface))',
          color: 'var(--color-text-secondary)',
          fontFamily: 'inherit',
          fontSize: '12px',
          lineHeight: '20px',
          fontVariantNumeric: 'tabular-nums',
        },
      },
      h(
        'dl',
        {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '4px 20px',
            margin: 0,
          },
        },
        field(
          '会话总用量',
          compact(data.total?.totalTokens),
          exact(data.total?.totalTokens),
          'total',
        ),
        field('输入', compact(breakdown.input), exact(breakdown.input), 'input'),
        field('输出', compact(breakdown.output), exact(breakdown.output), 'output'),
        field('缓存', compact(breakdown.cached), exact(breakdown.cached), 'cached'),
        field('命中率', hitRate, undefined, 'hit-rate'),
        field('花费', cost, undefined, 'cost'),
      ),
    );
  };
}
