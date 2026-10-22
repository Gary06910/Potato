'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const instance = require('../../src/server-agent/instance');
const { createServerAgentPaths } = require('../../src/server-agent/paths');
const { createAgentCleanup, matchesRoot } = require('../helpers/serverAgentFixture');
const cli = path.resolve(__dirname, '../../src/server-agent/cli.js');
const preload = path.resolve(__dirname, '../fixtures/serverAgentFaultPreload.js').replaceAll('\\', '/');

function fixture(t) {
  const startedAtMs = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent recovery-'));
  const paths = createServerAgentPaths({ root });
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome); fs.mkdirSync(paths.configRoot, { recursive: true });
  fs.writeFileSync(paths.configFile, JSON.stringify({ version: 1, profiles: [{ id: 'codex', name: 'Codex', codexHome, enabled: true }] }));
  const f = { root, paths, startedAtMs };
  return { ...f, cleanup: createAgentCleanup(t, f) };
}

function invoke(f, fault) {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const child = f.cleanup.spawn(process.execPath, [cli, 'ensure', `--root=${f.root}`], {
      windowsHide: true,
      env: { ...process.env, POTATO_TEST_AGENT_FAULT: fault || '',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${preload}"` }
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-4096); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture CLI exceeded 9s bound')); }, 9000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ pid: child.pid, startMs, endMs: Date.now(), code, signal, stdout, stderr }); });
  });
}

async function ready(f, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await instance.readiness(f.paths);
    if (state.state === 'ready') return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('fixture ready deadline');
}

test('a single cold ensure returns an actual usage-only ready owner', async t => {
  const f = fixture(t); const result = await invoke(f);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 0); assert.equal((await ready(f)).notificationReady, false);
});

test('stale launch ownership is recovered before a cold ensure', async t => {
  const f = fixture(t); fs.mkdirSync(f.paths.stateRoot, { recursive: true });
  fs.writeFileSync(f.paths.agentLaunchPath, JSON.stringify({ version: 1, pid: 2147483647, nonce: 'a'.repeat(32), startTicks: null }));
  assert.equal((await invoke(f)).code, 0);
  assert.equal((await ready(f)).state, 'ready');
  assert.equal(fs.existsSync(f.paths.agentLaunchPath), false);
  assert.equal(fs.existsSync(f.paths.agentReaperPath), false);
});

test('a stale ready marker is never accepted without matching live ownership', async t => {
  const f = fixture(t); fs.mkdirSync(f.paths.stateRoot, { recursive: true });
  fs.writeFileSync(f.paths.agentReadyPath, JSON.stringify({ version: 1, pid: 2147483647, nonce: 'b'.repeat(32), notificationRequired: false, notificationReady: false }));
  assert.equal((await instance.readiness(f.paths)).state, 'absent');
  assert.equal((await invoke(f)).code, 0);
  assert.notEqual((await ready(f)).pid, 2147483647);
});

test('slow run entry preserves one owner and returns ready within the existing budget', async t => {
  const f = fixture(t); const result = await invoke(f, 'slow-entry');
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 0, result.stderr);
  const state = await ready(f);
  const owner = JSON.parse(fs.readFileSync(f.paths.agentLockPath, 'utf8'));
  assert.equal(state.pid, owner.pid);
});

test('late ready remains a real bounded timeout then a later ensure finds the owner', async t => {
  const f = fixture(t); const result = await invoke(f, 'late-ready');
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 1); assert.match(result.stderr, /agent_start_timeout/);
  assert.ok(result.endMs - result.startMs >= 4900 && result.endMs - result.startMs < 9000);
  const state = await ready(f);
  const second = await invoke(f);
  assert.equal(second.code, 0); assert.match(second.stdout, /already-running/);
  assert.equal((await ready(f)).pid, state.pid);
});

test('a bounded child startup failure permits a subsequent healthy ensure', async t => {
  const f = fixture(t); const failed = await invoke(f, 'startup-exit');
  assert.equal(failed.code, 1); assert.match(failed.stderr, /agent_start_timeout/);
  assert.equal(fs.existsSync(f.paths.agentLaunchPath), false);
  const result = await invoke(f); assert.equal(result.code, 0, result.stderr);
  assert.equal((await ready(f)).state, 'ready');
});

test('cleanup finds a daemon even when an assertion failed before its PID was registered', async t => {
  let finalize;
  const f = fixture({ after(callback) { finalize = callback; }, diagnostic: value => t.diagnostic(value) });
  t.after(() => finalize());
  assert.equal((await invoke(f)).code, 0);
  const state = await ready(f);
  // Model the old third-readiness assertion failure with no tracked PID set.
  assert.throws(() => assert.fail('synthetic failure before cleanup registration'));
  await finalize();
  assert.notEqual((await instance.readiness(f.paths)).state, 'ready');
  assert.ok(f.cleanup.timeline.some(item => item.event === 'verified-termination' && item.pid === state.pid));
});

test('fixture argv matching rejects another root and a non-run command', () => {
  const canonical = value => value;
  const root = path.resolve('synthetic fixture with spaces');
  const argv = [process.execPath, cli, 'run', `--root=${root}`];
  assert.equal(matchesRoot(argv, root, cli, canonical), true);
  assert.equal(matchesRoot([...argv.slice(0, 3), `--root=${root}-other`], root, cli, canonical), false);
  assert.equal(matchesRoot([argv[0], cli, 'ensure', argv[3]], root, cli, canonical), false);
});

test('parent spawn registry covers real detached children blocked before any owner or ready marker', async t => {
  const f = fixture(t);
  const result = await invoke(f, 'entry-gate');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /agent_start_timeout/);
  assert.equal(fs.existsSync(f.paths.agentLockPath), false);
  assert.equal(fs.existsSync(f.paths.agentReadyPath), false);
  const { readDiscovery } = require('../helpers/serverAgentFixture');
  const before = readDiscovery(f.cleanup.registry, []);
  assert.equal(before.state, 'DISCOVERY_COMPLETE');
  assert.ok(before.registrations.length > 0);
  await f.cleanup.cleanup();
  assert.equal(f.cleanup.timeline.at(-1).state, 'CLEANUP_PASS');
  for (const row of before.registrations) {
    assert.ok(f.cleanup.timeline.some(item => item.event === 'verified-termination' && item.pid === row.pid));
    assert.ok(f.cleanup.timeline.some(item => item.event === 'exit-verification' && item.pid === row.pid && item.raw.state === 'VERIFIED_EXITED'));
  }
});
