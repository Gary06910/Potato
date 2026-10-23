'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAgentCleanup, createOwnershipController, readDiscovery } = require('../helpers/serverAgentFixture');
const { commandResult, createDarwinApi, createProcessInspector, decodeDarwinArgs, decodeWindowsArgv, inspectProcessExistence } = require('../helpers/agentProcessInspection');

const executable = path.resolve('synthetic-runtime/node');
const cli = path.resolve('synthetic-repo/src/server-agent/cli.js');
const root = path.resolve('synthetic fixture "quoted" apostrophe\'');
const fixture = { root, startedAtMs: 1000 };
const owned = () => ({ state: 'OBSERVED', pid: 4242, executable,
  argv: [executable, cli, 'run', `--root=${root}`], startedAtMs: 1500, generation: 'darwin:1500000' });
const registration = { pid: 4242, generation: 'darwin:1500000' };
const policy = { executable, cli, canonical: value => value, now: () => 2000 };

for (const platform of ['darwin', 'linux']) {
  const cases = [
    ['wrong full executable', r => { r.executable = path.resolve('other-runtime/node'); }, 'VERIFIED_NOT_OWNED'],
    ['basename only executable', r => { r.executable = 'node'; }, 'VERIFIED_NOT_OWNED'],
    ['wrong argv runtime', r => { r.argv[0] = path.resolve('other-runtime/node'); }, 'VERIFIED_NOT_OWNED'],
    ['wrong CLI path', r => { r.argv[1] = path.resolve('other-repo/src/server-agent/cli.js'); }, 'VERIFIED_NOT_OWNED'],
    ['relative CLI path', r => { r.argv[1] = 'src/server-agent/cli.js'; }, 'VERIFIED_NOT_OWNED'],
    ['ensure command', r => { r.argv[2] = 'ensure'; }, 'VERIFIED_NOT_OWNED'],
    ['similar root prefix', r => { r.argv[3] += '-other'; }, 'VERIFIED_NOT_OWNED'],
    ['root only within another argument', r => { r.argv[3] = `--note=--root=${root}`; }, 'VERIFIED_NOT_OWNED'],
    ['multiple root options', r => { r.argv.push(`--root=${root}`); }, 'VERIFIED_NOT_OWNED'],
    ['multiple conflicting root options', r => { r.argv.push('--root', `${root}-other`); }, 'VERIFIED_NOT_OWNED'],
    ['quoted root differs literally', r => { r.argv[3] = `--root="${root}"`; }, 'VERIFIED_NOT_OWNED'],
    ['root is missing', r => { r.argv.pop(); }, 'VERIFIED_NOT_OWNED'],
    ['old process', r => { r.startedAtMs = 999; }, 'VERIFIED_NOT_OWNED'],
    ['future process', r => { r.startedAtMs = 2001; }, 'VERIFIED_NOT_OWNED'],
    ['PID reuse before first cleanup query', r => { r.generation = 'darwin:1501000'; }, 'PID_REUSED'],
    ['missing executable', r => { delete r.executable; }, 'IDENTITY_INCOMPLETE'],
    ['missing start timestamp', r => { delete r.startedAtMs; }, 'IDENTITY_INCOMPLETE'],
    ['missing generation', r => { delete r.generation; }, 'IDENTITY_INCOMPLETE'],
    ['missing argv', r => { delete r.argv; }, 'IDENTITY_INCOMPLETE'],
    ['wrong query PID', r => { r.pid = 4343; }, 'IDENTITY_INCOMPLETE'],
    ['query EPERM', r => { Object.assign(r, { state: 'QUERY_DENIED', reason: 'EPERM' }); }, 'QUERY_DENIED'],
    ['query EACCES', r => { Object.assign(r, { state: 'QUERY_DENIED', reason: 'EACCES' }); }, 'QUERY_DENIED'],
    ['query failed', r => { Object.assign(r, { state: 'QUERY_FAILED', reason: 'timeout' }); }, 'QUERY_FAILED']
  ];
  for (const [name, mutate, expected] of cases) test(`${platform} mock rejects ${name} with zero signals`, t => {
    const raw = owned(); mutate(raw);
    const calls = [];
    const safety = createOwnershipController(fixture, { ...policy, inspect: () => raw,
      sendSignal: (...args) => calls.push(args) });
    const result = safety.terminate(4242, 'SIGKILL', registration);
    t.diagnostic(JSON.stringify({ platform, raw, result, signalCalls: calls.length }));
    assert.equal(result.state, expected);
    assert.equal(calls.length, 0);
  });

  test(`${platform} mock accepts complete owned identity with exact spaced and quoted root`, t => {
    const raw = owned(), calls = [];
    const safety = createOwnershipController(fixture, { ...policy, inspect: () => ({ ...raw }), sendSignal: (...args) => calls.push(args) });
    const result = safety.terminate(4242, 'SIGTERM', registration);
    t.diagnostic(JSON.stringify({ platform, raw, result, signalCalls: calls.length }));
    assert.equal(result.state, 'SIGNALLED');
    assert.deepEqual(calls, [[4242, 'SIGTERM']]);
    assert.equal(safety.timeline.filter(r => r.event === 'pre-kill-revalidation').length, 1);
  });

  test(`${platform} mock rejects identity change immediately before signal`, t => {
    const records = [owned(), { ...owned(), generation: 'darwin:1600000', startedAtMs: 1600 }], calls = [];
    const safety = createOwnershipController(fixture, { ...policy, inspect: () => records.shift(), sendSignal: (...args) => calls.push(args) });
    const result = safety.terminate(4242, 'SIGKILL', registration);
    t.diagnostic(JSON.stringify({ platform, result, timeline: safety.timeline, signalCalls: calls.length }));
    assert.equal(result.state, 'PID_REUSED'); assert.equal(calls.length, 0);
  });

  test(`${platform} mock marker PID alone cannot authorize a signal`, () => {
    const calls = [];
    const safety = createOwnershipController(fixture, { ...policy, inspect: owned, sendSignal: (...args) => calls.push(args) });
    assert.equal(safety.terminate(4242).state, 'IDENTITY_INCOMPLETE');
    assert.equal(calls.length, 0);
  });

  test(`${platform} mock verified absence produces zero signals`, t => {
    const calls = [], raw = { state: 'VERIFIED_EXITED', reason: 'OS confirms absence' };
    const safety = createOwnershipController(fixture, { ...policy, inspect: () => raw, sendSignal: (...args) => calls.push(args) });
    const result = safety.terminate(4242, 'SIGKILL', registration);
    t.diagnostic(JSON.stringify({ platform, raw, result, signalCalls: calls.length }));
    assert.equal(result.state, 'VERIFIED_EXITED'); assert.equal(calls.length, 0);
  });
}

