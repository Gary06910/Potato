'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createTokenMNotificationRuntime,
  hookCommandFor
} = require('../../src/electron/tokenMNotificationRuntime');
const { androidOutboxFilePath } = require('../../src/electron/androidNotificationRuntime');

const DESKTOP_ID = 'dev_33333333-3333-4333-8333-333333333333';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function createFixture(t, overrides = {}, runtimeOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-hook-reconcile-'));
  const codexHome = path.join(directory, 'codex-home');
  fs.mkdirSync(codexHome);
  const settings = {
    tokenMAndroidApiUrl: 'https://android.example.test/tokenm-desktop-http',
    tokenMAndroidCredential: `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`,
    tokenMAndroidDesktopId: DESKTOP_ID,
    tokenMAndroidDesktopName: 'Hook workstation',
    tokenMAndroidEnabled: false,
    tokenMAndroidPrivacyMode: true,
    tokenMCodexHookEnabled: false,
    tokenMCodexLastHookEventAt: '',
    ...overrides
  };
  const events = [];
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/v1/desktop/status')) {
      return jsonResponse({
        ok: true,
        desktop: { desktopId: DESKTOP_ID, name: 'Hook workstation', status: 'active' }
      });
    }
    if (parsed.pathname.endsWith('/v1/desktop/events')) {
      events.push(options.body ? JSON.parse(options.body) : null);
      return jsonResponse({
        status: 'created',
        taskId: 'tsk_33333333-3333-4333-8333-333333333333',
        notificationStatus: 'not_requested'
      }, 201);
    }
    return jsonResponse({ error: { code: 'invalid_request' } }, 404);
  };
  const runtime = createTokenMNotificationRuntime({
    userDataPath: directory,
    codexHome,
    fetch,
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    platform: 'linux',
    executablePath: process.execPath,
    ...runtimeOptions
  });
  const hooksPath = path.join(codexHome, 'hooks.json');
  const outboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
  const stableHookDirectory = path.join(directory, 'codex-hook');
  const cleanup = { migrationBackup: null };
  t.after(async () => {
    try {
      const disabled = await runtime.disableCodexHook();
      if (disabled.backupPath) fs.unlinkSync(disabled.backupPath);
    } catch (_) {}
    await runtime.stop();
    if (cleanup.migrationBackup) fs.unlinkSync(cleanup.migrationBackup);
    if (fs.existsSync(hooksPath)) fs.unlinkSync(hooksPath);
    if (fs.existsSync(outboxPath)) fs.unlinkSync(outboxPath);
    if (fs.existsSync(path.join(stableHookDirectory, 'launcher.ps1'))) fs.unlinkSync(path.join(stableHookDirectory, 'launcher.ps1'));
    if (fs.existsSync(path.join(stableHookDirectory, 'target.json'))) fs.unlinkSync(path.join(stableHookDirectory, 'target.json'));
    if (fs.existsSync(stableHookDirectory)) fs.rmdirSync(stableHookDirectory);
    fs.rmdirSync(codexHome);
    fs.rmdirSync(directory);
  });
  return { directory, codexHome, events, hooksPath, runtime, settings, cleanup };
}

