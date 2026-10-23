'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const verdict = (state, reason, extra = {}) => ({ state, reason, ...extra });
function queryError(error) {
  return verdict(['EPERM', 'EACCES'].includes(error.code) ? 'QUERY_DENIED' : 'QUERY_FAILED',
    error.code || error.message || 'unknown query error');
}

// Exit waiting never authorizes a signal. ESRCH is affirmative OS absence;
// EPERM/EACCES and all other errors remain failures, even after our own signal.
function inspectProcessExistence(pid, probe = candidate => process.kill(candidate, 0)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return verdict('IDENTITY_INCOMPLETE', 'invalid PID');
  try { probe(pid); return { state: 'PROCESS_EXISTS', pid }; }
  catch (error) { return error.code === 'ESRCH' ? verdict('VERIFIED_EXITED', 'OS existence probe confirms exit', { pid }) : queryError(error); }
}

// A failed command is never evidence of absence. Also used for raw ps regressions.
function commandResult(result) {
  if (result.error) return queryError(result.error);
  if (result.signal || result.status !== 0 || String(result.stderr || '').trim()) {
    const denied = /EPERM|EACCES|permission denied|operation not permitted|access.*denied|拒绝访问/i
      .test(String(result.stderr || ''));
    return verdict(denied ? 'QUERY_DENIED' : 'QUERY_FAILED', 'process query command failed', {
      status: result.status, signal: result.signal, stderr: String(result.stderr || '')
    });
  }
  if (typeof result.stdout !== 'string' || !result.stdout.trim()) {
    return verdict('IDENTITY_INCOMPLETE', 'empty process query output');
  }
  return { state: 'QUERY_OK', stdout: result.stdout };
}

function decodeNulArgv(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.at(-1) !== 0) throw new Error('incomplete NUL argv');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  return text.slice(0, -1).split('\0');
}

// Node/libuv quotes each argv element using the Windows CRT backslash/quote rules.
// Do not apply this decoder to POSIX ps output (which has lost argv boundaries).
function decodeWindowsArgv(text) {
  if (typeof text !== 'string' || !text || /[\0\r\n]/.test(text)) throw new Error('invalid Windows argv');
  const result = [];
  let i = 0;
  while (i < text.length) {
    while (/[ \t]/.test(text[i] || '') && i < text.length) i++;
    if (i === text.length) break;
    let value = '', quoted = false;
    while (i < text.length && (quoted || !/[ \t]/.test(text[i]))) {
      let slashes = 0;
      while (text[i] === '\\') { slashes++; i++; }
      if (text[i] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"';
        else if (quoted && text[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
        i++;
      } else {
        value += '\\'.repeat(slashes);
        if (i < text.length && (quoted || !/[ \t]/.test(text[i]))) value += text[i++];
      }
    }
    if (quoted) throw new Error('unclosed Windows quote');
    result.push(value);
  }
  return result;
}

function decodeDarwinArgs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) throw new Error('missing Darwin argv');
  const argc = buffer.readInt32LE(0);
  if (argc < 1 || argc > 4096) throw new Error('invalid Darwin argc');
  let offset = buffer.indexOf(0, 4);
  if (offset <= 4) throw new Error('missing Darwin exec header');
  while (buffer[offset] === 0 && offset < buffer.length) offset++;
  const args = [];
  for (let i = 0; i < argc; i++) {
    const end = buffer.indexOf(0, offset);
    if (end < offset) throw new Error('truncated Darwin argv');
    args.push(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(offset, end)));
    offset = end + 1;
  }
  // Environment bytes after argc entries are neither decoded nor logged.
  return args;
}

function decodeDarwinStart(buffer, pid) {
  // Apple proc_bsdinfo: 12 uint32, comm[16], name[32], 6 uint32, 2 uint64.
  if (buffer.length !== 136 || buffer.readUInt32LE(12) !== pid) throw new Error('invalid proc_bsdinfo');
  const seconds = buffer.readBigUInt64LE(120), micros = buffer.readBigUInt64LE(128);
  if (seconds === 0n || micros >= 1000000n) throw new Error('invalid Darwin start time');
  const start = seconds * 1000000n + micros;
  return { generation: `darwin:${start}`, startedAtMs: Number(start) / 1000 };
}

