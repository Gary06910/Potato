'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProcessInspector, createLinuxExitInspector, decodeLinuxStat } = require('../helpers/agentProcessInspection');
const { createAgentCleanup, createOwnershipController } = require('../helpers/serverAgentFixture');
const pid = 4242, generation = 'linux:150';
const registration = { pid, generation };
const executable = path.resolve('synthetic/node'), cli = path.resolve('synthetic/cli.js');
const root = path.resolve('synthetic fixture');
const policy = { executable, cli, canonical: v => v, now: () => 2000 };
const fixture = { root, startedAtMs: 1000, minStartTicks: '101' };
const error = code => Object.assign(new Error(code), { code });
function stat(state = 'S', ticks = '150', threads = '1') {
  const fields = Array(50).fill('0'); fields[0] = state; fields[1] = '123'; fields[17] = threads; fields[19] = ticks;
  return `${pid} (node ) with spaces) ${fields.join(' ')}\n`;
}
function proc(options = {}) {
  let index = 0;
  return { platform: 'linux', probe: options.probe || (() => true),
    readlink: () => { if (options.exeError) throw error(options.exeError); return executable; },
    readFile(file) {
      if (file.endsWith('/stat')) {
        const value = options.stats ? options.stats[Math.min(index++, options.stats.length - 1)] : stat();
        if (value instanceof Error) throw value;
        return value;
      }
      if (options.cmdError) throw error(options.cmdError);
      return options.cmdline ?? Buffer.from(`${[executable, cli, 'run', `--root=${root}`].join('\0')}\0`);
    }
  };
}
function refuse(inspect, expected, reg = registration) {
  const calls = [];
  const controller = createOwnershipController(fixture, { ...policy, inspect, sendSignal: (...a) => calls.push(a) });
  assert.equal(controller.terminate(pid, 'SIGKILL', reg).state, expected);
  assert.equal(calls.length, 0, 'SIGNAL_SENDER_CALLS = 0');
}
test('Linux state parser preserves bracketed comm, state, PPID and start ticks', () => {
  const row = decodeLinuxStat(stat('Z'), pid);
  assert.equal(row.processState, 'Z'); assert.equal(row.parentPid, 123); assert.equal(row.generation, generation);
  for (const text of [stat('ZZ'), stat('!'), stat('Z', '0'), stat('Z', '-1'), stat('Z').split(' ').slice(0, 12).join(' '), stat().replace('4242 (', '4243 (')]) {
    assert.throws(() => decodeLinuxStat(text, pid));
  }
});
test('Linux live complete identity authorizes only the fully revalidated owner', () => {
  const calls = [], inspect = createProcessInspector(proc());
  const controller = createOwnershipController(fixture, { ...policy, inspect, sendSignal: (...a) => calls.push(a) });
  assert.equal(controller.terminate(pid, 'SIGTERM', registration).state, 'SIGNALLED'); assert.equal(calls.length, 1);
});
for (const field of ['exeError', 'cmdError']) for (const code of ['ENOENT', 'ESRCH', 'EPERM', 'EACCES', 'EIO']) {
  test(`Linux live ${field}=${code} is unsignalled`, () => {
    refuse(createProcessInspector(proc({ [field]: code })), ['EPERM', 'EACCES'].includes(code) ? 'QUERY_DENIED' : 'QUERY_FAILED');
  });
}
for (const state of ['R', 'S', 'D', 'T', 't', 'X', 'I']) test(`Linux state ${state} plus missing metadata is not Zombie`, () => {
  refuse(createProcessInspector(proc({ stats: [stat(state)], exeError: 'ENOENT' })), 'QUERY_FAILED');
});
test('Linux stable Z same generation is runtime terminated, never PID reaped or signal authority', () => {
  const inspect = createProcessInspector(proc({ stats: [stat('Z')], exeError: 'ENOENT' }));
  assert.equal(inspect(pid).state, 'LINUX_ZOMBIE'); refuse(inspect, 'REGISTERED_GENERATION_ZOMBIE');
  const exit = createLinuxExitInspector(proc({ stats: [stat('Z')] }))(pid, registration);
  assert.equal(exit.state, 'REGISTERED_GENERATION_ZOMBIE'); assert.equal(exit.runtimeTerminated, true); assert.equal(exit.pidReaped, false);
});
test('Linux Z without or with different registration never owns the old process', () => {
  const inspect = createProcessInspector(proc({ stats: [stat('Z', '151')] }));
  refuse(inspect, 'PID_REUSED'); refuse(inspect, 'IDENTITY_INCOMPLETE', null);
});
test('Linux Z malformed stat refuses signal', () => {
  refuse(createProcessInspector(proc({ stats: [stat('Z', 'bad')] })), 'IDENTITY_INCOMPLETE');
});
test('Linux running to Z during exe read requires a confirming Z observation', () => {
  const inspect = createProcessInspector(proc({ stats: [stat(), stat('Z'), stat('Z')], exeError: 'ENOENT' }));
  refuse(inspect, 'REGISTERED_GENERATION_ZOMBIE');
});
test('Linux transition without confirming Z refuses signal', () => {
  refuse(createProcessInspector(proc({ stats: [stat(), stat('Z'), stat('S')], exeError: 'ENOENT' })), 'QUERY_FAILED');
});
test('Linux PID disappears between stat and exe; ESRCH proves observed absence', () => {
  let count = 0;
  const inspect = createProcessInspector(proc({ stats: [stat(), error('ENOENT')], exeError: 'ENOENT',
    probe: () => { if (++count > 1) throw error('ESRCH'); } }));
  refuse(inspect, 'VERIFIED_EXITED');
});
test('Linux two different stat generations refuse signal', () => {
  refuse(createProcessInspector(proc({ stats: [stat(), stat('S', '151')] })), 'PID_REUSED');
});
for (const code of ['EPERM', 'EACCES', 'EIO', 'ENOENT']) test(`Linux stat ${code} with kill0 success is fail-closed`, () => {
  refuse(createProcessInspector(proc({ stats: [error(code)] })), ['EPERM', 'EACCES'].includes(code) ? 'QUERY_DENIED' : 'QUERY_FAILED');
});
for (const code of ['EPERM', 'EACCES']) for (const stage of ['probe', 'second-stat', 'exe', 'cmdline']) {
  test(`Linux ${code} at ${stage} refuses exit and signal authority`, () => {
    const options = stage === 'probe' ? { probe: () => { throw error(code); } } : stage === 'second-stat' ? { stats: [stat(), error(code)] } : { [stage === 'exe' ? 'exeError' : 'cmdError']: code };
    refuse(createProcessInspector(proc(options)), 'QUERY_DENIED');
  });
}
test('Linux exit reader cannot promote live missing metadata or incomplete registration', () => {
  const inspect = createLinuxExitInspector(proc({ exeError: 'ENOENT' }));
  assert.equal(inspect(pid, registration).state, 'PROCESS_EXISTS');
  assert.equal(inspect(pid, undefined).state, 'IDENTITY_INCOMPLETE');
});
test('Linux exit-reader race or older ticks is fail-closed', () => {
  assert.equal(createLinuxExitInspector(proc({ stats: [stat('Z'), stat('Z', '151')] }))(pid, registration).state, 'PID_REUSED');
  assert.equal(createLinuxExitInspector(proc({ stats: [stat('Z', '149')] }))(pid, registration).state, 'PID_REUSED');
});
test('Linux exit-reader newer stable generation proves only original generation ended', () => {
  const row = createLinuxExitInspector(proc({ stats: [stat('Z', '151')] }))(pid, registration);
  assert.equal(row.state, 'ORIGINAL_GENERATION_TERMINATED'); assert.equal(row.pidReaped, true);
  assert.equal(row.currentPidReaped, false); refuse(() => row, 'ORIGINAL_GENERATION_TERMINATED');
});
function cleanupCase(t, { exit, initial, discovery } = {}) {
  const actualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-exit-contract-'));
  const paths = Object.fromEntries(['agentLockPath', 'agentReadyPath', 'agentLaunchPath', 'agentReaperPath'].map(key => [key, path.join(actualRoot, key)]));
  const calls = []; let clock = 0;
  const self = { state: 'OBSERVED', pid, executable, argv: [executable, cli, 'run', `--root=${actualRoot}`], generation, startTicks: '150' };
  const zombie = { state: 'LINUX_ZOMBIE', pid, generation, startTicks: '150', processState: 'Z', threadCount: 1, parentPid: 123 };
  const cleanup = createAgentCleanup({ after() {}, diagnostic: v => t.diagnostic(v) }, { ...fixture, root: actualRoot, paths }, {
    ...policy, inspect: candidate => candidate === process.pid ? self : (initial || zombie),
    inspectExit: exit || (() => ({ ...zombie, state: 'REGISTERED_GENERATION_ZOMBIE', runtimeTerminated: true, pidReaped: false })),
    monotonicNow: () => clock, wait: async ms => { clock += ms; },
    readDiscovery: () => discovery || ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [] }),
    sendSignal: (...a) => calls.push(a)
  });
  return { cleanup, calls, root: actualRoot };
}
test('Linux persistent registered Z times out bounded, artifact retained, no signal or cleanup pass', async t => {
  const x = cleanupCase(t);
  await assert.rejects(x.cleanup.cleanup(), /cleanup deadline/); assert.equal(x.calls.length, 0);
  const log = JSON.parse(fs.readFileSync(path.join(x.root, 'process-cleanup.json')));
  assert.ok(log.some(r => r.event === 'runtime-terminated-awaiting-reap'));
  assert.equal(log.some(r => r.event === 'cleanup-end'), false);
});
test('Linux Z then reaped cleanup is idempotent with zero signals', async t => {
  let index = 0;
  const x = cleanupCase(t, { exit: () => ++index === 1 ? { state: 'REGISTERED_GENERATION_ZOMBIE', pid, generation, runtimeTerminated: true, pidReaped: false } : { state: 'VERIFIED_EXITED', pid } });
  await x.cleanup.cleanup(); await x.cleanup.cleanup(); assert.equal(x.calls.length, 0);
  assert.equal(x.cleanup.timeline.filter(r => r.event === 'cleanup-end').length, 1);
});
test('Linux Z then PID reuse cleanup never signals the replacement', async t => {
  const exit = createLinuxExitInspector(proc({ stats: [stat('S', '151')] }));
  const x = cleanupCase(t, { exit }); await x.cleanup.cleanup(); assert.equal(x.calls.length, 0);
  assert.ok(x.cleanup.timeline.some(r => r.event === 'original-generation-exited'));
});
for (const state of ['QUERY_FAILED', 'QUERY_DENIED', 'IDENTITY_INCOMPLETE', 'PID_REUSED']) test(`Linux Z exit ${state} keeps cleanup failed and sender zero`, async t => {
  const x = cleanupCase(t, { exit: () => ({ state, reason: 'injected failure' }) });
  await assert.rejects(x.cleanup.cleanup(), new RegExp(state)); assert.equal(x.calls.length, 0);
});
test('Linux Z forged marker without journal cannot bypass discovery/registration', async t => {
  for (const discovery of [{ state: 'DISCOVERY_INCOMPLETE' }, { state: 'DISCOVERY_COMPLETE', registrations: [], markerPids: [pid] }]) {
    const x = cleanupCase(t, { discovery }); await assert.rejects(x.cleanup.cleanup()); assert.equal(x.calls.length, 0);
  }
});