for (const raw of [
  { error: { code: 'EPERM' }, status: null, stdout: '', stderr: '' },
  { error: { code: 'EACCES' }, status: null, stdout: '', stderr: '' },
  { status: 1, stdout: '', stderr: 'ps: Operation not permitted' },
  { status: 1, stdout: '', stderr: 'ps: Permission denied' },
  { error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
  { status: null, signal: 'SIGSEGV', stdout: '', stderr: '' },
  { status: 1, signal: null, stdout: '', stderr: '' },
  { status: 0, signal: null, stdout: '', stderr: '' },
  { status: 0, signal: null, stdout: 'partial', stderr: 'warning: truncated query' }
]) test(`raw ps failure stays fail-closed: ${JSON.stringify(raw)}`, t => {
  const result = commandResult(raw), calls = [];
  const safety = createOwnershipController(fixture, { ...policy, inspect: () => result, sendSignal: (...args) => calls.push(args) });
  const final = safety.terminate(4242, 'SIGKILL', registration);
  t.diagnostic(JSON.stringify({ raw, result: final, signalCalls: calls.length }));
  assert.ok(['QUERY_DENIED', 'QUERY_FAILED', 'IDENTITY_INCOMPLETE'].includes(final.state));
  assert.equal(calls.length, 0);
});

function darwinStart(pid, micros = 1500000n) {
  const buffer = Buffer.alloc(136); buffer.writeUInt32LE(pid, 12);
  buffer.writeBigUInt64LE(micros / 1000000n, 120); buffer.writeBigUInt64LE(micros % 1000000n, 128);
  return buffer;
}
function darwinArgs(argv) {
  const argc = Buffer.alloc(4); argc.writeInt32LE(argv.length);
  return Buffer.concat([argc, Buffer.from(`${executable}\0\0${argv.join('\0')}\0SECRET_ENV=must-not-be-logged\0`)]);
}

test('Darwin raw native records retain exact argv boundaries and microsecond generation', t => {
  const raw = { start: darwinStart(4242), argv: darwinArgs(owned().argv), executable };
  const inspect = createProcessInspector({ platform: 'darwin', probe: () => true, darwin: {
    start: () => raw.start, argv: () => raw.argv, executable: () => raw.executable
  } });
  const result = inspect(4242);
  t.diagnostic(JSON.stringify({ raw: { startHex: raw.start.toString('hex'), argv: owned().argv, executable }, result }));
  assert.equal(result.state, 'OBSERVED'); assert.equal(result.generation, 'darwin:1500000');
  assert.deepEqual(result.argv, owned().argv);
  assert.equal(JSON.stringify(result).includes('SECRET_ENV'), false);
  assert.throws(() => decodeDarwinArgs(raw.argv.subarray(0, 8)));
});

test('Darwin FFI boundary uses separate libproc and libSystem with checked native buffer lengths', () => {
  const libraries = [], argv = darwinArgs(owned().argv);
  const koffi = {
    errno: () => 1,
    load(library) {
      libraries.push(library);
      return { func(prototype) {
        if (prototype.includes(' proc_pidinfo(')) return (_pid, flavor, _arg, output, size) => {
          assert.equal(library, '/usr/lib/libproc.dylib'); assert.equal(flavor, 3); assert.equal(size, 136);
          darwinStart(4242).copy(output); return 136;
        };
        if (prototype.includes(' proc_pidpath(')) return (_pid, output) => {
          assert.equal(library, '/usr/lib/libproc.dylib'); Buffer.from(executable + '\0').copy(output);
          return Buffer.byteLength(executable);
        };
        return (mib, count, output, size) => {
          assert.equal(library, '/usr/lib/libSystem.B.dylib'); assert.deepEqual(mib, [1, 49, 4242]); assert.equal(count, 3);
          size[0] = argv.length;
          if (output) argv.copy(output);
          return 0;
        };
      } };
    }
  };
  const inspect = createProcessInspector({ platform: 'darwin', probe: () => true, darwin: createDarwinApi(koffi) });
  const row = inspect(4242);
  assert.equal(row.state, 'OBSERVED'); assert.deepEqual(row.argv, owned().argv);
  assert.deepEqual(libraries, ['/usr/lib/libSystem.B.dylib', '/usr/lib/libproc.dylib']);
});

test('Darwin native short buffers and permission errors refuse the actual sender', () => {
  for (const mode of ['short', 'denied']) {
    const ffi = { errno: () => 1, load: () => ({ func: () => () => mode === 'short' ? 1 : 0 }) };
    const calls = [], inspect = createProcessInspector({ platform: 'darwin', probe: () => true, darwin: createDarwinApi(ffi) });
    const safety = createOwnershipController(fixture, { ...policy, inspect, sendSignal: (...a) => calls.push(a) });
    assert.equal(safety.terminate(4242, 'SIGKILL', registration).state, mode === 'short' ? 'IDENTITY_INCOMPLETE' : 'QUERY_DENIED');
    assert.equal(calls.length, 0);
  }
});

for (const code of ['EPERM', 'EACCES', 'EIO', 'ESRCH']) test(`Darwin native ${code} never becomes absence while PID exists`, t => {
  const calls = [], error = Object.assign(new Error(code), { code });
  const inspect = createProcessInspector({ platform: 'darwin', probe: () => true,
    darwin: { start() { throw error; } } });
  const raw = inspect(4242);
  const safety = createOwnershipController(fixture, { ...policy, inspect: () => raw, sendSignal: (...args) => calls.push(args) });
  const result = safety.terminate(4242, 'SIGKILL', registration);
  t.diagnostic(JSON.stringify({ raw: { nativeError: code, probe: 'exists' }, result }));
  assert.equal(result.state, ['EPERM', 'EACCES'].includes(code) ? 'QUERY_DENIED' : 'QUERY_FAILED');
  assert.equal(calls.length, 0);
});

test('Darwin native generation changed during OS inspection refuses signal', () => {
  let index = 0;
  const inspect = createProcessInspector({ platform: 'darwin', probe: () => true, darwin: {
    start: () => darwinStart(4242, 1500000n + BigInt(index++)),
    argv: () => darwinArgs(owned().argv), executable: () => executable
  } });
  const calls = [], safety = createOwnershipController(fixture, { ...policy, inspect, sendSignal: (...a) => calls.push(a) });
  assert.equal(safety.terminate(4242, 'SIGKILL', registration).state, 'PID_REUSED');
  assert.equal(calls.length, 0);
});

function linuxStat(ticks = '150') {
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[17] = '1'; fields[19] = ticks;
  return `4242 (node name with ) parens) ${fields.join(' ')}\n`;
}
test('Linux raw /proc records use NUL argv, exe path and start ticks', t => {
  const raw = { stat: linuxStat(), cmdline: Buffer.from(`${owned().argv.join('\0')}\0`), exe: executable };
  const inspect = createProcessInspector({ platform: 'linux', probe: () => true,
    readFile: file => file.endsWith('/stat') ? raw.stat : raw.cmdline, readlink: () => raw.exe });
  const row = inspect(4242), calls = [];
  const safety = createOwnershipController({ ...fixture, minStartTicks: '101' }, { ...policy, inspect,
    sendSignal: (...a) => calls.push(a) });
  const result = safety.terminate(4242, 'SIGTERM', { pid: 4242, generation: 'linux:150' });
  t.diagnostic(JSON.stringify({ raw: { stat: raw.stat, cmdlineHex: raw.cmdline.toString('hex'), exe: raw.exe }, row, result }));
  assert.equal(result.state, 'SIGNALLED'); assert.equal(calls.length, 1);
});

test('Linux same-tick fixture ambiguity refuses signal', () => {
  const row = { ...owned(), generation: 'linux:100', startTicks: '100' }, calls = [];
  const safety = createOwnershipController({ ...fixture, minStartTicks: '101' }, { ...policy, inspect: () => row, sendSignal: (...a) => calls.push(a) });
  assert.equal(safety.terminate(4242, 'SIGKILL', { pid: 4242, generation: 'linux:100' }).state, 'VERIFIED_NOT_OWNED');
  assert.equal(calls.length, 0);
});

for (const code of ['EPERM', 'EACCES', 'ENOENT']) test(`Linux /proc ${code} with live PID refuses signal`, () => {
  const calls = [], inspect = createProcessInspector({ platform: 'linux', probe: () => true,
    readFile() { throw Object.assign(new Error(code), { code }); } });
  const safety = createOwnershipController(fixture, { ...policy, inspect, sendSignal: (...a) => calls.push(a) });
  assert.equal(safety.terminate(4242, 'SIGKILL', registration).state, code === 'ENOENT' ? 'QUERY_FAILED' : 'QUERY_DENIED');
  assert.equal(calls.length, 0);
});

test('only OS ESRCH proves absence on POSIX', () => {
  const inspect = createProcessInspector({ platform: 'darwin', probe() { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); } });
  const calls = [], safety = createOwnershipController(fixture, { ...policy, inspect, sendSignal: (...a) => calls.push(a) });
  assert.equal(safety.terminate(4242, 'SIGKILL', registration).state, 'VERIFIED_EXITED');
  assert.equal(calls.length, 0);
});

