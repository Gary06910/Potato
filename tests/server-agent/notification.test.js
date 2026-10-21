'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseServerAgentConfig } = require('../../src/server-agent/config');
const { createServerAgentPaths } = require('../../src/server-agent/paths');
const {
  createServerNotificationRuntime
} = require('../../src/server-agent/notificationRuntime');
const { writePrivateJsonAtomic } = require('../../src/shared/credentialStore');

const { createLoopbackDiagnostics } = require('../helpers/loopbackDiagnostics');

const DESKTOP_ID = 'dev_11111111-1111-4111-8111-111111111111';
const CREDENTIAL = `tm_uc_d1.${DESKTOP_ID}.${'x'.repeat(43)}`;
const TEST_NOW_MS = Date.parse('2026-09-21T10:05:00.000Z');

function rawInput(sessionId = 'session-1', turnId = 'turn-1') {
  return {
    hook_event_name: 'Stop',
    session_id: sessionId,
    turn_id: turnId,
    occurred_at: '2026-09-21T10:00:00.000Z',
    cwd: 'C:\\private\\server-project',
    model: 'private-model',
    last_assistant_message: 'private assistant message',
    duration_ms: 900
  };
}

function fixture(t, send, runtimeOptions = {}, diagnostics = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-server-notification-'));
  const paths = createServerAgentPaths({ root });
  const codexBusiness = path.join(root, 'codex-business');
  const codexPersonal = path.join(root, 'codex-personal');
  fs.mkdirSync(codexBusiness, { recursive: true });
  fs.mkdirSync(codexPersonal, { recursive: true });
  const config = parseServerAgentConfig({
    version: 1,
    endpoint: 'https://android.example.test/tokenm-desktop-http',
    profiles: [
      { id: 'business', name: 'Business', codexHome: codexBusiness, enabled: true },
      { id: 'personal', name: 'Personal', codexHome: codexPersonal, enabled: true }
    ]
  });
  writePrivateJsonAtomic(paths.credentialFile, {
    version: 1,
    credential: CREDENTIAL,
    desktopId: DESKTOP_ID,
    desktopName: 'A800 Server'
  });
  const { outboxOptions = {}, ...otherRuntimeOptions } = runtimeOptions;
  const runtime = createServerNotificationRuntime({
    config,
    paths,
    fetch: async () => ({}),
    ...otherRuntimeOptions,
    now: () => TEST_NOW_MS,
    outboxOptions: {
      ...outboxOptions,
      now: () => TEST_NOW_MS
    }
  }, {
    ...(diagnostics ? { createCodexHookBridge: diagnostics.bridgeFactory } : {}),
    createAndroidClient: () => ({ sendEvent: send }),
    randomBytes: () => crypto.createHash('sha256').update('test-token').digest()
  });
  const outboxPath = paths.notificationOutboxPath(DESKTOP_ID);
  t.after(async () => {
    diagnostics?.note('cleanup-start');
    try { await runtime.stop(); } finally { diagnostics?.finish(); }
    for (const filePath of [outboxPath, paths.credentialFile]) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    for (const directory of [paths.notificationRoot, paths.stateRoot, path.dirname(paths.credentialFile), paths.dataRoot, codexBusiness, codexPersonal, root]) {
      if (fs.existsSync(directory)) {
        try { fs.rmdirSync(directory); } catch (_) {}
      }
    }
  });
  return { root, paths, config, runtime, outboxPath };
}

test('server runtime uses one source outbox and profile-scoped privacy-safe identities', async (t) => {
  const setup = fixture(t, async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); });
  await setup.runtime.start();
  const longSession = 's'.repeat(128);
  const longTurn = 't'.repeat(128);
  await setup.runtime.enqueue(rawInput(longSession, longTurn), 'business');
  await setup.runtime.enqueue(rawInput(longSession, longTurn), 'personal');
  await setup.runtime.enqueue(rawInput(longSession, longTurn), 'business');
  assert.equal(setup.runtime.publicStatus().privacyMode, true);
  assert.equal(setup.runtime.publicStatus().outbox.total, 2);
  assert.equal(setup.runtime.publicStatus().outbox.pending, 2);
  await setup.runtime.stop();

  const document = JSON.parse(fs.readFileSync(setup.outboxPath, 'utf8'));
  assert.equal(document.items.length, 2);
  assert.notEqual(document.items[0].payload.eventId, document.items[1].payload.eventId);
  assert.notEqual(document.items[0].payload.sessionId, document.items[1].payload.sessionId);
  assert.equal(JSON.stringify(document).includes('C:\\private\\server-project'), false);
  assert.equal(JSON.stringify(document).includes('private assistant message'), false);
  assert.equal(JSON.stringify(document).includes('private-model'), false);
  assert.equal(JSON.stringify(document).includes('profileId'), false);
  assert.equal(path.dirname(setup.outboxPath), setup.paths.notificationRoot);
});

