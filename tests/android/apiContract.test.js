'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../apps/tokenm-android/uniCloud-alipay');
const core = require(path.join(projectRoot, 'cloudfunctions/common/tokenm-core'));
const cloudObject = require(path.join(projectRoot, 'cloudfunctions/tokenm-co/index.obj.js'));
const { createHttpHandler, MAX_BODY_BYTES } = require(path.join(
  projectRoot,
  'cloudfunctions/tokenm-desktop-http/http-contract.js'
));

const FIXED_NOW = Date.parse('2026-08-23T08:00:00.000Z');
const TEST_KEY = randomBytes(32);
const COLLECTION_NAMES = Object.freeze([
  'tokenm-usage-snapshots',
  'tokenm-users',
  'tokenm-desktops',
  'tokenm-pairing-sessions',
  'tokenm-tasks',
  'tokenm-mobile-devices',
  'tokenm-rate-limits'
]);

function createApplication() {
  return new core.TokenMApplication({
    repository: new core.MemoryRepository(),
    credentialKey: TEST_KEY,
    now: () => FIXED_NOW,
    provider: { async submit() { return { status: 'submitted' }; } }
  });
}

function request(method, route, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body = options.body;
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body);
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  }
  return {
    httpMethod: method,
    path: route,
    headers,
    body,
    isBase64Encoded: options.isBase64Encoded ?? false
  };
}

function parsed(response) {
  return JSON.parse(response.body);
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.name.endsWith('.js') ? [absolute] : [];
  });
}

