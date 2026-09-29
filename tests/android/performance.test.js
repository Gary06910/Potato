'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { environment, deferred } = require('./runtime-fixture');

test('page snapshots deduplicate cold reads, reuse fresh values and retain stale data on failure', async () => {
  const env = environment();
  const cache = env.load('services/page-cache.uts');
  const pending = deferred();
  let calls = 0;
  const loader = () => { calls++; return pending.promise; };
  const first = cache.desktopsSnapshot.read(false, loader);
  assert.equal(first, cache.desktopsSnapshot.read(false, loader));
  assert.equal(cache.desktopsSnapshot.peek(), null);
  pending.resolve([]);
  await first;
  assert.equal(calls, 1);
  await cache.desktopsSnapshot.read(false, loader);
  assert.equal(calls, 1);
  env.now += 60001;
  assert.deepEqual(cache.desktopsSnapshot.peek(), []);
  await assert.rejects(cache.desktopsSnapshot.read(false, async () => { throw new Error('offline'); }));
  assert.deepEqual(cache.desktopsSnapshot.peek(), []);
  assert.equal(cache.desktopsSnapshot.fresh(), false);
});

test('owner switch, token expiry and logout clear data and reject late responses', async () => {
  const env = environment();
  const cache = env.load('services/page-cache.uts');
  const pending = deferred();
  const old = cache.tasksSnapshot.read(false, () => pending.promise);
  env.uid = 'user-b';
  assert.equal(cache.tasksSnapshot.peek(), null);
  const fresh = { items: [], nextCursor: null };
  await cache.tasksSnapshot.read(false, async () => fresh);
  pending.resolve({ items: [env.task], nextCursor: null });
  await assert.rejects(old, /superseded/);
  assert.equal(cache.tasksSnapshot.peek(), fresh);
  env.expires = env.now;
  assert.equal(cache.tasksSnapshot.peek(), null);
  await assert.rejects(cache.tasksSnapshot.read(false, async () => fresh), /session_unavailable/);
  env.expires = env.now + 10000;
  await cache.tasksSnapshot.read(false, async () => fresh);
  await env.load('services/client-runtime.uts').logoutClient();
  assert.equal(cache.tasksSnapshot.peek(), null);
});

test('invalidation rejects an old read without cancelling or overwriting a newer one', async () => {
  const env = environment();
  const cache = env.load('services/page-cache.uts');
  const oldData = deferred();
  const newData = deferred();
  const old = cache.desktopsSnapshot.read(false, () => oldData.promise);
  cache.invalidateDesktopViews();
  const next = cache.desktopsSnapshot.read(false, () => newData.promise);
  oldData.resolve([env.desktop]);
  await assert.rejects(old, /superseded/);
  assert.equal(cache.desktopsSnapshot.inFlight, next);
  newData.resolve([]);
  await next;
  assert.deepEqual(cache.desktopsSnapshot.peek(), []);
});

test('Home uses one bounded bundle and supplies Settings without another dashboard request', async () => {
  const env = environment();
  const service = env.load('services/tokenm-service.uts');
  const pending = deferred();
  env.handlers.getAndroidDashboard = () => pending.promise;
  const result = service.getDashboard();
  assert.deepEqual(env.calls, ['getAndroidDashboard']);
  pending.resolve({ counts: { todayTasks: 1, activeDesktops: 1 }, settings: { notificationsEnabled: true }, recentTasks: [], recentDesktops: [] });
  await result;
  assert.equal((await service.getNotificationSettings()).notificationsEnabled, true);
  assert.equal(env.calls.filter((name) => name === 'getAndroidDashboard').length, 1);
});

test('short settled navigation cycle needs three business reads and one consent read, no Push registration', async () => {
  const env = environment();
  const service = env.load('services/tokenm-service.uts');
  const runtime = env.load('services/client-runtime.uts');
  const operations = [service.getDashboard, () => service.listTasks(null, 'all', 'all', 'all', 20), service.listDesktops, service.getNotificationSettings, () => service.listTasks(null, 'all', 'all', 'all', 20)];
  for (const operation of operations) {
    await runtime.prepareClientPage();
    await operation();
  }
  // Home has one bundle; Tasks adds task and desktop reads. Settings reuses Home.
  assert.equal(env.calls.length, 4);
  assert.equal(env.calls.filter((name) => name === 'getPrivacyConsent').length, 1);
  assert.equal(env.calls.filter((name) => name === 'listDesktops').length, 1);
  assert.equal(env.calls.filter((name) => name === 'listTasks').length, 1);
  assert.equal(env.pushRegistrations, 0);
});

