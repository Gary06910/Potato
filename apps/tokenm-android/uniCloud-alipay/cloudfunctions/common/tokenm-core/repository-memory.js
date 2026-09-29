'use strict';

const { RepositoryConflictError } = require('./errors');
const { COLLECTIONS, IDENTITY_COLLECTIONS } = require('./repository-contract');

const COLLECTION_NAMES = Object.freeze([
  ...Object.values(COLLECTIONS),
  ...Object.values(IDENTITY_COLLECTIONS)
]);

class MemoryRepository {
  constructor(initial = {}) {
    this._collections = createCollections(initial);
    this._transactionTail = Promise.resolve();
  }

  usageSnapshotCriteria(ownerId, cursor) {
    return { ownerId, ...(cursor ? { $usageAfter: cursor } : {}) };
  }

  taskHistoryCriteria(ownerId, options = {}) {
    return { ownerId, userDeletedAtMs: { taskAbsent: true },
      ...(Number.isFinite(options.after) ? { createdAtMs: { taskAfter: options.after } } : {}),
      ...(Number.isFinite(options.through) ? { createdAtMs: { taskThrough: options.through } } : {}),
      ...(options.day ? { occurredAt: { taskDay: options.day } } : {}),
      ...(options.cursor ? { $taskCursor: options.cursor } : {}),
      ...(options.desktopId !== undefined ? { desktopId: options.desktopId } : {}),
      ...(options.notificationStatus !== undefined ? { notificationStatus: options.notificationStatus } : {}),
      ...(options.notificationStatuses ? { notificationStatus: { taskIn: options.notificationStatuses } } : {}),
      ...(options.privacyMode !== undefined ? { privacyMode: options.privacyMode } : {}) };
  }

  async countWhere(collection, criteria) {
    return (await this.findMany(collection, criteria)).length;
  }

  async findById(collection, id) {
    const value = collectionMap(this._collections, collection).get(id);
    return value ? clone(value) : null;
  }

  async findOne(collection, criteria = {}) {
    const values = await this.findMany(collection, criteria, { limit: 1 });
    return values[0] ?? null;
  }

  async findMany(collection, criteria = {}, options = {}) {
    let values = [...collectionMap(this._collections, collection).values()]
      .filter((value) => matches(value, criteria));
    const ordering = options.sort ?? (options.sortBy
      ? [{ field: options.sortBy, direction: options.direction }]
      : []);
    if (ordering.length > 0) {
      values.sort((left, right) => {
        for (const entry of ordering) {
          const multiplier = entry.direction === 'asc' ? 1 : -1;
          const result = compare(left[entry.field], right[entry.field]) * multiplier;
          if (result !== 0) return result;
        }
        return 0;
      });
    }
    if (Number.isSafeInteger(options.skip)) values = values.slice(options.skip);
    if (Number.isSafeInteger(options.limit)) values = values.slice(0, options.limit);
    return clone(values);
  }

  async insert(collection, document) {
    const map = collectionMap(this._collections, collection);
    if (!document || typeof document._id !== 'string' || document._id.length === 0) {
      throw new TypeError('Repository documents require an explicit random _id.');
    }
    if (map.has(document._id)) throw new RepositoryConflictError(`${collection}._id`);
    enforceUnique(collection, document, map);
    map.set(document._id, clone(document));
    return clone(document);
  }

  async updateById(collection, id, patch) {
    const map = collectionMap(this._collections, collection);
    const current = map.get(id);
    if (!current) return null;
    const updated = { ...clone(current), ...clone(patch), _id: id };
    enforceUnique(collection, updated, map, id);
    map.set(id, updated);
    return clone(updated);
  }

  async updateWhere(collection, criteria, patch) {
    const map = collectionMap(this._collections, collection);
    let updatedCount = 0;
    for (const [id, current] of map) {
      if (!matches(current, criteria)) continue;
      const updated = { ...clone(current), ...clone(patch), _id: id };
      enforceUnique(collection, updated, map, id);
      map.set(id, updated);
      updatedCount += 1;
    }
    return updatedCount;
  }

  async removeById(collection, id) {
    return collectionMap(this._collections, collection).delete(id);
  }

