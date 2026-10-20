'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { getTokscaleStatus, readTokscaleBundledBuild } = require('../../src/shared/collector');
const manifest = require('../../scripts/vendor/tokscale.json');

test('retired updater exposes read-only status and no npm or cleanup operations', () => {
  const updater = require('../../src/shared/tokscaleUpdater');
  assert.equal(updater.getTokscaleStatus, getTokscaleStatus);
  for (const key of ['downloadFromNpm', 'checkNpmForNewer', 'resetToBundled', 'cleanupStaleStaging']) {
    assert.equal(updater[key], undefined);
  }
});

test('bundled build metadata is declared provenance and rejects invalid manifests', () => {
  assert.deepEqual(readTokscaleBundledBuild(), { releaseTag: manifest.releaseTag, commit: manifest.commit });
  assert.equal(readTokscaleBundledBuild({ ...manifest, mode: 'upstream' }), null);
  assert.equal(readTokscaleBundledBuild({ ...manifest, commit: 'invalid' }), null);
  assert.equal(readTokscaleBundledBuild(null), null);
});

test('legacy current.json and standalone files survive status and command resolution unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-p1-pointer-'));
  const oldBinary = path.join(home, 'standalone.exe');
  const pointer = path.join(home, 'tokscale', 'current.json');
  const cache = path.join(home, 'tokscale', 'cache.json');
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  fs.writeFileSync(oldBinary, 'standalone binary sentinel');
  fs.chmodSync(oldBinary, 0o755);
  const files = [oldBinary, pointer, cache];
  for (const document of [
    JSON.stringify({ version: '99.0.0', platform: `${process.platform}-${process.arch}`, path: oldBinary }),
    '{malformed legacy pointer'
  ]) {
    fs.writeFileSync(pointer, document);
    fs.writeFileSync(cache, 'legacy user cache sentinel');
    const before = files.map((file) => fs.readFileSync(file));
    const code = `const c = require('./src/shared/collector');
      const s = c.getTokscaleStatus();
      const command = c.tokscaleCommand();
      console.log(JSON.stringify({ status: s, selected: c.resolvePlatformBinary(), command: command.bin }));`;
    const child = spawnSync(process.execPath, ['-e', code], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, TOKEN_MONITOR_SHARED_DIR: home }, encoding: 'utf8'
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status.current.source, 'bundled');
    assert.equal(result.status.current.version, '4.20.0');
    assert.equal(result.command, result.selected.path);
    assert.notEqual(result.command, oldBinary);
    assert.deepEqual(files.map((file) => fs.readFileSync(file)), before);
  }
  // Evidence fixtures are retained; no user pointer, binary, or cache is removed.
});
