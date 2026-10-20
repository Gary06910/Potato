'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  captureDailyHistoryArchive,
  captureLiveDailyHistory,
  graphFromDailyHistoryArchive,
  normalizeDailyHistoryArchive,
} = require('../../src/shared/dailyHistoryArchive');

function graph(date, clients, extra = {}) {
  return {
    contributions: [{ date, activeTimeMs: extra.activeTimeMs || 0, clients }],
    ...(extra.timeMetrics ? { timeMetrics: extra.timeMetrics } : {})
  };
}

function client(clientId, modelId, tokens, cost, messages, extra = {}) {
  return {
    client: clientId,
    modelId,
    ...(extra.providerId ? { providerId: extra.providerId } : {}),
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: extra.reasoning || 0 },
    cost,
    messages
  };
}





function livePeriod(totalTokens, costUsd = 0) {
  return {
    totalTokens,
    costUsd,
    clients: { claude: totalTokens },
    clientCosts: { claude: costUsd },
    models: { opus: totalTokens },
    modelCosts: { opus: costUsd },
    clientModels: { claude: { opus: totalTokens } },
    clientModelCosts: { claude: { opus: costUsd } }
  };
}

test('fresh pricing replaces stale live costs in either direction, including zero, without losing archive-only usage', () => {
  for (const cost of [0, 0.01, 9]) {
    const date = '2026-08-18';
    const archivedOnly = '2026-08-17';
    const previous = captureLiveDailyHistory({}, livePeriod(100, 2), { todayKey: date });
    previous.days[archivedOnly] = { date: archivedOnly, observations: [{ client: 'claude', modelId: 'opus', tokens: 50, cost: 5 }] };
    const incoming = graph(date, [client('claude', 'opus', 100, cost, 1)]);
    const options = { todayKey: date, reprice: true };
    const next = captureDailyHistoryArchive(previous, incoming, options);
    assert.equal(Object.values(next.liveDays[date].observations)[0].cost, cost);
    const visible = graphFromDailyHistoryArchive(incoming, next, options);
    const day = visible.contributions.find(row => row.date === date);
    assert.equal(day.clients[0].cost, cost);
    assert.equal(day.clients[0].tokens.input, 100);
    assert.equal(visible.contributions.find(row => row.date === archivedOnly).clients[0].cost, 5);
    assert.equal(graphFromDailyHistoryArchive([], next, options).contributions.find(row => row.date === date).clients[0].cost, cost);
  }
});

test('archive pricing revisions reconcile legacy prices without overrides and preserve stamps after empty scans', () => {
  const date = '2026-08-18';
  const previous = captureLiveDailyHistory({}, livePeriod(100, 2), { todayKey: date });
  const zeroGraph = graph(date, [client('claude', 'opus', 100, 0, 1)]);
  const first = captureDailyHistoryArchive(previous, zeroGraph, { todayKey: date, pricingRevision: 'first', customPricingActive: false });
  assert.equal(Object.values(first.liveDays[date].observations)[0].cost, 0, 'unversioned live prices are legacy even without custom overrides');
  assert.equal(first.pricingRevision, 'first');
  const failed = captureDailyHistoryArchive(first, [], { todayKey: date, pricingRevision: 'second', customPricingActive: true });
  assert.equal(failed.pricingRevision, 'first', 'an empty graph cannot confirm a new price revision');
  const repriced = captureDailyHistoryArchive(failed, zeroGraph, { todayKey: date, pricingRevision: 'second', customPricingActive: true });
  assert.equal(Object.values(repriced.liveDays[date].observations)[0].cost, 0);
  assert.equal(repriced.pricingRevision, 'second');
});

test('legacy live metadata cannot override corrected binary graph prices, including zero', () => {
  const date = '2026-08-18';
  for (const cost of [0, 1]) {
    const previous = { liveDays: { [date]: { date, observations: [
      { client: 'claude', modelId: 'opus', tokens: 100, cost: 2, tokenComponentsAvailable: true, outputTokens: 20 },
      { client: 'claude', modelId: 'deleted', tokens: 50, cost: 3, tokenComponentsAvailable: true }
    ] } } };
    const fresh = graph(date, [client('claude', 'opus', 100, cost, 1)]);
    const options = { todayKey: date, pricingRevision: 'new-binary', customPricingActive: false };
    const next = captureDailyHistoryArchive(previous, fresh, options);
    const live = Object.values(next.liveDays[date].observations);
    assert.equal(live.find(row => row.modelId === 'opus').cost, cost);
    assert.equal(live.find(row => row.modelId === 'deleted').cost, 3);
    const displayed = graphFromDailyHistoryArchive(fresh, next, options).contributions[0].clients;
    assert.equal(displayed.find(row => row.modelId === 'opus').cost, cost);
    assert.equal(displayed.find(row => row.modelId === 'deleted').cost, 3);
    const returned = captureDailyHistoryArchive(JSON.parse(JSON.stringify(next)), graph(date, [client('claude', 'deleted', 50, 0, 1)]), options);
    assert.equal(Object.values(returned.liveDays[date].observations).find(row => row.modelId === 'deleted').cost, 0);
  }
});

