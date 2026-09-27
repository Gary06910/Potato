'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readRegularFileNoFollow } = require('../shared/credentialStore');
const { readRuntime } = require('../shared/notification/codexHookForwarder');

const MAX_LOCK_BYTES = 1024;
const WAIT_MS = 50;
const ENSURE_TIMEOUT_MS = 5000;

function error(code) {
  const value = new Error(code);
  value.code = code;
  return value;
}

function privateJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } catch (cause) {
    fs.closeSync(fd);
    fs.unlinkSync(temporary);
    throw cause;
  }
  fs.closeSync(fd);
  return temporary;
}

function readFile(filePath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const raw = readRegularFileNoFollow(filePath, { maxBytes: MAX_LOCK_BYTES, mode: 0o600 });
      return { raw, value: JSON.parse(raw) };
    } catch (cause) {
      if (cause.code === 'ENOENT') return null;
      if (cause.message?.includes('changed while it was being opened')) continue;
      throw error('invalid_agent_lock');
    }
  }
  throw error('agent_lock_contention');
}

function procStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch (_) { return null; }
}

function isAlive(value) {
  try { process.kill(value.pid, 0); }
  catch (cause) { return cause.code === 'EPERM'; }
  if (value.startTicks) {
    const current = procStartTicks(value.pid);
    if (current && current !== value.startTicks) return false;
  }
  return true;
}

function validOwner(value) {
  return value?.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.nonce === 'string' && /^[a-f0-9]{32}$/.test(value.nonce)
    && (value.startTicks === null || /^[0-9]+$/.test(value.startTicks));
}

function inspectAt(filePath) {
  const file = readFile(filePath);
  if (!file) return { state: 'absent' };
  if (!validOwner(file.value)) throw error('invalid_agent_lock');
  return { state: isAlive(file.value) ? 'live' : 'stale', ...file };
}

function inspect(paths) { return inspectAt(paths.agentLockPath); }

function createExclusive(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = privateJson(filePath, value);
  try { fs.linkSync(temporary, filePath); }
  finally { fs.unlinkSync(temporary); }
}

function releaseOwned(filePath, owner) {
  try {
    const file = readFile(filePath);
    if (file?.value?.nonce === owner.nonce && file.value.pid === owner.pid) fs.unlinkSync(filePath);
  } catch (_) { /* Leave an unexpected replacement untouched. */ }
}

function recoverStale(paths, targetPath = paths.agentLockPath) {
  const reaper = { version: 1, pid: process.pid, nonce: crypto.randomBytes(16).toString('hex'), startTicks: procStartTicks(process.pid) };
  try { createExclusive(paths.agentReaperPath, reaper); }
  catch (cause) {
    if (cause.code === 'EEXIST') throw error('agent_recovery_busy');
    throw cause;
  }
  try {
    const lock = inspectAt(targetPath);
    if (lock.state === 'stale') fs.unlinkSync(targetPath);
  } finally { releaseOwned(paths.agentReaperPath, reaper); }
}

function acquire(paths) {
  const owner = { version: 1, pid: process.pid, nonce: crypto.randomBytes(16).toString('hex'), startTicks: procStartTicks(process.pid) };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { createExclusive(paths.agentLockPath, owner); return owner; }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      const lock = inspect(paths);
      if (lock.state === 'live') throw error('agent_already_running');
      if (lock.state === 'stale') recoverStale(paths);
    }
  }
  throw error('agent_lock_contention');
}

function markReady(paths, owner, notificationStatus) {
  const state = notificationStatus?.state || 'unconfigured';
  const ready = {
    version: 1,
    pid: owner.pid,
    nonce: owner.nonce,
    notificationRequired: state !== 'unconfigured',
    notificationReady: state === 'ready'
  };
  const temporary = privateJson(paths.agentReadyPath, ready);
  try { fs.renameSync(temporary, paths.agentReadyPath); }
  catch (cause) { fs.unlinkSync(temporary); throw cause; }
}

function release(paths, owner) {
  releaseOwned(paths.agentReadyPath, owner);
  releaseOwned(paths.agentLockPath, owner);
}

function health(runtimePath) {
  let runtime;
  try { runtime = readRuntime(runtimePath); }
  catch (_) { return Promise.resolve(false); }
  return new Promise((resolve) => {
    const request = http.request({
      hostname: '127.0.0.1', port: runtime.port, path: '/health', method: 'GET',
      headers: { 'x-token-m-bridge-token': runtime.token }, timeout: 400
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode === 200)); });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function readiness(paths) {
  const lock = inspect(paths);
  if (lock.state !== 'live') return { state: lock.state };
  let marker;
  try { marker = readFile(paths.agentReadyPath)?.value; }
  catch (_) { return { state: 'starting' }; }
  if (!marker || marker.version !== 1 || marker.pid !== lock.value.pid || marker.nonce !== lock.value.nonce) {
    return { state: 'starting' };
  }
  if (marker.notificationRequired && !marker.notificationReady) return { state: 'notification_unavailable' };
  if (marker.notificationRequired && !(await health(paths.notificationRuntimePath))) return { state: 'starting' };
  return { state: 'ready', pid: lock.value.pid, notificationReady: marker.notificationReady };
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function ensure(paths, runArgs = [], options = {}) {
  const initial = await readiness(paths);
  if (initial.state === 'ready') return { ...initial, result: 'already-running' };
  if (initial.state === 'notification_unavailable') throw error('notification_unavailable');
  const deadline = Date.now() + (options.timeoutMs || ENSURE_TIMEOUT_MS);
  let launchOwner = null;
  let launchAttempts = 0;
  let nextLaunchAt = 0;
  try {
    while (Date.now() < deadline) {
      const current = await readiness(paths);
      if (current.state === 'ready') return { ...current, result: 'started' };
      if (current.state === 'notification_unavailable') throw error('notification_unavailable');
      if ((current.state === 'absent' || current.state === 'stale') && !launchOwner) {
        const owner = { version: 1, pid: process.pid, nonce: crypto.randomBytes(16).toString('hex'), startTicks: procStartTicks(process.pid) };
        try { createExclusive(paths.agentLaunchPath, owner); launchOwner = owner; }
        catch (cause) {
          if (cause.code !== 'EEXIST') throw cause;
          const gate = inspectAt(paths.agentLaunchPath);
          if (gate.state === 'stale') {
            try { recoverStale(paths, paths.agentLaunchPath); }
            catch (recoveryError) { if (recoveryError.code !== 'agent_recovery_busy') throw recoveryError; }
          }
        }
      }
      if (launchOwner && current.state === 'stale') {
        try { recoverStale(paths); }
        catch (cause) { if (cause.code !== 'agent_recovery_busy') throw cause; }
      }
      if (launchOwner && inspect(paths).state === 'absent' && launchAttempts < 3 && Date.now() >= nextLaunchAt) {
        const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'run', ...runArgs], {
          detached: true, stdio: 'ignore', windowsHide: true, env: process.env
        });
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', () => reject(error('agent_spawn_failed')));
        });
        child.unref();
        launchAttempts += 1;
        nextLaunchAt = Date.now() + 300;
      }
      await sleep(WAIT_MS);
    }
  } finally {
    if (launchOwner) releaseOwned(paths.agentLaunchPath, launchOwner);
  }
  throw error('agent_start_timeout');
}

module.exports = { acquire, ensure, health, inspect, markReady, readiness, recoverStale, release };