test('desktop mutations, pairing, settings update and task clear invalidate only affected views', async () => {
  const env = environment();
  const service = env.load('services/tokenm-service.uts');
  const cache = env.load('services/page-cache.uts');
  await service.getDashboard();
  await service.listTasks(null, 'all', 'all', 'all', 20);
  await service.renameDesktop('desk-1', 'Renamed');
  assert.equal(cache.desktopsSnapshot.peek(), null);
  assert.equal(cache.tasksSnapshot.peek(), null);
  assert.equal(cache.dashboardSnapshot.peek(), null);
  assert.equal(cache.settingsSnapshot.peek(), true);
  await service.listDesktops();
  await service.unbindDesktop('desk-1');
  assert.equal(cache.desktopsSnapshot.peek(), null);
  await service.listDesktops();
  await service.getPairingStatus('pair-1');
  assert.equal(cache.desktopsSnapshot.peek(), null);
  await service.getDashboard();
  await service.updateNotificationsEnabled(false);
  assert.equal(cache.settingsSnapshot.peek(), false);
  assert.equal(cache.dashboardSnapshot.peek(), null);
  assert.equal(cache.desktopsSnapshot.peek(), null);
  await service.listTasks(null, 'all', 'all', 'all', 20);
  await env.load('services/account-service.uts').clearCloudTaskHistory();
  assert.equal(cache.tasksSnapshot.peek().items.length, 0);
  assert.notEqual(cache.desktopsSnapshot.peek(), null);
});

test('warm page setup exposes cached content before consent resolves; offline refresh retains it', async () => {
  const env = environment();
  const runtime = env.load('services/client-runtime.uts');
  await runtime.prepareClientPage();
  await env.load('services/tokenm-service.uts').getDashboard();
  env.now += 30000;
  const pending = deferred();
  env.handlers.getPrivacyConsent = () => pending.promise;
  const page = env.page('dashboard', ['state', 'dashboard', 'runLoad', 'banner']);
  assert.equal(page.state.value, 'ready');
  assert.equal(page.dashboard.value.recentTasks[0].summary, 'Finished');
  const refresh = page.runLoad(true);
  assert.equal(page.state.value, 'ready');
  pending.reject({ errCode: 'NETWORK_ERROR', errMsg: 'offline' });
  await refresh;
  assert.equal(page.state.value, 'ready');
  assert.match(page.banner.value, /更新失败/);
});

test('cold page fails explicitly and empty cached desktop page survives failed refresh', async () => {
  const env = environment();
  env.handlers.getPrivacyConsent = async () => { throw { errCode: 'NETWORK_ERROR', errMsg: 'offline' }; };
  const cold = env.page('desktops', ['state', 'runLoad', 'errorMessage']);
  await cold.runLoad(false);
  assert.equal(cold.state.value, 'error');
  assert.ok(cold.errorMessage.value.length > 0);
  delete env.handlers.getPrivacyConsent;
  await env.load('services/client-runtime.uts').prepareClientPage();
  env.handlers.listDesktops = async () => ({ desktops: [] });
  await env.load('services/tokenm-service.uts').listDesktops();
  const warm = env.page('desktops', ['state', 'active', 'runLoad', 'banner']);
  assert.equal(warm.state.value, 'ready');
  assert.equal(warm.active.value.length, 0);
  env.now += 60001;
  env.handlers.listDesktops = async () => { throw { errCode: 'NETWORK_ERROR', errMsg: 'offline' }; };
  await warm.runLoad(true);
  assert.equal(warm.state.value, 'ready');
  assert.match(warm.banner.value, /上次数据/);
});

test('Tasks refreshes onShow and ignores an old filter response and stale pagination', async () => {
  const env = environment();
  await env.load('services/client-runtime.uts').prepareClientPage();
  const page = env.page('tasks', ['state', 'items', 'filter', 'runLoadFirst', 'runLoadMore', 'nextCursor']);
  assert.equal(typeof env.hooks.onShow, 'function');
  assert.equal(env.hooks.onLoad, undefined);
  const pending = deferred();
  env.handlers.listTasks = (input) => input.privacyMode === true ? pending.promise : { tasks: [], nextCursor: null };
  page.filter.value = 'privacy';
  const old = page.runLoadFirst(false);
  await new Promise((resolve) => setImmediate(resolve));
  page.filter.value = 'full';
  await page.runLoadFirst(false);
  pending.resolve({ tasks: [env.task], nextCursor: null });
  await old;
  assert.equal(page.items.value.length, 0);
  assert.equal(page.state.value, 'ready');
});

