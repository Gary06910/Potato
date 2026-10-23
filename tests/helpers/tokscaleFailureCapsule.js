'use strict';

// Test/release-gate diagnostics only. Never imported by the product runtime.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const NOT_CAPTURED = 'NOT_CAPTURED';
const EXCERPT_LIMIT = 2048;
const ENV_KEYS = ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'TOKSCALE_CONFIG_DIR', 'TOKSCALE_PRICING_CACHE_ONLY'];
const SOURCE_KEYS = ['DSH_HOME', 'HERMES_HOME', 'GOOSE_PATH_ROOT', 'TOKSCALE_EXTRA_DIRS',
  'TOKEN_MONITOR_QODER_CN_DB_PATH', 'TOKEN_MONITOR_QODER_CN_PROJECTS_PATH', 'QODERCN_CONFIG_DIR',
  'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR', 'TOKSCALE_HEADLESS_DIR'];
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

// Arbitrary text can contain session content or credentials. Only recognized
// diagnostic codes cross the disk boundary; the exact result stays in memory.
function excerpt(value) {
  if (value === undefined) return { length: null, byteLength: null, excerpt: NOT_CAPTURED };
  if (value === null) return { length: null, byteLength: null, excerpt: null };
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  const codes = text.match(/\b(?:ETIMEDOUT|ENOENT|EACCES|EPERM|EIO|EBUSY|ENOBUFS|SIGTERM|SIGKILL|SQLITE_BUSY|SQLITE_LOCKED)\b/g) || [];
  return {
    length: value.length,
    lengthUnit: Buffer.isBuffer(value) ? 'bytes' : 'UTF16_CODE_UNITS',
    byteLength: Buffer.isBuffer(value) ? value.length : Buffer.byteLength(text),
    excerpt: text ? `[UNTRUSTED_TEXT_WITHHELD] ${codes.join(' ')}`.trim().slice(0, EXCERPT_LIMIT) : '',
    excerptPolicy: 'DIAGNOSTIC_CODES_ONLY',
    excerptLimit: EXCERPT_LIMIT
  };
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function readGitSha(io, repoRoot) {
  let gitDir = path.join(repoRoot, '.git');
  if (io.statSync(gitDir).isFile()) {
    const pointer = io.readFileSync(gitDir, 'utf8').trim();
    if (!pointer.startsWith('gitdir: ')) return NOT_CAPTURED;
    gitDir = path.resolve(repoRoot, pointer.slice(8));
  }
  const head = io.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  if (!/^ref: refs\/heads\/[\w./-]+$/.test(head)) return NOT_CAPTURED;
  const ref = head.slice(5);
  let common = gitDir;
  try { common = path.resolve(gitDir, io.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch (_error) {}
  for (const base of [gitDir, common]) {
    try {
      const sha = io.readFileSync(path.join(base, ref), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch (_error) {}
  }
  const line = io.readFileSync(path.join(common, 'packed-refs'), 'utf8').split(/\r?\n/)
    .find((line) => line.endsWith(` ${ref}`));
  return line && /^[0-9a-f]{40} /.test(line) ? line.slice(0, 40) : NOT_CAPTURED;
}

function capture(read) {
  try { const value = read(); return { value, state: value === NOT_CAPTURED ? NOT_CAPTURED : 'CAPTURED' }; }
  catch (error) { return { value: NOT_CAPTURED, state: 'NOT_CAPTURED', errorCode: error.code || NOT_CAPTURED }; }
}

function writeCapsule(invocation, result, failure, timing, env, config, deps) {
  const io = deps.fs || fs;
  if (!config.isolationRoot || !path.isAbsolute(config.isolationRoot) || !path.isAbsolute(config.directory)) {
    throw Object.assign(new Error('An absolute isolated test root and failure directory are required'), { code: 'UNSAFE_CAPSULE_DIR' });
  }
  for (const target of [config.isolationRoot, config.directory, invocation.fixtureRoot]) {
    if (!io.lstatSync(target).isDirectory()) throw Object.assign(new Error('Capsule paths must be existing directories, not links'), { code: 'UNSAFE_CAPSULE_DIR' });
  }
  const root = io.realpathSync(config.isolationRoot);
  const directory = io.realpathSync(config.directory);
  const fixture = io.realpathSync(invocation.fixtureRoot);
  if (root === path.parse(root).root || directory === root || !within(root, directory) || !within(root, fixture)) {
    throw Object.assign(new Error('Capsule or fixture escapes the isolated test root'), { code: 'UNSAFE_CAPSULE_DIR' });
  }
  if (process.platform !== 'win32') {
    for (const target of [root, directory]) {
      const info = io.statSync(target);
      if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
        throw Object.assign(new Error('Capsule root/directory requires private owner permissions'), { code: 'UNSAFE_CAPSULE_PERMISSIONS' });
      }
    }
  }
  const binaryHash = capture(() => createHash('sha256').update(io.readFileSync(invocation.binaryPath)).digest('hex'));
  const gitSha = capture(() => readGitSha(io, path.resolve(__dirname, '../..')));
  const childError = result?.error || (result === undefined ? failure : null);
  const field = (object, key) => object?.[key] === undefined ? NOT_CAPTURED : object[key];
  const envPaths = Object.fromEntries(ENV_KEYS.map((key) => [key, field(env, key)]));
  const pathIsolation = Object.fromEntries(ENV_KEYS.filter((key) => key !== 'TOKSCALE_PRICING_CACHE_ONLY')
    .map((key) => [key, capture(() => typeof env[key] === 'string' && path.isAbsolute(env[key]) &&
      within(key === 'TMPDIR' ? root : fixture, io.realpathSync(env[key])))]));
  const isolated = Object.entries(pathIsolation).filter(([key]) => key !== 'TMPDIR')
    .every(([, check]) => check.value === true);
  const capsule = {
    schemaVersion: 1,
    ...invocation,
    nodeVersion: process.version,
    platform: deps.platform || process.platform,
    architecture: process.arch,
    binaryVersion: invocation.binaryVersion ?? NOT_CAPTURED,
    binaryPlatform: invocation.binaryPlatform ?? NOT_CAPTURED,
    binaryVersionSource: invocation.binaryVersionSource ?? NOT_CAPTURED,
    binaryHash: binaryHash.value,
    binaryHashCapture: binaryHash,
    gitSha: gitSha.value,
    gitShaCapture: gitSha,
    timing: { ...timing, timeoutReached: childError?.code === 'ETIMEDOUT' },
    failureKind: childError ? 'SPAWN_ERROR' : result?.status !== 0 ? 'NONZERO_EXIT' :
      failure instanceof SyntaxError || failure.cause instanceof SyntaxError ? 'INVALID_JSON' : 'CONTRACT_ASSERTION',
    result: {
      pid: result?.pid ?? null,
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      captureState: Object.fromEntries(['pid', 'status', 'signal'].map((key) => [key, result?.[key] === undefined ? NOT_CAPTURED : 'RETURNED'])),
      error: childError ? {
        name: field(childError, 'name'), message: excerpt(childError.message).excerpt,
        messagePolicy: 'DIAGNOSTIC_CODES_ONLY', code: field(childError, 'code'),
        errno: field(childError, 'errno'), syscall: field(childError, 'syscall')
      } : null,
      stdout: excerpt(result?.stdout), stderr: excerpt(result?.stderr)
    },
    environment: {
      ...envPaths,
      proxyPolicy: {
        allBlackholed: PROXY_KEYS.every((key) => env[key] === 'http://127.0.0.1:9'),
        bypassAbsent: !Object.hasOwn(env, 'NO_PROXY') && !Object.hasOwn(env, 'no_proxy')
      },
      sourceOverridesPresent: Object.fromEntries(SOURCE_KEYS.map((key) => [key, Object.hasOwn(env, key)])),
      cacheIsolation: isolated ? 'CONFIGURED_PATHS_WITHIN_FIXTURE' : 'NOT_PROVEN',
      pathIsolation,
      tmpdirWithinIsolationRoot: pathIsolation.TMPDIR.value
    }
  };
  const target = path.join(directory, `tokscale-${invocation.stageId.replace(/[^A-Z0-9_-]/gi, '_')}-${process.pid}-${randomUUID()}.json`);
  // Exclusive creation prevents overwrite, including an existing symlink.
  io.writeFileSync(target, `${JSON.stringify(capsule, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return target;
}

function runNativeFixture(call, consume, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const monotonic = deps.monotonic || (() => performance.now());
  const wallClock = deps.wallClock || (() => new Date().toISOString());
  const parentEnv = deps.env || process.env;
  const config = { directory: parentEnv.POTATO_TEST_TOKSCALE_FAILURE_DIR, isolationRoot: parentEnv.POTATO_TEST_FIXTURE_ROOT };
  // Snapshot only invocation metadata and the child environment allowlist.
  const { spawnOptions, ...identity } = call;
  const invocation = { ...identity, argv: [...call.argv] };
  const env = Object.fromEntries([...ENV_KEYS, ...SOURCE_KEYS, ...PROXY_KEYS, 'NO_PROXY', 'no_proxy']
    .filter((key) => Object.hasOwn(spawnOptions.env, key)).map((key) => [key, spawnOptions.env[key]]));
  const startTime = wallClock();
  const start = monotonic();
  let result, thrown;
  try { result = spawn(call.binaryPath, call.argv, spawnOptions); }
  catch (error) { thrown = error; }
  const elapsedMs = monotonic() - start;
  const endTime = wallClock();
  try {
    if (thrown) throw thrown;
    if (result.error) throw new Error(`Fixture run failed to execute: ${result.error.message}`, { cause: result.error });
    return consume(result);
  } catch (error) {
    let diagnostic = { status: 'DISABLED' };
    if (config.directory) {
      try {
        diagnostic = { status: 'WRITTEN', path: writeCapsule(invocation, result, error,
          { startTime, endTime, elapsedMs, timeoutMs: spawnOptions.timeout ?? NOT_CAPTURED }, env, config, deps) };
      } catch (writeError) {
        diagnostic = { status: 'WRITE_FAILED', code: writeError.code || NOT_CAPTURED,
          message: 'Failure capsule could not be safely written; original failure retained' };
      }
    }
    // Do not serialize these raw objects. Preserve exact identity for callers.
    try {
      Object.defineProperty(error, 'spawnResult', { value: result, configurable: true });
      error.failureCapsule = diagnostic;
    } catch (_attachmentError) { /* A frozen thrown error must remain the original failure. */ }
    throw error;
  }
}

module.exports = { runNativeFixture, EXCERPT_LIMIT };
