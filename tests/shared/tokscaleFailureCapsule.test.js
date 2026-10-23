'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runNativeFixture, EXCERPT_LIMIT } = require('../helpers/tokscaleFailureCapsule');
const { runAgainstFixture, verifyGooseScannerContract, TOKEN_CONTRACT_CASES, applicableTokenContracts } = require('../../scripts/verify-vendored-tokscale');

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tm-tokscale-capsule-'));
  const home = path.join(root, 'home');
  const directory = path.join(root, 'failures');
  for (const folder of [home, directory, path.join(home, '.config', 'tokscale'), path.join(home, '.local', 'share'), path.join(home, '.cache')]) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  const binaryPath = path.join(root, 'synthetic-binary');
  fs.writeFileSync(binaryPath, 'synthetic executable identity');
  const childEnv = {
    HOME: home, TMPDIR: root, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    TOKSCALE_CONFIG_DIR: path.join(home, '.config', 'tokscale'), TOKSCALE_PRICING_CACHE_ONLY: '1'
  };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) childEnv[key] = 'http://127.0.0.1:9';
  return {
    root, home, directory,
    call: { stageId: 'CLIENT_DEVIN', contractClient: 'devin', scanClients: 'devin-cli,devin-desktop', groupBy: 'client,session,model',
      binaryPath, binaryPlatform: 'linux-x64', binaryVersion: '4.20.0', binaryVersionSource: 'manifest.baseVersion', fixtureRoot: home,
      argv: ['--json', '--client', 'devin-cli,devin-desktop', '--group-by', 'client,session,model', '--no-spinner'],
      spawnOptions: { encoding: 'utf8', timeout: 15_000, env: childEnv } },
    deps: { env: { POTATO_TEST_TOKSCALE_FAILURE_DIR: directory, POTATO_TEST_FIXTURE_ROOT: root } }
  };
}

function timeout(extra = {}) {
  return { error: Object.assign(new Error('spawnSync fixture ETIMEDOUT'), { code: 'ETIMEDOUT', errno: -110, syscall: 'spawnSync' }),
    status: null, signal: 'SIGTERM', stdout: '', stderr: '', ...extra };
}

