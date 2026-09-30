'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const MAX_HOOKS_BYTES = 256 * 1024;

function configPathFor(codexHome) {
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) {
    throw new TypeError('codexHome must be an absolute path');
  }
  return path.join(codexHome, 'hooks.json');
}

function assertCodexHomeSafe(codexHome, fsApi) {
  try {
    const stat = fsApi.lstatSync(codexHome);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Codex home must be a real directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function readConfig(configPath, fsApi) {
  let stat;
  try {
    stat = fsApi.lstatSync(configPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, raw: null, value: { hooks: {} } };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex hooks.json must be a regular file');
  if (stat.size > MAX_HOOKS_BYTES) throw new Error(`Codex hooks.json exceeds ${MAX_HOOKS_BYTES} bytes`);
  const constants = fsApi.constants || nodeFs.constants;
  let descriptor;
  try {
    descriptor = fsApi.openSync(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const descriptorStat = fsApi.fstatSync(descriptor);
    if (!descriptorStat.isFile() || descriptorStat.size > MAX_HOOKS_BYTES) {
      throw new Error('Codex hooks.json must be a bounded regular file');
    }
    const raw = fsApi.readFileSync(descriptor, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex hooks.json must contain an object');
    return { exists: true, raw, value };
  } finally {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
  }
}

function commandValue(entry) {
  return entry && typeof entry === 'object' && entry.type === 'command' ? entry.command : null;
}

function identityDetails(commandIdentity) {
  if (typeof commandIdentity === 'string') {
    return { command: commandIdentity, commandWindows: null, legacyCommands: [] };
  }
  return {
    command: commandIdentity?.command,
    commandWindows: commandIdentity?.commandWindows || null,
    legacyCommands: Array.isArray(commandIdentity?.legacyCommands) ? commandIdentity.legacyCommands : [],
    runtimePath: commandIdentity?.runtimePath
  };
}

function handlerMatchesCurrent(entry, commandIdentity) {
  const identity = identityDetails(commandIdentity);
  if (commandValue(entry) !== identity.command) return false;
  return !identity.commandWindows || entry.commandWindows === identity.commandWindows;
}

// Accept only the historical formal forwarder template targeting this runtime.
function historicalForwarderMatches(command, runtimePath) {
  if (typeof command !== 'string' || typeof runtimePath !== 'string' || !path.isAbsolute(runtimePath)) return false;
  const prefix = 'powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand ';
  if (!command.startsWith(prefix)) return false;
  const encoded = command.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const invocation = script.match(/\$payload \| & '((?:[^']|'')+)' '((?:[^']|'')+)' '((?:[^']|'')+)'; exit \$LASTEXITCODE$/);
  if (!invocation) return false;
  const [executable, helper, runtime] = invocation.slice(1).map((value) => value.replaceAll("''", "'"));
  if (![executable, helper].every((value) => path.win32.isAbsolute(value))) return false;
  if (!/[\\/]src[\\/]electron[\\/]codexHookForwarder\.js$/.test(helper) || runtime !== runtimePath) return false;
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const expected = ["$ProgressPreference = 'SilentlyContinue'", '$utf8 = [System.Text.UTF8Encoding]::new($false)', '[Console]::InputEncoding = $utf8', '$OutputEncoding = $utf8', '$payload = [Console]::In.ReadToEnd()', "$env:ELECTRON_RUN_AS_NODE = '1'", '$payload | & ' + [executable, helper, runtime].map(quote).join(' '), 'exit $LASTEXITCODE'].join('; ');
  return script === expected && Buffer.from(expected, 'utf16le').toString('base64') === encoded;
}

function isPotatoOwnedStopHook(entry, commandIdentity) {
  const identity = identityDetails(commandIdentity);
  const candidates = new Set([identity.command, identity.commandWindows, ...identity.legacyCommands].filter(Boolean));
  // An unknown alternate platform command must not be discarded with an owned one.
  if (entry?.type !== 'command') return false;
  const commands = [entry.command, entry.commandWindows].filter((value) => value !== undefined && value !== null);
  return commands.length > 0 && commands.every((command) => candidates.has(command)
    || historicalForwarderMatches(command, identity.runtimePath));
}

function containsCommand(config, identity) {
  return (config?.hooks?.Stop || []).some((group) => (
    Array.isArray(group?.hooks) && group.hooks.some((entry) => handlerMatchesCurrent(entry, identity))
  ));
}

function hookState(configPath, enabled, backupPath = null, error = null) {
  return { enabled, needsTrust: enabled, configPath, backupPath, error };
}

function readCodexHookState({ codexHome, commandIdentity, fs: fsApi = nodeFs }) {
  const configPath = configPathFor(codexHome);
  try {
    assertCodexHomeSafe(codexHome, fsApi);
    return hookState(configPath, containsCommand(readConfig(configPath, fsApi).value, commandIdentity));
  } catch (error) {
    return hookState(configPath, false, null, error.message || String(error), null);
  }
}

function assertDestinationSafe(filePath, fsApi) {
  try {
    const stat = fsApi.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex hooks.json must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeAtomic(filePath, value, fsApi, expectedRaw) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    descriptor = fsApi.openSync(temporary, 'wx', 0o600);
    fsApi.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = undefined;
    assertDestinationSafe(filePath, fsApi);
    if (readConfig(filePath, fsApi).raw !== expectedRaw) throw new Error('Codex hooks.json changed during reconciliation');
    fsApi.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsApi.closeSync(descriptor); } catch (_) {}
    }
    try { fsApi.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function backupExisting(configPath, raw, fsApi) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${configPath}.token-m-backup-${stamp}`;
  let suffix = 0;
  while (true) {
    try {
      fsApi.writeFileSync(candidate, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      suffix += 1;
      candidate = `${configPath}.token-m-backup-${stamp}-${suffix}`;
    }
  }
}

function enableCodexStopHook({ codexHome, command, commandWindows, legacyCommands = [], runtimePath, backup = true, fs: fsApi = nodeFs }) {
  const configPath = configPathFor(codexHome);
  let createdBackupPath = null;
  try {
    assertCodexHomeSafe(codexHome, fsApi);
    if (typeof command !== 'string' || !command.trim()) throw new TypeError('Hook command is required');
    if (commandWindows !== undefined && commandWindows !== null
      && (typeof commandWindows !== 'string' || !commandWindows.trim())) {
      throw new TypeError('Windows hook command must be a non-empty string');
    }
    const identity = { command, commandWindows, legacyCommands, runtimePath };
    const document = readConfig(configPath, fsApi);
    const value = structuredClone(document.value);
    if (value.hooks === undefined) value.hooks = {};
    if (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks)) throw new Error('hooks must be an object');
    if (value.hooks.Stop === undefined) value.hooks.Stop = [];
    if (!Array.isArray(value.hooks.Stop)) throw new Error('hooks.Stop must be an array');
    let retainedCurrent = false;
    value.hooks.Stop = value.hooks.Stop.flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter((entry) => {
        if (!isPotatoOwnedStopHook(entry, identity)) return true;
        if (!retainedCurrent && group.matcher === '' && handlerMatchesCurrent(entry, identity)) {
          retainedCurrent = true;
          return true;
        }
        return false;
      });
      return hooks.length || group.hooks.length === 0 ? [{ ...group, hooks }] : [];
    });
    if (!retainedCurrent) {
      value.hooks.Stop.push({
        matcher: '',
        hooks: [{ type: 'command', command, ...(commandWindows ? { commandWindows } : {}), timeout: 5 }]
      });
    }
    if (JSON.stringify(value) === JSON.stringify(document.value)) return hookState(configPath, true);
    const backupPath = document.exists && backup ? backupExisting(configPath, document.raw, fsApi) : null;
    createdBackupPath = backupPath;
    writeAtomic(configPath, value, fsApi, document.raw);
    return hookState(configPath, true, backupPath);
  } catch (error) {
    return hookState(configPath, false, createdBackupPath, error.message || String(error), null);
  }
}

function disableCodexStopHook({ codexHome, commandIdentity, backup = true, fs: fsApi = nodeFs }) {
  const configPath = configPathFor(codexHome);
  try {
    assertCodexHomeSafe(codexHome, fsApi);
    const identity = identityDetails(commandIdentity);
    if (!identity.command) throw new TypeError('commandIdentity is required');
    const document = readConfig(configPath, fsApi);
    const hasMatchingHandler = (document.value?.hooks?.Stop || []).some((group) => (
      Array.isArray(group?.hooks) && group.hooks.some((entry) => isPotatoOwnedStopHook(entry, identity))
    ));
    if (!document.exists || !hasMatchingHandler) return hookState(configPath, false);
    const value = structuredClone(document.value);
    value.hooks.Stop = value.hooks.Stop.flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter((entry) => !isPotatoOwnedStopHook(entry, identity));
      if (hooks.length === 0 && group.hooks.length !== 0) return [];
      return [{ ...group, hooks }];
    });
    const backupPath = backup ? backupExisting(configPath, document.raw, fsApi) : null;
    writeAtomic(configPath, value, fsApi, document.raw);
    return hookState(configPath, false, backupPath);
  } catch (error) {
    return hookState(configPath, false, null, error.message || String(error), null);
  }
}

module.exports = {
  isPotatoOwnedStopHook,
  disableCodexStopHook,
  enableCodexStopHook,
  readCodexHookState
};
