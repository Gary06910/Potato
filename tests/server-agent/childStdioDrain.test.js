'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectChildOutput } = require('../helpers/collectChildOutput');
const { createAgentCleanup } = require('../helpers/serverAgentFixture');
const { createServerAgentPaths } = require('../../src/server-agent/paths');

function fakeStream() {
  const stream = new EventEmitter();
  stream.closed = false; stream.destroyed = false;
  stream.destroy = () => { stream.destroyed = true; stream.closed = true; };
  return stream;
}
function fixture() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 1234, exitCode: null, signalCode: null,
    stdout: fakeStream(), stderr: fakeStream(), stdin: fakeStream() });
  const kills = [], timers = new Set();
  let callback, clock = 0, clears = 0, budget;
  child.kill = signal => { kills.push(signal); return true; };
  const deps = {
    now: () => clock,
    setTimeout(fn, ms) { callback = fn; budget = ms; const token = {}; timers.add(token); return token; },
    clearTimeout(token) { clears++; timers.delete(token); }
  };
  const result = collectChildOutput(child, 9000, deps);
  let settlements = 0;
  // Attach rejection immediately; tests never create an unhandled rejected branch.
  const observed = result.then(value => { settlements++; return { value }; }, error => { settlements++; return { error }; });
  const exit = (code = 0, signal = null) => {
    child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
  };
  const close = (code = child.exitCode, signal = child.signalCode) => {
    child.stdout.closed = true; child.stderr.closed = true; child.stdin.closed = true;
    child.emit('close', code, signal);
  };
  return { child, result, observed, kills, timers, exit, close,
    fire() { clock = 9000; callback(); },
    get settlements() { return settlements; }, get clears() { return clears; }, get budget() { return budget; } };
}
function disposed(f) {
  assert.equal(f.timers.size, 0); assert.equal(f.clears, 1);
  for (const event of ['exit', 'spawn', 'error', 'close']) assert.equal(f.child.listenerCount(event), 0);
  for (const stream of [f.child.stdout, f.child.stderr, f.child.stdin]) {
    assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('error'), 0);
  }
}

for (const stream of ['stdout', 'stderr']) {
  test(`exit(0) then late ${stream} READY then close(0) retains all data`, async () => {
    const f = fixture(); f.exit();
    await Promise.resolve(); assert.equal(f.settlements, 0); assert.equal(f.timers.size, 1);
    f.child[stream].emit('data', Buffer.from('READY'));
    await Promise.resolve(); assert.equal(f.settlements, 0);
    f.close(); const result = await f.result;
    assert.equal(result[stream], 'READY'); assert.equal(result.code, 0);
    assert.equal(result.signal, null); assert.equal(result.outputComplete, true);
    assert.deepEqual(f.kills, []); disposed(f);
  });
}

test('multiple stdout/stderr chunks and split UTF-8 bytes survive exit and drain', async () => {
  const f = fixture(); const bytes = Buffer.from('READY 土豆\n');
  f.child.stdout.emit('data', bytes.subarray(0, 7)); f.child.stderr.emit('data', 'first:');
  f.exit(); f.child.stdout.emit('data', bytes.subarray(7, 9));
  f.child.stderr.emit('data', 'last'); f.child.stdout.emit('data', bytes.subarray(9)); f.close();
  const value = await f.result;
  assert.equal(value.stdout, bytes.toString('utf8')); assert.equal(value.stderr, 'first:last'); disposed(f);
});

test('exit with an open output pipe remains pending until child close', async () => {
  const f = fixture(); f.exit(); f.child.stdout.closed = true;
  f.child.stderr.emit('data', 'pipe still open');
  await Promise.resolve(); assert.equal(f.settlements, 0); assert.equal(f.child.stderr.closed, false);
  f.close(); assert.equal((await f.result).stderr, 'pipe still open'); disposed(f);
});

for (const code of [0, 7, 23]) {
  test(`close preserves exit code ${code} without converting failure status`, async () => {
    const f = fixture(); f.exit(code); f.child.stderr.emit('data', 'diagnostic'); f.close();
    assert.equal((await f.result).code, code); assert.equal((await f.result).stderr, 'diagnostic'); disposed(f);
  });
}
for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`close preserves ${signal} and null exit code`, async () => {
    const f = fixture(); f.exit(null, signal); f.child.stderr.emit('data', 'terminated'); f.close();
    const result = await f.result; assert.equal(result.code, null); assert.equal(result.signal, signal);
    assert.equal(result.stderr, 'terminated'); assert.deepEqual(f.kills, []); disposed(f);
  });
}

