'use strict';
// Test-only fault injection. A command must name an explicit synthetic root.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const isRun = process.argv.includes('run');
const root = process.argv.find(a => a.startsWith('--root='))?.slice(7);
if (isRun && root && process.env.POTATO_TEST_AGENT_FAULT) {
  const fault = process.env.POTATO_TEST_AGENT_FAULT;
  const record = event => fs.appendFileSync(path.join(root, 'fault-timeline.jsonl'), JSON.stringify({ event, atMs: Date.now(), pid: process.pid }) + '\n');
  record('fault-preload-entry');
  if (fault === 'entry-gate') {
    const end = Date.now() + 10000;
    record('entry-gate-blocked');
    while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    record('entry-gate-deadline');
  }
  if (fault === 'startup-exit') process.exit(17);
  if (fault === 'slow-entry') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); record('slow-entry-released'); }
  if (fault === 'late-ready') {
    const load = Module._load;
    Module._load = function(id) {
      const value = load.apply(this, arguments);
      if (id === './instance' && value.markReady && !value.testDelayed) {
        const ready = value.markReady;
        value.markReady = (...args) => {
          record('ready-requested');
          setTimeout(() => { ready(...args); record('ready-written'); }, 5800);
        };
        value.testDelayed = true;
      }
      return value;
    };
  }
}
