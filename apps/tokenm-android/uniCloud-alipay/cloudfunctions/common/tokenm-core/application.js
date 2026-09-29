'use strict';

const { isIP } = require('node:net');
const { putUsageSnapshot, listUsageSnapshots } = require('./usage-service');
const {
  createDesktopCredential,
  decryptSecret,
  parseDesktopCredential,
  secretsMatch
} = require('./credential');
const { AppError, RepositoryConflictError, invalidRequest } = require('./errors');
const { pairingCode, randomId, randomTombstone } = require('./ids');
const { COLLECTIONS, IDENTITY_COLLECTIONS, assertRepository } = require('./repository-contract');
const {
  MAX_PUSH_TARGETS,
  TOKEN_M_DCLOUD_APP_ID,
  normalizePushProviderError,
  normalizedProviderCode
} = require('./push-notification');
const {
  assertDesktopId,
  assertExactObject,
  assertTaskId,
  desktopName,
  eventsEqual,
  positivePageSize,
  requiredString,
  validateEvent
} = require('./validation');

const PAIRING_TTL_MS = 600_000;
const PAIRING_MAX_ATTEMPTS = 5;
const CURRENT_PRIVACY_VERSION = 'tokenm-android-v1';
const NOTIFICATION_STATUS = 'not_requested';
const DELIVERY_STATUS = Object.freeze({
  NOT_REQUESTED: NOTIFICATION_STATUS,
  SKIPPED_DISABLED: 'skipped_disabled',
  SKIPPED_NO_TARGET: 'skipped_no_target',
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  FAILED: 'failed'
});
const DELIVERY_STATUSES = new Set(Object.values(DELIVERY_STATUS));

const DEFAULT_RATE_RULES = Object.freeze({
  pairingCreate: Object.freeze({ scope: 'pairing-create', limit: 5, windowMs: 60_000 }),
  desktopPair: Object.freeze({ scope: 'desktop-pair', limit: 5, windowMs: 600_000 })
});

class TokenMApplication {
  constructor({ repository, credentialKey, now, rateRules, sendTaskCompletedNotification } = {}) {
    this.repository = assertRepository(repository);
    if (!Buffer.isBuffer(credentialKey) || credentialKey.length !== 32) {
      throw new AppError('configuration_required');
    }
    this.credentialKey = Buffer.from(credentialKey);
    this.now = typeof now === 'function' ? now : Date.now;
    this.rateRules = mergeRateRules(rateRules);
    if (
      sendTaskCompletedNotification !== undefined
      && typeof sendTaskCompletedNotification !== 'function'
    ) {
      throw new TypeError('sendTaskCompletedNotification must be a function.');
    }
    this.sendTaskCompletedNotification = sendTaskCompletedNotification ?? null;
  }

