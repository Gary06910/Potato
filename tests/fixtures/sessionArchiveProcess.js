'use strict';

// These markers precede imports so a native/startup exit can be distinguished
// from a database operation. Requiring the helper in a test sends no messages.
function startupStage(stage) {
  if (require.main === module && process.connected) process.send({ type: 'startup', stage, atMs: Date.now() });
}
startupStage('module-entry');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// The override lets the exact same fixture exercise production modules in an
// actual app.asar under the packaged executable's ELECTRON_RUN_AS_NODE mode.
const moduleRoot = process.env.POTATO_ARCHIVE_TEST_MODULE_ROOT || path.resolve(__dirname, '../..');
const storeModule = require(path.join(moduleRoot, 'src/shared/sessionUsageArchiveStore'));
const legacyModule = require(path.join(moduleRoot, 'src/shared/sessionUsageArchive'));
startupStage('modules-loaded');
const NOW = new Date('2026-10-20T06:00:00.000Z');

function summary(tokens = 100, id = 'one', names = ['today', 'month', 'allTime']) {
  return Object.fromEntries(names.map((name) => [name, {
    sessions: { [`codex:${id}`]: { client: 'codex', sessionId: id, totalTokens: tokens, costUsd: tokens / 100 } }
  }]));
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-concurrency-'));
  const options = { databasePath: path.join(dir, 'archive.sqlite'), path: path.join(dir, 'legacy.json') };
  const children = [];
  t.after(async () => {
    for (const child of children) {
      child.note('parent-cleanup', { aborted: t.signal.aborted });
      if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill();
    }
    await Promise.all(children.map((child) => child.exited));
    for (const child of children) t.diagnostic(JSON.stringify(child.diagnostics()));
    // Retain synthetic databases, sidecars and first failures for forensics.
  });
  return { dir, options, worker(plan = {}, spawnOptions = {}) { const child = spawnWorker({ ...options, ...plan }, { ...spawnOptions, signal: spawnOptions.signal || t.signal }); children.push(child); return child; } };
}

function spawnWorker(plan, options = {}) {
  const spawnAtMs = Date.now();
  const proc = fork(__filename, [JSON.stringify(plan)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    ...(options.execPath ? { execPath: options.execPath } : {})
  });
  const messages = [];
  const timeline = [];
  const pending = new Set();
  let stderr = '';
  let stdout = '';
  let spawnError = null;
  let exit = null;
  let closed = false;
  let disconnected = false;
  const note = (event, fields = {}) => {
    timeline.push({ event, atMs: Date.now(), ...fields });
    if (timeline.length > 64) timeline.shift();
  };
  note('fork-return', { pid: proc.pid, spawnAtMs });
  const kill = proc.kill.bind(proc);
  proc.kill = (signal) => { note('parent-kill-request', { signal: signal || 'SIGTERM' }); return kill(signal); };
  const diagnostics = () => ({
    pid: proc.pid ?? null, spawnAtMs, executable: options.execPath || process.execPath,
    nodeVersion: process.version, execArgv: proc.spawnargs.slice(1, -2),
    connected: proc.connected, disconnected, spawnError, exit, closed, stderr, stdout, timeline,
    messageTypes: messages.map((m) => m.type)
  });
  const fail = (type, reason) => {
    const error = new Error(`archive child ${type} failed (${reason}): ${JSON.stringify(diagnostics())}`);
    error.diagnostics = diagnostics();
    return error;
  };
  const checkPending = () => { for (const check of [...pending]) check(); };
  proc.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8192); });
  proc.stdout.on('data', (data) => { stdout = (stdout + data).slice(-4096); });
  proc.on('spawn', () => note('spawn'));
  proc.on('error', (error) => {
    spawnError = { code: error.code, message: error.message };
    note('error', spawnError);
    checkPending();
  });
  proc.on('message', (message) => {
    messages.push(message);
    if (message.type === 'ready' || message.type === 'startup') note(message.type, { stage: message.stage });
    checkPending();
  });
  proc.on('disconnect', () => { disconnected = true; note('disconnect'); checkPending(); });
  proc.on('exit', (code, signal) => { exit = { code, signal }; note('exit', exit); });
  const exited = new Promise((resolve) => proc.once('close', (code, signal) => {
    exit = { code, signal }; closed = true; note('close', exit); checkPending(); resolve(exit);
  }));
  function wait(type, start = 0) {
    return new Promise((resolve, reject) => {
      const finish = (error, message) => {
        clearTimeout(timer); pending.delete(check); options.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(message);
      };
      const check = () => {
        const message = messages.slice(start).find((value) => value.type === type || value.type === 'fatal');
        if (message?.type === 'fatal') return finish(fail(type, 'fatal'));
        if (message) return finish(null, message);
        if (spawnError || closed) return finish(fail(type, spawnError ? 'spawn-error' : 'closed-before-message'));
        // An exited child is allowed to drain its streams before reporting.
        // A disconnected child cannot send ready; close preserves the real exit
        // code and all stderr. A child that stays alive still hits the deadline.
      };
      const abort = () => { note('test-abort'); finish(fail(type, 'test-abort')); };
      const timer = setTimeout(() => finish(fail(type, 'deadline')), 20_000);
      pending.add(check);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort(); else check();
    });
  }
  return { proc, messages, wait, exited, note, diagnostics, send: (value) => proc.send(value) };
}