function consume(result) {
  if (result.status !== 0) throw new Error(`Fixture run exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function thrown(action) {
  try { action(); } catch (error) { return error; }
  assert.fail('Failure must not become success');
}

function fail(f, result, overrides = {}) {
  const error = thrown(() => runNativeFixture(f.call, consume, { ...f.deps, spawnSync: () => result, ...overrides }));
  assert.equal(error.spawnResult, result);
  return error;
}

function capsule(error) {
  assert.equal(error.failureCapsule.status, 'WRITTEN', JSON.stringify(error.failureCapsule));
  return JSON.parse(fs.readFileSync(error.failureCapsule.path, 'utf8'));
}

test('ETIMEDOUT retains exact cause/result, errno, status, signal and invocation', () => {
  const f = fixture(), result = timeout({ pid: 1234 });
  const error = fail(f, result);
  const saved = capsule(error);
  assert.equal(error.cause, result.error);
  assert.equal(error.message, 'Fixture run failed to execute: spawnSync fixture ETIMEDOUT');
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.result.error.name, 'Error');
  assert.equal(saved.result.error.code, 'ETIMEDOUT');
  assert.equal(saved.result.error.errno, -110);
  assert.equal(saved.result.error.syscall, 'spawnSync');
  assert.match(saved.result.error.message, /ETIMEDOUT/);
  assert.equal(saved.result.status, null);
  assert.equal(saved.result.signal, 'SIGTERM');
  assert.equal(saved.result.pid, 1234);
  assert.equal(saved.timing.timeoutMs, 15000);
  assert.equal(saved.timing.timeoutReached, true);
  assert.deepEqual(saved.argv, f.call.argv);
  assert.equal(saved.fixtureRoot, f.home);
  assert.equal(saved.nodeVersion, process.version);
  assert.equal(saved.architecture, process.arch);
  assert.equal(saved.binaryVersionSource, 'manifest.baseVersion');
  assert.equal(saved.binaryHash, createHash('sha256').update('synthetic executable identity').digest('hex'));
  assert.match(saved.gitSha, /^[0-9a-f]{40}$/);
  assert.equal(saved.environment.cacheIsolation, 'CONFIGURED_PATHS_WITHIN_FIXTURE');
  assert.equal(saved.environment.tmpdirWithinIsolationRoot, true);
});

test('a returned null signal is never replaced by a timeout default', () => {
  const f = fixture();
  const saved = capsule(fail(f, timeout({ signal: null })));
  assert.equal(saved.result.signal, null);
  assert.equal(saved.result.captureState.signal, 'RETURNED');
});

test('absent PID, signal, status and errno are marked without invention', () => {
  const f = fixture();
  const saved = capsule(fail(f, { error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }));
  for (const key of ['pid', 'status', 'signal']) {
    assert.equal(saved.result[key], null);
    assert.equal(saved.result.captureState[key], 'NOT_CAPTURED');
  }
  assert.equal(saved.result.error.errno, 'NOT_CAPTURED');
  assert.equal(saved.result.error.syscall, 'NOT_CAPTURED');
  assert.equal(saved.result.stdout.excerpt, 'NOT_CAPTURED');
});

test('a returned zero PID is preserved without claiming an active child', () => {
  const f = fixture();
  assert.equal(capsule(fail(f, timeout({ pid: 0 }))).result.pid, 0);
});

test('nonempty stdout/stderr retain lengths and only safe diagnostic excerpts', () => {
  const f = fixture(), result = timeout({ stdout: 'partial ETIMEDOUT', stderr: 'disk EIO' });
  const saved = capsule(fail(f, result));
  assert.equal(saved.result.stdout.length, result.stdout.length);
  assert.equal(saved.result.stderr.byteLength, Buffer.byteLength(result.stderr));
  assert.match(saved.result.stdout.excerpt, /ETIMEDOUT/);
  assert.match(saved.result.stderr.excerpt, /EIO/);
  assert.equal(saved.result.stdout.lengthUnit, 'UTF16_CODE_UNITS');
});

test('oversized output is bounded and Buffer byte lengths remain accurate', () => {
  const f = fixture(), output = Buffer.from('ETIMEDOUT '.repeat(5000));
  const saved = capsule(fail(f, timeout({ stdout: output, stderr: 'SIGTERM '.repeat(5000) })));
  assert.equal(saved.result.stdout.length, output.length);
  assert.equal(saved.result.stdout.byteLength, output.length);
  assert.equal(saved.result.stdout.lengthUnit, 'bytes');
  assert.equal(saved.result.stdout.excerpt.length, EXCERPT_LIMIT);
  assert.equal(saved.result.stderr.excerpt.length, EXCERPT_LIMIT);
});

test('nonzero exit remains failed with the returned status and no invented errno', () => {
  const f = fixture();
  const error = fail(f, { status: 7, signal: null, stdout: '{}', stderr: 'EIO' });
  const saved = capsule(error);
  assert.equal(saved.failureKind, 'NONZERO_EXIT');
  assert.equal(saved.result.status, 7);
  assert.equal(saved.result.error, null);
  assert.equal(saved.timing.timeoutReached, false);
});

test('spawn ENOENT is a spawn failure and never a timeout', () => {
  const f = fixture();
  const result = timeout({ error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawnSync' }), signal: null });
  const saved = capsule(fail(f, result));
  assert.equal(saved.result.error.code, 'ENOENT');
  assert.equal(saved.timing.timeoutReached, false);
});

test('bad JSON remains failed with its parse cause and returned output', () => {
  const f = fixture(), result = { status: 0, signal: null, stdout: '{bad json', stderr: '' };
  const error = thrown(() => runAgainstFixture(f.call.binaryPath, f.home, f.call.groupBy, f.call.scanClients,
    { stageId: 'CLIENT_DEVIN', contractClient: 'devin' }, { ...f.deps, spawnSync: () => result }));
  assert.ok(error.cause instanceof SyntaxError);
  assert.equal(error.spawnResult, result);
  assert.equal(capsule(error).failureKind, 'INVALID_JSON');
});

test('normal exit zero plus JSON returns unchanged values with no capsule or diagnostic I/O', () => {
  const f = fixture();
  const noIo = new Proxy(fs, { get() { throw new Error('Diagnostic I/O on success'); } });
  const parsed = runAgainstFixture(f.call.binaryPath, f.home, f.call.groupBy, f.call.scanClients, {},
    { ...f.deps, fs: noIo, spawnSync: () => ({ status: 0, stdout: '{"entries":[]}', stderr: '' }) });
  assert.deepEqual(parsed, { entries: [] });
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('successful result identity is unchanged at the raw runner boundary', () => {
  const f = fixture(), result = { status: 0, stdout: '{}', stderr: '' };
  assert.equal(runNativeFixture(f.call, (value) => value, { ...f.deps, spawnSync: () => result }), result);
});

test('disabled diagnostics retain old failure message/cause without any recorder I/O', () => {
  const f = fixture(), result = timeout();
  const noIo = new Proxy(fs, { get() { throw new Error('Disabled recorder accessed fs'); } });
  const error = fail(f, result, { env: {}, fs: noIo });
  assert.equal(error.failureCapsule.status, 'DISABLED');
  assert.equal(error.cause, result.error);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('capsule files are unique for parallel failures and exclusively created', async () => {
  const f = fixture();
  const paths = await Promise.all(Array.from({ length: 8 }, async () => fail(f, timeout()).failureCapsule.path));
  assert.equal(new Set(paths).size, 8);
  assert.equal(fs.readdirSync(f.directory).length, 8);
  for (const file of paths) if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('write failure is attached without masking the native error or mutating its result', () => {
  const f = fixture(), result = Object.freeze(timeout());
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'writeFileSync') return () => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); };
    return target[key];
  } });
  const error = fail(f, result, { fs: io });
  assert.equal(error.failureCapsule.status, 'WRITE_FAILED');
  assert.equal(error.failureCapsule.code, 'EACCES');
  assert.equal(error.cause, result.error);
  assert.equal(error.spawnResult, result);
});

test('missing diagnostics directory leaves the fixture and original error intact', () => {
  const f = fixture(), result = timeout();
  const error = fail(f, result, { env: { ...f.deps.env, POTATO_TEST_TOKSCALE_FAILURE_DIR: path.join(f.root, 'missing') } });
  assert.equal(error.failureCapsule.status, 'WRITE_FAILED');
  assert.equal(error.failureCapsule.code, 'ENOENT');
  assert.ok(fs.existsSync(f.home));
  assert.equal(error.cause, result.error);
});

test('failure directory outside the isolated root is refused', () => {
  const f = fixture(), other = fixture();
  const error = fail(f, timeout(), { env: { ...f.deps.env, POTATO_TEST_TOKSCALE_FAILURE_DIR: other.directory } });
  assert.equal(error.failureCapsule.code, 'UNSAFE_CAPSULE_DIR');
  assert.deepEqual(fs.readdirSync(other.directory), []);
});

test('a directory symlink or junction cannot redirect capsule output', () => {
  const f = fixture(), other = fixture(), link = path.join(f.root, 'redirect');
  fs.symlinkSync(other.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  const error = fail(f, timeout(), { env: { ...f.deps.env, POTATO_TEST_TOKSCALE_FAILURE_DIR: link } });
  assert.equal(error.failureCapsule.status, 'WRITE_FAILED');
  assert.equal(error.failureCapsule.code, 'UNSAFE_CAPSULE_DIR');
  assert.deepEqual(fs.readdirSync(other.directory), []);
});

test('a fixture outside the isolated test root is refused', () => {
  const f = fixture(), other = fixture();
  f.call.fixtureRoot = other.home;
  assert.equal(fail(f, timeout()).failureCapsule.code, 'UNSAFE_CAPSULE_DIR');
});

test('an absent isolated-root declaration fails closed without directory creation', () => {
  const f = fixture();
  const error = fail(f, timeout(), { env: { POTATO_TEST_TOKSCALE_FAILURE_DIR: f.directory } });
  assert.equal(error.failureCapsule.code, 'UNSAFE_CAPSULE_DIR');
});

test('a missing binary hash is NOT_CAPTURED and does not prevent the failure capsule', () => {
  const f = fixture(); f.call.binaryPath = path.join(f.root, 'missing-native');
  const saved = capsule(fail(f, timeout()));
  assert.equal(saved.binaryHash, 'NOT_CAPTURED');
  assert.equal(saved.binaryHashCapture.errorCode, 'ENOENT');
});

test('uncreated cache roots are reported unproven without losing the spawn failure', () => {
  const f = fixture(); f.call.spawnOptions.env.XDG_CACHE_HOME = path.join(f.home, 'not-created');
  const saved = capsule(fail(f, timeout()));
  assert.equal(saved.environment.cacheIsolation, 'NOT_PROVEN');
  assert.equal(saved.environment.pathIsolation.XDG_CACHE_HOME.errorCode, 'ENOENT');
});

test('monotonic elapsed is deterministic despite a backwards wall clock', () => {
  const f = fixture(), monotonic = [1000.25, 1037.75], wall = ['2026-10-23T10:00:00.000Z', '2026-10-23T09:59:59.000Z'];
  const saved = capsule(fail(f, timeout(), { monotonic: () => monotonic.shift(), wallClock: () => wall.shift() }));
  assert.equal(saved.timing.elapsedMs, 37.5);
  assert.equal(saved.timing.startTime, '2026-10-23T10:00:00.000Z');
  assert.equal(saved.timing.endTime, '2026-10-23T09:59:59.000Z');
});

test('spawn arguments/options are identical and all diagnostic I/O occurs after native return', () => {
  const f = fixture(), events = []; let returned = false;
  const io = new Proxy(fs, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => { assert.equal(returned, true, `Active-child I/O: ${key}`); events.push(key); return target[key](...args); };
  } });
  const result = timeout();
  const error = fail(f, result, { fs: io, spawnSync: (binary, argv, options) => {
    assert.equal(binary, f.call.binaryPath); assert.equal(argv, f.call.argv); assert.equal(options, f.call.spawnOptions);
    assert.deepEqual(Object.keys(options).sort(), ['encoding', 'env', 'timeout']);
    assert.equal(options.timeout, 15000);
    assert.deepEqual(events, []);
    events.push('spawn-return'); returned = true; return result;
  } });
  capsule(error);
  assert.equal(events[0], 'spawn-return');
  assert.ok(events.indexOf('readFileSync') > 0);
  assert.ok(events.indexOf('writeFileSync') > events.indexOf('readFileSync'));
});

test('private environment values and arbitrary output/session text never enter the JSON', () => {
  const f = fixture();
  const secrets = ['secret-key-sentinel', 'bearer-sentinel', 'cookie-sentinel', 'real-session-sentinel', 'archive-sentinel'];
  Object.assign(f.call.spawnOptions.env, { API_KEY: secrets[0], AUTHORIZATION: secrets[1], COOKIE: secrets[2], CODEX_HOME: secrets[3], TOKEN_MONITOR_ARCHIVE: secrets[4], HTTP_PROXY: `http://user:${secrets[0]}@proxy.invalid` });
  const result = timeout({ stdout: JSON.stringify({ session: secrets[3], archive: secrets[4] }), stderr: `Bearer ${secrets[1]} Cookie ${secrets[2]}` });
  result.error.message = secrets.join(' ');
  const error = fail(f, result), text = fs.readFileSync(error.failureCapsule.path, 'utf8');
  for (const secret of secrets) assert.equal(text.includes(secret), false);
  for (const key of ['API_KEY', 'AUTHORIZATION', 'COOKIE', 'CODEX_HOME', 'TOKEN_MONITOR_ARCHIVE']) assert.equal(text.includes(`"${key}"`), false);
  assert.equal(capsule(error).environment.proxyPolicy.allBlackholed, false);
  assert.equal(error.spawnResult.stdout, result.stdout);
});

