'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tar = require('tar');
const {
  fetchNodeRuntime,
  loadRuntimeManifest,
  validateRuntimeManifest
} = require('./fetch-node-runtime');
const { loadManifest, resolveManifestEntry } = require('../vendoredTokscale');
const { ensureVendoredTokscale } = require('../ensure-vendored-tokscale');
const { verifyPackage } = require('./verify-package');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_PLATFORM = 'linux';
const TARGET_ARCH = 'x64';
const SERVER_AGENT_PACKAGE_NAME = 'to-know-server-agent';
const SERVER_AGENT_PACKAGE_DIR = 'to-know-agent';
const SERVER_AGENT_SERVICE_SOURCE_DIR = path.join('packaging', 'server-agent');
const EXCLUDED_PRODUCTION_DEPENDENCIES = new Set(['@xhayper/discord-rpc', 'electron-updater']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function rootPackageJson(root = ROOT) {
  return readJson(path.join(root, 'package.json'));
}

function createServerAgentPackageManifest(rootPackage) {
  const dependencies = Object.fromEntries(
    Object.entries(rootPackage.dependencies || {})
      .filter(([name]) => !EXCLUDED_PRODUCTION_DEPENDENCIES.has(name))
  );
  return {
    name: SERVER_AGENT_PACKAGE_NAME,
    version: String(rootPackage.version || ''),
    private: true,
    description: 'Self-contained Potato Server Agent runtime.',
    license: rootPackage.license || 'MIT',
    dependencies
  };
}

function assertBuildHost() {
  if (process.platform !== TARGET_PLATFORM || process.arch !== TARGET_ARCH) {
    throw new Error(
      `Linux x64 server-agent packaging must run on linux x64; current host is ${process.platform}-${process.arch}. ` +
      'This command will not create a cross-platform fake artifact.'
    );
  }
}

function assertPackagingContracts(rootPackage, runtimeManifest, vendorManifest) {
  validateRuntimeManifest(runtimeManifest);
  if (runtimeManifest.nodeVersion !== '22.23.2') throw new Error('bundled Node version must remain 22.23.2');
  if (runtimeManifest.platform !== TARGET_PLATFORM || runtimeManifest.arch !== TARGET_ARCH) {
    throw new Error('server-agent packaging target must remain linux x64');
  }
  if (vendorManifest.mode !== 'override') throw new Error('Tokscale vendor manifest mode must remain override');
  if (vendorManifest.baseVersion !== '4.17.0') throw new Error('Tokscale vendor baseVersion must remain 4.17.0');
  if (rootPackage.dependencies?.tokscale !== '^4.17.0') {
    throw new Error('root Tokscale dependency must remain pinned to ^4.17.0');
  }
  const { entry } = resolveManifestEntry(vendorManifest, 'linux-x64');
  if (entry.package !== '@tokscale/cli-linux-x64-gnu' || entry.asset !== 'tokscale-linux-x64') {
    throw new Error('Tokscale linux-x64 package contract changed');
  }
  if (typeof rootPackage.version !== 'string' || !rootPackage.version) {
    throw new Error('root package version is required for the server-agent package');
  }
}

function privatePath(relativePath) {
  const lower = relativePath.split(path.sep).join('/').toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  const base = segments[segments.length - 1] || '';
  return segments.includes('.git')
    || base === '.env'
    || base.startsWith('.env.')
    || ['settings.json', 'credentials.json', 'auth.json', 'token-m-notification-runtime.json'].includes(base)
    || base.endsWith('.log')
    || /outbox.*\.json$/i.test(base);
}

function packageCopyOptions(source, options = {}) {
  const excludePrefixes = options.excludePrefixes || [];
  return {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (current) => {
      const relative = path.relative(source, current).split(path.sep).join('/');
      const excluded = excludePrefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
      return !excluded && !privatePath(relative);
    }
  };
}

function copyTree(source, destination, options = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, packageCopyOptions(source, options));
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function assertLinuxTokscaleInstallation(root, vendorManifest) {
  const { entry } = resolveManifestEntry(vendorManifest, 'linux-x64');
  const packageRoot = path.join(root, 'node_modules', entry.package);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const binaryPath = path.join(packageRoot, 'bin', 'tokscale');
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(binaryPath)) {
    throw new Error(
      `${entry.package} is missing from Linux production node_modules; run npm ci --omit=dev on linux x64 before packaging`
    );
  }
  const packageJson = readJson(packageJsonPath);
  if (packageJson.name !== entry.package || packageJson.version !== vendorManifest.baseVersion) {
    throw new Error(`${entry.package} does not match the pinned Tokscale manifest`);
  }
  return { binaryPath, packageRoot };
}