test('consent revocation removes cached views and route redirects; local expiry never sends a read', async () => {
  const env = environment();
  const runtime = env.load('services/client-runtime.uts');
  const cache = env.load('services/page-cache.uts');
  await runtime.prepareClientPage();
  await env.load('services/tokenm-service.uts').getDashboard();
  env.now += 30000;
  env.handlers.getPrivacyConsent = async () => ({ privacyConsent: env.consent(false) });
  assert.equal(await runtime.ensureProtectedClientRoute(), false);
  assert.equal(cache.dashboardSnapshot.peek(), null);
  assert.ok(env.routes.includes('/pages/permission/index'));
  assert.equal(runtime.canReuseProtectedPageData(), false);
  env.expires = env.now;
  const calls = env.calls.length;
  assert.equal(await runtime.ensureProtectedClientRoute(), false);
  assert.equal(env.calls.length, calls);
  assert.ok(env.routes.includes('/pages/login/index'));
});

test('navigation metrics record T0/onReady/content proxies once and ignore superseded pages', () => {
  const env = environment();
  const perf = env.load('services/navigation-perf.uts');
  perf.navigateColumn('/pages/tasks/index');
  const timing = new perf.PageTiming('/pages/tasks/index');
  timing.cachedReady();
  assert.equal(env.logs.length, 0);
  env.now += 10;
  timing.shellReady();
  timing.cachedReady();
  assert.equal(env.logs.length, 2);
  assert.equal(env.logs[0][2], 'NAVIGATION_TO_SHELL_MS');
  assert.equal(env.logs[1][2], 'NAVIGATION_TO_CACHED_CONTENT_MS');
  env.now += 50;
  timing.freshReady();
  assert.equal(env.logs[2][3], 60);
  perf.navigateColumn('/pages/settings/index');
  timing.record('ignored');
  assert.equal(env.logs.length, 3);
});

test('retained Tasks instance clears previous account filters and items before another account renders', async () => {
  const env = environment();
  await env.load('services/client-runtime.uts').prepareClientPage();
  const page = env.page('tasks', ['state', 'items', 'filter', 'desktopOptions', 'runLoadFirst', 'restoreCached']);
  page.filter.value = 'full';
  await page.runLoadFirst(false);
  assert.equal(page.items.value.length, 1);
  assert.equal(page.desktopOptions.value[1].label, 'Laptop');
  env.uid = 'user-b';
  page.restoreCached();
  assert.equal(page.items.value.length, 0);
  assert.equal(page.desktopOptions.value.length, 1);
  assert.equal(page.state.value, 'loading');
  assert.equal(page.filter.value, 'all');
});

test('settings mutation defeats an older response and cached false remains a valid value', async () => {
  const env = environment();
  const service = env.load('services/tokenm-service.uts');
  const cache = env.load('services/page-cache.uts');
  const pending = deferred();
  env.handlers.getSettings = () => pending.promise;
  const old = service.getNotificationSettings();
  await service.updateNotificationsEnabled(false);
  pending.resolve({ settings: { notificationsEnabled: true } });
  await assert.rejects(old, /superseded/);
  assert.equal(cache.settingsSnapshot.peek(), false);
  assert.equal((await service.getNotificationSettings()).notificationsEnabled, false);
});

test('server session rejection purges existing cache and redirects instead of retaining stale access', async () => {
  const env = environment();
  const service = env.load('services/tokenm-service.uts');
  const cache = env.load('services/page-cache.uts');
  await service.getDashboard();
  cache.dashboardSnapshot.expire();
  env.handlers.getAndroidDashboard = async () => { throw { errCode: 'uni-id-token-expired', errMsg: 'expired' }; };
  await assert.rejects(service.getDashboard());
  assert.equal(cache.dashboardSnapshot.peek(), null);
  assert.equal(cache.settingsSnapshot.peek(), null);
  assert.ok(env.routes.includes('/pages/login/index'));
});

