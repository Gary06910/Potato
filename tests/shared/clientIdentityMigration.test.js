'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const catalog = require('../../src/shared/clientCatalog');
const tracking = require('../../src/shared/clientTracking');
const { seedSplitClients, CLIENT_IDENTITY_GENERATION, isPreSplitEntry } = require('../../src/shared/clientIdentitySplits');
const { aggregateDevices, extractUsageFromTokscale, normalizePeriod, normalizeDeviceRecord, mergeDeviceRecord } = require('../../src/shared/usage');
const { coerceHistory, mergeHistories, normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const daily = require('../../src/shared/dailyHistoryArchive');
const clients = require('../../src/shared/clientUsageArchive');
const sessions = require('../../src/shared/sessionUsageArchive');
const { createSessionUsageArchiveStore, readSessionUsageArchiveSnapshot } = require('../../src/shared/sessionUsageArchiveStore');
const preferences = require('../../src/electron/renderer/clientDisplayPreferences');
const { normalizeCustomScanPaths } = require('../../src/shared/customScanPaths');
const { tokscaleClientFilter } = require('../../src/shared/collector');

process.env.TZ = 'UTC';
const now = new Date('2026-10-19T12:00:00.000Z');
const known = 'claude,codex,opencode,hermes,openclaw,cursor,antigravity,cline,amp,droid,kimi,qwen,grok,copilot,pi,omp,goose,zed,kilo,commandcode,mimo,muse,zcode,kiro,codebuddy,workbuddy,proma,catpaw,qodercn,reasonix,dsh,cherrystudio,lmstudio,unsloth,devin,fx,mcode'.split(',');
function period(rows) {
  return extractUsageFromTokscale(rows.map(([client, sessionId, tokens]) => ({ client, sessionId, model: 'gpt', totalTokens: tokens, costUsd: tokens / 100 })));
}
function summary(rows) {
  return { updatedAt: now.toISOString(), ...Object.fromEntries(['today','month','allTime'].map(name => [name, period(rows)])) };
}
function graph(date, rows) {
  return { contributions: [{ date, clients: rows.map(([client, tokens]) => ({ client, modelId: 'gpt', tokens: { input: tokens }, cost: tokens / 100, messages: 1 })) }] };
}
function evaluated(value, applied = '') {
  const result = seedSplitClients(tracking.clientsCsvForSetting(value), { applied });
  return { clients: result.clients, applied: [...new Set([...applied.split(',').filter(Boolean), ...result.evaluated])].join(',') };
}
function mainFunction(name, extras = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, extras);
}

test('stable catalog has exactly 37 ordered unique identities and independent fork/parser ownership', () => {
  assert.deepEqual([...catalog.CLIENT_IDS], known);
  assert.equal(new Set(known).size, 37);
  assert.deepEqual([...catalog.DEFAULT_CLIENT_IDS], known.filter(id => !['catpaw','qodercn'].includes(id)));
  assert.deepEqual([...catalog.FORK_ONLY_CLIENT_IDS], ['proma','catpaw','qodercn']);
  assert.deepEqual([...tracking.PARSE_LOCAL_CLIENTS], []);
  const nativeClients = ['proma','qodercn','claude'].filter(id => !tracking.PARSE_LOCAL_CLIENTS.includes(id));
  assert.equal(tokscaleClientFilter(nativeClients.join(',')), 'proma,qodercn,claude');
  assert.equal(tokscaleClientFilter('pi'), 'pi');
  assert.equal(tokscaleClientFilter('omp'), 'omp');
  assert.equal(tokscaleClientFilter('mimo'), 'micode,micode-desktop');
});

test('split settings evaluate once for tracked, untracked, absent and fresh settings', () => {
  assert.deepEqual(evaluated('codex,pi,micode'), { clients: 'codex,pi,omp,mimo', applied: 'omp' });
  assert.deepEqual(evaluated('codex'), { clients: 'codex', applied: 'omp' });
  assert.deepEqual(evaluated(''), { clients: '', applied: 'omp' });
  const fresh = evaluated(undefined);
  assert.equal(fresh.clients, tracking.DEFAULT_CLIENTS);
  assert.equal(fresh.applied, 'omp');
  const disabled = fresh.clients.split(',').filter(id => id !== 'omp').join(',');
  assert.equal(evaluated(disabled, fresh.applied).clients, disabled);
  assert.equal(evaluated('pi', evaluated('codex').applied).clients, 'pi');
  assert.equal(evaluated('codex,pi', 'omp').clients, 'codex,pi');
});

