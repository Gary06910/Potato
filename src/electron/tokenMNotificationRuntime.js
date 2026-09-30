'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writePrivateJsonAtomic } = require('../shared/credentialStore');
const { createCodexHookBridge } = require('./codexHookBridge');
const { disableCodexStopHook, enableCodexStopHook, readCodexHookState } = require('./codexStopHook');
const { createAndroidNotificationRuntime } = require('./androidNotificationRuntime');

function posixQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function windowsQuote(value) { return `"${String(value).replaceAll('"', '\\"')}"`; }
function powerShellQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function legacyWindowsHookCommandFor({ executablePath, helperPath, runtimePath }) {
  return `set "ELECTRON_RUN_AS_NODE=1"&&${windowsQuote(executablePath)} ${windowsQuote(helperPath)} ${windowsQuote(runtimePath)}`;
}
function encodedWindowsHookCommandFor({ executablePath, helperPath, runtimePath }) {
  const script = ["$ProgressPreference = 'SilentlyContinue'", '$utf8 = [System.Text.UTF8Encoding]::new($false)', '[Console]::InputEncoding = $utf8', '$OutputEncoding = $utf8', '$payload = [Console]::In.ReadToEnd()', "$env:ELECTRON_RUN_AS_NODE = '1'", `$payload | & ${powerShellQuote(executablePath)} ${powerShellQuote(helperPath)} ${powerShellQuote(runtimePath)}`, 'exit $LASTEXITCODE'].join('; ');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}
