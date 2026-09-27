'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createServerAgentPaths
} = require('../../src/server-agent/paths');
const {
  parseServerAgentConfig
} = require('../../src/server-agent/config');
const { sharedDataDir } = require('../../src/shared/config');

function absolute(name) {
  return path.join(os.tmpdir(), `toknow-server-agent-${name}`);
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    deviceName: 'To Know Server',
    profiles: [
      { id: 'business', name: 'Business', codexHome: absolute('codex-business'), enabled: true },
      { id: 'personal', name: 'Personal', codexHome: absolute('codex-personal'), enabled: true }
    ],
    ...overrides
  };
}

test('new device labels default to Potato Server while explicit saved names remain unchanged', () => {
  const { deviceName, ...withoutDeviceName } = validConfig();
  assert.equal(parseServerAgentConfig(withoutDeviceName).deviceName, 'Potato Server');
  assert.equal(parseServerAgentConfig(validConfig()).deviceName, deviceName);
  assert.equal(parseServerAgentConfig(validConfig({ deviceName: 'My Server' })).deviceName, 'My Server');
});

test('config v1 accepts enabled profiles and ignores unrecognized secret-shaped fields', () => {
  const config = parseServerAgentConfig({
    ...validConfig(),
    credential: 'should-not-survive',
    apiToken: 'should-not-survive',
    profiles: [{
      ...validConfig().profiles[0],
      refreshToken: 'should-not-survive',
      auth: { accessToken: 'should-not-survive' }
    }]
  });
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.profiles[0]).sort(), ['codexHome', 'enabled', 'id', 'name']);
  assert.equal('credential' in config, false);
  assert.equal('refreshToken' in config.profiles[0], false);
});

test('unknown version and empty profiles are rejected', () => {
  assert.throws(
    () => parseServerAgentConfig({ ...validConfig(), version: 2 }),
    (error) => error.code === 'unknown-config-version'
  );
  assert.throws(
    () => parseServerAgentConfig({ ...validConfig(), profiles: [] }),
    (error) => error.code === 'empty-profiles'
  );
});

test('duplicate profile ids and invalid ids are rejected', () => {
  assert.throws(
    () => parseServerAgentConfig({
      ...validConfig(),
      profiles: [validConfig().profiles[0], { ...validConfig().profiles[1], id: 'business' }]
    }),
    (error) => error.code === 'duplicate-profile-id'
  );
  for (const id of ['Business', 'bad/id', '../codex', '']) {
    assert.throws(
      () => parseServerAgentConfig({ ...validConfig(), profiles: [{ ...validConfig().profiles[0], id }] }),
      (error) => error.code === 'invalid-profile-id'
    );
  }
});

test('relative Codex homes and control characters in names are rejected', () => {
  assert.throws(
    () => parseServerAgentConfig({
      ...validConfig(),
      profiles: [{ ...validConfig().profiles[0], codexHome: '../.codex' }]
    }),
    (error) => error.code === 'relative-codex-home'
  );
  assert.throws(
    () => parseServerAgentConfig({
      ...validConfig(),
      profiles: [{ ...validConfig().profiles[0], name: 'Business\nSecret' }]
    }),
    (error) => error.code === 'invalid-config-field'
  );
});

test('enabled profiles cannot resolve to the same Codex home, while disabled profiles are ignored', () => {
  const home = absolute('codex-shared');
  assert.throws(
    () => parseServerAgentConfig({
      ...validConfig(),
      profiles: [
        { id: 'a', name: 'A', codexHome: home, enabled: true },
        { id: 'b', name: 'B', codexHome: path.join(home, '..', path.basename(home)), enabled: true }
      ]
    }),
    (error) => error.code === 'duplicate-codex-home'
  );
  const config = parseServerAgentConfig({
    ...validConfig(),
    profiles: [
      { id: 'a', name: 'A', codexHome: home, enabled: true },
      { id: 'disabled', name: 'Disabled', codexHome: home, enabled: false }
    ]
  });
  assert.equal(config.profiles.find((profile) => profile.id === 'disabled').enabled, false);
});

test('realpath dependency injection rejects distinct lexical paths resolving to one home', () => {
  const config = validConfig({
    profiles: [
      { id: 'a', name: 'A', codexHome: absolute('raw-a'), enabled: true },
      { id: 'b', name: 'B', codexHome: absolute('raw-b'), enabled: true }
    ]
  });
  assert.throws(
    () => parseServerAgentConfig(config, { realpathSync: () => absolute('same-real-home') }),
    (error) => error.code === 'duplicate-codex-home'
  );
});

test('display-name changes preserve the stable profile id', () => {
  const first = parseServerAgentConfig(validConfig()).profiles[0];
  const renamed = parseServerAgentConfig({
    ...validConfig(),
    profiles: [{ ...validConfig().profiles[0], name: 'Revenue' }]
  }).profiles[0];
  assert.equal(first.id, renamed.id);
  assert.notEqual(first.name, renamed.name);
});

test('XDG roots and profile state paths are independently derived', () => {
  const paths = createServerAgentPaths({
    homeDir: absolute('home'),
    env: {
      XDG_CONFIG_HOME: absolute('xdg-config'),
      XDG_DATA_HOME: absolute('xdg-data'),
      XDG_STATE_HOME: absolute('xdg-state')
    },
    platform: 'linux'
  });
  assert.equal(paths.configRoot, path.join(absolute('xdg-config'), 'toknow-agent'));
  assert.equal(paths.dataRoot, path.join(absolute('xdg-data'), 'toknow-agent'));
  assert.equal(paths.stateRoot, path.join(absolute('xdg-state'), 'toknow-agent'));
  const a = paths.profilePaths('business');
  const b = paths.profilePaths('personal');
  assert.notEqual(a.runtimeDir, b.runtimeDir);
  assert.notEqual(a.collectorAnchorPath, b.collectorAnchorPath);
  assert.notEqual(a.dailyHistoryArchivePath, b.dailyHistoryArchivePath);
  assert.notEqual(a.sessionUsageArchivePath, b.sessionUsageArchivePath);
  assert.equal(
    sharedDataDir({ env: { TOKEN_MONITOR_SHARED_DIR: a.runtimeDir }, platform: 'linux', homeDir: absolute('other') }),
    a.runtimeDir
  );
  assert.equal(
    sharedDataDir({ env: { TOKEN_MONITOR_SHARED_DIR: b.runtimeDir }, platform: 'linux', homeDir: absolute('other') }),
    b.runtimeDir
  );
});