test('MiMo legacy settings preserve order, hidden/pinned choice, custom paths and independent xiaomi/provider colour', () => {
  const list = catalog.KNOWN_CLIENT_LIST;
  assert.equal(tracking.clientsCsvForSetting('micode,mimo,micode-desktop,codex'), 'mimo,codex');
  assert.deepEqual(preferences.normalizeClientDisplayOrder('micode,codex', list).slice(0, 2), ['mimo','codex']);
  assert.equal(preferences.normalizeHiddenClients('micode,mimo', list), 'mimo');
  assert.equal(preferences.normalizePinnedClients('micode,codex', list), 'mimo,codex');
  assert.deepEqual(normalizeCustomScanPaths({ micode: ['/fixture/mimo'], mimo: ['/fixture/mimo','/fixture/new'] }, { platform: 'linux' }), { mimo: ['/fixture/mimo','/fixture/new'] });
  const colors = mainFunction('migrateVendorColors')({ micode: '#112233', xiaomi: '#445566', mimoProvider: '#778899' });
  assert.equal(colors.mimo, '#112233');
  assert.equal(colors.xiaomi, '#445566');
  assert.equal(colors.mimoProvider, '#778899');
  assert.equal(colors.micode, undefined);
  assert.equal(mainFunction('migrateVendorColors')({ micode: '#111111', mimo: '#222222' }).mimo, '#222222');
});

test('persisted MiMo snapshots prefer canonical fields and do not duplicate an aliased session', () => {
  const raw = period([['micode','same',50]]);
  raw.clients.micode = 50;
  raw.clientModels.micode = { gpt: 50 };
  raw.sessions['micode:same'] = { ...raw.sessions['mimo:same'], client: 'micode' };
  const normalized = normalizePeriod(raw);
  assert.equal(normalized.totalTokens, 50);
  assert.equal(normalized.clients.mimo, 50);
  assert.equal(normalized.clients.micode, undefined);
  assert.equal(Object.keys(normalized.sessions).length, 1);
  assert.equal(normalized.sessions['mimo:same'].totalTokens, 50);
  assert.deepEqual(normalizePeriod(normalized), normalized);
});

test('old daily/monthly MiMo history reads and merges canonically without touching totals', () => {
  const old = { daily: [{ date: '2026-10-18', tokens: 50, perClient: { micode: { tokens: 50 } } }], monthly: [{ month: '2026-10', tokens: 50, perClient: { micode: { tokens: 50 } } }], summary: { totalTokens: 50 } };
  const canonical = coerceHistory(old);
  assert.equal(canonical.daily[0].perClient.mimo.tokens, 50);
  assert.equal(canonical.monthly[0].perClient.mimo.tokens, 50);
  assert.equal(old.daily[0].perClient.micode.tokens, 50);
  const both = mergeHistories([old, canonical], { todayKey: '2026-10-19' });
  assert.equal(both.monthly[0].perClient.mimo.tokens, 100);
  assert.equal(both.summary.totalTokens, 100, 'two separate devices still add normally');
});

test('daily archives preserve merged-era Pi and stamp generation 2 even when only Pi is observed first', () => {
  const legacy = { version: 1, days: { '2026-10-18': { date: '2026-10-18', observations: [{ client: 'pi', modelId: 'gpt', tokens: 100, cost: 1, messages: 2 }] } } };
  const before = structuredClone(legacy);
  let archive = daily.captureDailyHistoryArchive(legacy, graph('2026-10-18', [['pi',60],['omp',40]]), { todayKey: '2026-10-19' });
  assert.equal(archive.days['2026-10-18'].clientIdentityGeneration, undefined);
  assert.equal(Object.values(archive.days['2026-10-18'].observations)[0].tokens, 100);
  archive = daily.captureDailyHistoryArchive(archive, graph('2026-10-19', [['pi',20]]), { todayKey: '2026-10-19' });
  assert.equal(archive.days['2026-10-19'].clientIdentityGeneration, CLIENT_IDENTITY_GENERATION);
  archive = daily.captureDailyHistoryArchive(archive, graph('2026-10-19', [['pi',20],['omp',30]]), { todayKey: '2026-10-19' });
  const restored = normalizeHistory(parseGraphResult(daily.graphFromDailyHistoryArchive([], archive)), { todayKey: '2026-10-19' });
  assert.equal(restored.monthly[0].tokens, 150);
  assert.equal(restored.summary.totalTokens, 150);
  assert.equal(restored.daily.find(row => row.date === '2026-10-19').perClient.omp.tokens, 30);
  assert.deepEqual(legacy, before);
  assert.equal(isPreSplitEntry({ clientIdentityGeneration: 2 }), false);
});

