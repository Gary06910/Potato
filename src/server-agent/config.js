'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_VERSION = 1;
const MAX_PROFILE_ID_LENGTH = 40;
const MAX_PROFILE_NAME_LENGTH = 80;
const MAX_DEVICE_NAME_LENGTH = 80;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function configError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedSingleLine(value, field, maxCodePoints, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw configError('invalid-config-field', `${field} must be a string`);
  }
  const normalized = value.normalize('NFC').trim();
  if (!normalized && required) throw configError('invalid-config-field', `${field} must be non-empty`);
  if ([...normalized].length > maxCodePoints) {
    throw configError('invalid-config-field', `${field} is too long`);
  }
  if (/\r|\n|[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw configError('invalid-config-field', `${field} must be single-line text`);
  }
  return normalized;
}

function normalizeProfileId(value) {
  if (typeof value !== 'string') throw configError('invalid-profile-id', 'profile.id must be a string');
  const id = value.trim();
  if (!id || id.length > MAX_PROFILE_ID_LENGTH || !PROFILE_ID_RE.test(id)) {
    throw configError('invalid-profile-id', 'profile.id must be lowercase ASCII identity text');
  }
  return id;
}

function normalizeAbsolutePath(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw configError('relative-codex-home', 'profile.codexHome must be an absolute path');
  }
  return path.normalize(value);
}

function pathIdentity(value, options = {}) {
  const realpath = options.realpathSync
    || (typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync);
  let resolved = path.resolve(value);
  try {
    const candidate = realpath(resolved);
    if (typeof candidate === 'string' && candidate) resolved = candidate;
  } catch (_) {
    // A profile may be configured before its Codex directory is created. The
    // normalized absolute path is still enough to reject lexical aliases such
    // as /home/user/foo/../.codex.
  }
  const normalized = path.normalize(resolved);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function parseServerAgentConfig(value, options = {}) {
  if (!isPlainObject(value)) throw configError('invalid-config', 'config must be an object');
  if (value.version !== CONFIG_VERSION) {
    throw configError('unknown-config-version', `unsupported server-agent config version: ${String(value.version)}`);
  }
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw configError('empty-profiles', 'config.profiles must contain at least one profile');
  }

  const deviceName = value.deviceName === undefined
    ? 'Potato Server'
    : boundedSingleLine(value.deviceName, 'deviceName', MAX_DEVICE_NAME_LENGTH);
  const endpoint = value.endpoint === undefined
    ? undefined
    : boundedSingleLine(value.endpoint, 'endpoint', 512, { required: false });
  const ids = new Set();
  const enabledHomeIdentities = new Map();
  const profiles = value.profiles.map((rawProfile) => {
    if (!isPlainObject(rawProfile)) throw configError('invalid-profile', 'each profile must be an object');
    const id = normalizeProfileId(rawProfile.id);
    if (ids.has(id)) throw configError('duplicate-profile-id', `duplicate profile.id: ${id}`);
    ids.add(id);
    const name = boundedSingleLine(rawProfile.name, `profile ${id} name`, MAX_PROFILE_NAME_LENGTH);
    const codexHome = normalizeAbsolutePath(rawProfile.codexHome);
    const enabled = rawProfile.enabled === undefined ? true : rawProfile.enabled;
    if (typeof enabled !== 'boolean') throw configError('invalid-profile', `profile ${id} enabled must be boolean`);

    if (enabled) {
      const identity = pathIdentity(codexHome, options);
      const previous = enabledHomeIdentities.get(identity);
      if (previous) {
        throw configError('duplicate-codex-home', `enabled profiles ${previous} and ${id} share a Codex home`);
      }
      enabledHomeIdentities.set(identity, id);
    }

    // Deliberately copy only the public, non-secret profile contract. Unknown
    // fields are not retained and therefore cannot reach a server snapshot.
    return Object.freeze({ id, name, codexHome, enabled });
  });

  return Object.freeze({
    version: CONFIG_VERSION,
    deviceName,
    ...(endpoint ? { endpoint } : {}),
    profiles: Object.freeze(profiles)
  });
}

function loadServerAgentConfig(filePath, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const wrapped = configError('config-read-failed', `could not read server-agent config: ${error.code || 'invalid-json'}`);
    wrapped.cause = error;
    throw wrapped;
  }
  return parseServerAgentConfig(parsed, options);
}

module.exports = {
  CONFIG_VERSION,
  MAX_PROFILE_ID_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  PROFILE_ID_RE,
  configError,
  loadServerAgentConfig,
  normalizeProfileId,
  parseServerAgentConfig,
  pathIdentity
};
