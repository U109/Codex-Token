// 从当前页面自己的打包模块中发现能力，不依赖版本或指纹白名单。
// 只静态检查源码，不使用 eval，也不调用未知导出。
const ID = '[A-Za-z_$][\\w$]*';
// 当前 app-initial 已超过 12 MiB；读取器和解析器共用大小上限，
// 让可选型号发现与其他宿主能力在应用增大后仍使用一致的处理范围。
const MAX_ASSET_CHARACTERS = 32 * 1024 * 1024;
const fail = () => {
  throw new Error('runtime-capability-discovery-unavailable');
};
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const one = (values) => {
  if (values.length !== 1) fail();
  return values[0];
};

// 只按词法匹配分隔符，不执行 JS；检查工厂时跳过注释、字符串、模板表达式和正则字面量。
function balanced(source, start) {
  const pairs = { '(': ')', '{': '}', '[': ']' },
    stack = [pairs[source[start]]];
  if (!stack[0]) fail();
  let expression = true;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i],
      next = source[i + 1];
    if (/\s/.test(ch)) continue;
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      if (i < 0) fail();
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) fail();
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      for (i++; i < source.length; i++) {
        if (source[i] === '\\') {
          i++;
          continue;
        }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          i = balanced(source, i + 1);
          continue;
        }
        if (source[i] === quote) break;
      }
      expression = false;
      continue;
    }
    if (ch === '/' && expression) {
      let characterClass = false;
      for (i++; i < source.length; i++) {
        if (source[i] === '\\') {
          i++;
          continue;
        }
        if (source[i] === '[') characterClass = true;
        if (source[i] === ']') characterClass = false;
        if (source[i] === '/' && !characterClass) break;
      }
      expression = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const word = source.slice(i).match(/^[\w$]+/)[0];
      i += word.length - 1;
      expression = /^(?:return|throw|case|delete|void|typeof|new|in|of|yield|await)$/.test(word);
      continue;
    }
    if (pairs[ch]) {
      stack.push(pairs[ch]);
      expression = true;
      continue;
    }
    if (ch === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
      expression = false;
      continue;
    }
    expression = !/[\w.\])}]/.test(ch);
  }
  fail();
}

function exportNames(source) {
  const names = new Map();
  for (const block of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const item of block[1].split(',')) {
      const m = item.trim().match(new RegExp('^(' + ID + ')(?:\\s+as\\s+(' + ID + '))?$'));
      if (m) names.set(m[1], m[2] ?? m[1]);
    }
  }
  return names;
}

function functions(source, exports) {
  const values = [];
  for (const m of source.matchAll(
    new RegExp('\\bfunction\\s+(' + ID + ')\\s*\\([^)]*\\)\\s*\\{', 'g'),
  )) {
    if (!exports.has(m[1])) continue;
    const start = m.index + m[0].lastIndexOf('{');
    values.push({
      local: m[1],
      name: exports.get(m[1]),
      body: source.slice(start, balanced(source, start) + 1),
    });
  }
  return values;
}

function factories(source) {
  const values = [];
  const pattern = new RegExp(
    '(?:^|[;,])\\s*(?:var\\s+)?(' + ID + ')\\s*=\\s*' + ID + '\\s*\\(\\s*\\(',
    'g',
  );
  for (const m of source.matchAll(pattern)) {
    const start = m.index + m[0].indexOf('(');
    values.push({ local: m[1], body: source.slice(start, balanced(source, start) + 1) });
  }
  return values;
}

