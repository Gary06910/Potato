'use strict';

const { readRegularFileNoFollow, writePrivateJsonAtomic } = require('../credentialStore');
const { validateAndroidCompletionPayload } = require('./androidPayload');

const VERSION = 3;
const DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_DELIVERED_ITEMS = 1_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15 * 60 * 1_000;
const MAX_ITEMS = 1_000;
const MAX_ATTEMPTS = 20;
const ACTIVE_TTL_MS = 24 * 60 * 60 * 1_000;
const FAILED_RETENTION_MS = 7 * ACTIVE_TTL_MS;
const MAX_FAILED_ITEMS = 50;

function timestamp(value) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) throw new TypeError('now() must return a finite timestamp');
  return result;
}

function responseStatus(value, error) {
  const candidate = error?.status ?? value?.status;
  return Number.isInteger(candidate) ? candidate : null;
}

function classifyAndroidDelivery(value, error) {
  const status = responseStatus(value, error);
  if (!error && (status === null || (status >= 200 && status < 300))) {
    return { kind: 'success', status };
  }
  if (status === 401 || status === 403) return { kind: 'credential', status };
  if ([400, 404, 405, 409, 413, 422].includes(status)) return { kind: 'terminal', status };
  if ([408, 425, 429, 500, 502, 503, 504].includes(status) || status === null || status >= 500) {
    return { kind: 'retry', status };
  }
  return { kind: 'terminal', status };
}

function safeErrorCode(error, status) {
  const code = String(error?.code || (status ? `http_${status}` : 'network_error'));
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : 'network_error';
}

function normalizeDelivered(value, now) {
  if (!Array.isArray(value)) throw new Error('Invalid Android delivered ledger');
  const events = new Map();
  for (const entry of value) {
    if (!entry || typeof entry.eventId !== 'string' || !/^evt:[^\s:]+:[^\s]+$/.test(entry.eventId)
      || entry.eventId.length > 240 || !Number.isFinite(entry.deliveredAt)) {
      throw new Error('Invalid Android delivered tombstone');
    }
    if (entry.deliveredAt + DELIVERED_RETENTION_MS <= now) continue;
    const previous = events.get(entry.eventId);
    if (!previous || previous.deliveredAt < entry.deliveredAt) {
      events.set(entry.eventId, { eventId: entry.eventId, deliveredAt: entry.deliveredAt });
    }
  }
  return [...events.values()].sort((a, b) => b.deliveredAt - a.deliveredAt).slice(0, MAX_DELIVERED_ITEMS);
}

function normalizeDocument(value, now) {
  if (!value || typeof value !== 'object' || ![1, 2, VERSION].includes(value.version) || !Array.isArray(value.items)) {
    throw new Error('Unsupported Android outbox document');
  }
  if (value.items.length > MAX_ITEMS) throw new Error('Android outbox is too large');
  const eventIds = new Set();
  return {
    version: VERSION,
    delivered: value.version < 3 ? [] : normalizeDelivered(value.delivered, now),
    items: value.items.map((item) => {
      const payload = validateAndroidCompletionPayload(item.payload);
      if (eventIds.has(payload.eventId)) throw new Error('Android outbox contains duplicate event ids');
      eventIds.add(payload.eventId);
      return {
        payload,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Math.min(now, Date.parse(payload.occurredAt) || now),
        failedAt: Number.isFinite(item.failedAt) ? item.failedAt : (item.suspended ? now : null),
        attemptCount: Number.isSafeInteger(item.attemptCount) && item.attemptCount >= 0
          ? item.attemptCount
          : 0,
        nextAttemptAt: Number.isFinite(item.nextAttemptAt) ? item.nextAttemptAt : 0,
        lastError: typeof item.lastError === 'string' ? item.lastError.slice(0, 80) : null,
        suspended: ['credential', 'terminal', 'retry_exhausted', 'expired'].includes(item.suspended) ? item.suspended : null
      };
    })
  };
}

