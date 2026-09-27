'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createServerAgentPaths } = require('../../src/server-agent/paths');
const { readRuntime } = require('../../src/shared/notification/codexHookForwarder');
const { writePrivateJsonAtomic } = require('../../src/shared/credentialStore');

const root = path.resolve(__dirname, '..', '..');
const cliPath = path.join(root, 'src', 'server-agent', 'cli.js');
const DESKTOP_ID = 'dev_11111111-1111-4111-8111-111111111111';
const CREDENTIAL = `tm_uc_d1.${DESKTOP_ID}.${'x'.repeat(43)}`;

function removeFixture(rootPath) {
  if (!fs.existsSync(rootPath)) return;
  const removeFilesIn = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isFile()) fs.unlinkSync(candidate);
    }
  };
  const directories = [
    path.join(rootPath, 'state', 'toknow-agent', 'notification'),
    path.join(rootPath, 'state', 'toknow-agent'),
    path.join(rootPath, 'data', 'toknow-agent'),
    path.join(rootPath, 'config', 'toknow-agent'),
    path.join(rootPath, 'codex'),
    path.join(rootPath, 'state', 'toknow-agent', 'profiles'),
    path.join(rootPath, 'state'),
    path.join(rootPath, 'data'),
    path.join(rootPath, 'config'),
    rootPath
  ];
  for (const directory of directories) removeFilesIn(directory);
  for (const directory of directories) {
    try { fs.rmdirSync(directory); } catch (_) {}
  }
}

function fixture(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-server-cli-'));
  const paths = createServerAgentPaths({ root: rootPath });
  const codexHome = path.join(rootPath, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(paths.configRoot, { recursive: true });
  fs.writeFileSync(paths.configFile, `${JSON.stringify({
    version: 1,
    endpoint: 'https://android.example.test/tokenm-desktop-http',
    profiles: [{ id: 'business', name: 'Business', codexHome, enabled: true }]
  })}\n`, 'utf8');
  writePrivateJsonAtomic(paths.credentialFile, {
    version: 1,
    credential: CREDENTIAL,
    desktopId: DESKTOP_ID,
    desktopName: 'A800 Server'
  });
  t.after(() => removeFixture(rootPath));
  return { rootPath, paths, codexHome };
}

function runCli(args, input = '') {
  return spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') }
  });
}

function rootArgs(rootPath, launcher = '/home/user/.local/bin/toknow-agent') {
  return ['--root', rootPath, '--launcher', launcher];
}