test('Windows Hook command stays byte-for-byte stable when the portable executable moves versions', () => {
  const launcherPath = '/C:/Users/Gary/AppData/Roaming/Token Monitor/codex-hook/launcher.ps1';
  const manifestPath = '/C:/Users/Gary/AppData/Roaming/Token Monitor/codex-hook/target.json';
  const first = hookCommandFor({
    platform: 'win32',
    executablePath: '/C:/Apps/To-Know-1.0.0.exe',
    helperPath: '/C:/Apps/resources/app.asar/src/electron/codexHookForwarder.js',
    runtimePath: '/C:/Users/Gary/AppData/Roaming/Token Monitor/token-m-notification-runtime.json',
    launcherPath,
    manifestPath
  });
  const second = hookCommandFor({
    platform: 'win32',
    executablePath: '/C:/Moved Apps/To-Know-1.0.1.exe',
    helperPath: '/C:/Moved Apps/resources/app.asar/src/electron/codexHookForwarder.js',
    runtimePath: '/C:/Users/Gary/AppData/Roaming/Token Monitor/token-m-notification-runtime.json',
    launcherPath,
    manifestPath
  });
  assert.equal(first, second);
  assert.equal(first, `powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -File "${launcherPath}" "${manifestPath}"`);
  assert.doesNotMatch(first, /-File '/);
  assert.match(first, /launcher\.ps1/);
  assert.match(first, /target\.json/);
  assert.doesNotMatch(first, /To-Know-1\.0\.[01]\.exe/);
});

test('Windows full Hook command reaches the bridge through cmd.exe without enqueueing an invalid identity', { skip: process.platform !== 'win32' }, async (t) => {
  const { directory, hooksPath, runtime, settings, events } = createFixture(t, {
    tokenMAndroidEnabled: true, tokenMCodexHookEnabled: true
  }, { platform: 'win32' });
  assert.equal((await runtime.start()).hook.enabled, true);
  const command = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks.Stop[0].hooks[0].commandWindows;
  const outboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
  const beforeOutbox = fs.existsSync(outboxPath) ? fs.readFileSync(outboxPath, 'utf8') : null;
  const beforeEvent = settings.tokenMCodexLastHookEventAt;
  const result = await new Promise((resolve, reject) => {
    // Keep the bridge's event loop running while the real command shell invokes the helper.
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
      windowsVerbatimArguments: true, windowsHide: true, timeout: 20_000
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => { stderr += data; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: '', turn_id: '', cwd: 'C:\\', last_assistant_message: null }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(settings.tokenMCodexLastHookEventAt, beforeEvent);
  assert.equal(events.length, 0);
  assert.equal(fs.existsSync(outboxPath) ? fs.readFileSync(outboxPath, 'utf8') : null, beforeOutbox);
});

test('Windows startup migrates only the exact broken stable command and remains idempotent', async (t) => {
  const { directory, codexHome, hooksPath, runtime, cleanup } = createFixture(t, {
    tokenMCodexHookEnabled: true
  }, { platform: 'win32' });
  const launcherPath = path.join(directory, 'codex-hook', 'launcher.ps1');
  const manifestPath = path.join(directory, 'codex-hook', 'target.json');
  // Freeze the historical template independently of the production identity generator.
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const oldCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -File ${quote(launcherPath)} ${quote(manifestPath)}`;
  const thirdParty = { type: 'command', command: oldCommand + ' --third-party', commandWindows: 'echo third-party', timeout: 17 };
  fs.writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [
    { type: 'command', command: oldCommand, commandWindows: oldCommand, timeout: 5 }, thirdParty
  ] }] } }));
  assert.equal((await runtime.start()).hook.enabled, true);
  const handlers = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks.Stop.flatMap((group) => group.hooks);
  assert.equal(handlers.filter((entry) => entry.command === oldCommand || entry.commandWindows === oldCommand).length, 0);
  assert.equal(handlers.filter((entry) => entry.command === runtime.commandIdentity && entry.commandWindows === runtime.commandIdentity).length, 1);
  assert.equal(handlers.length, 2);
  assert.deepEqual(handlers[0], thirdParty);
  const backups = fs.readdirSync(codexHome).filter((name) => name.startsWith('hooks.json.token-m-backup-'));
  assert.equal(backups.length, 1);
  cleanup.migrationBackup = path.join(codexHome, backups[0]);
  const bytes = fs.readFileSync(hooksPath, 'utf8');
  const mtime = fs.statSync(hooksPath).mtimeMs;
  assert.equal((await runtime.start()).hook.enabled, true);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), bytes);
  assert.equal(fs.statSync(hooksPath).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(codexHome).filter((name) => name.startsWith('hooks.json.token-m-backup-')), backups);
});

test('Windows launcher repairs literal newlines and reconciles valid CRLF source and target idempotently', async (t) => {
  const { directory, hooksPath, runtime } = createFixture(t, {
    tokenMCodexHookEnabled: true
  }, { platform: 'win32' });
  const launcherPath = path.join(directory, 'codex-hook', 'launcher.ps1');
  const manifestPath = path.join(directory, 'codex-hook', 'target.json');
  assert.equal((await runtime.start()).hook.enabled, true);
  const source = fs.readFileSync(launcherPath, 'utf8');
  assert.equal(source.includes('`r`n'), false);
  assert.equal(source.includes('\r\n'), true);
  assert.equal(source.endsWith('\r\n'), true);
  assert.equal(source.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(source.replaceAll('\r\n', '').includes('\r'), false);
  const lines = source.split('\r\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "$ErrorActionPreference = 'Stop'");
  assert.equal(lines[1], '$reader = [Console]::In');
  assert.equal(lines[18], '$payload | & $executablePath $helperPath $runtimePath');
  assert.equal(lines[19], 'exit $LASTEXITCODE');
  assert.equal(lines.every((line) => line.length > 0), true);

  if (process.platform === 'win32') {
    const parsed = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$tokens = $null; $parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${launcherPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$parseErrors); Write-Output $parseErrors.Count; if ($parseErrors.Count) { exit 1 }`
    ], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.equal(parsed.stdout.trim(), '0');
  }

  fs.writeFileSync(launcherPath, source.replaceAll('\r\n', '`r`n'), 'utf8');
  assert.equal((await runtime.start()).hook.enabled, true);
  assert.equal(fs.readFileSync(launcherPath, 'utf8'), source);
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  assert.deepEqual(JSON.parse(manifest), {
    version: 1, executablePath: process.execPath,
    helperPath: path.resolve(__dirname, '../../src/electron/codexHookForwarder.js'),
    runtimePath: runtime.runtimePath
  });
  const hooks = fs.readFileSync(hooksPath, 'utf8');
  const launcherMtime = fs.statSync(launcherPath).mtimeMs;
  const hooksMtime = fs.statSync(hooksPath).mtimeMs;
  assert.equal((await runtime.start()).hook.enabled, true);
  assert.equal(fs.readFileSync(launcherPath, 'utf8'), source);
  assert.equal(fs.statSync(launcherPath).mtimeMs, launcherMtime);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifest);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), hooks);
  assert.equal(fs.statSync(hooksPath).mtimeMs, hooksMtime);
  assert.equal(JSON.parse(hooks).hooks.Stop.length, 1);
});