test('manual refresh bypasses freshness and an existing empty Tasks result survives failure', async () => {
  const env = environment();
  const runtime = env.load('services/client-runtime.uts');
  await runtime.prepareClientPage();
  env.handlers.listTasks = async () => ({ tasks: [], nextCursor: null });
  await env.load('services/tokenm-service.uts').listTasks(null, 'all', 'all', 'all', 20);
  const page = env.page('tasks', ['state', 'items', 'banner', 'runPullRefresh']);
  assert.equal(page.state.value, 'ready');
  env.handlers.listTasks = async () => { throw { errCode: 'NETWORK_ERROR', errMsg: 'offline' }; };
  await page.runPullRefresh();
  assert.equal(env.calls.filter((name) => name === 'listTasks').length, 2);
  assert.equal(page.state.value, 'ready');
  assert.equal(page.items.value.length, 0);
  assert.match(page.banner.value, /上次数据/);
});

test('task clear invalidates retained filtered results before returning from Privacy', async () => {
  const env = environment();
  await env.load('services/client-runtime.uts').prepareClientPage();
  const page = env.page('tasks', ['state', 'items', 'filter', 'restoreCached', 'runLoadFirst']);
  page.filter.value = 'full';
  await page.runLoadFirst(false);
  env.load('services/page-cache.uts').invalidateTaskViews();
  page.restoreCached();
  assert.equal(page.items.value.length, 0);
  assert.equal(page.state.value, 'loading');
});

test('Push receive expires task views without clearing data, requesting data or changing settings', async () => {
  const env = environment();
  const service = env.load('services/tokenm-service.uts');
  const cache = env.load('services/page-cache.uts');
  await service.getDashboard();
  await service.listTasks(null, 'all', 'all', 'all', 20);
  env.loadActualPush().startPushRuntime();
  const calls = env.calls.length;
  env.pushListener({ type: 'receive' });
  assert.equal(cache.tasksSnapshot.fresh(), false);
  assert.equal(cache.dashboardSnapshot.fresh(), false);
  assert.equal(cache.settingsSnapshot.fresh(), true);
  assert.notEqual(cache.tasksSnapshot.peek(), null);
  assert.equal(env.calls.length, calls);
});

test('Getui icons bind once after CID success and warn on failure', async () => {
  const env = environment();
  const push = env.loadActualPush();
  push.startPushRuntime();
  assert.equal(env.iconBindings.length, 0);
  assert.equal(await push.getOfficialPushClientId(), 'test-cid');
  assert.deepEqual(env.iconBindings, [['push_small', 'push']]);
  await push.getOfficialPushClientId();
  assert.equal(env.iconBindings.length, 1);
  push.stopPushRuntime();
  push.startPushRuntime();
  env.iconBindingSucceeds = false;
  await push.getOfficialPushClientId();
  assert.equal(env.iconBindings.length, 2);
  assert.deepEqual(env.logs.at(-1), ['Getui notification icon binding failed']);
  assert.equal(env.pushRegistrations, 0);
});

test('event arriving during a read keeps the result stale for the next entry', async () => {
  const env = environment();
  const cache = env.load('services/page-cache.uts');
  const pending = deferred();
  const task = cache.tasksSnapshot.read(false, () => pending.promise);
  cache.expireTaskViews();
  pending.resolve({ items: [env.task], nextCursor: null });
  await task;
  assert.notEqual(cache.tasksSnapshot.peek(), null);
  assert.equal(cache.tasksSnapshot.fresh(), false);
});

test('history clear defeats a filtered task response that was already in flight', async () => {
  const env = environment();
  await env.load('services/client-runtime.uts').prepareClientPage();
  const page = env.page('tasks', ['items', 'filter', 'runLoadFirst']);
  page.filter.value = 'full';
  const pending = deferred();
  env.handlers.listTasks = () => pending.promise;
  const request = page.runLoadFirst(false);
  await new Promise((resolve) => setImmediate(resolve));
  env.load('services/page-cache.uts').invalidateTaskViews();
  pending.resolve({ tasks: [env.task], nextCursor: null });
  await request;
  assert.equal(page.items.value.length, 0);
});

test('snapshot rejection preserves Error objects and normalizes non-Throwable reasons', async () => {
  const env = environment();
  const cache = env.load('services/page-cache.uts');
  const original = new Error('network failed');
  await assert.rejects(cache.tasksSnapshot.read(false, () => Promise.reject(original)), (error) => error === original);
  for (const reason of [null, 'offline', { message: 'unknown rejection' }]) {
    await assert.rejects(cache.tasksSnapshot.read(false, () => Promise.reject(reason)), (error) => error instanceof Error && error.message === 'page_read_failed');
    assert.equal(cache.tasksSnapshot.inFlight, null);
  }
});


