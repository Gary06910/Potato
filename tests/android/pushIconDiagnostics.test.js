'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../../apps/tokenm-android');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('notification diagnostics are absent while production icon binding remains', () => {
  const page = read('pages/notifications/index.uvue');
  const push = read('services/push-runtime.uts');
  for (const term of ['通知图标诊断', '重新绑定通知图标', '读取当前通知图标', '读取应用与启动图标', 'icon-preview', 'APPLICATION_ICON', 'Expected push_small', 'Actual smallIcon']) {
    assert.doesNotMatch(page, new RegExp(term));
  }
  for (const file of ['active-notification-icon-inspector.uts', 'application-icon-inspector.uts']) {
    assert.equal(fs.existsSync(path.join(root, 'services', file)), false);
  }
  assert.match(push, /PushManager\.getInstance\(\)\.setNotificationIcon\(context, 'push_small', 'push'\)/);
  assert.match(push, /success: \(result: GetPushClientIdSuccess\) => \{[\s\S]*?bindGetuiNotificationIcons\(\)[\s\S]*?resolve\(result\.cid\)/);
  assert.doesNotMatch(push, /PushIconDiagnostics|iconDiagnostics|rebindGetuiNotificationIconsForDiagnostics|attemptGetuiNotificationIconBinding/);
});

test('Android package and notification delivery contracts remain stable', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const push = read('services/push-runtime.uts');
  const delivery = read('uniCloud-alipay/cloudfunctions/common/tokenm-core/push-notification.js');
  assert.equal(manifest.versionName, '0.1.1');
  assert.equal(manifest.versionCode, 6);
  assert.equal(manifest.appid, '__UNI__46C9063');
  assert.match(push, /TASK_NOTIFICATION_CHANNEL_ID = 'DcloudChannelID'/);
  assert.match(delivery, /force_notification: true/);
});