  async bootstrap(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, []);
    const user = await this.ensureUser(ownerId);
    const [desktops, devices] = await Promise.all([
      this.repository.findMany(COLLECTIONS.desktops, { ownerId }),
      this.repository.findMany(COLLECTIONS.mobileDevices, { ownerId })
    ]);
    return {
      ok: true,
      user: publicUser(user),
      counts: {
        activeDesktops: desktops.filter((entry) => entry.status === 'active').length,
        tasks: await this.repository.countWhere(COLLECTIONS.tasks, this.repository.taskHistoryCriteria(ownerId, { after: user.historyClearedAtMs })),
        activeMobileDevices: devices.filter((entry) => entry.status === 'active').length
      }
    };
  }

  async requireCurrentPrivacyConsent(ownerId) {
    assertOwner(ownerId);
    const user = await this.ensureUser(ownerId);
    if (!hasCurrentPrivacyConsent(user)) throw new AppError('privacy_consent_required');
    return user;
  }

  // Android needs no total-history/device scan or legacy latestTask projection.
  async getAndroidDashboard(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, ['dayStart', 'dayEnd']);
    const dayRange = dashboardDayRange(input, this.now());
    const user = await this.requireCurrentPrivacyConsent(ownerId);
    const [tasks, desktops, activeDesktops, todayTasks] = await Promise.all([
      this.repository.findMany(COLLECTIONS.tasks, this.repository.taskHistoryCriteria(ownerId, { after: user.historyClearedAtMs }), {
        sort: [{ field: 'createdAtMs', direction: 'desc' }, { field: '_id', direction: 'desc' }], limit: 3
      }),
      this.repository.findMany(COLLECTIONS.desktops, { ownerId, status: 'active' }, { sortBy: 'createdAtMs', direction: 'desc', limit: 2 }),
      this.repository.countWhere(COLLECTIONS.desktops, { ownerId, status: 'active' }),
      this.repository.countWhere(COLLECTIONS.tasks, this.repository.taskHistoryCriteria(ownerId, {
        after: user.historyClearedAtMs, day: { start: toIso(dayRange.startMs), end: toIso(dayRange.endMs) }
      }))
    ]);
    const recentTasks = await Promise.all(tasks.map(async task => {
      const desktop = await this.repository.findById(COLLECTIONS.desktops, task.desktopId);
      return { task: publicTask(task), desktopName: desktop?.ownerId === ownerId ? desktop.name : '未知电脑' };
    }));
    return { settings: publicSettings(user), counts: { activeDesktops, todayTasks }, recentTasks, recentDesktops: desktops.map(publicDesktop) };
  }

  async getSettings(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, []);
    return { settings: publicSettings(await this.requireCurrentPrivacyConsent(ownerId)) };
  }

  async getDashboard(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, ['dayStart', 'dayEnd']);
    const dayRange = dashboardDayRange(input, this.now());
    const user = await this.ensureUser(ownerId);
    const [desktops, storedTasks, devices] = await Promise.all([
      this.repository.findMany(COLLECTIONS.desktops, { ownerId }),
      this.repository.findMany(COLLECTIONS.tasks, this.repository.taskHistoryCriteria(ownerId, { after: user.historyClearedAtMs }), {
        sortBy: 'createdAtMs',
        direction: 'desc'
      }),
      this.repository.findMany(COLLECTIONS.mobileDevices, { ownerId })
    ]);
    const tasks = visibleTasks(storedTasks, user);
    return {
      settings: publicSettings(user),
      counts: {
        activeDesktops: desktops.filter((entry) => entry.status === 'active').length,
        tasks: await this.repository.countWhere(COLLECTIONS.tasks, this.repository.taskHistoryCriteria(ownerId, { after: user.historyClearedAtMs })),
        activeMobileDevices: devices.filter((entry) => entry.status === 'active').length,
        todayTasks: await this.repository.countWhere(COLLECTIONS.tasks, this.repository.taskHistoryCriteria(ownerId, {
          after: user.historyClearedAtMs,
          day: { start: toIso(dayRange.startMs), end: toIso(dayRange.endMs) }
        }))
      },
      latestTask: tasks[0] ? publicTask(tasks[0]) : null
    };
  }

  async listTasks(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, [
      'limit',
      'desktopId',
      'notificationStatus',
      'notificationStatuses',
      'privacyMode',
      'cursor'
    ]);
    const limit = positivePageSize(input.limit);
    if (input.desktopId !== undefined) assertDesktopId(input.desktopId);
    if (input.notificationStatus !== undefined && !DELIVERY_STATUSES.has(input.notificationStatus)) {
      throw invalidRequest('notificationStatus');
    }
    if (input.notificationStatus !== undefined && input.notificationStatuses !== undefined) {
      throw invalidRequest('notificationStatuses');
    }
    let notificationStatuses = null;
    if (input.notificationStatuses !== undefined) {
      if (
        !Array.isArray(input.notificationStatuses)
        || input.notificationStatuses.length < 1
        || input.notificationStatuses.length > DELIVERY_STATUSES.size
        || input.notificationStatuses.some((status) => !DELIVERY_STATUSES.has(status))
        || new Set(input.notificationStatuses).size !== input.notificationStatuses.length
      ) {
        throw invalidRequest('notificationStatuses');
      }
      notificationStatuses = input.notificationStatuses;
    }
    if (input.privacyMode !== undefined && typeof input.privacyMode !== 'boolean') {
      throw invalidRequest('privacyMode');
    }
    const cursor = validateTaskCursor(input.cursor);
    const user = await this.ensureUser(ownerId);
    const filtered = await this.repository.findMany(COLLECTIONS.tasks, this.repository.taskHistoryCriteria(ownerId, {
      after: user.historyClearedAtMs, cursor,
      desktopId: input.desktopId, notificationStatus: input.notificationStatus,
      notificationStatuses, privacyMode: input.privacyMode
    }), {
      sort: [{ field: 'createdAtMs', direction: 'desc' }, { field: '_id', direction: 'desc' }],
      limit: limit + 1
    });
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    return {
      tasks: page.map(publicTask),
      nextCursor: hasMore ? {
        createdAtMs: page.at(-1).createdAtMs,
        taskId: page.at(-1)._id
      } : null
    };
  }

  async getTask(ownerId, input) {
    assertOwner(ownerId);
    assertExactObject(input, ['taskId']);
    const taskId = assertTaskId(input.taskId);
    const task = await this.repository.findById(COLLECTIONS.tasks, taskId);
    const user = await this.ensureUser(ownerId);
    if (!task || task.ownerId !== ownerId || !isVisibleTask(task, user)) {
      throw new AppError('task_not_found');
    }
    return { task: publicTask(task) };
  }

  async listDesktops(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, []);
    const desktops = await this.repository.findMany(COLLECTIONS.desktops, { ownerId }, {
      sortBy: 'createdAtMs',
      direction: 'desc'
    });
    return { desktops: desktops.map(publicDesktop) };
  }

  async createPairingCode(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, []);
    await this.ensureUser(ownerId);
    const nowMs = this.now();
    await this.consumeRateLimit(this.rateRules.pairingCreate, ownerId, nowMs, ownerId);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const session = {
        _id: randomId('pairingSession'),
        ownerId,
        code: pairingCode(),
        activeOwnerKey: ownerId,
        codeUniquenessKey: null,
        ownerUniquenessKey: ownerId,
        status: 'active',
        attemptCount: 0,
        maxAttempts: PAIRING_MAX_ATTEMPTS,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + PAIRING_TTL_MS,
        usedAtMs: null,
        desktopId: null
      };
      session.codeUniquenessKey = session.code;
      try {
        await this.repository.runTransaction(async (transaction) => {
          const collision = await transaction.findOne(COLLECTIONS.pairingSessions, {
            code: session.code,
            status: 'active'
          });
          if (collision) throw new RepositoryConflictError('pairing_code');
          const active = await transaction.findOne(COLLECTIONS.pairingSessions, {
            activeOwnerKey: ownerId
          });
          if (active) {
            await transaction.updateById(COLLECTIONS.pairingSessions, active._id, {
              status: 'superseded',
              code: null,
              activeOwnerKey: null,
              codeUniquenessKey: randomTombstone(),
              ownerUniquenessKey: randomTombstone()
            });
          }
          await transaction.insert(COLLECTIONS.pairingSessions, session);
        });
        return {
          ok: true,
          sessionId: session._id,
          code: session.code,
          expiresAt: toIso(session.expiresAtMs),
          ttlSeconds: PAIRING_TTL_MS / 1000
        };
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
      }
    }
    throw new AppError('internal_error');
  }

  async getPairingStatus(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, ['sessionId']);
    let session;
    if (input.sessionId !== undefined) {
      const sessionId = requiredString(input.sessionId, 'sessionId', 255);
      session = await this.repository.findById(COLLECTIONS.pairingSessions, sessionId);
      if (!session || session.ownerId !== ownerId) throw new AppError('pairing_invalid');
    } else {
      const sessions = await this.repository.findMany(COLLECTIONS.pairingSessions, { ownerId }, {
        sortBy: 'createdAtMs',
        direction: 'desc',
        limit: 1
      });
      session = sessions[0] ?? null;
    }
    if (!session) return { status: 'none', sessionId: null, expiresAt: null, desktopId: null };
    if (session.status === 'active' && session.expiresAtMs <= this.now()) {
      session = await this.repository.runTransaction(async (transaction) => {
        const current = await transaction.findById(COLLECTIONS.pairingSessions, session._id);
        if (current?.status === 'active' && current.expiresAtMs <= this.now()) {
          return transaction.updateById(COLLECTIONS.pairingSessions, current._id, {
            status: 'expired',
            code: null,
            activeOwnerKey: null,
            codeUniquenessKey: randomTombstone(),
            ownerUniquenessKey: randomTombstone()
          });
        }
        return current;
      });
    }
    return publicPairingStatus(session);
  }

  async renameDesktop(ownerId, input) {
    assertOwner(ownerId);
    assertExactObject(input, ['desktopId', 'name']);
    const desktop = await this.requireOwnedDesktop(ownerId, assertDesktopId(input.desktopId));
    if (desktop.status !== 'active') throw new AppError('desktop_revoked');
    const nowMs = this.now();
    const updated = await this.repository.runTransaction((transaction) => (
      transaction.updateById(COLLECTIONS.desktops, desktop._id, {
        name: desktopName(input.name),
        updatedAtMs: nowMs
      })
    ));
    return { ok: true, desktop: publicDesktop(updated) };
  }

  async unbindDesktop(ownerId, input) {
    assertOwner(ownerId);
    assertExactObject(input, ['desktopId', 'confirmation']);
    const desktop = await this.requireOwnedDesktop(ownerId, assertDesktopId(input.desktopId));
    if (input.confirmation !== 'UNBIND') throw invalidRequest('confirmation');
    if (desktop.status === 'revoked') {
      await this.repository.removeWhere(COLLECTIONS.usageSnapshots, { desktopId: desktop._id });
      return { ok: true, alreadyRevoked: true, desktop: publicDesktop(desktop) };
    }
    const nowMs = this.now();
    const updated = await this.repository.runTransaction(async (transaction) => {
      const current = await transaction.findById(COLLECTIONS.desktops, desktop._id);
      if (current.status === 'revoked') return current;
      const revoked = await transaction.updateById(COLLECTIONS.desktops, desktop._id, {
        status: 'revoked',
        encryptedSecret: null,
        revokedAtMs: nowMs,
        updatedAtMs: nowMs
      });
      return revoked;
    });
    await this.repository.removeWhere(COLLECTIONS.usageSnapshots, { desktopId: desktop._id });
    return { ok: true, alreadyRevoked: false, desktop: publicDesktop(updated) };
  }

  async updateSettings(ownerId, input) {
    assertOwner(ownerId);
    assertExactObject(input, ['notificationsEnabled']);
    if (typeof input.notificationsEnabled !== 'boolean') throw invalidRequest('notificationsEnabled');
    const user = await this.ensureUser(ownerId);
    const updated = await this.repository.runTransaction((transaction) => (
      transaction.updateById(COLLECTIONS.users, user._id, {
        notificationsEnabled: input.notificationsEnabled,
        updatedAtMs: this.now()
      })
    ));
    return { ok: true, settings: publicSettings(updated) };
  }

  async getPrivacyConsent(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, []);
    const user = await this.ensureUser(ownerId);
    return { privacyConsent: publicPrivacyConsent(user) };
  }

  async updatePrivacyConsent(ownerId, input) {
    assertOwner(ownerId);
    assertExactObject(input, ['version']);
    if (input.version !== CURRENT_PRIVACY_VERSION) throw invalidRequest('version');
    const user = await this.ensureUser(ownerId);
    const consentedAtMs = this.now();
    const updated = await this.repository.runTransaction((transaction) => (
      transaction.updateById(COLLECTIONS.users, user._id, {
        privacyConsentVersion: CURRENT_PRIVACY_VERSION,
        privacyConsentAtMs: consentedAtMs,
        updatedAtMs: consentedAtMs
      })
    ));
    return { ok: true, privacyConsent: publicPrivacyConsent(updated) };
  }

  async registerMobileDevice(ownerId, input = {}, clientIdentity = {}) {
    assertOwner(ownerId);
    assertExactObject(input, [
      'enabled',
      'deviceLabel',
      'pushRegistrationStatus',
      'notificationPermissionState'
    ]);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw invalidRequest('enabled');
    assertExactObject(clientIdentity, ['deviceId', 'platform', 'appVersion']);
    const deviceId = requiredString(clientIdentity.deviceId, 'deviceId', 255);
    if (!/^[\x21-\x7e]+$/.test(deviceId)) throw invalidRequest('deviceId');
    const platform = requiredAsciiString(clientIdentity.platform, 'platform', 32);
    const appVersion = optionalAsciiString(clientIdentity.appVersion, 'appVersion', 40);
    const deviceLabel = input.deviceLabel === undefined
      ? 'Android device'
      : requiredString(input.deviceLabel, 'deviceLabel', 80);
    const pushRegistrationStatus = input.pushRegistrationStatus ?? 'notStarted';
    if (!['notStarted', 'ready', 'error'].includes(pushRegistrationStatus)) {
      throw invalidRequest('pushRegistrationStatus');
    }
    const notificationPermissionState = input.notificationPermissionState ?? 'notDetermined';
    if (!['notDetermined', 'authorized', 'denied'].includes(notificationPermissionState)) {
      throw invalidRequest('notificationPermissionState');
    }
    const user = await this.ensureUser(ownerId);
    const nowMs = this.now();
    const status = input.enabled === false ? 'disabled' : 'active';
    if (status === 'active' && !hasCurrentPrivacyConsent(user)) {
      throw new AppError('privacy_consent_required');
    }
    const stored = await this.repository.runTransaction(async (transaction) => {
      const current = await transaction.findOne(COLLECTIONS.mobileDevices, { ownerId, deviceId });
      if (current) {
        return transaction.updateById(COLLECTIONS.mobileDevices, current._id, {
          status,
          platform,
          deviceLabel,
          pushRegistrationStatus,
          notificationPermissionState,
          appVersion,
          updatedAtMs: nowMs,
          lastSeenAtMs: nowMs
        });
      }
      const created = {
        _id: randomId('mobileDevice'),
        ownerId,
        deviceId,
        platform,
        deviceLabel,
        pushRegistrationStatus,
        notificationPermissionState,
        appVersion,
        status,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        lastSeenAtMs: nowMs
      };
      await transaction.insert(COLLECTIONS.mobileDevices, created);
      return created;
    });
    return { ok: true, device: publicMobileDevice(stored) };
  }

  async deleteTask(ownerId, input) {
    assertOwner(ownerId);
    assertExactObject(input, ['taskId']);
    const taskId = assertTaskId(input.taskId);
    await this.ensureUser(ownerId);
    const task = await this.repository.findById(COLLECTIONS.tasks, taskId);
    if (!task || task.ownerId !== ownerId) throw new AppError('task_not_found');
    await this.repository.updateWhere(COLLECTIONS.tasks, {
      ...this.repository.taskHistoryCriteria(ownerId), _id: taskId
    }, taskTombstone(this.now()));
    return { ok: true, taskId };
  }

  async clearTasks(ownerId, input = {}) {
    assertOwner(ownerId);
    assertExactObject(input, ['confirmation']);
    if (input.confirmation !== 'CLEAR') throw invalidRequest('confirmation');
    const clearedAtMs = this.now();
    await this.ensureUser(ownerId);
    // A single server-side update; no pagination limit, user watermark or retry queue.
    const deletedCount = await this.repository.updateWhere(COLLECTIONS.tasks,
      this.repository.taskHistoryCriteria(ownerId, { through: clearedAtMs }), taskTombstone(clearedAtMs));
    return { ok: true, clearedAt: toIso(clearedAtMs), deletedCount, cleanupPending: false };
  }

  async clearTaskHistory(ownerId, input) {
    return this.clearTasks(ownerId, input);
  }

  async deleteAccount(ownerId, input) {
    assertOwner(ownerId);
    assertExactObject(input, ['confirmation']);
    if (input.confirmation !== 'DELETE') throw invalidRequest('confirmation');
    await this.ensureUser(ownerId);
    const deletionRequestedAtMs = this.now();
    const cleanupCollections = [
      [COLLECTIONS.usageSnapshots, { ownerId }],
      [COLLECTIONS.tasks, { ownerId }],
      [COLLECTIONS.desktops, { ownerId }],
      [COLLECTIONS.pairingSessions, { ownerId }],
      [COLLECTIONS.mobileDevices, { ownerId }],
      [COLLECTIONS.rateLimits, { ownerId }]
    ];
    await this.repository.runTransaction(async (transaction) => {
      await transaction.updateById(COLLECTIONS.users, ownerId, {
        notificationsEnabled: false,
        deletionRequestedAtMs,
        updatedAtMs: deletionRequestedAtMs
      });
      for (const [collection, criteria] of cleanupCollections) {
        await removeMatchingDocuments(transaction, collection, criteria, 100);
      }
    });
    const remaining = await Promise.all(cleanupCollections.map(([collection, criteria]) => (
      this.repository.findOne(collection, criteria)
    )));
    const cleanupPending = remaining.some(Boolean);
    if (!cleanupPending) {
      await this.repository.runTransaction((transaction) => (
        transaction.removeById(COLLECTIONS.users, ownerId)
      ));
    }
    return {
      ok: true,
      deletionRequestedAt: toIso(deletionRequestedAtMs),
      cleanupPending
    };
  }

  async pair(input, context) {
    const subject = validatedClientIpRateSubject(context);
    assertExactObject(input, ['schemaVersion', 'code', 'deviceName']);
    const nowMs = this.now();
    await this.consumeRateLimit(this.rateRules.desktopPair, subject, nowMs, null);
    if (input.schemaVersion !== 1 || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) {
      throw new AppError('pairing_invalid');
    }
    const name = desktopName(input.deviceName);
    const found = await this.repository.findOne(COLLECTIONS.pairingSessions, { code: input.code });
    if (!found) throw new AppError('pairing_invalid');

    const result = await this.repository.runTransaction(async (transaction) => {
      const session = await transaction.findById(COLLECTIONS.pairingSessions, found._id);
      if (!session || session.status !== 'active') return { paired: false };
      const nextAttemptCount = session.attemptCount + 1;
      if (session.expiresAtMs <= nowMs || nextAttemptCount > session.maxAttempts) {
        await transaction.updateById(COLLECTIONS.pairingSessions, session._id, {
          status: session.expiresAtMs <= nowMs ? 'expired' : 'locked',
          attemptCount: nextAttemptCount,
          code: null,
          activeOwnerKey: null,
          codeUniquenessKey: randomTombstone(),
          ownerUniquenessKey: randomTombstone()
        });
        return { paired: false };
      }
      const desktopId = randomId('desktop');
      const createdCredential = createDesktopCredential(desktopId, this.credentialKey);
      const desktop = {
        _id: desktopId,
        ownerId: session.ownerId,
        name,
        status: 'active',
        encryptedSecret: createdCredential.encryptedSecret,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        revokedAtMs: null,
        lastSeenAtMs: null,
        lastEventAtMs: null
      };
      await transaction.insert(COLLECTIONS.desktops, desktop);
      await transaction.updateById(COLLECTIONS.pairingSessions, session._id, {
        status: 'paired',
        attemptCount: nextAttemptCount,
        code: null,
        activeOwnerKey: null,
        codeUniquenessKey: randomTombstone(),
        ownerUniquenessKey: randomTombstone(),
        usedAtMs: nowMs,
        desktopId
      });
      return { paired: true, desktop, credential: createdCredential.credential };
    });
    if (!result.paired) throw new AppError('pairing_invalid');
    return {
      status: 'paired',
      desktop: {
        desktopId: result.desktop._id,
        name: result.desktop.name
      },
      credential: result.credential
    };
  }

  async putUsageSnapshot(credential, input) {
    return putUsageSnapshot(this, credential, input);
  }

  async listUsageSnapshots(credential, input = {}) {
    return listUsageSnapshots(this, credential, input);
  }

  async status(credential) {
    const desktop = await this.authenticateDesktop(credential);
    const nowMs = this.now();
    const updated = await this.repository.runTransaction((transaction) => (
      transaction.updateById(COLLECTIONS.desktops, desktop._id, {
        lastSeenAtMs: nowMs,
        updatedAtMs: nowMs
      })
    ));
    return { ok: true, desktop: publicDesktop(updated), serverTime: toIso(nowMs) };
  }

  async events(credential, input) {
    const nowMs = this.now();
    const desktop = await this.authenticateDesktop(credential);
    const event = validateEvent(input, nowMs);
    if (event.desktopId !== desktop._id) throw new AppError('unauthorized');
    await this.ensureUser(desktop.ownerId);
    const task = {
      _id: randomId('task'),
      ownerId: desktop.ownerId,
      ...event,
      notificationStatus: NOTIFICATION_STATUS,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    };

    let creation;
    try {
      creation = await this.repository.runTransaction(async (transaction) => {
        const existing = await transaction.findOne(COLLECTIONS.tasks, {
          desktopId: event.desktopId,
          eventId: event.eventId
        });
        if (existing) return { created: false, existing };
        await transaction.insert(COLLECTIONS.tasks, task);
        await transaction.updateById(COLLECTIONS.desktops, desktop._id, {
          lastSeenAtMs: nowMs,
          lastEventAtMs: nowMs,
          updatedAtMs: nowMs
        });
        return { created: true };
      });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error;
      const existing = await this.repository.findOne(COLLECTIONS.tasks, {
        desktopId: event.desktopId,
        eventId: event.eventId
      });
      creation = { created: false, existing };
    }

    if (!creation.created) return duplicateResult(creation.existing, event);
    const notificationStatus = await this.processTaskNotification(task, desktop);
    return createdResult(task._id, notificationStatus);
  }

  async processTaskNotification(task, desktop) {
    if (!this.sendTaskCompletedNotification) return DELIVERY_STATUS.NOT_REQUESTED;
    let claimed = false;
    let providerStage = 'notification_prepare';
    let sensitiveValues = [task._id, desktop.name, task.summary, task.project, task.sessionId];
    try {
      const currentUser = await this.repository.findById(COLLECTIONS.users, task.ownerId);
      if (!currentUser) throw new Error('Notification owner unavailable.');
      if (!currentUser.notificationsEnabled) {
        return this.transitionNotification(task._id, DELIVERY_STATUS.NOT_REQUESTED, {
          notificationStatus: DELIVERY_STATUS.SKIPPED_DISABLED,
          notificationReason: 'notifications_disabled',
          notificationTargetCount: 0,
          updatedAtMs: this.now()
        });
      }
      if (!hasCurrentPrivacyConsent(currentUser)) {
        return this.transitionNotification(task._id, DELIVERY_STATUS.NOT_REQUESTED, {
          notificationStatus: DELIVERY_STATUS.SKIPPED_DISABLED,
          notificationReason: 'privacy_consent_required',
          notificationTargetCount: 0,
          updatedAtMs: this.now()
        });
      }

      const targetResolution = await this.resolveNotificationTargets(task.ownerId);
      if (targetResolution.eligibleDeviceCount === 0) {
        return this.transitionNotification(task._id, DELIVERY_STATUS.NOT_REQUESTED, {
          notificationStatus: DELIVERY_STATUS.SKIPPED_NO_TARGET,
          notificationReason: 'no_eligible_device',
          notificationTargetCount: 0,
          updatedAtMs: this.now()
        });
      }
      if (targetResolution.pushClientIds.length === 0) {
        return this.transitionNotification(task._id, DELIVERY_STATUS.NOT_REQUESTED, {
          notificationStatus: DELIVERY_STATUS.SKIPPED_NO_TARGET,
          notificationReason: 'cid_unavailable',
          notificationTargetCount: 0,
          updatedAtMs: this.now()
        });
      }

      const attemptedAtMs = this.now();
      const claim = await this.claimNotification(task._id, {
        notificationStatus: DELIVERY_STATUS.PENDING,
        notificationTargetCount: targetResolution.pushClientIds.length,
        notificationAttemptedAtMs: attemptedAtMs,
        updatedAtMs: attemptedAtMs
      });
      if (!claim.claimed) return claim.status;
      claimed = true;
      providerStage = 'send_message';
      sensitiveValues = sensitiveValues.concat(targetResolution.pushClientIds);

      const submission = await this.sendTaskCompletedNotification({
        taskId: task._id,
        desktopName: desktop.name,
        pushClientIds: targetResolution.pushClientIds
      });
      const providerCode = normalizedProviderCode(submission?.providerCode);
      if (
        submission?.accepted !== true
        || providerCode !== '0'
      ) {
        return this.transitionNotification(task._id, DELIVERY_STATUS.PENDING, {
          notificationStatus: DELIVERY_STATUS.FAILED,
          notificationReason: 'provider_error',
          notificationProviderStage: 'provider_response',
          notificationProviderCode: providerCode,
          notificationProviderMessage: normalizePushProviderError('provider_response', {
            message: submission?.providerMessage
          }, sensitiveValues).safeMessage,
          updatedAtMs: this.now()
        });
      }
      const submittedAtMs = this.now();
      return this.transitionNotification(task._id, DELIVERY_STATUS.PENDING, {
        notificationStatus: DELIVERY_STATUS.SUBMITTED,
        notificationProviderStage: 'provider_response',
        notificationProviderCode: providerCode,
        notificationProviderMessage: null,
        notificationSubmittedAtMs: submittedAtMs,
        updatedAtMs: submittedAtMs
      });
    } catch (error) {
      const diagnostic = normalizePushProviderError(error?.stage ?? providerStage, error, sensitiveValues);
      return this.transitionNotification(
        task._id,
        claimed ? DELIVERY_STATUS.PENDING : DELIVERY_STATUS.NOT_REQUESTED,
        {
          notificationStatus: DELIVERY_STATUS.FAILED,
          notificationReason: 'provider_error',
          notificationProviderStage: diagnostic.stage,
          notificationProviderCode: diagnostic.code,
          notificationProviderMessage: diagnostic.safeMessage,
          updatedAtMs: this.now()
        }
      );
    }
  }

  async resolveNotificationTargets(ownerId) {
    const devices = await this.repository.findMany(
      COLLECTIONS.mobileDevices,
      { ownerId, status: 'active' },
      { sortBy: 'lastSeenAtMs', direction: 'desc', limit: MAX_PUSH_TARGETS }
    );
    const eligibleDeviceIds = new Set(devices
      .filter((device) => (
        device.pushRegistrationStatus === 'ready'
        && device.notificationPermissionState === 'authorized'
        && isAndroidAppPlatform(device.platform)
        && typeof device.deviceId === 'string'
        && device.deviceId.length > 0
      ))
      .map((device) => device.deviceId));
    if (eligibleDeviceIds.size === 0) {
      return { eligibleDeviceCount: 0, pushClientIds: [] };
    }

    const nowMs = this.now();
    const identities = await this.repository.findMany(
      IDENTITY_COLLECTIONS.devices,
      { user_id: ownerId, appid: TOKEN_M_DCLOUD_APP_ID },
      { limit: MAX_PUSH_TARGETS }
    );
    const pushClientIds = [];
    const seen = new Set();
    for (const identity of identities) {
      if (
        identity.user_id !== ownerId
        || identity.appid !== TOKEN_M_DCLOUD_APP_ID
        || !eligibleDeviceIds.has(identity.device_id)
        || !Number.isFinite(identity.token_expired)
        || identity.token_expired <= nowMs
        || !isUsablePushClientId(identity.push_clientid)
        || seen.has(identity.push_clientid)
      ) {
        continue;
      }
      seen.add(identity.push_clientid);
      pushClientIds.push(identity.push_clientid);
    }
    return {
      eligibleDeviceCount: eligibleDeviceIds.size,
      pushClientIds
    };
  }

  async transitionNotification(taskId, fromStatus, patch) {
    try {
      const updated = await this.repository.updateWhere(
        COLLECTIONS.tasks,
        { _id: taskId, notificationStatus: fromStatus },
        patch
      );
      if (updated === 1) return patch.notificationStatus;
      const current = await this.repository.findById(COLLECTIONS.tasks, taskId);
      return DELIVERY_STATUSES.has(current?.notificationStatus)
        ? current.notificationStatus
        : fromStatus;
    } catch (_error) {
      // A database failure cannot reliably be recorded in that database. Keep
      // the claim terminal for sending and emit only fixed, safe persistence facts.
      if (fromStatus === DELIVERY_STATUS.PENDING) {
        console.error('tokenm_push_provider', {
          taskId,
          stage: 'provider_persist',
          code: null,
          safeMessage: 'Notification outcome persistence failed.',
          intendedStatus: patch.notificationStatus
        });
      }
      return fromStatus;
    }
  }

  async claimNotification(taskId, patch) {
    try {
      const updated = await this.repository.updateWhere(
        COLLECTIONS.tasks,
        { _id: taskId, notificationStatus: DELIVERY_STATUS.NOT_REQUESTED },
        patch
      );
      if (updated === 1) return { claimed: true, status: DELIVERY_STATUS.PENDING };
      const current = await this.repository.findById(COLLECTIONS.tasks, taskId);
      return {
        claimed: false,
        status: DELIVERY_STATUSES.has(current?.notificationStatus)
          ? current.notificationStatus
          : DELIVERY_STATUS.NOT_REQUESTED
      };
    } catch (_error) {
      return { claimed: false, status: DELIVERY_STATUS.NOT_REQUESTED };
    }
  }

  async unpairSelf(credential, input) {
    assertExactObject(input, ['confirmation']);
    if (input.confirmation !== 'UNPAIR') throw invalidRequest('confirmation');
    const desktop = await this.authenticateDesktop(credential);
    const nowMs = this.now();
    await this.repository.runTransaction(async (transaction) => {
      const current = await transaction.findById(COLLECTIONS.desktops, desktop._id);
      if (!current || current.status !== 'active') throw new AppError('desktop_revoked');
      await transaction.updateById(COLLECTIONS.desktops, desktop._id, {
        status: 'revoked',
        encryptedSecret: null,
        revokedAtMs: nowMs,
        updatedAtMs: nowMs
      });
    });
    await this.repository.removeWhere(COLLECTIONS.usageSnapshots, { desktopId: desktop._id });
    return { ok: true };
  }

  async ensureUser(ownerId) {
    const existing = await this.repository.findById(COLLECTIONS.users, ownerId);
    if (existing) return existing;
    const nowMs = this.now();
    try {
      return await this.repository.runTransaction(async (transaction) => {
        const current = await transaction.findById(COLLECTIONS.users, ownerId);
        if (current) return current;
        const created = {
          _id: ownerId,
          ownerId,
          notificationsEnabled: false,
          privacyConsentVersion: null,
          privacyConsentAtMs: null,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          historyClearedAtMs: null
        };
        await transaction.insert(COLLECTIONS.users, created);
        return created;
      });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error;
      return this.repository.findById(COLLECTIONS.users, ownerId);
    }
  }

  async requireOwnedDesktop(ownerId, desktopId) {
    const desktop = await this.repository.findById(COLLECTIONS.desktops, desktopId);
    if (!desktop || desktop.ownerId !== ownerId) throw new AppError('unauthorized');
    return desktop;
  }

  async authenticateDesktop(value) {
    const parsed = parseDesktopCredential(value);
    const desktop = await this.repository.findById(COLLECTIONS.desktops, parsed.desktopId);
    if (!desktop) throw new AppError('unauthenticated');
    if (desktop.status !== 'active' || !desktop.encryptedSecret) {
      throw new AppError('desktop_revoked');
    }
    const storedSecret = decryptSecret(desktop.encryptedSecret, desktop._id, this.credentialKey);
    if (!secretsMatch(parsed.secret, storedSecret)) throw new AppError('unauthenticated');
    return desktop;
  }

  async consumeRateLimit(rule, subject, nowMs, ownerId = null) {
    const safeSubject = rateSubject(subject);
    const bucket = Math.floor(nowMs / rule.windowMs);
    const allowed = await this.repository.runTransaction(async (transaction) => {
      const oldBuckets = await transaction.findMany(
        COLLECTIONS.rateLimits,
        rule.scope === 'desktop-pair'
          ? { scope: rule.scope }
          : { scope: rule.scope, subject: safeSubject },
        { limit: 100 }
      );
      for (const oldBucket of oldBuckets) {
        if (oldBucket.expiresAtMs <= nowMs && oldBucket.bucket !== bucket) {
          await transaction.removeById(COLLECTIONS.rateLimits, oldBucket._id);
        }
      }
      const current = await transaction.findOne(COLLECTIONS.rateLimits, {
        scope: rule.scope,
        subject: safeSubject,
        bucket
      });
      if (current) {
        if (current.count >= rule.limit) return false;
        await transaction.updateById(COLLECTIONS.rateLimits, current._id, {
          count: current.count + 1,
          updatedAtMs: nowMs
        });
        return true;
      }
      await transaction.insert(COLLECTIONS.rateLimits, {
        _id: randomId('rateLimit'),
        scope: rule.scope,
        subject: safeSubject,
        ownerId,
        bucket,
        count: 1,
        limit: rule.limit,
        windowMs: rule.windowMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        expiresAtMs: (bucket + 1) * rule.windowMs
      });
      return true;
    });
    if (!allowed) throw new AppError('rate_limited');
  }
}

