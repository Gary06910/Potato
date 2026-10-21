'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { once } = require('node:events');
const { createLoopbackDiagnostics } = require('../helpers/loopbackDiagnostics');

async function listen(t, diagnostics, handler) {
  const server = http.createServer(handler);
  diagnostics.observe(server);
  t.after(async () => {
    diagnostics.note('cleanup-start');
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    diagnostics.finish();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test('loopback diagnostics distinguish a closed port before bridge start', async t => {
  const d = createLoopbackDiagnostics(t);
  const { server, url } = await listen(t, d, (_req, res) => res.end());
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(d.request('before-bridge-start', url), error => {
    assert.equal(error.diagnostics.request, 'before-bridge-start');
    assert.equal(error.diagnostics.error.cause.code, 'ECONNREFUSED');
    assert.equal(error.diagnostics.listening, false);
    return true;
  });
});

test('loopback diagnostics distinguish a server closed before the next request', async t => {
  const d = createLoopbackDiagnostics(t);
  const { server, url } = await listen(t, d, (_req, res) => res.end());
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(d.request('after-server-close', url), error => {
    assert.equal(error.diagnostics.error.cause.code, 'ECONNREFUSED');
    assert.ok(d.timeline.some(e => e.stage === 'server-close'));
    return true;
  });
});

test('loopback diagnostics preserve socket reset cause with a live server', async t => {
  const d = createLoopbackDiagnostics(t);
  const { url } = await listen(t, d, req => req.socket.resetAndDestroy());
  await assert.rejects(d.request('socket-reset', url, { method: 'POST', body: 'synthetic' }), error => {
    assert.ok(['ECONNRESET', 'UND_ERR_SOCKET'].includes(error.diagnostics.error.cause.code));
    assert.equal(error.diagnostics.listening, true);
    return true;
  });
});

test('loopback diagnostics preserve in-flight request abort and signal state', async t => {
  const d = createLoopbackDiagnostics(t);
  const controller = new AbortController();
  const { url } = await listen(t, d, () => controller.abort());
  await assert.rejects(d.request('request-abort', url, { signal: controller.signal }), error => {
    assert.equal(error.diagnostics.error.name, 'AbortError');
    assert.equal(error.diagnostics.error.cause.code, null);
    assert.equal(error.diagnostics.listening, true);
    return true;
  });
  assert.equal(controller.signal.aborted, true);
});

test('loopback diagnostics identify Fetch bad-port policy before opening a socket', async t => {
  const d = createLoopbackDiagnostics(t);
  t.after(() => d.finish());
  // Fetch rejects this port before connect. No fixed-port listener is needed,
  // avoiding contention with parallel tests or services on the host.
  await assert.rejects(d.request('fetch-blocked-port', 'http://127.0.0.1:1723/codex/stop',
    { method: 'POST', body: '{}' }), error => {
    assert.equal(error.diagnostics.error.name, 'TypeError');
    assert.equal(error.diagnostics.error.cause.message, 'bad port');
    assert.equal(error.diagnostics.error.cause.code, null);
    return true;
  });
});
