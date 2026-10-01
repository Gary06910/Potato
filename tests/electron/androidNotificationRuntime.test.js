'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  androidOutboxFilePath,
  createAndroidNotificationRuntime
} = require('../../src/electron/androidNotificationRuntime');
const { createAndroidOutbox } = require('../../src/electron/androidOutbox');

const DESKTOP_ID = 'dev_11111111-1111-4111-8111-111111111111';
const SECOND_DESKTOP_ID = 'dev_22222222-2222-4222-8222-222222222222';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('Android notification runtime pairs, queues the explicit event, and unpairs without exposing its credential', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-android-runtime-'));
  const outboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
  const credential = `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;
  const settings = {
    tokenMAndroidApiUrl: '',
    tokenMAndroidCredential: '',
    tokenMAndroidDesktopId: '',
    tokenMAndroidDesktopName: '',
    tokenMAndroidEnabled: false,
    tokenMAndroidPrivacyMode: true
  };
  const calls = [];
  let eventAccepted;
  const accepted = new Promise((resolve) => { eventAccepted = resolve; });
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, authorization: options.headers.authorization, body });
    if (parsed.pathname.endsWith('/v1/desktop/pair')) {
      return jsonResponse({
        status: 'paired',
        desktop: { desktopId: DESKTOP_ID, name: 'Workstation' },
        credential
      }, 201);
    }
    if (parsed.pathname.endsWith('/v1/desktop/status')) {
      return jsonResponse({
        ok: true,
        desktop: { desktopId: DESKTOP_ID, name: 'Workstation', status: 'active' }
      });
    }
    if (parsed.pathname.endsWith('/v1/desktop/events')) {
      eventAccepted(body);
      return jsonResponse({
        status: 'created',
        taskId: 'tsk_11111111-1111-4111-8111-111111111111',
        notificationStatus: 'not_requested'
      }, 201);
    }
    if (parsed.pathname.endsWith('/v1/desktop/unpair-self')) return jsonResponse({ ok: true });
    return jsonResponse({ error: { code: 'invalid_request' } }, 404);
  };
  const runtime = createAndroidNotificationRuntime({
    userDataPath: directory,
    fetch,
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    hostname: 'Workstation'
  });
  t.after(async () => {
    await runtime.stop();
    if (fs.existsSync(outboxPath)) fs.unlinkSync(outboxPath);
    fs.rmdirSync(directory);
  });

  const paired = await runtime.pair({
    baseUrl: 'https://android.example.test/tokenm-desktop-http',
    code: '123456'
  });
  assert.equal(paired.configured, true);
  assert.equal(paired.enabled, true);
  assert.equal(JSON.stringify(paired).includes(credential), false);
  assert.equal(settings.tokenMAndroidCredential, credential);

  await runtime.start();
  await runtime.enqueue({
    hook_event_name: 'Stop',
    session_id: 'session-1',
    turn_id: 'turn-1',
    occurred_at: new Date().toISOString(),
    cwd: 'C:\\private\\project',
    last_assistant_message: 'private result'
  });
  const keepAlive = setInterval(() => {}, 60_000);
  let event;
  try {
    event = await accepted;
  } finally {
    clearInterval(keepAlive);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.eventId, 'evt:session-1:turn-1');
  assert.equal(event.privacyMode, true);
  assert.deepEqual([event.project, event.model, event.summary, event.durationMs], [null, null, null, null]);
  assert.ok(calls.filter((call) => call.path.endsWith('/v1/desktop/events'))
    .every((call) => call.authorization === `Bearer ${credential}`));

  await runtime.stop();
  const unpaired = await runtime.unpairSelf();
  assert.equal(unpaired.configured, false);
  assert.equal(settings.tokenMAndroidCredential, '');
  assert.deepEqual(calls.at(-1).body, { confirmation: 'UNPAIR' });
});

test('Android binding state is explicit and invalid status pauses automatic delivery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-android-state-'));
  const credential = `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;
  const settings = {
    tokenMAndroidApiUrl: 'https://android.example.test/tokenm-desktop-http',
    tokenMAndroidCredential: credential,
    tokenMAndroidDesktopId: DESKTOP_ID,
    tokenMAndroidDesktopName: 'State workstation',
    tokenMAndroidEnabled: true,
    tokenMAndroidPrivacyMode: true
  };
  let response = jsonResponse({
    ok: true,
    desktop: { desktopId: DESKTOP_ID, name: 'State workstation', status: 'active' }
  });
  const runtime = createAndroidNotificationRuntime({
    userDataPath: directory,
    fetch: async (url) => {
      if (url.endsWith('/v1/desktop/status')) return response;
      return jsonResponse({ status: 'created', notificationStatus: 'not_requested' }, 201);
    },
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    hostname: 'State workstation'
  });
  t.after(async () => {
    await runtime.stop();
    const outboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
    if (fs.existsSync(outboxPath)) fs.unlinkSync(outboxPath);
    fs.rmdirSync(directory);
  });

  settings.tokenMAndroidCredential = '';
  assert.equal((await runtime.start()).bindingState, 'unbound');
  settings.tokenMAndroidCredential = credential;
  const bound = await runtime.start();
  assert.equal(bound.bindingState, 'bound');
  assert.equal(bound.enabled, true);
  assert.equal(bound.outbox.paused, false);

  response = jsonResponse({ ok: true, desktop: { desktopId: DESKTOP_ID, name: 'State workstation' } });
  const malformed = await runtime.refreshStatus();
  assert.equal(malformed.bindingState, 'invalid');
  assert.equal(malformed.outbox.paused, true);
  assert.equal(malformed.outbox.pausedReason, 'invalid_response');

  response = new Response(JSON.stringify({ error: { code: 'desktop_revoked' } }), { status: 401 });
  const revoked = await runtime.refreshStatus();
  assert.equal(revoked.bindingState, 'invalid');
  assert.equal(revoked.enabled, true);
  assert.equal(revoked.desktop.desktopId, DESKTOP_ID);
  assert.equal(settings.tokenMAndroidCredential, credential);
});

