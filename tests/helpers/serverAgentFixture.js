'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createProcessInspector, inspectProcessExistence, linuxClock } = require('./agentProcessInspection');

const cli = path.resolve(__dirname, '../../src/server-agent/cli.js');
const preload = path.resolve(__dirname, '../fixtures/serverAgentOwnershipPreload.js');

function canonicalIdentity(value) {
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved, { bigint: true });
  // Windows spelling may differ between CIM and process.execPath. File identity
  // prevents case folding from conflating files in case-sensitive directories.
  return `${process.platform === 'win32' ? resolved.toLowerCase() : resolved}\0${stat.dev}:${stat.ino}`;
}

function spawnAgentRegistered(spawn, command, args, options, registration) {
  const { root, registry } = registration;
  if (!Array.isArray(args) || args[0] !== cli || args[1] !== 'run') return spawn(command, args, options);
  if (canonicalIdentity(command) !== canonicalIdentity(process.execPath)
    || args.filter(a => a.startsWith('--root=')).length !== 1
    || args.find(a => a.startsWith('--root=')) !== `--root=${root}`) throw new Error('unrecognized fixture Agent launch');
  const id = randomUUID();
  const write = (kind, value) => fs.writeFileSync(path.join(registry, `${id}.${kind}.json`), JSON.stringify({ id, ...value }), { flag: 'wx', mode: 0o600 });
  write('intent', { parentPid: process.pid, argv: [command, ...args], atMs: Date.now() });
  let child;
  try { child = spawn(command, args, options); }
  catch (error) { write('outcome', { state: 'SPAWN_FAILED', noPid: true, code: error.code }); throw error; }
  if (!child.pid) child.once('error', error => write('outcome', { state: 'SPAWN_FAILED', noPid: true, code: error.code }));
  else {
    write('pid', { pid: child.pid });
    write('outcome', { ...createProcessInspector()(child.pid), pid: child.pid });
  }
  return child;
}

function matchesRoot(argv, root, expectedCli = cli, canonical = canonicalIdentity) {
  if (!Array.isArray(argv) || argv.length < 4 || argv.some(a => typeof a !== 'string' || a.includes('\0'))) return false;
  if (!path.isAbsolute(argv[1]) || canonical(argv[1]) !== canonical(expectedCli) || argv[2] !== 'run') return false;
  const roots = [];
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--root') roots.push(argv[++i]);
    else if (argv[i].startsWith('--root=')) roots.push(argv[i].slice(7));
  }
  return roots.length === 1 && typeof roots[0] === 'string' && path.isAbsolute(roots[0])
    && canonical(roots[0]) === canonical(root);
}

function verifyOwnership(row, fixture, registration, deps = {}) {
  if (row.state !== 'OBSERVED') return row;
  const deny = (state, reason) => ({ state, reason, pid: row.pid });
  if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !row.executable || !Array.isArray(row.argv)
    || typeof row.generation !== 'string' || !row.generation) return deny('IDENTITY_INCOMPLETE', 'missing process identity');
  if (!registration || registration.pid !== row.pid || !registration.generation) return deny('IDENTITY_INCOMPLETE', 'no complete spawn generation');
  if (registration.generation !== row.generation) return deny('PID_REUSED', 'OS start generation differs from spawn registration');
  const canonical = deps.canonical || canonicalIdentity;
  const executable = deps.executable || process.execPath;
  try {
    if (!path.isAbsolute(row.executable) || canonical(row.executable) !== canonical(executable)
      || !row.argv[0] || !path.isAbsolute(row.argv[0]) || canonical(row.argv[0]) !== canonical(executable)) {
      return deny('VERIFIED_NOT_OWNED', 'full executable identity mismatch');
    }
    if (!matchesRoot(row.argv, fixture.root, deps.cli || cli, canonical)) return deny('VERIFIED_NOT_OWNED', 'CLI/run/root identity mismatch');
  } catch (error) { return deny('IDENTITY_INCOMPLETE', `path identity unavailable: ${error.code || error.message}`); }
  if (fixture.minStartTicks !== undefined) {
    if (!/^\d+$/.test(row.startTicks || '')) return deny('IDENTITY_INCOMPLETE', 'missing Linux start ticks');
    if (BigInt(row.startTicks) < BigInt(fixture.minStartTicks)) return deny('VERIFIED_NOT_OWNED', 'start tick predates fixture or overlaps its boundary');
  } else {
    if (!Number.isFinite(row.startedAtMs) || !Number.isFinite(fixture.startedAtMs)) return deny('IDENTITY_INCOMPLETE', 'missing start timestamp');
    if (row.startedAtMs < fixture.startedAtMs || row.startedAtMs > (deps.now || Date.now)()) return deny('VERIFIED_NOT_OWNED', 'start time outside fixture lifetime');
  }
  return { state: 'VERIFIED_OWNED', identity: row };
}