function createDarwinApi(koffi) {
  const lib = koffi.load('/usr/lib/libSystem.B.dylib');
  const proc = koffi.load('/usr/lib/libproc.dylib');
  const pidinfo = proc.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ uint8_t *buffer, int size)');
  const pidpath = proc.func('int proc_pidpath(int pid, _Out_ uint8_t *buffer, uint32_t size)');
  const sysctl = lib.func('int sysctl(const int *name, unsigned int namelen, _Out_ uint8_t *oldp, _Inout_ size_t *oldlenp, const void *newp, size_t newlen)');
  function checked(value) {
    if (value <= 0) {
      const errno = koffi.errno();
      throw Object.assign(new Error(`Darwin process query errno=${errno}`), {
        code: ({ 1: 'EPERM', 13: 'EACCES', 3: 'ESRCH' })[errno] || `ERRNO_${errno}`
      });
    }
    return value;
  }
  return {
    start(pid) {
      const buffer = Buffer.alloc(136);
      if (checked(pidinfo(pid, 3, 0, buffer, buffer.length)) !== buffer.length) throw new Error('short proc_pidinfo');
      return buffer;
    },
    executable(pid) {
      const buffer = Buffer.alloc(4096);
      const length = checked(pidpath(pid, buffer, buffer.length));
      const end = buffer.indexOf(0);
      if (end < 1 || end > length || length >= buffer.length) throw new Error('truncated proc_pidpath');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
    },
    argv(pid) {
      const mib = [1, 49, pid], size = [0]; // CTL_KERN, KERN_PROCARGS2
      if (sysctl(mib, 3, null, size, null, 0) !== 0) checked(0);
      if (!Number.isSafeInteger(Number(size[0])) || size[0] < 6 || size[0] > 2 * 1024 * 1024) throw new Error('invalid procargs size');
      const buffer = Buffer.alloc(Number(size[0]));
      if (sysctl(mib, 3, buffer, size, null, 0) !== 0) checked(0);
      if (Number(size[0]) > buffer.length) throw new Error('truncated procargs');
      return buffer.subarray(0, Number(size[0]));
    }
  };
}
let darwinNative;
function darwinApi() { return darwinNative ||= createDarwinApi(require('koffi')); }

let linuxNative;
function linuxClock() {
  if (!linuxNative) {
    const koffi = require('koffi');
    const lib = koffi.load('libc.so.6');
    const clock = lib.func('int clock_gettime(int clockid, _Out_ int64_t *value)');
    const sysconf = lib.func('long sysconf(int name)');
    linuxNative = () => {
      const pair = [0, 0];
      if (clock(7, pair) !== 0) throw new Error('CLOCK_BOOTTIME unavailable');
      const hz = Number(sysconf(2)); // Linux _SC_CLK_TCK
      if (!Number.isSafeInteger(hz) || hz <= 0) throw new Error('invalid CLK_TCK');
      return { bootSeconds: Number(pair[0]) + Number(pair[1]) / 1e9, hz };
    };
  }
  return linuxNative();
}

function decodeLinuxStat(text, pid) {
  const boundary = typeof text === 'string' ? text.lastIndexOf(') ') : -1;
  if (boundary < 0 || !text.startsWith(`${pid} (`)) throw new Error('invalid /proc stat');
  const fields = text.slice(boundary + 2).trim().split(/\s+/);
  const ticks = fields[19]; // field 22; fields[0] is state (field 3).
  if (fields.length < 20 || !/^[RSDTtXZPI]$/.test(fields[0])
    || fields.slice(1, 20).some(v => !/^-?\d+$/.test(v))
    || !/^[1-9]\d*$/.test(ticks || '') || !/^\d+$/.test(fields[1])
    || !Number.isSafeInteger(Number(fields[1])) || !/^[1-9]\d*$/.test(fields[17])
    || !Number.isSafeInteger(Number(fields[17]))) throw new Error('incomplete /proc state or start ticks');
  return { generation: `linux:${ticks}`, startTicks: ticks, processState: fields[0], parentPid: Number(fields[1]), threadCount: Number(fields[17]) };
}

