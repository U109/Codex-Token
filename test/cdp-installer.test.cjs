const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('installer dialogs use concise, factual confirmation and completion messages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../packaging/windows/Setup.cs'), 'utf8');
  const message = (name) => {
    const literal = source.match(
      new RegExp(
        'private\\s+const\\s+string\\s+' +
          name +
          '\\s*=\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*\\+\\s*)*"(?:[^"\\\\]|\\\\.)*")\\s*;',
      ),
    );
    assert.ok(literal, name + ' must be a complete message');
    return literal[1]
      .match(/"(?:[^"\\]|\\.)*"/g)
      .map((part) => JSON.parse(part))
      .join('');
  };
  const prompt = message('InstallPrompt'),
    complete = message('InstallCompleteMessage');
  assert.ok(prompt.length <= 100, 'Keep the install decision short enough to scan');
  assert.ok(prompt.split('\n').length <= 4);
  for (const notice of [
    '是否安装 Codex Token',
    '非官方',
    '未签名',
    '不修改 Codex 原程序',
    '仅限本机的调试端口',
  ]) {
    assert.ok(prompt.includes(notice), 'Required installation notice: ' + notice);
  }
  assert.ok(complete.length <= 60);
  for (const instruction of ['安装完成', '完全退出 Codex', '“Codex Token”快捷方式']) {
    assert.ok(complete.includes(instruction), 'Required next step: ' + instruction);
  }
  assert.doesNotMatch(prompt + complete, /宿主|验收|兼容|0\.3\.3|自动检测界面能力/);
  assert.match(source, /MessageBox\.Show\(\s*InstallPrompt,/);
  assert.match(source, /MessageBox\.Show\(\s*InstallCompleteMessage,/);
});