test('merged client snapshots subtract only matching pair session identities and keep retained residue', () => {
  const old = clients.captureArchivedClientUsage({}, summary([['pi','p',60],['pi','o',40]]), 'pi', now);
  delete old.clients.pi.clientIdentityGeneration;
  const live = summary([['omp','o',55]]);
  const applied = clients.applyArchivedClientUsage(live, old, { activeClients: 'pi,omp', now });
  for (const name of ['today','month','allTime']) {
    assert.equal(applied[name].totalTokens, 115);
    assert.equal(applied[name].clients.pi, 60);
    assert.equal(applied[name].clients.omp, 55);
  }
  assert.ok(clients.pruneArchivedClientUsage(old, 'pi,omp').clients.pi);
  const unrelated = clients.applyArchivedClientUsage(summary([['codex','o',55]]), old, { activeClients: 'codex', now });
  assert.equal(unrelated.allTime.totalTokens, 155);
  const recaptured = clients.captureArchivedClientUsage(old, summary([['pi','p',65]]), 'pi', now);
  assert.equal(recaptured.clients.pi.periods.allTime.totalTokens, 105);
  assert.equal(recaptured.clients.pi.clientIdentityGeneration, undefined);
  assert.equal(clients.applyArchivedClientUsage(live, recaptured, { activeClients: 'omp', now }).allTime.totalTokens, 120);
});

test('aggregate-only merged snapshots are conservative, have no invented sessions, and generation 2 Pi is independent', () => {
  const old = clients.captureArchivedClientUsage({}, summary([['pi','p',100]]), 'pi', now);
  for (const p of Object.values(old.clients.pi.periods)) p.sessions = {};
  delete old.clients.pi.clientIdentityGeneration;
  const applied = clients.applyArchivedClientUsage(summary([['omp','o',40]]), old, { activeClients: 'omp', now });
  assert.equal(applied.allTime.totalTokens, 100);
  assert.equal(applied.allTime.clients.pi, 60);
  assert.equal(Object.keys(applied.allTime.sessions).length, 1);
  assert.equal(clients.applyArchivedClientUsage(summary([['omp','o',120]]), old, { activeClients: 'omp', now }).allTime.totalTokens, 120);
  old.clients.pi.clientIdentityGeneration = 2;
  assert.equal(clients.applyArchivedClientUsage(summary([['omp','o',40]]), old, { activeClients: 'omp', now }).allTime.totalTokens, 140);
});

test('session archive split replay deduplicates live and archived OMP irrespective of insertion order', () => {
  const pi = sessions.captureSessionUsageArchive({}, summary([['pi','shared',40],['pi','retained',60]]), now);
  const live = summary([['omp','shared',55]]);
  assert.equal(sessions.applySessionUsageArchive(live, pi, { now }).allTime.totalTokens, 115);
  const omp = sessions.captureSessionUsageArchive({}, summary([['omp','shared',55]]), now);
  for (const combined of [{ ...pi.sessions, ...omp.sessions }, { ...omp.sessions, ...pi.sessions }]) {
    const applied = sessions.applySessionUsageArchive(summary([]), { version: 1, sessions: combined }, { now });
    assert.equal(applied.allTime.totalTokens, 115);
  }
});

test('existing SQLite archive reads micode keys canonically, prefers canonical rows and keeps prune semantics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-p1-2-identity-'));
  const options = { databasePath: path.join(dir, 'sessions.sqlite'), legacyPath: path.join(dir, 'absent.json') };
  let store = createSessionUsageArchiveStore(options);
  store.capture(summary([['mimo','same',75]]), now);
  store.close();
  const db = new DatabaseSync(options.databasePath);
  const entry = sessions.captureSessionUsageArchive({}, summary([['micode','same',50]]), now).sessions['mimo:same'];
  entry.client = 'micode';
  for (const row of Object.values(entry.periods)) row.client = 'micode';
  db.prepare('INSERT INTO sessions(session_key, entry_json, revision) VALUES (?, ?, ?)').run('micode:same', JSON.stringify(entry), 0);
  db.close();
  store = createSessionUsageArchiveStore(options);
  const archive = store.read(now);
  assert.deepEqual(Object.keys(archive.sessions), ['mimo:same']);
  assert.equal(archive.sessions['mimo:same'].periods.allTime.totalTokens, 75);
  store.close();
  const snapshot = readSessionUsageArchiveSnapshot(options);
  assert.deepEqual(Object.keys(snapshot.sessions), ['mimo:same']);
  assert.equal(snapshot.sessions['mimo:same'].periods.allTime.totalTokens, 75);
  // Retain this synthetic database fixture; never touch user archive paths.
});