test('server outbox survives offline restart and flushes after recovery', async (t) => {
  const first = fixture(t, async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); }, {
    outboxOptions: { random: () => 0 }
  });
  await first.runtime.start();
  await first.runtime.enqueue(rawInput('restart-session', 'turn-1'), 'business');
  await first.runtime.flush();
  assert.equal(first.runtime.publicStatus().outbox.pending, 1);
  await first.runtime.stop();
  assert.equal(JSON.parse(fs.readFileSync(first.outboxPath, 'utf8')).items.length, 1);

  const sent = [];
  const secondRuntime = createServerNotificationRuntime({
    config: first.config,
    paths: first.paths,
    fetch: async () => ({}),
    now: () => TEST_NOW_MS,
    outboxOptions: { now: () => TEST_NOW_MS }
  }, {
    createAndroidClient: () => ({
      sendEvent: async (payload) => {
        sent.push(payload);
        return { status: 201 };
      }
    }),
    randomBytes: () => crypto.createHash('sha256').update('test-token-2').digest()
  });
  await secondRuntime.start();
  await secondRuntime.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventId, 'evt:business.restart-session:turn-1');
  assert.equal(secondRuntime.publicStatus().outbox.total, 0);
  await secondRuntime.stop();
});

test('credential rejection pauses the source outbox without losing the event', async (t) => {
  const setup = fixture(t, async () => { throw Object.assign(new Error('revoked'), { status: 401, code: 'desktop_revoked' }); });
  await setup.runtime.start();
  await setup.runtime.enqueue(rawInput('blocked-session', 'turn-1'), 'business');
  await setup.runtime.flush();
  const status = setup.runtime.publicStatus();
  assert.equal(status.state, 'blocked');
  assert.equal(status.outbox.paused, true);
  assert.equal(status.outbox.blocked, 1);
  assert.equal(JSON.parse(fs.readFileSync(setup.outboxPath, 'utf8')).items.length, 1);
});

test('loopback bridge requires token and validated profile header', async (t) => {
  const diagnostics = createLoopbackDiagnostics(t);
  const sent = [];
  const setup = fixture(t, async (payload) => {
    sent.push(payload);
    return { status: 201 };
  }, {}, diagnostics);
  diagnostics.note('runtime-start-begin');
  const status = await setup.runtime.start();
  diagnostics.note('runtime-start-complete', diagnostics.snapshot());
  const runtimeDocument = JSON.parse(fs.readFileSync(setup.runtime.runtimePath, 'utf8'));
  assert.deepEqual(Object.keys(runtimeDocument).sort(), ['host', 'port', 'token', 'version']);
  assert.equal(runtimeDocument.host, '127.0.0.1');
  assert.equal(status.bridge.host, '127.0.0.1');
  assert.equal(status.bridge.port, runtimeDocument.port);
  assert.equal(diagnostics.snapshot().listening, true);
  assert.equal(diagnostics.snapshot().address.address, runtimeDocument.host);
  assert.equal(diagnostics.snapshot().address.port, runtimeDocument.port);
  const url = `http://127.0.0.1:${runtimeDocument.port}/codex/stop`;
  const body = JSON.stringify(rawInput('bridge-session', 'turn-1'));

  const unauthorized = await diagnostics.request('unauthorized', url, { method: 'POST', body });
  assert.equal(unauthorized.status, 401);
  const missingProfile = await diagnostics.request('missing-profile', url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token-m-bridge-token': runtimeDocument.token },
    body
  });
  assert.equal(missingProfile.status, 400);
  const unknownProfile = await diagnostics.request('unknown-profile', url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-token-m-bridge-token': runtimeDocument.token,
      'x-to-know-profile-id': 'unknown'
    },
    body
  });
  assert.equal(unknownProfile.status, 400);
  const accepted = await diagnostics.request('valid-profile', url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-token-m-bridge-token': runtimeDocument.token,
      'x-to-know-profile-id': 'business'
    },
    body
  });
  assert.equal(accepted.status, 200);
  await setup.runtime.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'business.bridge-session');
  assert.equal(JSON.stringify(runtimeDocument).includes(CREDENTIAL), false);
  assert.equal(JSON.stringify(runtimeDocument).includes('codex'), false);
});

test('usage failures do not block real notification runtime synthetic events, and notification pause leaves usage independent', async (t) => {
  const { createUsageSyncRuntime } = require('../../src/server-agent/usageSyncRuntime');
  const { serializeServerSnapshot } = require('../../src/server-agent/snapshot');
  for (const notificationPaused of [false, true]) {
    const sent = [];
    const setup = fixture(t, async (payload) => {
      if (notificationPaused) throw Object.assign(Error('revoked'), { status: 401 });
      sent.push(payload); return { status: 'created' };
    });
    let uploads = 0;
    const sync = createUsageSyncRuntime({ config: setup.config, paths: setup.paths }, {
      createClient: () => ({ putUsageSnapshot: async () => { uploads++; throw Object.assign(Error('unavailable'), { status: 500 }); } })
    });
    t.after(() => sync.stop());
    await setup.runtime.start(); sync.start();
    sync.accept('business', serializeServerSnapshot({}, { profile: { id: 'business', name: 'Business' } }).snapshot);
    await setup.runtime.enqueue(rawInput('usage-isolation', 'turn-1'), 'business');
    await setup.runtime.flush();
    assert.equal(uploads, 1);
    assert.equal(sync.status().state, 'ready');
    assert.equal(sent.length, notificationPaused ? 0 : 1);
    assert.equal(setup.runtime.publicStatus().state, notificationPaused ? 'blocked' : 'ready');
    await sync.stop();
  }
});
