'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePeriod, extractUsageFromTokscale, emptyPeriod, aggregateDevices } = require('../../src/shared/usage');
const { captureSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/sessionUsageArchive');
const { captureArchivedClientUsage, applyArchivedClientUsage } = require('../../src/shared/clientUsageArchive');
const { syncPayload } = require('../../src/shared/syncPayload');
const AT = new Date('2026-10-20T06:00:00Z');
const dto = period => ({ updatedAt: AT.toISOString(), today: period, month: period, allTime: period });
for (const known of [false, true]) {
  test('session and frozen client archives preserve component evidence; known=' + known, () => {
    const period = normalizePeriod({ totalTokens: 100, clients: { claude: 100 },
      sessions: { 'claude:s': { client: 'claude', sessionId: 's', totalTokens: 100,
        ...(known ? { inputTokens: 70, outputTokens: 20, cacheReadTokens: 10 } : {}) } } });
    const archived = captureSessionUsageArchive({}, dto(period), AT);
    const restored = applySessionUsageArchive(dto(emptyPeriod()), archived, { now: AT });
    const row = restored.allTime.sessions['claude:s'];
    assert.equal(row.tokenComponentsAvailable, known);
    assert.equal(row.unclassifiedTokens, known ? 0 : 100);
    assert.equal(restored.allTime.unclassifiedTokens, known ? 0 : 100);
    const frozen = captureArchivedClientUsage({}, dto(period), 'claude', AT);
    const unfrozen = applyArchivedClientUsage(dto(emptyPeriod()), frozen, { now: AT, activeClients: '' });
    assert.equal(unfrozen.allTime.unclassifiedTokens, known ? 0 : 100);
  });
}
test('a native aggregate row without components remains unclassified on the wire', () => {
  const p = extractUsageFromTokscale({ entries: [{ client: 'claude', sessionId: 's', model: 'm', totalTokens: 100 }] });
  assert.equal(p.unclassifiedTokens, 100);
  assert.equal(p.capabilities.tokenComponents, false);
  assert.equal(p.sessions['claude:s'].unclassifiedTokens, 100);
  const wire = syncPayload(dto(p));
  const merged = aggregateDevices([{ deviceId: 'old', ...wire }], 3600000, AT.getTime());
  assert.equal(merged.periods.allTime.unclassifiedTokens, 100);
});
test('impossible component counters are explicitly invalid, with totals retained and no invented input', () => {
  const p = extractUsageFromTokscale({ entries: [{ client: 'claude', sessionId: 's', model: 'm', totalTokens: 10, input: 20, output: 3 }] });
  assert.equal(p.totalTokens, 10);
  assert.equal(p.tokenComponentsInvalid, true);
  assert.equal(p.unclassifiedTokens, 10);
  assert.equal(p.sessions['claude:s'].tokenComponentsInvalid, true);
  assert.equal(p.sessions['claude:s'].inputTokens, 0);
  const normalized = normalizePeriod({ totalTokens: 10, outputTokens: 20 });
  assert.equal(normalized.tokenComponentsInvalid, true);
  assert.equal(normalized.outputTokens, 0);
  assert.equal(normalized.unclassifiedTokens, 10);
});
test('session throughput raw sums survive archive replay, never derived from session wall span', () => {
  const p = extractUsageFromTokscale({ entries: [{ client: 'claude', sessionId: 's', model: 'm', input: 80, output: 20,
    performance: { totalDurationMs: 1000, timedTokens: 100, timedOutputTokens: 12 } }] });
  const archive = captureSessionUsageArchive({}, dto(p), AT);
  const restored = applySessionUsageArchive(dto(emptyPeriod()), archive, { now: AT });
  assert.equal(restored.allTime.timedTokens, 100);
  assert.equal(restored.allTime.timedOutputTokens, 12);
  assert.equal(restored.allTime.timedDurationMs, 1000);
  assert.equal(restored.allTime.sessions['claude:s'].timedOutputTokens, 12);
});