test('Windows CIM null/malformed/error output cannot prove exit', t => {
  for (const stdout of ['null', '{}', '[{}]', '{"found":true,"pid":4242}', '{broken']) {
    const inspect = createProcessInspector({ platform: 'win32', systemRoot: path.resolve('Windows'), run: () => ({ status: 0, stdout, stderr: '' }) });
    const calls = [], safety = createOwnershipController(fixture, { ...policy, inspect, sendSignal: (...a) => calls.push(a) });
    const result = safety.terminate(4242, 'SIGKILL', registration);
    t.diagnostic(JSON.stringify({ raw: stdout, result }));
    assert.equal(result.state, 'IDENTITY_INCOMPLETE'); assert.equal(calls.length, 0);
  }
  const inspect = createProcessInspector({ platform: 'win32', systemRoot: path.resolve('Windows'), run: () => ({ status: 0, stdout: '{"found":false}', stderr: '' }) });
  assert.equal(inspect(4242).state, 'VERIFIED_EXITED');
});

test('Windows query uses an absolute system PowerShell path independent of Git Bash PATH', () => {
  let invoked;
  const inspect = createProcessInspector({ platform: 'win32', systemRoot: path.resolve('Windows'),
    run: command => { invoked = command; return { status: 0, stdout: '{"found":false}', stderr: '' }; } });
  assert.equal(inspect(4242).state, 'VERIFIED_EXITED');
  assert.equal(invoked, path.resolve('Windows/System32/WindowsPowerShell/v1.0/powershell.exe'));
});

