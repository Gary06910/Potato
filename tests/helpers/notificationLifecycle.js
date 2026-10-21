'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEADLINE_MS = 5_000;

// A pending Promise alone does not keep Node 22's test process alive.
function withDeadline(promise, description) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Notification deadline: ' + description)), DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Watch the directory because the outbox replaces its document atomically.
// Check after installing the watcher as well, so an already completed write
// cannot be missed. Both the watcher and deadline are referenced and bounded.
function waitForOutbox(filePath, predicate, description) {
  return new Promise((resolve, reject) => {
    let watcher;
    let timer;
    let last;
    let settled = false;
    function finish(error, document) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve(document);
    }
    function inspect() {
      if (settled) return;
      try {
        last = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (predicate(last)) finish(null, last);
      } catch (error) {
        if (error.code !== 'ENOENT') finish(error);
      }
    }
    watcher = fs.watch(path.dirname(filePath), inspect);
    watcher.on('error', finish);
    timer = setTimeout(() => {
      const state = last && {
        pending: last.items.length,
        delivered: last.delivered.length,
        items: last.items.map(({ attemptCount, lastError, suspended }) => ({ attemptCount, lastError, suspended }))
      };
      finish(new Error('Notification deadline: ' + description + '; outbox=' + JSON.stringify(state)));
    }, DEADLINE_MS);
    inspect();
  });
}

module.exports = { waitForOutbox, withDeadline };
