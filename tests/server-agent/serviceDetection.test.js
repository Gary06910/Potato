'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  decodeMountPath,
  detectServiceEnvironment,
  inspectSupervisorBackend,
  mountTypeForPath,
  parseSupervisorIncludePatterns,
  supervisorConfigFromPid1
} = require('../../src/server-agent/serviceDetection');

class FixtureFileSystem {
  constructor() {
    this.directories = new Set(['/']);
    this.files = new Map();
    this.handles = new Map();
    this.nextHandle = 1;
    this.mutations = [];
  }

  addDirectory(directory, { writable = true, symlink = false } = {}) {
    const absolute = path.posix.normalize(directory);
    const parts = absolute.split('/').filter(Boolean);
    let cursor = '/';
    for (const part of parts) {
      cursor = path.posix.join(cursor, part);
      this.directories.add(cursor);
    }
    if (symlink) this.files.set(absolute, { type: 'symlink', writable, data: '' });
    return absolute;
  }

  addFile(filePath, content = '', { writable = true } = {}) {
    const absolute = path.posix.normalize(filePath);
    this.addDirectory(path.posix.dirname(absolute));
    this.files.set(absolute, { type: 'file', writable, data: String(content) });
    return absolute;
  }

  statSync(filePath) {
    const absolute = path.posix.normalize(filePath);
    const entry = this.files.get(absolute);
    if (entry && entry.type !== 'symlink') return this.statObject('file', entry);
    if (entry?.type === 'symlink') throw Object.assign(new Error('fixture path missing'), { code: 'ENOENT' });
    if (this.directories.has(absolute)) return this.statObject('directory', { writable: true });
    throw Object.assign(new Error('fixture path missing'), { code: 'ENOENT' });
  }

  lstatSync(filePath) {
    const absolute = path.posix.normalize(filePath);
    const entry = this.files.get(absolute);
    if (entry) return this.statObject(entry.type, entry);
    if (this.directories.has(absolute)) return this.statObject('directory', { writable: true });
    throw Object.assign(new Error('fixture path missing'), { code: 'ENOENT' });
  }

  statObject(type, entry) {
    return {
      size: Buffer.byteLength(entry.data || '', 'utf8'),
      isFile: () => type === 'file',
      isDirectory: () => type === 'directory',
      isSymbolicLink: () => type === 'symlink'
    };
  }

  accessSync(filePath) {
    const entry = this.files.get(path.posix.normalize(filePath));
    const dirExists = this.directories.has(path.posix.normalize(filePath));
    if (entry?.writable === false || (!entry && !dirExists)) {
      throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    }
  }

  realpathSync(filePath) {
    const absolute = path.posix.normalize(filePath);
    this.lstatSync(absolute);
    return absolute;
  }

  readFileSync(filePath, encoding) {
    const entry = this.files.get(path.posix.normalize(filePath));
    if (!entry || entry.type !== 'file') throw Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
    return encoding ? entry.data : Buffer.from(entry.data);
  }

  openSync(filePath) {
    const absolute = path.posix.normalize(filePath);
    const entry = this.files.get(absolute);
    if (!entry || entry.type !== 'file') throw Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
    const handle = this.nextHandle++;
    this.handles.set(handle, entry.data);
    return handle;
  }

  readSync(handle, buffer, offset, length) {
    const value = Buffer.from(this.handles.get(handle) || '');
    const bytes = value.subarray(0, length);
    bytes.copy(buffer, offset);
    return bytes.length;
  }

  closeSync(handle) {
    this.handles.delete(handle);
  }

  readdirSync(directory, options = {}) {
    const normalized = path.posix.normalize(directory);
    if (!this.directories.has(normalized)) throw Object.assign(new Error('fixture directory missing'), { code: 'ENOENT' });
    const entries = [];
    for (const filePath of this.files.keys()) {
      if (path.posix.dirname(filePath) !== normalized) continue;
      const entry = this.files.get(filePath);
      entries.push({
        name: path.posix.basename(filePath),
        isFile: () => entry.type === 'file',
        isDirectory: () => false,
        isSymbolicLink: () => entry.type === 'symlink'
      });
    }
    return options.withFileTypes ? entries : entries.map((entry) => entry.name);
  }
}