// A stable OS observation of a different start generation proves the registered
// generation is gone. It does NOT prove the current PID exited or authorize a
// signal to its replacement. Partial/denied/racing queries cannot prove this.
function originalGenerationExited(row, registration) {
  let newer = false;
  if (typeof row.generation === 'string' && registration?.generation) {
    const current = /^(darwin|linux):(\d+)$/.exec(row.generation);
    const prior = /^(darwin|linux):(\d+)$/.exec(registration.generation);
    if (current && prior && current[1] === prior[1]) newer = BigInt(current[2]) > BigInt(prior[2]);
    const windows = /^win32:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/;
    if (windows.test(row.generation) && windows.test(registration.generation)) newer = row.generation > registration.generation;
  }
  return row.state === 'OBSERVED' && registration && row.pid === registration.pid
    && newer
    && !!row.executable && Array.isArray(row.argv) && row.argv.length > 0
    && (Number.isFinite(row.startedAtMs) || /^\d+$/.test(row.startTicks || ''));
}

// No process-global signal monkeypatch. Unit tests inject both the OS reader and sender.
function createOwnershipController(fixture, deps) {
  const timeline = [], identities = new Map();
  const note = (event, extra = {}) => timeline.push({ atMs: (deps.now || Date.now)(), event, ...extra });
  function terminate(pid, signal = 'SIGKILL', registration) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !['SIGTERM', 'SIGKILL'].includes(signal)) {
      const result = { state: 'IDENTITY_INCOMPLETE', reason: 'invalid PID or termination signal' };
      note('termination-refused', { pid, result }); return result;
    }
    let current, verified;
    try {
      current = deps.inspect(pid);
      const result = verifyOwnership(current, fixture, registration, deps);
      note('ownership-inspection', { pid, raw: current, result });
      if (result.state !== 'VERIFIED_OWNED') return result;
      const prior = identities.get(pid);
      if (prior && prior !== current.generation) return { state: 'PID_REUSED', reason: 'generation changed since earlier inspection' };
      identities.set(pid, current.generation);
      verified = deps.inspect(pid);
      const again = verifyOwnership(verified, fixture, registration, deps);
      note('pre-kill-revalidation', { pid, raw: verified, result: again });
      if (again.state !== 'VERIFIED_OWNED') return again;
      if (JSON.stringify(current) !== JSON.stringify(verified)) return { state: 'PID_REUSED', reason: 'identity changed before signal' };
      deps.sendSignal(pid, signal);
      note('verified-termination', { pid, signal, generation: verified.generation });
      return { state: 'SIGNALLED', pid, signal };
    } catch (error) {
      // A signal-side ESRCH must be confirmed by a new OS query as well.
      if (error.code === 'ESRCH') {
        const after = deps.inspect(pid);
        if (after.state === 'VERIFIED_EXITED') return after;
      }
      const result = { state: ['EPERM', 'EACCES'].includes(error.code) ? 'QUERY_DENIED' : 'QUERY_FAILED', reason: error.code || error.message };
      note('termination-refused', { pid, result }); return result;
    }
  }
  return { terminate, timeline, note };
}

