'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { appVersion } = require('../shared/appVersion');
const { sharedDataDir } = require('../shared/config');
const { normalizeProfileId } = require('./config');
const {
  errorMessage,
  diagnosticMessage,
  MESSAGE_TYPES,
  readyMessage,
  snapshotMessage,
  stoppedMessage,
  validateWorkerMessage
} = require('./protocol');
const {
  serializeServerSnapshot,
  validateServerSnapshot
} = require('./snapshot');
const { DEFAULT_COMMAND_TIMEOUT_MS, parseTimeout } = require('./timeouts');

function safeErrorCode(error, fallback = 'worker-failed') {
  if (error?.code === 'snapshot-budget-exceeded') return error.code;
  if (error?.name === 'SnapshotBudgetError') return 'snapshot-budget-exceeded';
  if (typeof error?.code === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(error.code)) return error.code;
  return fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function defaultDeviceRuntimeFactory() {
  // Keep fixture/config tooling independent from optional provider transports.
  // The production path loads the existing shared runtime only when a real
  // collector worker is requested.
  return require('../shared/deviceRuntime').createDeviceRuntime;
}

function sendIpc(message, send = (value) => process.send?.(value, () => {})) {
  if (!validateWorkerMessage(message) && message.type !== MESSAGE_TYPES.STOP) {
    throw new TypeError(`invalid server-agent IPC message: ${String(message?.type || '')}`);
  }
  try {
    send(message);
  } catch (_) {
    // A supervisor disappearing must never make the collector throw from an
    // optional diagnostic/snapshot callback.
  }
}

function fixturePath() {
  return path.join(process.env.CODEX_HOME || '', 'server-agent-fixture.json');
}

function loadFixtureSummary(profileId, profileName) {
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(fixturePath(), 'utf8'));
  } catch (error) {
    const wrapped = new Error('server-agent fixture could not be read');
    wrapped.code = error.code || 'invalid-fixture';
    throw wrapped;
  }
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    const error = new Error('server-agent fixture must be an object');
    error.code = 'invalid-fixture';
    throw error;
  }
  if (fixture.fail === true) {
    const error = new Error('server-agent fixture requested failure');
    error.code = 'fixture-failure';
    throw error;
  }
  // The fixture mode is test-only and intentionally reads from the worker's
  // own CODEX_HOME. It makes cross-profile reads observable without replacing
  // the production collector or depending on a particular Tokscale log format.
  const stateDir = sharedDataDir();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'worker-fixture-state.json'),
    JSON.stringify({ profileId, clients: 'codex', marker: typeof fixture.marker === 'string' ? fixture.marker : null }),
    'utf8'
  );
  return {
    ...fixture,
    deviceId: `fixture:${profileId}`,
    profile: undefined,
    agentRuntime: 'server-agent',
    agentVersion: fixture.agentVersion || appVersion(),
    hostname: 'fixture',
    platform: fixture.platform || process.env.TO_KNOW_PLATFORM || `${process.platform}-${process.arch}`,
    updatedAt: fixture.updatedAt || new Date().toISOString(),
    profileName
  };
}