test('real Windows path casing resolves to the same full file identity', { skip: process.platform !== 'win32' }, () => {
  const actualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-case-'));
  const actualCli = path.resolve(__dirname, '../../src/server-agent/cli.js');
  const row = { ...owned(), executable: process.execPath.toUpperCase(), argv:
    [process.execPath.toLowerCase(), actualCli, 'run', `--root=${actualRoot}`] };
  const calls = [], safety = createOwnershipController({ root: actualRoot, startedAtMs: 1000 }, {
    inspect: () => row, now: () => 2000, sendSignal: (...a) => calls.push(a)
  });
  assert.equal(safety.terminate(4242, 'SIGTERM', registration).state, 'SIGNALLED');
  assert.equal(calls.length, 1);
});

test('Windows CRT decoder handles spaces, embedded quotes, empty args and trailing backslashes', () => {
  function quote(arg) {
    return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  }
  const args = ['C:\\Program Files\\node.exe', 'C:\\a b\\cli.js', 'run', '--root=C:\\space "quote"\\', '', "apostrophe'"];
  assert.deepEqual(decodeWindowsArgv(args.map(quote).join(' ')), args);
  assert.deepEqual(decodeWindowsArgv('"node" "a""b"'), ['node', 'a"b']);
  assert.throws(() => decodeWindowsArgv('"unclosed'));
});

