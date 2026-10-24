'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICE_BACKENDS = Object.freeze([
  'systemd-user',
  'supervisord',
  'container-external',
  'none'
]);
const SUPERVISOR_CONFIG_CANDIDATES = Object.freeze([
  '/etc/supervisord.conf',
  '/etc/supervisor/supervisord.conf',
  '/usr/local/etc/supervisord.conf'
]);
const MAX_PROC_BYTES = 8192;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;

function commandResult(status, stdout = '', stderr = '', errorCode = null) {
  return { status, stdout: String(stdout || ''), stderr: String(stderr || ''), errorCode };
}

function readBoundedFile(filePath, maxBytes, fsApi = fs) {
  let fd;
  try {
    fd = fsApi.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsApi.closeSync(fd); } catch (_) { /* best effort */ }
    }
  }
}

function findExecutable(name, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  const directories = pathValue.split(pathApi.delimiter).filter(Boolean);
  const suffixes = options.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];

  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = pathApi.join(directory, `${name}${suffix}`);
      try {
        if (!fsApi.statSync(candidate).isFile()) continue;
        if (options.platform !== 'win32') fsApi.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) {
        // Continue searching PATH without exposing filesystem details.
      }
    }
  }
  return null;
}

function createCommandRunner(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  return (name, args = [], limits = {}) => {
    const executable = findExecutable(name, { fsApi, pathApi, env, platform });
    if (!executable) return commandResult(null, '', '', 'command_missing');
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      env,
      timeout: limits.timeoutMs || 1500,
      maxBuffer: limits.maxBuffer || MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error) return commandResult(null, '', '', result.error.code || 'command_failed');
    const stdout = String(result.stdout || '').slice(0, MAX_COMMAND_OUTPUT_BYTES);
    const stderr = String(result.stderr || '').slice(0, MAX_COMMAND_OUTPUT_BYTES);
    return commandResult(result.status, stdout, stderr, null);
  };
}

function hasRegularFile(fsApi, filePath) {
  try {
    const stat = fsApi.statSync(filePath);
    return stat.isFile();
  } catch (_) {
    return false;
  }
}

function isSafeAbsolutePath(value, pathApi = path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  if (/[\0-\x1f\x7f]/.test(value) || !pathApi.isAbsolute(value)) return false;
  return true;
}

function parsePid1Arguments(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.length > MAX_PROC_BYTES) return [];
  return commandLine.split('\0').filter(Boolean).slice(0, 128).map((part) => part.slice(0, 4096));
}

function supervisorConfigFromPid1(commandLine, pathApi = path) {
  const args = parsePid1Arguments(commandLine);
  if (args.length === 0 || pathApi.basename(args[0]).toLowerCase() !== 'supervisord') return null;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-c' || argument === '--configuration') {
      const candidate = args[index + 1];
      return isSafeAbsolutePath(candidate, pathApi) ? pathApi.normalize(candidate) : null;
    }
    if (argument.startsWith('--configuration=')) {
      const candidate = argument.slice('--configuration='.length);
      return isSafeAbsolutePath(candidate, pathApi) ? pathApi.normalize(candidate) : null;
    }
    if (argument.startsWith('-c') && argument.length > 2) {
      const candidate = argument.slice(2);
      return isSafeAbsolutePath(candidate, pathApi) ? pathApi.normalize(candidate) : null;
    }
  }
  return null;
}

function pid1Information(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const commandLine = readBoundedFile('/proc/1/cmdline', MAX_PROC_BYTES, fsApi) || '';
  const args = parsePid1Arguments(commandLine);
  const comm = (readBoundedFile('/proc/1/comm', 256, fsApi) || '').trim().toLowerCase();
  const argvName = args.length > 0 ? pathApi.basename(args[0]).toLowerCase() : '';
  const processName = comm || argvName || 'unknown';
  const knownManager = ['supervisord', 'systemd', 'tini', 's6-svscan', 'dumb-init'].includes(processName);
  return {
    name: knownManager ? processName.trim() : (processName && processName !== 'unknown' ? 'other' : 'unknown'),
    rawProcessName: processName,
    commandLine,
    supervisorConfig: supervisorConfigFromPid1(commandLine, pathApi)
  };
}

function readConfigText(filePath, fsApi = fs) {
  try {
    const stat = fsApi.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const text = fsApi.readFileSync(filePath, 'utf8');
    return Buffer.byteLength(text, 'utf8') <= MAX_CONFIG_BYTES ? text : null;
  } catch (_) {
    return null;
  }
}