function baseFs() {
  const fsApi = new FixtureFileSystem();
  fsApi.addFile('/proc/1/comm', 'unknown\n');
  fsApi.addFile('/proc/1/cmdline', '/sbin/init\0');
  fsApi.addFile('/proc/1/cgroup', '0::/init.scope\n');
  fsApi.addFile('/proc/self/mountinfo', '1 0 0:1 / / rw - ext4 /dev/root rw\n');
  return fsApi;
}

function dependencySet(fsApi, available, { systemdOnline = false, supervisorOnline = false } = {}) {
  const commands = [];
  const commandAvailable = (name) => available.includes(name);
  const runCommand = (name, args) => {
    commands.push([name, ...args]);
    if (name === 'systemctl' && args[1] === 'show-environment') {
      return systemdOnline
        ? { status: 0, stdout: 'PRIVATE_TOKEN=must-not-leak\n' }
        : { status: 1, stdout: '', stderr: 'not connected' };
    }
    if (name === 'systemctl' && args[1] === 'is-system-running') {
      return { status: 0, stdout: 'running\n' };
    }
    if (name === 'supervisord') return { status: 0, stdout: '4.2.5\n' };
    if (name === 'supervisorctl') {
      return supervisorOnline
        ? { status: 0, stdout: 'toknow-agent RUNNING pid 123, uptime 0:01:00\n' }
        : { status: 1, stdout: '', stderr: 'unix socket unavailable' };
    }
    return { status: 1, stdout: '' };
  };
  return { fsApi, commandAvailable, runCommand, commands };
}

function addSupervisorFixture(fsApi, { configPath = '/etc/supervisor/supervisord.conf', include = 'conf.d/*.conf' } = {}) {
  const configDir = path.posix.dirname(configPath);
  fsApi.addDirectory(configDir);
  const includeDir = path.posix.resolve(configDir, path.posix.dirname(include));
  fsApi.addDirectory(includeDir);
  fsApi.addFile(configPath, `[supervisorctl]\nserverurl=unix:///tmp/supervisor.sock\n[include]\nfiles=${include}\n`);
  fsApi.addFile(path.posix.join(includeDir, 'existing.conf'), '[program:existing]\ncommand=/bin/true\n');
  return { configPath, includeDir };
}