function installerFixture(t) {
  // Windows TEMP 可能使用 8.3 短路径；原生解析保持与 .NET 和快捷方式一致的长路径。
  const parent = fs.realpathSync.native(os.tmpdir()),
    root = fs.mkdtempSync(path.join(parent, 'ct-cdp-install-test-'));
  const registry = 'HKCU:\\Software\\CodexTokenInstallerTests\\' + path.basename(root);
  t.after(() => {
    assert.ok(
      registry.startsWith('HKCU:\\Software\\CodexTokenInstallerTests\\ct-cdp-install-test-'),
    );
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'if(Test-Path -LiteralPath $env:CT_CDP_TEST_REGISTRY){Remove-Item -LiteralPath $env:CT_CDP_TEST_REGISTRY -Recurse -Force}',
      ],
      { env: { ...process.env, CT_CDP_TEST_REGISTRY: registry }, windowsHide: true },
    );
    const target = fs.realpathSync.native(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('ct-cdp-install-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const payload = path.join(root, 'payload'),
    official = path.join(root, 'fake-official'),
    install = path.join(root, 'CodexToken');
  fs.mkdirSync(payload);
  fs.mkdirSync(path.join(official, 'app/resources'), { recursive: true });
  const hostExe = path.join(official, 'app/ChatGPT.exe'),
    archive = path.join(official, 'app/resources/app.asar');
  fs.writeFileSync(hostExe, 'FAKE_OFFICIAL_EXE_NOT_EXECUTABLE');
  fs.writeFileSync(archive, 'FAKE_OFFICIAL_ASAR');
  const original = { exe: hash(hostExe), archive: hash(archive) };
  let manager = fs
    .readFileSync(path.join(__dirname, '../packaging/windows/Manage.ps1'), 'utf8')
    // 生产脚本本身已带 UTF-8 BOM，测试写出时只保留一个文件头。
    .replace(/^\uFEFF/, '');
  // 夹具按语句定位注入故障，并确认锚点仍存在，避免格式化让回滚测试悄悄失效。
  const patchManager = (pattern, replacement) => {
    assert.match(manager, pattern, 'Installer fixture injection point must exist');
    manager = manager.replace(pattern, replacement);
  };
  patchManager(
    /\$registryPath\s*=\s*'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexTokenCdp'/,
    '$registryPath = $env:CT_CDP_TEST_REGISTRY',
  );
  patchManager(
    /\[Environment\]::GetFolderPath\(\s*'Desktop'\s*\)/g,
    "(Join-Path $env:CT_CDP_TEST_ROOT 'desktop')",
  );
  patchManager(
    /\[Environment\]::GetFolderPath\(\s*'Programs'\s*\)/g,
    "(Join-Path $env:CT_CDP_TEST_ROOT 'programs')",
  );
  patchManager(
    /^[ \t]*\[IO.Directory\]::Move\(\$source,\s*\$target\)/m,
    "    if ($env:CT_CDP_FAIL_PLACE -eq '1' -and $source -eq $stage) { throw 'fixture-placement-failed' }\n$&",
  );
  patchManager(
    /(^function Set-Integration\b[\s\S]*?)(^})/m,
    "$1    if ($env:CT_CDP_FAIL_INTEGRATION -eq '1') { throw 'fixture-integration-failed' }\n$2",
  );
  patchManager(
    /^}\s*catch\s*{\s*(?=if\s*\(\$stage\b)/m,
    '$&Write-Host $_.Exception.Message; Write-Host $_.ScriptStackTrace\n    ',
  );
  fs.writeFileSync(path.join(payload, 'Manage.ps1'), '\ufeff' + manager);
  fs.writeFileSync(path.join(payload, 'runtime.js'), '/* 仅用于测试的本项目运行脚本。 */');
  fs.writeFileSync(path.join(payload, 'README.txt'), 'own test readme');
  fs.copyFileSync(
    path.resolve(__dirname, '../assets/codex-token.ico'),
    path.join(payload, 'CodexToken.ico'),
  );
  fs.copyFileSync(path.join(__dirname, 'fixtures/FakeHelper.cs'), path.join(root, 'FakeHelper.cs'));
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  // 使用与生产一致的 GUI 子系统；Windows PowerShell 通过 & 调用时不会等待，
  // $LASTEXITCODE 也不可靠，不能用控制台模拟程序掩盖这一差异。
  assert.equal(
    spawnSync(
      compiler,
      [
        '/nologo',
        '/target:winexe',
        '/out:' + path.join(payload, 'CodexToken.Runtime.exe'),
        path.join(root, 'FakeHelper.cs'),
      ],
      { windowsHide: true },
    ).status,
    0,
  );
  const manifest = {
    applicationId: 'org.codextoken.cdp',
    schemaVersion: 6,
    mode: 'cdp-runtime',
    releaseVersion: 'test',
    compatibilityMode: 'auto',
    payloadFiles: Object.fromEntries(
      ['Manage.ps1', 'runtime.js', 'README.txt', 'CodexToken.Runtime.exe', 'CodexToken.ico'].map(
        (n) => [n, hash(path.join(payload, n))],
      ),
    ),
  };
  const seal = (version = manifest.releaseVersion) => {
    manifest.releaseVersion = version;
    for (const name of Object.keys(manifest.payloadFiles))
      manifest.payloadFiles[name] = hash(path.join(payload, name));
    fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify(manifest));
  };
  seal();
  for (const name of ['desktop', 'programs']) fs.mkdirSync(path.join(root, name));
  const bootstrap = path.join(root, 'bootstrap.exe');
  fs.writeFileSync(bootstrap, 'TEST_BOOTSTRAP_NEVER_EXECUTED');
  const driver = path.join(root, 'driver.ps1');
  fs.copyFileSync(path.join(__dirname, 'fixtures/InstallerDriver.ps1'), driver);
  const run = (mode, managerRoot = payload, version = 'test', extraEnv = {}) => {
    const report = path.join(root, mode + '.json');
    const env = {
      ...process.env,
      CT_CDP_MANAGER: path.join(managerRoot, 'Manage.ps1'),
      CT_CDP_MODE: mode,
      CT_CDP_INSTALL: install,
      CT_CDP_BOOTSTRAP: bootstrap,
      CT_CDP_REPORT: report,
      CT_CDP_OFFICIAL: official,
      CT_CDP_HOST_VERSION: version,
      CT_CDP_TEST_ROOT: root,
      CT_CDP_TEST_REGISTRY: registry,
      ...extraEnv,
    };
    for (const key of Object.keys(env)) if (/^PSModulePath$/i.test(key)) delete env[key];
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      {
        windowsHide: true,
        encoding: 'utf8',
        env,
      },
    );
    assert.ok(
      fs.existsSync(report),
      result.error?.message || result.stderr || result.stdout || 'Manager did not write a report',
    );
    return {
      status: result.status,
      data: JSON.parse(fs.readFileSync(report, 'utf8')),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const ps = (script) =>
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, CT_CDP_TEST_REGISTRY: registry, CT_CDP_INSTALL: install },
      windowsHide: true,
      encoding: 'utf8',
    });
  return { root, payload, install, bootstrap, official, hostExe, archive, original, run, seal, ps };
}