function stableWindowsHookCommandFor({ launcherPath, manifestPath }) {
  if (![launcherPath, manifestPath].every((value) => typeof value === 'string' && path.isAbsolute(value))) throw new TypeError('Stable Hook launcher paths must be absolute');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -File ${powerShellQuote(launcherPath)} ${powerShellQuote(manifestPath)}`;
}
function hookCommandFor({ platform = process.platform, executablePath = process.execPath, helperPath, runtimePath, launcherPath, manifestPath }) {
  if (![executablePath, helperPath, runtimePath].every((value) => typeof value === 'string' && path.isAbsolute(value))) throw new TypeError('Hook command paths must be absolute');
  if (platform === 'win32') {
    return launcherPath && manifestPath
      ? stableWindowsHookCommandFor({ launcherPath, manifestPath })
      : encodedWindowsHookCommandFor({ executablePath, helperPath, runtimePath });
  }
  return `ELECTRON_RUN_AS_NODE=1 ${posixQuote(executablePath)} ${posixQuote(helperPath)} ${posixQuote(runtimePath)}`;
}

const CODEX_HOOK_DIRECTORY = 'codex-hook';
const CODEX_HOOK_LAUNCHER = 'launcher.ps1';
const CODEX_HOOK_MANIFEST = 'target.json';
const STABLE_HOOK_LAUNCHER_SOURCE = [
  "$ErrorActionPreference = 'Stop'",
  '$reader = [Console]::In',
  '$buffer = [char[]]::new(4096)',
  '$builder = [System.Text.StringBuilder]::new()',
  'while (($count = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {',
  '  if (($builder.Length + $count) -gt 65536) { exit 1 }',
  '  [void]$builder.Append($buffer, 0, $count)',
  '}',
  '$payload = $builder.ToString()',
  '$manifestPath = [string]$args[0]',
  '$manifestItem = Get-Item -LiteralPath $manifestPath -Force',
  'if ($manifestItem.PSIsContainer -or (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or $manifestItem.Length -gt 8192) { exit 1 }',
  '$manifest = ([System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json)',
  '$executablePath = [string]$manifest.executablePath',
  '$helperPath = [string]$manifest.helperPath',
  '$runtimePath = [string]$manifest.runtimePath',
  'if (![System.IO.Path]::IsPathRooted($executablePath) -or ![System.IO.Path]::IsPathRooted($helperPath) -or ![System.IO.Path]::IsPathRooted($runtimePath)) { exit 1 }',
  '$env:ELECTRON_RUN_AS_NODE = "1"',
  '$payload | & $executablePath $helperPath $runtimePath',
  'exit $LASTEXITCODE'
].join("`r`n") + "`r`n";

function assertPrivateRegularFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Potato Hook launcher files must be regular files');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function assertPrivateDirectory(directoryPath) {
  try {
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Potato Hook launcher directory must be a real directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Potato Hook launcher directory must be a real directory');
}

function writePrivateTextAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, value, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertPrivateRegularFile(filePath);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function ensureWindowsHookLauncher({ userDataPath, executablePath, helperPath, runtimePath }) {
  const directory = path.join(userDataPath, CODEX_HOOK_DIRECTORY);
  const launcherPath = path.join(directory, CODEX_HOOK_LAUNCHER);
  const manifestPath = path.join(directory, CODEX_HOOK_MANIFEST);
  assertPrivateDirectory(directory);
  assertPrivateRegularFile(launcherPath);
  let launcher = '';
  try { launcher = fs.readFileSync(launcherPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (launcher !== STABLE_HOOK_LAUNCHER_SOURCE) writePrivateTextAtomic(launcherPath, STABLE_HOOK_LAUNCHER_SOURCE);
  assertPrivateRegularFile(manifestPath);
  writePrivateJsonAtomic(manifestPath, { version: 1, executablePath, helperPath, runtimePath });
  return { launcherPath, manifestPath };
}

function safeMachineCode(error) {
  const code = String(error?.code || 'cloud_request_failed');
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(code) ? code : 'cloud_request_failed';
}

function createTokenMNotificationRuntime(options) {
  const { userDataPath, fetch, getSettings, commitSettings, emitStatus = () => {}, logger = {}, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), executablePath = process.execPath, helperPath = path.join(__dirname, 'codexHookForwarder.js'), platform = process.platform, hostname = os.hostname() } = options || {};
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new TypeError('userDataPath must be absolute');
  if (typeof fetch !== 'function' || typeof getSettings !== 'function' || typeof commitSettings !== 'function') throw new TypeError('fetch, getSettings, and commitSettings are required');
  const runtimePath = path.join(userDataPath, 'token-m-notification-runtime.json');
  const launcherPath = path.join(userDataPath, CODEX_HOOK_DIRECTORY, CODEX_HOOK_LAUNCHER);
  const manifestPath = path.join(userDataPath, CODEX_HOOK_DIRECTORY, CODEX_HOOK_MANIFEST);
  const command = hookCommandFor({ platform, executablePath, helperPath, runtimePath, launcherPath, manifestPath });
  const commandWindows = platform === 'win32' ? command : null;
  const legacyCommands = platform === 'win32'
    ? [
      legacyWindowsHookCommandFor({ executablePath, helperPath, runtimePath }),
      encodedWindowsHookCommandFor({ executablePath, helperPath, runtimePath })
    ]
    : [];
  const commandIdentity = { command, commandWindows, legacyCommands, runtimePath };
  let bridge = null; let stopped = true; let statusTimer = null; let lifecycle = Promise.resolve(); let hookReconcileError = '';
  const android = createAndroidNotificationRuntime({ userDataPath, fetch, getSettings, commitSettings, logger, hostname });
  function hookState() { return readCodexHookState({ codexHome, commandIdentity }); }
  function lastHookEventAt() {
    const value = getSettings()?.tokenMCodexLastHookEventAt;
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
  }
  function publicStatus() {
    const hook = hookState();
    const desired = getSettings()?.tokenMCodexHookEnabled === true;
    const lastEvent = lastHookEventAt();
    const error = hook.error || hookReconcileError || null;
    const status = error
      ? 'error'
      : !desired
        ? 'disabled'
        : !hook.enabled
          ? 'error'
          : lastEvent
            ? 'active'
            : 'needsTrust';
    return {
      hook: {
        status,
        desired,
        enabled: hook.enabled,
        configured: hook.enabled,
        needsTrust: status === 'needsTrust',
        lastHookEventAt: lastEvent,
        error
      },
      android: android.publicStatus()
    };
  }
  function publish() { const value = publicStatus(); emitStatus(value); return value; }
  function removeRuntimeMetadata() { try { fs.unlinkSync(runtimePath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  async function stopBridge() { const active = bridge; bridge = null; if (active) await active.stop(); removeRuntimeMetadata(); }
  async function stopComponents() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    await stopBridge();
    await android.stop();
  }
  async function startBridge() {
    const destination = android;
    if (bridge || !hookState().enabled || !destination.isActive()) return;
    const token = crypto.randomBytes(32).toString('base64url');
    const instance = createCodexHookBridge({ host: '127.0.0.1', port: 0, token, logger, onCompletion: async (input) => {
      const eventAt = new Date().toISOString();
      try {
        await android.enqueue(input);
      } catch (error) {
        logger.warn?.('Notification enqueue failed', { code: safeMachineCode(error) });
      }
      try {
        await commitSettings({ tokenMCodexLastHookEventAt: eventAt });
      } catch (error) {
        logger.warn?.('Hook event timestamp persistence failed', { code: safeMachineCode(error) });
      }
      publish();
    } });
    const address = await instance.start();
    try { writePrivateJsonAtomic(runtimePath, { version: 1, host: '127.0.0.1', port: address.port, token }); bridge = instance; } catch (error) { await instance.stop(); throw error; }
  }
  async function startComponents() {
    const destination = android;
    await destination.start();
    const hook = await reconcileCodexHook();
    if (hook.error) logger.warn?.('Codex Hook reconciliation failed', { code: 'hook_reconcile_failed' });
    await startBridge();
    if (destination.configuration().configured) {
      statusTimer = setInterval(() => {
        void destination.refreshStatus().then(publish);
      }, 60_000);
      statusTimer.unref?.();
    }
  }
  async function reconcileCodexHook() {
    const desired = getSettings()?.tokenMCodexHookEnabled === true;
    hookReconcileError = '';
    try {
      const current = hookState();
      if (current.error) {
        hookReconcileError = current.error;
        return current;
      }
      if (desired && (!android.configuration().configured || android.publicStatus().bindingState !== 'bound')) {
        // A persisted intent must not create a hook that cannot deliver to a
        // bound Android device. Keep an existing owned hook intact so a later
        // re-pair can reconcile it without losing the user's intent.
        if (current.enabled) return current;
        hookReconcileError = 'android_credential_invalid';
        return { ...current, error: hookReconcileError };
      }
      if (desired && platform === 'win32') ensureWindowsHookLauncher({ userDataPath, executablePath, helperPath, runtimePath });
      const state = desired
        ? enableCodexStopHook({ codexHome, command, commandWindows, legacyCommands, runtimePath })
        : disableCodexStopHook({ codexHome, commandIdentity });
      hookReconcileError = state.error || '';
      return state;
    } catch (error) {
      hookReconcileError = error?.message || String(error);
      return { enabled: false, needsTrust: false, error: hookReconcileError };
    }
  }
  async function reconcileComponents() {
    await stopComponents();
    if (!stopped) await startComponents();
  }
  function inLifecycle(operation) { const run = lifecycle.then(operation, operation); lifecycle = run.catch(() => {}); return run; }
  return {
    commandIdentity: command, runtimePath,
    start() { stopped = false; return inLifecycle(async () => { await stopComponents(); if (!stopped) await startComponents(); return publish(); }); },
    stop() { stopped = true; return inLifecycle(async () => { await stopComponents(); return publicStatus(); }); },
    shutdownSync() {
      stopped = true;
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      removeRuntimeMetadata();
      const active = bridge;
      bridge = null;
      if (active) void active.stop();
      android.shutdownSync();
    },
    getStatus() { return inLifecycle(async () => { await android.refreshStatus(); return publish(); }); },
    enableCodexHook() { return inLifecycle(async () => {
      const destination = android;
      if (!destination.configuration().configured) throw new Error('notifications_not_configured');
      if (destination.publicStatus().bindingState !== 'bound') {
        throw new Error('android_credential_invalid');
      }
      try {
        if (platform === 'win32') ensureWindowsHookLauncher({ userDataPath, executablePath, helperPath, runtimePath });
        const state = enableCodexStopHook({ codexHome, command, commandWindows, legacyCommands, runtimePath });
        hookReconcileError = state.error || '';
        if (state.enabled) {
          await commitSettings({ tokenMCodexHookEnabled: true });
          await startBridge();
        }
        publish();
        if (state.error) throw new Error(state.error);
        return state;
      } catch (error) {
        hookReconcileError = error?.message || String(error);
        publish();
        throw error;
      }
    }); },
    disableCodexHook() { return inLifecycle(async () => { const state = disableCodexStopHook({ codexHome, commandIdentity }); hookReconcileError = state.error || ''; if (!state.error) await commitSettings({ tokenMCodexHookEnabled: false }); await stopBridge(); publish(); return state; }); },
    pairAndroid(request) { return inLifecycle(async () => {
      const pairing = android.pair(request);
      publish();
      try {
        await pairing;
        await reconcileComponents();
      } catch (error) {
        // Pairing restores the previous binding state on failure. Publish it
        // as well so the renderer cannot remain stuck in the transient state.
        publish();
        throw error;
      }
      return publish();
    }); },
    setAndroidEnabled(enabled) { return inLifecycle(async () => {
      await android.setEnabled(enabled === true);
      await reconcileComponents();
      return publish();
    }); },
    setAndroidPrivacyMode(privacyMode) { return inLifecycle(async () => { await android.setPrivacyMode(privacyMode); return publish(); }); },
    clearUndelivered() { return inLifecycle(async () => { await android.clearUndelivered(); return publish(); }); },
    clearOutbox() { return inLifecycle(async () => { await android.clearOutbox(); return publish(); }); },
    unpairAndroid() { return inLifecycle(async () => { await android.unpairSelf(); await reconcileComponents(); return publish(); }); },

  };
}
module.exports = { createTokenMNotificationRuntime, hookCommandFor, legacyWindowsHookCommandFor, stableWindowsHookCommandFor };