test('current A800 fixture recommends container-external when supervisor control is unavailable', () => {
  const fsApi = baseFs();
  fsApi.addFile('/.dockerenv', '');
  fsApi.addFile('/proc/1/comm', 'supervisord\n');
  fsApi.addFile('/proc/1/cmdline', 'supervisord\0-c\0/usr/local/iCompute/etc/supervisord/supervisord.conf\0');
  fsApi.addFile('/proc/1/cgroup', '0::/kubepods.slice/pod-abc/containerd-xyz\n');
  fsApi.addFile('/proc/self/mountinfo', [
    '1 0 0:1 / / rw - overlay overlay rw',
    '2 1 0:2 / /home rw - ceph ceph-fuse rw'
  ].join('\n'));
  fsApi.addFile(
    '/usr/local/iCompute/etc/supervisord/supervisord.conf',
    '[unix_http_server]\nfile=/usr/local/libexec/.run/supervisor.sock\n[include]\nfiles=supervisord.d/*.conf\n'
  );
  fsApi.addDirectory('/usr/local/iCompute/etc/supervisord/supervisord.d');
  fsApi.addFile('/usr/local/iCompute/etc/supervisord/supervisord.d/platform.conf', '[program:platform]\ncommand=/bin/true\n');
  const deps = dependencySet(fsApi, ['systemctl', 'supervisord', 'supervisorctl']);
  const report = detectServiceEnvironment({
    ...deps,
    pathApi: path.posix,
    env: {
      HOME: '/home/user',
      PATH: '/usr/bin',
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      CODEX_HOME: '/secret/codex-home',
      AUTHORIZATION: 'secret-value'
    }
  });

  assert.equal(report.environment.container, true);
  assert.equal(report.environment.containerType, 'kubernetes');
  assert.equal(report.environment.kubernetes, true);
  assert.equal(report.environment.processManager, 'supervisord');
  assert.equal(report.backends['systemd-user'].available, false);
  assert.equal(report.backends['systemd-user'].binaryPresent, true);
  assert.equal(report.backends['systemd-user'].reason, 'user_manager_unavailable');
  assert.equal(report.backends.supervisord.processManagerDetected, true);
  assert.equal(report.backends.supervisord.supervisordBinaryPresent, true);
  assert.equal(report.backends.supervisord.version, '4.2.5');
  assert.equal(report.backends.supervisord.includeDirectoryAvailable, true);
  assert.equal(report.backends.supervisord.controlAvailable, false);
  assert.equal(report.backends.supervisord.managedInstallAvailable, false);
  assert.equal(report.backends.supervisord.reason, 'control_socket_unavailable');
  assert.equal(report.backends['container-external'].available, true);
  assert.equal(report.recommended, 'container-external');
  assert.deepEqual(report.runtimeContract.command, ['/home/user/.local/bin/toknow-agent', 'run']);
  assert.equal(report.runtimeContract.persistence.configPersistence, 'persistent-volume-supported');
  assert.equal(report.runtimeContract.persistence.runtimeDataPersistence, 'persistent-volume-supported');
  assert.equal(report.runtimeContract.persistence.serviceManagerConfig, 'ephemeral_or_orchestrator_managed');
  assert.deepEqual(deps.commands.map((command) => command.at(-1)), ['show-environment', '--version', 'status']);
  assert.equal(deps.commands.some((command) => /^(?:reread|update|enable|start|restart|stop)$/.test(command.at(-1))), false);
  assert.equal(fsApi.mutations.length, 0);

  const json = JSON.stringify(report);
  for (const secret of ['secret-value', 'CODEX_HOME', '/secret/codex-home', '10.0.0.1', 'supervisord -c']) {
    assert.equal(json.includes(secret), false, `JSON must not contain ${secret}`);
  }
});

test('ordinary Ubuntu fixture recommends a reachable systemd user manager', () => {
  const fsApi = baseFs();
  fsApi.addFile('/proc/1/comm', 'systemd\n');
  const deps = dependencySet(fsApi, ['systemctl'], { systemdOnline: true });
  const report = detectServiceEnvironment({
    ...deps,
    pathApi: path.posix,
    env: { HOME: '/home/alice', PATH: '/usr/bin' }
  });

  assert.equal(report.environment.container, false);
  assert.equal(report.environment.processManager, 'systemd');
  assert.equal(report.backends['systemd-user'].binaryPresent, true);
  assert.equal(report.backends['systemd-user'].userManagerReachable, true);
  assert.equal(report.backends['systemd-user'].userManagerState, 'running');
  assert.equal(report.backends['systemd-user'].available, true);
  assert.equal(report.recommended, 'systemd-user');
});

test('reachable systemd user manager remains authority when PID 1 is not systemd', () => {
  const fsApi = baseFs();
  fsApi.addFile('/proc/1/comm', 'tini\n');
  const deps = dependencySet(fsApi, ['systemctl'], { systemdOnline: true });
  const report = detectServiceEnvironment({
    ...deps,
    pathApi: path.posix,
    env: { HOME: '/home/alice', PATH: '/usr/bin' }
  });
  assert.equal(report.environment.processManager, 'tini');
  assert.equal(report.backends['systemd-user'].available, true);
  assert.equal(report.recommended, 'systemd-user');
});