for (const code of ['EPERM', 'EACCES', 'ENOENT', 'EIO']) test(`Linux exit stat/probe ${code} never proves reaping without ESRCH`, () => {
  const expected = ['EPERM', 'EACCES'].includes(code) ? 'QUERY_DENIED' : 'QUERY_FAILED';
  const inspect = createLinuxExitInspector(proc({ stats: [stat('Z'), error(code)] }));
  const row = inspect(pid, registration); assert.equal(row.state, expected); refuse(() => row, expected);
});
test('Linux empty live cmdline is incomplete, not runtime terminated', () => {
  refuse(createProcessInspector(proc({ cmdline: Buffer.alloc(0) })), 'IDENTITY_INCOMPLETE');
});
test('Linux Z second read missing but PID present is not reaped', () => {
  refuse(createProcessInspector(proc({ stats: [stat('Z'), error('ENOENT')] })), 'QUERY_FAILED');
});
test('Linux Z generation changes while confirming termination refuses signal', () => {
  refuse(createProcessInspector(proc({ stats: [stat(), stat('Z'), stat('Z', '151')], exeError: 'ENOENT' })), 'PID_REUSED');
});
test('Linux live-to-Z during pre-kill revalidation sends zero signals and waits for reaping', async t => {
  let queries = 0;
  const live = { state: 'OBSERVED', pid, executable, generation, startTicks: '150' };
  const zombie = { state: 'LINUX_ZOMBIE', pid, generation, startTicks: '150', processState: 'Z', threadCount: 1 };
  const actualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-prekill-z-'));
  const f = { ...fixture, root: actualRoot, paths: Object.fromEntries(['agentLockPath', 'agentReadyPath', 'agentLaunchPath', 'agentReaperPath'].map(k => [k, path.join(actualRoot, k)])) };
  live.argv = [executable, cli, 'run', `--root=${actualRoot}`];
  const calls = [];
  const cleanup = createAgentCleanup({ after() {} }, f, { ...policy,
    inspect: p => p === process.pid ? live : ++queries <= 2 ? live : zombie,
    inspectExit: () => ({ state: 'VERIFIED_EXITED', pid }),
    readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [] }),
    sendSignal: (...a) => calls.push(a)
  });
  await cleanup.cleanup(); assert.equal(calls.length, 0);
  assert.ok(cleanup.timeline.some(r => r.event === 'pre-kill-revalidation' && r.result.state === 'REGISTERED_GENERATION_ZOMBIE'));
  t.diagnostic('SIGNAL_SENDER_CALLS = 0');
});
test('Linux repeated failed Z cleanup stays bounded and never sends a signal', async t => {
  const x = cleanupCase(t);
  await assert.rejects(x.cleanup.cleanup(), /cleanup deadline/);
  await assert.rejects(x.cleanup.cleanup(), /cleanup deadline/);
  assert.equal(x.calls.length, 0);
});