test(
  'CDP manager checks, installs, repairs an owned install, rejects tampering, and uninstalls without writing the host',
  { skip: process.platform !== 'win32' },
  (t) => {
    const { install, payload, hostExe, archive, original, run } = installerFixture(t);
    const check = run('Check');
    assert.equal(check.status, 0, check.stderr + check.stdout);
    assert.equal(check.data.runtimeLaunched, false);
    assert.equal(fs.existsSync(install), false);
    const installed = run('Install');
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    assert.equal(installed.data.clientCopied, false);
    assert.equal(installed.data.featureVerified, false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(install, 'launch.json'))).aumid,
      'OpenAI.Codex_test!App',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(install, 'package.owner.json'))).applicationId,
      'org.codextoken.cdp',
    );
    const reinstalled = run('Install');
    assert.equal(reinstalled.status, 0, reinstalled.stderr + reinstalled.stdout);
    assert.equal(reinstalled.data.upgraded, true);
    assert.equal(reinstalled.data.previousVersion, 'test');
    fs.writeFileSync(
      path.join(install, 'CodexToken.Runtime.exe'),
      'INVALID_OLD_BINARY_MUST_NOT_BE_EXECUTED',
    );
    const repaired = run('Install');
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    assert.equal(
      hash(path.join(install, 'CodexToken.Runtime.exe')),
      hash(path.join(payload, 'CodexToken.Runtime.exe')),
    );
    fs.appendFileSync(path.join(install, 'runtime.js'), '/* 模拟载荷被修改。 */');
    const tampered = run('Launch', install);
    assert.equal(tampered.status, 1);
    assert.equal(tampered.data.errorCode, 'payload-checksum-mismatch');
    const failStop = path.join(install, 'fail-stop.fixture');
    fs.writeFileSync(failStop, 'owned test sentinel');
    const refused = run('Uninstall', install);
    assert.equal(refused.status, 1);
    assert.equal(refused.data.errorCode, 'helper-stop-failed');
    assert.equal(
      fs.existsSync(install),
      true,
      'A failed GUI helper stop must preserve the install',
    );
    fs.unlinkSync(failStop);
    const removed = run('Uninstall', install);
    assert.equal(removed.status, 0, removed.stderr + removed.stdout);
    assert.equal(fs.existsSync(install), false);
    assert.equal(removed.data.profileDeleted, false);
    assert.deepEqual({ exe: hash(hostExe), archive: hash(archive) }, original);
    fs.appendFileSync(archive, 'changed');
    const updated = run('Check', payload, '99.9999.9999.0');
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.equal(updated.data.packageVersion, '99.9999.9999.0');
    assert.equal(updated.data.compatibilityMode, 'auto');
    assert.equal(updated.data.versionGateEnabled, false);
    assert.equal(updated.data.officialFingerprintGateEnabled, false);
    assert.equal(fs.existsSync(install), false);
  },
);

