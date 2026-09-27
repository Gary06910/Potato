'use strict';

const os = require('node:os');
const path = require('node:path');
const { normalizeProfileId } = require('./config');

const APP_DIR_NAME = 'toknow-agent';
const DESKTOP_ID_RE = /^dev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function baseRoot(kind, options = {}) {
  const explicit = nonBlank(options[`${kind}Root`]);
  if (explicit) return path.resolve(explicit);
  if (nonBlank(options.root)) return path.join(path.resolve(options.root), kind);

  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const envKey = {
    config: 'XDG_CONFIG_HOME',
    data: 'XDG_DATA_HOME',
    state: 'XDG_STATE_HOME'
  }[kind];
  const envValue = nonBlank(env[envKey]);
  if (envValue) return path.resolve(envValue);
  const fallback = {
    config: path.join(homeDir, '.config'),
    data: path.join(homeDir, '.local', 'share'),
    state: path.join(homeDir, '.local', 'state')
  }[kind];
  return path.resolve(fallback);
}

function createServerAgentPaths(options = {}) {
  const configRoot = path.join(baseRoot('config', options), APP_DIR_NAME);
  const dataRoot = path.join(baseRoot('data', options), APP_DIR_NAME);
  const stateRoot = path.join(baseRoot('state', options), APP_DIR_NAME);
  const configFile = path.join(configRoot, 'config.json');
  const credentialFile = path.join(dataRoot, 'credentials.json');
  const profilesRoot = path.join(stateRoot, 'profiles');
  const notificationRoot = path.join(stateRoot, 'notification');

  function profileStateDir(profileId) {
    return path.join(profilesRoot, normalizeProfileId(profileId), 'runtime');
  }

  function profilePaths(profileId) {
    const runtimeDir = profileStateDir(profileId);
    return {
      runtimeDir,
      collectorAnchorPath: path.join(runtimeDir, 'collector-anchor.json'),
      dailyHistoryArchivePath: path.join(runtimeDir, 'daily-history-archive.json'),
      sessionUsageArchivePath: path.join(runtimeDir, 'session-usage-archive.sqlite'),
      workerPidPath: path.join(runtimeDir, 'worker.pid')
    };
  }

  function notificationOutboxPath(desktopId) {
    if (!DESKTOP_ID_RE.test(desktopId || '')) return null;
    return path.join(notificationRoot, `android-outbox-${desktopId}.json`);
  }

  return Object.freeze({
    configRoot,
    configFile,
    dataRoot,
    credentialFile,
    stateRoot,
    profilesRoot,
    notificationRoot,
    notificationRuntimePath: path.join(notificationRoot, 'hook-runtime.json'),
    notificationOutboxPath,
    supervisorPidPath: path.join(stateRoot, 'server-agent.pid'),
    agentLockPath: path.join(stateRoot, 'server-agent.lock'),
    agentReadyPath: path.join(stateRoot, 'server-agent.ready.json'),
    agentReaperPath: path.join(stateRoot, 'server-agent.reaper.lock'),
    agentLaunchPath: path.join(stateRoot, 'server-agent.launch.lock'),
    profileStateDir,
    profilePaths
  });
}

module.exports = {
  APP_DIR_NAME,
  createServerAgentPaths
};