test('Desktop URLized function preserves pair, status, events, duplicate, conflict, and unpair-self HTTP shapes', async () => {
  const application = createApplication();
  await application.bootstrap('uid-http');
  await application.updatePrivacyConsent('uid-http', {
    version: core.PRIVACY_CONSENT_VERSION
  });
  await application.registerMobileDevice('uid-http', {
    deviceLabel: 'Android',
    pushRegistrationStatus: 'ready',
    notificationPermissionState: 'authorized'
  }, {
    deviceId: 'http-installation',
    platform: 'app',
    appVersion: '1.0.0'
  });
  const pairing = await application.createPairingCode('uid-http');
  const handler = createHttpHandler({
    application,
    requestIdFactory: () => 'req_11111111-1111-4111-8111-111111111111'
  });
  const pairResponse = await handler(request('POST', '/v1/desktop/pair', {
    body: { schemaVersion: 1, code: pairing.code, deviceName: 'HTTP Desktop' }
  }), { CLIENTIP: '203.0.113.7' });
  const pairBody = parsed(pairResponse);
  assert.equal(pairResponse.statusCode, 201);
  assert.equal(pairResponse.mpserverlessComposedResponse, true);
  assert.equal(pairResponse.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(pairBody).sort(), [
    'credential',
    'desktop',
    'requestId',
    'status'
  ]);
  assert.deepEqual(Object.keys(pairBody.desktop).sort(), ['desktopId', 'name']);
  assert.match(pairBody.credential, /^tm_uc_d1\.dev_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

  const authorization = { authorization: `Bearer ${pairBody.credential}` };
  const statusResponse = await handler(request('GET', '/v1/desktop/status', {
    headers: authorization
  }));
  const statusBody = parsed(statusResponse);
  assert.equal(statusResponse.statusCode, 200);
  assert.deepEqual(Object.keys(statusBody.desktop).sort(), [
    'desktopId',
    'lastEventAt',
    'lastSeenAt',
    'name',
    'status'
  ]);
  assert.equal(statusBody.desktop.desktopId, pairBody.desktop.desktopId);

  const event = {
    schemaVersion: 1,
    eventId: 'evt:http-session:turn-1',
    event: 'codex.task.completed',
    desktopId: pairBody.desktop.desktopId,
    occurredAt: new Date(FIXED_NOW).toISOString(),
    privacyMode: true,
    sessionId: 'http-session',
    project: null,
    model: null,
    summary: null,
    durationMs: null
  };
  const eventResponse = await handler(request('POST', '/v1/desktop/events', {
    headers: { ...authorization, 'content-type': 'application/json' },
    body: event
  }));
  const eventBody = parsed(eventResponse);
  assert.equal(eventResponse.statusCode, 201);
  assert.deepEqual(Object.keys(eventBody).sort(), [
    'notificationStatus',
    'requestId',
    'status',
    'taskId'
  ]);
  assert.equal(eventBody.notificationStatus, 'not_requested');

  const duplicateResponse = await handler(request('POST', '/v1/desktop/events', {
    headers: { ...authorization, 'content-type': 'application/json' },
    body: event
  }));
  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(parsed(duplicateResponse).status, 'duplicate');
  const conflictResponse = await handler(request('POST', '/v1/desktop/events', {
    headers: { ...authorization, 'content-type': 'application/json' },
    body: { ...event, sessionId: 'changed' }
  }));
  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(parsed(conflictResponse).error.code, 'event_conflict');

  const unpairResponse = await handler(request('POST', '/v1/desktop/unpair-self', {
    headers: { ...authorization, 'content-type': 'application/json' },
    body: { confirmation: 'UNPAIR' }
  }));
  assert.equal(unpairResponse.statusCode, 200);
  assert.equal(parsed(unpairResponse).ok, true);
  const revokedResponse = await handler(request('GET', '/v1/desktop/status', {
    headers: authorization
  }));
  assert.equal(revokedResponse.statusCode, 401);
  assert.equal(parsed(revokedResponse).error.code, 'desktop_revoked');
});

test('HTTP adapter passes only validated platform client IP scope and never reflects credentials, bodies, or internal errors', async () => {
  let pairContext;
  const safeHandler = createHttpHandler({
    application: {
      async pair(_input, context) {
        pairContext = context;
        return {
          status: 'paired',
          desktop: { desktopId: 'dev_11111111-1111-4111-8111-111111111111', name: 'Desktop' },
          credential: 'tm_uc_d1.dev_11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
        };
      }
    },
    requestIdFactory: () => 'req_test'
  });
  await safeHandler(request('POST', '/v1/desktop/pair', {
    headers: {
      'content-type': 'application/json',
      'user-agent': 'must-not-be-a-rate-subject',
      'x-forwarded-for': '198.51.100.8'
    },
    body: { schemaVersion: 1, code: '123456', deviceName: 'Desktop' }
  }), { CLIENTIP: '203.0.113.7' });
  assert.deepEqual(pairContext, { rateSubject: 'client-ip:203.0.113.7' });

  const missingClientIp = await safeHandler(request('POST', '/v1/desktop/pair', {
    body: { schemaVersion: 1, code: '123456', deviceName: 'Desktop' }
  }));
  assert.equal(missingClientIp.statusCode, 503);
  assert.equal(parsed(missingClientIp).error.code, 'configuration_required');
  const invalidClientIp = await safeHandler(request('POST', '/v1/desktop/pair', {
    body: { schemaVersion: 1, code: '123456', deviceName: 'Desktop' }
  }), { CLIENTIP: 'not-an-ip', xForwardedFor: '198.51.100.8' });
  assert.equal(invalidClientIp.statusCode, 503);
  assert.equal(parsed(invalidClientIp).error.code, 'configuration_required');

  const exposedSecret = 'tm_uc_d1.dev_11111111-1111-4111-8111-111111111111.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const failingHandler = createHttpHandler({
    application: {
      async status() {
        throw new Error(`database failed for ${exposedSecret}`);
      }
    },
    requestIdFactory: () => 'req_test'
  });
  const failed = await failingHandler(request('GET', '/v1/desktop/status', {
    headers: { authorization: `Bearer ${exposedSecret}` }
  }));
  assert.equal(failed.statusCode, 500);
  assert.equal(parsed(failed).error.code, 'internal_error');
  assert.equal(failed.body.includes(exposedSecret), false);
  assert.equal(failed.body.includes('database failed'), false);

  const oversized = await safeHandler(request('POST', '/v1/desktop/pair', {
    body: JSON.stringify({ value: 'x'.repeat(MAX_BODY_BYTES) }),
    headers: { 'content-type': 'application/json' }
  }), { CLIENTIP: '203.0.113.7' });
  assert.equal(oversized.statusCode, 413);
  assert.equal(parsed(oversized).error.code, 'body_too_large');
});

