'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { PERIODS, normalizePeriod } = require('./usage');
const { splitClientIdFor } = require('./clientIdentitySplits');
const { isLegacyCursorEntry, legacyCursorLookup, supersedingCursorSessionId } = require('./providers/cursor/sessionGuard');
const {
  cloneJson,
  hasSummaryPeriod,
  localDay,
  localMonth,
  numberValue,
  periodFor,
  targetPeriod,
  toDate
} = require('./archiveHelpers');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const { filterReasonixSyntheticSessions, isReasonixSyntheticSession } = require('./providers/reasonix/sessionGuard');

function sessionUsageArchiveDate(deviceRecord, fallback = new Date()) {
  const collectedAt = new Date(deviceRecord?.updatedAt || '');
  return Number.isNaN(collectedAt.getTime()) ? toDate(fallback) : collectedAt;
}

function sessionKey(client, sessionId) {
  const normalized = normalizePeriod({
    sessions: {
      candidate: { client, sessionId, totalTokens: 1 }
    }
  });
  const session = Object.values(normalized.sessions)[0];
  return session ? `${session.client}:${session.sessionId}` : null;
}

function sameJson(left, right) {
  return isDeepStrictEqual(left || null, right || null);
}

function normalizedSessionFrom(value, fallbackKey) {
  if (isReasonixSyntheticSession(value, fallbackKey)) return null;
  const period = normalizePeriod({ sessions: { [fallbackKey || 'session']: value } });
  return Object.values(period.sessions)[0] || null;
}

function hasSessionUsage(session) {
  return numberValue(session?.totalTokens) > 0 || numberValue(session?.costUsd) > 0;
}

function normalizeSessionUsageArchive(value) {
  const source = value?.sessions && typeof value.sessions === 'object' ? value.sessions : value;
  const normalized = { version: 1, sessions: {} };
  if (!source || typeof source !== 'object') return normalized;

  for (const [rawKey, rawEntry] of Object.entries(source)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    if (isReasonixSyntheticSession(rawEntry, rawKey)) continue;
    const rawPeriods = rawEntry.periods && typeof rawEntry.periods === 'object'
      ? rawEntry.periods
      : rawEntry;
    const entry = {
      client: '',
      sessionId: '',
      capturedAt: toDate(rawEntry.capturedAt).toISOString(),
      day: String(rawEntry.day || localDay(rawEntry.capturedAt)),
      month: String(rawEntry.month || localMonth(rawEntry.capturedAt)),
      ...(rawEntry.clientIdentityGeneration !== undefined ? { clientIdentityGeneration: numberValue(rawEntry.clientIdentityGeneration) } : {}),
      periodWindows: {},
      periods: {}
    };

    for (const periodName of PERIODS) {
      const session = normalizedSessionFrom(rawPeriods?.[periodName], rawKey);
      if (!session || isReasonixSyntheticSession(session, rawKey)
        || !hasSessionUsage(session) && rawPeriods?.[periodName]?.totalTokens !== 0) continue;
      delete session.liveActivity;
      delete session.waitingForInput;
      const key = sessionKey(session.client, session.sessionId);
      if (!key) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.periods[periodName] = session;
      const rawWindow = rawEntry.periodWindows?.[periodName] || {};
      entry.periodWindows[periodName] = {
        capturedAt: toDate(rawWindow.capturedAt || rawEntry.capturedAt).toISOString()
      };
      if (periodName === 'today') entry.periodWindows[periodName].day = String(rawWindow.day || rawEntry.day || localDay(rawEntry.capturedAt));
      if (periodName === 'month') entry.periodWindows[periodName].month = String(rawWindow.month || rawEntry.month || localMonth(rawEntry.capturedAt));
    }

    if (!entry.client || !entry.sessionId || Object.keys(entry.periods).length === 0) continue;
    const supersededBy = sessionKey('cursor', String(rawEntry.supersededBy || '').replace(/^cursor:/, ''));
    if (rawEntry.supersededBy && supersededBy && isLegacyCursorEntry(entry)) entry.supersededBy = supersededBy;
    const key = `${entry.client}:${entry.sessionId}`;
    const previous = normalized.sessions[key];
    if (!previous) normalized.sessions[key] = entry;
    else {
      // A released client alias may share its ID with the renamed client.
      // Keep whole period observations, including a newer explicit zero.
      for (const name of Object.keys(entry.periods)) {
        const before = Date.parse(previous.periodWindows[name]?.capturedAt || previous.capturedAt) || 0;
        const after = Date.parse(entry.periodWindows[name]?.capturedAt || entry.capturedAt) || 0;
        if (previous.periods[name] && (before > after || before === after && rawKey !== key)) continue;
        previous.periods[name] = entry.periods[name];
        previous.periodWindows[name] = entry.periodWindows[name];
      }
      if (entry.capturedAt > previous.capturedAt) {
        previous.capturedAt = entry.capturedAt;
        previous.day = entry.day;
        previous.month = entry.month;
      }
    }
  }

  return normalized;
}