test('synchronous spawn throw retains the exact original error', () => {
  const f = fixture(), original = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const error = thrown(() => runNativeFixture(f.call, consume, { ...f.deps, spawnSync: () => { throw original; } }));
  assert.equal(error, original);
  assert.equal(capsule(error).result.error.code, 'ENOENT');
});

test('a frozen consumer error cannot be replaced by attachment failure', () => {
  const f = fixture(), original = Object.freeze(new Error('original assertion'));
  const error = thrown(() => runNativeFixture(f.call, () => { throw original; }, { ...f.deps, env: {}, spawnSync: () => ({ status: 0 }) }));
  assert.equal(error, original);
});

for (const contract of TOKEN_CONTRACT_CASES) test(`actual CLIENT_${contract.client.toUpperCase()} boundary records contract and scanner filters`, () => {
  const f = fixture(), result = timeout();
  const scanClients = contract.scanClients || contract.client;
  const stageId = `CLIENT_${contract.client.toUpperCase()}`;
  const error = thrown(() => runAgainstFixture(f.call.binaryPath, f.home, 'client,session,model', scanClients,
    { stageId, contractClient: contract.client }, { ...f.deps, spawnSync: () => result }));
  const saved = capsule(error);
  assert.equal(saved.stageId, stageId);
  assert.equal(saved.contractClient, contract.client);
  assert.equal(saved.scanClients, scanClients);
  assert.equal(saved.groupBy, 'client,session,model');
  assert.deepEqual(saved.argv.slice(1, 5), ['--client', scanClients, '--group-by', 'client,session,model']);
});

