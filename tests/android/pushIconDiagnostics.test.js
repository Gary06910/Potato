'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../apps/tokenm-android');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('icon diagnostics expose only bounded, nonsensitive fields and dynamic SDK/resource metadata', () => {
  const push = read('services/push-runtime.uts');
  const model = push.match(/export type PushIconDiagnostics = \{([^}]+)\}/)?.[1];
  assert.ok(model);
  assert.deepEqual([...model.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]), [
    'sdkVersion', 'packageName', 'pushSmallResourceId', 'pushResourceId',
    'autoBindingState', 'lastBindingResult', 'lastBindingSource', 'lastBindingErrorCategory'
  ]);
  assert.doesNotMatch(model, /cid|token|user|account|credential|task|desktop|secret|payload/i);
  assert.match(push, /resources\.getIdentifier\('push_small', 'drawable', packageName\)/);
  assert.match(push, /resources\.getIdentifier\('push', 'drawable', packageName\)/);
  assert.match(push, /PushManager\.getInstance\(\)\.getVersion\(context\)/);
  assert.doesNotMatch(push, /0x7f[0-9a-f]{6}/i);
  assert.match(push, /lastBindingErrorCategory = 'exception'/);
  assert.doesNotMatch(push, /lastBindingErrorCategory\s*=\s*[^\n]*\.message/);
});

test('auto result and manual rebind use one icon-only binding path', () => {
  const push = read('services/push-runtime.uts');
  const binding = push.slice(push.indexOf('const attemptGetuiNotificationIconBinding'), push.indexOf('export const isAllowedTaskId'));
  const manual = push.match(/export const rebindGetuiNotificationIconsForDiagnostics = [\s\S]*?attemptGetuiNotificationIconBinding\('manual'\)/)?.[0];
  assert.ok(manual);
  assert.match(binding, /setNotificationIcon\(context, 'push_small', 'push'\) \? 'success' : 'false'/);
  assert.match(binding, /if \(source == 'auto'\) iconDiagnostics\.autoBindingState = iconDiagnostics\.lastBindingResult/);
  assert.match(binding, /lastBindingResult = 'exception'/);
  assert.doesNotMatch(binding, /getPushClientId|registerMobileDevice|setPushCid|setPushChannel|onPushMessage|uniCloud|createPushMessage/);
  assert.match(push, /success: \(result: GetPushClientIdSuccess\) => \{[\s\S]*?bindGetuiNotificationIcons\(\)[\s\S]*?resolve\(result\.cid\)/);
});

test('notification page reports missing resources and refreshes diagnostics after manual binding', () => {
  const page = read('pages/notifications/index.uvue');
  assert.match(page, /通知图标诊断/);
  assert.match(page, /id > 0 \? `found \(\$\{id\}\)` : 'missing'/);
  assert.match(page, /iconDiagnostics\.value = rebindGetuiNotificationIconsForDiagnostics\(\)/);
  assert.doesNotMatch(page, /cid|token|credential|pairing|desktop|payload/i);
});

test('diagnostic build only bumps version code and retains delivery contract', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const push = read('services/push-runtime.uts');
  const delivery = read('uniCloud-alipay/cloudfunctions/common/tokenm-core/push-notification.js');
  assert.equal(manifest.versionName, '0.1.1');
  assert.equal(manifest.versionCode, 4);
  assert.equal(manifest.appid, '__UNI__46C9063');
  assert.match(push, /TASK_NOTIFICATION_CHANNEL_ID = 'DcloudChannelID'/);
  assert.match(delivery, /force_notification: true/);
});
