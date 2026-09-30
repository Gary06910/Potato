'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTokenMNotificationRuntime } = require('../../src/electron/tokenMNotificationRuntime');
const { androidOutboxFilePath } = require('../../src/electron/androidNotificationRuntime');

const ANDROID_DESKTOP = 'dev_11111111-1111-4111-8111-111111111111';
const WECHAT_DESKTOP = 'dev_abcdefghijklmnopqrstuv';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function postCompletion(runtimePath, input) {
  const metadata = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  const response = await fetch(`http://${metadata.host}:${metadata.port}/codex/stop`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-token-m-bridge-token': metadata.token
    },
    body: JSON.stringify(input)
  });
  assert.equal(response.status, 200);
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for Android event delivery');
}

test('Stop hook ignores historical destination settings and submits Android events only', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-target-runtime-'));
  const codexHome = path.join(directory, 'codex-home');
  fs.mkdirSync(codexHome);
  const settings = {
    tokenMNotificationTarget: 'wechat',
    tokenMAndroidApiUrl: 'https://android.example.test/tokenm-desktop-http',
    tokenMAndroidCredential: `tm_uc_d1.${ANDROID_DESKTOP}.${crypto.randomBytes(32).toString('base64url')}`,
    tokenMAndroidDesktopId: ANDROID_DESKTOP,
    tokenMAndroidDesktopName: 'Android workstation',
    tokenMAndroidEnabled: true,
    tokenMAndroidPrivacyMode: true,
    tokenMWeChatApiUrl: 'https://wechat.example.test',
    tokenMWeChatCredential: `tm_wx_d1.${WECHAT_DESKTOP}.${crypto.randomBytes(32).toString('base64url')}`,
    tokenMWeChatDesktopId: WECHAT_DESKTOP,
    tokenMWeChatDesktopName: 'WeChat workstation',
    tokenMWeChatEnabled: true,
    tokenMWeChatPrivacyMode: true
  };
  const androidEvents = [];
  const wechatEvents = [];
  let acceptAndroid;
  const androidAccepted = new Promise((resolve) => { acceptAndroid = resolve; });
  const cloudFetch = async (url, options) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    if (parsed.hostname === 'android.example.test') {
      if (parsed.pathname.endsWith('/v1/desktop/status')) {
        return jsonResponse({
          ok: true,
          desktop: { desktopId: ANDROID_DESKTOP, name: 'Android workstation', status: 'active' }
        });
      }
      if (parsed.pathname.endsWith('/v1/desktop/events')) {
        androidEvents.push(body);
        acceptAndroid();
        return jsonResponse({
          status: androidEvents.length === 1 ? 'created' : 'duplicate',
          taskId: 'tsk_11111111-1111-4111-8111-111111111111',
          notificationStatus: 'not_requested'
        }, 201);
      }
    }
    if (parsed.hostname === 'wechat.example.test') {
      if (parsed.pathname === '/v1/desktop/status') {
        return jsonResponse({
          ok: true,
          desktop: { desktopId: WECHAT_DESKTOP, name: 'WeChat workstation', status: 'active' }
        });
      }
      if (parsed.pathname === '/v1/desktop/events') {
        wechatEvents.push(body);
        return jsonResponse({ status: 'created' }, 201);
      }
    }
    return jsonResponse({ error: { code: 'invalid_request' } }, 404);
  };
  const runtime = createTokenMNotificationRuntime({
    userDataPath: directory,
    codexHome,
    fetch: cloudFetch,
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    platform: process.platform,
    executablePath: process.execPath
  });
  const androidOutbox = androidOutboxFilePath(directory, ANDROID_DESKTOP);
  const wechatOutbox = path.join(directory, 'token-m-wechat-outbox.json');
  const hooksPath = path.join(codexHome, 'hooks.json');
  const hookDirectory = path.join(directory, 'codex-hook');
  const hookLauncherPath = path.join(hookDirectory, 'launcher.ps1');
  const hookManifestPath = path.join(hookDirectory, 'target.json');
  t.after(async () => {
    try {
      const disabled = await runtime.disableCodexHook();
      if (disabled.backupPath) fs.unlinkSync(disabled.backupPath);
    } catch (_) {}
    await runtime.stop();
    if (fs.existsSync(androidOutbox)) fs.unlinkSync(androidOutbox);
    if (fs.existsSync(wechatOutbox)) fs.unlinkSync(wechatOutbox);
    if (fs.existsSync(hooksPath)) fs.unlinkSync(hooksPath);
    if (fs.existsSync(hookLauncherPath)) fs.unlinkSync(hookLauncherPath);
    if (fs.existsSync(hookManifestPath)) fs.unlinkSync(hookManifestPath);
    if (fs.existsSync(hookDirectory)) fs.rmdirSync(hookDirectory);
    fs.rmdirSync(codexHome);
    fs.rmdirSync(directory);
  });

  let status = await runtime.start();
  assert.equal(status.android.configured, true);
  assert.equal(status.wechat, undefined);
  assert.equal(runtime.setNotificationTarget, undefined);
  const hook = await runtime.enableCodexHook();
  assert.equal(hook.enabled, true, hook.error || 'hook should be enabled');
  await postCompletion(runtime.runtimePath, {
    hook_event_name: 'Stop',
    session_id: 'session-android',
    turn_id: 'turn-1',
    occurred_at: new Date().toISOString()
  });
  await androidAccepted;
  assert.equal(androidEvents.length, 1);
  assert.equal(androidEvents[0].eventId, 'evt:session-android:turn-1');
  assert.equal(wechatEvents.length, 0);

  await postCompletion(runtime.runtimePath, {
    hook_event_name: 'Stop', session_id: 'session-android', turn_id: 'turn-1',
    occurred_at: new Date().toISOString()
  });
  status = await runtime.getStatus();
  assert.equal(status.android.bindingState, 'bound');
  await waitFor(() => androidEvents.length === 2);
  assert.equal(androidEvents.length, 2);
  assert.equal(androidEvents[1].eventId, androidEvents[0].eventId);
  assert.equal(wechatEvents.length, 0);
});
