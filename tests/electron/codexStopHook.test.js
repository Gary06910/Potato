'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  disableCodexStopHook,
  enableCodexStopHook,
  readCodexHookState
} = require('../../src/electron/codexStopHook');

function fixture(t) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-hooks-'));
  const files = new Set();
  t.after(() => {
    for (const file of files) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(codexHome);
  });
  return { codexHome, files };
}

test('merges and exactly disables the Token M Stop hook while preserving other hooks', (t) => {
  const { codexHome, files } = fixture(t);
  const configPath = path.join(codexHome, 'hooks.json');
  files.add(configPath);
  const original = {
    custom: { retained: true },
    hooks: {
      Stop: [{ matcher: 'always', hooks: [{ type: 'command', command: 'other-tool', timeout: 30 }] }],
      Start: [{ hooks: [{ type: 'command', command: 'start-tool' }] }]
    }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`);

  const enabled = enableCodexStopHook({
    codexHome,
    command: 'token-m-posix',
    commandWindows: 'token-m-win'
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.needsTrust, true);
  assert.ok(enabled.backupPath);
  files.add(enabled.backupPath);
  assert.equal(fs.readFileSync(enabled.backupPath, 'utf8'), `${JSON.stringify(original, null, 2)}\n`);

  const merged = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(merged.custom.retained, true);
  assert.equal(merged.hooks.Start[0].hooks[0].command, 'start-tool');
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.Stop[1].hooks[0].command, 'token-m-posix');
  assert.equal(merged.hooks.Stop[1].hooks[0].commandWindows, 'token-m-win');
  assert.equal(merged.hooks.Stop[1].hooks[0].timeout, 5);

  const duplicate = enableCodexStopHook({ codexHome, command: 'token-m-posix', commandWindows: 'token-m-win' });
  assert.equal(duplicate.backupPath, null);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks.Stop.length, 2);

  const disabled = disableCodexStopHook({
    codexHome,
    commandIdentity: { command: 'token-m-posix', commandWindows: 'token-m-win' }
  });
  files.add(disabled.backupPath);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), original);
});

test('migrates the legacy Windows shell command in place without adding a duplicate Stop hook', (t) => {
  const { codexHome, files } = fixture(t);
  const configPath = path.join(codexHome, 'hooks.json');
  files.add(configPath);
  const legacy = 'set "ELECTRON_RUN_AS_NODE=1"&&"C:\\Program Files (x86)\\Token M\\electron.exe"';
  fs.writeFileSync(configPath, `${JSON.stringify({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: legacy, timeout: 5 }] }] }
  }, null, 2)}\n`);

  const state = enableCodexStopHook({
    codexHome,
    command: 'powershell.exe -EncodedCommand stable',
    commandWindows: 'powershell.exe -EncodedCommand stable',
    legacyCommands: [legacy]
  });
  files.add(state.backupPath);
  assert.equal(state.enabled, true);
  const stop = JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks.Stop;
  assert.equal(stop.length, 1);
  assert.deepEqual(stop[0].hooks[0], {
    type: 'command',
    command: 'powershell.exe -EncodedCommand stable',
    commandWindows: 'powershell.exe -EncodedCommand stable',
    timeout: 5
  });
});

test('reports malformed files without overwriting them', (t) => {
  const { codexHome, files } = fixture(t);
  const configPath = path.join(codexHome, 'hooks.json');
  files.add(configPath);
  fs.writeFileSync(configPath, '{broken');
  const state = enableCodexStopHook({ codexHome, command: 'token-m' });
  assert.equal(state.enabled, false);
  assert.match(state.error, /JSON/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{broken');
});

test('refuses a hooks.json reported as a symlink', (t) => {
  const { codexHome } = fixture(t);
  const configPath = path.join(codexHome, 'hooks.json');
  const fsApi = Object.create(fs);
  fsApi.lstatSync = (target) => {
    if (target === configPath) return { isFile: () => false, isSymbolicLink: () => true, size: 0 };
    return fs.lstatSync(target);
  };
  const state = readCodexHookState({ codexHome, commandIdentity: 'token-m', fs: fsApi });
  assert.equal(state.enabled, false);
  assert.match(state.error, /regular file/);
});

test('returns a safe actionable error when hooks.json cannot be replaced', (t) => {
  const { codexHome } = fixture(t);
  const fsApi = Object.create(fs);
  fsApi.renameSync = () => {
    const error = new Error('access denied');
    error.code = 'EACCES';
    throw error;
  };
  const state = enableCodexStopHook({
    codexHome,
    command: 'token-m-hook',
    fs: fsApi
  });
  assert.equal(state.enabled, false);
  assert.match(state.error, /access denied/);
  assert.equal(fs.existsSync(path.join(codexHome, 'hooks.json')), false);
});

const { isPotatoOwnedStopHook } = require('../../src/electron/codexStopHook');
const { hookCommandFor } = require('../../src/electron/tokenMNotificationRuntime');

function sanitizedHooks() {
  const runtimePath = '/C:/Synthetic/Token Monitor/token-m-notification-runtime.json';
  const command = hookCommandFor({ platform: 'win32', executablePath: '/C:/Synthetic/Potato.exe', helperPath: '/C:/Synthetic/src/electron/codexHookForwarder.js', runtimePath,
    launcherPath: '/C:/Synthetic/Token Monitor/codex-hook/launcher.ps1', manifestPath: '/C:/Synthetic/Token Monitor/codex-hook/target.json' });
  const current = { matcher: '', hooks: [{ type: 'command', command, commandWindows: command, timeout: 5 }] };
  const legacy = Array.from({ length: 6 }, (_, i) => {
    const legacyCommand = hookCommandFor({ platform: 'win32', executablePath: '/C:/Synthetic/build-' + i + '/Potato.exe', helperPath: '/C:/Synthetic/build-' + i + '/resources/app.asar/src/electron/codexHookForwarder.js', runtimePath });
    return { matcher: '', hooks: [{ type: 'command', command: legacyCommand, commandWindows: legacyCommand, timeout: 5 }] };
  });
  const thirdParty = { matcher: '', custom: { unchanged: true }, hooks: [{ type: 'command', command: 'other-tool --codex --token', timeout: 31 }] };
  return { identity: { command, commandWindows: command, runtimePath }, current, legacy, thirdParty };
}

for (const variant of ['current', 'six legacy + current', 'legacy only', 'duplicated current']) {
  test('reconciliation canonicalizes ' + variant + ' and is byte-idempotent', (t) => {
    const { codexHome, files } = fixture(t);
    const configPath = path.join(codexHome, 'hooks.json');
    files.add(configPath);
    const { identity, current, legacy, thirdParty } = sanitizedHooks();
    const owned = variant === 'current' ? [current] : variant === 'legacy only' ? legacy
      : variant === 'duplicated current' ? [current, current, current] : [...legacy, current];
    const original = { custom: 'retained', hooks: { Stop: [...owned, thirdParty], Start: [{ untouched: true }] } };
    const raw = JSON.stringify(original, null, 2) + '\n';
    fs.writeFileSync(configPath, raw);
    const first = enableCodexStopHook({ codexHome, ...identity });
    assert.equal(first.error, null);
    if (first.backupPath) files.add(first.backupPath);
    assert.equal(Boolean(first.backupPath), variant !== 'current');
    const canonical = fs.readFileSync(configPath, 'utf8');
    if (variant === 'current') assert.equal(canonical, raw);
    const next = JSON.parse(canonical);
    assert.equal(next.hooks.Stop.flatMap((group) => group.hooks).filter((entry) => isPotatoOwnedStopHook(entry, identity)).length, 1);
    assert.deepEqual(next.hooks.Stop.find((group) => group.custom), thirdParty);
    assert.deepEqual(next.hooks.Start, original.hooks.Start);
    for (let i = 0; i < 2; i++) {
      assert.equal(enableCodexStopHook({ codexHome, ...identity }).backupPath, null);
      assert.equal(fs.readFileSync(configPath, 'utf8'), canonical);
    }
    const disabled = disableCodexStopHook({ codexHome, commandIdentity: identity });
    assert.equal(disabled.error, null);
    files.add(disabled.backupPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).hooks.Stop, [thirdParty]);
    assert.equal(disableCodexStopHook({ codexHome, commandIdentity: identity }).backupPath, null);
  });
}

test('ownership rejects lookalikes, different runtime, injected script, and unknown alternate commands', () => {
  const { identity, legacy, thirdParty } = sanitizedHooks();
  const entry = legacy[0].hooks[0];
  assert.equal(isPotatoOwnedStopHook(entry, identity), true);
  assert.equal(isPotatoOwnedStopHook(entry, { ...identity, runtimePath: identity.runtimePath + '.other' }), false);
  assert.equal(isPotatoOwnedStopHook(thirdParty.hooks[0], identity), false);
  assert.equal(isPotatoOwnedStopHook({ ...entry, commandWindows: 'unrelated' }, identity), false);
  const prefix = entry.command.slice(0, entry.command.lastIndexOf(' ') + 1);
  const script = Buffer.from(entry.command.slice(prefix.length), 'base64').toString('utf16le');
  const injected = prefix + Buffer.from(script + '; other-tool', 'utf16le').toString('base64');
  assert.equal(isPotatoOwnedStopHook({ type: 'command', command: injected }, identity), false);
});


test('desired OFF removes six historical forwarders and current from mixed groups, preserving unrelated entries', (t) => {
  const { codexHome, files } = fixture(t);
  const configPath = path.join(codexHome, 'hooks.json');
  files.add(configPath);
  const { identity, current, legacy, thirdParty } = sanitizedHooks();
  const unrelated = thirdParty.hooks[0];
  const mixed = { matcher: '', metadata: 'retained', hooks: [legacy[0].hooks[0], unrelated] };
  const original = { hooks: { Stop: [mixed, ...legacy.slice(1), current, { matcher: 'empty', hooks: [] }] } };
  fs.writeFileSync(configPath, JSON.stringify(original));
  const result = disableCodexStopHook({ codexHome, commandIdentity: identity });
  assert.equal(result.error, null);
  files.add(result.backupPath);
  assert.equal(JSON.parse(fs.readFileSync(result.backupPath)).hooks.Stop.flatMap((group) => group.hooks).filter((entry) => isPotatoOwnedStopHook(entry, identity)).length, 7);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).hooks.Stop, [{ ...mixed, hooks: [unrelated] }, { matcher: 'empty', hooks: [] }]);
});

test('invalid Stop structure stays untouched and does not create backups', (t) => {
  const { codexHome, files } = fixture(t);
  const configPath = path.join(codexHome, 'hooks.json');
  files.add(configPath);
  const raw = JSON.stringify({ hooks: { Stop: {} } });
  fs.writeFileSync(configPath, raw);
  const result = enableCodexStopHook({ codexHome, command: 'synthetic-stable' });
  assert.match(result.error, /array/);
  assert.equal(result.backupPath, null);
  assert.equal(fs.readFileSync(configPath, 'utf8'), raw);
});

test('external changes during reconciliation are preserved, with original private backup retained', (t) => {
  const { codexHome, files } = fixture(t);
  const configPath = path.join(codexHome, 'hooks.json');
  files.add(configPath);
  const raw = JSON.stringify({ hooks: {} });
  const external = JSON.stringify({ hooks: {}, externallyChanged: true });
  fs.writeFileSync(configPath, raw);
  const fsApi = Object.create(fs);
  fsApi.fsyncSync = (descriptor) => {
    fs.fsyncSync(descriptor);
    fs.writeFileSync(configPath, external);
  };
  const result = enableCodexStopHook({ codexHome, command: 'synthetic-stable', fs: fsApi });
  assert.match(result.error, /changed during reconciliation/);
  files.add(result.backupPath);
  assert.equal(fs.readFileSync(configPath, 'utf8'), external);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), raw);
});
