'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('../shared/config');
const { reportFailure, run: runHookForwarder } = require('../shared/notification/codexHookForwarder');
const { disableCodexStopHook, enableCodexStopHook, readCodexHookState } = require('../shared/notification/codexStopHook');
const { loadServerAgentConfig, normalizeProfileId } = require('./config');
const { loadServerCredential } = require('./notificationRuntime');
const { serverHookCommand, stableLauncherPath } = require('./hooks');
const { createServerAgentPaths } = require('./paths');
const { detectServiceEnvironment } = require('./serviceDetection');
const instance = require('./instance');
const shellBootstrap = require('./shellBootstrap');

function packageJsonPath() {
  return path.join(__dirname, '..', '..', 'package.json');
}

function readServerAgentVersion() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath(), 'utf8'));
  return String(packageJson.version || '0.0.0');
}

function isVersionRequest(argv) {
  return argv.includes('--version') || argv.includes('-v');
}

function safeCode(error, fallback = 'server_agent_failed') {
  const code = String(error?.code || fallback);
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : fallback;
}

function commandError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function enabledProfileIds(config) {
  return config.profiles.filter((profile) => profile.enabled).map((profile) => profile.id);
}

function assertCompleteSnapshots(config, snapshots) {
  const expected = enabledProfileIds(config);
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)
    || expected.length === 0 || expected.some((profileId) => !Object.hasOwn(snapshots, profileId))) {
    throw commandError('snapshot_incomplete');
  }
  return snapshots;
}

function optionValue(args, ...names) {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function pathsForArgs(args) {
  return createServerAgentPaths({
    root: optionValue(args, 'root'),
    configRoot: optionValue(args, 'configRoot', 'config-root'),
    dataRoot: optionValue(args, 'dataRoot', 'data-root'),
    stateRoot: optionValue(args, 'stateRoot', 'state-root')
  });
}

function configForArgs(args, paths) {
  const configPath = optionValue(args, 'config') || paths.configFile;
  return { config: loadServerAgentConfig(configPath), configPath };
}

function profileForConfig(config, profileId) {
  let id;
  try { id = normalizeProfileId(profileId); } catch (_) { throw commandError('invalid_profile'); }
  const profile = config.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw commandError('unknown_profile');
  return profile;
}

function launcherForArgs(args) {
  return optionValue(args, 'launcherPath', 'launcher') || stableLauncherPath();
}

function configFileState(codexHome) {
  const filePath = path.join(codexHome, 'hooks.json');
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? 'present' : 'invalid';
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function hookIdentity(profileId, args) {
  return serverHookCommand({ launcherPath: launcherForArgs(args), profileId });
}

function hookStatus(config, profile, args) {
  const command = hookIdentity(profile.id, args);
  const state = readCodexHookState({ codexHome: profile.codexHome, commandIdentity: command });
  return {
    profileId: profile.id,
    configured: state.enabled,
    configFileState: configFileState(profile.codexHome),
    needsTrust: state.needsTrust === true,
    error: state.error ? 'hook_config_error' : null
  };
}

function notificationCredentialState(paths) {
  try {
    const credential = loadServerCredential(paths.credentialFile);
    return credential.state;
  } catch (error) {
    return safeCode(error, 'invalid_credential');
  }
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return value;
}

async function runHooks(subcommand, args) {
  if (!['status', 'enable', 'disable'].includes(subcommand)) {
    throw commandError('unknown_hooks_command');
  }
  const paths = pathsForArgs(args);
  const { config } = configForArgs(args, paths);
  const profile = profileForConfig(config, optionValue(args, 'profile'));
  if (subcommand === 'status') return writeJson(hookStatus(config, profile, args));
  if (subcommand === 'enable') {
    const credentialState = notificationCredentialState(paths);
    if (credentialState === 'unconfigured') throw commandError('notification_not_configured');
    if (credentialState !== 'configured') throw commandError('invalid_credential');
    const command = hookIdentity(profile.id, args);
    const state = enableCodexStopHook({ codexHome: profile.codexHome, command });
    if (state.error || !state.enabled) throw commandError('hook_enable_failed');
    return writeJson({ profileId: profile.id, configured: true, needsTrust: true });
  }
  const command = hookIdentity(profile.id, args);
  const state = disableCodexStopHook({ codexHome: profile.codexHome, commandIdentity: command });
  if (state.error) throw commandError('hook_disable_failed');
  return writeJson({ profileId: profile.id, configured: false, needsTrust: false });
}

async function runService(subcommand, args, deps = {}) {
  if (subcommand !== 'detect') throw commandError('unknown_service_command');
  const detect = deps.detectServiceEnvironment || detectServiceEnvironment;
  const report = detect({
    env: deps.env || process.env,
    fsApi: deps.fsApi,
    pathApi: deps.pathApi,
    platform: deps.platform,
    commandAvailable: deps.commandAvailable,
    runCommand: deps.runCommand,
    supervisorConfig: optionValue(args, 'supervisorConfig', 'supervisor-config')
  });
  return writeJson(report);
}

async function runHookFailOpen(args) {
  try {
    const paths = pathsForArgs(args);
    const profileId = optionValue(args, 'profile');
    await runHookForwarder({ runtimePath: paths.notificationRuntimePath, profileId });
    process.stdout.write('{}\n');
  } catch (error) {
    // The Stop Hook is an optional notification side effect. Never let an
    // unavailable bridge, credential, or cloud endpoint fail the Codex task.
    reportFailure(error);
  }
  return undefined;
}

async function runEnsure(args, deps = {}) {
  const paths = pathsForArgs(args);
  configForArgs(args, paths);
  const forwarded = [];
  for (const [key, names] of Object.entries({
    root: ['root'], config: ['config'], 'config-root': ['configRoot', 'config-root'],
    'data-root': ['dataRoot', 'data-root'], 'state-root': ['stateRoot', 'state-root']
  })) {
    const value = optionValue(args, ...names);
    if (value !== undefined) forwarded.push(`--${key}=${value}`);
  }
  const result = await (deps.ensure || instance.ensure)(paths, forwarded);
  if (!args.quiet) process.stdout.write(`READY / ${result.result}\n`);
  return result;
}

function commandOptions(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--command') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw commandError('missing_launcher_name');
      result.push(argv[++index]);
    } else if (argv[index].startsWith('--command=')) result.push(argv[index].slice('--command='.length));
  }
  return result;
}