function mergeRateRules(overrides = {}) {
  const merged = {};
  for (const [name, defaultRule] of Object.entries(DEFAULT_RATE_RULES)) {
    const candidate = { ...defaultRule, ...(overrides[name] ?? {}) };
    if (
      typeof candidate.scope !== 'string'
      || !Number.isSafeInteger(candidate.limit)
      || candidate.limit < 1
      || !Number.isSafeInteger(candidate.windowMs)
      || candidate.windowMs < 1
    ) {
      throw new TypeError('Invalid rate limit rule.');
    }
    merged[name] = Object.freeze(candidate);
  }
  return Object.freeze(merged);
}

function assertOwner(ownerId) {
  requiredAsciiString(ownerId, 'authenticatedOwner', 240);
}

function rateSubject(value) {
  const parsed = requiredString(value, 'rateSubject', 255);
  if (!/^[\x20-\x7e]+$/.test(parsed)) throw invalidRequest('rateSubject');
  return parsed;
}

function validatedClientIpRateSubject(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new AppError('configuration_required');
  }
  const keys = Object.keys(context);
  if (keys.length !== 1 || keys[0] !== 'rateSubject') {
    throw new AppError('configuration_required');
  }
  const subject = context.rateSubject;
  const prefix = 'client-ip:';
  const clientIp = typeof subject === 'string' && subject.startsWith(prefix)
    ? subject.slice(prefix.length)
    : '';
  if (!clientIp || clientIp.trim() !== clientIp || isIP(clientIp) === 0) {
    throw new AppError('configuration_required');
  }
  return subject;
}

