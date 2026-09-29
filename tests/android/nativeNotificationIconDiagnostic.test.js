'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, 'apps/tokenm-android', f), 'utf8');
const helper = read('services/native-notification-icon-diagnostic.uts');
const inspector = read('services/active-notification-icon-inspector.uts');
const page = read('pages/notifications/index.uvue');

test('native control has a resource small icon, fixed identity and no provider/payload/large icon', () => {
  assert.match(helper, /import NotificationManager from 'android.app.NotificationManager'/);
  assert.match(helper, /context.getPackageName\(\)/);
  assert.match(helper, /resources.getIdentifier\('push_small', 'drawable', packageName\)/);
  assert.match(helper, /builder.setSmallIcon\(pushSmallId\)/);
  assert.match(helper, /CHANNEL_ID = 'DcloudChannelID'/);
  assert.match(helper, /NATIVE_ICON_DIAGNOSTIC_TAG = 'potato-native-icon-diagnostic'/);
  assert.match(helper, /NATIVE_ICON_DIAGNOSTIC_ID = 91001/);
  assert.match(helper, /manager.notify\(NATIVE_ICON_DIAGNOSTIC_TAG, NATIVE_ICON_DIAGNOSTIC_ID.toInt\(\), builder.build\(\)\)/);
  assert.doesNotMatch(helper, /createPushMessage|PushManager|com.igexin|setLargeIcon|setOngoing|setFullScreenIntent|setNotificationIcon|0x7f|\b(?:payload|taskId|cid|uniCloud|extras)\b/i);
});

// Exercise the control flow against a native boundary mock; this does not compile UTS.
function runControl(api, resourceId, channelExists = true, enabled = true, throws = false) {
  const calls = [];
  let channel = channelExists;
  const manager = {
    areNotificationsEnabled: () => enabled,
    getNotificationChannel: () => channel ? {} : null,
    notify: (...args) => { if (throws) throw Error('blocked'); calls.push(['notify', ...args]); }
  };
  class Builder {
    constructor(...args) { calls.push(['builder', args.length, args[1]]); }
    setSmallIcon(id) { calls.push(['small', id]); }
    setContentTitle(value) { calls.push(['title', value]); }
    setContentText(value) { calls.push(['text', value]); }
    setAutoCancel(value) { calls.push(['auto', value]); }
    setOnlyAlertOnce(value) { calls.push(['once', value]); }
    build() { return {}; }
  }
  const context = {
    getPackageName: () => 'com.gary.tokenm',
    getResources: () => ({ getIdentifier: (...args) => { calls.push(['lookup', ...args]); return resourceId; } }),
    getSystemService: () => manager
  };
  const code = helper.replace(/^import .*$/gm, '').replace(/export type NativeNotificationIconDiagnostic = \{[\s\S]*?\}/, '')
    .replace(/export const /g, 'const ').replace(/\(\): NativeNotificationIconDiagnostic/g, '()')
    .replace(/: NativeNotificationIconDiagnostic =/g, ' =').replace(/ as NotificationManager \| null/g, '')
    .replace(/NATIVE_ICON_DIAGNOSTIC_ID.toInt\(\)/g, 'NATIVE_ICON_DIAGNOSTIC_ID');
  const result = vm.runInNewContext(code + '\nsendNativeNotificationIconDiagnostic()', {
    UTSAndroid: { getAppContext: () => context }, Build: { VERSION: { SDK_INT: api } },
    Context: { NOTIFICATION_SERVICE: 'notification' }, Notification: { Builder },
    ensureTaskNotificationChannel: () => { calls.push(['ensure']); channel = true; }
  });
  return { result, calls };
}

test('native control submits only after lookup and uses the appropriate Builder contract', () => {
  for (const api of [21, 25, 26, 35]) {
    const { result, calls } = runControl(api, 12345);
    assert.equal(result.state, 'NOTIFY_SUBMITTED');
    assert.deepEqual(calls.find(c => c[0] === 'lookup'), ['lookup', 'push_small', 'drawable', 'com.gary.tokenm']);
    assert.deepEqual(calls.find(c => c[0] === 'small'), ['small', 12345]);
    assert.deepEqual(calls.find(c => c[0] === 'builder'), ['builder', api >= 26 ? 2 : 1, api >= 26 ? 'DcloudChannelID' : undefined]);
    assert.equal(calls.find(c => c[0] === 'notify')[1], 'potato-native-icon-diagnostic');
    assert.equal(calls.find(c => c[0] === 'notify')[2], 91001);
    assert.equal(calls.find(c => c[0] === 'title')[1], 'Potato 图标测试');
    assert.equal(calls.find(c => c[0] === 'text')[1], '本地 Android 原生通知');
    assert.equal(calls.some(c => c[0] === 'ensure'), false);
  }
});

