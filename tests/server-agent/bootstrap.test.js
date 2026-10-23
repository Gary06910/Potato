'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createCodexHookBridge } = require('../../src/shared/notification/codexHookBridge');
const { readRuntime } = require('../../src/shared/notification/codexHookForwarder');
const { writePrivateJsonAtomic } = require('../../src/shared/credentialStore');
const { createServerAgentPaths } = require('../../src/server-agent/paths');
const instance = require('../../src/server-agent/instance');
const shell = require('../../src/server-agent/shellBootstrap');
const { createAgentCleanup } = require('../helpers/serverAgentFixture');
const { collectChildOutput } = require('../helpers/collectChildOutput');

const cli = path.resolve(__dirname, '..', '..', 'src', 'server-agent', 'cli.js');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';

function fixture() {
  const startedAtMs = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-bootstrap-'));
  const paths = createServerAgentPaths({ root });
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(paths.configRoot, { recursive: true });
  fs.mkdirSync(codexHome);
  fs.writeFileSync(paths.configFile, JSON.stringify({ version: 1, profiles: [
    { id: 'codex', name: 'Codex', codexHome, enabled: true }
  ] }));
  return { root, paths, startedAtMs };
}

function invoke(args, cleanup, timeoutMs = 9000, entry = cli) {
  const child = cleanup.spawn(process.execPath, [entry, ...args], { windowsHide: true });
  return collectChildOutput(child, timeoutMs);
}

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timed out');
}

test('run ownership is atomic, live ownership survives a second claim, and dead ownership is recoverable', () => {
  const { paths } = fixture();
  const first = instance.acquire(paths);
  assert.equal(instance.inspect(paths).state, 'live');
  assert.throws(() => instance.acquire(paths), { code: 'agent_already_running' });
  instance.release(paths, { ...first, nonce: 'f'.repeat(32) });
  assert.equal(instance.inspect(paths).state, 'live');
  instance.release(paths, first);
  assert.equal(instance.inspect(paths).state, 'absent');
  fs.writeFileSync(paths.agentLockPath, JSON.stringify({ version: 1, pid: 2147483647,
    nonce: 'a'.repeat(32), startTicks: null }), { mode: 0o600 });
  assert.equal(instance.inspect(paths).state, 'stale');
  instance.recoverStale(paths);
  assert.equal(instance.inspect(paths).state, 'absent');
});

test('20 parallel ensure commands share one detached usage-only Agent; termination and SIGKILL recovery', async (t) => {
  const f = fixture();
  const { root, paths } = f;
  const cleanup = createAgentCleanup(t, f);
  const args = ['ensure', `--root=${root}`];
  const calls = await Promise.all(Array.from({ length: 20 }, () => invoke(args, cleanup)));
  assert.equal(calls.every((result) => result.code === 0 && result.stdout.includes('READY')), true,
    JSON.stringify(calls.filter((result) => result.code !== 0 || !result.stdout.includes('READY'))));
  const first = await instance.readiness(paths);
  assert.equal(first.state, 'ready');
  assert.equal(first.notificationReady, false);
  const fast = await invoke(args, cleanup);
  assert.equal(fast.code, 0, fast.stderr);
  assert.match(fast.stdout, /READY \/ already-running/);
  // Exercise the direct API in an instrumented launcher too: even an unexpected
  // cold path must inherit registration and forward the explicit synthetic root.
  const apiScript = 'const {createServerAgentPaths}=require("./src/server-agent/paths"); const {ensure}=require("./src/server-agent/instance"); const root=process.argv[1]; ensure(createServerAgentPaths({root}),["--root="+root]).then(value=>console.log(JSON.stringify(value)),()=>{process.exitCode=1;});';
  const apiCall = await invoke([apiScript, root], cleanup, 9000, '-e');
  assert.equal(apiCall.code, 0, apiCall.stderr);
  const direct = JSON.parse(apiCall.stdout);
  assert.equal(direct.result, 'already-running');
  assert.equal(direct.pid, first.pid);
  assert.equal((await instance.readiness(paths)).pid, first.pid);
  const duplicateRun = await invoke(['run', `--root=${root}`], cleanup);
  assert.equal(duplicateRun.code, 1);
  assert.match(duplicateRun.stderr, /agent_already_running/);
  assert.equal((await instance.readiness(paths)).pid, first.pid);
  cleanup.terminate(first.pid, 'SIGTERM');
  await until(() => instance.inspect(paths).state !== 'live', 18000);
  assert.equal(instance.inspect(paths).state, process.platform === 'win32' ? 'stale' : 'absent');
  const cold = await invoke(args, cleanup);
  assert.equal(cold.code, 0, cold.stderr);
  const second = await instance.readiness(paths);
  assert.notEqual(second.pid, first.pid);
  cleanup.terminate(second.pid, 'SIGKILL');
  await until(() => instance.inspect(paths).state === 'stale');
  const recovered = await Promise.all(Array.from({ length: 20 }, () => invoke(args, cleanup)));
  assert.equal(recovered.every((result) => result.code === 0 && result.stdout.includes('READY')), true,
    JSON.stringify(recovered.filter((result) => result.code !== 0 || !result.stdout.includes('READY'))));
  const third = await instance.readiness(paths);
  assert.equal(third.state, 'ready');
  assert.notEqual(third.pid, second.pid);
  cleanup.terminate(third.pid, 'SIGTERM');
  await until(() => instance.inspect(paths).state !== 'live', 18000);
  assert.equal(instance.inspect(paths).state, process.platform === 'win32' ? 'stale' : 'absent');
});

