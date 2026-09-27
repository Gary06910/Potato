'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const runtimePath = path.join(root, 'scripts', 'server-agent', 'runtime.json');
const launcherPath = path.join(root, 'bin', 'toknow-agent');
const installPath = path.join(root, 'install.sh');
const serviceSourcePath = path.join(root, 'packaging', 'server-agent', 'toknow-agent.service');
const serviceRemovalSourcePath = path.join(root, 'packaging', 'server-agent', 'remove-user-service.sh');
const supervisorTemplatePath = path.join(root, 'packaging', 'server-agent', 'supervisord', 'toknow-agent.conf.template');
const supervisorRemovalPath = path.join(root, 'packaging', 'server-agent', 'supervisord', 'remove-service.sh');
const containerReadmePath = path.join(root, 'packaging', 'server-agent', 'container', 'README.md');
const packageScriptPath = path.join(root, 'scripts', 'server-agent', 'package-linux-x64.js');
const runtime = require('../../scripts/server-agent/fetch-node-runtime');
const packageScript = require('../../scripts/server-agent/package-linux-x64');
const packageVerifier = require('../../scripts/server-agent/verify-package');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function createVerifierFixture({ omitNodeModules = false } = {}) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-agent-package-verifier-'));
  const manifest = packageScript.createServerAgentPackageManifest(packageScript.rootPackageJson());
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'runtime', 'node', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'app', 'src', 'server-agent'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'app', 'src', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'systemd'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'supervisord'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'container'), { recursive: true });
  for (const file of ['serviceDetection.js', 'serviceInstaller.js', 'instance.js', 'shellBootstrap.js']) {
    fs.copyFileSync(path.join(root, 'src', 'server-agent', file), path.join(packageRoot, 'app', 'src', 'server-agent', file));
  }
  if (!omitNodeModules) fs.mkdirSync(path.join(packageRoot, 'app', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'bin', 'toknow-agent'), read(launcherPath), 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'install.sh'), read(installPath), 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'VERSION'), '1.0.0\n', 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'runtime', 'manifest.json'), `${read(runtimePath).trim()}\n`, 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'runtime', 'node', 'bin', 'node'), 'bundled node placeholder\n', 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'app', 'package.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'app', 'LICENSE'), read(path.join(root, 'LICENSE')), 'utf8');
  fs.copyFileSync(serviceSourcePath, path.join(packageRoot, 'systemd', 'toknow-agent.service'));
  fs.copyFileSync(serviceRemovalSourcePath, path.join(packageRoot, 'systemd', 'remove-user-service.sh'));
  fs.copyFileSync(supervisorTemplatePath, path.join(packageRoot, 'supervisord', 'toknow-agent.conf.template'));
  fs.copyFileSync(supervisorRemovalPath, path.join(packageRoot, 'supervisord', 'remove-service.sh'));
  fs.copyFileSync(containerReadmePath, path.join(packageRoot, 'container', 'README.md'));
  return { packageRoot, manifest };
}

function writeFixtureFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'fixture\n', 'utf8');
}

function createRelativeSymlinkFixture() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-agent-symlink-source-'));
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-agent-symlink-destination-'));
  const links = new Map([
    ['node_modules/.bin/js-yaml', '../js-yaml/bin/js-yaml.js'],
    ['node_modules/.bin/semver', '../semver/bin/semver.js'],
    ['node_modules/.bin/tokscale', '../tokscale/bin.js'],
    ['node/bin/npm', '../lib/node_modules/npm/bin/npm-cli.js'],
    ['node/bin/npx', '../lib/node_modules/npm/bin/npx-cli.js'],
    ['node/bin/corepack', '../lib/node_modules/corepack/dist/corepack.js']
  ]);
  for (const [relativeLink, target] of links) {
    const linkPath = path.join(source, ...relativeLink.split('/'));
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    writeFixtureFile(path.resolve(path.dirname(linkPath), target));
    fs.symlinkSync(target, linkPath);
  }
  return { source, destination, links };
}

function assertInternalSymlink(root, linkPath) {
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, `${linkPath} must remain a symlink`);
  const target = fs.realpathSync(linkPath);
  const relative = path.relative(root, target);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `${linkPath} escapes ${root}`);
  return target;
}

test('Linux x64 runtime metadata is fixed and contains no Tokscale duplicate manifest', () => {
  const metadata = JSON.parse(read(runtimePath));
  assert.deepEqual(metadata, {
    nodeVersion: '22.23.2',
    platform: 'linux',
    arch: 'x64',
    nodeAsset: 'node-v22.23.2-linux-x64.tar.xz',
    distributionBaseUrl: 'https://nodejs.org/dist/v22.23.2/'
  });
  assert.deepEqual(runtime.distributionUrls(metadata), {
    archive: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz',
    shasums: 'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt'
  });
  assert.equal(Object.keys(metadata).some((key) => key.toLowerCase().includes('tokscale')), false);
});