// Legacy and canonical SQLite rows may coexist. Merge them by canonical
// session identity and per-period capture provenance, without changing schema.
const canonicalArchiveRows = new WeakMap();

function mergeSessionArchiveEntry(archive, entry, sourceKey = '') {
  const key = `${entry.client}:${entry.sessionId}`;
  let canonical = canonicalArchiveRows.get(archive);
  if (!canonical) { canonical = new Set(); canonicalArchiveRows.set(archive, canonical); }
  if (sourceKey === key) {
    canonical.add(key);
    archive.sessions[key] = entry;
    return;
  }
  if (canonical.has(key)) return;
  const previous = archive.sessions[key];
  if (!previous) { archive.sessions[key] = entry; return; }
  const merged = { ...previous, periods: { ...previous.periods }, periodWindows: { ...previous.periodWindows } };
  for (const periodName of PERIODS) {
    const session = entry.periods?.[periodName];
    if (!session) continue;
    const before = previous.periodWindows?.[periodName]?.capturedAt || previous.capturedAt;
    const after = entry.periodWindows?.[periodName]?.capturedAt || entry.capturedAt;
    if (previous.periods?.[periodName] && Date.parse(before) > Date.parse(after)) continue;
    merged.periods[periodName] = session;
    merged.periodWindows[periodName] = entry.periodWindows?.[periodName] || {};
  }
  if (Date.parse(entry.capturedAt) >= Date.parse(previous.capturedAt)) Object.assign(merged, { capturedAt: entry.capturedAt, day: entry.day, month: entry.month });
  archive.sessions[key] = merged;
}

function canonicalSessionUsageArchive(value) {
  if (value?.version === 1 && value.sessions && typeof value.sessions === 'object') return value;
  return normalizeSessionUsageArchive(value);
}

function pruneExpiredSessionUsagePeriods(archive, capturedAt, changedKeys) {
  const day = localDay(capturedAt);
  const month = localMonth(capturedAt);
  // Collector snapshots can finish out of order across processes. A stale
  // snapshot must never move the pruning frontier backwards.
  const pruneDay = !archive.prunedDay || archive.prunedDay < day;
  const pruneMonth = !archive.prunedMonth || archive.prunedMonth < month;
  if (!pruneDay && !pruneMonth) return;

  for (const [key, entry] of Object.entries(archive.sessions)) {
    let changed = false;
    entry.periodWindows = entry.periodWindows || {};
    const todayWindow = entry.periodWindows?.today;
    const retainedDay = todayWindow?.day || entry.day;
    if (pruneDay && entry.periods?.today && (!retainedDay || retainedDay < day)) {
      delete entry.periods.today;
      delete entry.periodWindows.today;
      changed = true;
    }
    const monthWindow = entry.periodWindows?.month;
    const retainedMonth = monthWindow?.month || entry.month;
    if (pruneMonth && entry.periods?.month && (!retainedMonth || retainedMonth < month)) {
      delete entry.periods.month;
      delete entry.periodWindows.month;
      changed = true;
    }
    if (changed) changedKeys.add(key);
  }
  if (pruneDay) archive.prunedDay = day;
  if (pruneMonth) archive.prunedMonth = month;
}