function createAndroidOutbox({
  filePath,
  send,
  now = Date.now,
  random = Math.random,
  logger = {},
  onDeliveryFailure = () => {},
  maxAttempts = MAX_ATTEMPTS
}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
  if (typeof send !== 'function') throw new TypeError('send is required');
  if (typeof onDeliveryFailure !== 'function') throw new TypeError('onDeliveryFailure must be a function');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new TypeError(`maxAttempts must be between 1 and ${MAX_ATTEMPTS}`);
  }
  let document = { version: VERSION, items: [], delivered: [] };
  let loaded = false;
  let running = false;
  let pausedReason = null;
  let timer = null;
  let lane = Promise.resolve();

  function currentTime() { return timestamp(now()); }

  function load() {
    if (loaded) return;
    try {
      const raw = readRegularFileNoFollow(filePath, {
        description: 'Android notification outbox',
        encoding: 'utf8',
        maxBytes: 8 * 1024 * 1024,
        mode: 0o600
      });
      document = normalizeDocument(JSON.parse(raw), currentTime());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    loaded = true;
    prune();
    persist();
  }

  function persist() { writePrivateJsonAtomic(filePath, document); }

  function prune() {
    const now = currentTime();
    document.delivered = normalizeDelivered(document.delivered, now);
    for (const item of document.items) {
      if (!item.suspended && item.createdAt + ACTIVE_TTL_MS <= now) {
        item.suspended = 'expired';
        item.lastError = 'expired';
        item.failedAt = item.createdAt + ACTIVE_TTL_MS;
      }
    }
    const retained = document.items.filter((item) => item.suspended && item.failedAt + FAILED_RETENTION_MS > now)
      .sort((a, b) => b.failedAt - a.failedAt).slice(0, MAX_FAILED_ITEMS);
    const keep = new Set(retained);
    document.items = document.items.filter((item) => !item.suspended || keep.has(item));
  }

  function snapshot() {
    const firstError = document.items.find((item) => item.lastError)?.lastError || null;
    return {
      pending: document.items.filter((item) => !item.suspended).length,
      blocked: document.items.filter((item) => item.suspended === 'credential').length,
      failed: document.items.filter((item) => item.suspended && item.suspended !== 'credential').length,
      total: document.items.length,
      lastError: firstError,
      paused: Boolean(pausedReason),
      pausedReason,
      items: document.items.map((item) => ({
        eventId: item.payload.eventId,
        attemptCount: item.attemptCount,
        nextAttemptAt: item.nextAttemptAt,
        lastError: item.lastError,
        suspended: item.suspended
      }))
    };
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    if (!running || !document.items.length) return;
    const earliest = Math.min(...document.items.map((item) => item.suspended
      ? item.failedAt + FAILED_RETENTION_MS
      : Math.min(pausedReason ? Infinity : item.nextAttemptAt, item.createdAt + ACTIVE_TTL_MS)));
    timer = setTimeout(() => {
      timer = null;
      api.flush().catch((error) => logger.warn?.('Android outbox flush failed', {
        code: safeErrorCode(error)
      }));
    }, Math.max(0, earliest - currentTime()));
    timer.unref?.();
  }

  function enqueueInLane(operation) {
    const next = lane.then(operation, operation);
    lane = next.catch(() => {});
    return next;
  }

  async function flushDue() {
    load();
    prune();
    persist();
    if (pausedReason) { schedule(); return snapshot(); }
    const attempted = new Set();
    while (true) {
      if (pausedReason) break;
      prune();
      const index = document.items.findIndex((item) => (
        !item.suspended
        && !attempted.has(item.payload.eventId)
        && item.nextAttemptAt <= currentTime()
      ));
      if (index < 0) break;
      const item = document.items[index];
      attempted.add(item.payload.eventId);
      let result;
      let failure;
      try { result = await send(validateAndroidCompletionPayload(item.payload)); }
      catch (error) { failure = error; }
      const outcome = classifyAndroidDelivery(result, failure);
      if (outcome.kind === 'success') {
        // Both changes are persisted in the same atomic document write, inside the lane.
        document.delivered.unshift({ eventId: item.payload.eventId, deliveredAt: currentTime() });
        document.items.splice(index, 1);
      } else {
        try { onDeliveryFailure({ error: failure, outcome }); } catch (_) {}
        item.attemptCount += 1;
        item.lastError = safeErrorCode(failure, outcome.status);
        if (outcome.kind === 'retry' && item.attemptCount < maxAttempts) {
          const nominal = Math.min(
            MAX_DELAY_MS,
            BASE_DELAY_MS * (2 ** Math.min(20, item.attemptCount - 1))
          );
          const randomValue = Number(random());
          const bounded = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0.5;
          item.nextAttemptAt = currentTime() + Math.round(nominal * bounded);
        } else {
          item.failedAt = currentTime();
          item.suspended = outcome.kind;
          if (outcome.kind === 'retry') {
            item.suspended = 'terminal';
            item.lastError = 'retry_exhausted';
          }
        }
      }
      prune();
      persist();
    }
    schedule();
    return snapshot();
  }

  const api = {
    enqueue(payload) {
      return enqueueInLane(() => {
        load();
        prune();
        persist();
        const clean = validateAndroidCompletionPayload(payload);
        if (!document.items.some((item) => item.payload.eventId === clean.eventId)
          && !document.delivered.some((item) => item.eventId === clean.eventId)) {
          if (document.items.length >= MAX_ITEMS) throw Object.assign(new Error('outbox_full'), { code: 'outbox_full' });
          document.items.push({
            payload: clean,
            createdAt: Math.min(currentTime(), Date.parse(clean.occurredAt) || currentTime()),
            failedAt: null,
            attemptCount: 0,
            nextAttemptAt: currentTime(),
            lastError: null,
            suspended: null
          });
          persist();
        }
        schedule();
        return snapshot();
      });
    },
    start() {
      return enqueueInLane(() => {
        running = true;
        pausedReason = null;
        try {
          load();
          schedule();
          return snapshot();
        } catch (error) {
          running = false;
          throw error;
        }
      });
    },
    flush() { return enqueueInLane(flushDue); },
    clearUndelivered() {
      return enqueueInLane(() => {
        load();
        prune();
        document.items = document.items.filter((item) => !item.suspended);
        persist();
        schedule();
        return snapshot();
      });
    },
    clearOutbox() {
      return enqueueInLane(() => {
        load();
        document.items = [];
        persist();
        schedule();
        return snapshot();
      });
    },
    stop() {
      running = false;
      clearTimer();
      return lane;
    },
    pause(reason = 'invalid') {
      pausedReason = safeErrorCode({ code: reason });
      schedule();
      return snapshot();
    },
    load() { load(); return snapshot(); },
    snapshot() { load(); return snapshot(); }
  };
  return api;
}

module.exports = {
  DELIVERED_RETENTION_MS,
  MAX_DELIVERED_ITEMS,
  MAX_ATTEMPTS,
  MAX_ITEMS,
  ACTIVE_TTL_MS,
  FAILED_RETENTION_MS,
  MAX_FAILED_ITEMS,
  classifyAndroidDelivery,
  createAndroidOutbox
};
