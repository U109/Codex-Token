/** 原生模型弹窗左侧的 Fast 闪电开关；状态来自宿主已保存的服务档位。 */
export function createFastModeToggle(React) {
  const h = React.createElement;
  function Bolt({ enabled, size = 16 }) {
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: enabled ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M11.4 2.4 4.7 10.8h4.7l-.8 6.8 6.7-8.4h-4.7z' }),
    );
  }
  return function FastModeToggle({ controller, identity, indicator = false }) {
    const subscribe = React.useCallback(
      (fn) => controller?.subscribe(fn) ?? (() => {}),
      [controller],
    );
    const getSnapshot = React.useCallback(
      () => controller?.getSnapshot(identity),
      [controller, identity.threadId, identity.model, identity.cwd],
    );
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(
      () => controller?.attach(identity),
      [controller, identity.threadId, identity.model, identity.cwd],
    );
    if (!state?.available || (indicator && !state.enabled)) return null;
    if (indicator)
      return h(
        'span',
        {
          className: 'ct-fast-indicator',
          'aria-hidden': true,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--color-text-tertiary,#777)',
          },
        },
        h(Bolt, { enabled: true, size: 12 }),
      );
    const activate = () => {
      if (!state.pending && !state.locked) void controller.setEnabled(identity, !state.enabled);
    };
    return h(
      React.Fragment,
      null,
      h(
        'style',
        null,
        `
        .ct-fast-toggle{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:4px;border:0;border-radius:8px;background:transparent;color:var(--color-text-tertiary,#777);cursor:pointer}
        .ct-fast-toggle[aria-checked=true]{color:var(--color-chart-blue,#3291ff)}
        .ct-fast-toggle:hover:not(:disabled){background:var(--color-background-primary-ghost-hover,rgba(127,127,127,.12))}
        .ct-fast-toggle:focus-visible{outline:2px solid var(--color-chart-blue,#3291ff);outline-offset:1px}
        .ct-fast-toggle:disabled{cursor:default;opacity:.5}
        .ct-fast-indicator{display:inline-flex;align-items:center;margin-inline-end:3px;color:var(--color-text-tertiary,#777)}
        .ct-fast-error{position:absolute;inset-inline-start:0;top:34px;z-index:1;padding:4px 8px;border-radius:6px;background:var(--color-surface-elevated-secondary,#fff);color:var(--color-text,#222);font-size:12px;white-space:nowrap}
      `,
      ),
      h(
        'button',
        {
          type: 'button',
          role: 'menuitemcheckbox',
          className: 'ct-fast-toggle',
          'aria-label': state.enabled ? '关闭 Fast' : '开启 Fast',
          'aria-checked': state.enabled,
          'aria-busy': state.pending || undefined,
          disabled: state.pending || state.locked,
          title: state.locked ? 'Fast 由管理员设置' : 'Fast · 实际费用以上游计费为准',
          onClick(event) {
            event.preventDefault();
            event.stopPropagation();
            activate();
          },
          onKeyDown(event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              activate();
            }
          },
        },
        h(Bolt, { enabled: state.enabled }),
      ),
      state.error
        ? h('span', { className: 'ct-fast-error', role: 'alert' }, '无法保存 Fast 设置')
        : null,
    );
  };
}