function tokenizeIncludeFiles(value) {
  const tokens = [];
  let token = '';
  let quote = '';
  let escaped = false;
  for (const character of String(value || '')) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

function parseSupervisorIncludePatterns(configText, configPath, options = {}) {
  const pathApi = options.pathApi || path;
  const lines = String(configText || '').split(/\r?\n/);
  let inInclude = false;
  let filesValue = '';
  let readingFiles = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (section) {
      inInclude = section[1].trim().toLowerCase() === 'include';
      readingFiles = false;
      continue;
    }
    if (!inInclude || /^\s*[#;]/.test(line) || !line.trim()) continue;
    const field = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (field) {
      readingFiles = field[1].toLowerCase() === 'files';
      if (readingFiles) filesValue += ` ${field[2]}`;
      continue;
    }
    if (readingFiles && /^\s+/.test(line)) filesValue += ` ${line.trim()}`;
  }

  const baseDirectory = pathApi.dirname(configPath);
  const patterns = [];
  for (const token of tokenizeIncludeFiles(filesValue)) {
    if (token.length > 4096 || /[\0-\x1f\x7f]/.test(token)) continue;
    const absolutePattern = pathApi.normalize(pathApi.isAbsolute(token)
      ? token
      : pathApi.resolve(baseDirectory, token));
    const segments = absolutePattern.split(pathApi.sep).filter(Boolean);
    const wildcardIndices = [];
    segments.forEach((segment, index) => {
      if (segment.includes('*') || segment.includes('?') || segment.includes('[') || segment.includes(']')) {
        wildcardIndices.push(index);
      }
    });
    if (wildcardIndices.some((index) => index !== segments.length - 1)) continue;
    const wildcard = wildcardIndices.length === 1;
    patterns.push({
      absolutePattern,
      directory: pathApi.dirname(absolutePattern),
      basenamePattern: pathApi.basename(absolutePattern),
      wildcard
    });
  }
  return patterns;
}

function globBasenameMatches(pattern, candidate) {
  if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[') && !pattern.includes(']')) {
    return pattern === candidate;
  }
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else if (character === '[') {
      const closing = pattern.indexOf(']', index + 1);
      if (closing === -1) expression += '\\[';
      else {
        expression += pattern.slice(index, closing + 1);
        index = closing;
      }
    } else expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  expression += '$';
  try { return new RegExp(expression).test(candidate); } catch (_) { return false; }
}

function safeWritableDirectory(directory, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  try {
    const lstat = fsApi.lstatSync(directory);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return false;
    const realPath = fsApi.realpathSync(directory);
    if (pathApi.normalize(realPath) !== pathApi.normalize(pathApi.resolve(directory))) return false;
    fsApi.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function discoverSupervisorIncludes(configPath, configText, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const patterns = parseSupervisorIncludePatterns(configText, configPath, { pathApi });
  const usable = patterns.filter((pattern) => safeWritableDirectory(pattern.directory, { fsApi, pathApi }));
  const uniqueDirectories = [...new Set(usable.map((pattern) => pathApi.normalize(pattern.directory)))];
  const managedFilenamePatterns = usable.filter((pattern) => globBasenameMatches(pattern.basenamePattern, 'toknow-agent.conf'));
  const matchingDirs = [...new Set(managedFilenamePatterns.map((pattern) => pathApi.normalize(pattern.directory)))];
  let reason = null;
  let directory = null;
  if (patterns.length === 0) reason = 'supervisor_include_unavailable';
  else if (uniqueDirectories.length === 0) reason = 'supervisor_include_unavailable';
  else if (matchingDirs.length !== 1 || uniqueDirectories.length !== 1) reason = 'supervisor_include_ambiguous';
  else directory = matchingDirs[0];
  return { available: Boolean(directory), directory, reason, patterns };
}

function listSupervisorIncludedConfigFiles(configPath, configText, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const files = [];
  for (const pattern of parseSupervisorIncludePatterns(configText, configPath, { pathApi })) {
    try {
      if (!pattern.wildcard) {
        if (hasRegularFile(fsApi, pattern.absolutePattern)) files.push(pattern.absolutePattern);
        continue;
      }
      for (const entry of fsApi.readdirSync(pattern.directory, { withFileTypes: true })) {
        if (!globBasenameMatches(pattern.basenamePattern, entry.name) || !entry.isFile()) continue;
        files.push(pathApi.join(pattern.directory, entry.name));
      }
    } catch (_) {
      // Unreadable include entries do not become evidence that a program is safe.
    }
  }
  return [...new Set(files)];
}

function configHasProgram(configText, programName) {
  const escaped = String(programName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`^\\s*\\[program:${escaped}\\]\\s*(?:[#;].*)?$`, 'im');
  return expression.test(String(configText || ''));
}

function configHasManagedMarker(configText) {
  return /^\s*[#;]\s*Managed by To Know Server Agent installer\.?\s*$/im.test(String(configText || ''));
}

function extractVersion(output) {
  const match = String(output || '').slice(0, 256).match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)\b/);
  return match ? match[1] : null;
}

function isSuccessful(result) {
  return Boolean(result && result.status === 0 && !result.errorCode);
}

function resolveSupervisorConfig(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const pid1 = options.pid1 || pid1Information({ fsApi, pathApi });
  const explicit = options.supervisorConfig;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return isSafeAbsolutePath(explicit, pathApi) && hasRegularFile(fsApi, explicit)
      ? pathApi.normalize(explicit)
      : null;
  }
  const candidates = [];
  if (pid1.name === 'supervisord' && pid1.supervisorConfig) candidates.push(pid1.supervisorConfig);
  if (isSafeAbsolutePath(env.SUPERVISOR_CONFIG, pathApi)) candidates.push(pathApi.normalize(env.SUPERVISOR_CONFIG));
  if (pid1.supervisorConfig) candidates.push(pid1.supervisorConfig);
  candidates.push(...SUPERVISOR_CONFIG_CANDIDATES);
  for (const candidate of candidates) {
    if (isSafeAbsolutePath(candidate, pathApi) && hasRegularFile(fsApi, candidate)) return pathApi.normalize(candidate);
  }
  return null;
}

function inspectSupervisorBackend(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const commandAvailable = options.commandAvailable || ((name) => Boolean(findExecutable(name, {
    fsApi, pathApi, env, platform: options.platform || process.platform
  })));
  const runCommand = options.runCommand || createCommandRunner({
    fsApi, pathApi, env, platform: options.platform || process.platform
  });
  const pid1 = options.pid1 || pid1Information({ fsApi, pathApi });
  const supervisordBinaryPresent = commandAvailable('supervisord');
  const supervisorctlBinaryPresent = commandAvailable('supervisorctl');
  const configPath = resolveSupervisorConfig({ ...options, fsApi, pathApi, env, pid1 });
  const configText = configPath ? readConfigText(configPath, fsApi) : null;
  const include = configText && configPath
    ? discoverSupervisorIncludes(configPath, configText, { fsApi, pathApi })
    : { available: false, directory: null, reason: 'supervisor_include_unavailable', patterns: [] };

  let version = null;
  if (supervisordBinaryPresent) {
    const versionResult = runCommand('supervisord', ['--version'], { timeoutMs: 1500, maxBuffer: 1024 });
    if (isSuccessful(versionResult)) version = extractVersion(versionResult.stdout);
  }

  let controlAvailable = false;
  if (supervisorctlBinaryPresent && configPath) {
    const controlResult = runCommand('supervisorctl', ['-c', configPath, 'status'], {
      timeoutMs: 2000,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES
    });
    controlAvailable = isSuccessful(controlResult);
  }

  const processManagerDetected = pid1.name === 'supervisord' || controlAvailable;
  const managedInstallAvailable = Boolean(controlAvailable && include.available);
  let reason = null;
  if (!supervisordBinaryPresent) reason = 'supervisord_binary_missing';
  else if (!supervisorctlBinaryPresent) reason = 'supervisorctl_binary_missing';
  else if (!configPath) reason = 'primary_config_unavailable';
  else if (!controlAvailable) reason = 'control_socket_unavailable';
  else if (!include.available) reason = include.reason || 'supervisor_include_unavailable';

  return {
    report: {
      available: managedInstallAvailable,
      processManagerDetected,
      supervisordBinaryPresent,
      supervisorctlBinaryPresent,
      version,
      configDiscovered: Boolean(configPath),
      includeDirectoryAvailable: include.available,
      controlAvailable,
      managedInstallAvailable,
      reason
    },
    configPath,
    configText,
    includeDirectory: include.directory,
    includeReason: include.reason,
    includePatterns: include.patterns,
    pid1
  };
}

function readContainerEvidence(options = {}) {
  const fsApi = options.fsApi || fs;
  const env = options.env || process.env;
  const dockerenv = hasRegularFile(fsApi, '/.dockerenv');
  const cgroup = readBoundedFile('/proc/1/cgroup', MAX_PROC_BYTES, fsApi) || '';
  const cgroupDocker = /(?:^|[/:.-])docker(?:[/:.-]|$)|docker-[0-9a-f]{6,}/i.test(cgroup);
  const cgroupKubernetes = /kubepods/i.test(cgroup);
  const cgroupContainerd = /containerd/i.test(cgroup);
  const kubernetes = Boolean((typeof env.KUBERNETES_SERVICE_HOST === 'string'
    && env.KUBERNETES_SERVICE_HOST.trim()) || cgroupKubernetes);
  const container = Boolean(dockerenv || cgroupDocker || cgroupKubernetes || cgroupContainerd || kubernetes);
  const containerType = kubernetes ? 'kubernetes'
    : (dockerenv || cgroupDocker) ? 'docker'
      : cgroupContainerd ? 'containerd'
        : container ? 'unknown' : null;
  return { container, containerType, kubernetes };
}

function systemdUserBackend(options = {}) {
  const env = options.env || process.env;
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const commandAvailable = options.commandAvailable || ((name) => Boolean(findExecutable(name, {
    fsApi, pathApi, env, platform: options.platform || process.platform
  })));
  const runCommand = options.runCommand || createCommandRunner({
    fsApi, pathApi, env, platform: options.platform || process.platform
  });
  const binaryPresent = commandAvailable('systemctl');
  let userManagerReachable = false;
  let userManagerState = binaryPresent ? 'unavailable' : 'unknown';
  if (binaryPresent) {
    const probe = runCommand('systemctl', ['--user', 'show-environment'], {
      timeoutMs: 1500,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES
    });
    userManagerReachable = isSuccessful(probe);
    if (!userManagerReachable) userManagerState = 'offline';
    else {
      const state = runCommand('systemctl', ['--user', 'is-system-running'], {
        timeoutMs: 1500,
        maxBuffer: 1024
      });
      const normalized = String(state.stdout || '').trim().toLowerCase();
      userManagerState = ['running', 'degraded', 'starting', 'maintenance', 'stopping'].includes(normalized)
        ? normalized
        : 'reachable';
    }
  }
  return {
    available: userManagerReachable,
    binaryPresent,
    userManagerReachable,
    userManagerState,
    reason: userManagerReachable ? null : binaryPresent ? 'user_manager_unavailable' : 'systemctl_binary_missing'
  };
}

function decodeMountPath(value) {
  return String(value || '').replace(/\\(040|011|012|134)/g, (_, code) => ({
    '040': ' ', '011': '\t', '012': '\n', '134': '\\'
  }[code]));
}

function mountTypeForPath(targetPath, mountInfo, pathApi = path) {
  if (!isSafeAbsolutePath(targetPath, pathApi)) return 'unknown';
  let selected = null;
  for (const line of String(mountInfo || '').split(/\r?\n/)) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before.length < 5 || after.length < 1) continue;
    const mountPoint = pathApi.normalize(decodeMountPath(before[4]));
    const normalizedTarget = pathApi.normalize(targetPath);
    const covers = normalizedTarget === mountPoint
      || normalizedTarget.startsWith(mountPoint.endsWith(pathApi.sep) ? mountPoint : `${mountPoint}${pathApi.sep}`);
    if (!covers || (selected && mountPoint.length <= selected.mountPoint.length)) continue;
    selected = { mountPoint, fileSystem: after[0].toLowerCase() };
  }
  if (!selected) return 'unknown';
  if (/^(?:ceph|ceph-fuse|fuse\.ceph-fuse|nfs|nfs4|cifs|glusterfs)$/.test(selected.fileSystem)) return 'persistent-volume-supported';
  if (selected.fileSystem === 'overlay' || selected.fileSystem === 'overlayfs') {
    return 'ephemeral_or_orchestrator_managed';
  }
  return 'unknown';
}

