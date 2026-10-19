/** 宿主挂载入口：复用原生 React，管理被动通知、消息身份、重挂载和完整清理。 */
import { createDesktopBridge } from './desktop-bridge.mjs';
import { createTokenBadge } from '../ui/token-badge.mjs';
import { createModelMetadataBridge } from './model-metadata.mjs';
import { discoverHostConfig } from './cdp-discovery.mjs';

const OWNER = 'data-ct-cdp-root';
const GLOBAL = '__ctTokenCdpRuntimeV1';
const validId = (value) => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
// 当前官方回复行距 AppScope 超过 230 层 Fiber；遍历仍设上限，但不能按浅层测试树估计宿主深度。
const MAX_FIBER_DEPTH = 512;
function currentFiber(node) {
  const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
  if (!key) return null;
  let fiber = node[key],
    top = fiber;
  for (let i = 0; top?.return && i < MAX_FIBER_DEPTH; i++) top = top.return;
  if (top?.return) return null;
  if (top?.stateNode?.current && top.stateNode.current !== top) fiber = fiber.alternate ?? fiber;
  return fiber;
}

// 只读取身份属性，不读取正文。提交时两份 Fiber 可能并存，优先选择属于当前根节点的一份。
/** 从当前 Fiber 的身份属性读取消息归属；不读取正文，也不用位置或 URL 推断。 */
export function messageIdentityForNode(node) {
  for (
    let fiber = currentFiber(node), i = 0;
    fiber && i < MAX_FIBER_DEPTH;
    i++, fiber = fiber.return
  ) {
    const props = fiber.memoizedProps;
    if (props?.item?.type !== 'assistant-message') continue;
    const { conversationId: threadId, sourceTurnId: turnId } = props;
    const itemId = props.item.searchItemId;
    const hostId = props.hostId ?? 'local';
    if (![hostId, threadId, itemId].every(validId) || (turnId != null && !validId(turnId)))
      return null;
    return { hostId, threadId, itemId, ...(turnId != null ? { turnId } : {}) };
  }
  return null;
}

// 即使助手消息尚未出现，宿主的回合内容根节点也必须归属明确的活跃回合，不能根据 URL 或最新记录推断。
export function runningIdentityForNode(node) {
  for (
    let fiber = currentFiber(node), i = 0;
    fiber && i < MAX_FIBER_DEPTH;
    i++, fiber = fiber.return
  ) {
    const props = fiber.memoizedProps;
    if (!props?.mcpTurn) continue;
    const { hostId, conversationId: threadId, turnId } = props;
    if (
      props.mcpTurn.status !== 'inProgress' ||
      props.mcpTurn.turnId !== turnId ||
      ![hostId, threadId, turnId].every(validId)
    )
      return null;
    return { hostId, threadId, turnId, running: true };
  }
  return null;
}

// 在明确的活跃回合内选取最外层内容块，使控件位于最后一条工具或消息内容下方，排除固定输入区状态节点。
// 同一回合存在互不相连的候选根节点时不挂载，避免重复展示。
export function runningContentRows(candidates) {
  const identified = candidates
    .filter(
      (row) =>
        !row.closest?.(
          '[data-ct-cdp-root],[data-in-progress-fixed-content],[data-above-composer-portal],[data-above-composer-fixed-content-portal]',
        ),
    )
    .map((row) => ({ row, identity: runningIdentityForNode(row) }))
    .filter((entry) => entry.identity);
  const key = (entry) =>
    JSON.stringify([entry.identity.hostId, entry.identity.threadId, entry.identity.turnId]);
  const outer = identified.filter(
    (entry) =>
      !identified.some(
        (parent) =>
          parent !== entry && key(parent) === key(entry) && parent.row.contains(entry.row),
      ),
  );
  const counts = new Map();
  for (const entry of outer) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
  return outer.filter((entry) => counts.get(key(entry)) === 1).map((entry) => entry.row);
}

// 只把已识别的 AppScope 上下文引用传入独立根节点，不遍历应用状态或消息，不在 React 外调用 Hook，
// 也不修改宿主 Fiber 或上下文；React 18 与 19 的 Provider 暴露方式不同。
export function nativeScopeContextForNode(node, brand) {
  if (typeof brand !== 'string' || !brand) return null;
  for (
    let fiber = currentFiber(node), i = 0;
    fiber && i < MAX_FIBER_DEPTH;
    i++, fiber = fiber.return
  ) {
    const context = fiber.type?._context ?? fiber.type;
    if (context?.$$typeof !== Symbol.for('react.context') || context.displayName !== brand)
      continue;
    const value = fiber.memoizedProps?.value;
    if (!(value instanceof Map)) return null;
    return { Provider: context.Provider ?? context, value };
  }
  return null;
}

