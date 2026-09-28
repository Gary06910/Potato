'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../apps/tokenm-android');
const inspector = fs.readFileSync(path.join(root, 'services/application-icon-inspector.uts'), 'utf8');
const page = fs.readFileSync(path.join(root, 'pages/notifications/index.uvue'), 'utf8');

test('application identity inspector resolves installed package and launcher metadata', () => {
  assert.match(inspector, /context\.getPackageName\(\)/);
  assert.match(inspector, /manager\.getApplicationInfo\(packageName, 0\)/);
  assert.match(inspector, /inspectResource\(resources, applicationInfo\.icon\)/);
  assert.match(inspector, /manager\.getApplicationIcon\(packageName\)/);
  assert.match(inspector, /getField\('roundIconRes'\)/);
  assert.match(inspector, /manager\.getLaunchIntentForPackage\(packageName\)/);
  assert.match(inspector, /manager\.getActivityInfo\(component, 0\)/);
  assert.match(inspector, /inspectResource\(resources, activityInfo\.icon\)/);
  assert.match(inspector, /activityInfo\.loadIcon\(manager\)/);
  assert.match(inspector, /getIdentifier\('push_small', 'drawable', packageName\)/);
  assert.doesNotMatch(inspector, /0x7f[0-9a-f]{6}/i);
});

test('diagnostic UI compares application, round, launcher, and notification previews', () => {
  assert.match(page, /读取应用与启动图标/);
  assert.match(page, /APPLICATION_ICON · ApplicationInfo\.icon/);
  assert.match(page, /ROUND_ICON · ApplicationInfo\.roundIconRes/);
  assert.match(page, /LAUNCHER_ACTIVITY_ICON · ActivityInfo\.icon/);
  assert.match(page, /NOTIFICATION_PUSH_SMALL/);
  assert.match(page, /applicationIconInspection\.applicationIcon\.previewDataUrl/);
  assert.match(page, /applicationIconInspection\.roundIcon\.previewDataUrl/);
  assert.match(page, /applicationIconInspection\.launcherActivityIcon\.previewDataUrl/);
  assert.match(page, /applicationIconInspection\.pushSmallIcon\.previewDataUrl/);
});

test('inspector reads package resources without notification data or delivery changes', () => {
  assert.doesNotMatch(inspector, /\b(?:cid|token|account|taskId|payload|notification|uniCloud)\b/i);
  assert.doesNotMatch(inspector, /setNotificationIcon|createNotificationChannel|deleteNotificationChannel|\.notify\(/);
});
