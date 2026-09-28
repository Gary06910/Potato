'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../apps/tokenm-android');
const inspector = fs.readFileSync(path.join(root, 'services/active-notification-icon-inspector.uts'), 'utf8');
const page = fs.readFileSync(path.join(root, 'pages/notifications/index.uvue'), 'utf8');

test('active inspector queries only this package and selects the latest posted notification', () => {
  assert.match(inspector, /manager\.getActiveNotifications\(\)/);
  assert.match(inspector, /posted\.getPackageName\(\) != packageName/);
  assert.match(inspector, /posted\.getPostTime\(\) > latestPostTime/);
  assert.match(inspector, /if \(latestIndex < 0\) return result/);
  assert.match(inspector, /state: 'NO_ACTIVE_NOTIFICATION'/);
  assert.match(inspector, /Build\.VERSION\.SDK_INT < 28/);
});

test('inspector reads bounded icon and channel metadata without notification contents or delivery calls', () => {
  assert.match(inspector, /notification\.getSmallIcon\(\)/);
  assert.match(inspector, /notification\.getLargeIcon\(\)/);
  assert.match(inspector, /notification\.getChannelId\(\)/);
  assert.match(inspector, /icon\.getType\(\)/);
  assert.match(inspector, /icon\.getResPackage\(\)/);
  assert.match(inspector, /icon\.getResId\(\)/);
  assert.doesNotMatch(inspector, /notification\.(?:extras|getExtras|getContent|content|title)\b|\b(?:taskId|desktopName|clientId|cid|userId|account|credential|token|payload|intent|uniCloud)\b/i);
  assert.doesNotMatch(inspector, /setNotificationIcon|registerMobileDevice|setPushCid|setPushChannel|createNotificationChannel|deleteNotificationChannel|\.notify\(/);
});

test('resource lookup and foreign-package resolution preserve package and ID on failure', () => {
  assert.match(inspector, /getIdentifier\('push_small', 'drawable', packageName\)/);
  assert.match(inspector, /context\.createPackageContext\(packageName, 0\)/);
  assert.match(inspector, /resources\.getResourceEntryName\(result\.resourceId\)/);
  assert.match(inspector, /resources\.getResourceTypeName\(result\.resourceId\)/);
  assert.match(inspector, /resources\.getResourcePackageName\(result\.resourceId\)/);
  assert.match(inspector, /resourceName: 'unresolved'/);
  assert.match(inspector, /result\.smallIcon\.resourcePackage == packageName &&\s+result\.smallIcon\.resourceId == result\.expectedPushSmallId \? 'YES' : 'NO'/);
  assert.doesNotMatch(inspector, /0x7f[0-9a-f]{6}/i);
});

test('notification settings expose manual read, comparison, and two local previews', () => {
  assert.match(page, /读取当前通知图标/);
  assert.match(page, /activeIconInspection\.value = inspectActiveNotificationIcons\(\)/);
  assert.match(page, /activeIconInspection\.state == 'NO_ACTIVE_NOTIFICATION'/);
  assert.match(page, /activeIconInspection\.matchPushSmall/);
  assert.match(page, /activeIconInspection\.expectedPreviewDataUrl/);
  assert.match(page, /activeIconInspection\.smallIcon\.previewDataUrl/);
  assert.match(inspector, /resources\.getDrawable\(resourceId, null\)/);
});
