'use strict';

const { createRuntimeApplication } = require('./runtime');

const TOKEN_M_ERROR_MESSAGES = Object.freeze({
  body_too_large: 'Request body is too large.',
  configuration_required: 'Server configuration is incomplete.',
  desktop_revoked: 'Desktop credential is not active.',
  event_conflict: 'The event identifier is already used by different event data.',
  internal_error: 'The request could not be completed.',
  invalid_request: 'The request is invalid.',
  pairing_invalid: 'The pairing code is invalid.',
  privacy_consent_required: 'Privacy consent is required.',
  privacy_payload_rejected: 'The privacy payload is invalid.',
  rate_limited: 'Too many requests.',
  task_not_found: 'Task was not found.',
  unauthenticated: 'Authentication is required.',
  unauthorized: 'The operation is not allowed.'
});

const INTERNAL_ERROR = Object.freeze({
  errCode: 'internal_error',
  errMsg: TOKEN_M_ERROR_MESSAGES.internal_error
});

module.exports = {
  async _before() {
    const clientInfo = this.getClientInfo();
    const uniIdCommon = require('uni-id-common');
    const identity = uniIdCommon.createInstance({ clientInfo });
    const checked = await identity.checkToken(this.getUniIdToken());
    const errCode = checked?.errCode || checked?.code;
    if (errCode || typeof checked?.uid !== 'string' || checked.uid.length === 0) {
      throw {
        errCode: errCode || 'uni-id-check-token-failed',
        errMsg: checked?.errMsg || checked?.msg || 'Login required.'
      };
    }
    this.tokenmUid = checked.uid;
    this.tokenmApplication = createRuntimeApplication();
  },

  _after(error, result) {
    if (!error) return result;
    if (
      error.name === 'AppError'
      && typeof error.code === 'string'
      && Object.hasOwn(TOKEN_M_ERROR_MESSAGES, error.code)
    ) {
      return {
        errCode: error.code,
        errMsg: TOKEN_M_ERROR_MESSAGES[error.code]
      };
    }
    const identityCode = typeof error.errCode === 'string' ? error.errCode : error.code;
    if (typeof identityCode === 'string' && identityCode.startsWith('uni-id-')) {
      return {
        errCode: identityCode,
        errMsg: 'Authentication is required.'
      };
    }
    return { ...INTERNAL_ERROR };
  },

  async bootstrap(input = {}) {
    return this.tokenmApplication.bootstrap(this.tokenmUid, input);
  },

  async getAndroidDashboard(input = {}) {
    return this.tokenmApplication.getAndroidDashboard(this.tokenmUid, input);
  },

  async getSettings(input = {}) {
    return this.tokenmApplication.getSettings(this.tokenmUid, input);
  },

  async getDashboard(input = {}) {
    return this.tokenmApplication.getDashboard(this.tokenmUid, input);
  },

  async listTasks(input = {}) {
    return this.tokenmApplication.listTasks(this.tokenmUid, input);
  },

  async getTask(input) {
    return this.tokenmApplication.getTask(this.tokenmUid, input);
  },

  async deleteTask(input) {
    return this.tokenmApplication.deleteTask(this.tokenmUid, input);
  },

  async clearTasks(input) {
    return this.tokenmApplication.clearTasks(this.tokenmUid, input);
  },

  async listDesktops(input = {}) {
    return this.tokenmApplication.listDesktops(this.tokenmUid, input);
  },

  async createPairingCode(input = {}) {
    return this.tokenmApplication.createPairingCode(this.tokenmUid, input);
  },

  async getPairingStatus(input = {}) {
    return this.tokenmApplication.getPairingStatus(this.tokenmUid, input);
  },

  async renameDesktop(input) {
    return this.tokenmApplication.renameDesktop(this.tokenmUid, input);
  },

  async unbindDesktop(input) {
    return this.tokenmApplication.unbindDesktop(this.tokenmUid, input);
  },

  async updateSettings(input) {
    return this.tokenmApplication.updateSettings(this.tokenmUid, input);
  },

  async getPrivacyConsent(input = {}) {
    return this.tokenmApplication.getPrivacyConsent(this.tokenmUid, input);
  },

  async updatePrivacyConsent(input) {
    return this.tokenmApplication.updatePrivacyConsent(this.tokenmUid, input);
  },

  async registerMobileDevice(input = {}) {
    const clientInfo = this.getClientInfo();
    return this.tokenmApplication.registerMobileDevice(this.tokenmUid, input, {
      deviceId: clientInfo.deviceId,
      platform: clientInfo.platform,
      appVersion: clientInfo.appVersion
    });
  },

  async clearTaskHistory(input) {
    return this.tokenmApplication.clearTaskHistory(this.tokenmUid, input);
  },

  async deleteAccount(input) {
    return this.tokenmApplication.deleteAccount(this.tokenmUid, input);
  }
};

// Consent and account/device teardown remain reachable when consent is stale.
const PROTECTED_OPERATIONS = Object.freeze(["bootstrap","getDashboard","listTasks","getTask","listDesktops","createPairingCode","getPairingStatus","renameDesktop","unbindDesktop","updateSettings","deleteTask","clearTasks"]);
for (const method of PROTECTED_OPERATIONS) {
  const operation = module.exports[method];
  module.exports[method] = async function (...args) {
    await this.tokenmApplication.requireCurrentPrivacyConsent(this.tokenmUid);
    return operation.apply(this, args);
  };
}
