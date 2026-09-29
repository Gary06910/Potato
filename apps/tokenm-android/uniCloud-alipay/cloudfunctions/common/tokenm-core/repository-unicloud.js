'use strict';

const { RepositoryConflictError } = require('./errors');
const { COLLECTIONS } = require('./repository-contract');

const DEVELOPMENT_SPACE_VALIDATION = Object.freeze({
  verifiedLocally: false,
  requiresIsolatedDevelopmentSpace: Object.freeze([
    '支付宝云复合唯一索引的创建与冲突错误形状',
    'startTransaction 下 doc get/update/remove 与单条 add 的行为',
    'where 查询在事务内的结果形状和并发可见性',
    '大账户清理在 10 秒事务边界内的分批策略'
  ]),
  officialReferences: Object.freeze([
    'https://doc.dcloud.net.cn/uniCloud/cf-database.html#start-transaction',
    'https://doc.dcloud.net.cn/uniCloud/db-index.html'
  ])
});

class UniCloudRepository {
  constructor({ database, transaction = false } = {}) {
    if (!database || typeof database.collection !== 'function') {
      throw new TypeError('A uniCloud database or transaction object is required.');
    }
    this.database = database;
    this.transaction = transaction;
  }

  usageSnapshotCriteria(ownerId, cursor) {
    if (!cursor) return { ownerId };
    const cmd = this.database.command;
    return cmd.and({ ownerId }, cmd.or(
      { updatedAtMs: cmd.lt(cursor.updatedAtMs) },
      { updatedAtMs: cursor.updatedAtMs, _id: cmd.lt(cursor._id) }
    ));
  }

  taskHistoryCriteria(ownerId, options = {}) {
    const cmd = this.database.command;
    const criteria = { ownerId, userDeletedAtMs: cmd.exists(false).or(cmd.eq(null)),
      ...(Number.isFinite(options.after) ? { createdAtMs: cmd.gt(options.after) } : {}),
      ...(Number.isFinite(options.through) ? { createdAtMs: cmd.lte(options.through) } : {}),
      ...(options.day ? { occurredAt: cmd.gte(options.day.start).and(cmd.lt(options.day.end)) } : {}),
      ...(options.desktopId !== undefined ? { desktopId: options.desktopId } : {}),
      ...(options.notificationStatus !== undefined ? { notificationStatus: options.notificationStatus } : {}),
      ...(options.notificationStatuses ? { notificationStatus: cmd.in(options.notificationStatuses) } : {}),
      ...(options.privacyMode !== undefined ? { privacyMode: options.privacyMode } : {}) };
    return options.cursor ? cmd.and(criteria, cmd.or(
      { createdAtMs: cmd.lt(options.cursor.createdAtMs) },
      { createdAtMs: options.cursor.createdAtMs, _id: cmd.lt(options.cursor.taskId) }
    )) : criteria;
  }

  async countWhere(collection, criteria) {
    const response = await execute(() => this.database.collection(collection).where(criteria).count());
    return response.total;
  }

  async findById(collection, id) {
    const response = await execute(() => this.database.collection(collection).doc(id).get());
    return extractOne(response);
  }

  async findOne(collection, criteria = {}) {
    const response = await execute(() => (
      this.database.collection(collection).where(criteria).limit(1).get()
    ));
    return extractOne(response);
  }

  async findMany(collection, criteria = {}, options = {}) {
    let query = this.database.collection(collection).where(criteria);
    const ordering = options.sort ?? (options.sortBy
      ? [{ field: options.sortBy, direction: options.direction }]
      : []);
    for (const entry of ordering) {
      query = query.orderBy(entry.field, entry.direction === 'asc' ? 'asc' : 'desc');
    }
    if (Number.isSafeInteger(options.skip)) query = query.skip(options.skip);
    query = query.limit(Number.isSafeInteger(options.limit) ? options.limit : 500);
    const response = await execute(() => query.get());
    return extractMany(response);
  }

  async insert(collection, document) {
    await execute(() => this.database.collection(collection).add(document));
    return structuredClone(document);
  }

  async updateById(collection, id, patch) {
    const current = await this.findById(collection, id);
    if (!current) return null;
    // uniCloud recursively merges object updates; snapshots must replace the
    // previous object, including model keys removed by later projections.
    const update = collection === COLLECTIONS.usageSnapshots && Object.hasOwn(patch, 'snapshot')
      ? { ...patch, snapshot: this.database.command.set(patch.snapshot) } : patch;
    await execute(() => this.database.collection(collection).doc(id).update(update));
    return { ...current, ...structuredClone(patch), _id: id };
  }

  async updateWhere(collection, criteria, patch) {
    if (this.transaction) {
      throw new Error('支付宝云事务内条件更新未启用；使用事务外 where().update()。');
    }
    const response = await execute(() => (
      this.database.collection(collection).where(criteria).update(patch)
    ));
    return response?.updated ?? response?.affectedDocs ?? response?.affectedDocsCount ?? 0;
  }

  async removeById(collection, id) {
    const response = await execute(() => this.database.collection(collection).doc(id).remove());
    return Boolean(response?.deleted || response?.affectedDocs || response?.affectedDocsCount);
  }

  async removeWhere(collection, criteria = {}) {
    if (this.transaction) {
      throw new Error('支付宝云事务内批量删除未启用；先查询 _id，再逐条 doc().remove()。');
    }
    const response = await execute(() => this.database.collection(collection).where(criteria).remove());
    return response?.deleted ?? response?.affectedDocs ?? response?.affectedDocsCount ?? 0;
  }

  async runTransaction(work) {
    if (this.transaction) throw new Error('Nested To Know transactions are not supported.');
    const transaction = await execute(() => this.database.startTransaction());
    const repository = new UniCloudRepository({ database: transaction, transaction: true });
    try {
      const result = await work(repository);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (_rollbackError) {
        // Preserve the operation error; rollback outcome is an isolated-space validation concern.
      }
      throw translateRepositoryError(error);
    }
  }
}

function createUniCloudRepository(runtime = globalThis.uniCloud) {
  if (!runtime || typeof runtime.database !== 'function') {
    throw new TypeError('The uniCloud runtime is unavailable.');
  }
  return new UniCloudRepository({ database: runtime.database() });
}

async function execute(operation) {
  try {
    return await operation();
  } catch (error) {
    throw translateRepositoryError(error);
  }
}

function translateRepositoryError(error) {
  if (error instanceof RepositoryConflictError) return error;
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/duplicate|unique|E11000/i.test(`${code} ${message}`)) {
    return new RepositoryConflictError('platform_unique_constraint');
  }
  return error;
}

function extractOne(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data[0] ? structuredClone(data[0]) : null;
  return data && typeof data === 'object' ? structuredClone(data) : null;
}

function extractMany(response) {
  return Array.isArray(response?.data) ? structuredClone(response.data) : [];
}

module.exports = {
  DEVELOPMENT_SPACE_VALIDATION,
  UniCloudRepository,
  createUniCloudRepository,
  translateRepositoryError
};