test('Devin retains every original token bucket, deduplication and session expectation', () => {
  const devin = TOKEN_CONTRACT_CASES.find(({ client }) => client === 'devin');
  assert.equal(devin.scanClients, 'devin-cli,devin-desktop');
  assert.deepEqual(devin.expectedRow, { model: 'claude-sonnet-4', input: 1200, output: 340, cacheRead: 500, cacheWrite: 80, reasoning: 0 });
  assert.deepEqual(devin.expectedPeriod, { totalTokens: 2120, clientTokens: 2120, clientOutputTokens: 340 });
  assert.deepEqual(devin.expectedSession, { id: 'devin-contract', totalTokens: 2120, outputTokens: 340, reasoningTokens: 0 });
});

test('direct exported calls identify every catalog client without explicit diagnostics metadata', () => {
  for (const contract of TOKEN_CONTRACT_CASES) {
    const f = fixture(), scanClients = contract.scanClients || contract.client;
    const error = thrown(() => runAgainstFixture(f.call.binaryPath, f.home, 'client,session,model', scanClients, {},
      { ...f.deps, spawnSync: () => timeout() }));
    const saved = capsule(error);
    assert.equal(saved.contractClient, contract.client);
    assert.equal(saved.stageId, `CLIENT_${contract.client.toUpperCase()}`);
    assert.equal(saved.scanClients, scanClients);
    assert.equal(saved.groupBy, 'client,session,model');
  }
});

