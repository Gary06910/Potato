'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MESSAGE_TYPES, stopMessage } = require('../../src/server-agent/protocol');
const { validateServerSnapshot } = require('../../src/server-agent/snapshot');

const workerPath = path.resolve(__dirname, '..', '..', 'src', 'server-agent', 'profileWorker.js');
const EXIT_TIMEOUT_MS = 4000;

function fixtureSummary() {
  const period = {
    capabilities: { tokenComponents: true },
    totalTokens: 2,
    cacheReadTokens: 1,
    outputTokens: 1,
    clients: { codex: 2 },
    clientCacheReads: { codex: 1 },
    clientOutputs: { codex: 1 },
    models: { 'fixture-model': 2 },
    modelCacheReads: { 'fixture-model': 1 },
    modelOutputs: { 'fixture-model': 1 },
    clientModels: { codex: { 'fixture-model': 2 } }
  };
  return {
    updatedAt: '2026-09-21T10:00:00.000Z',
    periodWindows: {
      today: { key: '2026-09-21' },
      month: { key: '2026-09' },
      allTime: { key: 'all-time' }
    },
    today: period,
    month: period,
    allTime: period,
    history: { daily: [] }
  };
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function startFixtureWorker(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toknow-profile-worker-'));
  const fixtureFile = path.join(root, 'server-agent-fixture.json');
  const sharedDir = path.join(root, 'shared');
  const stateFile = path.join(sharedDir, 'worker-fixture-state.json');
  fs.writeFileSync(fixtureFile, JSON.stringify(fixtureSummary()));
  const child = fork(workerPath, [], {
    execArgv: ['--require', path.join(__dirname, 'fixtures', 'keepWorkerAlive.js')],
    env: {
      ...process.env,
      CODEX_HOME: root,
      TOKEN_MONITOR_SHARED_DIR: sharedDir,
      TO_KNOW_PROFILE_ID: 'business',
      TO_KNOW_PROFILE_NAME: 'Business',
      TO_KNOW_SERVER_AGENT_TEST_FIXTURE: '1',
      TO_KNOW_SERVER_AGENT_ONCE: '0'
    },
    silent: true,
    windowsHide: true
  });
  const messages = [];
  let stderr = '';
  child.on('message', (message) => messages.push(message));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await withTimeout(exited, EXIT_TIMEOUT_MS, 'fixture worker cleanup');
    for (const file of [stateFile, fixtureFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    if (fs.existsSync(sharedDir)) fs.rmdirSync(sharedDir);
    fs.rmdirSync(root);
  });
  return { child, exited, messages, stderr: () => stderr };
}

async function waitForMessage(child, type) {
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      child.off('message', onMessage);
      child.off('exit', onExit);
      resolve(message);
    };
    const onExit = () => {
      child.off('message', onMessage);
      reject(new Error(`worker exited before ${type}`));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  }), EXIT_TIMEOUT_MS, type);
}

test('published profile worker exits when parent IPC disconnects without STOP', async (t) => {
  const fixture = startFixtureWorker(t);
  const published = await waitForMessage(fixture.child, MESSAGE_TYPES.SNAPSHOT);
  validateServerSnapshot(published.snapshot);
  assert.equal(published.snapshot.today.totalTokens, 2);
  assert.equal(fixture.child.connected, true);

  fixture.child.disconnect();
  assert.equal(fixture.child.connected, false);
  const exit = await withTimeout(fixture.exited, EXIT_TIMEOUT_MS, 'post-snapshot parent disconnect');
  assert.deepEqual(exit, { code: 0, signal: null }, fixture.stderr());
  assert.equal(fixture.messages.filter((message) => message.type === MESSAGE_TYPES.STOP).length, 0);
});

test('STOP message and ensuing IPC disconnect stop a profile worker once', async (t) => {
  const fixture = startFixtureWorker(t);
  const published = await waitForMessage(fixture.child, MESSAGE_TYPES.SNAPSHOT);
  validateServerSnapshot(published.snapshot);

  fixture.child.send(stopMessage('business'));
  const exit = await withTimeout(fixture.exited, EXIT_TIMEOUT_MS, 'normal worker stop');
  assert.deepEqual(exit, { code: 0, signal: null }, fixture.stderr());
  assert.equal(fixture.messages.filter((message) => message.type === MESSAGE_TYPES.STOPPED).length, 1);
});