function createProfileWorker(options = {}, deps = {}) {
  const profileId = normalizeProfileId(options.profileId || process.env.TO_KNOW_PROFILE_ID);
  const profileName = String(options.profileName || process.env.TO_KNOW_PROFILE_NAME || profileId).trim();
  const deviceName = options.deviceName || process.env.TO_KNOW_DEVICE_NAME || undefined;
  const send = deps.send || ((message) => sendIpc(message));
  const makeSnapshot = deps.serializeServerSnapshot || serializeServerSnapshot;
  const platform = options.platform || process.env.TO_KNOW_PLATFORM || undefined;
  const agentVersion = options.agentVersion || process.env.TO_KNOW_AGENT_VERSION || appVersion();
  const once = options.once === true || process.env.TO_KNOW_SERVER_AGENT_ONCE === '1';
  let runtime = null;
  let stopped = false;
  let snapshotPublished = false;
  let stopPromise = null;

  function emit(message) {
    if (typeof send === 'function') send(message);
  }

  function publishSnapshot(record) {
    if (stopped) return;
    try {
      const serialized = makeSnapshot(record, {
        profile: { id: profileId, name: profileName },
        platform,
        agentVersion,
        deviceName
      });
      validateServerSnapshot(serialized.snapshot);
      snapshotPublished = true;
      emit(snapshotMessage(profileId, serialized.snapshot));
      if (once) void stop();
    } catch (error) {
      emit(errorMessage(profileId, safeErrorCode(error), 'snapshot'));
      if (once) void stop();
    }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (stopped) return;
      stopped = true;
      try { runtime?.stop?.({ skipCloseWatchers: true }); } catch (_) {}
      try { await runtime?.flush?.(); } catch (_) {}
      emit(stoppedMessage(profileId));
      if (process.connected) {
        try { process.disconnect(); } catch (_) {}
      }
      // Let pending child-process termination callbacks drain. The timer is
      // bounded and only belongs to this profile worker.
      setTimeout(() => process.exit(0), 25);
    })();
    return stopPromise;
  }

  function start() {
    emit(readyMessage(profileId));
    if (process.env.TO_KNOW_SERVER_AGENT_TEST_FIXTURE === '1') {
      try {
        publishSnapshot(loadFixtureSummary(profileId, profileName));
      } catch (error) {
        emit(errorMessage(profileId, safeErrorCode(error, 'fixture-failed'), 'fixture'));
        void stop();
      }
      return { stop, getSnapshotPublished: () => snapshotPublished };
    }

    const commandTimeoutMs = parseTimeout(process.env.TO_KNOW_TOKSCALE_TIMEOUT_MS) ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const watchEnabled = parseBoolean(process.env.TO_KNOW_WATCH_ENABLED, true);
    const historyEnabled = parseBoolean(process.env.TO_KNOW_HISTORY_ENABLED, true);
    const projectsEnabled = parseBoolean(process.env.TO_KNOW_PROJECTS_ENABLED, false);
    const runtimeOptions = {
      envelope: {
        deviceId: `server-agent:${profileId}`,
        agentVersion,
        agentRuntime: 'server-agent'
      },
      limitsOptions: { limitsEnabled: false },
      usageOptions: {
        clients: 'codex',
        allTimeSince: process.env.TO_KNOW_ALL_TIME_SINCE || '2024-01-01',
        commandTimeoutMs,
        deviceId: `server-agent:${profileId}`,
        agentVersion,
        agentRuntime: 'server-agent',
        projectsEnabled,
        historyEnabled,
        watchEnabled,
        watchDebounceMs: parseNumber(process.env.TO_KNOW_WATCH_DEBOUNCE_MS, 1500),
        intervalMs: parseNumber(process.env.TO_KNOW_INTERVAL_MS, 5 * 60 * 1000),
        anchorPersistenceEnabled: true,
        dailyHistoryArchiveEnabled: true,
        onError: (error, stage) => emit(errorMessage(profileId, safeErrorCode(error), stage)),
        logger: () => {}
      },
      sink: null,
      onRecord: (record) => publishSnapshot(record),
      onDiagnosticEvent: (event) => emit(diagnosticMessage(profileId, event?.subsystem, event?.code))
    };
    try {
      const makeDeviceRuntime = deps.createDeviceRuntime || defaultDeviceRuntimeFactory();
      runtime = makeDeviceRuntime(runtimeOptions, deps.deviceRuntimeDeps || {});
    } catch (error) {
      emit(errorMessage(profileId, safeErrorCode(error), 'startup'));
      void stop();
    }
    return { stop, getSnapshotPublished: () => snapshotPublished };
  }

  return { start, stop, getSnapshotPublished: () => snapshotPublished };
}

if (require.main === module) {
  const worker = createProfileWorker();
  process.on('message', (message) => {
    if (message?.type === MESSAGE_TYPES.STOP && message.profileId === process.env.TO_KNOW_PROFILE_ID) {
      void worker.stop();
    }
  });
  process.on('disconnect', () => {
    void worker.stop();
  });
  worker.start();
}

module.exports = {
  createProfileWorker,
  loadFixtureSummary,
  safeErrorCode
};