function readDiscovery(registry, markerPaths) {
  const registrations = [], markerPids = [];
  try {
    const names = fs.readdirSync(registry);
    const intents = names.filter(name => name.endsWith('.intent.json'));
    const outcomes = names.filter(name => name.endsWith('.outcome.json'));
    if (outcomes.length !== intents.length) throw new Error('unresolved spawn intent or orphan outcome');
    for (const name of intents) {
      const intent = JSON.parse(fs.readFileSync(path.join(registry, name), 'utf8'));
      const result = JSON.parse(fs.readFileSync(path.join(registry, name.replace('.intent.json', '.outcome.json')), 'utf8'));
      if (intent.id !== result.id || !intent.id || !Array.isArray(intent.argv)) throw new Error('invalid spawn journal');
      if (result.state === 'SPAWN_FAILED' && result.noPid === true) continue;
      if (!Number.isSafeInteger(result.pid) || result.pid <= 0) throw new Error('missing spawned PID');
      if (result.state === 'VERIFIED_EXITED') continue;
      if (result.state !== 'OBSERVED' || !result.generation) throw new Error(`incomplete spawn inspection: ${result.state}`);
      registrations.push({ pid: result.pid, generation: result.generation });
    }
    for (const file of markerPaths) {
      try {
        const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0) throw new Error('invalid marker PID');
        markerPids.push(marker.pid);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { state: 'DISCOVERY_COMPLETE', registrations, markerPids };
  } catch (error) { return { state: 'DISCOVERY_INCOMPLETE', reason: error.code || error.message, registrations, markerPids }; }
}

function createAgentCleanup(t, fixture, deps = {}) {
  assert.ok(Number.isFinite(fixture.startedAtMs), 'fixture creation time is required');
  const registry = path.join(fixture.root, 'test-agent-spawns');
  fs.mkdirSync(registry, { mode: 0o700 });
  const inspect = deps.inspect || createProcessInspector();
  const inspectExit = deps.inspectExit || inspectProcessExistence;
  // A read-only self query must work before any detached fixture can be launched.
  const self = inspect(process.pid);
  const unavailable = process.platform === 'darwin' ? 'MAC_PROCESS_INSPECTION_UNAVAILABLE' : 'PROCESS_INSPECTION_UNAVAILABLE';
  assert.ok(self.state === 'OBSERVED' && self.executable && self.argv?.length && self.generation
    && (Number.isFinite(self.startedAtMs) || /^\d+$/.test(self.startTicks || '')), `${unavailable}: ${JSON.stringify(self)}`);
  if (process.platform === 'linux' && !deps.inspect) {
    const clock = linuxClock();
    fixture.minStartTicks = String(Math.ceil(clock.bootSeconds * clock.hz));
  }
  const controller = createOwnershipController(fixture, { ...deps, inspect,
    sendSignal: deps.sendSignal || ((pid, signal) => process.kill(pid, signal)) });
  const { note, timeline } = controller;
  const launchers = new Set();
  let sealed = false, completed = false;
  const discovery = () => (deps.readDiscovery || readDiscovery)(registry, [fixture.paths.agentLockPath, fixture.paths.agentReadyPath]);
  function environment(extra = {}) {
    assert.equal(sealed, false, 'fixture launch is sealed');
    const env = { ...process.env, ...extra, POTATO_TEST_AGENT_REGISTRY: registry, POTATO_TEST_AGENT_ROOT: fixture.root };
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require="${preload.replaceAll('\\', '/')}"`;
    return env;
  }
  function spawn(command, args, options = {}) {
    assert.equal(sealed, false, 'fixture launch is sealed');
    const child = spawnAgentRegistered(cp.spawn, command, args, { ...options, env: environment(options.env) }, { root: fixture.root, registry });
    launchers.add(child);
    child.once('close', () => launchers.delete(child));
    return child;
  }
  function terminate(pid, signal = 'SIGKILL') {
    const found = discovery();
    if (found.state !== 'DISCOVERY_COMPLETE') { note('discovery-refused', found); return found; }
    return controller.terminate(pid, signal, found.registrations.find(row => row.pid === pid));
  }
  function snapshot() {
    const state = {};
    for (const [name, file] of Object.entries({ owner: fixture.paths.agentLockPath, ready: fixture.paths.agentReadyPath,
      launch: fixture.paths.agentLaunchPath, reaper: fixture.paths.agentReaperPath })) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        state[name] = { pid: value.pid, version: value.version, notificationReady: value.notificationReady };
      } catch (error) { state[name] = { error: error.code || 'invalid' }; }
    }
    return state;
  }
  async function cleanup() {
    if (completed) return;
    sealed = true;
    note('cleanup-begin', { state: snapshot() });
    try {
      let deadline = Date.now() + 5000;
      while (launchers.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(launchers.size, 0, 'DISCOVERY_INCOMPLETE: fixture launchers have not closed');
      const found = discovery(); note('discovery', found);
      assert.equal(found.state, 'DISCOVERY_COMPLETE', JSON.stringify(found));
      const candidates = [...new Set([...found.registrations.map(row => row.pid), ...found.markerPids])];
      const remaining = new Set();
      // Preflight every candidate before signaling any of them.
      for (const pid of candidates) {
        const raw = inspect(pid), registration = found.registrations.find(row => row.pid === pid);
        const result = verifyOwnership(raw, fixture, registration, deps);
        note('cleanup-inspection', { pid, raw, result });
        if (result.state === 'VERIFIED_EXITED') continue;
        if (originalGenerationExited(raw, registration)) {
          note('original-generation-exited', { pid, originalGeneration: registration.generation,
            replacementGeneration: raw.generation, decision: 'NO_SIGNAL_PID_REUSED' });
          continue;
        }
        assert.equal(result.state, 'VERIFIED_OWNED', JSON.stringify({ pid, result }));
        remaining.add(pid);
      }
      for (const pid of remaining) {
        const result = controller.terminate(pid, 'SIGKILL', found.registrations.find(row => row.pid === pid));
        assert.ok(['SIGNALLED', 'VERIFIED_EXITED'].includes(result.state), JSON.stringify({ pid, result }));
      }
      deadline = Date.now() + 5000;
      while (remaining.size && Date.now() < deadline) {
        for (const pid of remaining) {
          const raw = inspectExit(pid); note('exit-verification', { pid, raw });
          if (raw.state === 'VERIFIED_EXITED') remaining.delete(pid);
          else assert.equal(raw.state, 'PROCESS_EXISTS', `cleanup exit query unresolved: ${JSON.stringify(raw)}`);
        }
        if (remaining.size) await new Promise(resolve => setTimeout(resolve, 50));
      }
      // If the OS reused a just-signalled PID before the existence probe saw
      // ESRCH, verify the original generation once at the bounded deadline.
      for (const pid of remaining) {
        const registration = found.registrations.find(row => row.pid === pid);
        const raw = inspect(pid);
        note('exit-deadline-inspection', { pid, raw });
        if (raw.state === 'VERIFIED_EXITED' || originalGenerationExited(raw, registration)) {
          remaining.delete(pid);
          note('original-generation-exited', { pid, originalGeneration: registration.generation,
            replacementGeneration: raw.generation, decision: 'NO_FURTHER_SIGNAL' });
        }
      }
      assert.equal(remaining.size, 0, 'fixture Agent still alive after cleanup deadline');
      completed = true;
      note('cleanup-end', { state: 'CLEANUP_PASS', remaining: [] });
    } catch (error) { note('cleanup-failed', { error: error.message }); throw error; }
    finally {
      fs.writeFileSync(path.join(fixture.root, 'process-cleanup.json'), JSON.stringify(timeline, null, 2));
      t.diagnostic?.(JSON.stringify({ root: fixture.root, cleanup: timeline }));
    }
  }
  t.after(cleanup);
  return { terminate, cleanup, snapshot, timeline, spawn, environment, registry };
}

module.exports = { createAgentCleanup, createOwnershipController, matchesRoot, readDiscovery, spawnAgentRegistered, verifyOwnership };