  async removeWhere(collection, criteria = {}) {
    const map = collectionMap(this._collections, collection);
    let removed = 0;
    for (const [id, value] of map) {
      if (matches(value, criteria)) {
        map.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async runTransaction(work) {
    let release;
    const predecessor = this._transactionTail;
    this._transactionTail = new Promise((resolve) => {
      release = resolve;
    });
    await predecessor;
    const transaction = new MemoryTransaction(this._collections);
    try {
      const result = await work(transaction);
      this._collections = transaction._collections;
      return result;
    } finally {
      release();
    }
  }

  snapshot(collection) {
    if (collection) return clone([...collectionMap(this._collections, collection).values()]);
    return Object.fromEntries(COLLECTION_NAMES.map((name) => [
      name,
      clone([...this._collections.get(name).values()])
    ]));
  }
}

class MemoryTransaction extends MemoryRepository {
  constructor(source) {
    super();
    this._collections = cloneCollections(source);
  }

  async runTransaction(_work) {
    throw new Error('Nested To Know transactions are not supported.');
  }
}

function createCollections(initial) {
  const collections = new Map(COLLECTION_NAMES.map((name) => [name, new Map()]));
  for (const [name, documents] of Object.entries(initial)) {
    const map = collectionMap(collections, name);
    for (const document of documents) map.set(document._id, clone(document));
  }
  for (const [name, map] of collections) {
    for (const document of map.values()) enforceUnique(name, document, map, document._id);
  }
  return collections;
}

function cloneCollections(source) {
  return new Map([...source].map(([name, map]) => [
    name,
    new Map([...map].map(([id, value]) => [id, clone(value)]))
  ]));
}

function collectionMap(collections, collection) {
  const map = collections.get(collection);
  if (!map) throw new TypeError(`Unknown To Know collection: ${collection}`);
  return map;
}

function matches(document, criteria) {
  return Object.entries(criteria).every(([field, expected]) => (field === '$taskCursor'
    ? document.createdAtMs < expected.createdAtMs || (document.createdAtMs === expected.createdAtMs && document._id < expected.taskId)
    : field === '$usageAfter'
    ? document.updatedAtMs < expected.updatedAtMs || (document.updatedAtMs === expected.updatedAtMs && document._id < expected._id)
    : expected && typeof expected === 'object'
    ? (expected.taskIn ? expected.taskIn.includes(document[field])
      : expected.taskAbsent === true ? document[field] == null
      : expected.taskAfter !== undefined ? document[field] > expected.taskAfter
      : expected.taskThrough !== undefined ? document[field] <= expected.taskThrough
      : expected.taskDay ? document[field] >= expected.taskDay.start && document[field] < expected.taskDay.end
      : false)
    : Object.is(document[field], expected)));
}

function compare(left, right) {
  if (Object.is(left, right)) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left < right ? -1 : 1;
}

function enforceUnique(collection, candidate, map, excludedId = null) {
  if (collection === COLLECTIONS.pairingSessions) {
    for (const existing of map.values()) {
      if (existing._id === excludedId) continue;
      if (existing.codeUniquenessKey === candidate.codeUniquenessKey) {
        throw new RepositoryConflictError('pairing_code_key');
      }
      if (existing.ownerUniquenessKey === candidate.ownerUniquenessKey) {
        throw new RepositoryConflictError('pairing_owner_key');
      }
    }
    return;
  }
  const constraints = uniqueConstraints(collection, candidate);
  for (const [constraint, fields] of constraints) {
    for (const existing of map.values()) {
      if (existing._id === excludedId) continue;
      if (fields.every((field) => Object.is(existing[field], candidate[field]))) {
        throw new RepositoryConflictError(constraint);
      }
    }
  }
}

function uniqueConstraints(collection, document) {
  switch (collection) {
    case COLLECTIONS.usageSnapshots:
      return [['desktop_profile_unique', ['desktopId', 'profileId']]];
    case COLLECTIONS.tasks:
      return [['desktop_event', ['desktopId', 'eventId']]];
    case COLLECTIONS.mobileDevices:
      return [['owner_device', ['ownerId', 'deviceId']]];
    case COLLECTIONS.rateLimits:
      return [['rate_scope_subject_bucket', ['scope', 'subject', 'bucket']]];
    default:
      return document._id ? [] : [];
  }
}

function clone(value) {
  return structuredClone(value);
}

module.exports = {
  MemoryRepository
};