function requiredAsciiString(value, field, maxLength) {
  const parsed = requiredString(value, field, maxLength);
  if (!/^[\x20-\x7e]+$/.test(parsed)) throw invalidRequest(field);
  return parsed;
}

function optionalAsciiString(value, field, maxLength) {
  return value === undefined || value === null ? null : requiredAsciiString(value, field, maxLength);
}

async function removeMatchingDocuments(repository, collection, criteria, limit = 100) {
  const documents = await repository.findMany(collection, criteria, { limit });
  for (const document of documents) await repository.removeById(collection, document._id);
  return documents.length;
}

function validateTaskCursor(value) {
  if (value === undefined || value === null) return null;
  assertExactObject(value, ['createdAtMs', 'taskId']);
  if (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) {
    throw invalidRequest('cursor.createdAtMs');
  }
  return { createdAtMs: value.createdAtMs, taskId: assertTaskId(value.taskId) };
}

function dashboardDayRange(input, nowMs) {
  const hasStart = input.dayStart !== undefined;
  const hasEnd = input.dayEnd !== undefined;
  if (hasStart !== hasEnd) throw invalidRequest('dayStart');
  if (!hasStart) {
    const start = new Date(nowMs);
    start.setUTCHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs: start.getTime() + 86_400_000 };
  }
  const dayStart = requiredString(input.dayStart, 'dayStart', 40);
  const dayEnd = requiredString(input.dayEnd, 'dayEnd', 40);
  const startMs = Date.parse(dayStart);
  const endMs = Date.parse(dayEnd);
  if (
    !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || new Date(startMs).toISOString() !== dayStart
    || new Date(endMs).toISOString() !== dayEnd
    || endMs <= startMs
    || endMs - startMs > 26 * 60 * 60_000
  ) {
    throw invalidRequest('dayStart');
  }
  return { startMs, endMs };
}