// Only explicit OS absence proves reaping. Missing exe/cmdline is never enough.
function linuxFailure(pid, error, probe, evidence) {
  let result;
  if (['ENOENT', 'ESRCH'].includes(error.code)) {
    const existence = inspectProcessExistence(pid, probe);
    evidence.existenceProbe = existence.state;
    result = existence.state === 'PROCESS_EXISTS'
      ? verdict('QUERY_FAILED', 'metadata missing for an existing process') : existence;
  } else result = error.code ? queryError(error) : verdict('IDENTITY_INCOMPLETE', error.message);
  return { ...result, pid, evidence };
}

// A bounded stat pair is sufficient for exit observation, never signal authority.
// On a live -> Z transition a third stat must confirm Z with the same generation.
function observeLinux(pid, deps, identity) {
  const read = deps.readFile || fs.readFileSync, readlink = deps.readlink || fs.readlinkSync;
  const probe = deps.probe || (candidate => process.kill(candidate, 0));
  const evidence = { stat: [], exeRead: 'NOT_REQUESTED', cmdlineRead: 'NOT_REQUESTED' };
  const existence = inspectProcessExistence(pid, probe);
  evidence.existenceProbe = existence.state;
  if (existence.state !== 'PROCESS_EXISTS') return { ...existence, pid, evidence };
  function stat() {
    try {
      const row = decodeLinuxStat(read(`/proc/${pid}/stat`, 'utf8'), pid);
      evidence.stat.push({ state: row.processState, startTicks: row.startTicks, parentPid: row.parentPid, threadCount: row.threadCount });
      return row;
    } catch (error) { evidence.stat.push({ error: error.code || 'INVALID_STAT' }); throw error; }
  }
  try {
    const before = stat();
    let executable, argv, metadataError;
    if (identity && before.processState !== 'Z') {
      try { executable = readlink(`/proc/${pid}/exe`); evidence.exeRead = 'OK'; }
      catch (error) { evidence.exeRead = error.code || 'INVALID'; metadataError = error; }
      if (!metadataError) {
        try { argv = decodeNulArgv(read(`/proc/${pid}/cmdline`)); evidence.cmdlineRead = 'OK'; }
        catch (error) { evidence.cmdlineRead = error.code || 'INVALID'; metadataError = error; }
      }
    }
    // Do not replace permission failures with a later exit observation.
    if (['EPERM', 'EACCES'].includes(metadataError?.code)) throw metadataError;
    const after = stat();
    if (before.generation !== after.generation) return verdict('PID_REUSED', 'generation changed during /proc query', { pid, evidence });
    if (after.processState === 'Z') {
      if (after.threadCount !== 1) return verdict('QUERY_FAILED', 'Zombie leader may still have executing threads', { pid, evidence });
      if (before.processState !== 'Z' || before.threadCount !== 1) {
        const confirmed = stat();
        if (confirmed.generation !== after.generation) return verdict('PID_REUSED', 'generation changed while confirming Z', { pid, evidence });
        if (confirmed.processState !== 'Z' || confirmed.threadCount !== 1) return verdict('QUERY_FAILED', 'unstable Zombie observation', { pid, evidence });
      }
      return { state: 'LINUX_ZOMBIE', pid, ...after, runtimeTerminated: true, pidReaped: false, evidence };
    }
    if (before.processState === 'Z') return verdict('QUERY_FAILED', 'inconsistent Zombie state', { pid, evidence });
    if (metadataError) throw metadataError;
    if (!identity) return { state: 'LINUX_STATE_OBSERVED', pid, ...after, evidence };
    // Running/sleeping may alternate during revalidation. Neither is ownership
    // identity; the stable PID/start ticks plus complete exe/argv still are.
    return { state: 'OBSERVED', pid, executable, argv, generation: before.generation, startTicks: before.startTicks };
  } catch (error) { return linuxFailure(pid, error, probe, evidence); }
}