/** 静态识别唯一的 React、渲染器与消息解析器导出；不执行未知工厂函数。 */
export function inferNativeCapabilities(source) {
  if (typeof source !== 'string' || source.length > MAX_ASSET_CHARACTERS) fail();
  const exports = exportNames(source),
    declarations = functions(source, exports),
    modules = factories(source);
  const core = one(
    modules.filter(
      (m) => /\.createElement\s*=/.test(m.body) && /\.useSyncExternalStore\s*=/.test(m.body),
    ),
  );
  const dom = one(
    modules.filter(
      (m) =>
        /\.createRoot\s*=/.test(m.body) &&
        (/\.hydrateRoot\s*=/.test(m.body) || /Minified React error/.test(m.body)),
    ),
  );
  const factoryExport = (module) => {
    if (exports.has(module.local)) return exports.get(module.local);
    return exports.get(
      one(
        modules.filter(
          (m) =>
            exports.has(m.local) &&
            new RegExp('\\.exports\\s*=\\s*' + escaped(module.local) + '\\(\\)').test(m.body),
        ),
      ).local,
    );
  };
  const parser = one(
    declarations.filter(
      (f) =>
        f.body.length < 2000 &&
        /\.data\b/.test(f.body) &&
        /\bwindow\b/.test(f.body) &&
        /\.has\(/.test(f.body) &&
        /\.get\(/.test(f.body) &&
        /\.set\(/.test(f.body),
    ),
  );
  const cache = one(
    [...parser.body.matchAll(new RegExp('(' + ID + ')\\.has\\(', 'g'))].map((m) => m[1]),
  );
  const initializer = one(
    declarations.filter((f) =>
      new RegExp('(?<![\\w$])' + escaped(cache) + '\\s*=\\s*new WeakMap\\b').test(f.body),
    ),
  );
  const scopes = declarations.filter(
    (f) =>
      /getOwnValue\(/.test(f.body) &&
      /queryClient/.test(f.body) &&
      /\.watch=/.test(f.body) &&
      /\.useContext/.test(f.body),
  );
  return {
    parserExport: parser.name,
    parserInitExport: initializer.name,
    reactExport: factoryExport(core),
    reactDomExport: factoryExport(dom),
    ...(scopes.length === 1 ? { scopeHookExport: scopes[0].name } : {}),
  };
}

/** 只接受按 host/thread 订阅 modelSettings 的唯一候选；歧义时放弃型号展示能力。 */
export function inferModelCapability(source) {
  if (typeof source !== 'string' || source.length > MAX_ASSET_CHARACTERS) fail();
  const exports = exportNames(source),
    candidates = [];
  const pattern = new RegExp('(?<![\\w$])(' + ID + ')\\s*=\\s*' + ID + '\\s*\\(', 'g');
  for (const m of source.matchAll(pattern)) {
    if (!exports.has(m[1])) continue;
    const start = m.index + m[0].lastIndexOf('(');
    // 大部分导出与型号配置无关，先筛选候选，避免为每个名称重复解析数兆字节的无关代码。
    if (!/field:\s*[`'"]modelSettings[`'"]/.test(source.slice(start, start + 4000))) continue;
    const body = source.slice(start, balanced(source, start) + 1);
    if (
      body.length < 4000 &&
      /field:\s*[`'"]modelSettings[`'"]/.test(body) &&
      /\.subscribe\(/.test(body) &&
      /\.hostId\b/.test(body) &&
      /\.threadId\b/.test(body)
    )
      candidates.push(exports.get(m[1]));
  }
  return one(candidates);
}

/** 唯一的本地 AppServerManager 原子；同时核对初始化形状与明确的管理器消费点。 */
export function inferApiFastCapability(source) {
  if (typeof source !== 'string' || source.length > MAX_ASSET_CHARACTERS) fail();
  const exports = exportNames(source),
    candidates = [];
  const pattern = new RegExp('(?<![\\w$])(' + ID + ')\\s*=\\s*' + ID + '\\s*\\(', 'g');
  for (const match of source.matchAll(pattern)) {
    if (!exports.has(match[1])) continue;
    const start = match.index + match[0].lastIndexOf('(');
    const preview = source.slice(start, start + 600);
    if (!/\{\s*scope\s*:/.test(preview) || !/[`'"]local[`'"]/.test(preview)) continue;
    const body = source.slice(start, balanced(source, start) + 1);
    if (body.length > 1000 || !/return\s+null\b/.test(body)) continue;
    if (
      !new RegExp(
        '\\.get\\(\\s*' + escaped(match[1]) + '\\s*,[^)]{1,100}\\)\\?\\.getConversation\\(',
      ).test(source)
    )
      continue;
    candidates.push(exports.get(match[1]));
  }
  return one(candidates);
}

/** 复用模型选择器的项目上下文；新聊天的目录来自宿主订阅，不能借用其他会话或权限目录。 */
export function inferApiFastContextCapability(source) {
  if (typeof source !== 'string' || source.length > MAX_ASSET_CHARACTERS) fail();
  const exports = exportNames(source),
    candidates = [];
  const pattern = new RegExp('(?<![\\w$])(' + ID + ')\\s*=\\s*' + ID + '\\s*\\(', 'g');
  for (const match of source.matchAll(pattern)) {
    if (!exports.has(match[1])) continue;
    const start = match.index + match[0].lastIndexOf('(');
    const preview = source.slice(start, start + 1500);
    if (
      ![
        'activeLocalProjectCwd',
        'conversationCwd',
        'conversationHostId',
        'selectedRemoteProject',
      ].every((field) => preview.includes(field + ':'))
    )
      continue;
    const body = source.slice(start, balanced(source, start) + 1);
    if (
      body.length <= 1500 &&
      new RegExp('^\\(\\s*' + ID + '\\s*,\\s*\\(\\s*' + ID + '\\s*,\\s*\\{\\s*get\\s*:').test(
        body,
      ) &&
      /\bactiveWorkspaceRoot\s*:/.test(body) &&
      /\bisActiveWorkspaceRootLoading\s*:/.test(body)
    )
      candidates.push(exports.get(match[1]));
  }
  return one(candidates);
}

/** 只读当前 app:// 页面自己的有限本地资源，发现必要能力及可选的型号元数据。 */
export async function discoverHostConfig({ document: doc, target = globalThis, fetchSource } = {}) {
  const origin = target.location?.origin;
  if (origin !== 'app://-') fail();
  if (doc.readyState === 'loading')
    await new Promise((resolve) => {
      const done = () => {
        target.clearTimeout(timer);
        doc.removeEventListener('DOMContentLoaded', done);
        resolve();
      };
      const timer = target.setTimeout(done, 15000);
      doc.addEventListener('DOMContentLoaded', done, { once: true });
    });
  const urls = new Set();
  const add = (raw, base = origin + '/') => {
    try {
      const url = new URL(raw, base);
      if (
        url.protocol === 'app:' &&
        url.host === '-' &&
        !url.username &&
        !url.password &&
        /^\/assets\/[\w.-]+\.js$/.test(url.pathname) &&
        !url.search &&
        !url.hash
      )
        urls.add(url.href);
    } catch {
      /* 非本地模块，不参与能力发现。 */
    }
  };
  for (const node of doc.querySelectorAll('script[src],link[rel="modulepreload"][href]'))
    add(node.src || node.href);
  for (const entry of target.performance?.getEntriesByType?.('resource') ?? []) add(entry.name);
  const read =
    fetchSource ??
    (async (url) => {
      const response = await target.fetch(url, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) fail();
      const text = await response.text();
      if (text.length > MAX_ASSET_CHARACTERS) fail();
      return text;
    });
  const sources = new Map();
  // 只读取当前应用的 JS 资源，不请求外部资源，不读取源码映射、用户档案、认证数据或会话状态，
  // 也不调用任意导出。
  for (let count = 0; count < 8; count++) {
    const pending = [...urls].filter((url) => !sources.has(url));
    const url =
      pending.find((url) => /\/app-shared[.-]/.test(url)) ??
      pending.find((url) => /\/app-initial[.-]/.test(url)) ??
      pending.find((url) => /\/index[.-]/.test(url));
    if (!url) break;
    let source;
    try {
      source = await read(url);
    } catch {
      sources.set(url, '');
      continue;
    }
    if (typeof source !== 'string' || source.length > MAX_ASSET_CHARACTERS) {
      sources.set(url, '');
      continue;
    }
    sources.set(url, source);
    for (const m of source.matchAll(/["'`]((?:\.{0,2}\/)?(?:assets\/)?[\w.-]+\.js)["'`]/g))
      add(m[1], url);
    const shared = [...sources].find(([url]) => /\/app-shared[.-]/.test(url));
    const metadata = [...sources].find(([url]) => /\/app-initial[.-]/.test(url));
    if (shared && metadata) break;
  }
  const shared = one([...sources].filter(([url]) => /\/app-shared[.-]/.test(url)));
  const native = inferNativeCapabilities(shared[1]);
  const config = {
    ...native,
    sharedModuleUrl: shared[0],
    actionRowSelector:
      'div.turn-action-controls > div.flex.min-h-5.min-w-0.flex-wrap.items-center,div.turn-action-controls',
    runningRowSelector: 'div.flex.flex-col.gap-0',
  };
  try {
    const metadata = one([...sources].filter(([url]) => /\/app-initial[.-]/.test(url)));
    if (native.scopeHookExport)
      Object.assign(config, {
        modelMetadataModuleUrl: metadata[0],
        threadModelExport: inferModelCapability(metadata[1]),
      });
  } catch {
    /* 可选型号元数据失败时不能停用 Token 采集。 */
  }
  try {
    const initial = one([...sources].filter(([url]) => /\/app-initial[.-]/.test(url)));
    if (native.scopeHookExport)
      Object.assign(config, {
        apiFastModuleUrl: initial[0],
        apiFastManagerExport: inferApiFastCapability(initial[1]),
        apiFastContextExport: inferApiFastContextCapability(initial[1]),
      });
  } catch {
    /* Fast 是独立的可选能力，不能依赖混淆名或使统计失效。 */
  }
  return config;
}