test('parallel bash shims exec each original once, forward arguments and streams, propagate exit status, and share an Agent',
  { skip: process.platform !== 'linux' }, async (t) => {
    const f = fixture();
    const { root, paths } = f;
    const cleanup = createAgentCleanup(t, f);
    const homeDir = path.join(root, 'home');
    const originals = path.join(root, 'originals');
    fs.mkdirSync(homeDir);
    fs.mkdirSync(originals);
    const launcher = path.join(root, 'toknow-agent');
    fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@" '--root=${root}'\n`, { mode: 0o755 });
    const names = ['codex', 'codex-srj', 'codex-plus'];
    for (const [index, name] of names.entries()) {
      fs.writeFileSync(path.join(originals, name),
        `#!/bin/sh\nIFS= read -r INPUT\nprintf 'ORIGINAL:${name}:%s:%s\\n' "$1" "$INPUT"\nprintf 'STDERR:${name}\\n' >&2\nexit ${31 + index}\n`, { mode: 0o755 });
    }
    shell.install({ paths, homeDir, launcher, commands: names, envPath: originals });
    const shimDir = shell.locations(paths, homeDir).shimDir;
    const calls = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
      const name = names[index % names.length];
      const child = cleanup.spawn(path.join(shimDir, name), [`argument-${index}`], {
        env: { ...process.env, PATH: `${shimDir}:${originals}:${process.env.PATH}` }
      });
      const output = collectChildOutput(child);
      child.stdin.end(`input-${index}\n`);
      return { name, index, ...await output };
    }));
    for (const call of calls) {
      assert.equal(call.stdout.trim(), `ORIGINAL:${call.name}:argument-${call.index}:input-${call.index}`);
      assert.equal(call.stderr.trim(), `STDERR:${call.name}`);
      assert.equal(call.code, 31 + names.indexOf(call.name));
    }
    const agent = await instance.readiness(paths);
    assert.equal(agent.state, 'ready');
    // Cleanup was registered before invoking the first shim.
    const second = await invoke(['ensure', `--root=${root}`], cleanup);
    assert.equal(second.code, 0);
    assert.equal((await instance.readiness(paths)).pid, agent.pid);
    fs.writeFileSync(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failOpen = await (async () => {
      const child = cleanup.spawn(path.join(shimDir, 'codex'), ['still-starts'], {
        env: { ...process.env, PATH: `${shimDir}:${originals}:${process.env.PATH}` }
      });
      const output = collectChildOutput(child);
      child.stdin.end('input\n');
      return output;
    })();
    assert.equal(failOpen.code, 31);
    assert.match(failOpen.stdout, /ORIGINAL:codex:still-starts:input/);
    assert.match(failOpen.stderr, /Agent unavailable; continuing Codex/);
  });