test('Tokscale package metadata remains sourced from the pinned vendor manifest', () => {
  const rootPackage = packageScript.rootPackageJson();
  const vendorManifest = JSON.parse(read(path.join(root, 'scripts', 'vendor', 'tokscale.json')));
  packageScript.assertPackagingContracts(rootPackage, JSON.parse(read(runtimePath)), vendorManifest);
  assert.equal(vendorManifest.baseVersion, '4.17.0');
  assert.equal(vendorManifest.platforms['linux-x64'].package, '@tokscale/cli-linux-x64-gnu');
  assert.equal(vendorManifest.platforms['linux-x64'].asset, 'tokscale-linux-x64');
  assert.equal(packageScript.createServerAgentPackageManifest(rootPackage).dependencies['electron-updater'], undefined);
});

test('launcher is self-relative and uses only the bundled Node executable', () => {
  const launcher = read(launcherPath);
  assert.match(launcher, /exec "\$PACKAGE_ROOT\/runtime\/node\/bin\/node" "\$PACKAGE_ROOT\/app\/src\/server-agent\/cli\.js" "\$@"/);
  assert.match(launcher, /\$0/);
  assert.doesNotMatch(launcher, /\b(?:npm|npx)\b/i);
  assert.doesNotMatch(launcher, /\/usr\/(?:local\/)?bin\/node\b|\bnodejs\b/i);
  assert.doesNotMatch(launcher, /ELECTRON_RUN_AS_NODE|electron(?:\.exe)?\b|DISPLAY|X11|Wayland/i);
  assert.doesNotMatch(launcher, /D:\\Program Files|toknow-server-agent-2a2|\/home\/user\/Public/i);
});

test('install script supports a user prefix override and never touches user state', () => {
  const install = read(installPath);
  assert.match(install, /TO_KNOW_INSTALL_ROOT/);
  assert.match(install, /--prefix/);
  assert.match(install, /--user-service/);
  assert.match(install, /--service-manager supervisord/);
  assert.match(install, /--supervisor-config/);
  assert.match(install, /\$HOME\/\.local\/share\/toknow-agent/);
  assert.match(install, /\$HOME\/\.local\/bin\/toknow-agent/);
  assert.doesNotMatch(install, /\bsudo\b|\/usr\/local|\/etc\/systemd\/system|loginctl\s+enable-linger/i);
  assert.doesNotMatch(install, /\.config\/toknow-agent|credentials\.json|settings\.json|auth\.json|outbox/i);
});

test('packaged systemd user unit uses the stable launcher and contains no secrets', () => {
  const unit = read(serviceSourcePath);
  assert.match(unit, /^ExecStart=%h\/\.local\/bin\/toknow-agent run$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /^TimeoutStopSec=15$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^PrivateTmp=true$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /1\.0\.0|CODEX_HOME|Authorization|ownerId|desktopId|CID|credential|secret|bridge token/i);
});

test('server package manifest uses root version and has no desktop entry point', () => {
  const rootPackage = packageScript.rootPackageJson();
  const manifest = packageScript.createServerAgentPackageManifest(rootPackage);
  assert.equal(manifest.version, rootPackage.version);
  assert.equal(Object.hasOwn(manifest, 'main'), false);
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false);
  assert.equal(Object.hasOwn(manifest.dependencies, 'electron-updater'), false);
  assert.equal(Object.hasOwn(manifest.dependencies, '@xhayper/discord-rpc'), false);
  assert.equal(manifest.dependencies.tokscale, '^4.17.0');
});

test('Linux package source includes the systemd user-service assets', () => {
  const source = read(packageScriptPath);
  assert.equal(packageScript.SERVER_AGENT_SERVICE_SOURCE_DIR, path.join('packaging', 'server-agent'));
  assert.ok(source.includes("toknow-agent.service"));
  assert.ok(source.includes("remove-user-service.sh"));
  assert.ok(source.includes("toknow-agent.conf.template"));
  assert.ok(source.includes("'container', 'README.md'"));
  assert.deepEqual(packageVerifier.REQUIRED_PATHS.slice(-4), [
    'supervisord/toknow-agent.conf.template',
    'supervisord/remove-service.sh',
    'container/README.md',
    'VERSION'
  ]);
});

test('supervisord package asset declares a stable launcher and scoped lifecycle policy', () => {
  const template = read(supervisorTemplatePath);
  assert.match(template, /^\[program:toknow-agent\]$/m);
  assert.match(template, /^command=@STABLE_LAUNCHER@ run$/m);
  assert.match(template, /^autostart=true$/m);
  assert.match(template, /^autorestart=true$/m);
  assert.match(template, /^stopsignal=TERM$/m);
  assert.match(template, /^stopwaitsecs=15$/m);
  assert.match(template, /^stopasgroup=true$/m);
  assert.match(template, /^killasgroup=true$/m);
  assert.doesNotMatch(template, /\/home\/user|1\.0\.0/);
});

test('package copy policy preserves symlink text and never dereferences', () => {
  const options = packageScript.packageCopyOptions(path.join(os.tmpdir(), 'toknow-agent-copy-source'));
  assert.equal(options.recursive, true);
  assert.equal(options.verbatimSymlinks, true);
  assert.equal(options.dereference, false);
  assert.equal(typeof options.filter, 'function');
});

