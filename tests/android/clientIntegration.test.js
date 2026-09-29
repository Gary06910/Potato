'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../apps/tokenm-android');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('production client facade routes every business operation to tokenm-co', () => {
  const client = read('services/client.uts');
  const service = read('services/tokenm-service.uts');
  assert.match(client, /from ['"]\.\/tokenm-service\.uts['"]/);
  assert.doesNotMatch(client, /mock-service|fixtures/);
  assert.match(service, /uniCloud\.importObject\s*\(\s*['"]tokenm-co['"]/);
  assert.doesNotMatch(service, /mock-service|mock-data|fixtures/);

  for (const method of [
    'bootstrap',
    'getAndroidDashboard',
    'getSettings',
    'listTasks',
    'getTask',
    'listDesktops',
    'createPairingCode',
    'getPairingStatus',
    'renameDesktop',
    'unbindDesktop',
    'updateSettings'
  ]) {
    assert.match(service, new RegExp(`tokenmCo\\.${method}(?:<[^>]+>)?\\s*\\(`), `${method} is not wired`);
  }
});

test('real task adapter preserves server cursor filtering and privacy presentation', () => {
  const service = read('services/tokenm-service.uts');
  const models = read('types/models.uts');
  assert.match(models, /type TaskCursor\s*=\s*\{[\s\S]{0,160}createdAtMs:\s*number[\s\S]{0,160}taskId:\s*string/);
  assert.match(service, /input\.set\s*\(\s*['"]cursor['"]\s*,\s*cursor\s*\)/);
  assert.match(models, /'not_requested'/);
  assert.match(service, /filter\s*==\s*['"]not_requested['"][\s\S]{0,120}return \['not_requested'\]/);
  assert.match(service, /sanitizeTask\s*\(\s*\{/);
  assert.match(service, /nextCursor:\s*page\.nextCursor/);
});

test('desktop and notification adapters preserve current Android cloud fields', () => {
  const service = read('services/tokenm-service.uts');
  const desktops = read('pages/desktops/index.uvue');
  const notifications = read('pages/notifications/index.uvue');

  assert.match(service, /createdAt:\s*value\.createdAt/);
  assert.match(desktops, /formatDateTime\(item\.createdAt\)/);
  assert.match(desktops, /formatDateTime\(item\.lastSeenAt\)/);
  assert.match(notifications, /updateNotificationsEnabled\(event\.detail\.value\)/);
  assert.match(service, /tokenmCo\.updateSettings<CloudSettingsResult>/);
});

test('permission retry actions restore working state after service failure', () => {
  const permission = read('pages/permission/index.uvue');
  const notifications = read('pages/notifications/index.uvue');
  for (const source of [permission, notifications]) {
    const start = source.indexOf('const runRetryRegistration');
    const end = source.indexOf('\n}\n', start);
    assert.ok(start >= 0);
    assert.ok(end > start);
    const retry = source.slice(start, end);
    assert.match(retry, /try\s*\{/);
    assert.match(retry, /finally\s*\{[\s\S]*working\.value\s*=\s*false/);
  }
});

test('pairing page polls the owned server session instead of inferring from desktop-list changes', () => {
  const page = read('pages/pairing/index.uvue');
  assert.match(page, /getPairingStatus\s*\(\s*sessionId\.value\s*\)/);
  assert.match(page, /current\.status\s*==\s*['"]paired['"]/);
  assert.doesNotMatch(page, /initialDesktopIds|listDesktops\s*\(/);
});

test('task deep links return to the task list when the ID is invalid or no longer owned', () => {
  const page = read('pages/task-detail/index.uvue');
  assert.match(page, /task_not_found[\s\S]{0,300}任务不存在或已删除/);
  assert.match(page, /fallbackToTasks[\s\S]{0,300}\/pages\/tasks\/index/);
  assert.match(page, /\^tsk_\[0-9a-f\]/);
});

test('privacy data actions are available only to a current authenticated profile', () => {
  const page = read('pages/privacy/index.uvue');
  assert.match(page, /getCurrentAccountProfile\s*\(\)\.authenticated/);
  assert.match(page, /v-if=['"]!authenticated['"]/);
  assert.match(page, /v-else[\s\S]{0,500}confirmClear[\s\S]{0,500}confirmDelete/);
});

test('integrated data pages expose loading error empty and explicit refetch states', () => {
  const dashboard = read('pages/dashboard/index.uvue');
  const tasks = read('pages/tasks/index.uvue');
  const desktops = read('pages/desktops/index.uvue');
  const taskDetail = read('pages/task-detail/index.uvue');
  const pairing = read('pages/pairing/index.uvue');
  const notifications = read('pages/notifications/index.uvue');
  const settings = read('pages/settings/index.uvue');

  for (const source of [dashboard, tasks, desktops]) {
    assert.match(source, /state\s*==\s*['"]loading['"]/);
    assert.match(source, /state\s*==\s*['"]error['"]/);
    assert.match(source, /mode=['"]empty['"]/);
    assert.match(source, /refresherrefresh/);
  }
  for (const source of [taskDetail, pairing, notifications, settings]) {
    assert.match(source, /state\s*==\s*['"]loading['"]/);
    assert.match(source, /state\s*==\s*['"]error['"]/);
    assert.match(source, /action-text=['"]重试['"]/);
  }
});

test('no Android page or root lifecycle bypasses the client service for business cloud calls', () => {
  const roots = [read('App.uvue'), read('main.uts')];
  const pageRoot = path.join(projectRoot, 'pages');
  const pages = fs.readdirSync(pageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => read(`pages/${entry.name}/index.uvue`));
  assert.doesNotMatch([...roots, ...pages].join('\n'), /uniCloud\.(?:importObject|callFunction|database)\s*\(/);
});