test(
  'owned upgrades preserve extra files, replace the bootstrap and payload, and stop only the matching running helper',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = installerFixture(t),
      other = installerFixture(t);
    assert.equal(f.run('Install').status, 0);
    assert.equal(other.run('Install').status, 0);
    fs.writeFileSync(path.join(f.install, 'user-note.txt'), 'KEEP_EXTRA_FILE');
    fs.mkdirSync(path.join(f.install, 'notes'));
    fs.writeFileSync(path.join(f.install, 'notes/keep.txt'), 'KEEP_NESTED_FILE');
    // 旧文件即使被修改，也应由已验证的新载荷修复。
    fs.appendFileSync(path.join(f.install, 'runtime.js'), 'old modified bytes');
    fs.appendFileSync(path.join(f.payload, 'runtime.js'), '/* 模拟新版本载荷。 */');
    fs.writeFileSync(f.bootstrap, 'NEW_BOOTSTRAP_NEVER_EXECUTED');
    f.seal('next');
    const helpers = [f, other].map((item) =>
      spawn(path.join(item.install, 'CodexToken.Runtime.exe'), ['--hold'], {
        windowsHide: true,
        stdio: 'ignore',
      }),
    );
    const exited = helpers.map((child) => new Promise((resolve) => child.once('exit', resolve)));
    try {
      for (const item of [f, other]) {
        const deadline = Date.now() + 5000;
        while (
          !fs.existsSync(path.join(item.install, 'helper-ready.fixture')) &&
          Date.now() < deadline
        )
          await new Promise((r) => setTimeout(r, 30));
        assert.ok(fs.existsSync(path.join(item.install, 'helper-ready.fixture')));
      }
      const upgraded = f.run('Install');
      assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
      assert.equal(upgraded.data.upgraded, true);
      assert.equal(upgraded.data.installedVersion, 'next');
      assert.equal(
        hash(path.join(f.install, 'runtime.js')),
        hash(path.join(f.payload, 'runtime.js')),
      );
      assert.equal(hash(path.join(f.install, 'CodexToken.exe')), hash(f.bootstrap));
      assert.equal(
        fs.readFileSync(path.join(f.install, 'user-note.txt'), 'utf8'),
        'KEEP_EXTRA_FILE',
      );
      assert.equal(
        fs.readFileSync(path.join(f.install, 'notes/keep.txt'), 'utf8'),
        'KEEP_NESTED_FILE',
      );
      await exited[0];
      assert.equal(helpers[0].exitCode, 0);
      assert.equal(helpers[1].exitCode, null, 'Another installation must keep running');
      assert.deepEqual(
        fs.readdirSync(f.root).filter((n) => /^\.CodexTokenCdp-(stage|backup)-/.test(n)),
        [],
      );
      assert.deepEqual({ exe: hash(f.hostExe), archive: hash(f.archive) }, f.original);
    } finally {
      for (const [i, item] of [f, other].entries()) {
        spawnSync(
          path.join(item.payload, 'CodexToken.Runtime.exe'),
          ['--stop', '--root', item.install],
          { windowsHide: true },
        );
        if (helpers[i].exitCode === null) await exited[i];
      }
    }
  },
);