test('mixed-version hub records normalize MiMo locally and keep merged Pi per device without cross-device inference', () => {
  const old = normalizeDeviceRecord({ ...summary([['micode','old',100],['pi','merged',70]]), deviceId: 'old', hostname: 'old', platform: 'linux' });
  const updated = normalizeDeviceRecord({ ...summary([['mimo','new',150],['pi','p',30],['omp','o',40]]), deviceId: 'old', hostname: 'old', platform: 'linux' });
  const replaced = mergeDeviceRecord(old, updated);
  assert.equal(replaced.periods.allTime.clients.mimo, 150);
  const other = normalizeDeviceRecord({ ...summary([['micode','other',100],['pi','merged',70]]), deviceId: 'other', hostname: 'other', platform: 'linux' });
  const combined = aggregateDevices([replaced, other], { now: now.getTime() });
  assert.equal(combined.periods.allTime.clients.mimo, 250);
  assert.equal(combined.periods.allTime.clients.micode, undefined);
  assert.equal(combined.periods.allTime.clients.pi, 100);
  assert.equal(combined.periods.allTime.clients.omp, 40);
  assert.equal(combined.periods.allTime.totalTokens, 390);
});


test('MiMo daily and frozen client archives read legacy aliases idempotently without duplicating canonical usage', () => {
  const observations = [
    { client: 'micode', modelId: 'gpt', tokens: 50, cost: 0.5, messages: 1 },
    { client: 'mimo', modelId: 'gpt', tokens: 50, cost: 0.5, messages: 1 }
  ];
  const archive = daily.normalizeDailyHistoryArchive({ days: { '2026-10-18': { observations } } });
  assert.equal(Object.values(archive.days['2026-10-18'].observations).length, 1);
  assert.equal(Object.values(archive.days['2026-10-18'].observations)[0].tokens, 50);
  assert.deepEqual(daily.normalizeDailyHistoryArchive(archive), archive);
  const captured = clients.captureArchivedClientUsage({}, summary([['mimo','one',50]]), 'mimo', now);
  const alias = structuredClone(captured.clients.mimo);
  alias.client = 'micode';
  const frozen = clients.normalizeArchivedClientUsage({ clients: { micode: alias, mimo: captured.clients.mimo } });
  assert.deepEqual(Object.keys(frozen.clients), ['mimo']);
  assert.equal(clients.applyArchivedClientUsage(summary([]), frozen, { now }).allTime.totalTokens, 50);
});


test('MiMo snapshot component maps follow the renamed client even when only the counters retain an old key', () => {
  const raw = { totalTokens: 50, cacheReadTokens: 20, outputTokens: 10, clients: { mimo: 50 }, clientCacheReads: { micode: 20 }, clientOutputs: { micode: 10 }, clientModels: { micode: { gpt: 50 } }, capabilities: { tokenComponents: true } };
  const normalized = normalizePeriod(raw);
  assert.equal(normalized.clients.mimo, 50);
  assert.equal(normalized.clientCacheReads.mimo, 20);
  assert.equal(normalized.clientOutputs.mimo, 10);
  assert.equal(normalized.clientModels.mimo.gpt, 50);
});

test('independent Kilo native sub-source counters remain additive through identity normalization', () => {
  const normalized = normalizePeriod({ totalTokens: 100, clients: { kilo: 60, kilocode: 40 }, clientModels: { kilo: { gpt: 60 }, kilocode: { gpt: 40 } } });
  assert.equal(normalized.clients.kilo, 100);
  assert.equal(normalized.clientModels.kilo.gpt, 100);
  const history = coerceHistory({ daily: [{ date: '2026-10-18', tokens: 100, perClient: { kilo: { tokens: 60 }, kilocode: { tokens: 40 } } }] });
  assert.equal(history.daily[0].perClient.kilo.tokens, 100);
});


test('client identity maps do not write untrusted map names onto Object.prototype', () => {
  const raw = JSON.parse('{"totalTokens":1,"clients":{"__proto__":1},"clientModels":{"__proto__":{"identitySentinel":1}}}');
  const normalized = normalizePeriod(raw);
  assert.equal(Object.prototype.identitysentinel, undefined);
  assert.equal(Object.hasOwn(normalized.clientModels, '__proto__'), false);
});