function taskTombstone(nowMs) {
  return { userDeletedAtMs: nowMs, project: null, model: null, summary: null,
    durationMs: null, sessionId: '', updatedAtMs: nowMs };
}

function isVisibleTask(task, user) {
  return task.userDeletedAtMs == null
    && (!Number.isFinite(user.historyClearedAtMs) || task.createdAtMs > user.historyClearedAtMs);
}

function visibleTasks(tasks, user) {
  return tasks.filter((task) => isVisibleTask(task, user));
}

function isAndroidAppPlatform(value) {
  return value === 'app' || value === 'app-android' || value === 'android';
}

function isUsablePushClientId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function duplicateResult(task, event) {
  // A deleted record deliberately no longer contains the original display payload.
  // Its canonical identity still consumes this event forever, without a new Push attempt.
  if (!task || (task.userDeletedAtMs == null ? !eventsEqual(task, event)
    : task.desktopId !== event.desktopId || task.eventId !== event.eventId || task.event !== event.event)) {
    throw new AppError('event_conflict');
  }
  return {
    status: 'duplicate',
    taskId: task._id,
    notificationStatus: task.notificationStatus
  };
}

function createdResult(taskId, notificationStatus) {
  return { status: 'created', taskId, notificationStatus };
}

function publicUser(user) {
  return {
    notificationsEnabled: user.notificationsEnabled,
    privacyConsent: publicPrivacyConsent(user),
    createdAt: toIso(user.createdAtMs)
  };
}

