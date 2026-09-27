'use strict';

const http = require('node:http');
const { readRegularFileNoFollow } = require('../credentialStore');

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_RUNTIME_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;

function finishSuccess() {
  try { process.stdout.write('{}\n'); } catch (_) {}
}

function failure(stage, code, cause, detail = null) {
  const error = new Error(code, { cause });
  error.stage = stage;
  error.code = code;
  error.detail = detail;
  return error;
}

function safeCode(value, fallback = 'unknown_error') {
  const candidate = String(value || fallback);
  return /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : fallback;
}

function reportFailure(error) {
  const fields = [
    'stage=' + safeCode(error?.stage, 'unknown'),
    'code=' + safeCode(error?.code, error?.name || 'unknown_error')
  ];
  if (Number.isInteger(error?.status)) fields.push(`status=${error.status}`);
  if (error?.detail) fields.push(`detail=${safeCode(error.detail)}`);
  if (Array.isArray(error?.inputKeys) && error.inputKeys.length > 0) {
    fields.push(`input_fields=${error.inputKeys.join(',')}`);
  }
  try { process.stderr.write(`[token-m-hook] ${fields.join(' ')}\n`); } catch (_) {}
}

function readBoundedStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    process.stdin.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        rejected = true;
        reject(new Error('stdin_too_large'));
      } else chunks.push(chunk);
    });
    process.stdin.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    process.stdin.on('error', reject);
  });
}

function readRuntime(filePath) {
  const value = JSON.parse(readRegularFileNoFollow(filePath, {
    description: 'Potato notification runtime',
    encoding: 'utf8',
    maxBytes: MAX_RUNTIME_BYTES,
    mode: 0o600
  }));
  if (value?.version !== 1 || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('invalid_runtime');
  }
  if (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error('invalid_runtime');
  return value;
}

function post(runtime, body, options = {}) {
  return new Promise((resolve, reject) => {
    const profileId = options.profileId;
    const request = http.request({
      host: runtime.host,
      port: runtime.port,
      path: '/codex/stop',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-token-m-bridge-token': runtime.token,
        ...(profileId === undefined ? {} : { 'x-to-know-profile-id': String(profileId) })
      },
      timeout: 1_500
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      response.on('end', () => {
        if (size > MAX_RESPONSE_BYTES) {
          reject(failure('response-read', 'response_too_large'));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }
        let detail = null;
        try { detail = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error; } catch (_) {}
        const error = failure('request', `http_${response.statusCode}`, null, detail);
        error.status = response.statusCode;
        reject(error);
      });
    });
    request.on('timeout', () => request.destroy(failure('request', 'ETIMEDOUT')));
    request.on('error', (error) => {
      if (error?.stage) reject(error);
      else reject(failure('request', safeCode(error?.code, 'connection_failure'), error));
    });
    request.end(body);
  });
}

async function run(options = {}) {
  const runtimePath = options.runtimePath || process.argv[2];
  const profileId = options.profileId === undefined ? process.argv[3] : options.profileId;
  if (!runtimePath) throw failure('arguments', 'missing_runtime_path');
  let body;
  try { body = await readBoundedStdin(); }
  catch (error) { throw failure('stdin-read', safeCode(error?.code, error?.message), error); }
  let input;
  try { input = JSON.parse(body.toString('utf8')); }
  catch (error) { throw failure('stdin-parse', 'json_parse_failure', error); }
  const inputKeys = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input).filter((key) => /^[A-Za-z0-9_.-]{1,80}$/.test(key)).sort().slice(0, 32)
    : [];
  try {
    const runtime = readRuntime(runtimePath);
    await post(runtime, body, { profileId });
  } catch (error) {
    const wrapped = error?.stage
      ? error
      : failure('runtime-read', safeCode(error?.code, error?.message === 'invalid_runtime' ? 'invalid_runtime' : error?.name), error);
    wrapped.inputKeys = inputKeys;
    throw wrapped;
  }
}

function runCli(options = {}) {
  run(options).then(finishSuccess, (error) => {
    reportFailure(error);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_STDIN_BYTES,
  post,
  readRuntime,
  reportFailure,
  run,
  runCli
};