test('single delete and clear reject stale responses, update home, and retain records on failure', async () => {
  const env = environment(); const service = env.load('services/tokenm-service.uts');
  const cache = env.load('services/page-cache.uts'); const management = env.load('services/task-management.uts');
  await service.getDashboard(); await service.listTasks(null,'all','all','all',20);
  const task = cache.tasksSnapshot.peek().items[0];
  env.handlers.deleteTask = async () => { throw Error('offline'); };
  await assert.rejects(management.deleteTaskRecord(task));
  assert.equal(cache.tasksSnapshot.peek().items.length,1);
  const pending = deferred(); cache.tasksSnapshot.expire();
  env.handlers.listTasks = () => pending.promise;
  const late = service.listTasks(null,'all','all','all',20);
  env.handlers.deleteTask = async () => ({ ok:true });
  await management.deleteTaskRecord(task);
  assert.equal(cache.tasksSnapshot.peek().items.length,0);
  assert.equal(cache.dashboardSnapshot.peek().recentTasks.length,0);
  pending.resolve({tasks:[env.task],nextCursor:null});
  await assert.rejects(late);
  env.handlers.listTasks = async () => ({tasks:[],nextCursor:null});
  assert.equal((await service.listTasks(null,'all','all','all',20)).items.length,0);
  env.handlers.listTasks = async () => ({tasks:[{...env.task,taskId:'new'}],nextCursor:null});
  cache.tasksSnapshot.expire();
  await service.listTasks(null,'all','all','all',20);
  assert.equal(cache.tasksSnapshot.peek().items[0].taskId,'new');
  env.handlers.clearTasks = async () => { throw Error('offline'); };
  await assert.rejects(management.clearTaskRecords());
  assert.equal(cache.tasksSnapshot.peek().items.length,1);
  const oldHome = deferred(); cache.dashboardSnapshot.expire();
  env.handlers.getAndroidDashboard = () => oldHome.promise;
  const lateHome = service.getDashboard();
  env.handlers.clearTasks = async () => ({ok:true});
  await management.clearTaskRecords();
  assert.equal(cache.tasksSnapshot.peek().items.length,0);
  assert.equal(cache.dashboardSnapshot.peek().todayCompletedCount,0);
  oldHome.resolve({counts:{todayTasks:99,activeDesktops:1},settings:{notificationsEnabled:true},latestTask:env.task});
  await assert.rejects(lateHome);
  assert.equal(cache.dashboardSnapshot.peek().todayCompletedCount,0);
  env.handlers.listTasks = async () => ({tasks:[],nextCursor:null});
  assert.equal((await service.listTasks(null,'all','all','all',20)).items.length,0);
});

test('task detail deleted response shows a safe empty error and does not navigate/crash', async () => {
  const env=environment();
  env.handlers.getTask=async()=>{throw {errCode:'task_not_found'};};
  const page=env.page('task-detail',['taskId','task','state','errorMessage','runLoad']);
  page.taskId.value='tsk_12345678-1234-4123-8123-123456789abc';
  await page.runLoad();
  assert.equal(page.task.value,null);assert.equal(page.state.value,'error');
  assert.equal(page.errorMessage.value,'任务不存在或已删除');
});


test('task actions require sheet plus confirmation; failure retains page; clear ignores filters',async()=>{
  const env=environment();await env.load('services/client-runtime.uts').prepareClientPage();
  await env.load('services/tokenm-service.uts').listTasks(null,'all','all','all',20);
  const page=env.page('tasks',['items','taskActions','confirmClear','runDelete','filter','desktopId','mutation','state']);
  const task=page.items.value[0];page.taskActions(task);
  assert.deepEqual(Array.from(env.actionSheet.itemList),['删除此任务记录']);
  assert.ok(!env.calls.includes('deleteTask'));
  env.actionSheet.success({tapIndex:0});assert.equal(env.modal.title,'删除这条任务记录？');
  env.modal.success({confirm:false});assert.ok(!env.calls.includes('deleteTask'));
  env.handlers.deleteTask=async()=>{throw Error('offline');};await page.runDelete(task);
  assert.equal(page.items.value.length,1);assert.equal(page.mutation.value,'');
  env.handlers.deleteTask=async()=>({ok:true});await page.runDelete(task);
  assert.equal(page.items.value.length,0);assert.equal(page.state.value,'ready');
  page.filter.value='privacy';page.desktopId.value='desk-1';page.confirmClear();
  assert.match(env.modal.content,/当前账户中的全部任务记录/);
  env.handlers.clearTasks=async input=>{assert.equal(Object.keys(input).join(','),'confirmation');return {ok:true};};
  await page.runDelete(null);assert.equal(page.items.value.length,0);
});