function publicSettings(user) {
  return {
    notificationsEnabled: user.notificationsEnabled,
    privacyConsent: publicPrivacyConsent(user)
  };
}

function publicPrivacyConsent(user) {
  const version = typeof user.privacyConsentVersion === 'string'
    ? user.privacyConsentVersion
    : null;
  const acceptedAt = toIso(user.privacyConsentAtMs);
  return {
    requiredVersion: CURRENT_PRIVACY_VERSION,
    acceptedVersion: version,
    acceptedAt,
    isCurrent: hasCurrentPrivacyConsent(user)
  };
}

function hasCurrentPrivacyConsent(user) {
  return user.privacyConsentVersion === CURRENT_PRIVACY_VERSION
    && Number.isFinite(user.privacyConsentAtMs);
}

function publicDesktop(desktop) {
  return {
    desktopId: desktop._id,
    name: desktop.name,
    status: desktop.status,
    createdAt: toIso(desktop.createdAtMs),
    lastSeenAt: toIso(desktop.lastSeenAtMs),
    lastEventAt: toIso(desktop.lastEventAtMs)
  };
}

function publicPairingStatus(session) {
  return {
    sessionId: session._id,
    status: session.status,
    expiresAt: toIso(session.expiresAtMs),
    desktopId: session.desktopId
  };
}