function cleanupFixture(t, deps = {}) {
  const actualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-mock-'));
  const paths = Object.fromEntries(['agentLockPath', 'agentReadyPath', 'agentLaunchPath', 'agentReaperPath'].map(key => [key, path.join(actualRoot, key)]));
  let cleanupHook;
  const calls = [];
  const f = { root: actualRoot, paths, startedAtMs: 1000 };
  const mockInspect = deps.inspect || (() => ({ ...owned(), argv: [executable, cli, 'run', `--root=${actualRoot}`] }));
  const cleanup = createAgentCleanup({ after: fn => { cleanupHook = fn; }, diagnostic: text => t.diagnostic(text) }, f,
    { ...policy, inspect: mockInspect,
      inspectExit: pid => { const row = mockInspect(pid); return row.state === 'OBSERVED' ? { state: 'PROCESS_EXISTS', pid } : row; },
      sendSignal: (...a) => calls.push(a), ...deps });
  return { f, cleanup, calls, cleanupHook };
}

test('missing marker plus unresolved pre-spawn intent never reports cleanup success', async t => {
  const { cleanup, calls } = cleanupFixture(t);
  fs.writeFileSync(path.join(cleanup.registry, 'early.intent.json'), JSON.stringify({ id: 'early', argv: owned().argv }));
  assert.equal(readDiscovery(cleanup.registry, []).state, 'DISCOVERY_INCOMPLETE');
  await assert.rejects(cleanup.cleanup(), /DISCOVERY_INCOMPLETE/);
  assert.equal(calls.length, 0);
  assert.ok(cleanup.timeline.some(row => row.event === 'cleanup-failed'));
  assert.equal(cleanup.timeline.some(row => row.event === 'cleanup-end'), false);
});