export function isOwnedMutation(mutation) {
  const inside = (node) =>
    !!(node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(`[${OWNER}]`);
  if (inside(mutation.target)) return true;
  if (mutation.type !== 'childList') return false;
  const changes = [...mutation.addedNodes, ...mutation.removedNodes];
  return changes.length > 0 && changes.every(inside);
}

export function nativeActionPresentation(row, target = globalThis) {
  const buttons = [...(row.querySelectorAll?.('button') ?? [])].filter(
    (button) => !button.closest?.(`[${OWNER}]`),
  );
  const copy =
    buttons.find((button) =>
      /copy|copied|复制|copier|kopieren|copiar|コピー|복사/i.test(
        [
          button.getAttribute?.('aria-label'),
          button.getAttribute?.('title'),
          button.getAttribute?.('data-testid'),
        ]
          .filter(Boolean)
          .join(' '),
      ),
    ) ?? buttons[0];
  if (!copy) return { anchor: null, presentation: {} };
  let anchor = copy;
  while (anchor.parentElement && anchor.parentElement !== row) anchor = anchor.parentElement;
  const computed = target.getComputedStyle?.(copy),
    icon = copy.querySelector?.('svg');
  const iconStyle = icon && target.getComputedStyle?.(icon);
  const style = {};
  for (const key of [
    'fontFamily',
    'fontWeight',
    'height',
    'borderRadius',
    'paddingTop',
    'paddingBottom',
  ]) {
    if (computed?.[key]) style[key] = computed[key];
  }
  // 图标按钮的横向点击区域应与复制按钮一致，避免原生边框或内边距挤压相邻按钮。
  const buttonPixels = Number.parseFloat(computed?.width);
  if (Number.isFinite(buttonPixels) && buttonPixels >= 16 && buttonPixels <= 48)
    style.minWidth = `${buttonPixels}px`;
  // 复制按钮只有图标，计算得到的字号可能仍是正文的 14–16px。
  // 保留原生点击区域和外观，数字使用较小字号；SVG 尺寸与复制图标一致，不强制限制为 12px。
  const compactPixels = (value, max) => {
    const pixels =
      typeof value === 'string' && /^(?:\d*\.)?\d+px$/.test(value) ? Number.parseFloat(value) : NaN;
    return `${pixels > 0 ? Math.min(pixels, max) : max}px`;
  };
  style.fontSize = compactPixels(computed?.fontSize, 12);
  style.lineHeight = compactPixels(computed?.lineHeight, 16);
  const iconPixels = Number.parseFloat(iconStyle?.width);
  return {
    anchor,
    presentation: {
      className: typeof copy.className === 'string' ? copy.className : '',
      style,
      iconSize: `${Number.isFinite(iconPixels) && iconPixels >= 8 && iconPixels <= 32 ? iconPixels : 16}px`,
    },
  };
}

// 可调用的导出工厂不一定是 React；编译器运行时也可能提供工厂，但没有元素或 Hook API。
// 初始化采集器或挂载界面前，必须先校验这些能力。
export function resolveNativeRuntime(native, config) {
  if (
    typeof native?.[config.parserInitExport] !== 'function' ||
    typeof native?.[config.parserExport] !== 'function'
  )
    throw new Error('runtime-parser-contract-mismatch');
  let React, createRoot;
  try {
    React = native[config.reactExport]();
    if (
      !['createElement', 'useSyncExternalStore', 'useId', 'useState', 'useRef'].every(
        (key) => typeof React?.[key] === 'function',
      )
    )
      throw new Error();
  } catch {
    throw new Error('runtime-react-core-contract-mismatch');
  }
  try {
    ({ createRoot } = native[config.reactDomExport]());
    if (typeof createRoot !== 'function') throw new Error();
  } catch {
    throw new Error('runtime-react-dom-contract-mismatch');
  }
  try {
    native[config.parserInitExport]();
  } catch {
    throw new Error('runtime-parser-contract-mismatch');
  }
  return { React, createRoot, parseNativeMessage: native[config.parserExport] };
}

/** 幂等安装增强；宿主结构不兼容时返回固定诊断码，释放已创建资源并保留原版运行。 */
export async function installCdpRuntime(config, dependencies = {}) {
  const target = dependencies.target ?? globalThis;
  const doc = dependencies.document ?? target.document;
  if (!doc || target.location?.origin !== config.origin || (target.top && target.top !== target))
    return { state: 'wrong-origin' };
  const previous = target[GLOBAL];
  if (previous?.version === config.releaseVersion && ['ready', 'loading'].includes(previous.state))
    return previous.health();
  previous?.dispose?.();

  let stopped = false,
    timer = null,
    observer = null,
    bridge = null,
    modelBridge = null;
  const roots = new Map();
  const status = {
    version: config.releaseVersion,
    state: 'loading',
    mode: 'app-server-reported',
    mounted: 0,
    notifications: 0,
    parserReady: false,
    modelMetadataState: 'unavailable',
    errorCode: null,
    errorStage: null,
  };
  const health = () => ({
    ...status,
    mounted: roots.size,
    modelMetadata: modelBridge?.getHealth() ?? null,
  });
  const disposeRoot = (row, entry) => {
    try {
      entry.root.unmount();
    } catch {
      /* 增强清理失败后，宿主仍须保持可用。 */
    }
    entry.container.remove();
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    target.clearTimeout(timer);
    observer?.disconnect();
    target.removeEventListener('message', onMessage);
    doc.removeEventListener('DOMContentLoaded', startObserver);
    bridge?.dispose();
    for (const [row, entry] of roots) disposeRoot(row, entry);
    roots.clear();
    modelBridge?.dispose();
    status.state = 'disposed';
  };
  let parseNativeMessage;
  const onMessage = (event) => {
    if (stopped) return;
    try {
      // 复用宿主导出的解析器，沿用来源校验及 WeakMap，避免重复解码或确认分片。
      const message = parseNativeMessage(event);
      if (message?.type === 'mcp-notification') {
        bridge.captureNotification(message.hostId, message.method, message.params);
        // 诊断信息不保留通知载荷、消息正文或工具参数。
        if (
          [
            'thread/started',
            'thread/settings/updated',
            'turn/started',
            'turn/completed',
            'thread/tokenUsage/updated',
            'item/started',
            'item/completed',
            'model/rerouted',
          ].includes(message.method)
        )
          status.notifications++;
      } else if (message?.type === 'codex-app-server-connection-changed') {
        bridge.connectionChanged(message);
      }
    } catch {
      /* 畸形事件不能中断宿主订阅方。 */
    }
  };
  let React, createRoot, Badge, ScopedBadge, MetadataBoundary, scopeBrand;
  const scan = () => {
    timer = null;
    if (stopped) return;
    const seen = new Set();
    const runningRows = config.runningRowSelector
      ? runningContentRows([...doc.querySelectorAll(config.runningRowSelector)])
      : [];
    const actionRows = [...doc.querySelectorAll(config.actionRowSelector)].filter(
      (row) => !runningRows.some((content) => content.contains(row)),
    );
    const runningSet = new Set(runningRows);
    const candidates = new Set(
      [...actionRows, ...runningRows].filter((row) => !row.closest(`[${OWNER}]`)),
    );
    const wrappers = new Set();
    // 宿主外层容器可能与内部操作区共享布局类；即使选择器较宽，也只挂载最内层匹配项。
    for (const row of actionRows) {
      for (let parent = row.parentElement; parent; parent = parent.parentElement) {
        if (actionRows.includes(parent)) wrappers.add(parent);
      }
    }
    for (const row of candidates) {
      if (wrappers.has(row)) continue;
      const identity = runningSet.has(row)
        ? runningIdentityForNode(row)
        : messageIdentityForNode(row);
      if (!identity) continue; // 身份缺失时不按序号、URL、正文或“最新消息”兜底。
      seen.add(row);
      const identityKey = JSON.stringify(identity);
      const action = identity.running
        ? { anchor: null, presentation: { iconSize: '16px' } }
        : nativeActionPresentation(row, target);
      const presentationKey = JSON.stringify(action.presentation);
      let entry = roots.get(row);
      if (entry && !row.contains(entry.container)) {
        disposeRoot(row, entry);
        roots.delete(row);
        entry = null;
      }
      if (!entry) {
        const container = doc.createElement('span');
        container.setAttribute(OWNER, '');
        container.style.display = 'inline-flex';
        container.style.flexShrink = '0';
        if (identity.running) {
          container.style.alignSelf = 'flex-start';
          container.style.marginTop = '6px';
        }
        if (action.anchor && row.insertBefore)
          row.insertBefore(container, action.anchor.nextSibling);
        else row.appendChild(container);
        entry = {
          container,
          root: createRoot(container, { identifierPrefix: 'ct-cdp-' }),
          identityKey: null,
        };
        roots.set(row, entry);
      }
      // 宿主操作项重排后，仍将增强根节点紧接在复制按钮后。
      if (action.anchor && row.insertBefore && action.anchor.nextSibling !== entry.container)
        row.insertBefore(entry.container, action.anchor.nextSibling);
      // React 可能在独立根节点之后追加工具块；跟随内容移动，使统计行保持在最新内容下方。
      if (identity.running && row.lastElementChild !== entry.container)
        row.appendChild(entry.container);
      // 不强制显示宿主操作区；增强根节点沿用原生的悬停、焦点与减少动态效果规则。
      const context = ScopedBadge ? nativeScopeContextForNode(row, scopeBrand) : null;
      if (
        entry.identityKey !== identityKey ||
        entry.contextValue !== context?.value ||
        entry.presentationKey !== presentationKey
      ) {
        const badgeProps = { ...identity, actionPresentation: action.presentation };
        let element = React.createElement(Badge, badgeProps);
        if (context) {
          element = React.createElement(
            context.Provider,
            { value: context.value },
            React.createElement(
              MetadataBoundary,
              { key: identityKey, identity: badgeProps },
              React.createElement(ScopedBadge, badgeProps),
            ),
          );
        }
        entry.root.render(element);
        entry.identityKey = identityKey;
        entry.contextValue = context?.value;
        entry.presentationKey = presentationKey;
      }
    }
    for (const [row, entry] of roots) {
      if (!seen.has(row)) {
        disposeRoot(row, entry);
        roots.delete(row);
      }
    }
    status.state = 'ready';
  };
  const schedule = () => {
    if (!stopped && timer === null) timer = target.setTimeout(scan, 60);
  };
  const startObserver = () => {
    if (stopped || observer || !doc.body) return;
    observer = new target.MutationObserver((changes) => {
      if (changes.some((change) => !isOwnedMutation(change))) schedule();
    });
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    if (doc.documentElement)
      observer.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      });
    schedule();
  };
  target[GLOBAL] = {
    version: config.releaseVersion,
    get state() {
      return status.state;
    },
    health,
    dispose,
  };
  let stage = 'capability-discovery';
  try {
    if (config.compatibilityMode === 'auto' && !dependencies.native) {
      config = { ...config, ...(await discoverHostConfig({ document: doc, target })) };
      if (stopped) return health();
    }
    stage = 'shared-module';
    const native = dependencies.native ?? (await import(config.sharedModuleUrl));
    if (stopped) return health();
    stage = 'native-contract';
    ({ React, createRoot, parseNativeMessage } = resolveNativeRuntime(native, config));
    stage = 'collector';
    let storage;
    try {
      storage = target.localStorage;
    } catch {
      /* 已有健康状态会反映此失败。 */
    }
    bridge = createDesktopBridge({ mode: 'app-server-reported', storage, target });
    Badge = createTokenBadge(React);
    modelBridge = createModelMetadataBridge(target);
    if (dependencies.metadataRuntime || config.modelMetadataModuleUrl) {
      try {
        let metadata = dependencies.metadataRuntime;
        if (!metadata) {
          const module = await import(config.modelMetadataModuleUrl);
          metadata = {
            useScope: native[config.scopeHookExport],
            threadModelAtom: module[config.threadModelExport],
          };
        }
        if (stopped) return health();
        const { useScope, threadModelAtom } = metadata;
        scopeBrand = threadModelAtom?.scope?.__scopeBrand;
        if (
          typeof useScope !== 'function' ||
          typeof scopeBrand !== 'string' ||
          !scopeBrand ||
          typeof React.useEffect !== 'function' ||
          typeof React.Component !== 'function'
        )
          throw new Error();
        ScopedBadge = function ModelMetadataBadge(props) {
          const scope = useScope(threadModelAtom.scope);
          React.useEffect(
            () => modelBridge.attachScope(scope, threadModelAtom, props.hostId, props.threadId),
            [scope, props.hostId, props.threadId],
          );
          return React.createElement(Badge, props);
        };
        MetadataBoundary = class extends React.Component {
          constructor(props) {
            super(props);
            this.state = { failed: false };
          }
          static getDerivedStateFromError() {
            return { failed: true };
          }
          componentDidCatch() {
            status.modelMetadataState = 'unavailable';
          }
          render() {
            return this.state.failed
              ? React.createElement(Badge, this.props.identity)
              : this.props.children;
          }
        };
        status.modelMetadataState = 'ready';
      } catch {
        /* 型号元数据是可选能力；协议不兼容时仍保留用量采集和按钮。 */
      }
    }
    target.addEventListener('message', onMessage);
    status.parserReady = true;
    stage = 'observer';
    if (doc.readyState === 'loading')
      doc.addEventListener('DOMContentLoaded', startObserver, { once: true });
    else startObserver();
    return health();
  } catch (error) {
    dispose();
    status.state = 'unsupported';
    status.errorStage = stage;
    const known = [
      'runtime-parser-contract-mismatch',
      'runtime-react-core-contract-mismatch',
      'runtime-react-dom-contract-mismatch',
      'runtime-capability-discovery-unavailable',
    ];
    status.errorCode =
      stage === 'shared-module'
        ? 'runtime-shared-module-load-failed'
        : stage === 'collector'
          ? 'runtime-collector-init-failed'
          : stage === 'observer'
            ? 'runtime-observer-init-failed'
            : known.includes(error?.message)
              ? error.message
              : 'runtime-host-contract-mismatch';
    return health();
  }
}
