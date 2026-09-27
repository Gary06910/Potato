'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { loadServerAgentConfig, parseServerAgentConfig } = require('./config');
const { createServerAgentPaths } = require('./paths');
const {
  MESSAGE_TYPES,
  stopMessage,
  validateWorkerMessage
} = require('./protocol');
const { validateServerSnapshot } = require('./snapshot');
const { createServerNotificationRuntime } = require('./notificationRuntime');
const { createUsageSyncRuntime } = require('./usageSyncRuntime');
const {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  SNAPSHOT_TIMEOUT_GRACE_MS,
  resolveCommandTimeout,
  resolveSnapshotTimeout,
  resolveTimeout
} = require('./timeouts');
const MAX_DIAGNOSTICS = 32;
const WORKER_RESTART_INITIAL_MS = 1_000;
const WORKER_RESTART_MAX_MS = 30_000;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function boundedString(value, fallback, maxLength = 256) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength && !/[\r\n\p{Cc}\p{Cf}]/u.test(normalized)
    ? normalized
    : fallback;
}

function safeEnvValue(value, fallback = '') {
  return boundedString(String(value ?? ''), fallback, 512);
}

function safeNotificationCode(error, fallback = 'notification_start_failed') {
  const code = String(error?.code || fallback);
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : fallback;
}