async function runShell(subcommand, args, argv) {
  const paths = pathsForArgs(args);
  const commands = commandOptions(argv);
  if (subcommand === 'install' || subcommand === 'add') {
    return writeJson(shellBootstrap.install({ paths, commands, launcher: launcherForArgs(args) }));
  }
  if (subcommand === 'remove') {
    if (commands.length !== 1) throw commandError('remove_one_launcher_at_a_time');
    return writeJson(shellBootstrap.remove({ paths, command: commands[0] }));
  }
  if (subcommand === 'uninstall') {
    const current = await shellBootstrap.status({ paths });
    if (current.commands.length > 1) throw commandError('remove_commands_individually');
    if (!current.commands.length) return writeJson(current);
    return writeJson(shellBootstrap.remove({ paths, command: current.commands[0] }));
  }
  if (subcommand === 'status') return writeJson(await shellBootstrap.status({ paths }));
  throw commandError('unknown_shell_command');
}

async function run(argv = process.argv.slice(2), deps = {}) {
  if (isVersionRequest(argv)) {
    const version = readServerAgentVersion();
    process.stdout.write(`To Know Server Agent ${version}\n`);
    return version;
  }

  const args = parseArgs(argv);
  const positional = argv.filter((value) => !String(value).startsWith('--'));
  const command = positional[0] || 'run';
  if (command === 'hook') return runHookFailOpen(args);
  if (command === 'hooks') return runHooks(positional[1], args);
  if (command === 'service') return runService(positional[1], args, deps);
  if (command === 'ensure') return runEnsure(args, deps);
  if (command === 'shell') return runShell(positional[1], args, argv);
  if (!['run', 'once'].includes(command)) throw commandError('unknown_server_agent_command');
  const paths = pathsForArgs(args);
  const { config } = configForArgs(args, paths);
  const owner = (deps.acquire || instance.acquire)(paths);
  const release = () => (deps.release || instance.release)(paths, owner);
  let released = false;
  const cleanup = () => { if (!released) { released = true; release(); } };
  process.once('exit', cleanup);
  const createServerAgentSupervisor = deps.createServerAgentSupervisor
    || require('./supervisor').createServerAgentSupervisor;
  let supervisor;
  let stop;
  try {
    supervisor = createServerAgentSupervisor({
      config,
      paths,
      once: command === 'once',
      agentVersion: args.agentVersion,
      watchEnabled: args.watch === '0' ? false : undefined,
      onMinimalReady: command === 'run'
        ? ({ notification }) => instance.markReady(paths, owner, notification)
        : undefined
    });
    if (command === 'run') {
      stop = () => { void supervisor.stop().catch((cause) => {
        process.stderr.write(`server-agent failed: ${safeCode(cause)}\n`);
      }).finally(() => {
        cleanup();
        process.removeListener('exit', cleanup);
      }); };
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
    }
    await supervisor.start();
  } catch (cause) {
    try { await supervisor?.stop(); } catch (_) {}
    cleanup();
    process.removeListener('exit', cleanup);
    if (stop) for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop);
    throw cause;
  }
  if (command === 'once') {
    try {
      await supervisor.waitForSnapshots();
      const snapshots = assertCompleteSnapshots(config, supervisor.getAllSnapshots());
      process.stdout.write(`${JSON.stringify(snapshots)}\n`);
      return snapshots;
    } finally {
      await supervisor.stop();
      cleanup();
      process.removeListener('exit', cleanup);
    }
  }

  return supervisor;
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`server-agent failed: ${safeCode(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  configFileState,
  hookStatus,
  isVersionRequest,
  packageJsonPath,
  readServerAgentVersion,
  assertCompleteSnapshots,
  enabledProfileIds,
  run,
  runHookFailOpen,
  runHooks,
  runService
};
