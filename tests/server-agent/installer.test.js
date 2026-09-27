'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const installSource = path.join(root, 'install.sh');
const serviceSource = path.join(root, 'packaging', 'server-agent', 'toknow-agent.service');

function shellPath() {
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    ]
    : ['sh'];
  return candidates.find((candidate) => candidate && (candidate === 'sh' || fs.existsSync(candidate))) || 'sh';
}

function createFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-server-agent-installer-'));
  const packageRoot = path.join(tempRoot, 'package');
  const home = path.join(tempRoot, 'home');
  const fakeBin = path.join(packageRoot, 'fake-bin');
  const configHome = path.join(home, '.config');
  const systemctlLog = path.join(home, 'systemctl.log');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'systemd'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'VERSION'), '1.0.0\n', 'utf8');
  fs.copyFileSync(installSource, path.join(packageRoot, 'install.sh'));
  fs.copyFileSync(serviceSource, path.join(packageRoot, 'systemd', 'toknow-agent.service'));
  fs.writeFileSync(path.join(packageRoot, 'bin', 'toknow-agent'), '#!/bin/sh\nexit 0\n', 'utf8');
  fs.writeFileSync(
    path.join(fakeBin, 'systemctl'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "${TO_KNOW_SYSTEMCTL_LOG:-$HOME/systemctl.log}"\nif [ "${TO_KNOW_SYSTEMCTL_FAIL:-0}" = "1" ]; then exit 1; fi\n',
    'utf8'
  );

  return { configHome, fakeBin, home, packageRoot, systemctlLog };
}

function runInstall(fixture, args = [], overrides = {}) {
  const inheritedPath = process.env.PATH || '';
  const shellToolPath = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\bin', inheritedPath].join(path.delimiter)
    : inheritedPath;
  const pathEntries = overrides.includeFakeSystemctl === false
    ? shellToolPath
    : `${fixture.fakeBin}${path.delimiter}${shellToolPath}`;
  const env = {
    ...process.env,
    HOME: fixture.home,
    PATH: pathEntries,
    ...overrides.env
  };
  return spawnSync(shellPath(), ['install.sh', ...args], {
    cwd: fixture.packageRoot,
    encoding: 'utf8',
    env
  });
}

function unitPath(fixture) {
  return path.join(fixture.configHome, 'systemd', 'user', 'toknow-agent.service');
}

function systemctlCalls(fixture) {
  try {
    return fs.readFileSync(fixture.systemctlLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
    return [];
  }
}

test('plain install does not call systemctl or enable a service', () => {
  const fixture = createFixture();
  const result = runInstall(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(systemctlCalls(fixture), []);
  assert.equal(fs.existsSync(unitPath(fixture)), false);
  assert.equal(fs.existsSync(path.join(fixture.home, '.local', 'bin', 'toknow-agent')), true);
});

test('--service-manager container-external installs the launcher and prints its runtime contract', () => {
  const fixture = createFixture();
  const result = runInstall(fixture, ['--service-manager', 'container-external']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Service backend: container-external/);
  assert.match(result.stdout, /toknow-agent run/);
  assert.match(result.stdout, /SIGTERM/);
  assert.match(result.stdout, /15s/);
  assert.match(result.stdout, /Persistent config:/);
  assert.match(result.stdout, /Persistent runtime data:/);
  assert.deepEqual(systemctlCalls(fixture), []);
  assert.equal(fs.existsSync(unitPath(fixture)), false);
});

test('unsupported service manager fails before runtime installation', () => {
  const fixture = createFixture();
  const result = runInstall(fixture, ['--service-manager', 'openrc']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported service manager/i);
  assert.equal(fs.existsSync(path.join(fixture.home, '.local', 'bin', 'toknow-agent')), false);
  assert.deepEqual(systemctlCalls(fixture), []);
});

test('--user-service installs the unit, reloads the user manager, and enables now', () => {
  const fixture = createFixture();
  const result = runInstall(fixture, ['--user-service']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(unitPath(fixture), 'utf8'), fs.readFileSync(serviceSource, 'utf8'));
  assert.deepEqual(systemctlCalls(fixture), [
    '--user daemon-reload',
    '--user enable --now toknow-agent.service'
  ]);
});

test('--service-manager systemd-user preserves the existing unit contract', () => {
  const fixture = createFixture();
  const result = runInstall(fixture, ['--service-manager', 'systemd-user']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(unitPath(fixture), 'utf8'), fs.readFileSync(serviceSource, 'utf8'));
  assert.deepEqual(systemctlCalls(fixture), [
    '--user daemon-reload',
    '--user enable --now toknow-agent.service'
  ]);
});

test('--user-service rejects a non-default prefix before calling systemctl', () => {
  const fixture = createFixture();
  const result = runInstall(fixture, ['--user-service', '--prefix', path.join(fixture.packageRoot, 'custom')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires the default install root/i);
  assert.deepEqual(systemctlCalls(fixture), []);
});

test('--user-service fails clearly when systemctl is missing', () => {
  const fixture = createFixture();
  const result = runInstall(fixture, ['--user-service'], { includeFakeSystemctl: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires systemctl/i);
  assert.equal(fs.existsSync(unitPath(fixture)), false);
});

test('--user-service does not overwrite an unknown existing unit', () => {
  const fixture = createFixture();
  fs.mkdirSync(path.dirname(unitPath(fixture)), { recursive: true });
  fs.writeFileSync(unitPath(fixture), '[Service]\nExecStart=/custom/service\n', 'utf8');
  const result = runInstall(fixture, ['--user-service']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not managed by Potato/i);
  assert.equal(fs.readFileSync(unitPath(fixture), 'utf8'), '[Service]\nExecStart=/custom/service\n');
  assert.deepEqual(systemctlCalls(fixture), []);
});

test('--user-service safely updates a unit explicitly marked as To Know managed', () => {
  const fixture = createFixture();
  fs.mkdirSync(path.dirname(unitPath(fixture)), { recursive: true });
  fs.writeFileSync(unitPath(fixture), '# Managed by To Know Server Agent installer.\n[Service]\n', 'utf8');
  const result = runInstall(fixture, ['--user-service']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(unitPath(fixture), 'utf8'), fs.readFileSync(serviceSource, 'utf8'));
});

test('--user-service fails if the user manager cannot reload', () => {
  const fixture = createFixture();
  const result = runInstall(fixture, ['--user-service'], { env: { TO_KNOW_SYSTEMCTL_FAIL: '1' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /daemon-reload failed/i);
  assert.equal(fs.existsSync(unitPath(fixture)), true);
});
