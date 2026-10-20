const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test(
  'Windows incremental reader handles append, UTF-8 fragments, replay, replacement and bounded metadata transport',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-usage-reader-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, 'reader-test.exe');
    const compile = spawnSync(
      path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/codepage:65001',
        '/target:exe',
        '/r:System.Web.Extensions.dll',
        '/out:' + executable,
        path.resolve(__dirname, '../packaging/windows/UsageLogReader.cs'),
        path.join(__dirname, 'fixtures/UsageLogReaderTest.cs'),
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const run = spawnSync(executable, [path.join(root, 'synthetic-codex-home')], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /PRIVATE_|credentials|synthetic-codex-home/);
    const result = JSON.parse(run.stdout);
    assert.ok(result.passed && result.assertions > 300);
    // 将 C# 实际产出的白名单交给真正的 JS 采集器，防止两端字段漂移。
    const { createAppServerUsageCollector } = await import('../src/host/app-server-usage.mjs');
    const collector = createAppServerUsageCollector();
    collector.observeLocalIdentities([
      {
        hostId: 'local',
        threadId: result.sample.threadId,
        turnId: result.sample.turnId,
        running: true,
      },
    ]);
    collector.ingestLocalRecords([result.sample]);
    assert.equal(collector.getActive()[0].source.requestCount, 1);
    assert.equal(collector.getActive()[0].usage.total.totalTokens, 1100);
  },
);