test(
  'upgrade failures preserve the old files and restore shortcuts and typed uninstall metadata',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = installerFixture(t),
      integrated = { CT_CDP_WITH_INTEGRATION: '1' };
    const initial = f.run('Install', f.payload, 'test', integrated);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    const readIcons = () =>
      f.ps(
        "$shell=New-Object -ComObject WScript.Shell;[pscustomobject]@{links=@('desktop','programs')|ForEach-Object{$shell.CreateShortcut((Join-Path (Split-Path -Parent $env:CT_CDP_INSTALL) ($_+'/Codex Token.lnk'))).IconLocation};uninstall=Get-ItemPropertyValue -LiteralPath $env:CT_CDP_TEST_REGISTRY -Name DisplayIcon}|ConvertTo-Json -Compress",
      );
    const expectedIcon = path.join(f.install, 'CodexToken.ico') + ',0';
    assert.deepEqual(JSON.parse(readIcons().stdout), {
      links: [expectedIcon, expectedIcon],
      uninstall: expectedIcon,
    });
    assert.equal(
      hash(path.join(f.install, 'CodexToken.ico')),
      hash(path.join(f.payload, 'CodexToken.ico')),
    );
    assert.equal(
      f.ps(
        "New-ItemProperty -LiteralPath $env:CT_CDP_TEST_REGISTRY -Name CustomValue -Value '%TEMP%/keep' -PropertyType ExpandString -Force | Out-Null",
      ).status,
      0,
    );
    const links = ['desktop', 'programs'].map((name) => path.join(f.root, name, 'Codex Token.lnk'));
    const before = {
      runtime: hash(path.join(f.install, 'runtime.js')),
      bootstrap: hash(path.join(f.install, 'CodexToken.exe')),
      marker: hash(path.join(f.install, 'package.owner.json')),
      links: links.map(hash),
    };
    fs.appendFileSync(path.join(f.payload, 'runtime.js'), '/* 待验证的候选载荷。 */');
    f.seal('candidate');
    for (const [fault, code] of [
      ['CT_CDP_FAIL_PLACE', 'fixture-placement-failed'],
      ['CT_CDP_FAIL_INTEGRATION', 'fixture-integration-failed'],
    ]) {
      const result = f.run('Install', f.payload, 'test', { ...integrated, [fault]: '1' });
      assert.equal(result.status, 1);
      assert.equal(result.data.errorCode, code, result.stdout + result.stderr);
      assert.deepEqual(
        {
          runtime: hash(path.join(f.install, 'runtime.js')),
          bootstrap: hash(path.join(f.install, 'CodexToken.exe')),
          marker: hash(path.join(f.install, 'package.owner.json')),
          links: links.map(hash),
        },
        before,
      );
      const metadata = f.ps(
        "$key=Get-Item -LiteralPath $env:CT_CDP_TEST_REGISTRY; @{version=$key.GetValue('DisplayVersion');custom=$key.GetValue('CustomValue',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=[string]$key.GetValueKind('CustomValue')}|ConvertTo-Json -Compress",
      );
      assert.equal(metadata.status, 0, metadata.stderr);
      assert.deepEqual(JSON.parse(metadata.stdout), {
        version: 'test',
        custom: '%TEMP%/keep',
        kind: 'ExpandString',
      });
      assert.deepEqual(
        fs.readdirSync(f.root).filter((n) => /^\.CodexTokenCdp-(stage|backup)-/.test(n)),
        [],
      );
    }
    const shortcut = fs.readFileSync(links[1]);
    const foreignShortcut = f.ps(
      "$p=Join-Path (Split-Path -Parent $env:CT_CDP_INSTALL) 'programs/Codex Token.lnk';$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);$s.TargetPath=Join-Path $env:TEMP 'another-installer.exe';$s.Save()",
    );
    assert.equal(foreignShortcut.status, 0, foreignShortcut.stderr);
    const foreignHash = hash(links[1]);
    assert.equal(
      f.run('Install', f.payload, 'test', integrated).data.errorCode,
      'shortcut-already-owned-by-another-install',
    );
    assert.equal(hash(links[0]), before.links[0]);
    assert.equal(hash(links[1]), foreignHash);
    assert.equal(hash(path.join(f.install, 'runtime.js')), before.runtime);
    fs.writeFileSync(links[1], shortcut);
    assert.equal(
      f.ps(
        "Set-ItemProperty -LiteralPath $env:CT_CDP_TEST_REGISTRY -Name InstallLocation -Value 'ANOTHER_INSTALL'",
      ).status,
      0,
    );
    assert.equal(
      f.run('Install', f.payload, 'test', integrated).data.errorCode,
      'uninstall-entry-already-owned-by-another-install',
    );
    assert.equal(hash(path.join(f.install, 'runtime.js')), before.runtime);
    assert.equal(
      f.ps(
        'Set-ItemProperty -LiteralPath $env:CT_CDP_TEST_REGISTRY -Name InstallLocation -Value $env:CT_CDP_INSTALL',
      ).status,
      0,
    );
    fs.writeFileSync(path.join(f.install, 'fail-stop.fixture'), 'do not replace');
    const stopped = f.run('Install', f.payload, 'test', integrated);
    assert.equal(stopped.data.errorCode, 'helper-stop-failed');
    assert.equal(hash(path.join(f.install, 'runtime.js')), before.runtime);
    fs.unlinkSync(path.join(f.install, 'fail-stop.fixture'));
    fs.appendFileSync(path.join(f.payload, 'runtime.js'), 'CORRUPTED_INCOMING_PAYLOAD');
    const corrupt = f.run('Install', f.payload, 'test', integrated);
    assert.equal(corrupt.data.errorCode, 'payload-checksum-mismatch');
    assert.equal(hash(path.join(f.install, 'runtime.js')), before.runtime);
    f.seal('candidate');
    const upgraded = f.run('Install', f.payload, 'test', integrated);
    assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
    assert.equal(upgraded.data.upgraded, true);
    assert.equal(
      JSON.parse(
        f.ps(
          'Get-ItemPropertyValue -LiteralPath $env:CT_CDP_TEST_REGISTRY -Name DisplayVersion | ConvertTo-Json -Compress',
        ).stdout,
      ),
      'candidate',
    );
    assert.deepEqual(JSON.parse(readIcons().stdout), {
      links: [expectedIcon, expectedIcon],
      uninstall: expectedIcon,
    });
  },
);