test('missing resource and disabled permission do not submit; missing channel uses only existing creator', () => {
  for (const resourceId of [0, -1]) {
    const { result, calls } = runControl(35, resourceId);
    assert.equal(result.state, 'PUSH_SMALL_MISSING');
    assert.equal(calls.some(c => c[0] === 'notify' || c[0] === 'builder' || c[0] === 'ensure'), false);
  }
  assert.equal(runControl(35, 123, true, false).result.state, 'NOTIFICATIONS_DISABLED');
  assert.equal(runControl(35, 123, true, true, true).result.state, 'NOTIFY_EXCEPTION');
  assert.equal(runControl(26, 123, false).calls.filter(c => c[0] === 'ensure').length, 1);
});

test('local inspector selects exact tag/id while business inspector excludes the control', () => {
  assert.match(inspector, /posted.getTag\(\) == NATIVE_ICON_DIAGNOSTIC_TAG && posted.getId\(\) == NATIVE_ICON_DIAGNOSTIC_ID/);
  assert.match(inspector, /if \(localDiagnostic != isDiagnostic\) continue/);
  assert.match(inspector, /inspectLocalNotificationIcons[^\n]*inspectNotificationIcons\(true\)/);
  assert.match(inspector, /inspectActiveNotificationIcons[^\n]*inspectNotificationIcons\(false\)/);
  assert.doesNotMatch(inspector, /\b(?:extras|payload|title|text|taskId|cid)\b/i);
  for (const field of ['channelId', 'type', 'resourcePackage', 'resourceId', 'resourceName', 'previewDataUrl', 'matchPushSmall']) assert.ok(inspector.includes(field));
  assert.match(page, /发送本地图标测试通知/);
  assert.match(page, /读取本地图标测试通知/);
  assert.match(page, /Local native notification/);
  assert.match(page, /UniPush notification/);
  assert.match(page, /localIconInspection.value = inspectLocalNotificationIcons\(\)/);
});

test('auxiliary logos are read from installed metadata and expose none or resource preview', () => {
  const app = read('services/application-icon-inspector.uts');
  assert.match(app, /inspectResource\(resources, applicationInfo.logo\)/);
  assert.match(app, /inspectResource\(resources, activityInfo.logo\)/);
  for (const field of ['applicationLogo', 'launcherActivityLogo']) {
    assert.ok(page.includes(field + '.previewDataUrl'));
    assert.ok(page.includes(field + '.resourceName'));
    assert.ok(page.includes(field + ".resourceId) : 'none'"));
  }
});

test('protected cloud and push delivery sources retain the pre-experiment bytes', () => {
  const expected = {
  "apps/tokenm-android/services/push-runtime.uts": "f1eaf3ce8848ff93a9b45b8671ea5294152dceefdad0b1588b401c8ca6407c4d",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/application.js": "2b4fb99fee7ddbe42b0de0382f6526c2080cba5240614c6de2ce13e663c53349",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/credential.js": "55a8fc6f506eb3d65b0a39de4bdc19d19017415584c428880913662c36558372",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/errors.js": "7cecd8a0b24498fb79fb6503a4141de4640e7cdc14324417d51a2ebba6896ef9",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/ids.js": "f96e8f03f6a5c5ff79d674d61e1c215bc94577db9614c3f59a00be487189a9cd",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/index.js": "fe1919b80f202d00a0b1ce688ce182139444e4f1d677f44ce32084b35d5e642e",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/package.json": "62c24a729f0c135988efefc3686788b4a4784d7f716798d1b2d69972b8ad8a1c",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/push-notification.js": "332fce22468404cc2d061ad5ff037400a49eee29e985d24cb2e025a220d7307e",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/repository-contract.js": "f351ca412f1690a4db647afe819ed23b210c281c618109b4b542f9dcd6c6f44d",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/repository-memory.js": "b87ed4cc6f50df075a06dd8182a3a62030759025039f0b8cbed123fe6f6cc082",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/repository-unicloud.js": "45b27c4d2633dff73e7ac8643569c62f72e5599dfaec1b5ac0b0fcec2cc0eb89",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/usage-service.js": "34e27d868f7b997b73cfd9b9248e47770b3c00012e40183a858fa3ba52302523",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/usage-snapshot.js": "5598a9d7f81de059dcd8e9fe209b64878e3b27a98bf22e1a1cf917f13d3d2df5",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/validation.js": "d0fb09ba549e843869eb09d954f3f88f0c4e2ec7503561a8b57e028d8282ebf3",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/tokenm-desktop-http/INTEGRATION.md": "077061ec6445863488dea813f2a3e63b16c89b10784182cd8888ec61805259b4",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/tokenm-desktop-http/http-contract.js": "0c2916361c1d821954b6c07d656d386d8a8a9d20e7909e8056e0e37f3d48d0b0",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/tokenm-desktop-http/index.js": "6326711ec79df2ba8edbeb6eb23f55fc1061bd8b360cf1e3bf68ebd036401f6f",
  "apps/tokenm-android/uniCloud-alipay/cloudfunctions/tokenm-desktop-http/package.json": "85f8cfc1549a1faecbaa208864969ca376f762f77046388eec37ebe541b5f40e"
};
  for (const [file, hash] of Object.entries(expected)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), hash, file);
  }
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.versionName, '0.1.1');
  assert.equal(manifest.versionCode, 4);
  assert.equal(manifest.appid, '__UNI__46C9063');
});
