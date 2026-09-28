'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../apps/tokenm-android');
const core = require(path.join(
  projectRoot,
  'uniCloud-alipay/cloudfunctions/common/tokenm-core'
));

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function occurrenceCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function assertExports(source, names) {
  for (const name of names) {
    assert.match(source, new RegExp(`export\\s+(?:const|function|class)\\s+${name}\\b`), `${name} must be exported`);
  }
}

test('client runtime exposes one narrow auth, consent, push, routing, and logout seam', () => {
  const runtime = read('services/client-runtime.uts');
  assertExports(runtime, [
    'bootstrapClientRuntime',
    'getRuntimeFacts',
    'loginWithUsername',
    'registerWithUsername',
    'acceptCurrentPrivacyConsent',
    'requestNotificationPermissionFromCta',
    'refreshMobileRegistration',
    'logoutClient',
    'flushPendingNotificationRoute'
  ]);
  for (const moduleName of [
    'auth-service.uts',
    'privacy-consent.uts',
    'push-runtime.uts',
    'mobile-device.uts'
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, 'services', moduleName)), true, `${moduleName} is missing`);
  }
});

test('push initialization is gated by both authenticated user and current privacy consent', () => {
  const runtime = read('services/client-runtime.uts');
  const push = read('services/push-runtime.uts');
  const app = read('App.uvue');

  assert.match(runtime, /(?:authenticated|signedIn|hasSession|userId)/);
  assert.match(runtime, /(?:privacyConsent|consentAccepted|hasCurrentConsent)/);
  assert.match(runtime, /(?:authenticated|signedIn|hasSession|userId)[\s\S]{0,500}(?:privacyConsent|consentAccepted|hasCurrentConsent)[\s\S]{0,500}startPushRuntime\s*\(/);
  assert.match(runtime, /let\s+bootstrapInFlight\s*:\s*Promise<RuntimeFacts>\s*\|\s*null\s*=\s*null/);
  assert.match(runtime, /bootstrapClientRuntime[\s\S]{0,200}if\s*\(bootstrapInFlight\s*!=\s*null\)\s*return\s+bootstrapInFlight/);
  assert.doesNotMatch(app, /getPushClientId|onPushMessage|setPushCid|requestNotificationPermission/);
  assert.equal(occurrenceCount(push, /\bgetPushClientId\s*\(/g) <= 1, true);
});

test('Android notification permission can only be requested from the explicit CTA path', () => {
  const runtime = read('services/client-runtime.uts');
  const permissionPage = read('pages/permission/index.uvue');
  const notificationsPage = read('pages/notifications/index.uvue');
  const app = read('App.uvue');

  assert.match(runtime, /export\s+(?:const|function)\s+requestNotificationPermissionFromCta\b/);
  assert.match(permissionPage, /@click=/);
  assert.match(permissionPage, /requestNotificationPermissionFromCta/);
  assert.match(notificationsPage, /@click=/);
  assert.match(notificationsPage, /requestNotificationPermissionFromCta/);
  assert.doesNotMatch(app, /requestNotificationPermissionFromCta|getPushClientId|POST_NOTIFICATIONS/);
});

test('Android manifest declares notifications but disables framework auto-request', () => {
  const manifest = read('AndroidManifest.xml');
  assert.match(manifest, /package="\$\{applicationId\}"/);
  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(manifest, /android:name="dcloud_push_auto_request_permission"[\s\S]{0,160}android:value="false"/);
});

test('push runtime owns exactly one listener and tears the same listener down', () => {
  const push = read('services/push-runtime.uts');
  assertExports(push, ['startPushRuntime', 'stopPushRuntime']);
  assert.equal(occurrenceCount(push, /\bonPushMessage\s*\(/g), 1);
  assert.equal(occurrenceCount(push, /\boffPushMessage\s*\(/g), 1);
  assert.match(push, /(?:started|listening|listenerRegistered)/);
  assert.match(push, /(?:started|listening|listenerRegistered)\s*=\s*false/);
});

test('push runtime creates the stable task channel inside the consent-gated start path', () => {
  const push = read('services/push-runtime.uts');
  assertExports(push, ['ensureTaskNotificationChannel']);
  assert.match(push, /TASK_NOTIFICATION_CHANNEL_ID\s*=\s*['"]DcloudChannelID['"]/);
  assert.match(push, /setPushChannel\s*\(\s*\{[\s\S]{0,500}importance\s*:\s*3[\s\S]{0,300}lockscreenVisibility\s*:\s*1/);
  assert.match(push, /startPushRuntime[\s\S]{0,500}ensureTaskNotificationChannel\s*\(\)[\s\S]{0,300}onPushMessage\s*\(/);
});

test('Getui notification icons bind once after Android push SDK initialization without changing delivery', () => {
  const push = read('services/push-runtime.uts');
  const manifest = JSON.parse(read('manifest.json'));
  const delivery = read('uniCloud-alipay/cloudfunctions/common/tokenm-core/push-notification.js');
  const androidImport = push.match(/\/\/ #ifdef APP-ANDROID\s+import PushManager from 'com\.igexin\.sdk\.PushManager'\s+\/\/ #endif/);
  const binding = push.match(/const bindGetuiNotificationIcons = \(\) => \{([\s\S]*?)\n\}/);
  const cidSuccess = push.match(/success: \(result: GetPushClientIdSuccess\) => \{([\s\S]*?)\n {4}\}/);

  assert.ok(androidImport, 'the Getui import must be Android-only');
  assert.ok(binding, 'the icon binding must be inside one helper');
  assert.match(binding[1], /\/\/ #ifdef APP-ANDROID[\s\S]*attemptGetuiNotificationIconBinding\('auto'\)[\s\S]*\/\/ #endif/);
  assert.match(binding[1], /notificationIconBindingAttempted[\s\S]*notificationIconBindingAttempted = true/);
  assert.match(push, /PushManager\.getInstance\(\)\.setNotificationIcon\(context, 'push_small', 'push'\)/);
  assert.equal(occurrenceCount(push, /\.setNotificationIcon\s*\(/g), 1);
  assert.ok(cidSuccess, 'CID success is the SDK initialization completion point');
  assert.match(cidSuccess[1], /bindGetuiNotificationIcons\(\)[\s\S]*resolve\(result\.cid\)/);
  assert.match(push, /startPushRuntime[\s\S]*notificationIconBindingAttempted = false[\s\S]*uni\.onPushMessage/);
  assert.doesNotMatch(push.slice(push.indexOf('const pushMessageListener'), push.indexOf('export const wasPushActivatedByUser')), /bindGetuiNotificationIcons|setNotificationIcon/);

  assert.equal(manifest.appid, '__UNI__46C9063');
  assert.equal(manifest['app-android'].distribute.icons.hdpi, 'package/icons/potato-hdpi.png');
  assert.match(push, /TASK_NOTIFICATION_CHANNEL_ID = 'DcloudChannelID'/);
  assert.match(delivery, /force_notification: true/);
  assert.match(delivery, /payload: \{ taskId: safeTaskId \}/);
});

test('mobile registration binds official setPushCid before writing the business device record', () => {
  const runtime = read('services/client-runtime.uts');
  const mobile = read('services/mobile-device.uts');
  const backend = read('uniCloud-alipay/cloudfunctions/common/tokenm-core/application.js');
  assert.match(runtime, /facts\.login\s*!=\s*['"]signedIn['"][\s\S]{0,200}facts\.privacyConsent\s*!=\s*['"]current['"]/);
  assert.match(mobile, /setPushCid\s*\([\s\S]{0,500}tokenmCo\.registerMobileDevice\s*\(\s*\{[\s\S]{0,200}enabled\s*:\s*true[\s\S]{0,200}pushRegistrationStatus\s*:\s*['"]ready['"]/);
  assert.match(mobile, /writeBusinessDevice[\s\S]{0,800}tokenmCo\.registerMobileDevice\s*\(/);
  assert.match(mobile, /disableCurrentMobileDevice[\s\S]{0,500}writeBusinessDevice\s*\(\s*false/);
  assert.match(backend, /status\s*=\s*input\.enabled\s*===\s*false\s*\?\s*['"]disabled['"]\s*:\s*['"]active['"][\s\S]{0,200}status\s*===\s*['"]active['"]\s*&&\s*!hasCurrentPrivacyConsent\s*\(/);
  assert.doesNotMatch(mobile, /ownerId\s*:|userId\s*:|openid\s*:/i);
});

test('every active business device state requires current consent while logout teardown remains allowed', async () => {
  const application = new core.TokenMApplication({
    repository: new core.MemoryRepository(),
    credentialKey: randomBytes(32),
    now: () => Date.parse('2026-08-23T12:00:00.000Z'),
    provider: { async submit() { return { status: 'submitted' }; } }
  });
  const ownerId = 'uid-client-consent-boundary';
  await application.bootstrap(ownerId);
  const clientIdentity = {
    deviceId: 'client-consent-device',
    platform: 'app',
    appVersion: '1.0.0'
  };

  for (const pushRegistrationStatus of ['notStarted', 'ready', 'error']) {
    await assert.rejects(application.registerMobileDevice(ownerId, {
      enabled: true,
      deviceLabel: 'Android',
      notificationPermissionState: 'authorized',
      pushRegistrationStatus
    }, clientIdentity), (error) => error.code === 'privacy_consent_required');
  }

  const teardown = await application.registerMobileDevice(ownerId, {
    enabled: false,
    deviceLabel: 'Android',
    notificationPermissionState: 'denied',
    pushRegistrationStatus: 'notStarted'
  }, clientIdentity);
  assert.equal(teardown.device.status, 'disabled');
});

test('notification presentation distinguishes permission, registration, recovery, and ready states truthfully', () => {
  const runtime = read('services/client-runtime.uts');
  const presentation = read('services/presentation.uts');
  const models = read('types/models.uts');
  const combined = `${runtime}\n${presentation}\n${models}`;

  for (const state of ['permission_required', 'registration_required', 'registration_error', 'ready']) {
    assert.match(combined, new RegExp(`['"]${state}['"]`), `${state} presentation state is missing`);
  }
  assert.doesNotMatch(presentation, /已送达|一定收到|保证送达/);
});

test('push click routing accepts only an opaque taskId and otherwise falls back safely', () => {
  const push = read('services/push-runtime.uts');
  const runtime = read('services/client-runtime.uts');
  const combined = `${push}\n${runtime}`;

  assert.match(combined, /taskId/);
  assert.match(combined, /\/pages\/task-detail\/index\?taskId=/);
  assert.match(combined, /encodeURIComponent\s*\(/);
  assert.match(combined, /\/pages\/(?:tasks|dashboard)\/index/);
  assert.doesNotMatch(push, /getString\s*\(\s*['"]type['"]\s*\)/);
  assert.doesNotMatch(combined, /payload\.(?:url|path|route)|data\.(?:url|path|route)/);
  assert.doesNotMatch(combined, /prompt|conversation|sourceCode|lastAssistantResponse|credential|secret/);
});

test('logout stops push and clears client state through the official uni-id-co boundary', () => {
  const runtime = read('services/client-runtime.uts');
  const auth = read('services/auth-service.uts');
  assert.match(runtime, /logoutClient[\s\S]{0,1200}stopPushRuntime\s*\(/);
  assert.match(runtime, /logoutClient[\s\S]{0,1600}(?:logoutWithUniId|logoutOfficial|logout)\s*\(/);
  assert.match(auth, /uniCloud\.importObject\s*\(\s*['"]uni-id-co['"]/);
  assert.match(auth, /\.login\s*\(\s*\{[\s\S]{0,300}username[\s\S]{0,300}password/);
  assert.match(auth, /\.registerUser\s*\(\s*\{[\s\S]{0,300}username[\s\S]{0,300}password/);
  assert.doesNotMatch(auth, /loginBySms|loginByWechat|loginByApple|loginByGoogle|mobileConfirm|emailConfirm/);
  assert.doesNotMatch(auth, /createHash|createHmac|sha-?256|passwordHash/i);
});

test('account deletion finishes custom cleanup before official close and logout', () => {
  const account = read('services/account-service.uts');
  const auth = read('services/auth-service.uts');

  assert.match(account, /tokenmCo\.deleteAccount\s*\(\s*\{\s*confirmation\s*:\s*['"]DELETE['"]\s*\}\s*\)/);
  assert.match(account, /cleanupPending\s*===\s*true[\s\S]{0,500}closeAccountWithUniId\s*\(\s*\)/);
  assert.match(account, /closeAccountWithUniId\s*\(\s*\)[\s\S]{0,500}stopPushRuntime\s*\(\s*\)[\s\S]{0,500}logoutWithUniId\s*\(\s*\)/);
  assert.match(auth, /uniIdCo\.closeAccount\s*\(\s*\)/);
  assert.doesNotMatch(account, /uni-id-users|uni-id-device|opendb-verify-codes/);
});