test('non-Linux default exit adapter does not interpret registration as probe', { skip: process.platform === 'linux' }, async () => {
  const actualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-adapter-self-'));
  const self = { state: 'OBSERVED', pid: process.pid, executable, argv: [executable, cli, 'run', `--root=${actualRoot}`], generation: 'darwin:1500000', startedAtMs: 1500 };
  const paths = Object.fromEntries(['agentLockPath', 'agentReadyPath', 'agentLaunchPath', 'agentReaperPath'].map(k => [k, path.join(actualRoot, k)]));
  let clock = 0;
  const calls = [];
  const cleanup = createAgentCleanup({ after() {} }, { root: actualRoot, paths, startedAtMs: 1000 }, {
    ...policy, inspect: () => self,
    monotonicNow: () => clock, wait: async ms => { clock += ms; },
    readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [{ pid: process.pid, generation: self.generation }], markerPids: [] }),
    sendSignal: (...a) => calls.push(a) // Positive mock only; native boundary queries self with signal zero.
  });
  await assert.rejects(cleanup.cleanup(), /cleanup deadline/);
  assert.equal(calls.length, 1);
  assert.ok(cleanup.timeline.some(r => r.event === 'exit-verification' && r.raw.state === 'PROCESS_EXISTS'));
  assert.equal(cleanup.timeline.some(r => r.raw?.reason === 'probe is not a function'), false);
});

test('Linux Zombie group leader with surviving threads never proves runtime termination', () => {
  for (const threads of ['2', '8']) {
    refuse(createProcessInspector(proc({ stats: [stat('Z', '150', threads)] })), 'QUERY_FAILED');
    const row = createLinuxExitInspector(proc({ stats: [stat('Z', '150', threads)] }))(pid, registration);
    assert.equal(row.state, 'QUERY_FAILED'); assert.notEqual(row.runtimeTerminated, true);
  }
});
test('Linux final thread departure needs two Z/threadCount=1 observations', () => {
  refuse(createProcessInspector(proc({ stats: [stat('Z', '150', '2'), stat('Z'), stat('Z')] })), 'REGISTERED_GENERATION_ZOMBIE');
  refuse(createProcessInspector(proc({ stats: [stat('Z', '150', '2'), stat('Z'), stat('Z', '150', '2')] })), 'QUERY_FAILED');
});