function publicMobileDevice(device) {
  return {
    deviceRecordId: device._id,
    deviceId: device.deviceId,
    platform: device.platform,
    deviceLabel: device.deviceLabel,
    pushRegistrationStatus: device.pushRegistrationStatus,
    notificationPermissionState: device.notificationPermissionState,
    appVersion: device.appVersion,
    status: device.status,
    lastSeenAt: toIso(device.lastSeenAtMs),
    createdAt: toIso(device.createdAtMs),
    updatedAt: toIso(device.updatedAtMs)
  };
}

function publicTask(task) {
  return {
    taskId: task._id,
    schemaVersion: task.schemaVersion,
    eventId: task.eventId,
    event: task.event,
    desktopId: task.desktopId,
    occurredAt: task.occurredAt,
    privacyMode: task.privacyMode,
    sessionId: task.sessionId,
    project: task.project,
    model: task.model,
    summary: task.summary,
    durationMs: task.durationMs,
    notificationStatus: task.notificationStatus,
    createdAt: toIso(task.createdAtMs)
  };
}

function toIso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

module.exports = {
  DEFAULT_RATE_RULES,
  DELIVERY_STATUS,
  DELIVERY_STATUSES,
  NOTIFICATION_STATUS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  CURRENT_PRIVACY_VERSION,
  PRIVACY_CONSENT_VERSION: CURRENT_PRIVACY_VERSION,
  TokenMApplication
};
