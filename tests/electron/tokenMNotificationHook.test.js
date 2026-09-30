'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function createFixture(t, overrides = {}) {
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
    executablePath: process.execPath
  });
  const hooksPath = path.join(codexHome, 'hooks.json');
  const outboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
  const stableHookDirectory = path.join(directory, 'codex-hook');
  t.after(async () => {
    try {
      const disabled = await runtime.disableCodexHook();
      if (disabled.backupPath) fs.unlinkSync(disabled.backupPath);
    } catch (_) {}
    await runtime.stop();
    if (fs.existsSync(hooksPath)) fs.unlinkSync(hooksPath);
    if (fs.existsSync(outboxPath)) fs.unlinkSync(outboxPath);
    if (fs.existsSync(path.join(stableHookDirectory, 'launcher.ps1'))) fs.unlinkSync(path.join(stableHookDirectory, 'launcher.ps1'));
    if (fs.existsSync(path.join(stableHookDirectory, 'target.json'))) fs.unlinkSync(path.join(stableHookDirectory, 'target.json'));
    if (fs.existsSync(stableHookDirectory)) fs.rmdirSync(stableHookDirectory);
    fs.rmdirSync(codexHome);
    fs.rmdirSync(directory);
  });
  return { directory, codexHome, events, hooksPath, runtime, settings };
}

test('Windows Hook command stays byte-for-byte stable when the portable executable moves versions', () => {
  const launcherPath = 'C:\\Users\\Gary\\AppData\\Roaming\\Token Monitor\\codex-hook\\launcher.ps1';
  const manifestPath = 'C:\\Users\\Gary\\AppData\\Roaming\\Token Monitor\\codex-hook\\target.json';
  const first = hookCommandFor({
    platform: 'win32',
    executablePath: 'C:\\Apps\\To-Know-1.0.0.exe',
    helperPath: 'C:\\Apps\\resources\\app.asar\\src\\electron\\codexHookForwarder.js',
    runtimePath: 'C:\\Users\\Gary\\AppData\\Roaming\\Token Monitor\\token-m-notification-runtime.json',
    launcherPath,
    manifestPath
  });
  const second = hookCommandFor({
    platform: 'win32',
    executablePath: 'C:\\Apps\\To-Know-1.0.1.exe',
    helperPath: 'C:\\Apps\\resources\\app.asar\\src\\electron\\codexHookForwarder.js',
    runtimePath: 'C:\\Users\\Gary\\AppData\\Roaming\\Token Monitor\\token-m-notification-runtime.json',
    launcherPath,
    manifestPath
  });
  assert.equal(first, second);
  assert.match(first, /launcher\.ps1/);
  assert.match(first, /target\.json/);
  assert.doesNotMatch(first, /To-Know-1\.0\.[01]\.exe/);
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
