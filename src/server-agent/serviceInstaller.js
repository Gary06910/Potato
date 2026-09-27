'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  configHasManagedMarker,
  configHasProgram,
  createCommandRunner,
  inspectSupervisorBackend,
  isSafeAbsolutePath,
  listSupervisorIncludedConfigFiles,
  readConfigText
} = require('./serviceDetection');

const MANAGED_PROGRAM = 'toknow-agent';
const MANAGED_CONFIG_NAME = 'toknow-agent.conf';
const MARKER = 'Managed by To Know Server Agent installer';

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error, fallback = 'service_install_failed') {
  const code = String(error?.code || fallback);
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : fallback;
}

function quoteSupervisorArgument(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function validateStableLauncher(launcherPath, pathApi = path) {
  if (!isSafeAbsolutePath(launcherPath, pathApi) || pathApi.basename(launcherPath) !== 'toknow-agent') {
    throw serviceError('invalid_stable_launcher');
  }
  if (/(?:^|[/\\])v?\d+\.\d+\.\d+(?:[/\\]|$)/.test(launcherPath)) {
    throw serviceError('version_specific_launcher_refused');
  }
}

function generateSupervisorConfig({ template, launcherPath, pathApi = path }) {
  validateStableLauncher(launcherPath, pathApi);
  if (typeof template !== 'string' || Buffer.byteLength(template, 'utf8') > 64 * 1024) {
    throw serviceError('invalid_supervisor_template');
  }
  if (!template.includes('@STABLE_LAUNCHER@') || !template.includes(`[program:${MANAGED_PROGRAM}]`)
    || !template.includes(MARKER)) {
    throw serviceError('invalid_supervisor_template');
  }
  return template.replaceAll('@STABLE_LAUNCHER@', quoteSupervisorArgument(launcherPath));
}

function runSupervisorctl(runCommand, configPath, commandArgs, failureCode) {
  const result = runCommand('supervisorctl', ['-c', configPath, ...commandArgs], {
    timeoutMs: 5000,
    maxBuffer: 16 * 1024
  });
  if (!result || result.status !== 0 || result.errorCode) throw serviceError(failureCode);
  return result;
}

function supervisorDependencies(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const commandAvailable = options.commandAvailable || options.detection?.commandAvailable;
  const runCommand = options.runCommand || options.detection?.runCommand || createCommandRunner({
    fsApi,
    pathApi,
    env,
    platform: options.platform || process.platform
  });
  const inspect = inspectSupervisorBackend({
    fsApi,
    pathApi,
    env,
    platform: options.platform,
    commandAvailable,
    runCommand,
    supervisorConfig: options.supervisorConfig
  });
  if (!inspect.configPath) throw serviceError('primary_config_unavailable');
  if (!inspect.report.controlAvailable) throw serviceError('control_socket_unavailable');
  if (!inspect.report.includeDirectoryAvailable || !inspect.includeDirectory) {
    throw serviceError(inspect.includeReason || 'supervisor_include_unavailable');
  }
  return { fsApi, pathApi, env, inspect, runCommand };
}

function readExistingText(filePath, fsApi) {
  try {
    const stat = fsApi.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 256 * 1024) {
      throw serviceError('unknown_supervisor_config_refused');
    }
    return fsApi.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)) throw error;
    throw serviceError('unknown_supervisor_config_refused');
  }
}

function assertManagedConfigOrAbsent(targetPath, options) {
  const existing = readExistingText(targetPath, options.fsApi);
  if (existing === null) return { exists: false, content: null };
  if (!configHasManagedMarker(existing) || !configHasProgram(existing, MANAGED_PROGRAM)) {
    throw serviceError('unknown_supervisor_config_refused');
  }
  return { exists: true, content: existing };
}

