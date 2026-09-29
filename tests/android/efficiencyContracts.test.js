'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { environment } = require('./runtime-fixture');

test('protected business rejection inside consent TTL clears cache, stops Push, requires reconfirmation and redirects', async () => {
  const env = environment();
  const runtime = env.load('services/client-runtime.uts');
  const service = env.load('services/tokenm-service.uts');
  const cache = env.load('services/page-cache.uts');
  await runtime.prepareClientPage();
  await service.getDashboard();
  cache.dashboardSnapshot.expire();
  env.handlers.getAndroidDashboard = async () => { throw { errCode: 'privacy_consent_required' }; };
  await assert.rejects(service.getDashboard());
  assert.equal(env.calls.filter(x => x === 'getPrivacyConsent').length, 1);
  assert.equal(cache.dashboardSnapshot.peek(), null);
  assert.equal(cache.settingsSnapshot.peek(), null);
  assert.equal(runtime.canReuseProtectedPageData(), false);
  assert.equal(env.pushStops, 1);
  assert.equal(env.reconfirmations, 1);
  assert.ok(env.routes.includes('/pages/permission/index'));
});

test('registration freshness covers concurrency, CID discovery/change, owner, permission, version, label, retry and heartbeat', async () => {
  const env = environment(); env.expires = 1e12; env.useActualRegistration();
  const mobile = env.load('services/mobile-device.uts');
  const register = () => mobile.registerCurrentMobileDevice('authorized');
  const writes = () => env.calls.filter(x => x === 'registerMobileDevice').length;
  await Promise.all([register(), register()]); assert.equal(writes(), 1);
  await register(); assert.equal(writes(), 1);
  assert.equal(env.calls.filter(x => x === 'getPushClientId').length, 1);
  env.now += 30000; await register(); assert.equal(writes(), 1);
  env.cid = 'replacement-cid'; env.now += 30000; await register(); assert.equal(writes(), 2);
  env.deviceLabel = 'Phone'; await register(); assert.equal(writes(), 3);
  env.appVersion = '0.1.2'; await register(); assert.equal(writes(), 4);
  await mobile.registerCurrentMobileDevice('denied'); assert.equal(writes(), 5);
  assert.equal(env.calls.filter(x => x === 'setPushCid').length, 2); // No rebinding for label/version/permission.
  env.uid = 'user-b'; await register(); assert.equal(writes(), 6);
  env.now += 6 * 60 * 60 * 1000; await register(); assert.equal(writes(), 7);
  mobile.resetMobileRegistrationFreshness(); await register(); assert.equal(writes(), 8);
  mobile.resetMobileRegistrationFreshness();
  env.handlers.setPushCid = async () => { throw Error('offline'); };
  await assert.rejects(register()); assert.equal(writes(), 9); // Existing error-status write retained.
  delete env.handlers.setPushCid; await register(); assert.equal(writes(), 10);
  await mobile.disableCurrentMobileDevice('authorized', 'ready');
  await register(); assert.equal(writes(), 12);
});

test('Permission remains usable before consent without reading protected bootstrap statistics', async () => {
  const env = environment();
  env.handlers.getPrivacyConsent = async () => ({ privacyConsent: env.consent(false) });
  const page = env.page('permission', ['state', 'facts', 'runLoad', 'activeDesktopCountLabel']);
  await page.runLoad();
  assert.equal(page.state.value, 'ready');
  assert.equal(page.facts.value.privacyConsent, 'required');
  assert.equal(env.calls.includes('bootstrap'), false);
  assert.match(page.activeDesktopCountLabel.value, /确认隐私后/);
});

test('uncached detail rejects stale consent immediately; old-account failures do not purge a new account', async () => {
  const env = environment();
  const runtime = env.load('services/client-runtime.uts');
  const service = env.load('services/tokenm-service.uts');
  await runtime.prepareClientPage(); await service.getDashboard();
  env.handlers.getTask = async () => { throw { errCode: 'privacy_consent_required' }; };
  await assert.rejects(service.getTask('task'));
  assert.equal(runtime.canReuseProtectedPageData(), false);
  let reject;
  env.handlers.getTask = () => new Promise((_resolve, no) => { reject = no; });
  const old = service.getTask('task');
  env.uid = 'user-b'; await runtime.prepareClientPage(); await service.getDashboard();
  const routes = env.routes.length;
  reject({ errCode: 'privacy_consent_required' }); await assert.rejects(old);
  assert.equal(env.routes.length, routes);
  assert.notEqual(env.load('services/page-cache.uts').dashboardSnapshot.peek(), null);
});

test('registration never binds an old account after CID resolves across account switch', async () => {
  const env = environment(); env.useActualRegistration();
  const mobile = env.load('services/mobile-device.uts');
  const pending = mobile.registerCurrentMobileDevice('authorized');
  env.uid = 'other-owner';
  await assert.rejects(pending, /session_changed/);
  assert.equal(env.calls.includes('setPushCid'), false);
  assert.equal(env.calls.includes('registerMobileDevice'), false);
});

test('each cache TTL returns zero requests while fresh and one after expiry; force always refreshes', async () => {
  const env = environment(); const cache = env.load('services/page-cache.uts');
  for (const [name, ttl] of [['dashboardSnapshot', 30000], ['tasksSnapshot', 30000], ['desktopsSnapshot', 60000], ['settingsSnapshot', 60000]]) {
    let calls = 0; const read = force => cache[name].read(force, async () => { calls++; return false; });
    await read(false); await read(false); assert.equal(calls, 1, name);
    env.now += ttl - 1; await read(false); assert.equal(calls, 1, name);
    env.now++; await read(false); assert.equal(calls, 2, name);
    await read(true); assert.equal(calls, 3, name);
  }
});
