'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function windowsProcesses(root, pid) {
  const escaped = root.replace(/'/g, "''");
  const filter = pid ? `-Filter 'ProcessId = ${Number(pid)}'` : '';
  const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process ${filter} | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; executable=$_.ExecutablePath; commandLine=$_.CommandLine; started=$_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000
  });
  assert.equal(result.status, 0, `fixture process identity query failed: ${result.stderr}`);
  const value = JSON.parse(result.stdout || '[]');
  return Array.isArray(value) ? value : [value];
}

function matchesRoot(commandLine, root) {
  const normalized = commandLine.replaceAll('"', '');
  const marker = `--root=${root}`;
  const index = normalized.indexOf(marker);
  return index >= 0 && (!normalized[index + marker.length] || /\s/.test(normalized[index + marker.length]))
    && /server-agent[/\\]cli\.js\s+run(?:\s|$)/.test(normalized);
}

// Discovery is restricted to a unique mkdtemp root. No name-wide termination.
function createAgentCleanup(t, fixture) {
  const { root, paths } = fixture;
  const earliest = fixture.startedAtMs || Date.now() - 2000;
  const identities = new Map();
  const timeline = [];
  const note = (event, extra = {}) => timeline.push({ atMs: Date.now(), event, ...extra });
  function discover(pid) {
    if (process.platform === 'win32') return windowsProcesses(root, pid).filter(row => {
      return path.resolve(row.executable || '').toLowerCase() === path.resolve(process.execPath).toLowerCase()
        && matchesRoot(row.commandLine || '', root) && Date.parse(row.started) >= earliest - 2000;
    });
    const candidates = pid ? [pid] : [paths.agentLockPath, paths.agentReadyPath].flatMap(file => {
      try { return [JSON.parse(fs.readFileSync(file, 'utf8')).pid]; } catch (_) { return []; }
    });
    return [...new Set(candidates)].flatMap(candidate => {
      const result = spawnSync('ps', ['-ww', '-p', String(candidate), '-o', 'args='], { encoding: 'utf8' });
      if (result.status !== 0 || !matchesRoot(result.stdout, root)) return [];
      const started = spawnSync('ps', ['-p', String(candidate), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
      const executable = spawnSync('ps', ['-p', String(candidate), '-o', 'comm='], { encoding: 'utf8' }).stdout.trim();
      if (path.basename(executable) !== path.basename(process.execPath)) return [];
      return [{ pid: candidate, executable, commandLine: result.stdout.trim(), started }];
    });
  }
  function terminate(pid, signal = 'SIGKILL') {
    const [current] = discover(pid);
    if (!current) { note('already-exited-or-unowned', { pid }); return false; }
    const prior = identities.get(pid);
    assert.ok(!prior || prior.started === current.started, 'fixture PID was reused; refusing termination');
    identities.set(pid, current);
    const [verified] = discover(pid);
    assert.deepEqual(verified, current, 'fixture identity changed before termination');
    note('verified-termination', { signal, ...verified });
    try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return true;
  }
  function snapshot() {
    const state = {};
    for (const [name, file] of Object.entries({ owner: paths.agentLockPath, ready: paths.agentReadyPath,
      launch: paths.agentLaunchPath, reaper: paths.agentReaperPath })) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Nonces and notification runtime/token are deliberately excluded.
        state[name] = { pid: value.pid, version: value.version, notificationReady: value.notificationReady,
          modifiedMs: fs.statSync(file).mtimeMs };
      } catch (error) { state[name] = { error: error.code || 'invalid' }; }
    }
    return state;
  }
  async function cleanup() {
    note('cleanup-begin', { state: snapshot() });
    const rows = discover();
    for (const row of rows) terminate(row.pid);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const remaining = discover();
      if (!remaining.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const remaining = discover();
    note('cleanup-end', { remaining: remaining.map(row => row.pid), state: snapshot() });
    fs.writeFileSync(path.join(root, 'process-cleanup.json'), JSON.stringify(timeline, null, 2));
    t.diagnostic?.(JSON.stringify({ root, cleanup: timeline }));
    assert.equal(remaining.length, 0, 'fixture Agent still alive after cleanup');
  }
  t.after(cleanup);
  return { terminate, cleanup, snapshot, timeline };
}

module.exports = { createAgentCleanup, matchesRoot };