test('traditional supervisord fixture recommends the controllable backend', () => {
  const fsApi = baseFs();
  fsApi.addFile('/proc/1/comm', 'supervisord\n');
  fsApi.addFile('/proc/1/cmdline', 'supervisord\0-c\0/etc/supervisor/supervisord.conf\0');
  const { configPath } = addSupervisorFixture(fsApi);
  const deps = dependencySet(fsApi, ['supervisord', 'supervisorctl'], { supervisorOnline: true });
  const report = detectServiceEnvironment({
    ...deps,
    pathApi: path.posix,
    env: { HOME: '/home/operator', PATH: '/usr/bin' }
  });
  assert.equal(report.environment.container, false);
  assert.equal(report.backends.supervisord.version, '4.2.5');
  assert.equal(report.backends.supervisord.configDiscovered, true);
  assert.equal(report.backends.supervisord.controlAvailable, true);
  assert.equal(report.backends.supervisord.managedInstallAvailable, true);
  assert.equal(report.recommended, 'supervisord');
  assert.equal(JSON.stringify(report).includes(configPath), false);
});

test('Kubernetes with tini and no in-container manager recommends container-external', () => {
  const fsApi = baseFs();
  fsApi.addFile('/proc/1/comm', 'tini\n');
  fsApi.addFile('/proc/1/cgroup', '0::/kubepods/burstable/pod-abcd\n');
  const deps = dependencySet(fsApi, []);
  const report = detectServiceEnvironment({
    ...deps,
    pathApi: path.posix,
    env: { HOME: '/home/app', PATH: '/usr/bin', KUBERNETES_SERVICE_HOST: '10.0.0.2' }
  });
  assert.equal(report.environment.container, true);
  assert.equal(report.environment.kubernetes, true);
  assert.equal(report.environment.processManager, 'tini');
  assert.equal(report.recommended, 'container-external');
});

test('unknown Linux without manager or container evidence recommends foreground', () => {
  const fsApi = baseFs();
  const deps = dependencySet(fsApi, []);
  const report = detectServiceEnvironment({
    ...deps,
    pathApi: path.posix,
    env: { HOME: '/home/operator', PATH: '/usr/bin' }
  });
  assert.equal(report.environment.container, false);
  assert.equal(report.recommended, 'none');
  assert.equal(report.backends.none.available, true);
  assert.equal(report.backends.none.autoRestart, false);
  assert.equal(report.runtimeContract.persistence.processRestart, 'manual');
});

test('supervisord binary and control tools are reported separately', () => {
  const fsApi = baseFs();
  const { configPath } = addSupervisorFixture(fsApi);
  const missingSupervisor = inspectSupervisorBackend({
    fsApi,
    pathApi: path.posix,
    env: { PATH: '/usr/bin' },
    supervisorConfig: configPath,
    commandAvailable: (name) => name === 'supervisorctl',
    runCommand: () => ({ status: 0, stdout: '' })
  });
  assert.equal(missingSupervisor.report.supervisordBinaryPresent, false);
  assert.equal(missingSupervisor.report.supervisorctlBinaryPresent, true);
  assert.equal(missingSupervisor.report.reason, 'supervisord_binary_missing');

  const missingCtl = inspectSupervisorBackend({
    fsApi,
    pathApi: path.posix,
    env: { PATH: '/usr/bin' },
    supervisorConfig: configPath,
    commandAvailable: (name) => name === 'supervisord',
    runCommand: () => ({ status: 0, stdout: '4.2.5' })
  });
  assert.equal(missingCtl.report.supervisordBinaryPresent, true);
  assert.equal(missingCtl.report.supervisorctlBinaryPresent, false);
  assert.equal(missingCtl.report.controlAvailable, false);
  assert.equal(missingCtl.report.reason, 'supervisorctl_binary_missing');
});

test('PID 1 config parsing accepts only bounded absolute supervisor paths', () => {
  assert.equal(supervisorConfigFromPid1('supervisord\0-c\0/usr/local/etc/supervisord.conf\0', path.posix), '/usr/local/etc/supervisord.conf');
  assert.equal(supervisorConfigFromPid1(`supervisord\0-c\0${'x'.repeat(5000)}\0`, path.posix), null);
  assert.equal(supervisorConfigFromPid1('sh\0-c\0/etc/supervisord.conf\0', path.posix), null);
  assert.equal(supervisorConfigFromPid1('supervisord\0-c\0relative.conf\0', path.posix), null);
});