test('Node checksum parser accepts the official SHASUMS256 format', () => {
  const digest = 'a'.repeat(64);
  assert.equal(runtime.parseShasums256(`${digest}  node-v22.23.2-linux-x64.tar.xz\n`, 'node-v22.23.2-linux-x64.tar.xz'), digest);
  assert.equal(runtime.parseShasums256(`${digest} *node-v22.23.2-linux-x64.tar.xz\n`, 'node-v22.23.2-linux-x64.tar.xz'), digest);
  assert.throws(
    () => runtime.parseShasums256(`${digest}  other.tar.xz\n`, 'node-v22.23.2-linux-x64.tar.xz'),
    /does not contain/
  );
});

test('version flag is local metadata only and does not enter the collector path', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'src', 'server-agent', 'cli.js'), '--version'], {
    cwd: path.join(root, 'src', 'server-agent'),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: path.join(os.tmpdir(), 'missing-toknow-version-codex-home') }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Potato Server Agent 1.0.0');
  assert.equal(result.stderr, '');
});

test('package verifier accepts the intended layout and rejects Electron source', () => {
  const { packageRoot } = createVerifierFixture();
  assert.equal(packageVerifier.verifyPackage(packageRoot, { requireExecutable: false }).version, '1.0.0');

  fs.mkdirSync(path.join(packageRoot, 'app', 'src', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'app', 'src', 'electron', 'main.js'), 'forbidden\n', 'utf8');
  assert.throws(() => packageVerifier.verifyPackage(packageRoot), /Electron source/);
});

test('Linux copy preserves npm .bin relative symlinks inside the package', { skip: process.platform !== 'linux' }, () => {
  const { source, destination, links } = createRelativeSymlinkFixture();
  packageScript.copyTree(source, path.join(destination, 'package'));
  const packageRoot = path.join(destination, 'package');
  for (const [relativeLink, target] of [...links].slice(0, 3)) {
    const copiedLink = path.join(packageRoot, ...relativeLink.split('/'));
    assert.equal(fs.readlinkSync(copiedLink), target);
    assertInternalSymlink(packageRoot, copiedLink);
    assert.notEqual(fs.realpathSync(copiedLink), fs.realpathSync(path.join(source, ...relativeLink.split('/'))));
  }
});

test('Linux copy preserves Node runtime bin relative symlinks inside the runtime root', { skip: process.platform !== 'linux' }, () => {
  const { source, destination, links } = createRelativeSymlinkFixture();
  packageScript.copyTree(source, path.join(destination, 'package'));
  const runtimeRoot = path.join(destination, 'package', 'node');
  for (const [relativeLink, target] of [...links].slice(3)) {
    const copiedLink = path.join(destination, 'package', ...relativeLink.split('/'));
    assert.equal(fs.readlinkSync(copiedLink), target);
    assertInternalSymlink(runtimeRoot, copiedLink);
  }
});

test('Linux copy leaves external symlinks for strict package verification to reject', { skip: process.platform !== 'linux' }, () => {
  const { packageRoot } = createVerifierFixture({ omitNodeModules: true });
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-agent-external-symlink-source-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-agent-external-symlink-target-'));
  const outsideFile = path.join(outsideRoot, 'outside.txt');
  const sourceLink = path.join(source, 'escape');
  writeFixtureFile(outsideFile);
  fs.symlinkSync(outsideFile, sourceLink);

  const destination = path.join(packageRoot, 'app', 'node_modules');
  packageScript.copyTree(source, destination);
  const copiedLink = path.join(destination, 'escape');
  assert.equal(fs.lstatSync(copiedLink).isSymbolicLink(), true);
  assert.throws(
    () => packageVerifier.verifyPackage(packageRoot),
    (error) => {
      assert.equal(error.code, 'invalid-server-agent-package');
      assert.equal(Array.isArray(error.errors), true);

      const externalSymlinkError = error.errors.find(
        (item) =>
          item.includes('app/node_modules/escape')
          && item.includes('symlink-escapes-package')
          && item.includes('invalid symlink')
      );

      assert.ok(externalSymlinkError);
      return true;
    }
  );
});

test('Windows package command is fail-closed instead of producing a fake Linux artifact', { skip: process.platform !== 'win32' }, () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-agent-no-fake-package-'));
  const result = spawnSync(process.execPath, [packageScriptPath, '--output-dir', outputRoot], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must run on linux x64/i);
  assert.deepEqual(fs.readdirSync(outputRoot), []);
});

test('2C upload and remote contracts are included by Server source-copy rules', () => {
  const source = read(packageScriptPath);
  assert.ok(source.includes("copyTree(path.join(root, 'src', 'server-agent')"));
  assert.ok(source.includes("copyTree(path.join(root, 'src', 'shared')"));
  for (const relative of ['src/server-agent/usageSyncRuntime.js', 'src/shared/remoteUsage.js', 'src/shared/usageSnapshot.js', 'src/shared/notification/androidClient.js']) {
    assert.equal(packageScript.privatePath(relative), false);
    assert.equal(fs.existsSync(path.join(root, relative)), true);
  }
  assert.equal(source.includes("copyTree(path.join(root, 'src', 'electron')"), false);
});