test('a source returning after a partial pricing scan still replaces its stale live price', () => {
  const date = '2026-08-18';
  const previous = { pricingRevision: 'old', liveDays: { [date]: { date, observations: [
    { client: 'claude', modelId: 'opus', tokens: 100, cost: 2 },
    { client: 'claude', modelId: 'sonnet', tokens: 50, cost: 3 }
  ] } } };
  const options = { todayKey: date, pricingRevision: 'new', customPricingActive: true };
  const partial = captureDailyHistoryArchive(previous, graph(date, [client('claude', 'opus', 100, 1, 1)]), options);
  assert.equal(partial.pricingRevision, 'new');
  const missing = Object.values(partial.liveDays[date].observations).find(row => row.modelId === 'sonnet');
  assert.equal(missing.pricingRevision, 'old');
  assert.equal(missing.cost, 3);
  const returnedGraph = graph(date, [client('claude', 'opus', 100, 1, 1), client('claude', 'sonnet', 50, 0, 1)]);
  const returned = captureDailyHistoryArchive(JSON.parse(JSON.stringify(partial)), returnedGraph, options);
  const observation = Object.values(returned.liveDays[date].observations).find(row => row.modelId === 'sonnet');
  assert.equal(observation.cost, 0);
  assert.equal(observation.pricingRevision, 'new');
  assert.equal(graphFromDailyHistoryArchive([], returned, options).contributions[0].clients.find(row => row.modelId === 'sonnet').cost, 0);
});

test('an equal live snapshot persists its current pricing revision', () => {
  const date = '2026-08-18';
  const old = captureLiveDailyHistory({}, livePeriod(100, 2), { todayKey: date, pricingRevision: 'old' });
  const next = captureLiveDailyHistory(old, livePeriod(100, 2), { todayKey: date, pricingRevision: 'new' });
  assert.equal(Object.values(normalizeDailyHistoryArchive(next).liveDays[date].observations)[0].pricingRevision, 'new');
});

test('repricing an equal live snapshot keeps richer retained token components', () => {
  const date = '2026-08-18';
  const previous = { liveDays: { [date]: { date, observations: [
    { client: 'claude', modelId: 'opus', tokens: 100, cost: 2, pricingRevision: 'old',
      tokenComponentsAvailable: true, outputTokens: 20, cacheWriteTokens: 30 }
  ] } } };
  const next = captureLiveDailyHistory(previous, livePeriod(100, 0), { todayKey: date, pricingRevision: 'new' });
  const [observation] = Object.values(next.liveDays[date].observations);
  assert.equal(observation.cost, 0);
  assert.equal(observation.pricingRevision, 'new');
  assert.equal(observation.outputTokens, 20);
  assert.equal(observation.cacheWriteTokens, 30);
  assert.equal(observation.tokenComponentsAvailable, true);
});

for (const revision of ['same', 'new']) {
  test(`equal-token model reattribution keeps incoming identities with ${revision} pricing revision`, () => {
    const date = '2026-08-18';
    const previous = { liveDays: { [date]: { date, observations: [
      { client: 'claude', modelId: 'opus', tokens: 60, cost: 2, pricingRevision: 'same', tokenComponentsAvailable: true, outputTokens: 20 },
      { client: 'claude', modelId: 'haiku', tokens: 40, cost: 1, pricingRevision: 'same', tokenComponentsAvailable: true, cacheWriteTokens: 10 }
    ] } } };
    const period = {
      totalTokens: 100, costUsd: 3, clients: { claude: 100 }, clientCosts: { claude: 3 },
      models: { sonnet: 60, haiku: 40 }, modelCosts: { sonnet: 2, haiku: 1 },
      clientModels: { claude: { sonnet: 60, haiku: 40 } }, clientModelCosts: { claude: { sonnet: 2, haiku: 1 } }
    };
    const next = captureLiveDailyHistory(previous, period, { todayKey: date, pricingRevision: revision });
    const rows = Object.values(normalizeDailyHistoryArchive(JSON.parse(JSON.stringify(next))).liveDays[date].observations);
    assert.deepEqual(rows.map(row => row.modelId).sort(), ['haiku', 'sonnet']);
    const sonnet = rows.find(row => row.modelId === 'sonnet');
    assert.equal(sonnet.tokens, 60);
    assert.equal(sonnet.cost, 2);
    assert.equal(sonnet.outputTokens, undefined, 'components from a different model are not transferred');
    assert.equal(rows.find(row => row.modelId === 'haiku').cacheWriteTokens, 10);
    assert.ok(rows.every(row => row.pricingRevision === revision));
  });
}
