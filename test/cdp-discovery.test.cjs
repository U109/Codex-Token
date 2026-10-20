const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = import('../src/host/cdp-discovery.mjs');

const shared = `var core=wrap((e=>{e.createElement=function(){};e.useSyncExternalStore=function(){};})),
react=wrap(((e,t)=>{t.exports=core()})),
client=wrap((e=>{e.createRoot=function(){};e.hydrateRoot=function(){};})),
dom=wrap(((e,t)=>{t.exports=client()}));
function parse(e){if(cache.has(e))return cache.get(e);let t=decode(e.data,window);return cache.set(e,t),t}
function init(){cache=new WeakMap}
function scope(e){let t=React.useContext(e);return {getOwnValue(){},get queryClient(){return t},watch:0}.watch=t}
export{react as R,dom as D,parse as P,init as I,scope as S};`;
const metadata =
  'var atom=make(Scope,(e)=>e.hostId,(e)=>e.threadId,{subscribe:client.subscribe(e),field:`modelSettings`});export{atom as A};';
const fastContext =
  'var target=family(Scope,(thread,{get:g})=>{let result=resolve({activeLocalProjectCwd:g(project),conversationCwd:g(cwd,thread),conversationHostId:g(host,thread),selectedRemoteProject:g(remote)});return{activeWorkspaceRoot:null,isActiveWorkspaceRootLoading:false,...result}});export{target as Workspace};';

test('Fast manager discovery follows exports and fails safely on ambiguous host managers', async () => {
  const { inferApiFastCapability } = await api;
  const source =
    'var manager=family(Scope,(host,{scope:s})=>{if(host!==`local`)return null;let m=getManager(s,host);return m});function use(s,h,t){return s.get(manager,h)?.getConversation(t)}export{manager as NativeManager};';
  assert.equal(inferApiFastCapability(source), 'NativeManager');
  assert.equal(inferApiFastCapability(source.replaceAll('manager', '$renamed')), 'NativeManager');
  assert.throws(
    () => inferApiFastCapability(source.replace('getConversation', 'unrelated')),
    /capability-discovery/,
  );
  const second = source
    .replaceAll('manager', 'other')
    .replaceAll('NativeManager', 'OtherExport')
    .replace('function use', 'function useOther');
  assert.throws(() => inferApiFastCapability(source + second), /capability-discovery/);
});

test('Fast project context discovery rejects initializers, ambiguity and missing directory sources', async () => {
  const { inferApiFastContextCapability, discoverHostConfig } = await api;
  const wrapped =
    'function initialize(){' +
    fastContext.replace('export{target as Workspace};', '') +
    '}export{initialize as Init,target as Workspace};';
  assert.equal(inferApiFastContextCapability(wrapped), 'Workspace');
  assert.equal(
    inferApiFastContextCapability(fastContext.replaceAll('target', '$renamed')),
    'Workspace',
  );
  assert.throws(
    () => inferApiFastContextCapability(fastContext.replace('conversationCwd', 'unrelated')),
    /capability-discovery/,
  );
  assert.throws(
    () =>
      inferApiFastContextCapability(
        fastContext +
          fastContext.replaceAll('target', 'other').replace(' as Workspace', ' as Other'),
      ),
    /capability-discovery/,
  );
  const { doc, target, sources } = environment();
  sources['app://-/assets/app-initial-new.js'] +=
    fastContext +
    'var manager=family(Scope,(host,{scope:s})=>{if(host!==`local`)return null;return getManager(s,host)});function use(s,h,t){return s.get(manager,h)?.getConversation(t)}export{manager as Manager};';
  const result = await discoverHostConfig({
    document: doc,
    target,
    fetchSource: async (url) => sources[url],
  });
  assert.equal(result.apiFastManagerExport, 'Manager');
  assert.equal(result.apiFastContextExport, 'Workspace');
  assert.equal(result.threadModelExport, 'A');
});

test('automatic capabilities follow renamed exports without a version or fingerprint table', async () => {
  const { inferNativeCapabilities, inferModelCapability } = await api;
  const first = inferNativeCapabilities(shared);
  assert.deepEqual(first, {
    parserExport: 'P',
    parserInitExport: 'I',
    reactExport: 'R',
    reactDomExport: 'D',
    scopeHookExport: 'S',
  });
  const renamed = shared
    .replaceAll('core', '$core2')
    .replaceAll('react', '$react2')
    .replaceAll('cache', '$cache2')
    .replaceAll('parse', '$parse2')
    .replace(' as R', ' as ReactNew')
    .replace(' as P', ' as ParserNew');
  assert.equal(inferNativeCapabilities(renamed).reactExport, 'ReactNew');
  assert.equal(inferNativeCapabilities(renamed).parserExport, 'ParserNew');
  assert.equal(inferModelCapability(metadata), 'A');
});

test('source inspection ignores strings, regex delimiters and templates, without executing unknown factories', async () => {
  const { inferNativeCapabilities } = await api;
  const tricky = shared.replace(
    'e.createElement=',
    'let x=/[)}]/;let y=`raw ) ${`nested ${1}`}`;/* ) } */e.createElement=',
  );
  assert.equal(inferNativeCapabilities(tricky).reactExport, 'R');
  const bad = shared.replace(
    't.exports=core()',
    'globalThis.UNSAFE_FACTORY_WAS_CALLED=true;t.exports=core()',
  );
  inferNativeCapabilities(bad);
  assert.equal(globalThis.UNSAFE_FACTORY_WAS_CALLED, undefined);
});