test('include discovery resolves config-relative glob directories without shell execution', () => {
  const patterns = parseSupervisorIncludePatterns('[include]\nfiles=supervisord.d/*.conf\n', '/usr/local/etc/supervisord/supervisord.conf', {
    pathApi: path.posix
  });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].directory, '/usr/local/etc/supervisord/supervisord.d');
  assert.equal(patterns[0].basenamePattern, '*.conf');
});


const supportedFileSystems = ['ceph', 'ceph-fuse', 'fuse.ceph-fuse', 'nfs', 'nfs4', 'cifs', 'glusterfs'];
const unknownFileSystems = [
  'ext4', 'xfs', 'tmpfs', 'fuse.sshfs', 'fuse.rclone', 'fuse.unknown',
  'fuse.ceph-fuse-extra', 'fuse.ceph', 'fuse.ceph-fuse.extra', 'prefixceph', 'ceph-extra'
];

function a800MountReport(fileSystem) {
  const fsApi = baseFs();
  fsApi.addFile('/.dockerenv', '');
  fsApi.addFile('/proc/1/comm', 'supervisord\n');
  fsApi.addFile('/proc/1/cmdline', 'supervisord\0-c\0/usr/local/iCompute/etc/supervisord/supervisord.conf\0');
  fsApi.addFile('/proc/1/cgroup', '0::/kubepods.slice/pod-abc/containerd-xyz\n');
  fsApi.addFile('/proc/self/mountinfo', [
    '1 0 0:1 / / rw - overlay overlay rw',
    `2 1 0:50 / /home/user rw - ${fileSystem} ceph-fuse rw`
  ].join('\n'));
  fsApi.addFile(
    '/usr/local/iCompute/etc/supervisord/supervisord.conf',
    '[unix_http_server]\nfile=/usr/local/libexec/.run/supervisor.sock\n[include]\nfiles=supervisord.d/*.conf\n'
  );
  fsApi.addDirectory('/usr/local/iCompute/etc/supervisord/supervisord.d');
  fsApi.addFile('/usr/local/iCompute/etc/supervisord/supervisord.d/platform.conf', '[program:platform]\ncommand=/bin/true\n');
  for (const name of ['writeFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'chmodSync', 'symlinkSync']) {
    fsApi[name] = (...args) => {
      fsApi.mutations.push([name, ...args]);
      throw new Error('Service detection must not mutate the filesystem');
    };
  }
  const openSync = fsApi.openSync.bind(fsApi);
  fsApi.openSync = (filePath, flags) => {
    assert.equal(flags, 'r');
    return openSync(filePath);
  };
  const deps = dependencySet(fsApi, ['systemctl', 'supervisord', 'supervisorctl']);
  const report = detectServiceEnvironment({
    ...deps,
    platform: 'linux',
    pathApi: path.posix,
    env: {
      HOME: '/home/user', PATH: '/usr/bin',
      XDG_CONFIG_HOME: '/home/user/.config',
      XDG_DATA_HOME: '/home/user/.local/share',
      XDG_STATE_HOME: '/home/user/.local/state',
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      CODEX_HOME: '/secret/codex-home', AUTHORIZATION: 'secret-value',
      ownerId: 'private-owner', CID: 'private-cid', COOKIE: 'private-cookie',
      PROMPT: 'private-prompt', REPLY: 'private-reply'
    }
  });
  assert.deepEqual(fsApi.mutations, []);
  assert.equal(fsApi.handles.size, 0);
  assert.deepEqual(deps.commands, [
    ['systemctl', '--user', 'show-environment'],
    ['supervisord', '--version'],
    ['supervisorctl', '-c', '/usr/local/iCompute/etc/supervisord/supervisord.conf', 'status']
  ]);
  const json = JSON.stringify(report);
  for (const secret of [
    'secret-value', 'CODEX_HOME', '/secret/codex-home', '10.0.0.1',
    'private-owner', 'private-cid', 'private-cookie', 'private-prompt', 'private-reply',
    'PRIVATE_TOKEN', 'must-not-leak', 'supervisord -c'
  ]) assert.equal(json.includes(secret), false, `JSON must not contain ${secret}`);
  return report;
}

test('A800 ceph and fuse.ceph-fuse public reports are identical', (t) => {
  const ceph = a800MountReport('ceph');
  const fuse = a800MountReport('fuse.ceph-fuse');
  t.diagnostic(`A800_AB_PUBLIC_REPORTS ${JSON.stringify({ ceph, fuse })}`);
  for (const report of [ceph, fuse]) {
    assert.equal(report.runtimeContract.persistence.configPersistence, 'persistent-volume-supported');
    assert.equal(report.runtimeContract.persistence.runtimeDataPersistence, 'persistent-volume-supported');
    assert.equal(report.runtimeContract.persistence.serviceManagerConfig, 'ephemeral_or_orchestrator_managed');
    assert.equal(report.runtimeContract.persistence.hostReboot, 'unknown');
    assert.equal(report.runtimeContract.persistence.containerRecreate, 'unknown');
    assert.equal(report.recommended, 'container-external');
    assert.deepEqual(report.environment, {
      container: true, containerType: 'kubernetes', kubernetes: true, processManager: 'supervisord'
    });
    assert.equal(report.backends['systemd-user'].available, false);
    assert.equal(report.backends.supervisord.controlAvailable, false);
    assert.deepEqual(report.runtimeContract.command, ['/home/user/.local/bin/toknow-agent', 'run']);
  }
  assert.deepEqual(fuse, ceph);
});

for (const fileSystem of [...supportedFileSystems, 'overlay', 'overlayfs', ...unknownFileSystems]) {
  const expected = supportedFileSystems.includes(fileSystem) ? 'persistent-volume-supported'
    : ['overlay', 'overlayfs'].includes(fileSystem) ? 'ephemeral_or_orchestrator_managed' : 'unknown';
  test(`mountTypeForPath classifies exact filesystem ${fileSystem}`, () => {
    assert.equal(mountTypeForPath('/home/user/.config/toknow-agent',
      `2 1 0:50 / /home/user rw - ${fileSystem} ceph-fuse rw`, path.posix), expected);
  });
  test(`public A800 persistence classifies exact filesystem ${fileSystem}`, () => {
    const report = a800MountReport(fileSystem);
    assert.equal(report.runtimeContract.persistence.configPersistence, expected);
    assert.equal(report.runtimeContract.persistence.runtimeDataPersistence, expected);
    assert.equal(report.runtimeContract.persistence.serviceManagerConfig, 'ephemeral_or_orchestrator_managed');
    assert.equal(report.recommended, 'container-external');
  });
}

test('mountTypeForPath selects the longest covering mount regardless of input order', () => {
  const lines = [
    '1 0 0:1 / / rw - overlay overlay rw',
    '2 1 0:50 / /home/user rw - fuse.ceph-fuse ceph-fuse rw',
    '3 2 0:51 / /home/user/.local rw - tmpfs tmpfs rw',
    '4 3 0:52 / /home/user/.local/share rw - nfs4 server:/data rw'
  ];
  for (const mountInfo of [lines.join('\n'), [...lines].reverse().join('\n')]) {
    assert.equal(mountTypeForPath('/home/user/.config', mountInfo, path.posix), 'persistent-volume-supported');
    assert.equal(mountTypeForPath('/home/user/.local/state', mountInfo, path.posix), 'unknown');
    assert.equal(mountTypeForPath('/home/user/.local/share/agent', mountInfo, path.posix), 'persistent-volume-supported');
    assert.equal(mountTypeForPath('/home/user2/.config', mountInfo, path.posix), 'ephemeral_or_orchestrator_managed');
    assert.equal(mountTypeForPath('/home/user/.local/share2', mountInfo, path.posix), 'unknown');
  }
});

test('mountTypeForPath enforces exact mount point and child path boundaries', () => {
  const mountInfo = '2 1 0:50 / /home/user rw - ceph ceph-fuse rw';
  for (const target of ['/home/user', '/home/user/', '/home/user/.config', '/home/user/a/../b']) {
    assert.equal(mountTypeForPath(target, mountInfo, path.posix), 'persistent-volume-supported');
  }
  for (const target of ['/home', '/home/user2', '/home/username/.config', '/other']) {
    assert.equal(mountTypeForPath(target, mountInfo, path.posix), 'unknown');
  }
});

for (const [escaped, decoded] of [['\\040', ' '], ['\\011', '\t'], ['\\012', '\n'], ['\\134', '\\']]) {
  test(`mountTypeForPath decodes Linux mountinfo escape ${escaped}`, () => {
    const mountInfo = `2 1 0:50 / /home/user${escaped}data rw shared:1 - fuse.ceph-fuse ceph-fuse rw\r\n`;
    assert.equal(decodeMountPath(`/home/user${escaped}data`), `/home/user${decoded}data`);
    // Existing path safety rejects control characters even after mount decoding.
    const expected = /[\t\n]/.test(decoded) ? 'unknown' : 'persistent-volume-supported';
    assert.equal(mountTypeForPath(`/home/user${decoded}data/config`, mountInfo, path.posix), expected);
    assert.equal(mountTypeForPath('/home/userdata/config', mountInfo, path.posix), 'unknown');
  });
}

test('mountTypeForPath fails closed for invalid input and unmatched mounts', () => {
  for (const mountInfo of [null, undefined, '', 'garbage', '1 0 0:1 / /home/user rw',
    '1 0 - ceph', '2 1 0:50 / /home/user rw - ', '2 1 0:50 / /other rw - ceph ceph-fuse rw']) {
    assert.equal(mountTypeForPath('/home/user/config', mountInfo, path.posix), 'unknown');
  }
  for (const target of [null, undefined, '', 'relative/path', '/home/user/invalid\0path']) {
    assert.equal(mountTypeForPath(target, '1 0 0:1 / / rw - ceph ceph rw', path.posix), 'unknown');
  }
});

test('public runtime persistence requires both XDG data and state mounts to be supported', () => {
  for (const [root, fileSystem, expected] of [
    ['/home/user/.local/state', 'tmpfs', 'unknown'],
    ['/home/user/.local/share', 'overlay', 'ephemeral_or_orchestrator_managed']
  ]) {
    const fsApi = baseFs();
    fsApi.addFile('/proc/self/mountinfo', [
      '1 0 0:1 / / rw - overlay overlay rw',
      '2 1 0:50 / /home/user rw - fuse.ceph-fuse ceph-fuse rw',
      `3 2 0:51 / ${root} rw - ${fileSystem} source rw`
    ].join('\n'));
    const deps = dependencySet(fsApi, []);
    const report = detectServiceEnvironment({ ...deps, pathApi: path.posix, platform: 'linux', env: { HOME: '/home/user' } });
    assert.equal(report.runtimeContract.persistence.configPersistence, 'persistent-volume-supported');
    assert.equal(report.runtimeContract.persistence.runtimeDataPersistence, expected);
    assert.deepEqual(deps.commands, []);
  }
});

for (const [platform, pathApi, home, launcher] of [
  ['win32', path.win32, 'C:\\Users\\fixture', 'C:\\Users\\fixture\\.local\\bin\\toknow-agent'],
  ['darwin', path.posix, '/Users/fixture', '/Users/fixture/.local/bin/toknow-agent']
]) {
  test(`service detection preserves ${platform} mock path compatibility`, () => {
    const fsApi = baseFs();
    fsApi.addFile('/proc/self/mountinfo', '');
    const deps = dependencySet(fsApi, []);
    const report = detectServiceEnvironment({ ...deps, platform, pathApi, env: { HOME: home } });
    assert.equal(report.recommended, 'none');
    assert.equal(report.environment.container, false);
    assert.equal(report.backends['systemd-user'].available, false);
    assert.equal(report.backends.supervisord.controlAvailable, false);
    assert.equal(report.runtimeContract.persistence.configPersistence, 'unknown');
    assert.equal(report.runtimeContract.persistence.runtimeDataPersistence, 'unknown');
    assert.deepEqual(report.runtimeContract.command, [launcher, 'run']);
    assert.deepEqual(deps.commands, []);
    assert.deepEqual(fsApi.mutations, []);
  });
}