test('cloud functions pin the supported runtime and only the Desktop HTTP entrypoint is URLized', () => {
  const tokenmCo = json('cloudfunctions/tokenm-co/package.json');
  assert.deepEqual(tokenmCo['cloudfunction-config'], {
    runtime: 'Nodejs18',
    timeout: 10
  });
  assert.equal(Object.hasOwn(tokenmCo['cloudfunction-config'], 'path'), false);

  const desktopHttp = json('cloudfunctions/tokenm-desktop-http/package.json');
  assert.deepEqual(desktopHttp['cloudfunction-config'], {
    runtime: 'Nodejs18',
    timeout: 10,
    path: '/tokenm-desktop-http'
  });
});

test('Cloud Object delegates every mobile method under checkToken uid and authoritative client device identity', async () => {
  const source = read('cloudfunctions/tokenm-co/index.obj.js');
  const requiredMethods = [
    'bootstrap',
    'getDashboard',
    'listTasks',
    'getTask',
    'deleteTask',
    'clearTasks',
    'listDesktops',
    'createPairingCode',
    'getPairingStatus',
    'renameDesktop',
    'unbindDesktop',
    'updateSettings',
    'getPrivacyConsent',
    'updatePrivacyConsent',
    'registerMobileDevice',
    'clearTaskHistory',
    'deleteAccount'
  ];
  assert.match(source, /require\('uni-id-common'\)/);
  assert.match(source, /createInstance\(\{ clientInfo \}\)/);
  assert.match(source, /checkToken\(this\.getUniIdToken\(\)\)/);
  assert.match(source, /this\.tokenmUid = checked\.uid/);
  assert.match(source, /deviceId: clientInfo\.deviceId/);
  assert.doesNotMatch(source, /input\.(?:ownerId|userId|openid)/);
  for (const method of requiredMethods) assert.equal(typeof cloudObject[method], 'function');

  const application = createApplication();
  const context = {
    tokenmUid: 'uid-authenticated',
    tokenmApplication: application,
    getClientInfo() {
      return { deviceId: 'official-device-id', platform: 'app', appVersion: '1.0.0' };
    }
  };
  await assert.rejects(cloudObject.registerMobileDevice.call(context, {
    ownerId: 'uid-attacker'
  }), (error) => error.code === 'invalid_request');
  await assert.rejects(cloudObject.registerMobileDevice.call(context, {
    deviceLabel: 'Authenticated device',
    pushRegistrationStatus: 'ready',
    notificationPermissionState: 'authorized'
  }), (error) => error.code === 'privacy_consent_required');
  const disabled = await cloudObject.registerMobileDevice.call(context, {
    enabled: false,
    deviceLabel: 'Authenticated device',
    pushRegistrationStatus: 'ready',
    notificationPermissionState: 'authorized'
  });
  assert.equal(disabled.device.status, 'disabled');

  await assert.rejects(cloudObject.updatePrivacyConsent.call(context, {
    version: core.PRIVACY_CONSENT_VERSION,
    ownerId: 'uid-attacker'
  }), (error) => error.code === 'invalid_request');
  await cloudObject.updatePrivacyConsent.call(context, {
    version: core.PRIVACY_CONSENT_VERSION
  });
  await cloudObject.registerMobileDevice.call(context, {
    deviceLabel: 'Authenticated device',
    pushRegistrationStatus: 'ready',
    notificationPermissionState: 'authorized'
  });
  const stored = application.repository.snapshot(core.COLLECTIONS.mobileDevices)[0];
  assert.equal(stored.ownerId, 'uid-authenticated');
  assert.equal(stored.deviceId, 'official-device-id');
  assert.equal(stored.status, 'active');
  const consentUser = await application.repository.findById(
    core.COLLECTIONS.users,
    'uid-authenticated'
  );
  assert.equal(consentUser.privacyConsentVersion, core.PRIVACY_CONSENT_VERSION);
});

