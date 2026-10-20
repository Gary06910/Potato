'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  NOW, summary, fixture, inspect, stop, createSessionUsageArchiveStore,
  readSessionUsageArchiveSnapshot, captureSessionUsageArchive, writeSessionUsageArchive
} = require('../fixtures/sessionArchiveProcess');

// Fixed experiment counts: every result is retained, including the first failure.
for (const count of [3, 8]) {
  for (const legacy of [false, true]) {
    for (let round = 1; round <= 3; round += 1) {
      test(`${legacy ? 'legacy migration' : 'cold database'}: ${count} process barrier round ${round}`, async (t) => {
        const f = fixture(t);
        if (legacy) {
          let archive = captureSessionUsageArchive({}, summary(), NOW);
          archive = captureSessionUsageArchive(archive, summary(200, 'two'), NOW);
          writeSessionUsageArchive(archive, f.options);
        }
        const children = Array.from({ length: count }, () => f.worker());
        const runtime = await Promise.all(children.map((child) => child.wait('ready')));
        // All independent processes have loaded the module but none has opened
        // the file. One coordinator releases the synchronous first reads.
        children.forEach((child) => child.send({ op: 'read' }));
        const results = await Promise.all(children.map((child) => child.wait('result')));
        await Promise.all(children.map(stop));
        t.diagnostic(JSON.stringify({ dir: f.dir, runtime: runtime[0], results }));
        const state = inspect(f.options);
        t.diagnostic(JSON.stringify({ state }));
        assert.deepEqual(results.map((r) => r.error), Array(count).fill(null));
        assert.equal(state.integrity, 'ok');
        assert.equal(state.journal, 'wal');
        assert.equal(state.metadata['schema-version'], '1');
        assert.equal(state.metadata['legacy-migrated'], '1');
        assert.equal(state.metadata.revision, legacy ? '1' : '0');
        assert.equal(state.rows.length, legacy ? 2 : 0);
        for (const result of results) assert.deepEqual(result.archive, results[0].archive);
        if (legacy) {
          assert.equal(results[0].archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
          assert.equal(results[0].archive.sessions['codex:two'].periods.allTime.totalTokens, 200);
          assert.equal(fs.existsSync(f.options.path), false);
        }
      });
    }
  }
}

test('a controlled rollback lock waits before WAL and succeeds after release', async (t) => {
  const f = fixture(t);
  const holder = f.worker();
  const reader = f.worker();
  await Promise.all([holder.wait('ready'), reader.wait('ready')]);
  holder.send({ op: 'hold', fresh: true });
  await holder.wait('held');
  reader.send({ op: 'read' });
  const wal = await reader.wait('wal');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const completedWhileLocked = reader.messages.some((m) => m.type === 'result');
  holder.send({ op: 'release' });
  await holder.wait('released');
  const result = await reader.wait('result');
  t.diagnostic(JSON.stringify({ wal, completedWhileLocked, result, dir: f.dir }));
  assert.equal(completedWhileLocked, false);
  assert.ok(wal.busyTimeout > 0 && wal.busyTimeout <= 5000);
  assert.equal(result.error, null);
  assert.ok(result.elapsedMs >= 150);
  await Promise.all([stop(holder), stop(reader)]);
  assert.equal(inspect(f.options).integrity, 'ok');
});

test('a controlled lock expires finitely, preserves legacy, and the same store retries', async (t) => {
  const f = fixture(t);
  writeSessionUsageArchive(captureSessionUsageArchive({}, summary(), NOW), f.options);
  const original = fs.readFileSync(f.options.path);
  const holder = f.worker();
  const reader = f.worker();
  await Promise.all([holder.wait('ready'), reader.wait('ready')]);
  holder.send({ op: 'hold', fresh: true });
  await holder.wait('held');
  reader.send({ op: 'read' });
  const failed = await reader.wait('result');
  t.diagnostic(JSON.stringify({ failed, dir: f.dir }));
  assert.equal(failed.error.errcode, 5);
  assert.match(failed.error.message, /locked|busy/i);
  assert.ok(failed.elapsedMs >= 4500 && failed.elapsedMs < 15_000, JSON.stringify(failed));
  assert.equal(failed.archive, undefined, 'read failure is never an empty success');
  assert.deepEqual(fs.readFileSync(f.options.path), original);
  assert.throws(() => readSessionUsageArchiveSnapshot({ ...f.options, strict: true }), /locked|busy/i);
  holder.send({ op: 'release' });
  await holder.wait('released');
  // A partially initialized SQLite file is refused by strict snapshots; the
  // unchanged legacy bytes remain available until the writer retries.
  assert.throws(() => readSessionUsageArchiveSnapshot({ ...f.options, strict: true }), /no such table|not ready/);
  const start = reader.messages.length;
  reader.send({ op: 'read' });
  const recovered = await reader.wait('result', start);
  assert.equal(recovered.error, null);
  assert.equal(recovered.archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
  await Promise.all([stop(holder), stop(reader)]);
  assert.equal(inspect(f.options).integrity, 'ok');
});

test('existing WAL supports readers, serialized revisions, stale writer and crash recovery', async (t) => {
  const f = fixture(t);
  const seed = createSessionUsageArchiveStore(f.options);
  assert.equal(seed.capture(summary(), NOW).error, null);
  seed.close();
  const stale = f.worker();
  const writer = f.worker();
  const holder = f.worker();
  await Promise.all([stale.wait('ready'), writer.wait('ready'), holder.wait('ready')]);
  stale.send({ op: 'read' });
  assert.equal((await stale.wait('result')).error, null);
  writer.send({ op: 'capture', summary: summary(150, 'one', ['month']), at: '2026-10-20T06:01:00Z' });
  assert.equal((await writer.wait('result')).error, null);
  let start = stale.messages.length;
  stale.send({ op: 'capture', summary: summary(0, 'one', ['today']), at: '2026-10-20T06:02:00Z' });
  const merged = await stale.wait('result', start);
  assert.equal(merged.error, null);
  assert.equal(merged.archive.sessions['codex:one'].periods.today.totalTokens, 0);
  assert.equal(merged.archive.sessions['codex:one'].periods.month.totalTokens, 150);
  assert.equal(merged.archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
  holder.send({ op: 'hold', dirty: true });
  await holder.wait('held');
  const before = readSessionUsageArchiveSnapshot({ ...f.options, strict: true });
  assert.equal(before.sessions['codex:one'].periods.month.totalTokens, 150);
  start = writer.messages.length;
  writer.send({ op: 'capture', summary: summary(50, 'two'), at: '2026-10-20T06:03:00Z' });
  await writer.wait('attempting', start);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(writer.messages.slice(start).some((m) => m.type === 'result'), false);
  holder.proc.kill(); // Only the fixture's own process, with an uncommitted WAL.
  await holder.exited;
  const recovered = await writer.wait('result', start);
  assert.equal(recovered.error, null);
  start = stale.messages.length;
  stale.send({ op: 'refresh' });
  const refreshed = await stale.wait('result', start);
  assert.equal(refreshed.error, null);
  assert.equal(refreshed.archive.sessions['codex:two'].periods.allTime.totalTokens, 50);
  await Promise.all([stop(writer), stop(stale)]);
  const state = inspect(f.options);
  t.diagnostic(JSON.stringify({ state, dir: f.dir }));
  assert.equal(state.metadata.revision, '4');
  assert.equal(state.integrity, 'ok');
  const reopened = createSessionUsageArchiveStore(f.options);
  try {
    const pruned = reopened.read(new Date('2026-12-01T06:00:00Z'));
    assert.equal(pruned.sessions['codex:one'].periods.today, undefined);
    assert.equal(pruned.sessions['codex:one'].periods.allTime.totalTokens, 100);
  } finally { reopened.close(); }
});


test('a killed migration rolls back its marker and rows before another process takes over', async (t) => {
  const f = fixture(t);
  writeSessionUsageArchive(captureSessionUsageArchive({}, summary(), NOW), f.options);
  const original = fs.readFileSync(f.options.path);
  const migrator = f.worker({ pauseMigration: true });
  const follower = f.worker();
  await Promise.all([migrator.wait('ready'), follower.wait('ready')]);
  migrator.send({ op: 'read' });
  assert.equal((await migrator.wait('migration-staged')).synchronous, 2, 'migration uses FULL durability');
  assert.deepEqual(fs.readFileSync(f.options.path), original);
  const during = readSessionUsageArchiveSnapshot({ ...f.options, strict: true });
  assert.equal(during.sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.notEqual(inspect(f.options).metadata['legacy-migrated'], '1');
  follower.send({ op: 'read' });
  await follower.wait('attempting');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(follower.messages.some((m) => m.type === 'result'), false);
  migrator.proc.kill();
  await migrator.exited;
  const result = await follower.wait('result');
  assert.equal(result.error, null);
  assert.equal(result.archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
  await stop(follower);
  const state = inspect(f.options);
  assert.equal(state.metadata['legacy-migrated'], '1');
  assert.equal(state.metadata.revision, '1');
  assert.equal(state.rows.length, 1);
  assert.equal(state.integrity, 'ok');
  assert.equal(fs.existsSync(f.options.path), false);
});

test('a WAL writer timeout returns its trusted archive and recovers without publishing zero', async (t) => {
  const f = fixture(t);
  const seed = createSessionUsageArchiveStore(f.options);
  assert.equal(seed.capture(summary(), NOW).error, null);
  seed.close();
  const writer = f.worker();
  const holder = f.worker();
  await Promise.all([writer.wait('ready'), holder.wait('ready')]);
  writer.send({ op: 'read' });
  assert.equal((await writer.wait('result')).archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
  holder.send({ op: 'hold' });
  await holder.wait('held');
  let start = writer.messages.length;
  writer.send({ op: 'capture', summary: summary(999), at: '2026-10-20T06:01:00Z' });
  const failed = await writer.wait('result', start);
  t.diagnostic(JSON.stringify({ failed, dir: f.dir }));
  assert.equal(failed.error.errcode, 5);
  assert.ok(failed.elapsedMs >= 4500 && failed.elapsedMs < 15000);
  assert.equal(failed.archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(readSessionUsageArchiveSnapshot({ ...f.options, strict: true }).sessions['codex:one'].periods.allTime.totalTokens, 100);
  holder.send({ op: 'release' });
  await holder.wait('released');
  start = writer.messages.length;
  writer.send({ op: 'capture', summary: summary(150), at: '2026-10-20T06:02:00Z' });
  const recovered = await writer.wait('result', start);
  assert.equal(recovered.error, null);
  assert.equal(recovered.archive.sessions['codex:one'].periods.allTime.totalTokens, 150);
  await Promise.all([stop(holder), stop(writer)]);
  assert.equal(inspect(f.options).metadata.revision, '2');
  assert.equal(inspect(f.options).integrity, 'ok');
});
