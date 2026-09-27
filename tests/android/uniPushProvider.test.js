'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../apps/tokenm-android/uniCloud-alipay');
const core = require(path.join(projectRoot, 'cloudfunctions/common/tokenm-core'));

const TASK_ID = 'tsk_11111111-1111-4111-8111-111111111111';

test('provider diagnostics are bounded and do not retain echoed sensitive values', () => {
  const safe = core.normalizePushProviderError('send_message', {
    errCode: 20001, code: 'ignored', errMsg: 'Application unavailable.\n at hidden stack',
    message: 'ignored', stack: 'FORBIDDEN_STACK'
  });
  assert.deepEqual(safe, { stage: 'send_message', code: '20001', safeMessage: 'Application unavailable.' });
  assert.equal(core.normalizePushProviderError('get_push_manager', { code: 'ERR_EXTENSION', message: 'Extension unavailable.' }).code, 'ERR_EXTENSION');
  assert.equal(core.normalizePushProviderError('send_message', null).code, null);
  assert.equal(core.normalizePushProviderError('send_message', { message: 'short message '.repeat(50) }).safeMessage.length, 240);
  for (const message of [
    'bad controlled-cid', 'payload={"taskId":"private"}', 'token=private-token',
    'credential: private', 'Bearer private', 'summary=private task', 'bad private task content'
  ]) {
    const diagnostic = core.normalizePushProviderError('send_message', { message }, ['controlled-cid', 'private task content']);
    assert.equal(diagnostic.safeMessage, '[provider detail omitted]');
  }
  assert.equal(core.normalizePushProviderError('send_message', { code: 'controlled-cid' }, ['controlled-cid']).code, null);
});

test('Desktop URLized runtime uses only the current DCloud uni-push extension', () => {
  const source = fs.readFileSync(path.join(
    projectRoot,
    'cloudfunctions/tokenm-desktop-http/index.js'
  ), 'utf8');
  assert.match(source, /createTaskCompletedPushSender/);
  assert.match(source, /runtime:\s*globalThis\.uniCloud/);
  assert.doesNotMatch(source, /getui|honor|huawei|xiaomi|oppo|vivo|meizu|fcm/i);

  const packageJson = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'cloudfunctions/tokenm-desktop-http/package.json'
  ), 'utf8'));
  assert.deepEqual(packageJson.extensions, { 'uni-cloud-push': {} });
});

test('push_clientid targeting emits the exact contract shape without platform and deduplicates targets', async () => {
  const calls = [];
  const runtime = {
    getPushManager(options) {
      calls.push({ kind: 'manager', options });
      return {
        async sendMessage(request) {
          calls.push({ kind: 'send', request });
          return { errCode: 0, errMsg: 'ok', data: { ignored: true } };
        }
      };
    }
  };
  const send = core.createTaskCompletedPushSender({ runtime, timeoutMs: 100 });
  const result = await send({
    taskId: TASK_ID,
    desktopName: 'LAPTOP-0Q9SBHOE\nsecret-line',
    pushClientIds: ['controlled-cid-a', 'controlled-cid-a', 'controlled-cid-b'],
    prompt: 'FORBIDDEN_PROMPT',
    reply: 'FORBIDDEN_REPLY',
    cwd: 'FORBIDDEN_CWD',
    summary: 'FORBIDDEN_SUMMARY'
  });
  assert.deepEqual(result, { accepted: true, providerCode: '0', providerStage: 'provider_response', providerMessage: null });
  assert.deepEqual(calls[0], {
    kind: 'manager',
    options: { appId: '__UNI__46C9063' }
  });
  assert.deepEqual(calls[1], {
    kind: 'send',
    request: {
      push_clientid: ['controlled-cid-a', 'controlled-cid-b'],
      title: 'Potato',
      content: '任务完成 · LAPTOP-0Q9SBHOE secret-line',
      payload: { taskId: TASK_ID },
      force_notification: true
    }
  });
  const serialized = JSON.stringify(calls[1].request);
  assert.equal(Object.hasOwn(calls[1].request, 'platform'), false);
  assert.doesNotMatch(serialized, /FORBIDDEN_PROMPT|FORBIDDEN_REPLY|FORBIDDEN_CWD|FORBIDDEN_SUMMARY/);
  assert.deepEqual(Object.keys(calls[1].request.payload), ['taskId']);
});

test('only the current DCloud errCode zero contract is submission evidence', async () => {
  for (const [errCode, accepted, providerCode] of [
    [0, true, '0'],
    [200, false, '200'],
    ['30005', false, '30005'],
    ['unsafe provider detail', false, null]
  ]) {
    const send = core.createTaskCompletedPushSender({
      runtime: {
        getPushManager: () => ({ sendMessage: async () => ({ errCode }) })
      },
      timeoutMs: 100
    });
    assert.deepEqual(await send({
      taskId: TASK_ID,
      pushClientIds: ['controlled-cid']
    }), { accepted, providerCode, providerStage: 'provider_response', providerMessage: null });
  }

  const legacyCodeOnly = core.createTaskCompletedPushSender({
    runtime: {
      getPushManager: () => ({ sendMessage: async () => ({ code: 0 }) })
    },
    timeoutMs: 100
  });
  assert.deepEqual(await legacyCodeOnly({
    taskId: TASK_ID,
    pushClientIds: ['controlled-cid']
  }), { accepted: false, providerCode: null, providerStage: 'provider_response', providerMessage: null });
});

test('runtime extension validation is deferred until send so Phase 1 routes can initialize', async () => {
  let send;
  assert.doesNotThrow(() => {
    send = core.createTaskCompletedPushSender({ runtime: null, timeoutMs: 100 });
  });
  await assert.rejects(send({
    taskId: TASK_ID,
    pushClientIds: ['controlled-cid']
  }), /runtime extension is unavailable/);
});

test('provider call has a bounded timeout and is invoked once', async () => {
  let calls = 0;
  const send = core.createTaskCompletedPushSender({
    runtime: {
      getPushManager: () => ({
        sendMessage: () => {
          calls += 1;
          return new Promise(() => {});
        }
      })
    },
    timeoutMs: 5
  });
  await assert.rejects(send({
    taskId: TASK_ID,
    pushClientIds: ['controlled-cid']
  }), /submission timed out/);
  assert.equal(calls, 1);
});

test('provider payload rejects invalid task IDs, target values, and target counts', () => {
  assert.throws(() => core.buildTaskCompletedNotification({
    taskId: ` ${TASK_ID}`,
    pushClientIds: ['controlled-cid']
  }), /Invalid taskId/);
  assert.throws(() => core.buildTaskCompletedNotification({
    taskId: TASK_ID,
    pushClientIds: []
  }), /1 to 500/);
  assert.throws(() => core.buildTaskCompletedNotification({
    taskId: TASK_ID,
    pushClientIds: Array.from({ length: 501 }, (_value, index) => `controlled-cid-${index}`)
  }), /1 to 500/);
  assert.throws(() => core.buildTaskCompletedNotification({
    taskId: TASK_ID,
    pushClientIds: ['cid\nline']
  }), /Invalid pushClientId/);
});