function getPersistenceReport(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const home = isSafeAbsolutePath(env.HOME, pathApi) ? pathApi.normalize(env.HOME) : null;
  const mountInfo = readBoundedFile('/proc/self/mountinfo', 256 * 1024, fsApi) || '';
  const configRoot = home ? (isSafeAbsolutePath(env.XDG_CONFIG_HOME, pathApi)
    ? pathApi.join(pathApi.normalize(env.XDG_CONFIG_HOME), 'toknow-agent')
    : pathApi.join(home, '.config', 'toknow-agent')) : null;
  const dataRoot = home ? pathApi.join(
    isSafeAbsolutePath(env.XDG_DATA_HOME, pathApi) ? pathApi.normalize(env.XDG_DATA_HOME) : pathApi.join(home, '.local', 'share'),
    'toknow-agent'
  ) : null;
  const stateRoot = home ? pathApi.join(
    isSafeAbsolutePath(env.XDG_STATE_HOME, pathApi) ? pathApi.normalize(env.XDG_STATE_HOME) : pathApi.join(home, '.local', 'state'),
    'toknow-agent'
  ) : null;
  return {
    processRestart: 'unknown',
    sessionLogout: 'unknown',
    hostReboot: 'unknown',
    containerRestart: 'unknown',
    containerRecreate: 'unknown',
    configPersistence: configRoot ? mountTypeForPath(configRoot, mountInfo, pathApi) : 'unknown',
    runtimeDataPersistence: dataRoot && stateRoot
      ? [mountTypeForPath(dataRoot, mountInfo, pathApi), mountTypeForPath(stateRoot, mountInfo, pathApi)]
        .every((value) => value === 'persistent-volume-supported')
        ? 'persistent-volume-supported'
        : ([mountTypeForPath(dataRoot, mountInfo, pathApi), mountTypeForPath(stateRoot, mountInfo, pathApi)]
          .includes('ephemeral_or_orchestrator_managed') ? 'ephemeral_or_orchestrator_managed' : 'unknown')
      : 'unknown'
  };
}

