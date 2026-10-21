'use strict';

const http = require('node:http');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { createCodexHookBridge } = require('../../src/shared/notification/codexHookBridge');

function safeText(value) {
  return String(value || '').replace(/[A-Za-z]:[\\/][^\s]*/g, '[path]')
    .replace(/(?:tm_uc_d1\.|Bearer\s+)\S+/g, '[secret]').slice(0, 240);
}

function socketInfo(socket) {
  if (!socket) return null;
  const safeAddress = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value) ? value : null;
  return { localAddress: safeAddress(socket.localAddress), localPort: socket.localPort ?? null,
    remoteAddress: safeAddress(socket.remoteAddress), remotePort: socket.remotePort ?? null,
    destroyed: socket.destroyed ?? null };
}

function errorInfo(error) {
  const cause = error?.cause;
  return { name: safeText(error?.name), message: safeText(error?.message),
    cause: { code: safeText(cause?.code) || null, errno: cause?.errno ?? null,
      syscall: safeText(cause?.syscall) || null, name: safeText(cause?.name),
      message: safeText(cause?.message), socket: socketInfo(cause?.socket) } };
}

// Test-only observation: no retry, delay, body/header logging, or production edits.
function createLoopbackDiagnostics(t) {
  const origin = performance.now();
  const timeline = [];
  let server = null;
  const snapshot = () => {
    const address = server?.address();
    return { listening: server?.listening ?? false,
      address: address && typeof address === 'object'
        ? { address: address.address, family: address.family, port: address.port } : null };
  };
  const note = (stage, fields = {}) => {
    timeline.push({ stage, relativeMs: Number((performance.now() - origin).toFixed(3)), ...fields });
  };
  note('test-start', { node: process.version,
    runnerArgs: process.execArgv.filter(a => /^--test(?:-|$)/.test(a)),
    runnerConcurrency: process.env.POTATO_TEST_CONCURRENCY || 'default',
    defaultConcurrency: Math.max(os.availableParallelism() - 1, 1),
    proxyVariablesPresent: Object.keys(process.env).filter(k => /^(?:https?|all)_proxy$/i.test(k) && process.env[k]),
    nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY === '1' });
  function observe(active) {
    server = active;
    active.on('listening', () => note('bridge-listen-complete', snapshot()));
    active.on('close', () => note('server-close', snapshot()));
    active.on('error', error => note('server-error', { ...snapshot(), error: errorInfo(error) }));
    active.on('connection', socket => {
      const connected = socketInfo(socket);
      note('server-connection', { socket: connected, ...snapshot() });
      socket.on('error', error => note('socket-error', { socket: connected, error: errorInfo(error) }));
      socket.on('close', hadError => note('socket-close', { socket: connected, hadError }));
    });
    if (active.listening) note('observed-already-listening', snapshot());
  }
  function bridgeFactory(options) {
    const bridge = createCodexHookBridge(options);
    return {
      address: () => bridge.address(),
      start() {
        // start() synchronously constructs the HTTP server. Restore immediately,
        // before awaiting listen; the real server and all arguments are retained.
        const create = http.createServer;
        http.createServer = function(...args) { const active = create.apply(this, args); observe(active); return active; };
        try { return bridge.start().then(address => { note('bridge-start-complete', { ...snapshot(), address }); return address; }); }
        finally { http.createServer = create; }
      },
      async stop() { note('bridge-stop-start', snapshot()); await bridge.stop(); note('bridge-stop-complete', snapshot()); }
    };
  }
  async function request(stage, url, options, fetchImpl = globalThis.fetch) {
    const endpoint = new URL(url);
    if (endpoint.hostname !== '127.0.0.1') throw new Error('Diagnostic requests require IPv4 loopback');
    note('request-start', { request: stage, host: endpoint.hostname, port: Number(endpoint.port),
      signalPresent: Boolean(options?.signal), signalAborted: options?.signal?.aborted ?? false, ...snapshot() });
    try {
      const response = await fetchImpl(url, options);
      note('request-complete', { request: stage, status: response.status, ...snapshot() });
      return response;
    } catch (error) {
      const failure = { request: stage, error: errorInfo(error),
        signalPresent: Boolean(options?.signal), signalAborted: options?.signal?.aborted ?? false, ...snapshot() };
      note('request-error', failure);
      // Include the phase/cause even when TAP omits the original error stack.
      const wrapped = new Error('Loopback request failed: ' + JSON.stringify(failure));
      wrapped.diagnostics = failure;
      throw wrapped;
    }
  }
  return { note, observe, bridgeFactory, request, snapshot, timeline,
    finish() { t.diagnostic(JSON.stringify({ loopbackTimeline: timeline })); } };
}

module.exports = { createLoopbackDiagnostics };
