'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

let trackingApi = {};
try {
  trackingApi = require('../../src/shared/clientTracking');
} catch (_) {}

const { DEFAULT_CLIENTS, KNOWN_CLIENTS, clientsCsvForSetting } = trackingApi;
const rootDir = path.join(__dirname, '..', '..');

function readmeTrackedClientIds() {
  const iconToClient = {
    deepseek: 'dsh',
    'hermes-agent': 'hermes',
    xai: 'grok',
    'mimo-code': 'mimo',
    qoder: 'qodercn'
  };
  return fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| <img'))
    .filter((line) => line.split('|').map((cell) => cell.trim())[4] === '✅')
    .map((line) => {
      const icon = line.match(/tools-icon\/([^".]+)\.[a-z]+"/i)?.[1] || '';
      return iconToClient[icon] || icon;
    });
}

test('clientsCsvForSetting uses defaults only for missing settings', () => {
  assert.equal(typeof DEFAULT_CLIENTS, 'string');
  assert.equal(typeof clientsCsvForSetting, 'function');
  assert.equal(clientsCsvForSetting(undefined), DEFAULT_CLIENTS);
  assert.equal(clientsCsvForSetting(null), DEFAULT_CLIENTS);
});

test('default tracked clients include current tokscale-supported tools', () => {
  const clients = DEFAULT_CLIENTS.split(',');
  for (const client of ['cline', 'amp', 'droid', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilo', 'commandcode', 'zcode', 'kiro', 'codebuddy', 'workbuddy', 'reasonix', 'dsh', 'cherrystudio', 'lmstudio', 'unsloth']) {
    assert.ok(clients.includes(client), `${client} should be tracked by default`);
  }
});

test('fresh defaults follow the stable MiMo policy without overwriting saved choices', () => {
  assert.ok(DEFAULT_CLIENTS.split(',').includes('mimo'));
  assert.equal(clientsCsvForSetting('claude,pi'), 'claude,pi');
  assert.equal(clientsCsvForSetting('micode'), 'mimo');
});

test('KNOWN_CLIENTS is a superset of DEFAULT_CLIENTS and includes renamed MiMo and opt-in Qoder CN', () => {
  // Display-preference normalization (hide/pin/reorder) keys off the KNOWN list, not
  // the default-tracked list — so an opt-in client like micode must stay here or its
  // prefs get silently dropped on save/read.
  const known = KNOWN_CLIENTS.split(',');
  assert.ok(known.includes('mimo'), 'micode must remain a known client');
  assert.ok(known.includes('qodercn'), 'qodercn must remain a known client');
  for (const client of DEFAULT_CLIENTS.split(',')) {
    assert.ok(known.includes(client), `${client} (default-tracked) must also be known`);
  }
});

// The renderer is no longer a third party to compare against: it destructures
// the same catalog these CSVs are projected from, so asserting it here would be
// the catalog against itself. That the renderer actually consumes the catalog is
// guarded in tests/electron/rendererClientLabels.test.js. README stays a real
// cross-check because it is hand-authored.
test('legacy documented tools retain catalog order while P1.3 source integration is pending', () => {
  const known = KNOWN_CLIENTS.split(',');
  const documented = readmeTrackedClientIds();
  assert.equal(documented.length, 30);
  assert.deepEqual(documented, known.filter(id => documented.includes(id)));
  assert.deepEqual(DEFAULT_CLIENTS.split(','), known.filter((client) => !['catpaw', 'qodercn'].includes(client)));
});

test('documented client CSV follows the canonical catalog order', () => {
  const envExample = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');
  const documented = envExample.match(/^TOKEN_MONITOR_CLIENTS=(.*)$/m)?.[1].split(',') || [];
  const documentedSet = new Set(documented);
  assert.deepEqual(
    documented,
    KNOWN_CLIENTS.split(',').filter((id) => documentedSet.has(id))
  );
});

// "default tracked clients are supported by tokscale or a native adapter" —
// this contract lives in scripts/verify-vendored-tokscale-clients.js instead
// of here. It has to run against the real vendored tokscale binary
// (vendor-tokscale.yml), not the plain npm-installed one: a client can be
// merged upstream and pinned into the vendor build well before it's in a
// tagged npm release (dsh, cherrystudio), so checking the npm binary here
// would just be testing an executable packaged releases don't ship.

test('clientsCsvForSetting preserves explicit empty tracked-tool selection', () => {
  assert.equal(clientsCsvForSetting(''), '');
  assert.equal(clientsCsvForSetting('  '), '');
});

test('clientsCsvForSetting normalizes saved client csv values', () => {
  assert.equal(clientsCsvForSetting(' Claude , Codex,,hermes '), 'claude,codex,hermes');
  assert.equal(clientsCsvForSetting('kilocode,kilo'), 'kilo');
});