// The caller owns the canonical in-memory archive. Updating it in place keeps a
// watch tick proportional to the sessions in that tick instead of cloning and
// normalizing every retained session. Persistence receives only changed keys.
function updateSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date(), options = {}) {
  const archive = canonicalSessionUsageArchive(existingArchive);
  const changedKeys = new Set();
  const captureDate = toDate(capturedAt);
  const captureTime = captureDate.getTime();
  pruneExpiredSessionUsagePeriods(archive, captureDate, changedKeys);
  if (!deviceRecord || typeof deviceRecord !== 'object') return { archive, changedKeys };

  const capturedAtIso = captureDate.toISOString();
  const day = localDay(captureDate);
  const month = localMonth(captureDate);
  const sourceArchivedKeys = new Set(deviceRecord.codexLocalSessionKeys || []);
  // This marks completed App report requests, not parser completeness. A
  // Today-only tick and a progressive preview cannot clear other observations.
  const fullScan = deviceRecord.sessionUsageArchiveFullScan === true
    && PERIODS.every(name => {
      const value = deviceRecord.periods?.[name] || deviceRecord[name];
      return value && typeof value === 'object' && value.sessions && typeof value.sessions === 'object';
    });
  const allTime = options.canonicalSummary === true
    ? (deviceRecord.periods?.allTime || deviceRecord.allTime) : fullScan && periodFor(deviceRecord, 'allTime');
  const liveKeys = fullScan ? new Set(Object.values(allTime.sessions || {})
    .map(session => sessionKey(session.client, session.sessionId)).filter(Boolean)) : null;
  const watchToday = deviceRecord.sessionUsageArchiveFullScan === false
    ? (options.canonicalSummary === true
      ? deviceRecord.periods?.today || deviceRecord.today || {}
      : periodFor(deviceRecord, 'today')) : null;
  for (const periodName of PERIODS) {
    if (periodName === 'today' && archive.prunedDay && day < archive.prunedDay) continue;
    if (periodName === 'month' && archive.prunedMonth && month < archive.prunedMonth) continue;
    const rawPeriod = deviceRecord?.periods?.[periodName] || deviceRecord?.[periodName];
    const period = options.canonicalSummary === true
      ? (rawPeriod && typeof rawPeriod === 'object' ? rawPeriod : { sessions: {} })
      : periodFor(deviceRecord, periodName);
    const observations = Object.values(period.sessions || {});
    if (liveKeys && periodName !== 'allTime') {
      for (const [key, entry] of Object.entries(archive.sessions)) {
        const identity = sessionKey(entry.client, entry.sessionId);
        if (!entry.periods?.[periodName] || !liveKeys.has(identity)
          || period.sessions?.[identity] || sourceArchivedKeys.has(key)) continue;
        observations.push({ client: entry.client, sessionId: entry.sessionId, totalTokens: 0, costUsd: 0 });
      }
    }
    for (const session of observations) {
      const hasUsage = hasSessionUsage(session);
      if (isReasonixSyntheticSession(session) || !hasUsage && session.totalTokens !== 0) continue;
      const archiveKey = sessionKey(session.client, session.sessionId);
      if (!archiveKey) continue;
      if (sourceArchivedKeys.has(archiveKey)) continue;
      // An empty Today scan can leave zero rows in broader anchor deltas.
      // Only a still-identified Today row proves a watch zero was observed.
      if (watchToday && periodName !== 'today' && !hasUsage && !watchToday.sessions?.[archiveKey]) continue;
      const entry = archive.sessions[archiveKey] || {
        client: session.client,
        sessionId: session.sessionId,
        capturedAt: capturedAtIso,
        day,
        month,
        periodWindows: {},
        periods: {}
      };
      const window = entry.periodWindows?.[periodName] || {};
      const retainedCaptureTime = Date.parse(window.capturedAt || '');
      // SQLite serializes commits, not collection time. Keep the newest event
      // for each period when two collectors finish in the opposite order.
      if (Number.isFinite(retainedCaptureTime) && retainedCaptureTime > captureTime) continue;
      const sameWindow = periodName === 'today'
        ? window.day === day
        : periodName === 'month'
          ? window.month === month
          : true;
      // Every tick carries every session of all three periods, and nearly all of
      // them are unchanged, so compare before copying. A session equal to the
      // stored copy would also be equal after the round-trip; one that differs
      // only in what the round-trip drops is caught by the second comparison.
      if (sameWindow && sameJson(entry.periods[periodName], session)) continue;
      const nextSession = cloneJson(session);
      delete nextSession.liveActivity;
      delete nextSession.waitingForInput;
      if (sameWindow && sameJson(entry.periods[periodName], nextSession)) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.capturedAt = capturedAtIso;
      entry.day = day;
      entry.month = month;
      entry.periods[periodName] = nextSession;
      entry.periodWindows = entry.periodWindows || {};
      entry.periodWindows[periodName] = { capturedAt: capturedAtIso };
      if (periodName === 'today') entry.periodWindows[periodName].day = day;
      if (periodName === 'month') entry.periodWindows[periodName].month = month;
      archive.sessions[archiveKey] = entry;
      changedKeys.add(archiveKey);
    }
  }

  if (options.cursorUsageEvents) linkLegacyCursorEvents(archive, changedKeys, options.cursorUsageEvents);
  return { archive, changedKeys };
}