test('pre-marker PID without complete spawn generation is unresolved and unsignalled', async t => {
  const { cleanup, calls } = cleanupFixture(t);
  fs.writeFileSync(path.join(cleanup.registry, 'early.intent.json'), JSON.stringify({ id: 'early', argv: owned().argv }));
  fs.writeFileSync(path.join(cleanup.registry, 'early.outcome.json'), JSON.stringify({ id: 'early', state: 'QUERY_DENIED', pid: 4242 }));
  await assert.rejects(cleanup.cleanup(), /incomplete spawn inspection/);
  assert.equal(calls.length, 0);
});

for (const state of ['QUERY_DENIED', 'QUERY_FAILED', 'IDENTITY_INCOMPLETE', 'PID_REUSED']) {
  test(`cleanup ${state} preserves failure diagnostic and sends zero signals`, async t => {
    const x = cleanupFixture(t, { inspect: pid => pid === process.pid ? owned() : { state, reason: 'synthetic query error' },
      readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [] }) });
    await assert.rejects(x.cleanup.cleanup(), new RegExp(state));
    assert.equal(x.calls.length, 0);
    const log = JSON.parse(fs.readFileSync(path.join(x.f.root, 'process-cleanup.json'), 'utf8'));
    assert.ok(log.some(row => row.event === 'cleanup-failed'));
    assert.equal(log.some(row => row.event === 'cleanup-end'), false);
  });
}

test('forged live marker PID without spawn registration refuses cleanup signal', async t => {
  const { f, cleanup, calls } = cleanupFixture(t);
  fs.writeFileSync(f.paths.agentLockPath, JSON.stringify({ pid: 4242 }));
  await assert.rejects(cleanup.cleanup(), /no complete spawn generation/);
  assert.equal(calls.length, 0);
});

test('registered pre-marker process is safely managed after simulated assertion failure', async t => {
  let sent = false;
  const x = cleanupFixture(t, {
    inspect: pid => pid === process.pid ? owned() : sent ? { state: 'VERIFIED_EXITED' } :
      { ...owned(), argv: [executable, cli, 'run', `--root=${x.f.root}`] },
    readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [] }),
    sendSignal: (pid, signal) => { x.calls.push([pid, signal]); sent = true; }
  });
  assert.throws(() => assert.fail('synthetic assertion after spawn, before marker'));
  await x.cleanup.cleanup();
  assert.equal(x.calls.length, 1);
  assert.ok(x.cleanup.timeline.some(row => row.event === 'cleanup-end'));
});