function createLinuxExitInspector(deps = {}) {
  return (pid, registration) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || registration?.pid !== pid
      || !/^linux:[1-9]\d*$/.test(registration?.generation || '')) return verdict('IDENTITY_INCOMPLETE', 'no complete Linux spawn generation', { pid });
    const row = observeLinux(pid, deps, false);
    if (!['LINUX_ZOMBIE', 'LINUX_STATE_OBSERVED'].includes(row.state)) return row;
    if (row.generation !== registration.generation) {
      if (BigInt(row.startTicks) > BigInt(registration.generation.slice(6))) {
        return { ...row, state: 'ORIGINAL_GENERATION_TERMINATED', originalGeneration: registration.generation,
          runtimeTerminated: true, pidReaped: true, currentPidReaped: false };
      }
      return { ...row, state: 'PID_REUSED', reason: 'observed generation is older than registration' };
    }
    return { ...row, state: row.state === 'LINUX_ZOMBIE' ? 'REGISTERED_GENERATION_ZOMBIE' : 'PROCESS_EXISTS' };
  };
}

function createProcessInspector(deps = {}) {
  const platform = deps.platform || process.platform;
  const run = deps.run || spawnSync;
  const probe = deps.probe || (pid => process.kill(pid, 0));
  const native = deps.darwin;
  function absent(pid, error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return queryError(error);
    if (!['ENOENT', 'ESRCH'].includes(error.code)) return queryError(error);
    try { probe(pid); return verdict('QUERY_FAILED', 'metadata missing for an existing process'); }
    catch (cause) { return cause.code === 'ESRCH' ? verdict('VERIFIED_EXITED', 'OS confirms PID absence') : queryError(cause); }
  }
  return function inspect(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return verdict('IDENTITY_INCOMPLETE', 'invalid PID');
    if (platform === 'linux') return observeLinux(pid, deps, true);
    try {
      if (platform === 'win32') {
        const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ found=$true; pid=$p.ProcessId; executable=$p.ExecutablePath; commandLine=$p.CommandLine; started=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress } else { '{"found":false}' }`;
        const systemRoot = deps.systemRoot || process.env.SystemRoot || process.env.WINDIR;
        if (!systemRoot || !path.isAbsolute(systemRoot)) return verdict('QUERY_FAILED', 'Windows system directory unavailable');
        const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const result = commandResult(run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8', windowsHide: true, timeout: 10000
        }));
        if (result.state !== 'QUERY_OK') return result;
        let row;
        try { row = JSON.parse(result.stdout); } catch (_) { return verdict('IDENTITY_INCOMPLETE', 'invalid CIM JSON'); }
        if (row?.found === false && Object.keys(row).length === 1) return verdict('VERIFIED_EXITED', 'CIM confirms PID absence');
        if (row?.found !== true || row.pid !== pid || !row.executable || !row.started) return verdict('IDENTITY_INCOMPLETE', 'missing CIM fields');
        return { state: 'OBSERVED', pid, executable: row.executable, argv: decodeWindowsArgv(row.commandLine),
          generation: `win32:${row.started}`, startedAtMs: Date.parse(row.started) };
      }
      try { probe(pid); } catch (error) { return absent(pid, error); }
      if (platform === 'darwin') {
        const api = native || darwinApi();
        const before = decodeDarwinStart(api.start(pid), pid);
        const executable = api.executable(pid), argv = decodeDarwinArgs(api.argv(pid));
        const after = decodeDarwinStart(api.start(pid), pid);
        if (before.generation !== after.generation) return verdict('PID_REUSED', 'generation changed during native query');
        return { state: 'OBSERVED', pid, executable, argv, ...before };
      }
      return verdict('QUERY_FAILED', `unsupported process inspection platform: ${platform}`);
    } catch (error) {
      if (error.code) return absent(pid, error);
      return verdict('IDENTITY_INCOMPLETE', error.message);
    }
  };
}

module.exports = { createLinuxExitInspector, commandResult, createDarwinApi, createProcessInspector, decodeDarwinArgs, decodeDarwinStart,
  decodeLinuxStat, decodeNulArgv, decodeWindowsArgv, inspectProcessExistence, linuxClock };