test('startup reconciles the persisted Hook intent without rewriting an exact definition', async (t) => {
  const fixture = createFixture(t);
  const { hooksPath, runtime, settings } = fixture;

  let status = await runtime.start();
  assert.equal(status.hook.status, 'disabled');
  assert.equal(fs.existsSync(hooksPath), false);

  settings.tokenMCodexHookEnabled = true;
  status = await runtime.start();
  assert.equal(status.hook.status, 'needsTrust');
  assert.equal(status.hook.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks.Stop.length, 1);

  const before = fs.readFileSync(hooksPath, 'utf8');
  const beforeMtime = fs.statSync(hooksPath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 25));
  status = await runtime.start();
  assert.equal(status.hook.status, 'needsTrust');
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), before);
  assert.equal(fs.statSync(hooksPath).mtimeMs, beforeMtime);

  fs.unlinkSync(hooksPath);
  status = await runtime.start();
  assert.equal(status.hook.enabled, true);
  assert.equal(status.hook.status, 'needsTrust');
  assert.equal(fs.existsSync(hooksPath), true);

  const disabled = await runtime.setAndroidEnabled(false);
  assert.equal(disabled.hook.enabled, true);
  assert.equal(settings.tokenMCodexHookEnabled, true);
  const reenabled = await runtime.setAndroidEnabled(true);
  assert.equal(reenabled.hook.enabled, true);
  assert.equal(settings.tokenMCodexHookEnabled, true);
});

test('an unbound Android device rejects enabling and does not write a Hook', async (t) => {
  const fixture = createFixture(t, {
    tokenMAndroidApiUrl: '',
    tokenMAndroidCredential: '',
    tokenMAndroidDesktopId: '',
    tokenMAndroidDesktopName: ''
  });
  const { hooksPath, runtime, settings } = fixture;
  await runtime.start();
  await assert.rejects(runtime.enableCodexHook(), /notifications_not_configured|android_credential_invalid/);
  assert.equal(settings.tokenMCodexHookEnabled, false);
  assert.equal(fs.existsSync(hooksPath), false);
});

test('a trusted runtime event records only a safe timestamp and disabling removes the owned Hook', async (t) => {
  const fixture = createFixture(t, { tokenMAndroidEnabled: true, tokenMCodexHookEnabled: true });
  const { events, runtime, settings } = fixture;
  const status = await runtime.start();
  assert.equal(status.hook.status, 'needsTrust');
  const metadata = JSON.parse(fs.readFileSync(runtime.runtimePath, 'utf8'));
  const response = await fetch(`http://${metadata.host}:${metadata.port}/codex/stop`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-token-m-bridge-token': metadata.token
    },
    body: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'private-session',
      turn_id: 'private-turn',
      cwd: 'C:\\private\\project',
      last_assistant_message: 'private reply'
    })
  });
  assert.equal(response.status, 200);
  const afterEvent = await runtime.getStatus();
  assert.equal(afterEvent.hook.status, 'active');
  assert.match(afterEvent.hook.lastHookEventAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(settings.tokenMCodexLastHookEventAt, afterEvent.hook.lastHookEventAt);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(afterEvent), /private-session|private-turn|private reply|private\\project/);

  const disabled = await runtime.disableCodexHook();
  assert.ok(disabled.backupPath);
  fs.unlinkSync(disabled.backupPath);
  assert.equal(disabled.enabled, false);
  assert.equal(settings.tokenMCodexHookEnabled, false);
  assert.equal(settings.tokenMAndroidCredential.includes(DESKTOP_ID), true);
  assert.equal((await runtime.getStatus()).hook.status, 'disabled');
});
