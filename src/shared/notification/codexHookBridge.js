'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const MAX_BODY_BYTES = 64 * 1024;

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function createCodexHookBridge({ host = '127.0.0.1', port = 0, token, onCompletion, logger = {} }) {
  if (host !== '127.0.0.1') throw new TypeError('Codex hook bridge must bind to 127.0.0.1');
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('Bridge token must be at least 32 characters');
  if (typeof onCompletion !== 'function') throw new TypeError('onCompletion is required');
  let server = null;

  function respond(response, status, body) {
    const payload = `${JSON.stringify(body)}\n`;
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload)
    });
    response.end(payload);
  }

  function handler(request, response) {
    const supplied = request.headers['x-token-m-bridge-token']
      || String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const profileId = headerValue(request.headers['x-to-know-profile-id']);
    if (request.method === 'GET' && request.url === '/health') {
      request.resume();
      if (!tokenMatches(supplied, token)) respond(response, 401, { error: 'unauthorized' });
      else respond(response, 200, { ready: true });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/codex/stop') {
      request.resume();
      respond(response, 404, { error: 'not_found' });
      return;
    }
    if (!tokenMatches(supplied, token)) {
      request.resume();
      respond(response, 401, { error: 'unauthorized' });
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        respond(response, 413, { error: 'body_too_large' });
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', async () => {
      if (rejected) return;
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await onCompletion(input, profileId ? { profileId } : {});
        respond(response, 200, {});
      } catch (error) {
        logger.warn?.('Codex hook bridge rejected input', { code: error?.code || 'invalid_input' });
        respond(response, 400, { error: 'invalid_hook_input' });
      }
    });
  }

  return {
    start() {
      if (server) return Promise.resolve(this.address());
      server = http.createServer(handler);
      server.requestTimeout = 5_000;
      server.headersTimeout = 5_000;
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(this.address());
        });
      });
    },
    stop() {
      if (!server) return Promise.resolve();
      const active = server;
      server = null;
      return new Promise((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    },
    address() {
      const value = server?.address();
      return value && typeof value === 'object' ? { host, port: value.port } : null;
    }
  };
}

module.exports = { createCodexHookBridge };