test('Android pairing exposes pairing state without persisting the code before success', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-android-pairing-'));
  const credential = `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;
  const settings = {
    tokenMAndroidApiUrl: '',
    tokenMAndroidCredential: '',
    tokenMAndroidDesktopId: '',
    tokenMAndroidDesktopName: '',
    tokenMAndroidEnabled: false,
    tokenMAndroidPrivacyMode: true
  };
  let releasePair;
  const pairGate = new Promise((resolve) => { releasePair = resolve; });
  const runtime = createAndroidNotificationRuntime({
    userDataPath: directory,
    fetch: async (url) => {
      if (url.endsWith('/v1/desktop/pair')) {
        await pairGate;
        return jsonResponse({
          status: 'paired',
          desktop: { desktopId: DESKTOP_ID, name: 'Pairing workstation' },
          credential
        }, 201);
      }
      return jsonResponse({ ok: true });
    },
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    hostname: 'Pairing workstation'
  });
  t.after(async () => {
    await runtime.stop();
    fs.rmdirSync(directory);
  });

  const pending = runtime.pair({
    baseUrl: 'https://android.example.test/tokenm-desktop-http',
    code: '004219'
  });
  assert.equal(runtime.publicStatus().bindingState, 'pairing');
  assert.equal(settings.tokenMAndroidCredential, '');
  assert.equal(settings.tokenMAndroidApiUrl, '');
  releasePair();
  const paired = await pending;
  assert.equal(paired.bindingState, 'bound');
  assert.equal(settings.tokenMAndroidCredential, credential);
});

test('Android unpair uses a temporary client while disabled and clears local credential only after success', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-android-unpair-'));
  const credential = `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;
  const settings = {
    tokenMAndroidApiUrl: 'https://android.example.test/tokenm-desktop-http',
    tokenMAndroidCredential: credential,
    tokenMAndroidDesktopId: DESKTOP_ID,
    tokenMAndroidDesktopName: 'Disabled workstation',
    tokenMAndroidEnabled: false,
    tokenMAndroidPrivacyMode: true
  };
  let unpairCalls = 0;
  const runtime = createAndroidNotificationRuntime({
    userDataPath: directory,
    fetch: async (url, options) => {
      if (url.endsWith('/v1/desktop/unpair-self')) {
        unpairCalls += 1;
        assert.equal(options.headers.authorization, `Bearer ${credential}`);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    },
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    hostname: 'Disabled workstation'
  });
  t.after(async () => {
    await runtime.stop();
    fs.rmdirSync(directory);
  });

  const status = await runtime.unpairSelf();
  assert.equal(unpairCalls, 1);
  assert.equal(status.bindingState, 'unbound');
  assert.equal(settings.tokenMAndroidCredential, '');
  assert.equal(settings.tokenMAndroidDesktopId, '');
  assert.equal(settings.tokenMAndroidEnabled, false);
});