test('Git Bash fixture executes dynamic shims without recursion and keeps original streams and exit code',
  { skip: process.platform !== 'win32' || !fs.existsSync(gitBash) }, async (t) => {
    const f = fixture();
    const { root, paths } = f;
    const cleanup = createAgentCleanup(t, f);
    const shimDir = path.join(root, 'shims');
    const aliases = path.join(root, 'aliases');
    const originals = path.join(root, 'originals');
    fs.mkdirSync(shimDir);
    fs.mkdirSync(aliases);
    fs.mkdirSync(originals);
    const posix = (value) => {
      const result = spawnSync(gitBash, ['-c', 'cygpath -u "$1"', '_', value], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const agent = path.join(root, 'toknow-agent');
    fs.writeFileSync(agent, `#!/bin/bash\nexec '${posix(process.execPath)}' '${cli}' "$@" '--root=${root}'\n`, { mode: 0o755 });
    const names = ['codex', 'codex-srj', 'codex-plus'];
    for (const [index, name] of names.entries()) {
      fs.writeFileSync(path.join(originals, name),
        `#!/bin/bash\nIFS= read -r INPUT\nprintf 'ORIGINAL:${name}:%s:%s\\n' "$1" "$INPUT"\nprintf 'STDERR:${name}\\n' >&2\nexit ${41 + index}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(shimDir, name), shell.shimText(name, posix(agent)), { mode: 0o755 });
      fs.linkSync(path.join(shimDir, name), path.join(aliases, name));
    }
    const environment = { ...process.env, PATH: `${posix(shimDir)}:${posix(aliases)}:${posix(originals)}:/usr/bin` };
    const calls = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
      const name = names[index % names.length];
      const child = cleanup.spawn(gitBash, [posix(path.join(shimDir, name)), `arg-${index}`], { env: environment });
      const output = collectChildOutput(child);
      child.stdin.end(`input-${index}\n`);
      return { name, index, ...await output };
    }));
    for (const call of calls) {
      assert.equal(call.stdout.trim(), `ORIGINAL:${call.name}:arg-${call.index}:input-${call.index}`);
      assert.equal(call.stderr.trim(), `STDERR:${call.name}`);
      assert.equal(call.code, 41 + names.indexOf(call.name));
    }
    const running = await instance.readiness(paths);
    assert.equal(running.state, 'ready');
    fs.writeFileSync(agent, '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    const failOpen = await (async () => {
      const child = cleanup.spawn(gitBash, [posix(path.join(shimDir, 'codex')), 'still-starts'], { env: environment });
      const output = collectChildOutput(child);
      child.stdin.end('input\n');
      return output;
    })();
    assert.equal(failOpen.code, 41);
    assert.match(failOpen.stdout, /ORIGINAL:codex:still-starts:input/);
    assert.match(failOpen.stderr, /Agent unavailable; continuing Codex/);
    cleanup.terminate(running.pid, 'SIGTERM');
  });

test('authenticated local health has no completion side effects', async (t) => {
  let completions = 0;
  const token = '0123456789abcdef0123456789abcdef';
  const bridge = createCodexHookBridge({ token, onCompletion: async () => { completions += 1; } });
  t.after(() => bridge.stop());
  const address = await bridge.start();
  assert.equal(address.host, '127.0.0.1');
  const url = `http://${address.host}:${address.port}/health`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { 'x-token-m-bridge-token': token } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
  assert.equal(completions, 0);
});

test('configured readiness verifies the version-1 Hook runtime through authenticated health', async (t) => {
  const { paths } = fixture();
  const owner = instance.acquire(paths);
  t.after(() => instance.release(paths, owner));
  const token = crypto.randomBytes(32).toString('base64url');
  const bridge = createCodexHookBridge({ token, onCompletion: async () => {} });
  t.after(() => bridge.stop());
  const address = await bridge.start();
  writePrivateJsonAtomic(paths.notificationRuntimePath, { version: 1, host: '127.0.0.1', port: address.port, token });
  instance.markReady(paths, owner, { state: 'ready' });
  assert.equal(readRuntime(paths.notificationRuntimePath).version, 1);
  assert.deepEqual(await instance.readiness(paths), { state: 'ready', pid: process.pid, notificationReady: true });
  writePrivateJsonAtomic(paths.notificationRuntimePath, { version: 1, host: '127.0.0.1', port: address.port,
    token: crypto.randomBytes(32).toString('base64url') });
  assert.equal((await instance.readiness(paths)).state, 'starting');
});

test('ensure reports a bounded safe error for invalid configuration', async (t) => {
  const f = fixture();
  const { root, paths } = f;
  const cleanup = createAgentCleanup(t, f);
  fs.writeFileSync(paths.configFile, '{invalid-json');
  const result = await invoke(['ensure', `--root=${root}`], cleanup);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /server-agent failed: config-read-failed/);
  assert.equal(result.stderr.includes(root), false);
  assert.equal(result.stderr.includes('CODEX_HOME'), false);
});

test('shell registration preserves bashrc, validates names, updates once, and removes one exact shim at a time', async () => {
  const { root, paths } = fixture();
  const homeDir = path.join(root, 'home');
  const originals = path.join(root, 'originals');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(originals);
  const names = ['codex', 'codex-srj', 'codex-plus'];
  assert.equal(shell.validateName('cdex-srj'), 'cdex-srj');
  for (const name of names) fs.writeFileSync(path.join(originals, name), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const bashrc = path.join(homeDir, '.bashrc');
  fs.writeFileSync(bashrc, '# user content\n');
  const launcher = path.join(root, 'toknow-agent');
  const options = { paths, homeDir, envPath: originals, launcher };
  shell.install({ ...options, commands: names });
  shell.install({ ...options, commands: ['codex'] });
  const content = fs.readFileSync(bashrc, 'utf8');
  assert.equal(content.startsWith('# user content\n'), true);
  assert.equal(content.split(shell.START).length - 1, 1);
  assert.match(shell.shimText('codex', launcher), /exec "\$ORIGINAL" "\$@"/);
  assert.match(shell.shimText('codex', launcher), /Agent unavailable; continuing Codex/);
  const active = await shell.status({ paths, homeDir, envPath: `${shell.locations(paths, homeDir).shimDir}${path.delimiter}${originals}` });
  assert.equal(active.shimActive, true);
  assert.equal(active.agentRunning, false);
  assert.equal(JSON.stringify(active).includes('CODEX_HOME'), false);
  assert.throws(() => shell.install({ ...options, launcher: 'relative-agent', commands: ['codex'] }),
    { code: 'invalid_agent_launcher' });
  for (const invalid of ['', '../codex', 'codex*', 'codex;id', 'a\nb', 'a\\b']) {
    assert.throws(() => shell.validateName(invalid), { code: 'invalid_launcher_name' });
  }
  assert.throws(() => shell.install({ ...options, commands: ['unknown'] }), { code: 'original_launcher_missing' });
  fs.writeFileSync(bashrc, `${shell.START}\n# damaged\n`);
  assert.throws(() => shell.remove({ paths, command: 'codex', homeDir }), { code: 'invalid_shell_marker' });
  fs.writeFileSync(bashrc, content);
  shell.remove({ paths, command: 'codex', homeDir });
  shell.remove({ paths, command: 'codex-srj', homeDir });
  shell.remove({ paths, command: 'codex-plus', homeDir });
  assert.equal(fs.readFileSync(bashrc, 'utf8'), '# user content\n');
  assert.equal(fs.existsSync(path.join(originals, 'codex')), true);
  fs.writeFileSync(bashrc, `${shell.START}\n# broken\n`);
  assert.throws(() => shell.install({ ...options, commands: ['codex'] }), { code: 'invalid_shell_marker' });
});
