'use strict';

// Test-only collector. The caller retains spawning/journaling and Agent ownership.
function collectChildOutput(child, timeoutMs = 9000, deps = {}) {
  const now = deps.now || (() => performance.now());
  const schedule = deps.setTimeout || setTimeout;
  const cancel = deps.clearTimeout || clearTimeout;
  const startedAt = now();
  return new Promise((resolve, reject) => {
    const stdout = [], stderr = [];
    let settled = false, closed = false, exited = false, failure;
    let code = child.exitCode ?? null, signal = child.signalCode ?? null;
    let spawned = Number.isSafeInteger(child.pid) && child.pid > 0;
    const output = chunks => Buffer.concat(chunks).toString('utf8');
    const snapshot = () => ({
      pid: child.pid ?? null, code, signal, elapsedMs: now() - startedAt, timeoutMs,
      spawned, exited, closed, stdout: output(stdout), stderr: output(stderr),
      outputComplete: closed,
      stdoutClosed: child.stdout?.closed ?? true, stderrClosed: child.stderr?.closed ?? true
    });
    const onStdout = chunk => stdout.push(Buffer.from(chunk));
    const onStderr = chunk => stderr.push(Buffer.from(chunk));
    const onSpawn = () => { spawned = true; };
    const onExit = (exitCode, exitSignal) => { exited = true; code = exitCode; signal = exitSignal; };
    function fail(type, cause) {
      if (settled) return;
      settled = true;
      cancel(timer);
      const diagnostics = { type, ...snapshot() };
      if (type === 'TIMEOUT') diagnostics.timeoutType = exited ? 'STDIO_DRAIN_TIMEOUT' : 'PROCESS_TIMEOUT';
      failure = Object.assign(new Error(`CLI ${type}: ${JSON.stringify(diagnostics)}`, { cause }), {
        code: `CLI_${type}`, diagnostics
      });
      // Never signal a numeric PID or an already-exited handle (possible reuse).
      if (spawned && !exited && child.exitCode === null && child.signalCode === null) {
        try { diagnostics.killRequested = 'SIGKILL'; diagnostics.killAccepted = child.kill('SIGKILL'); }
        catch (error) { diagnostics.killError = error.code || error.message; }
      }
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { stream?.destroy(); }
        catch (error) { (diagnostics.streamCleanupErrors ||= []).push(error.code || error.message); }
      }
      reject(failure);
    }
    const onError = error => fail(spawned ? 'CHILD_ERROR' : 'SPAWN_ERROR', error);
    const onStdoutError = error => fail('STDOUT_ERROR', error);
    const onStderrError = error => fail('STDERR_ERROR', error);
    const onStdinError = error => fail('STDIN_ERROR', error);
    function onClose(exitCode, exitSignal) {
      code = exitCode; signal = exitSignal; closed = true;
      if (failure) failure.diagnostics.close = { code, signal, elapsedMs: now() - startedAt };
      if (!settled) {
        if (!spawned) fail('SPAWN_ERROR', new Error('close without a successful spawn'));
        else { settled = true; cancel(timer); resolve(snapshot()); }
      }
      child.off('spawn', onSpawn);
      child.off('exit', onExit);
      child.off('error', onError);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.stdout?.off('error', onStdoutError);
      child.stderr?.off('error', onStderrError);
      child.stdin?.off('error', onStdinError);
    }
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.stdout?.on('error', onStdoutError);
    child.stderr?.on('error', onStderrError);
    child.stdin?.on('error', onStdinError);
    child.once('spawn', onSpawn);
    child.once('exit', onExit);
    child.on('error', onError);
    child.once('close', onClose);
    const timer = schedule(() => fail('TIMEOUT'), timeoutMs);
  });
}

module.exports = { collectChildOutput };