function findConflictingProgram(targetPath, options) {
  const { inspect, fsApi } = options;
  const configFiles = [inspect.configPath, ...listSupervisorIncludedConfigFiles(
    inspect.configPath,
    inspect.configText,
    { fsApi, pathApi: options.pathApi }
  )];
  for (const filePath of [...new Set(configFiles)]) {
    if (options.pathApi.normalize(filePath) === options.pathApi.normalize(targetPath)) continue;
    const content = readConfigText(filePath, fsApi);
    if (content && configHasProgram(content, MANAGED_PROGRAM)) return true;
  }
  return false;
}

function writeManagedConfig(targetPath, content, options) {
  const { fsApi } = options;
  const current = assertManagedConfigOrAbsent(targetPath, options);
  if (current.exists && current.content === content) return false;
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let tempCreated = false;
  try {
    fsApi.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    tempCreated = true;
    if (current.exists) {
      const recheck = assertManagedConfigOrAbsent(targetPath, options);
      if (!recheck.exists) throw serviceError('unknown_supervisor_config_refused');
      fsApi.renameSync(tempPath, targetPath);
      tempCreated = false;
    } else {
      try {
        fsApi.linkSync(tempPath, targetPath);
        fsApi.unlinkSync(tempPath);
        tempCreated = false;
      } catch (error) {
        if (error.code === 'EEXIST') throw serviceError('unknown_supervisor_config_refused');
        if (typeof fsApi.linkSync !== 'function') {
          fsApi.writeFileSync(targetPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
          fsApi.unlinkSync(tempPath);
          tempCreated = false;
        } else throw error;
      }
    }
  } catch (error) {
    if (tempCreated) {
      try { fsApi.unlinkSync(tempPath); } catch (_) { /* only the exact generated temp file */ }
    }
    if (error.code && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)) throw error;
    throw serviceError('supervisor_config_write_failed');
  }
  return true;
}

function validateSupervisordService(options = {}) {
  const { fsApi, pathApi, inspect, runCommand } = supervisorDependencies(options);
  const launcherPath = options.launcherPath;
  validateStableLauncher(launcherPath, pathApi);
  const targetPath = pathApi.join(inspect.includeDirectory, MANAGED_CONFIG_NAME);
  assertManagedConfigOrAbsent(targetPath, { fsApi });
  if (findConflictingProgram(targetPath, { inspect, fsApi, pathApi })) {
    throw serviceError('unknown_existing_program_refused');
  }
  const template = options.templateContent === undefined
    ? fsApi.readFileSync(options.templatePath, 'utf8')
    : options.templateContent;
  const generatedConfig = generateSupervisorConfig({ template, launcherPath, pathApi });
  return { fsApi, pathApi, inspect, runCommand, targetPath, generatedConfig };
}

function installSupervisordService(options = {}) {
  const { fsApi, pathApi, inspect, runCommand, targetPath, generatedConfig } = validateSupervisordService(options);
  writeManagedConfig(targetPath, generatedConfig, { fsApi, pathApi });

  runSupervisorctl(runCommand, inspect.configPath, ['reread'], 'supervisor_reread_failed');
  runSupervisorctl(
    runCommand,
    inspect.configPath,
    ['update', MANAGED_PROGRAM],
    'supervisor_update_failed'
  );
  const status = runSupervisorctl(
    runCommand,
    inspect.configPath,
    ['status', MANAGED_PROGRAM],
    'supervisor_status_failed'
  );
  if (!new RegExp(`^${MANAGED_PROGRAM}\\s+RUNNING(?:\\s|$)`, 'im').test(status.stdout || '')) {
    throw serviceError('supervisor_program_not_running');
  }
  return { configPath: targetPath, controlConfigPath: inspect.configPath, installed: true };
}

