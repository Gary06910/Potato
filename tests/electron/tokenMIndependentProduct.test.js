'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const packageJson = require('../../package.json');

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('Potato retains its independent identity, updater ownership, and package boundary', () => {
  const main = read('src/electron/main.js');
  const updater = read('src/shared/appUpdater.js');
  const releaseWorkflow = read('.github/workflows/release.yml');

  assert.deepEqual(packageJson.build.publish, [{ provider: 'github', owner: 'Gary06910', repo: 'Potato' }]);
  assert.equal(packageJson.productName, 'Potato');
  assert.equal(packageJson.build.productName, 'Potato');
  assert.equal(packageJson.build.appId, 'com.javis.tokenmonitor');
  assert.equal(packageJson.build.releaseInfo.releaseNotesFile, '.github/TOKEN_M_RELEASE_TEMPLATE.md');

  assert.match(updater, /const GITHUB_REPO = 'Gary06910\/Potato'/);
  assert.doesNotMatch(updater, /Javis603\/token-monitor/);
  assert.match(main, /const APP_NAME = 'Potato'/);
  assert.match(main, /const LEGACY_USER_DATA_PATH = path\.join\(app\.getPath\('appData'\), 'Token Monitor'\)/);
  assert.match(main, /app\.setPath\('userData', LEGACY_USER_DATA_PATH\)/);
  assert.match(main, /app\.setAppUserModelId\('com\.javis\.tokenmonitor'\)/);

  for (const file of [
    'androidClient',
    'androidNotificationRuntime',
    'androidOutbox',
    'androidPayload',
    'codexHookBridge',
    'codexHookForwarder',
    'codexStopHook'
  ]) {
    assert.equal(fs.existsSync(path.join(PROJECT_ROOT, 'src/electron', `${file}.js`)), true, file);
  }

  assert.doesNotMatch(read('src/electron/tokenMNotificationRuntime.js'), /wechat/i);
  assert.match(releaseWorkflow, /TOKEN_M_RELEASE_TEMPLATE\.md/);
  assert.ok(packageJson.build.files.includes('LICENSE'));
  for (const excluded of [
    '!**/credentials.json',
    '!**/settings.json',
    '!**/.env',
    '!**/.env.*',
    '!**/*.log',
    '!**/*outbox*.json',
    '!**/token-m-notification-runtime.json'
  ]) assert.ok(packageJson.build.files.includes(excluded), excluded);
});
