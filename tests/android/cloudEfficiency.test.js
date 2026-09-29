'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../../apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core');
const cloud = require('../../apps/tokenm-android/uniCloud-alipay/cloudfunctions/tokenm-co/index.obj');
const { UniCloudRepository } = require('../../apps/tokenm-android/uniCloud-alipay/cloudfunctions/common/tokenm-core/repository-unicloud');

const protectedMethods = ['bootstrap', 'getDashboard', 'listTasks', 'getTask', 'listDesktops', 'createPairingCode', 'getPairingStatus', 'renameDesktop', 'unbindDesktop', 'updateSettings', 'deleteTask', 'clearTasks'];
function application() {
  return new core.TokenMApplication({ repository: new core.MemoryRepository(), credentialKey: Buffer.alloc(32, 1), now: () => 100000 });
}
test('every protected cloud-object operation rejects an old privacy version before reading or mutating data', async () => {
  const app = application();
  await app.bootstrap('owner');
  await app.updatePrivacyConsent('owner', { version: core.PRIVACY_CONSENT_VERSION });
  const user = await app.repository.findOne(core.COLLECTIONS.users, { ownerId: 'owner' });
  // Simulates server version advancement while a client still believes consent current.
  await app.repository.updateById(core.COLLECTIONS.users, user._id, { privacyConsentVersion: 'previous-version' });
  for (const method of protectedMethods) {
    let invoked = false;
    const facade = { requireCurrentPrivacyConsent: app.requireCurrentPrivacyConsent.bind(app), [method]: async () => { invoked = true; return { ok: true }; } };
    await assert.rejects(cloud[method].call({ tokenmUid: 'owner', tokenmApplication: facade }, {}), error => error.code === 'privacy_consent_required');
    assert.equal(invoked, false, method);
    await app.updatePrivacyConsent('owner', { version: core.PRIVACY_CONSENT_VERSION });
    await cloud[method].call({ tokenmUid: 'owner', tokenmApplication: facade }, {});
    assert.equal(invoked, true, method);
    await app.repository.updateById(core.COLLECTIONS.users, user._id, { privacyConsentVersion: 'previous-version' });
  }
  for (const method of ['getAndroidDashboard', 'getSettings']) {
    await assert.rejects(cloud[method].call({ tokenmUid: 'owner', tokenmApplication: app }, {}), error => error.code === 'privacy_consent_required');
  }
  await assert.rejects(app.registerMobileDevice('owner', { enabled: true }, { deviceId: 'test', platform: 'app' }), error => error.code === 'privacy_consent_required');
  // Consent recovery and disabling the device must remain possible.
  await app.registerMobileDevice('owner', { enabled: false }, { deviceId: 'test', platform: 'app' });
  assert.equal((await app.getPrivacyConsent('owner')).privacyConsent.isCurrent, false);
  await app.updatePrivacyConsent('owner', { version: core.PRIVACY_CONSENT_VERSION });
});