test('completed registered exit with stale marker can finish cleanup without signaling', async t => {
  const x = cleanupFixture(t, {
    inspect: pid => pid === process.pid ? owned() : { state: 'VERIFIED_EXITED' },
    readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [4242] })
  });
  await x.cleanup.cleanup(); assert.equal(x.calls.length, 0);
  assert.equal(x.cleanup.timeline.at(-1).state, 'CLEANUP_PASS');
});

for (const code of ['EPERM', 'EACCES', 'EIO', 'ESRCH']) test(`OS exit probe ${code} is explicitly classified and cannot authorize a signal`, t => {
  const raw = { error: code };
  const probe = () => { throw Object.assign(new Error(code), { code }); };
  const result = inspectProcessExistence(4242, probe), calls = [];
  const safety = createOwnershipController(fixture, { ...policy, inspect: () => result, sendSignal: (...a) => calls.push(a) });
  const final = safety.terminate(4242, 'SIGKILL', registration);
  t.diagnostic(JSON.stringify({ raw, result, final, signalCalls: calls.length }));
  assert.equal(final.state, code === 'ESRCH' ? 'VERIFIED_EXITED' : code === 'EIO' ? 'QUERY_FAILED' : 'QUERY_DENIED');
  assert.equal(calls.length, 0);
});

test('after an owned signal, exit uses affirmative OS absence rather than incomplete CIM metadata', async t => {
  let sent = false, ownershipQueriesAfterSignal = 0;
  const x = cleanupFixture(t, {
    inspect: pid => {
      if (pid === process.pid) return owned();
      if (sent) { ownershipQueriesAfterSignal++; return { state: 'IDENTITY_INCOMPLETE', reason: 'CIM teardown fields absent' }; }
      return { ...owned(), argv: [executable, cli, 'run', `--root=${x.f.root}`] };
    },
    inspectExit: pid => inspectProcessExistence(pid, () => { throw Object.assign(new Error('OS confirms exit'), { code: 'ESRCH' }); }),
    readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [] }),
    sendSignal: (...args) => { x.calls.push(args); sent = true; }
  });
  await x.cleanup.cleanup();
  assert.equal(x.calls.length, 1);
  assert.equal(ownershipQueriesAfterSignal, 0);
  assert.equal(x.cleanup.timeline.at(-1).state, 'CLEANUP_PASS');
});

test('exit-probe denial after a valid owned signal still rejects cleanup and never repeats the signal', async t => {
  const x = cleanupFixture(t, {
    inspect: pid => pid === process.pid ? owned() : { ...owned(), argv: [executable, cli, 'run', `--root=${x.f.root}`] },
    inspectExit: () => ({ state: 'QUERY_DENIED', reason: 'EPERM' }),
    readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [] })
  });
  await assert.rejects(x.cleanup.cleanup(), /QUERY_DENIED/);
  assert.equal(x.calls.length, 1);
  assert.equal(x.cleanup.timeline.some(row => row.event === 'cleanup-end'), false);
});

test('OS-proven replacement generation means original exited; live replacement receives zero signals', async t => {
  const replacement = { ...owned(), executable: path.resolve('unrelated/conhost.exe'),
    argv: [path.resolve('unrelated/conhost.exe'), '0x4'], generation: 'darwin:1800000', startedAtMs: 1800 };
  const x = cleanupFixture(t, {
    inspect: pid => pid === process.pid ? owned() : replacement,
    readDiscovery: () => ({ state: 'DISCOVERY_COMPLETE', registrations: [registration], markerPids: [4242] })
  });
  await x.cleanup.cleanup();
  assert.equal(x.calls.length, 0);
  const record = x.cleanup.timeline.find(row => row.event === 'original-generation-exited');
  assert.equal(record.decision, 'NO_SIGNAL_PID_REUSED');
  assert.equal(record.originalGeneration, registration.generation);
  assert.equal(record.replacementGeneration, replacement.generation);
  assert.equal(x.cleanup.timeline.at(-1).state, 'CLEANUP_PASS');
  assert.equal(x.cleanup.timeline.some(row => row.event === 'exit-verification'), false);
});