test('direct DSH joined grouping identifies the metadata stage without explicit diagnostics', () => {
  const f = fixture();
  const error = thrown(() => runAgainstFixture(f.call.binaryPath, f.home, 'client,workspace,session,model', 'dsh', {},
    { ...f.deps, spawnSync: () => timeout() }));
  const saved = capsule(error);
  assert.equal(saved.contractClient, 'dsh');
  assert.equal(saved.stageId, 'DSH_SESSION_METADATA');
});

for (const stageId of ['DSH_BASE', 'DSH_SESSION_METADATA', 'DSH_MODEL_ATTRIBUTION']) test(`actual ${stageId} wrapper preserves stage`, () => {
  const f = fixture();
  const error = thrown(() => runAgainstFixture(f.call.binaryPath, f.home, 'client,model', 'dsh', { stageId, caseIndex: 2 },
    { ...f.deps, spawnSync: () => timeout() }));
  const saved = capsule(error);
  assert.equal(saved.stageId, stageId); assert.equal(saved.contractClient, 'dsh'); assert.equal(saved.caseIndex, 2);
});

test('actual Goose base boundary records stage before its first child call', () => {
  const f = fixture();
  const error = thrown(() => verifyGooseScannerContract(f.call.binaryPath, {}, { ...f.deps, fixtureTmpDir: f.root, spawnSync: () => timeout() }));
  assert.equal(error.cause.code, 'ETIMEDOUT');
  assert.equal(error.spawnResult.error.code, 'ETIMEDOUT');
  assert.equal(capsule(error).stageId, 'GOOSE_BASE');
});

for (const stageId of ['GOOSE_GRAPH', 'GOOSE_PATH_DATE']) test(`actual ${stageId} failure is attributed by its executing call`, () => {
  const f = fixture(); let calls = 0;
  const entries = [
    ['goose-contract', 1200, 340, 60], ['fallback', 70, 30, 0], ['mixed', 70, 20, 10]
  ].map(([sessionId, input, output, reasoning]) => ({ client: 'goose', model: 'claude-sonnet-4', sessionId, input, output, reasoning }));
  const graph = { contributions: [{ date: '2026-08-20', clients: [{ client: 'goose', modelId: 'claude-sonnet-4', tokens: { input: 1340, output: 390 } }] }] };
  const error = thrown(() => verifyGooseScannerContract(f.call.binaryPath, {}, { ...f.deps, fixtureTmpDir: f.root, spawnSync: () => {
    calls += 1;
    if (calls === 1) return { status: 0, stdout: JSON.stringify({ entries }), stderr: '' };
    if (calls === 2 && stageId === 'GOOSE_PATH_DATE') return { status: 0, stdout: JSON.stringify(graph), stderr: '' };
    return timeout();
  } }));
  const saved = capsule(error);
  assert.equal(saved.stageId, stageId);
  assert.equal(saved.contractClient, 'goose');
  assert.equal(saved.scanClients, 'goose');
  assert.equal(saved.groupBy, stageId === 'GOOSE_GRAPH' ? null : 'client,session,model');
  assert.equal(calls, stageId === 'GOOSE_GRAPH' ? 2 : 3);
});

for (const platform of ['linux', 'darwin']) test(`${platform.toUpperCase()}_MOCK_CONTRACT_PASS: stages, status and signal are captured without native acceptance`, () => {
  const f = fixture();
  const saved = capsule(fail(f, timeout({ signal: null }), { platform }));
  assert.equal(saved.platform, platform);
  assert.equal(saved.result.signal, null);
  assert.ok(applicableTokenContracts(platform).some(({ client }) => client === 'devin'));
});