function linkLegacyCursorEvents(archive, changedKeys, readCursorUsageEvents) {
  const pending = [];
  for (const [key, entry] of Object.entries(archive.sessions)) {
    if (entry.supersededBy || !isLegacyCursorEntry(entry)) continue;
    const lookup = legacyCursorLookup(entry);
    if (lookup) pending.push([key, entry, lookup]);
  }
  if (pending.length === 0) return;

  const usageEvents = readCursorUsageEvents();
  if (!usageEvents) return;
  for (const [key, entry, lookup] of pending) {
    const sessionId = supersedingCursorSessionId(lookup, usageEvents);
    if (!sessionId) continue;
    entry.supersededBy = sessionKey('cursor', sessionId);
    changedKeys.add(key);
  }
}

function captureSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date()) {
  const archive = normalizeSessionUsageArchive(existingArchive);
  return updateSessionUsageArchive(archive, deviceRecord, capturedAt).archive;
}

function addSessionBreakdown(period, session) {
  const client = session.client;
  const cacheRead = Math.max(0, Math.round(numberValue(session.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(session.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(session.outputTokens)));

  if (cacheRead > 0) period.clientCacheReads[client] = (period.clientCacheReads[client] || 0) + cacheRead;
  if (cacheWrite > 0) period.clientCacheWrites[client] = (period.clientCacheWrites[client] || 0) + cacheWrite;
  if (output > 0) period.clientOutputs[client] = (period.clientOutputs[client] || 0) + output;

  const modelTokens = Object.entries(session.models || {})
    .map(([model, tokens]) => [model, numberValue(tokens)])
    .filter(([, tokens]) => tokens > 0);
  const totalModelTokens = modelTokens.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (totalModelTokens === 0) return;
  if (modelTokens.length > 1) {
    for (const [model, tokens] of modelTokens) {
      period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + tokens;
    }
    period.capabilities.tokenComponents = false;
    return;
  }

  for (const [model, tokens] of modelTokens) {
    const cr = Math.min(tokens, cacheRead);
    const cw = Math.min(tokens - cr, cacheWrite);
    const ou = Math.min(tokens - cr - cw, output);
    if (cr > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + cr;
    if (cw > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + cw;
    if (ou > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + ou;
    const unclassified = Math.max(0, numberValue(session.unclassifiedTokens ?? tokens - cr - cw - ou));
    if (unclassified > 0) {
      period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + unclassified;
      period.capabilities.tokenComponents = false;
    }
  }
}

function addArchivedSession(period, session, archiveKey = null) {
  if (isReasonixSyntheticSession(session)) return;
  const key = archiveKey || sessionKey(session.client, session.sessionId);
  if (!key || period.sessions[key]) return;

  const archived = { ...cloneJson(session), archived: true };
  period.sessions[key] = archived;
  const tokens = Math.max(0, Math.round(numberValue(archived.totalTokens)));
  const cost = numberValue(archived.costUsd);
  const cacheRead = Math.max(0, Math.round(numberValue(archived.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(archived.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(archived.outputTokens)));

  period.totalTokens += tokens;
  period.costUsd += cost;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;
  period.timedTokens += numberValue(archived.timedTokens);
  period.timedOutputTokens += numberValue(archived.timedOutputTokens);
  period.timedDurationMs += numberValue(archived.timedDurationMs);
  if (numberValue(archived.timedDurationMs) > 0) {
    // Session archives carry output/duration, but no timed-total/model split.
    delete period.modelThroughput;
  }
  const unclassified = Math.max(0, numberValue(archived.unclassifiedTokens ?? tokens - cacheRead - cacheWrite - output));
  if (unclassified > 0) {
    period.unclassifiedTokens += unclassified;
    period.clientUnclassifiedTokens[archived.client] = (period.clientUnclassifiedTokens[archived.client] || 0) + unclassified;
    period.capabilities.tokenComponents = false;
  }
  if (tokens > 0) period.clients[archived.client] = (period.clients[archived.client] || 0) + tokens;
  if (cost > 0) period.clientCosts[archived.client] = (period.clientCosts[archived.client] || 0) + cost;

  for (const [model, modelTokens] of Object.entries(archived.models || {})) {
    const next = Math.max(0, Math.round(numberValue(modelTokens)));
    if (next <= 0) continue;
    period.models[model] = (period.models[model] || 0) + next;
    if (!period.clientModels[archived.client]) period.clientModels[archived.client] = {};
    period.clientModels[archived.client][model] = (period.clientModels[archived.client][model] || 0) + next;
  }
  for (const [model, modelCost] of Object.entries(archived.modelCosts || {})) {
    const next = numberValue(modelCost);
    if (next <= 0) continue;
    period.modelCosts[model] = (period.modelCosts[model] || 0) + next;
    if (!period.clientModelCosts[archived.client]) period.clientModelCosts[archived.client] = {};
    period.clientModelCosts[archived.client][model] = (period.clientModelCosts[archived.client][model] || 0) + next;
  }

  addSessionBreakdown(period, archived);
}

function isLiveUnderSplitId(period, entry, session) {
  const split = splitClientIdFor(session?.client);
  if (!split) return false;
  const sessionId = String(session?.sessionId || entry?.sessionId || '').trim();
  if (!sessionId) return false;
  return Boolean(period?.sessions?.[`${split}:${sessionId}`]);
}

function shouldApplyPeriod(periodName, entry, now) {
  const window = entry?.periodWindows?.[periodName] || {};
  if (periodName === 'today') return (window.day || entry.day) === localDay(now);
  if (periodName === 'month') return (window.month || entry.month) === localMonth(now);
  return periodName === 'allTime';
}

function applySessionUsageArchive(summary, archive, options = {}) {
  const normalizedArchive = options.canonical === true
    ? canonicalSessionUsageArchive(archive)
    : normalizeSessionUsageArchive(archive);
  const now = toDate(options.now);
  const next = options.mutate === true ? summary : cloneJson(summary);
  const periodContainer = next.periods && typeof next.periods === 'object' ? next.periods : next;
  for (const periodName of PERIODS) {
    const period = periodContainer?.[periodName];
    if (period && typeof period === 'object' && Object.prototype.hasOwnProperty.call(period, 'sessions')) {
      period.sessions = filterReasonixSyntheticSessions(period.sessions);
    }
  }
  const targetPeriods = new Map();
  const targetFor = (periodName) => {
    if (!targetPeriods.has(periodName)) {
      const period = options.canonicalSummary === true
        ? (next.periods && typeof next.periods === 'object' ? next.periods[periodName] : next[periodName])
        : targetPeriod(next, periodName);
      targetPeriods.set(periodName, period);
    }
    return targetPeriods.get(periodName);
  };

  // SQLite may still hold a released literal alias beside its canonical peer.
  // Pick one whole latest observation per period; never add the same ID twice.
  // Select zeros too, so a newer zero cannot resurrect an older alias's usage.
  const retainedRows = new Map();
  for (const [archiveKey, entry] of Object.entries(normalizedArchive.sessions)) {
    for (const periodName of PERIODS) {
      const session = entry.periods?.[periodName];
      if (!session || !shouldApplyPeriod(periodName, entry, now)) continue;
      // Same rule as the client archive: never create a period the summary does
      // not have. A progressive preview is marked partial by the periods it
      // omits, and a partial that looks complete loses the attribution fields
      // deviceState would otherwise carry forward.
      if (!hasSummaryPeriod(next, periodName)) continue;
      const period = targetFor(periodName);
      const key = sessionKey(session.client || entry.client, session.sessionId || entry.sessionId) || archiveKey;
      if (period.sessions[key]) continue;
      const selectionKey = `${periodName}:${key}`;
      const observedAt = Date.parse(entry.periodWindows?.[periodName]?.capturedAt || entry.capturedAt || '') || 0;
      const previous = retainedRows.get(selectionKey);
      if (previous && (previous.observedAt > observedAt
        || previous.observedAt === observedAt && previous.archiveKey === key)) continue;
      retainedRows.set(selectionKey, { period, key, entry, session, observedAt, archiveKey });
    }
  }
  const supersededRows = [];
  const mergedRows = [];
  for (const { period, key: archiveKey, entry, session } of retainedRows.values()) {
    if (!hasSessionUsage(session)) continue;
    // A row keyed under a merged id replays only after every other row: an
    // archived split-id copy of the same session is the same usage twice, and
    // the merged row can only see that overlap once the split row is already
    // in the period. Insertion order puts the older merged row first, so
    // deferring by identity is what makes the replay order-independent.
    if (splitClientIdFor(session.client || entry.client)) {
      mergedRows.push([period, archiveKey, entry, session]);
      continue;
    }
    if (entry.supersededBy) {
      supersededRows.push([period, archiveKey, session, entry.supersededBy]);
      continue;
    }
    addArchivedSession(period, session, archiveKey);
  }

  for (const [period, archiveKey, entry, session] of mergedRows) {
    if (period.sessions[archiveKey]) continue;
    // An archived session captured while two clients shared one row is keyed
    // under the merged id, so the live split-id copy of the same session is a
    // different key. The split id's own scan is the authoritative source now —
    // it reports the same bytes the merged row was built from — so skip the
    // archived copy rather than adding it on top. The check runs late enough to
    // also see the split id's *archived* rows, which the first pass applied.
    if (isLiveUnderSplitId(period, entry, session)) continue;
    if (entry.supersededBy) {
      supersededRows.push([period, archiveKey, session, entry.supersededBy]);
      continue;
    }
    addArchivedSession(period, session, archiveKey);
  }

  // A legacy Cursor row whose event now belongs to another session is judged
  // after every other row has replayed, so that session counts whether it is
  // live or only archived. Without it the row is still the only record.
  for (const [period, archiveKey, session, supersededBy] of supersededRows) {
    if (!period.sessions[supersededBy]) addArchivedSession(period, session, archiveKey);
  }

  return next;
}

function sessionUsageArchivePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'session-usage-archive.json');
}

function readSessionUsageArchive(options = {}) {
  const read = options.readJson || readJson;
  return normalizeSessionUsageArchive(read(sessionUsageArchivePath(options), {}));
}

function writeSessionUsageArchive(archive, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(sessionUsageArchivePath(options), normalizeSessionUsageArchive(archive));
}

function clearSessionUsageArchive(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(sessionUsageArchivePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  mergeSessionArchiveEntry,
  applySessionUsageArchive,
  captureSessionUsageArchive,
  clearSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  sessionUsageArchivePath,
  updateSessionUsageArchive,
  writeSessionUsageArchive
};