test('Cloud Object _after returns normal values and emits only safe uniCloud error envelopes', () => {
  const normal = { ok: true, value: 'unchanged' };
  assert.strictEqual(cloudObject._after(null, normal), normal);

  const tokenMError = new core.AppError('invalid_request', {
    field: 'secret-value-must-not-be-reflected'
  });
  assert.deepEqual(cloudObject._after(tokenMError), {
    errCode: 'invalid_request',
    errMsg: 'The request is invalid.'
  });
  assert.deepEqual(cloudObject._after(new core.AppError('privacy_consent_required', {
    acceptedVersion: 'must-not-be-reflected'
  })), {
    errCode: 'privacy_consent_required',
    errMsg: 'Privacy consent is required.'
  });

  assert.deepEqual(cloudObject._after({
    errCode: 'uni-id-token-expired',
    errMsg: 'provider detail must not be reflected'
  }), {
    errCode: 'uni-id-token-expired',
    errMsg: 'Authentication is required.'
  });

  const unknown = cloudObject._after(new Error(
    'database and credential detail must not be reflected'
  ));
  assert.deepEqual(unknown, {
    errCode: 'internal_error',
    errMsg: 'The request could not be completed.'
  });
  assert.doesNotMatch(JSON.stringify(unknown), /database|credential/);
});

test('all server-only schemas and支付宝 index files satisfy the frozen data contract', () => {
  const databaseRoot = path.join(projectRoot, 'database');
  const actualSchemas = fs.readdirSync(databaseRoot)
    .filter((name) => name.endsWith('.schema.json'))
    .map((name) => name.replace('.schema.json', ''))
    .sort();
  assert.deepEqual(actualSchemas, [...COLLECTION_NAMES].sort());

  for (const collection of COLLECTION_NAMES) {
    const schema = json(`database/${collection}.schema.json`);
    const indexes = json(`database/${collection}.index.json`);
    assert.deepEqual(schema.permission, {
      read: false,
      create: false,
      update: false,
      delete: false,
      count: false
    });
    assert.equal(Array.isArray(indexes), true);
    for (const index of indexes) {
      assert.equal(typeof index.IndexName, 'string');
      assert.equal(typeof index.MgoKeySchema.MgoIsUnique, 'boolean');
      assert.equal(Object.hasOwn(index.MgoKeySchema, 'MgoIsSparse'), false);
      for (const key of index.MgoKeySchema.MgoIndexKeys) {
        assert.ok(['varchar', 'bool', 'int', 'long', 'float', 'double', 'point', 'array']
          .includes(key.Type));
      }
    }
    assert.doesNotMatch(JSON.stringify(indexes), /ttl|expireAfter/i);
  }

  const tasks = json('database/tokenm-tasks.schema.json');
  const taskIndexes = json('database/tokenm-tasks.index.json');
  const eventUnique = taskIndexes.find((entry) => entry.IndexName === 'desktop_event_unique');
  assert.deepEqual(eventUnique.MgoKeySchema.MgoIndexKeys, [
    { Name: 'desktopId', Direction: '1', Type: 'varchar' },
    { Name: 'eventId', Direction: '1', Type: 'varchar' }
  ]);
  assert.equal(eventUnique.MgoKeySchema.MgoIsUnique, true);
  assert.ok(tasks.properties.desktopId.maxLength <= 255);
  assert.ok(tasks.properties.eventId.maxLength <= 255);
  assert.equal(tasks.properties.project.maxLength, 80);
  assert.equal(tasks.properties.model.maxLength, 80);
  assert.equal(tasks.properties.summary.maxLength, 600);

  const pairingIndexes = json('database/tokenm-pairing-sessions.index.json');
  assert.equal(pairingIndexes.find((entry) => entry.IndexName === 'code_uniqueness')
    .MgoKeySchema.MgoIsUnique, true);
  assert.equal(pairingIndexes.find((entry) => entry.IndexName === 'owner_uniqueness')
    .MgoKeySchema.MgoIsUnique, true);
  assert.equal(pairingIndexes.find((entry) => entry.IndexName === 'active_code_lookup')
    .MgoKeySchema.MgoIsUnique, false);

  const mobile = json('database/tokenm-mobile-devices.schema.json');
  for (const field of [
    '_id',
    'ownerId',
    'platform',
    'deviceLabel',
    'pushRegistrationStatus',
    'notificationPermissionState',
    'appVersion',
    'lastSeenAtMs',
    'status',
    'createdAtMs',
    'updatedAtMs'
  ]) assert.ok(mobile.required.includes(field), `${field} must be required`);
  assert.equal(Object.hasOwn(mobile.properties, 'cid'), false);
  assert.equal(Object.hasOwn(mobile.properties, 'pushCid'), false);
  const mobileIndexes = json('database/tokenm-mobile-devices.index.json');
  assert.deepEqual(
    mobileIndexes.find((entry) => entry.IndexName === 'owner_status_push_permission')
      .MgoKeySchema.MgoIndexKeys.map((entry) => entry.Name),
    ['ownerId', 'status', 'pushRegistrationStatus', 'notificationPermissionState']
  );

  const rate = json('database/tokenm-rate-limits.schema.json');
  assert.ok(rate.properties.ownerId.maxLength <= 255);
  const rateIndexes = json('database/tokenm-rate-limits.index.json');
  assert.ok(rateIndexes.some((entry) => entry.IndexName === 'owner_id'));

  const users = json('database/tokenm-users.schema.json');
  assert.equal(core.CURRENT_PRIVACY_VERSION, 'tokenm-android-v1');
  assert.equal(core.PRIVACY_CONSENT_VERSION, core.CURRENT_PRIVACY_VERSION);
  assert.ok(users.required.includes('privacyConsentVersion'));
  assert.ok(users.required.includes('privacyConsentAtMs'));
  assert.equal(users.properties.privacyConsentVersion.defaultValue, null);
  assert.equal(users.properties.privacyConsentAtMs.defaultValue, null);

  for (const [collection, fields] of Object.entries({
    'tokenm-users': ['createdAtMs', 'updatedAtMs'],
    'tokenm-desktops': ['createdAtMs', 'updatedAtMs'],
    'tokenm-pairing-sessions': ['createdAtMs', 'expiresAtMs'],
    'tokenm-tasks': ['createdAtMs', 'updatedAtMs'],
    'tokenm-mobile-devices': ['lastSeenAtMs', 'createdAtMs', 'updatedAtMs'],
    'tokenm-rate-limits': ['bucket', 'createdAtMs', 'updatedAtMs', 'expiresAtMs']
  })) {
    const schema = json(`database/${collection}.schema.json`);
    for (const field of fields) assert.equal(schema.properties[field].bsonType, 'long');
  }
  assert.equal(Object.hasOwn(tasks.properties, 'deliveryId'), false);
  assert.equal(fs.existsSync(path.join(databaseRoot, 'tokenm-push-deliveries.schema.json')), false);
  assert.equal(fs.existsSync(path.join(databaseRoot, 'tokenm-security-events.schema.json')), false);
});