test(
  'automatic upgrades refuse unowned directories and nested links without removing their contents',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = installerFixture(t);
    fs.mkdirSync(f.install);
    const extra = path.join(f.install, 'keep.txt');
    fs.writeFileSync(extra, 'NOT_OWNED');
    assert.equal(f.run('Install').data.errorCode, 'unowned-install-root');
    assert.equal(fs.readFileSync(extra, 'utf8'), 'NOT_OWNED');
    fs.writeFileSync(
      path.join(f.install, 'package.owner.json'),
      JSON.stringify({ applicationId: 'another.app', mode: 'cdp-runtime' }),
    );
    assert.equal(f.run('Install').data.errorCode, 'unowned-install-root');
    fs.writeFileSync(
      path.join(f.install, 'package.owner.json'),
      JSON.stringify({ applicationId: 'org.codextoken.cdp', mode: 'cdp-runtime' }),
    );
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'LINK_TARGET');
    fs.symlinkSync(outside, path.join(f.install, 'linked-directory'), 'junction');
    const linked = f.run('Install');
    assert.equal(linked.status, 1);
    assert.equal(linked.data.errorCode, 'reparse-cleanup-target');
    assert.equal(fs.readFileSync(extra, 'utf8'), 'NOT_OWNED');
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'LINK_TARGET');
  },
);

