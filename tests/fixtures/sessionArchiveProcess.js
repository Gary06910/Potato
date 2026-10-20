'use strict';

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
      if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill();
    }
    await Promise.all(children.map((child) => child.exited));
    // Retain synthetic databases, sidecars and first failures for forensics.
  });
  return { dir, options, worker(plan = {}) { const child = spawnWorker({ ...options, ...plan }); children.push(child); return child; } };
}

function spawnWorker(plan) {
  const proc = fork(__filename, [JSON.stringify(plan)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const messages = [];
  let stderr = '';
  proc.stderr.on('data', (data) => { stderr += data; });
  proc.stdout.resume();
  proc.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  async function wait(type, start = 0) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const message = messages.slice(start).find((value) => value.type === type || value.type === 'fatal');
      if (message?.type === 'fatal') throw new Error(JSON.stringify(message));
      if (message) return message;
      if (proc.exitCode !== null || proc.signalCode !== null || Date.now() > deadline) {
        throw new Error(`archive child ${type} failed: ${stderr} ${JSON.stringify(messages)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { proc, messages, wait, exited, send: (value) => proc.send(value) };
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
  const runtimeDatabase = new DatabaseSync(':memory:');
  const sqlite = runtimeDatabase.prepare('SELECT sqlite_version() AS version').get().version;
  runtimeDatabase.close();
  notify({ type: 'ready', versions: process.versions, platform: process.platform, arch: process.arch, sqlite });
}

async function stop(child) {
  child.send({ op: 'close' });
  assert.deepEqual(await child.exited, { code: 0, signal: null });
}

module.exports = { ...storeModule, ...legacyModule, DatabaseSync, NOW, summary, fixture, inspect, stop };
if (require.main === module) runWorker(JSON.parse(process.argv[2]));
