'use strict';

// Loaded only in explicitly isolated test launchers, before production captures spawn.
// Parent-side registration covers the interval before the child even enters Node.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { spawnAgentRegistered } = require('../helpers/serverAgentFixture');

const registry = process.env.POTATO_TEST_AGENT_REGISTRY;
const root = process.env.POTATO_TEST_AGENT_ROOT;
if (registry && root) {
  if (fs.realpathSync(registry) !== path.join(fs.realpathSync(root), 'test-agent-spawns')) throw new Error('invalid fixture registry');
  const original = cp.spawn;
  cp.spawn = function(command, args, options) {
    return spawnAgentRegistered(original.bind(this), command, args, options, { root, registry });
  };
}