test('custom account cleanup documentation requires completion before official identity closure', () => {
  const integration = read('cloudfunctions/tokenm-co/INTEGRATION.md');
  const databaseNotes = read('database/README.md');
  assert.match(integration, /cleanupPending.*false/s);
  assert.match(integration, /uniIdCo\.closeAccount\(\)/);
  assert.match(databaseNotes, /only Potato custom data/i);
  assert.match(databaseNotes, /explicitly bump the version/i);
});

test('Token M custom JavaScript uses only the permitted random and AES-GCM crypto primitives', () => {
  const files = sourceFiles(projectRoot);
  const combined = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(combined, /createHash|createHmac|pbkdf2|scrypt|credentialHash|payloadDigest|pairingCodeDigest/);
  const credential = read('cloudfunctions/common/tokenm-core/credential.js');
  const ids = read('cloudfunctions/common/tokenm-core/ids.js');
  assert.match(credential, /createCipheriv\('aes-256-gcm'/);
  assert.match(credential, /createDecipheriv\('aes-256-gcm'/);
  assert.match(credential, /timingSafeEqual/);
  assert.match(credential, /randomBytes/);
  assert.match(credential, /TOKEN_M_DESKTOP_CREDENTIAL_KEY/);
  assert.match(ids, /randomUUID/);
  assert.match(ids, /randomInt/);
});

test('real uniCloud repository is present but marks live支付宝 behavior as development-space-only', () => {
  assert.equal(core.DEVELOPMENT_SPACE_VALIDATION.verifiedLocally, false);
  assert.ok(core.DEVELOPMENT_SPACE_VALIDATION.requiresIsolatedDevelopmentSpace.length >= 4);
  const repositorySource = read('cloudfunctions/common/tokenm-core/repository-unicloud.js');
  assert.match(repositorySource, /startTransaction\(\)/);
  assert.match(repositorySource, /transaction\.commit\(\)/);
  assert.match(repositorySource, /transaction\.rollback\(\)/);
  assert.match(repositorySource, /doc\(id\)\.remove\(\)/);
});
