const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

test(
  'compiled helper retries an unacknowledged batch, backfills a new page session and tails the next append',
  { skip: process.platform !== 'win32', timeout: 20000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-usage-transport-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, 'transport-test.exe');
    const compile = spawnSync(
      path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/codepage:65001',
        '/target:exe',
        '/main:UsageTransportTest',
        '/r:System.Web.Extensions.dll',
        '/out:' + executable,
        path.resolve(__dirname, '../packaging/windows/Runtime.cs'),
        path.resolve(__dirname, '../packaging/windows/UsageLogReader.cs'),
        path.join(__dirname, 'fixtures/UsageTransportTest.cs'),
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const threadId = '11111111-1111-4111-8111-111111111111';
    const folder = path.join(root, 'sessions/2026/10/20');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'rollout-2026-10-20T09-53-01-' + threadId + '.jsonl');
    const counts = (n) => ({
      total_tokens: n * 1100,
      input_tokens: n * 1000,
      output_tokens: n * 100,
      cached_input_tokens: n * 500,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: n * 50,
    });
    const row = (response, n) =>
      JSON.stringify({
        type: 'token_usage_record',
        payload: {
          thread_id: threadId,
          turn_id: 't1',
          response_id: response,
          usage: counts(1),
          turn_token_usage: counts(n),
          thread_token_usage: counts(n),
          text: 'PRIVATE_BODY',
        },
      }) + '\n';
    fs.writeFileSync(file, row('r1', 1));
    const health = { state: 'ready', parserReady: true, mounted: 1, notifications: 0 };
    let firstBatch,
      retried = false,
      replayed = false,
      tailed = false;
    const failures = [];
    const sockets = new Set();
    const server = http.createServer();
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    function frame(value) {
      const bytes = Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
      header[0] = 0x81;
      if (bytes.length < 126) header[1] = bytes.length;
      else {
        header[1] = 126;
        header.writeUInt16BE(bytes.length, 2);
      }
      return Buffer.concat([header, bytes]);
    }
    server.on('upgrade', (request, socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      const accept = crypto
        .createHash('sha1')
        .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n',
      );
      let buffered = Buffer.alloc(0);
      socket.on('data', (bytes) => {
        buffered = Buffer.concat([buffered, bytes]);
        while (buffered.length >= 2) {
          const opcode = buffered[0] & 15,
            masked = !!(buffered[1] & 128);
          let length = buffered[1] & 127,
            offset = 2;
          if (length === 126) {
            if (buffered.length < 4) return;
            length = buffered.readUInt16BE(2);
            offset = 4;
          }
          if (length === 127) {
            if (buffered.length < 10) return;
            length = Number(buffered.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffered.length < offset + (masked ? 4 : 0) + length) return;
          const mask = masked ? buffered.subarray(offset, offset + 4) : null;
          offset += masked ? 4 : 0;
          const payload = Buffer.from(buffered.subarray(offset, offset + length));
          if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          buffered = buffered.subarray(offset + length);
          if (opcode !== 1) continue;
          const command = JSON.parse(payload);
          let result = {},
            error;
          try {
            if (command.method === 'Page.addScriptToEvaluateOnNewDocument')
              result = { identifier: 'test-script' };
            if (command.method === 'Runtime.evaluate') {
              const expression = command.params.expression;
              if (expression.includes('exchangeLocalUsage(')) {
                const envelope = JSON.parse(
                  expression.slice(expression.indexOf('exchangeLocalUsage(') + 19, -9),
                );
                assert.doesNotMatch(JSON.stringify(envelope), /PRIVATE_|text|credentials/);
                let session = retried ? 'page-two' : 'page-one',
                  ack = null;
                if (envelope.session === 'page-one' && envelope.records.length) {
                  if (!firstBatch) {
                    firstBatch = JSON.stringify(envelope);
                    error = { code: -32000, message: 'Execution context was destroyed' };
                  } else {
                    assert.equal(
                      JSON.stringify(envelope),
                      firstBatch,
                      'lost ACK must not advance the file cursor',
                    );
                    retried = true;
                    session = 'page-two';
                  }
                } else if (envelope.session === 'page-two') {
                  ack = envelope.batchId;
                  if (envelope.records.some((record) => record.responseId === 'r1')) {
                    assert.ok(envelope.records[0].replay);
                    replayed = true;
                    fs.appendFileSync(file, row('r2', 2));
                  }
                  if (envelope.records.some((record) => record.responseId === 'r2')) {
                    assert.equal(envelope.records.length, 1);
                    assert.equal(envelope.records[0].replay, false);
                    tailed = true;
                    setTimeout(() => socket.destroy(), 30);
                  }
                }
                result = {
                  result: {
                    type: 'object',
                    value: { health, session, ack, targets: [{ threadId, revision: 0 }] },
                  },
                };
              } else result = { result: { type: 'object', value: health } };
            }
          } catch (failure) {
            failures.push(failure);
            socket.destroy();
            return;
          }
          socket.write(frame({ id: command.id, ...(error ? { error } : { result }) }));
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const child = spawn(
      executable,
      [`ws://127.0.0.1:${server.address().port}/devtools/page/test`, root],
      { windowsHide: true },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let output = '';
    child.stderr.on('data', (bytes) => {
      output += bytes;
    });
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Synthetic CDP transport timed out: ' + output));
      }, 12000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(failures.length, 0, failures[0]?.stack);
    assert.equal(exit, 0, output);
    assert.ok(retried && replayed && tailed);
    const report = fs.readFileSync(path.join(root, 'report.json'), 'utf8');
    assert.doesNotMatch(report, /PRIVATE_|threadId|responseId/);
  },
);