test('help and version are informational with valid, missing, malformed, or invalid runtime config', (t) => {
  const { rootPath, paths } = fixture(t);
  for (const configState of ['valid', 'missing', 'malformed', 'invalid']) {
    if (configState === 'missing') fs.unlinkSync(paths.configFile);
    if (configState === 'malformed') fs.writeFileSync(paths.configFile, '{invalid-json', 'utf8');
    if (configState === 'invalid') fs.writeFileSync(paths.configFile, '{"version":2,"profiles":[]}', 'utf8');
    const before = fs.readdirSync(rootPath, { recursive: true }).sort();
    for (const flag of ['--help', '--version']) {
      const result = runCli([flag, '--root', rootPath]);
      assert.equal(result.status, 0, `${configState} ${flag}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /Potato Server Agent/);
      if (flag === '--help') assert.match(result.stdout, /toknow-agent <command>/);
      else assert.equal(result.stdout.trim(), 'Potato Server Agent 1.0.0');
      assert.deepEqual(fs.readdirSync(rootPath, { recursive: true }).sort(), before);
      assert.equal(fs.existsSync(paths.agentLockPath), false);
      assert.equal(fs.existsSync(paths.supervisorPidPath), false);
      assert.equal(fs.existsSync(paths.profilesRoot), false);
    }
  }
});

test('once still rejects malformed runtime config before starting an Agent', (t) => {
  const { rootPath, paths } = fixture(t);
  fs.writeFileSync(paths.configFile, '{invalid-json', 'utf8');
  const result = runCli(['once', '--root', rootPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config-read-failed/);
  assert.equal(fs.existsSync(paths.agentLockPath), false);
  assert.equal(fs.existsSync(paths.supervisorPidPath), false);
});

test('notification runtime file diagnostics use the Potato description', (t) => {
  const { paths } = fixture(t);
  assert.throws(() => readRuntime(paths.configRoot), /Potato notification runtime must be a regular file/);
});

test('service detect CLI emits backend availability and a safe runtime contract', () => {
  const result = runCli(['service', 'detect']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report.backends), [
    'systemd-user',
    'supervisord',
    'container-external',
    'none'
  ]);
  assert.equal(['systemd-user', 'supervisord', 'container-external', 'none'].includes(report.recommended), true);
  assert.equal(report.runtimeContract.command.at(-1), 'run');
  assert.equal(report.runtimeContract.stopSignal, 'SIGTERM');
  assert.equal(report.runtimeContract.stopTimeoutSeconds, 15);
  assert.deepEqual(report.runtimeContract.requiredPersistentRoots, [
    '~/.config/toknow-agent',
    '~/.local/share/toknow-agent',
    '~/.local/state/toknow-agent'
  ]);
  assert.doesNotMatch(result.stdout, /Authorization|ownerId|CID|CODEX_HOME|tm_uc_d1\.|KUBERNETES_SERVICE_HOST=/i);
});

test('hooks status/enable/disable keep trust explicit and preserve profile-local hooks', (t) => {
  const setup = fixture(t);
  const before = runCli(['hooks', 'status', '--profile', 'business', ...rootArgs(setup.rootPath)]);
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(JSON.parse(before.stdout), {
    profileId: 'business',
    configured: false,
    configFileState: 'missing',
    needsTrust: false,
    error: null
  });

  fs.writeFileSync(path.join(setup.codexHome, 'hooks.json'), `${JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] },
    retained: true
  })}\n`, 'utf8');
  const enabled = runCli(['hooks', 'enable', '--profile', 'business', ...rootArgs(setup.rootPath)]);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.stderr, '');
  assert.deepEqual(JSON.parse(enabled.stdout), { profileId: 'business', configured: true, needsTrust: true });
  const hooks = JSON.parse(fs.readFileSync(path.join(setup.codexHome, 'hooks.json'), 'utf8'));
  assert.equal(hooks.retained, true);
  assert.equal(hooks.hooks.Stop[1].hooks[0].command, "'/home/user/.local/bin/toknow-agent' hook --profile 'business'");

  const status = runCli(['hooks', 'status', '--profile', 'business', ...rootArgs(setup.rootPath)]);
  assert.equal(status.status, 0, status.stderr);
  const statusValue = JSON.parse(status.stdout);
  assert.equal(statusValue.configured, true);
  assert.equal(statusValue.needsTrust, true);
  assert.equal(JSON.stringify(statusValue).includes('trust: true'), false);
  assert.equal(JSON.stringify(statusValue).includes('CODEX_HOME'), false);

  const disabled = runCli(['hooks', 'disable', '--profile', 'business', ...rootArgs(setup.rootPath)]);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout), { profileId: 'business', configured: false, needsTrust: false });
  const restored = JSON.parse(fs.readFileSync(path.join(setup.codexHome, 'hooks.json'), 'utf8'));
  assert.equal(restored.retained, true);
  assert.equal(restored.hooks.Stop.length, 1);
  assert.equal(restored.hooks.Stop[0].hooks[0].command, 'other-tool');
});

test('hooks enable fails closed when the Server credential is absent', (t) => {
  const setup = fixture(t);
  fs.unlinkSync(setup.paths.credentialFile);
  const result = runCli(['hooks', 'enable', '--profile', 'business', ...rootArgs(setup.rootPath)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notification_not_configured/);
  assert.doesNotMatch(result.stderr, /tm_uc_d1|CODEX_HOME/);
});

test('hook CLI is fail-open for missing runtime and refused bridge connections', async (t) => {
  const setup = fixture(t);
  const input = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: 'C:\\private\\codex'
  });
  const missing = runCli(['hook', '--profile', 'business', ...rootArgs(setup.rootPath)], input);
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /stage=runtime-read/);
  assert.doesNotMatch(missing.stderr, /private|C:\\|CODEX_HOME|tm_uc_d1/);

  const server = http.createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close((error) => error ? reject(error) : resolve(value));
    });
  });
  writePrivateJsonAtomic(setup.paths.notificationRuntimePath, {
    version: 1,
    host: '127.0.0.1',
    port,
    token: 'a'.repeat(43)
  });
  const refused = runCli(['hook', '--profile', 'business', ...rootArgs(setup.rootPath)], input);
  assert.equal(refused.status, 0);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /stage=request code=(?:ECONNREFUSED|connection_failure)/);
});

test('hook CLI rejects malformed profile locally while keeping the Codex exit open', (t) => {
  const setup = fixture(t);
  const result = runCli(['hook', '--profile', 'Business', ...rootArgs(setup.rootPath)], '{}');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /Business|CODEX_HOME|tm_uc_d1/);
});