function assertProductionNodeModules(root) {
  for (const desktopDependency of ['electron', 'electron-builder']) {
    if (fs.existsSync(path.join(root, 'node_modules', desktopDependency))) {
      throw new Error(
        `desktop dependency ${desktopDependency} is present; run npm ci --omit=dev on linux x64 before packaging`
      );
    }
  }
}

function assertBundledNode(nodeRoot, nodeVersion, spawn = spawnSync) {
  const nodePath = path.join(nodeRoot, 'bin', 'node');
  if (!fs.existsSync(nodePath)) throw new Error(`bundled Node executable is missing: ${nodePath}`);
  const result = spawn(nodePath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw new Error(`bundled Node failed to execute: ${result.error.message}`);
  if (result.status !== 0 || String(result.stdout || '').trim() !== `v${nodeVersion}`) {
    throw new Error(`bundled Node version check failed: expected v${nodeVersion}, got ${String(result.stdout || '').trim()}`);
  }
  return nodePath;
}

function parseOutputDir(argv) {
  const outputFlag = argv.find((value) => value.startsWith('--output-dir='));
  if (outputFlag) return path.resolve(outputFlag.slice('--output-dir='.length));
  const outputIndex = argv.indexOf('--output-dir');
  if (outputIndex !== -1 && argv[outputIndex + 1]) return path.resolve(argv[outputIndex + 1]);
  return path.join(ROOT, 'dist', 'server-agent');
}

async function packageLinuxX64({
  root = ROOT,
  outputDir = path.join(ROOT, 'dist', 'server-agent'),
  fetchRuntime = fetchNodeRuntime,
  ensureTokscale = ensureVendoredTokscale,
  spawn = spawnSync
} = {}) {
  assertBuildHost();
  const rootPackage = rootPackageJson(root);
  const runtimeManifest = loadRuntimeManifest(path.join(root, 'scripts', 'server-agent', 'runtime.json'));
  const vendorManifest = loadManifest();
  assertPackagingContracts(rootPackage, runtimeManifest, vendorManifest);

  const outputRoot = path.resolve(outputDir);
  fs.mkdirSync(outputRoot, { recursive: true });
  const artifactName = `To-Know-Agent-${rootPackage.version}-linux-x64.tar.gz`;
  const artifactPath = path.join(outputRoot, artifactName);
  if (fs.existsSync(artifactPath)) throw new Error(`refusing to overwrite existing artifact: ${artifactPath}`);

  assertLinuxTokscaleInstallation(root, vendorManifest);
  assertProductionNodeModules(root);
  const previousCwd = process.cwd();
  let tokScaleResult;
  try {
    process.chdir(root);
    tokScaleResult = await ensureTokscale({ requestedKey: 'linux-x64' });
  } finally {
    process.chdir(previousCwd);
  }
  if (tokScaleResult.status === 'unavailable' || tokScaleResult.status === 'fallback') {
    throw new Error('pinned Linux x64 Tokscale binary was not available for packaging');
  }

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-agent-package-'));
  const packageRoot = path.join(stageRoot, SERVER_AGENT_PACKAGE_DIR);
  const appRoot = path.join(packageRoot, 'app');
  const runtimeRoot = path.join(packageRoot, 'runtime');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  copyTree(path.join(root, 'src', 'server-agent'), path.join(appRoot, 'src', 'server-agent'));
  copyTree(path.join(root, 'src', 'shared'), path.join(appRoot, 'src', 'shared'));
  copyTree(path.join(root, 'node_modules'), path.join(appRoot, 'node_modules'), {
    excludePrefixes: [...EXCLUDED_PRODUCTION_DEPENDENCIES]
  });
  copyFile(path.join(root, 'LICENSE'), path.join(appRoot, 'LICENSE'));
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    `${JSON.stringify(createServerAgentPackageManifest(rootPackage), null, 2)}\n`,
    'utf8'
  );
  copyFile(path.join(root, 'bin', 'toknow-agent'), path.join(packageRoot, 'bin', 'toknow-agent'));
  copyFile(path.join(root, 'install.sh'), path.join(packageRoot, 'install.sh'));
  copyFile(
    path.join(root, SERVER_AGENT_SERVICE_SOURCE_DIR, 'toknow-agent.service'),
    path.join(packageRoot, 'systemd', 'toknow-agent.service')
  );
  copyFile(
    path.join(root, SERVER_AGENT_SERVICE_SOURCE_DIR, 'remove-user-service.sh'),
    path.join(packageRoot, 'systemd', 'remove-user-service.sh')
  );
  copyFile(
    path.join(root, SERVER_AGENT_SERVICE_SOURCE_DIR, 'supervisord', 'toknow-agent.conf.template'),
    path.join(packageRoot, 'supervisord', 'toknow-agent.conf.template')
  );
  copyFile(
    path.join(root, SERVER_AGENT_SERVICE_SOURCE_DIR, 'supervisord', 'remove-service.sh'),
    path.join(packageRoot, 'supervisord', 'remove-service.sh')
  );
  copyFile(
    path.join(root, SERVER_AGENT_SERVICE_SOURCE_DIR, 'container', 'README.md'),
    path.join(packageRoot, 'container', 'README.md')
  );
  fs.writeFileSync(path.join(packageRoot, 'VERSION'), `${rootPackage.version}\n`, 'utf8');
  fs.writeFileSync(path.join(runtimeRoot, 'manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`, 'utf8');
  fs.chmodSync(path.join(packageRoot, 'bin', 'toknow-agent'), 0o755);
  fs.chmodSync(path.join(packageRoot, 'install.sh'), 0o755);
  fs.chmodSync(path.join(packageRoot, 'systemd', 'remove-user-service.sh'), 0o755);
  fs.chmodSync(path.join(packageRoot, 'supervisord', 'remove-service.sh'), 0o755);

  const nodeRuntime = await fetchRuntime({ manifest: runtimeManifest });
  assertBundledNode(nodeRuntime.nodeRoot, runtimeManifest.nodeVersion, spawn);
  copyTree(nodeRuntime.nodeRoot, path.join(runtimeRoot, 'node'));

  verifyPackage(packageRoot, { requireExecutable: true });
  await tar.c({ cwd: stageRoot, file: artifactPath, gzip: true, portable: true }, [SERVER_AGENT_PACKAGE_DIR]);
  return { artifactName, artifactPath, packageRoot, tokScaleResult, nodeRuntime };
}

if (require.main === module) {
  packageLinuxX64({ outputDir: parseOutputDir(process.argv.slice(2)) })
    .then(({ artifactPath }) => process.stdout.write(`server-agent package created: ${artifactPath}\n`))
    .catch((error) => {
      process.stderr.write(`server-agent Linux package failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  EXCLUDED_PRODUCTION_DEPENDENCIES,
  ROOT,
  SERVER_AGENT_PACKAGE_DIR,
  SERVER_AGENT_PACKAGE_NAME,
  SERVER_AGENT_SERVICE_SOURCE_DIR,
  TARGET_ARCH,
  TARGET_PLATFORM,
  assertBuildHost,
  assertBundledNode,
  assertLinuxTokscaleInstallation,
  assertProductionNodeModules,
  assertPackagingContracts,
  createServerAgentPackageManifest,
  copyTree,
  packageCopyOptions,
  packageLinuxX64,
  parseOutputDir,
  privatePath,
  rootPackageJson
};