test('malformed Android event acknowledgement keeps the queue and invalidates the binding', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-android-event-response-'));
  const credential = `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;
  const settings = {
    tokenMAndroidApiUrl: 'https://android.example.test/tokenm-desktop-http',
    tokenMAndroidCredential: credential,
    tokenMAndroidDesktopId: DESKTOP_ID,
    tokenMAndroidDesktopName: 'Malformed response workstation',
    tokenMAndroidEnabled: true,
    tokenMAndroidPrivacyMode: true
  };
  let eventSeenResolve;
  const eventSeen = new Promise((resolve) => { eventSeenResolve = resolve; });
  const runtime = createAndroidNotificationRuntime({
    userDataPath: directory,
    fetch: async (url) => {
      if (url.endsWith('/v1/desktop/status')) {
        return jsonResponse({
          ok: true,
          desktop: { desktopId: DESKTOP_ID, name: settings.tokenMAndroidDesktopName, status: 'active' }
        });
      }
      if (url.endsWith('/v1/desktop/events')) {
        eventSeenResolve();
        return jsonResponse({
          status: 'created',
          taskId: 'tsk_11111111-1111-4111-8111-111111111111'
        }, 201);
      }
      return jsonResponse({ ok: true });
    },
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    hostname: 'Malformed response workstation'
  });
  const outboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
  t.after(async () => {
    await runtime.stop();
    if (fs.existsSync(outboxPath)) fs.unlinkSync(outboxPath);
    fs.rmdirSync(directory);
  });

  await runtime.start();
  await runtime.enqueue({
    hook_event_name: 'Stop',
    session_id: 'malformed-session',
    turn_id: 'turn-1',
    occurred_at: new Date().toISOString()
  });
  await eventSeen;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (runtime.publicStatus().bindingState === 'invalid') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const status = runtime.publicStatus();
  assert.equal(status.bindingState, 'invalid');
  assert.equal(status.outbox.paused, true);
  assert.equal(status.outbox.pausedReason, 'invalid_response');
  assert.equal(status.outbox.pending, 1);
  assert.equal(settings.tokenMAndroidCredential, credential);
});

test('Android outbox identity stays isolated across unpair and re-pair', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-android-outbox-identity-'));
  const firstCredential = `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;
  const secondCredential = `tm_uc_d1.${SECOND_DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;
  const settings = {
    tokenMAndroidApiUrl: 'https://android.example.test/tokenm-desktop-http',
    tokenMAndroidCredential: firstCredential,
    tokenMAndroidDesktopId: DESKTOP_ID,
    tokenMAndroidDesktopName: 'First workstation',
    tokenMAndroidEnabled: true,
    tokenMAndroidPrivacyMode: true
  };
  const eventCalls = [];
  const runtime = createAndroidNotificationRuntime({
    userDataPath: directory,
    fetch: async (url, options = {}) => {
      if (url.endsWith('/v1/desktop/pair')) {
        return jsonResponse({
          status: 'paired',
          desktop: { desktopId: SECOND_DESKTOP_ID, name: 'Second workstation' },
          credential: secondCredential
        }, 201);
      }
      if (url.endsWith('/v1/desktop/status')) {
        const authorization = options.headers?.authorization || '';
        const desktopId = authorization === `Bearer ${secondCredential}`
          ? SECOND_DESKTOP_ID
          : DESKTOP_ID;
        const name = desktopId === SECOND_DESKTOP_ID ? 'Second workstation' : 'First workstation';
        return jsonResponse({ ok: true, desktop: { desktopId, name, status: 'active' } });
      }
      if (url.endsWith('/v1/desktop/events')) {
        eventCalls.push({ authorization: options.headers?.authorization, body: JSON.parse(options.body) });
        return jsonResponse({
          status: 'created',
          taskId: 'tsk_22222222-2222-4222-8222-222222222222',
          notificationStatus: 'not_requested'
        }, 201);
      }
      if (url.endsWith('/v1/desktop/unpair-self')) return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: 'invalid_request' } }, 404);
    },
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    hostname: 'Second workstation'
  });
  const firstOutboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
  const secondOutboxPath = androidOutboxFilePath(directory, SECOND_DESKTOP_ID);
  t.after(async () => {
    await runtime.stop();
    if (fs.existsSync(firstOutboxPath)) fs.unlinkSync(firstOutboxPath);
    if (fs.existsSync(secondOutboxPath)) fs.unlinkSync(secondOutboxPath);
    fs.rmdirSync(directory);
  });

  const oldOutbox = createAndroidOutbox({
    filePath: firstOutboxPath,
    send: async () => ({ status: 201 })
  });
  await oldOutbox.enqueue({
    schemaVersion: 1,
    eventId: 'evt:first-session:turn-1',
    event: 'codex.task.completed',
    desktopId: DESKTOP_ID,
    occurredAt: new Date().toISOString(),
    privacyMode: true,
    sessionId: 'first-session',
    project: null,
    model: null,
    summary: null,
    durationMs: null
  });
  await oldOutbox.stop();
  assert.equal(fs.existsSync(firstOutboxPath), true);

  await runtime.unpairSelf();
  assert.equal(settings.tokenMAndroidCredential, '');
  await runtime.pair({
    baseUrl: settings.tokenMAndroidApiUrl,
    code: '123456'
  });
  await runtime.start();

  assert.equal(runtime.outboxPath, secondOutboxPath);
  assert.equal(runtime.publicStatus().bindingState, 'bound');
  assert.equal(runtime.publicStatus().outbox.pending, 0);
  assert.equal(eventCalls.length, 0);
  assert.equal(fs.existsSync(firstOutboxPath), true);
});