function stableRuntimeCommand(home, pathApi = path) {
  const stableLauncher = isSafeAbsolutePath(home, pathApi)
    ? pathApi.join(pathApi.normalize(home), '.local', 'bin', 'toknow-agent')
    : '~/.local/bin/toknow-agent';
  return [stableLauncher, 'run'];
}

function detectServiceEnvironment(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const pid1 = options.pid1 || pid1Information({ fsApi, pathApi });
  const container = readContainerEvidence({ fsApi, env });
  const systemd = systemdUserBackend({ ...options, fsApi, pathApi, env });
  const supervisor = inspectSupervisorBackend({ ...options, fsApi, pathApi, env, pid1 });
  const containerExternal = {
    available: container.container,
    reason: container.container ? null : 'container_orchestrator_not_detected'
  };
  const none = { available: true, autoRestart: false, productionDaemonConfigured: false };

  let recommended = 'none';
  if (supervisor.report.managedInstallAvailable) recommended = 'supervisord';
  else if (systemd.available && !container.container) recommended = 'systemd-user';
  else if (containerExternal.available) recommended = 'container-external';
  else if (systemd.available) recommended = 'systemd-user';

  const persistence = getPersistenceReport({ fsApi, pathApi, env });
  persistence.processRestart = recommended === 'none' ? 'manual'
    : recommended === 'container-external' ? 'orchestrator-managed'
      : 'service-manager-managed';
  persistence.serviceManagerConfig = supervisor.configPath
    ? mountTypeForPath(supervisor.configPath, readBoundedFile('/proc/self/mountinfo', 256 * 1024, fsApi) || '', pathApi)
    : 'unknown';

  const command = stableRuntimeCommand(env.HOME, pathApi);
  return {
    environment: {
      container: container.container,
      containerType: container.containerType,
      kubernetes: container.kubernetes,
      processManager: pid1.name
    },
    backends: {
      'systemd-user': systemd,
      supervisord: supervisor.report,
      'container-external': containerExternal,
      none
    },
    recommended,
    runtimeContract: {
      command,
      stopSignal: 'SIGTERM',
      stopTimeoutSeconds: 15,
      restartRecommended: recommended === 'container-external' ? 'always/on-failure' : null,
      requiredPersistentRoots: ['~/.config/toknow-agent', '~/.local/share/toknow-agent', '~/.local/state/toknow-agent'],
      persistence
    }
  };
}

module.exports = {
  MAX_CONFIG_BYTES,
  MAX_PROC_BYTES,
  SERVICE_BACKENDS,
  SUPERVISOR_CONFIG_CANDIDATES,
  configHasManagedMarker,
  configHasProgram,
  createCommandRunner,
  decodeMountPath,
  detectServiceEnvironment,
  discoverSupervisorIncludes,
  findExecutable,
  globBasenameMatches,
  inspectSupervisorBackend,
  isSafeAbsolutePath,
  listSupervisorIncludedConfigFiles,
  mountTypeForPath,
  parsePid1Arguments,
  parseSupervisorIncludePatterns,
  pid1Information,
  readBoundedFile,
  readConfigText,
  readContainerEvidence,
  resolveSupervisorConfig,
  safeWritableDirectory,
  stableRuntimeCommand,
  supervisorConfigFromPid1,
  systemdUserBackend,
  tokenizeIncludeFiles
};