test('task pushdown is equivalent to legacy ordering/filter/cursor across ties, tombstones and history watermark', async () => {
  const app = application(); const repo = app.repository;
  await app.bootstrap('owner');
  const user = await repo.findOne(core.COLLECTIONS.users, { ownerId: 'owner' });
  await repo.updateById(core.COLLECTIONS.users, user._id, { historyClearedAtMs: 20 });
  for (let i = 0; i < 320; i++) {
    const task = { _id: `tsk_${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, ownerId: i % 13 === 0 ? 'other' : 'owner', desktopId: i % 2 ? 'dev_11111111-0000-4000-8000-000000000000' : 'dev_22222222-0000-4000-8000-000000000000', eventId: `evt:${i}`, event: 'codex.task.completed', schemaVersion: 1, createdAtMs: Math.floor(i / 3), occurredAt: new Date(100000).toISOString(), privacyMode: i % 3 === 0, notificationStatus: i % 2 ? 'submitted' : 'failed', sessionId: '', project: null, model: null, summary: null, durationMs: null };
    if (i % 7 === 0) task.userDeletedAtMs = 100000;
    else if (i % 5 === 0) task.userDeletedAtMs = null;
    await repo.insert(core.COLLECTIONS.tasks, task);
  }
  const all = await repo.findMany(core.COLLECTIONS.tasks, { ownerId: 'owner' }, { sort: [{ field: 'createdAtMs', direction: 'desc' }, { field: '_id', direction: 'desc' }] });
  const filters = [{}, { privacyMode: true }, { privacyMode: false }, { desktopId: 'dev_11111111-0000-4000-8000-000000000000' }, { notificationStatus: 'failed' }, { notificationStatuses: ['submitted', 'failed'] }, { privacyMode: false, notificationStatuses: ['submitted'], desktopId: 'dev_11111111-0000-4000-8000-000000000000' }];
  for (const filter of filters) {
    let cursor = null;
    do {
      const expected = all.filter(t => t.userDeletedAtMs == null && t.createdAtMs > 20
        && (!cursor || t.createdAtMs < cursor.createdAtMs || (t.createdAtMs === cursor.createdAtMs && t._id < cursor.taskId))
        && (filter.privacyMode === undefined || t.privacyMode === filter.privacyMode)
        && (filter.desktopId === undefined || t.desktopId === filter.desktopId)
        && (filter.notificationStatus === undefined || t.notificationStatus === filter.notificationStatus)
        && (!filter.notificationStatuses || filter.notificationStatuses.includes(t.notificationStatus)));
      const result = await app.listTasks('owner', { ...filter, limit: 7, ...(cursor ? { cursor } : {}) });
      assert.deepEqual(result.tasks.map(t => t.taskId), expected.slice(0, 7).map(t => t._id));
      const last = expected[6];
      const next = expected.length > 7 ? { createdAtMs: last.createdAtMs, taskId: last._id } : null;
      assert.deepEqual(result.nextCursor, next);
      cursor = next;
    } while (cursor);
  }
});

test('UniCloud adapter pushes exact filters and compound cursor into where plus sort/limit', async () => {
  const op = (kind, value) => ({ kind, value, or(other) { return op('or', [this, other]); } });
  const command = Object.fromEntries(['exists', 'eq', 'gt', 'lt', 'in'].map(k => [k, v => op(k, v)]));
  command.and = (...parts) => op('and', parts); command.or = (...parts) => op('or', parts);
  const calls = []; const query = { where(x) { calls.push(['where', x]); return this; }, orderBy(...x) { calls.push(['sort', ...x]); return this; }, limit(x) { calls.push(['limit', x]); return this; }, async get() { return { data: [] }; } };
  const repo = new UniCloudRepository({ database: { command, collection: () => query } });
  const criteria = repo.taskHistoryCriteria('owner', { after: 20, cursor: { createdAtMs: 30, taskId: 'task' }, desktopId: 'desktop', privacyMode: false, notificationStatuses: ['submitted'] });
  await repo.findMany(core.COLLECTIONS.tasks, criteria, { sort: [{ field: 'createdAtMs', direction: 'desc' }, { field: '_id', direction: 'desc' }], limit: 8 });
  assert.equal(criteria.kind, 'and');
  const base = criteria.value[0]; assert.equal(base.ownerId, 'owner'); assert.equal(base.desktopId, 'desktop'); assert.equal(base.privacyMode, false); assert.equal(base.notificationStatus.kind, 'in'); assert.equal(base.createdAtMs.value, 20);
  assert.equal(criteria.value[1].kind, 'or');
  assert.equal(criteria.value[1].value[0].createdAtMs.value, 30);
  assert.equal(criteria.value[1].value[1].createdAtMs, 30);
  assert.equal(criteria.value[1].value[1]._id.value, 'task');
  assert.deepEqual(calls.slice(1), [['sort', 'createdAtMs', 'desc'], ['sort', '_id', 'desc'], ['limit', 8]]);
});

test('Android dashboard bounds task/desktop materialization and excludes mobile-device history reads', async () => {
  const app = application(); await app.bootstrap('owner');
  await app.updatePrivacyConsent('owner', { version: core.PRIVACY_CONSENT_VERSION });
  const repo = app.repository;
  for (let i = 0; i < 15; i++) {
    await repo.insert(core.COLLECTIONS.desktops, { _id: `desktop-${i}`, ownerId: 'owner', name: `Desktop ${i}`, status: 'active', createdAtMs: i });
    await repo.insert(core.COLLECTIONS.tasks, { _id: `task-${i}`, ownerId: 'owner', desktopId: `desktop-${i}`, createdAtMs: i, occurredAt: new Date(100000).toISOString(), eventId: `event-${i}`, privacyMode: true, notificationStatus: 'submitted' });
  }
  await repo.updateById(core.COLLECTIONS.tasks, 'task-14', { userDeletedAtMs: 100000 });
  const reads = []; const find = repo.findMany.bind(repo);
  repo.findMany = async (collection, criteria, options = {}) => { reads.push({ collection, criteria, options }); return find(collection, criteria, options); };
  const result = await app.getAndroidDashboard('owner');
  assert.equal(result.counts.activeDesktops, 15); assert.equal(result.counts.todayTasks, 14);
  assert.deepEqual(result.recentTasks.map(t => t.task.taskId), ['task-13', 'task-12', 'task-11']);
  assert.equal(result.recentTasks[0].desktopName, 'Desktop 13'); assert.equal(result.recentDesktops.length, 2);
  assert.ok(reads.some(r => r.collection === core.COLLECTIONS.tasks && r.options.limit === 3));
  assert.ok(reads.some(r => r.collection === core.COLLECTIONS.desktops && r.options.limit === 2));
  assert.equal(reads.some(r => r.collection === core.COLLECTIONS.mobileDevices), false);
});