test(
  'CDP runtime stop signals are scoped to the installation root, never another install or legacy helper',
  { skip: process.platform !== 'win32' },
  (t) => {
    const parent = fs.realpathSync.native(os.tmpdir()),
      root = fs.mkdtempSync(path.join(parent, 'ct-cdp-stop-test-'));
    t.after(() => {
      const target = fs.realpathSync.native(root);
      assert.equal(path.dirname(target), parent);
      assert.ok(path.basename(target).startsWith('ct-cdp-stop-test-'));
      fs.rmSync(target, { recursive: true, force: true });
    });
    const harness = path.join(root, 'ScopedStopTest.cs'),
      exe = path.join(root, 'stop-test.exe');
    fs.copyFileSync(path.join(__dirname, 'fixtures/ScopedStopTest.cs'), harness);
    const compile = spawnSync(
      path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/target:exe',
        '/main:ScopedStopTest',
        '/r:System.Web.Extensions.dll',
        '/out:' + exe,
        path.resolve(__dirname, '../packaging/windows/Runtime.cs'),
        harness,
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const result = spawnSync(exe, [root], { windowsHide: true, encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      'Only the requested root may receive a stop signal: ' + result.stdout + result.stderr,
    );
  },
);

test(
  'compiled universal runtime accepts unlisted host versions and changed host bytes while rejecting payload tampering',
  { skip: process.platform !== 'win32' },
  (t) => {
    const parent = fs.realpathSync.native(os.tmpdir()),
      root = fs.mkdtempSync(path.join(parent, 'ct-cdp-plan-test-'));
    t.after(() => {
      const target = fs.realpathSync.native(root);
      assert.equal(path.dirname(target), parent);
      assert.ok(path.basename(target).startsWith('ct-cdp-plan-test-'));
      fs.rmSync(target, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, 'official/resources'), { recursive: true });
    const exe = path.join(root, 'official/ChatGPT.exe'),
      archive = path.join(root, 'official/resources/app.asar');
    fs.writeFileSync(exe, 'INERT_HOST_NOT_EXECUTABLE');
    fs.writeFileSync(archive, 'INERT_ARCHIVE');
    fs.writeFileSync(path.join(root, 'runtime.js'), '/* 只作校验、不执行的运行脚本。 */');
    fs.writeFileSync(
      path.join(root, 'package.owner.json'),
      JSON.stringify({ applicationId: 'org.codextoken.cdp', mode: 'cdp-runtime' }),
    );
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        applicationId: 'org.codextoken.cdp',
        schemaVersion: 6,
        mode: 'cdp-runtime',
        compatibilityMode: 'auto',
        payloadFiles: { 'runtime.js': hash(path.join(root, 'runtime.js')) },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'launch.json'),
      JSON.stringify({
        executable: exe,
        archive,
        aumid: 'OpenAI.Codex_test!App',
        packageVersion: '99.9999.9999.0',
        compatibilityMode: 'auto',
      }),
    );
    const source = path.join(root, 'PlanTest.cs'),
      harness = path.join(root, 'plan-test.exe');
    fs.copyFileSync(path.join(__dirname, 'fixtures/PlanTest.cs'), source);
    const compiled = spawnSync(
      path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/target:exe',
        '/main:PlanTest',
        '/r:System.Web.Extensions.dll',
        '/out:' + harness,
        path.resolve(__dirname, '../packaging/windows/Runtime.cs'),
        source,
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const run = () => spawnSync(harness, [root], { windowsHide: true, encoding: 'utf8' });
    assert.equal(run().stdout, '99.9999.9999.0');
    fs.appendFileSync(exe, 'updated');
    fs.appendFileSync(archive, 'updated');
    assert.equal(run().status, 0, 'Official hashes must not act as a whitelist');
    fs.appendFileSync(path.join(root, 'runtime.js'), 'tampered');
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, 'payload-checksum-mismatch');
  },
);

test(
  'CDP launcher verifies embedded payload hashes before executing installed PowerShell',
  { skip: process.platform !== 'win32' },
  (t) => {
    const parent = fs.realpathSync.native(os.tmpdir()),
      root = fs.mkdtempSync(path.join(parent, 'ct-cdp-bootstrap-test-'));
    t.after(() => {
      const target = fs.realpathSync.native(root);
      assert.equal(path.dirname(target), parent);
      assert.ok(path.basename(target).startsWith('ct-cdp-bootstrap-test-'));
      fs.rmSync(target, { recursive: true, force: true });
    });
    const payload = path.join(root, 'payload');
    fs.mkdirSync(payload);
    const manager = fs
      .readFileSync(path.join(__dirname, 'fixtures/BootstrapManager.ps1'), 'utf8')
      .replace(/^\uFEFF/, '');
    fs.writeFileSync(path.join(payload, 'Manage.ps1'), '\ufeff' + manager);
    const manifest = {
      applicationId: 'org.codextoken.cdp',
      payloadFiles: { 'Manage.ps1': hash(path.join(payload, 'Manage.ps1')) },
    };
    fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify(manifest));
    fs.copyFileSync(path.join(payload, 'Manage.ps1'), path.join(root, 'Manage.ps1'));
    fs.copyFileSync(path.join(payload, 'manifest.json'), path.join(root, 'manifest.json'));
    fs.writeFileSync(
      path.join(root, 'package.owner.json'),
      JSON.stringify({ applicationId: 'org.codextoken.cdp', mode: 'cdp-runtime' }),
    );
    const driver = path.join(root, 'driver.ps1');
    fs.copyFileSync(path.join(__dirname, 'fixtures/BootstrapDriver.ps1'), driver);
    const env = {
      ...process.env,
      CT_CDP_BOOT_TEST: root,
      CT_CDP_SETUP_SOURCE: path.resolve(__dirname, '../packaging/windows/Setup.cs'),
    };
    for (const key of Object.keys(env)) if (/^PSModulePath$/i.test(key)) delete env[key];
    const run = () =>
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
        { env, windowsHide: true, encoding: 'utf8' },
      );
    const clean = run();
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'check.json'))).stubExecuted, true);
    const sentinel = path.join(root, 'must-not-exist.txt');
    fs.writeFileSync(
      path.join(root, 'Manage.ps1'),
      `Set-Content -LiteralPath '${sentinel.replace(/'/g, "''")}' -Value 'tampered script executed'`,
    );
    assert.equal(run().status, 1);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'check.json'))).errorCode,
      'setup-bootstrap-or-integrity-failed',
    );
  },
);