function inspect(options) {
  const db = new DatabaseSync(options.databasePath, { readOnly: true });
  try {
    return {
      integrity: Object.values(db.prepare('PRAGMA integrity_check').get())[0],
      journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
      metadata: Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map((r) => [r.key, r.value])),
      rows: db.prepare('SELECT session_key, entry_json, revision FROM sessions ORDER BY session_key').all()
    };
  } finally { db.close(); }
}

function errorInfo(error) {
  return error ? { code: error.code, errcode: error.errcode, errstr: error.errstr, message: error.message, stack: error.stack } : null;
}

function runWorker(plan) {
  startupStage('runtime-init');
  if (plan.lifecycleFault === 'startup-throw') throw new Error('synthetic archive startup exception');
  if (plan.lifecycleFault === 'hold-before-ready') {
    process.once('message', () => runWorker({ ...plan, lifecycleFault: undefined }));
    return;
  }
  if (plan.lifecycleFault === 'exit-before-ready') process.exit(23);
  if (plan.lifecycleFault === 'clean-exit-before-ready') process.exit(0);
  if (plan.lifecycleFault === 'disconnect-before-ready') { process.disconnect(); return; }
  let lock;
  const notify = (message) => process.send(message);
  let migrationPaused = false;
  class ObservedDatabase extends DatabaseSync {
    exec(sql) {
      if (/journal_mode\s*=\s*WAL/i.test(sql)) {
        notify({ type: 'wal', busyTimeout: this.prepare('PRAGMA busy_timeout').get().timeout });
      }
      if (plan.pauseMigration && !migrationPaused && /^COMMIT$/.test(sql.trim())) {
        migrationPaused = true;
        notify({ type: 'migration-staged', synchronous: this.prepare('PRAGMA synchronous').get().synchronous });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
        throw new Error('migration pause deadline');
      }
      return super.exec(sql);
    }
  }
  const store = storeModule.createSessionUsageArchiveStore({ ...plan, DatabaseSync: ObservedDatabase });
  process.on('message', (message) => {
    const started = Date.now();
    try {
      if (message.op === 'hold') {
        lock = new DatabaseSync(plan.databasePath);
        if (message.fresh) lock.exec('CREATE TABLE lock_probe (value INTEGER)');
        lock.exec(message.fresh ? 'BEGIN EXCLUSIVE' : 'BEGIN IMMEDIATE');
        if (message.dirty) {
          lock.exec("UPDATE metadata SET value = '999' WHERE key = 'revision'");
          lock.exec("UPDATE sessions SET entry_json = '{}' ");
        }
        notify({ type: 'held' });
        return;
      }
      if (message.op === 'release') { lock.exec('ROLLBACK'); lock.close(); lock = null; notify({ type: 'released' }); return; }
      if (message.op === 'close') { store.close(); process.disconnect(); return; }
      notify({ type: 'attempting', op: message.op });
      let archive;
      let error = null;
      if (message.op === 'capture') {
        const result = store.capture(message.summary, new Date(message.at || NOW));
        archive = result.archive;
        error = result.error;
      } else if (message.op === 'refresh') archive = store.refresh(undefined, { strict: true });
      else if (message.op === 'snapshot') archive = store.snapshot({ strict: true });
      else archive = store.read(new Date(message.at || NOW));
      notify({ type: 'result', archive, error: errorInfo(error), elapsedMs: Date.now() - started });
    } catch (error) { notify({ type: 'result', error: errorInfo(error), elapsedMs: Date.now() - started }); }
  });
  startupStage('memory-sqlite-query');
  const runtimeDatabase = new DatabaseSync(':memory:');
  const sqlite = runtimeDatabase.prepare('SELECT sqlite_version() AS version').get().version;
  runtimeDatabase.close();
  startupStage('send-ready');
  notify({ type: 'ready', versions: process.versions, platform: process.platform, arch: process.arch, sqlite });
}

async function stop(child) {
  child.send({ op: 'close' });
  assert.deepEqual(await child.exited, { code: 0, signal: null });
}

module.exports = { ...storeModule, ...legacyModule, DatabaseSync, NOW, summary, fixture, inspect, stop };
if (require.main === module) runWorker(JSON.parse(process.argv[2]));