function createServerAgentSupervisor(options = {}, deps = {}) {
  const config = options.config
    ? parseServerAgentConfig(options.config, options.configValidation || {})
    : loadServerAgentConfig(options.configPath, options.configValidation || {});
  const paths = options.paths || createServerAgentPaths(options.pathOptions || {});
  const forkWorker = deps.fork || fork;
  const workerPath = options.workerPath || path.join(__dirname, 'profileWorker.js');
  const inheritedEnv = { ...(options.env || process.env) };
  const startTimeoutMs = resolveTimeout(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS);
  const stopTimeoutMs = resolveTimeout(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
  const effectiveCommandTimeoutMs = resolveCommandTimeout(
    options.commandTimeoutMs,
    inheritedEnv.TO_KNOW_TOKSCALE_TIMEOUT_MS
  );
  const snapshotTimeoutMs = resolveSnapshotTimeout(options.snapshotTimeoutMs, effectiveCommandTimeoutMs);
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const workers = new Map();
  const latestSnapshots = new Map();
  const snapshotWaiters = new Set();
  const makeNotificationRuntime = deps.createNotificationRuntime || createServerNotificationRuntime;
  let lifecycle = 'created';
  let startPromise = null;
  let stopPromise = null;
  let pidFileWritten = false;
  let usageSyncRuntime = null;
  let usageSyncStatus = { state: options.once ? 'skipped_once' : 'not_started' };
  let notificationRuntime = null;
  let notificationStatus = { state: options.once === true ? 'skipped_once' : 'not_started' };

  function enabledProfiles() {
    return config.profiles.filter((profile) => profile.enabled);
  }

  function buildWorkerEnv(profile) {
    const profileStateDir = paths.profileStateDir(profile.id);
    const env = {
      ...inheritedEnv,
      CODEX_HOME: profile.codexHome,
      TOKEN_MONITOR_SHARED_DIR: profileStateDir,
      TOKEN_MONITOR_CLIENTS: 'codex',
      TOKEN_MONITOR_LIMITS_ENABLED: '0',
      TO_KNOW_PROFILE_ID: profile.id,
      TO_KNOW_PROFILE_NAME: profile.name,
      TO_KNOW_DEVICE_NAME: safeEnvValue(config.deviceName, 'Potato Server'),
      TO_KNOW_AGENT_VERSION: safeEnvValue(options.agentVersion || process.env.npm_package_version, '1.0.0'),
      TO_KNOW_SERVER_AGENT_ONCE: options.once === true ? '1' : '0',
      TO_KNOW_WATCH_ENABLED: options.watchEnabled === false ? '0' : '1',
      TO_KNOW_HISTORY_ENABLED: options.historyEnabled === false ? '0' : '1',
      TO_KNOW_PROJECTS_ENABLED: options.projectsEnabled === true ? '1' : '0',
      TO_KNOW_TOKSCALE_TIMEOUT_MS: String(effectiveCommandTimeoutMs)
    };
    if (options.platform) env.TO_KNOW_PLATFORM = safeEnvValue(options.platform, 'unknown');
    if (options.allTimeSince) env.TO_KNOW_ALL_TIME_SINCE = safeEnvValue(options.allTimeSince, '2024-01-01');
    if (options.fixtureMode === true) env.TO_KNOW_SERVER_AGENT_TEST_FIXTURE = '1';
    else delete env.TO_KNOW_SERVER_AGENT_TEST_FIXTURE;
    return env;
  }

  function recordFor(profile) {
    return {
      profile,
      child: null,
      generation: 0,
      state: 'created',
      ready: false,
      stopped: false,
      exited: false,
      exitCode: null,
      signal: null,
      lastErrorCode: null,
      lastSnapshotAt: null,
      restartCount: 0,
      restartTimer: null,
      restartScheduledAt: null,
      restartPending: false,
      diagnostics: []
    };
  }

  function isActiveLifecycle() {
    return lifecycle === 'starting' || lifecycle === 'running';
  }

  function isCurrentWorker(record, child, generation) {
    return record.generation === generation && record.child === child;
  }

  function notifySnapshotWaiters() {
    for (const check of snapshotWaiters) check();
  }

  function cancelRestart(record) {
    if (record.restartTimer !== null) clearTimer(record.restartTimer);
    record.restartTimer = null;
    record.restartScheduledAt = null;
    record.restartPending = false;
  }

  function restartDelayMs(restartCount) {
    return Math.min(
      WORKER_RESTART_MAX_MS,
      WORKER_RESTART_INITIAL_MS * (2 ** Math.max(0, restartCount - 1))
    );
  }

  function recordDiagnostic(record, stage, code) {
    const item = { stage: boundedString(stage, 'runtime', 32), code: boundedString(code, 'unknown', 64) };
    record.diagnostics.push(item);
    if (record.diagnostics.length > MAX_DIAGNOSTICS) record.diagnostics.shift();
    options.onDiagnostic?.({ profileId: record.profile.id, ...item });
  }

  function scheduleWorkerRestart(record) {
    if (!isActiveLifecycle() || record.restartPending || record.restartTimer !== null) return;

    record.restartCount += 1;
    const delayMs = restartDelayMs(record.restartCount);
    record.restartPending = true;
    record.restartScheduledAt = new Date().toISOString();
    record.restartTimer = setTimer(() => {
      record.restartTimer = null;
      record.restartScheduledAt = null;
      record.restartPending = false;
      if (!isActiveLifecycle()) return;
      if (record.child && !record.exited) return;
      spawnWorker(record.profile);
      notifySnapshotWaiters();
    }, delayMs);
    notifySnapshotWaiters();
  }

  function handleWorkerMessage(record, child, generation, message) {
    if (!isCurrentWorker(record, child, generation)) return;
    if (!validateWorkerMessage(message) || message.profileId !== record.profile.id) {
      recordDiagnostic(record, 'ipc', 'invalid-message');
      return;
    }
    switch (message.type) {
      case MESSAGE_TYPES.READY:
        if (message.clients !== 'codex') {
          record.lastErrorCode = 'non-codex-client-list';
          recordDiagnostic(record, 'protocol', record.lastErrorCode);
          return;
        }
        record.ready = true;
        record.state = 'ready';
        break;
      case MESSAGE_TYPES.SNAPSHOT:
        try {
          validateServerSnapshot(message.snapshot);
          if (message.snapshot.profile.id !== record.profile.id) throw new Error('invalid-snapshot');
          latestSnapshots.set(record.profile.id, clone(message.snapshot));
          record.lastSnapshotAt = new Date().toISOString();
          record.state = 'running';
          record.lastErrorCode = null;
          record.restartCount = 0;
          cancelRestart(record);
          try { usageSyncRuntime?.accept(record.profile.id, message.snapshot); }
          catch (_) { recordDiagnostic(record, 'usage_sync', 'sync-failed'); }
          options.onSnapshot?.(record.profile.id, clone(message.snapshot));
        } catch (error) {
          record.lastErrorCode = error.code || 'invalid-snapshot';
          recordDiagnostic(record, 'snapshot', record.lastErrorCode);
        }
        break;
      case MESSAGE_TYPES.DIAGNOSTIC:
        recordDiagnostic(record, message.stage, message.code);
        break;
      case MESSAGE_TYPES.ERROR:
        record.lastErrorCode = message.code;
        record.state = 'failed';
        recordDiagnostic(record, message.stage, message.code);
        options.onError?.({ profileId: record.profile.id, stage: message.stage, code: message.code });
        break;
      case MESSAGE_TYPES.STOPPED:
        record.stopped = true;
        record.state = 'stopped';
        cancelRestart(record);
        break;
      default:
        break;
    }
    notifySnapshotWaiters();
  }

  function handleWorkerExit(record, child, generation, code, signal) {
    if (!isCurrentWorker(record, child, generation)) return;
    record.exited = true;
    record.exitCode = code;
    record.signal = signal;
    record.child = null;
    if (isActiveLifecycle() && !record.stopped) {
      record.state = 'failed';
      if (!record.lastErrorCode) {
        record.lastErrorCode = 'worker-exited';
        recordDiagnostic(record, 'process', record.lastErrorCode);
      }
      scheduleWorkerRestart(record);
    } else {
      record.state = 'stopped';
    }
    notifySnapshotWaiters();
  }

  function handleWorkerError(record, child, generation) {
    if (!isCurrentWorker(record, child, generation)) return;
    if (!record.lastErrorCode) {
      record.lastErrorCode = 'worker-process-error';
      recordDiagnostic(record, 'process', record.lastErrorCode);
      options.onError?.({ profileId: record.profile.id, stage: 'process', code: record.lastErrorCode });
    }
    record.state = 'failed';
    if (!isActiveLifecycle()) {
      notifySnapshotWaiters();
      return;
    }

    // A spawn/IPC error can be followed by an exit event, or by no exit event
    // at all. Retire this generation immediately so either case has one retry
    // path and a late event cannot touch the replacement worker.
    record.exited = true;
    record.exitCode = null;
    record.signal = null;
    record.child = null;
    try { child.kill(); } catch (_) {}
    scheduleWorkerRestart(record);
    notifySnapshotWaiters();
  }

  function handleWorkerSpawnFailure(record, generation) {
    if (record.generation !== generation) return;
    record.exited = true;
    record.state = 'failed';
    record.lastErrorCode = 'worker-spawn-error';
    recordDiagnostic(record, 'process', record.lastErrorCode);
    options.onError?.({ profileId: record.profile.id, stage: 'process', code: record.lastErrorCode });
    scheduleWorkerRestart(record);
    notifySnapshotWaiters();
  }

  function spawnWorker(profile) {
    const record = workers.get(profile.id) || recordFor(profile);
    workers.set(profile.id, record);
    if (!isActiveLifecycle()) return record;
    if (record.child && !record.exited) return record;

    record.generation += 1;
    const generation = record.generation;
    record.child = null;
    record.state = 'starting';
    record.ready = false;
    record.stopped = false;
    record.exited = false;
    record.exitCode = null;
    record.signal = null;
    record.lastErrorCode = null;
    record.restartTimer = null;
    record.restartScheduledAt = null;
    record.restartPending = false;

    let child;
    try {
      fs.mkdirSync(paths.profileStateDir(profile.id), { recursive: true });
      child = forkWorker(workerPath, [], {
        env: buildWorkerEnv(profile),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true
      });
      record.child = child;
      child.on('message', (message) => handleWorkerMessage(record, child, generation, message));
      child.on('error', () => handleWorkerError(record, child, generation));
      child.on('exit', (code, signal) => handleWorkerExit(record, child, generation, code, signal));
    } catch {
      record.child = null;
      handleWorkerSpawnFailure(record, generation);
    }
    return record;
  }

  function writeSupervisorPid() {
    if (options.pidFile === false) return;
    fs.mkdirSync(path.dirname(paths.supervisorPidPath), { recursive: true });
    fs.writeFileSync(paths.supervisorPidPath, String(process.pid), 'utf8');
    pidFileWritten = true;
  }

  function removeSupervisorPid() {
    if (!pidFileWritten) return;
    try { fs.unlinkSync(paths.supervisorPidPath); } catch (_) {}
    pidFileWritten = false;
  }

  async function startNotificationRuntime() {
    if (options.once === true) return;
    try {
      notificationRuntime = makeNotificationRuntime({
        config,
        paths,
        fetch: options.fetch,
        logger: { warn: (message, details) => options.onDiagnostic?.({ stage: 'notification', code: safeNotificationCode(details) }) }
      }, deps.notificationDeps || {});
      notificationStatus = await notificationRuntime.start();
    } catch (error) {
      notificationRuntime = null;
      notificationStatus = { state: 'degraded', configured: false, error: safeNotificationCode(error) };
      options.onDiagnostic?.({ stage: 'notification', code: notificationStatus.error });
    }
  }

  async function stopNotificationRuntime() {
    if (!notificationRuntime) return;
    try {
      notificationStatus = await notificationRuntime.stop();
    } catch (error) {
      notificationStatus = {
        ...(notificationStatus || {}),
        state: 'degraded',
        error: safeNotificationCode(error, 'notification_stop_failed')
      };
      options.onDiagnostic?.({ stage: 'notification', code: notificationStatus.error });
    }
    notificationRuntime = null;
  }

  function waitForStart() {
    const records = [...workers.values()];
    if (records.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = setTimer(resolve, startTimeoutMs);
      const check = () => {
        if (records.every((record) => record.ready || record.exited || record.lastErrorCode)) {
          clearTimer(deadline);
          resolve();
        }
      };
      for (const record of records) {
        const child = record.child;
        child?.on('message', check);
        child?.on('exit', check);
        child?.on('error', check);
      }
      check();
    });
  }

  async function start() {
    if (startPromise) return startPromise;
    if (lifecycle === 'stopping' || lifecycle === 'stopped') throw new Error('server-agent supervisor is stopped');
    lifecycle = 'starting';
    startPromise = (async () => {
      writeSupervisorPid();
      await startNotificationRuntime();
      if (!options.once) {
        try {
          usageSyncRuntime = (deps.createUsageSyncRuntime || createUsageSyncRuntime)({ config, paths, fetch: options.fetch,
            stopTimeoutMs, onDiagnostic: options.onDiagnostic }, deps.usageSyncDeps || {});
          usageSyncStatus = await usageSyncRuntime.start();
        } catch (_) { usageSyncStatus = { state: 'unconfigured' }; }
      }
      for (const profile of enabledProfiles()) {
        if (!isActiveLifecycle()) break;
        spawnWorker(profile);
      }
      if (isActiveLifecycle()) options.onMinimalReady?.({ notification: clone(notificationStatus) });
      await waitForStart();
      if (lifecycle === 'starting') lifecycle = 'running';
      return getDiagnostics();
    })();
    return startPromise;
  }

  function waitForSnapshots(timeoutMs = snapshotTimeoutMs) {
    const waitTimeoutMs = resolveTimeout(timeoutMs, snapshotTimeoutMs);
    const expected = enabledProfiles().map((profile) => profile.id);
    const isTerminal = (id) => {
      const record = workers.get(id);
      return record?.lastErrorCode && !record.restartPending;
    };
    if (expected.length === 0 || expected.every((id) => latestSnapshots.has(id) || isTerminal(id))) {
      return Promise.resolve(getAllSnapshots());
    }
    return new Promise((resolve) => {
      const check = () => {
        if (expected.every((id) => latestSnapshots.has(id) || isTerminal(id))) {
          snapshotWaiters.delete(check);
          clearTimer(deadline);
          resolve(getAllSnapshots());
        }
      };
      const deadline = setTimer(() => {
        snapshotWaiters.delete(check);
        resolve(getAllSnapshots());
      }, waitTimeoutMs);
      snapshotWaiters.add(check);
      check();
    });
  }

  function waitForExit(record) {
    if (!record.child || record.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const child = record.child;
      const timer = setTimer(() => {
        if (!record.exited) {
          try { child.kill(); } catch (_) {}
        }
        resolve();
      }, stopTimeoutMs);
      child.once('exit', () => {
        clearTimer(timer);
        resolve();
      });
    });
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      lifecycle = 'stopping';
      for (const record of workers.values()) cancelRestart(record);
      await stopNotificationRuntime();
      try { if (usageSyncRuntime) usageSyncStatus = await usageSyncRuntime.stop(); }
      catch (_) { usageSyncStatus = { state: 'stopped' }; }
      const records = [...workers.values()];
      for (const record of records) {
        if (!record.child || record.exited) continue;
        try {
          if (record.child.connected) record.child.send(stopMessage(record.profile.id));
        } catch (_) {}
      }
      await Promise.all(records.map(waitForExit));
      for (const record of records) {
        record.stopped = true;
        record.state = 'stopped';
      }
      removeSupervisorPid();
      lifecycle = 'stopped';
      return getDiagnostics();
    })();
    return stopPromise;
  }

  function getSnapshot(profileId) {
    return clone(latestSnapshots.get(profileId) || null);
  }

  function getAllSnapshots() {
    return Object.fromEntries([...latestSnapshots.entries()].map(([id, snapshot]) => [id, clone(snapshot)]));
  }

  function getDiagnostics() {
    const profiles = {};
    for (const [id, record] of workers.entries()) {
      profiles[id] = {
        state: record.state,
        ready: record.ready,
        stopped: record.stopped,
        exited: record.exited,
        exitCode: record.exitCode,
        signal: record.signal,
        lastErrorCode: record.lastErrorCode,
        lastSnapshotAt: record.lastSnapshotAt,
        restartCount: record.restartCount,
        restartPending: record.restartPending,
        diagnostics: clone(record.diagnostics)
      };
    }
    return {
      state: lifecycle,
      workerModel: 'child_process',
      usageSync: usageSyncRuntime?.status() || usageSyncStatus,
      clientList: 'codex',
      profileCount: enabledProfiles().length,
      notification: clone(notificationStatus),
      profiles
    };
  }

  function getTimeouts() {
    return {
      startTimeoutMs,
      stopTimeoutMs,
      effectiveCommandTimeoutMs,
      snapshotTimeoutMs,
      snapshotTimeoutGraceMs: SNAPSHOT_TIMEOUT_GRACE_MS
    };
  }

  return {
    config,
    paths,
    start,
    stop,
    waitForSnapshots,
    getSnapshot,
    getAllSnapshots,
    getDiagnostics,
    getTimeouts,
    getNotificationStatus: () => clone(notificationStatus),
    _buildWorkerEnv: buildWorkerEnv
  };
}

module.exports = {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  SNAPSHOT_TIMEOUT_GRACE_MS,
  WORKER_RESTART_INITIAL_MS,
  WORKER_RESTART_MAX_MS,
  createServerAgentSupervisor
};
