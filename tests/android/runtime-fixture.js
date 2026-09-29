'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');


const root = process.env.POTATO_RUNTIME_ROOT ?? path.resolve(__dirname, '../../apps/tokenm-android');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Execute the actual UTS algorithms with type syntax removed, not a duplicate
// cache implementation. HBuilderX separately validates UTS/Kotlin generation.
function environment() {
  class UniCloudError extends Error {}
  const env = {
    now: 100000,
    uid: 'user-a',
    expires: 10000000,
    calls: [],
    cacheReads: [],
    handlers: {},
    routes: [],
    hooks: {},
    logs: [],
    iconBindings: [],
    iconBindingSucceeds: true,
    pushRegistrations: 0,
    desktop: { desktopId: 'desk-1', name: 'Laptop', status: 'active', createdAt: null, lastSeenAt: null, lastEventAt: null },
    task: { taskId: 'tsk-1', desktopId: 'desk-1', occurredAt: '2026-09-09T00:00:00Z', privacyMode: false, summary: 'Finished', project: 'App', model: 'model', durationMs: 20, notificationStatus: 'submitted' }
  };
  const consent = (current = true) => ({
    getString(key) { return { requiredVersion: 'v1', acceptedVersion: 'v1', acceptedAt: null }[key]; },
    getBoolean() { return current; }
  });
  const cloud = new Proxy({}, {
    get(_object, method) {
      return async (input) => {
        env.calls.push(method);
        if (env.handlers[method]) {
          try {
            return await env.handlers[method](input);
          } catch (error) {
            if (error?.errCode) Object.setPrototypeOf(error, UniCloudError.prototype);
            throw error;
          }
        }
        if (method === 'getPrivacyConsent' || method === 'updatePrivacyConsent') return { privacyConsent: consent() };
        if (method === 'listDesktops') return { desktops: [{ ...env.desktop }] };
        if (method === 'listTasks') return { tasks: [{ ...env.task }], nextCursor: null };
        if (method === 'getTask') return { task: { ...env.task } };
        if (method === 'getAndroidDashboard') return { counts: { todayTasks: 1, activeDesktops: 1 }, settings: { notificationsEnabled: true }, recentTasks: [{ task: { ...env.task }, desktopName: env.desktop.name }], recentDesktops: [{ ...env.desktop }] };
        if (method === 'getDashboard') return { counts: { todayTasks: 1, activeDesktops: 1 }, settings: { notificationsEnabled: true }, latestTask: env.task };
        if (method === 'getSettings') return { settings: { notificationsEnabled: true } };
        if (method === 'updateSettings') return { settings: { notificationsEnabled: input.notificationsEnabled } };
        if (method === 'renameDesktop') return { desktop: { ...env.desktop, name: input.name } };
        if (method === 'unbindDesktop') return { desktop: { ...env.desktop, status: 'revoked' } };
        if (method === 'getPairingStatus') return { status: 'paired', sessionId: 'pair-1', desktopId: 'desk-1' };
        if (method === 'registerMobileDevice' || method === 'setPushCid') return { ok: true };
        if (method === 'createPairingCode') return { sessionId: 'pair-1', code: '123456', expiresAt: new Date(env.now + 600000).toISOString() };
        if (method === 'clearTasks' || method === 'deleteTask') return { ok: true };
        throw new Error(`unhandled fixture method ${method}`);
      };
    }
  });
  const context = vm.createContext({
    UniCloudError,
    Error,
    Promise,
    Date: class extends Date { static now() { return env.now; } },
    console: { info: (...args) => env.logs.push(args), warn: (...args) => env.logs.push(args) },
    UTSAndroid: { getAppContext: () => ({
      getPackageName: () => 'com.gary.tokenm',
      getResources: () => ({ getIdentifier: (name, type, packageName) => {
        assert.equal(type, 'drawable');
        assert.equal(packageName, 'com.gary.tokenm');
        return name === 'push_small' ? 101 : name === 'push' ? 102 : 0;
      } })
    }) },
    PushManager: { getInstance: () => ({ getVersion: () => '3.test', setNotificationIcon: (_context, small, large) => {
      env.iconBindings.push([small, large]);
      return env.iconBindingSucceeds;
    } }) },
    uniCloud: { importObject: () => cloud },
    uni: {
      getPushChannelManager: () => null,
      getPushClientId: ({ success }) => { env.calls.push('getPushClientId'); success({ cid: env.cid ?? 'test-cid' }); },
      getSystemInfoSync: () => ({ appVersion: env.appVersion ?? '0.1.1' }),
      getStorageSync: (key) => key === 'tokenm.push.user-activated.v1' ? true : key === 'tokenm.device.label.v1' ? env.deviceLabel ?? null : null,
      setStorageSync() {}, removeStorageSync() {},
      onPushMessage: (listener) => { env.pushListener = listener; },
      offPushMessage() {},
      getAppAuthorizeSetting: () => ({ notificationAuthorized: env.permission ?? 'authorized' }),
      reLaunch: ({ url }) => { env.routes.push(url); },
      navigateTo() {}, showToast() {}, showModal(options) { env.modal=options; }, showActionSheet(options) { env.actionSheet=options; }, openAppAuthorizeSetting() {}
    }
  });
  vm.runInContext('Object.prototype.set = function (key, value) { this[key] = value; }', context);
  const modules = new Map();
  const profile = () => ({ userId: env.uid, username: env.uid, authenticated: !!env.uid && env.expires > env.now });
  modules.set('services/auth-service.uts', {
    getCurrentAccountProfile: profile, uniIdCo: cloud,
    loginWithUniId: async () => profile(), registerWithUniId: async () => profile(),
    logoutWithUniId: async () => { env.uid = ''; }, closeAccountWithUniId: async () => {},
    createOfficialCaptcha() {}, refreshOfficialCaptcha() {}
  });
  modules.set('services/push-runtime.uts', {
    wasPushActivatedByUser: () => true, isPushReconfirmationRequired: () => false,
    startPushRuntime() {}, stopPushRuntime() { env.pushStops = (env.pushStops ?? 0) + 1; }, requirePushReconfirmation() { env.reconfirmations = (env.reconfirmations ?? 0) + 1; },
    flushPendingPushRoute() {}, markPushNavigationReady() {}, clearPushActivation() {},
    rememberPushActivation() {}, requestAndroidNotificationPermission: async () => {}
  });
  modules.set('services/mobile-device.uts', {
    registerCurrentMobileDevice: async () => { env.pushRegistrations++; },
    disableCurrentMobileDevice: async () => {}, resetMobileRegistrationFreshness() {}
  });
  modules.set('vue', { computed: (getter) => ({ get value() { return getter(); } }), ref: (value) => ({ value }), nextTick: (fn) => Promise.resolve().then(fn) });
  modules.set('@dcloudio/uni-app', Object.fromEntries(['onShow', 'onReady', 'onLoad', 'onHide', 'onUnload'].map((key) => [key, (fn) => { env.hooks[key] = fn; }])));

  function evaluate(file, source, names) {
    const dependencies = [];
    source = source.replace(/import PushManager from 'com\.igexin\.sdk\.PushManager'/g, '').replace(/import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g, (_all, type, bindings, specifier) => {
      if (type) return '';
      const dependency = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier;
      const index = dependencies.push(load(dependency)) - 1;
      return `const { ${bindings} } = dependencies[${index}];`;
    }).replace(/\bexport\s+/g, '');
    const js = stripTypeScriptTypes(source, { mode: 'transform' });
    const factory = vm.runInContext(`(function(dependencies) { ${js}\nreturn { ${names.join(', ')} }; })`, context, { filename: file });
    return factory(dependencies);
  }
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    if (file === 'services/client.uts') return { ...load('services/tokenm-service.uts'), ...load('services/client-runtime.uts') };
    const source = read(file);
    const names = [...source.matchAll(/export (?:const|class|function) (\w+)/g)].map((match) => match[1]);
    const result = evaluate(file, source, names);
    if (file === 'services/page-cache.uts') {
      for (const name of ['dashboardSnapshot', 'tasksSnapshot', 'desktopsSnapshot', 'settingsSnapshot']) {
        const snapshot = result[name]; const original = snapshot.read.bind(snapshot);
        snapshot.read = (force, loader) => {
          env.cacheReads.push({ name, state: snapshot.inFlight != null ? 'in_flight' : !force && snapshot.fresh() ? 'hit' : snapshot.peek() == null ? 'miss' : 'stale' });
          return original(force, loader);
        };
      }
    }
    modules.set(file, result);
    return result;
  }
  env.load = load;
  env.loadActualMobile = () => { modules.delete('services/mobile-device.uts'); return load('services/mobile-device.uts'); };
  env.useActualRegistration = () => { env.loadActualPush(); env.loadActualMobile(); };
  env.loadActualPush = () => {
    modules.delete('services/push-runtime.uts');
    return load('services/push-runtime.uts');
  };
  env.page = (name, names) => {
    env.hooks = {};
    const file = `pages/${name}/index.uvue`;
    return evaluate(file, read(file).split('<script setup lang="uts">')[1].split('</script>')[0], names);
  };
  env.consent = consent;
  return env;
}


module.exports = { environment, deferred };