function removeSupervisordService(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const runCommand = options.runCommand || options.detection?.runCommand || createCommandRunner({
    fsApi,
    pathApi,
    env,
    platform: options.platform || process.platform
  });
  const inspect = inspectSupervisorBackend({
    fsApi,
    pathApi,
    env,
    platform: options.platform,
    commandAvailable: options.commandAvailable || options.detection?.commandAvailable,
    runCommand,
    supervisorConfig: options.supervisorConfig
  });
  if (!inspect.configPath || !inspect.includeDirectory) throw serviceError('supervisor_include_unavailable');
  const targetPath = pathApi.join(inspect.includeDirectory, MANAGED_CONFIG_NAME);
  const target = assertManagedConfigOrAbsent(targetPath, { fsApi });
  if (!target.exists) return { removed: false, configPath: null };
  if (!configHasManagedMarker(target.content) || !configHasProgram(target.content, MANAGED_PROGRAM)) {
    throw serviceError('unknown_supervisor_config_refused');
  }
  if (!inspect.report.controlAvailable) throw serviceError('control_socket_unavailable');
  if (findConflictingProgram(targetPath, { inspect, fsApi, pathApi })) {
    throw serviceError('unknown_existing_program_refused');
  }

  const status = runSupervisorctl(
    runCommand,
    inspect.configPath,
    ['status', MANAGED_PROGRAM],
    'supervisor_status_failed'
  );
  const statusLine = String(status.stdout || '').match(new RegExp(`^${MANAGED_PROGRAM}\\s+([A-Z]+)(?:\\s|$)`, 'im'));
  if (!statusLine) throw serviceError('supervisor_status_unrecognized');
  if (statusLine[1].toUpperCase() === 'RUNNING') {
    runSupervisorctl(
      runCommand,
      inspect.configPath,
      ['stop', MANAGED_PROGRAM],
      'supervisor_stop_failed'
    );
  } else if (statusLine[1].toUpperCase() !== 'STOPPED' && statusLine[1].toUpperCase() !== 'EXITED') {
    throw serviceError('supervisor_status_unrecognized');
  }

  const recheck = assertManagedConfigOrAbsent(targetPath, { fsApi });
  if (!recheck.exists || recheck.content !== target.content) throw serviceError('unknown_supervisor_config_refused');
  fsApi.unlinkSync(targetPath);
  runSupervisorctl(runCommand, inspect.configPath, ['reread'], 'supervisor_reread_failed');
  runSupervisorctl(
    runCommand,
    inspect.configPath,
    ['update', MANAGED_PROGRAM],
    'supervisor_update_failed'
  );
  return { removed: true, configPath: targetPath };
}

function parseOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw serviceError('invalid_service_installer_arguments');
    options[name] = value;
    index += 1;
  }
  return { positional, options };
}

function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseOptions(argv);
  const action = parsed.positional[0];
  const options = {
    ...dependencies,
    supervisorConfig: parsed.options['supervisor-config'],
    launcherPath: parsed.options.launcher,
    templatePath: parsed.options.template
  };
  if (parsed.options['service-manager'] !== 'supervisord') throw serviceError('unsupported_service_manager');
  if (action === 'validate') {
    validateSupervisordService(options);
    process.stdout.write('Supervisord backend preflight PASS.\n');
    return true;
  }
  if (action === 'install') {
    const result = installSupervisordService(options);
    process.stdout.write(`Supervisord program installed: ${result.installed ? 'toknow-agent' : 'none'}\n`);
    return result;
  }
  if (action === 'remove') {
    const result = removeSupervisordService(options);
    process.stdout.write(`${result.removed ? 'Removed' : 'Not installed'} Potato Server Agent supervisord program.\n`);
    return result;
  }
  throw serviceError('unknown_service_installer_action');
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`server-agent service installer failed: ${safeCode(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MANAGED_CONFIG_NAME,
  MANAGED_PROGRAM,
  assertManagedConfigOrAbsent,
  generateSupervisorConfig,
  installSupervisordService,
  parseOptions,
  quoteSupervisorArgument,
  removeSupervisordService,
  runCli,
  safeCode,
  validateSupervisordService,
  validateStableLauncher
};