test('spawn error without exit rejects once; later close preserves the failure', async () => {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, stdout: fakeStream(), stderr: fakeStream(), stdin: fakeStream() });
  child.kill = () => assert.fail('spawn error must not signal');
  let clears = 0;
  const result = collectChildOutput(child, 9000, { setTimeout: () => ({}), clearTimeout: () => { clears++; } });
  const failed = assert.rejects(result, error => {
    assert.equal(error.code, 'CLI_SPAWN_ERROR'); assert.equal(error.cause.code, 'ENOENT');
    assert.equal(error.diagnostics.closed, false); assert.equal(error.diagnostics.close.code, -2); return true;
  });
  child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
  child.emit('close', -2, null); await failed; assert.equal(clears, 1);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  assert.equal(child.listenerCount('error'), 0);
});

test('runtime error plus close rejects once and clears the timer once', async () => {
  const f = fixture(); f.child.stdout.emit('data', 'partial');
  f.child.emit('error', Object.assign(new Error('runtime failure'), { code: 'EIO' }));
  f.child.emit('error', new Error('second error'));
  f.exit(1); f.close(); const { error } = await f.observed;
  assert.equal(error.code, 'CLI_CHILD_ERROR'); assert.equal(error.cause.code, 'EIO');
  assert.equal(error.diagnostics.stdout, 'partial'); assert.equal(error.diagnostics.close.code, 1);
  assert.equal(f.settlements, 1); assert.deepEqual(f.kills, ['SIGKILL']); disposed(f);
});
for (const stream of ['stdout', 'stderr', 'stdin']) {
  test(`${stream} stream error rejects even when later close is zero`, async () => {
    const f = fixture(); f.child[stream].emit('error', new Error('broken stream'));
    f.exit(); f.close(); const { error } = await f.observed;
    assert.equal(error.code, `CLI_${stream.toUpperCase()}_ERROR`);
    assert.equal(error.diagnostics.outputComplete, false); assert.equal(f.settlements, 1); disposed(f);
  });
}

test('runtime error after exit never signals an exited handle', async () => {
  const f = fixture(); f.exit(); f.child.emit('error', new Error('late error')); f.close();
  assert.equal((await f.observed).error.code, 'CLI_CHILD_ERROR'); assert.deepEqual(f.kills, []); disposed(f);
});

test('timeout retains process state and output, disposes pipes, and kills only its held child', async () => {
  const f = fixture(); f.child.stdout.emit('data', 'partial stdout'); f.child.stderr.emit('data', 'partial stderr');
  assert.equal(f.budget, 9000); f.fire(); const { error } = await f.observed;
  assert.equal(error.code, 'CLI_TIMEOUT'); assert.equal(error.diagnostics.timeoutType, 'PROCESS_TIMEOUT');
  assert.equal(error.diagnostics.elapsedMs, 9000); assert.equal(error.diagnostics.code, null);
  assert.equal(error.diagnostics.signal, null); assert.equal(error.diagnostics.outputComplete, false);
  assert.equal(error.diagnostics.stdout, 'partial stdout'); assert.equal(error.diagnostics.stderr, 'partial stderr');
  assert.equal(error.diagnostics.stdoutClosed, false); assert.deepEqual(f.kills, ['SIGKILL']);
  for (const stream of [f.child.stdin, f.child.stdout, f.child.stderr]) assert.equal(stream.destroyed, true);
  f.exit(null, 'SIGKILL'); f.close(); assert.equal(error.diagnostics.close.signal, 'SIGKILL'); disposed(f);
});

test('exit zero without stdio close is still a bounded drain timeout and never signals', async () => {
  const f = fixture(); f.exit(); f.child.stdout.emit('data', 'READY'); f.fire();
  const { error } = await f.observed;
  assert.equal(error.diagnostics.timeoutType, 'STDIO_DRAIN_TIMEOUT'); assert.equal(error.diagnostics.code, 0);
  assert.equal(error.diagnostics.stdout, 'READY'); assert.equal(error.diagnostics.outputComplete, false);
  assert.deepEqual(f.kills, []); f.close(); disposed(f);
});

