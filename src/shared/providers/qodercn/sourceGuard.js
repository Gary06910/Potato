'use strict';
const fs = require('node:fs');
const { qoderCnDataPaths } = require('./paths');

// The pinned fork can skip an unreadable legacy DB without a nonzero exit.
// Validate readability, never parse/add usage here. A failed check aborts the
// collection before publication, leaving the last complete snapshot intact.
function assertQoderCnSourceReadable(options = {}) {
  for (const file of qoderCnDataPaths(options).dbPaths) {
    try { fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 250');
      db.prepare('SELECT 1 FROM chat_message LIMIT 1').get();
    } catch (cause) {
      const error = new Error('Qoder CN source is temporarily unreadable', { cause });
      error.code = 'QODER_CN_SOURCE_UNREADABLE';
      throw error;
    } finally { db.close(); }
  }
}
module.exports = { assertQoderCnSourceReadable };