test('ambiguous or missing capabilities disable only the enhancement instead of guessing', async () => {
  const { inferNativeCapabilities } = await api;
  assert.throws(
    () => inferNativeCapabilities(shared.replace('e.createElement=', 'e.noElement=')),
    /capability-discovery/,
  );
  assert.throws(
    () =>
      inferNativeCapabilities(
        shared.replace(
          'export{',
          'function parse2(e){if(cache.has(e))return cache.get(e);return cache.set(e,window.decode(e.data))}export{parse2 as P2,',
        ),
      ),
    /capability-discovery/,
  );
});

function environment() {
  const urls = [
    'app://-/assets/index-new.js',
    'app://-/assets/app-shared-new.js',
    'https://untrusted.invalid/assets/app-shared-evil.js',
  ];
  const doc = { readyState: 'complete', querySelectorAll: () => urls.map((src) => ({ src })) };
  const target = { location: { origin: 'app://-' }, performance: { getEntriesByType: () => [] } };
  const sources = {
    'app://-/assets/index-new.js': 'import "./app-initial-new.js";',
    'app://-/assets/app-shared-new.js': shared,
    'app://-/assets/app-initial-new.js': metadata,
  };
  return { doc, target, sources };
}

test('discovery reads only local application modules and hydrates optional model capabilities', async () => {
  const { discoverHostConfig } = await api,
    { doc, target, sources } = environment(),
    requested = [];
  const result = await discoverHostConfig({
    document: doc,
    target,
    fetchSource: async (url) => {
      requested.push(url);
      return sources[url];
    },
  });
  assert.equal(result.sharedModuleUrl, 'app://-/assets/app-shared-new.js');
  assert.equal(result.threadModelExport, 'A');
  assert.equal(
    requested.some((url) => url.startsWith('https:')),
    false,
  );
  assert.equal(requested.length, 3);
});

test('the full discovery path retains model metadata when the native initial bundle exceeds 12 MiB', async () => {
  const { discoverHostConfig } = await api;
  // 当前官方 app-initial 约为 14 MB；同时测试读取器、解析器和生产资源读取流程，
  // 避免大小检查让本可识别的可选型号能力悄悄失效。
  const largeMetadata = '/*' + ' '.repeat(13 * 1024 * 1024) + '*/' + metadata;
  for (const injectedReader of [false, true]) {
    const { doc, target, sources } = environment();
    sources['app://-/assets/app-initial-new.js'] = largeMetadata;
    target.fetch = async (url) => ({ ok: true, text: async () => sources[url] });
    const config = await discoverHostConfig({
      document: doc,
      target,
      ...(injectedReader ? { fetchSource: async (url) => sources[url] } : {}),
    });
    assert.equal(config.threadModelExport, 'A');
    assert.equal(config.scopeHookExport, 'S');
    assert.equal(config.modelMetadataModuleUrl, 'app://-/assets/app-initial-new.js');
  }
});

test('unavailable optional metadata does not break usage collection', async () => {
  const { discoverHostConfig } = await api,
    { doc, target, sources } = environment();
  const result = await discoverHostConfig({
    document: doc,
    target,
    fetchSource: async (url) => {
      if (url.includes('app-initial')) throw Error('optional asset unavailable');
      return sources[url];
    },
  });
  assert.equal(result.reactExport, 'R');
  assert.equal(result.modelMetadataModuleUrl, undefined);
});

test('oversized optional assets remain bounded without disabling the required usage capabilities', async () => {
  const { discoverHostConfig } = await api;
  const oversized = ' '.repeat(32 * 1024 * 1024 + 1);
  for (const injectedReader of [false, true]) {
    const { doc, target, sources } = environment();
    sources['app://-/assets/app-initial-new.js'] = oversized;
    target.fetch = async (url) => ({ ok: true, text: async () => sources[url] });
    const config = await discoverHostConfig({
      document: doc,
      target,
      ...(injectedReader ? { fetchSource: async (url) => sources[url] } : {}),
    });
    assert.equal(config.reactExport, 'R');
    assert.equal(config.threadModelExport, undefined);
  }
});

test('discovery rejects remote document origins before reading any asset', async () => {
  const { discoverHostConfig } = await api;
  await assert.rejects(
    () =>
      discoverHostConfig({
        target: { location: { origin: 'https://untrusted.invalid' } },
        fetchSource: () => {
          throw Error('must not read');
        },
      }),
    /capability-discovery/,
  );
});

test('universal packaging has one runtime and no installed-host profile gate', () => {
  const build = fs.readFileSync(path.resolve(__dirname, '../scripts/build.py'), 'utf8');
  assert.doesNotMatch(
    build,
    /load_profiles\(|retained_validation\(|verify_host\(|Get-AppxPackage|runtime_file\(/,
  );
  assert.match(build, /CodexToken-Setup-win-x64\.exe/);
  const manager = fs.readFileSync(
    path.resolve(__dirname, '../packaging/windows/Manage.ps1'),
    'utf8',
  );
  assert.doesNotMatch(manager, /Catalog\.adapter|executableSha256|archiveSha256/);
  const runtime = fs.readFileSync(
    path.resolve(__dirname, '../packaging/windows/Runtime.cs'),
    'utf8',
  );
  assert.doesNotMatch(
    runtime,
    /official-host-changed|unsupported-official-host|catalog\["adapter"\]/,
  );
});