test('close winning the timeout race stays successful with no late kill or timer', async () => {
  const f = fixture(); f.exit(); f.close(); f.fire();
  assert.equal((await f.result).code, 0); assert.equal(f.settlements, 1); assert.deepEqual(f.kills, []); disposed(f);
});

test('timeout winning close zero stays failed with exactly one settlement', async () => {
  const f = fixture(); f.fire(); f.exit(); f.close(); f.fire();
  assert.equal((await f.observed).error.code, 'CLI_TIMEOUT'); assert.equal(f.settlements, 1);
  assert.deepEqual(f.kills, ['SIGKILL']); disposed(f);
});

for (const mode of ['false', 'throw', 'error-event']) {
  test(`timeout kill ${mode} is recorded and never becomes success`, async () => {
    const f = fixture();
    f.child.kill = signal => {
      f.kills.push(signal);
      if (mode === 'throw') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      if (mode === 'error-event') f.child.emit('error', new Error('kill error'));
      return false;
    };
    f.fire(); f.exit(); f.close(); const { error } = await f.observed;
    assert.equal(error.code, 'CLI_TIMEOUT'); assert.equal(f.settlements, 1);
    if (mode === 'throw') assert.equal(error.diagnostics.killError, 'EPERM');
    else assert.equal(error.diagnostics.killAccepted, false);
    assert.deepEqual(f.kills, ['SIGKILL']); disposed(f);
  });
}

test('twenty concurrent independent handles retain their own late chunks and status', async () => {
  const fixtures = Array.from({ length: 20 }, () => fixture());
  fixtures.forEach((f, index) => { f.child.stdout.emit('data', `child-${index}:`); f.exit(index); });
  for (const [index, f] of [...fixtures.entries()].reverse()) {
    f.child.stdout.emit('data', 'READY'); f.child.stderr.emit('data', `stderr-${index}`); f.close();
  }
  const results = await Promise.all(fixtures.map(f => f.result));
  results.forEach((result, index) => {
    assert.equal(result.stdout, `child-${index}:READY`); assert.equal(result.stderr, `stderr-${index}`);
    assert.equal(result.code, index); disposed(fixtures[index]);
  });
});

function realFixture(t) {
  const startedAtMs = Date.now(); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-contract-'));
  return createAgentCleanup(t, { root, startedAtMs, paths: createServerAgentPaths({ root }) });
}

test('real cleanup.spawn launchers drain large stdout/stderr concurrently and preserve nonzero exit', async t => {
  const cleanup = realFixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => {
    const source = `const fs=require('node:fs'); fs.writeSync(1, 'READY:${index}:'+'x'.repeat(131072)); fs.writeSync(2, 'ERR:${index}:'+'y'.repeat(65536)); process.exitCode=${index};`;
    return collectChildOutput(cleanup.spawn(process.execPath, ['-e', source], { windowsHide: true }));
  }));
  results.forEach((result, index) => {
    assert.equal(result.code, index); assert.equal(result.signal, null);
    assert.equal(result.stdout, `READY:${index}:` + 'x'.repeat(131072));
    assert.equal(result.stderr, `ERR:${index}:` + 'y'.repeat(65536)); assert.equal(result.outputComplete, true);
  });
});

test('real cleanup.spawn ENOENT rejects and its close still completes fixture cleanup', async t => {
  const cleanup = realFixture(t);
  const child = cleanup.spawn(path.join(os.tmpdir(), 'does-not-exist-r7-node.exe'), [], { windowsHide: true });
  const closed = new Promise(resolve => child.once('close', resolve));
  await assert.rejects(collectChildOutput(child), error => error.code === 'CLI_SPAWN_ERROR' && error.cause.code === 'ENOENT');
  await closed;
});


test('real timeout rejects, closes its own pipes, and reaps only its direct launcher', async t => {
  const cleanup = realFixture(t);
  const child = cleanup.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  // A deliberately short budget exercises disposal; bootstrap still uses 9000ms.
  await assert.rejects(collectChildOutput(child, 200), error => {
    assert.equal(error.code, 'CLI_TIMEOUT'); assert.equal(error.diagnostics.timeoutType, 'PROCESS_TIMEOUT');
    assert.equal(error.diagnostics.killRequested, 'SIGKILL'); assert.equal(error.diagnostics.killAccepted, true);
    return true;
  });
  await closed;
  for (const stream of [child.stdin, child.stdout, child.stderr]) assert.equal(stream.destroyed, true);
});
