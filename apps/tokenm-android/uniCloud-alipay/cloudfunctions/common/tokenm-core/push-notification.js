'use strict';

const TOKEN_M_DCLOUD_APP_ID = '__UNI__46C9063';
const MAX_PUSH_TARGETS = 500;
const MAX_NOTIFICATION_CONTENT_CODE_POINTS = 49;
const DEFAULT_PUSH_TIMEOUT_MS = 4_000;
const PROVIDER_STAGES = new Set([
  'build_request', 'get_push_manager', 'send_message', 'provider_response',
  'provider_timeout', 'provider_persist', 'notification_prepare'
]);

function buildTaskCompletedNotification({ taskId, desktopName, pushClientIds } = {}) {
  const safeTaskId = requiredPayloadString(taskId, 'taskId', 64);
  const targets = uniquePushClientIds(pushClientIds);
  if (targets.length < 1 || targets.length > MAX_PUSH_TARGETS) {
    throw new TypeError('Task completion notifications require 1 to 500 Push targets.');
  }
  const safeDesktopName = singleLineText(desktopName);
  const content = truncateCodePoints(
    safeDesktopName.length > 0 ? `任务完成 · ${safeDesktopName}` : '任务完成',
    MAX_NOTIFICATION_CONTENT_CODE_POINTS
  );
  return {
    push_clientid: targets,
    title: 'Potato',
    content,
    payload: { taskId: safeTaskId },
    force_notification: true
  };
}

function createTaskCompletedPushSender({
  runtime = globalThis.uniCloud,
  appId = TOKEN_M_DCLOUD_APP_ID,
  timeoutMs = DEFAULT_PUSH_TIMEOUT_MS
} = {}) {
  const safeAppId = requiredPayloadString(appId, 'appId', 80);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000) {
    throw new TypeError('Push timeout must be an integer from 1 to 8000 milliseconds.');
  }
  let manager = null;
  return async function sendTaskCompletedNotification(input) {
    let stage = 'build_request';
    const timeoutError = new Error('uni-cloud-push submission timed out.');
    const sensitiveValues = [input?.taskId, input?.desktopName,
      ...(Array.isArray(input?.pushClientIds) ? input.pushClientIds : [])];
    try {
      const request = buildTaskCompletedNotification(input);
      sensitiveValues.push(request.content);
      stage = 'get_push_manager';
      if (!runtime || typeof runtime.getPushManager !== 'function') {
        throw new TypeError('The uni-cloud-push runtime extension is unavailable.');
      }
      if (!manager) manager = runtime.getPushManager({ appId: safeAppId });
      if (!manager || typeof manager.sendMessage !== 'function') {
        throw new TypeError('The uni-cloud-push manager is unavailable.');
      }
      stage = 'send_message';
      const result = await withTimeout(
        Promise.resolve().then(() => manager.sendMessage(request)),
        timeoutMs,
        timeoutError
      );
      stage = 'provider_response';
      const diagnostic = normalizePushProviderError(stage, {
        errCode: result?.errCode,
        errMsg: result?.errMsg
      }, sensitiveValues);
      return {
        accepted: diagnostic.code === '0',
        providerCode: diagnostic.code,
        providerStage: stage,
        providerMessage: diagnostic.code === '0' ? null : diagnostic.safeMessage
      };
    } catch (error) {
      const diagnostic = normalizePushProviderError(
        error === timeoutError ? 'provider_timeout' : stage, error, sensitiveValues
      );
      // Propagate only the bounded diagnostic, never the provider error/cause/request.
      throw Object.assign(new Error(diagnostic.safeMessage ?? 'Push provider failed.'), diagnostic);
    }
  };
}

function withTimeout(operation, timeoutMs, timeoutError) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function uniquePushClientIds(values) {
  if (!Array.isArray(values)) throw new TypeError('pushClientIds must be an array.');
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const parsed = requiredPayloadString(value, 'pushClientId', 512);
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    unique.push(parsed);
  }
  return unique;
}

function requiredPayloadString(value, field, maxLength) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return value;
}

function singleLineText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncateCodePoints(value, limit) {
  return Array.from(value).slice(0, limit).join('');
}

function normalizedProviderCode(value) {
  const candidate = typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : '';
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(candidate) ? candidate : null;
}

function normalizePushProviderError(stage, error, sensitiveValues = []) {
  let code = normalizedProviderCode(error?.errCode ?? error?.code);
  let message = typeof error?.errMsg === 'string' ? error.errMsg : error?.message;
  message = typeof message === 'string' ? message.split(/[\r\n]/u)[0] : '';
  // Provider diagnostics need no request values. Suppress echoed data instead of
  // attempting to serialize or recursively redact the provider's error object.
  for (const value of sensitiveValues) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (code?.includes(value)) code = null;
    if (message.includes(value)) message = '[provider detail omitted]';
  }
  if (/[{}[\]]|https?:\/\/|(?:token|credential|authorization|payload|push_clientid|\bcid\b|taskId|prompt|reply|summary|content|secret)\s*[:=]|\bBearer\s|[A-Za-z0-9_/-]{32,}/iu.test(message)) {
    message = '[provider detail omitted]';
  }
  return {
    stage: PROVIDER_STAGES.has(stage) ? stage : 'send_message',
    code,
    safeMessage: singleLineText(message).slice(0, 240) || null
  };
}

module.exports = {
  DEFAULT_PUSH_TIMEOUT_MS,
  MAX_PUSH_TARGETS,
  TOKEN_M_DCLOUD_APP_ID,
  buildTaskCompletedNotification,
  createTaskCompletedPushSender,
  normalizePushProviderError,
  normalizedProviderCode
};
