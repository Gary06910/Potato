'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../../package.json');
const {
  androidOutboxFilePath,
  createAndroidNotificationRuntime
} = require('../../src/electron/androidNotificationRuntime');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP_ID = 'dev_11111111-1111-4111-8111-111111111111';
const CREDENTIAL = `tm_uc_d1.${DESKTOP_ID}.${crypto.randomBytes(32).toString('base64url')}`;

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function completion(turnId = 'turn-1') {
  return {
    hook_event_name: 'Stop',
    session_id: 'sync-regression-session',
    turn_id: turnId,
    cwd: 'C:\\workspaces\\token-m',
    model: 'gpt-5',
    last_assistant_message: 'local completion summary',
    duration_ms: 42,
    occurred_at: new Date().toISOString()
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for local notification boundary');
}

test('upstream-sync candidate keeps the fetched upstream package and Token M release ownership', () => {
  const lock = JSON.parse(read('package-lock.json'));
  const manifest = JSON.parse(read('scripts/vendor/tokscale.json'));
  const updater = read('src/shared/appUpdater.js');
  const main = read('src/electron/main.js');
  const preload = read('src/electron/preload.js');
  const artifactConfig = read('.github/signpath/artifact-configuration.xml');
  const applicationConfig = read('.github/signpath/application-artifact-configuration.xml');
  const releaseWorkflow = read('.github/workflows/release.yml');

  assert.equal(packageJson.version, '1.0.0');
  assert.equal(lock.packages[''].version, packageJson.version);
  assert.equal(packageJson.dependencies.tokscale, `^${manifest.baseVersion}`);
  assert.equal(packageJson.dependencies.koffi, '^3.1.5');
  assert.equal(packageJson.dependencies['electron-updater'], '6.8.9');
  assert.equal(packageJson.engines.node, '>=22.15.0');
  assert.equal(manifest.baseVersion, '4.17.0');
  assert.equal(manifest.releaseTag, 'token-monitor-09cf5471');

  assert.deepEqual(packageJson.build.publish, [{ provider: 'github', owner: 'Gary06910', repo: 'Potato' }]);
  assert.match(updater, /const GITHUB_REPO = 'Gary06910\/Potato'/);
  assert.doesNotMatch(updater, /const GITHUB_REPO = 'Javis603\/token-monitor'/);
  assert.match(artifactConfig, /product-name="Potato"/);
  assert.match(applicationConfig, /path="application\/Potato\.exe"/);
  assert.match(applicationConfig, /product-name="Potato"/);
  assert.match(releaseWorkflow, /prepare-github-release-notes\.js \.github\/TOKEN_M_RELEASE_TEMPLATE\.md/);
  assert.doesNotMatch(releaseWorkflow, /prepare-github-release-notes\.js \.github\/RELEASE_TEMPLATE\.md/);

  // The collector is initialized before the optional notification runtime. A
  // delivery outage therefore cannot prevent ordinary usage collection.
  assert.ok(main.indexOf('startMode();') < main.indexOf('notifications.start()'));
  assert.match(main, /if \(key\.startsWith\('tokenM'\)\) delete normalizedPatch\[key\]/);
  assert.match(main, /tokenMNotificationRuntime\?\.shutdownSync\(\)/);
  assert.match(preload, /notifications:pairAndroid/);
  assert.match(preload, /notifications:setAndroidPrivacyMode/);
});

test('candidate contains the current upstream feature and renderer-refactor surface', () => {
  for (const relativePath of [
    'src/electron/modelAliasPresentation.js',
    'src/electron/renderer/modelAliasForm.js',
    'src/electron/renderer/modelAliases.js',
    'src/shared/sessionUsageArchiveStore.js',
    'src/shared/customScanPaths.js',
    'src/shared/providers/factory/limits.js',
    'src/shared/sessionMetadata.js',
    'src/shared/providers/droid/sessionMetadata.js',
    'src/shared/providers/volcengine/limits.js',
    'src/shared/providers/kimi/limits.js',
    'src/shared/providers/antigravity/oauth.js',
    'src/electron/renderer/rowDragController.js',
    'src/electron/renderer/app.js'
  ]) assert.equal(fs.existsSync(path.join(PROJECT_ROOT, relativePath)), true, relativePath);

  const collector = read('src/shared/collector.js');
  const catalog = read('src/shared/clientCatalog.js');
  const main = read('src/electron/main.js');
  const renderer = read('src/electron/renderer/app.js');
  const tray = read('src/electron/tray.js');
  const releaseWorkflow = read('.github/workflows/release.yml');
  const kimiLimits = read('src/shared/providers/kimi/limits.js');
  const antigravityOAuth = read('src/shared/providers/antigravity/oauth.js');
  assert.match(collector, /customScanPaths/);
  assert.match(collector, /applyTokscaleSessionMetadata/);
  assert.match(main, /sessionUsageArchiveStore/);
  assert.match(catalog, /id: 'amp'/);
  assert.match(renderer, /customScanPathsForClient/);
  assert.match(renderer, /modelAlias/);
  assert.match(renderer, /tokenRate/);
  assert.match(renderer, /verticalDragSortApi/);
  assert.match(collector, /SELF_WATCHED_SQLITE_SIDECAR_CLIENTS = Object\.freeze\(\['qodercn', 'zcode'\]\)/);
  assert.match(kimiLimits, /limit_month_total/);
  assert.match(kimiLimits, /label: 'Monthly'/);
  assert.match(antigravityOAuth, /\[API_DAILY_BASE_URL, API_BASE_URL\]/);
  assert.match(tray, /accelerator: 'Command\+Q'/);
  assert.match(releaseWorkflow, /os: windows-latest\s+target: win/);
  assert.doesNotMatch(releaseWorkflow, /os: macos-|target: mac|target: linux/);
  assert.doesNotMatch(releaseWorkflow, /latest-mac\.yml|latest-linux\.yml|\.dmg|\.AppImage/);
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, 'src/electron/renderer/preferenceDragSort.js')), false);
});

test('notification overlay stays local-first across pairing, privacy, duplicates, and cloud failure', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-m-upstream-sync-'));
  const settings = {
    tokenMAndroidApiUrl: '',
    tokenMAndroidCredential: '',
    tokenMAndroidDesktopId: '',
    tokenMAndroidDesktopName: '',
    tokenMAndroidEnabled: false,
    tokenMAndroidPrivacyMode: true,
    tokenMCodexHookEnabled: false
  };
  const requests = [];
  const events = [];
  let offline = false;
  const runtime = createAndroidNotificationRuntime({
    userDataPath: directory,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/v1/desktop/status')) {
        if (offline) throw new Error('simulated cloud outage');
        return jsonResponse({
          ok: true,
          desktop: { desktopId: DESKTOP_ID, name: 'Sync workstation', status: 'active' }
        });
      }
      if (url.endsWith('/v1/desktop/events')) {
        if (offline) throw new Error('simulated cloud outage');
        events.push(JSON.parse(options.body));
        return jsonResponse({
          status: events.length === 1 ? 'created' : 'duplicate',
          taskId: 'tsk_11111111-1111-4111-8111-111111111111',
          notificationStatus: 'not_requested'
        }, events.length === 1 ? 201 : 200);
      }
      return jsonResponse({ ok: true });
    },
    getSettings: () => settings,
    commitSettings: async (patch) => Object.assign(settings, patch),
    hostname: 'Sync workstation'
  });

  t.after(async () => {
    await runtime.stop();
    const outboxPath = androidOutboxFilePath(directory, DESKTOP_ID);
    if (outboxPath && fs.existsSync(outboxPath)) fs.unlinkSync(outboxPath);
    fs.rmdirSync(directory);
  });

  const initial = await runtime.start();
  assert.equal(initial.bindingState, 'unbound');
  await runtime.enqueue(completion());
  assert.equal(requests.length, 0, 'unbound delivery must not make a network request');

  Object.assign(settings, {
    tokenMAndroidApiUrl: 'https://android.example.test/tokenm-desktop-http',
    tokenMAndroidCredential: CREDENTIAL,
    tokenMAndroidDesktopId: DESKTOP_ID,
    tokenMAndroidDesktopName: 'Sync workstation',
    tokenMAndroidEnabled: true
  });
  const bound = await runtime.start();
  assert.equal(bound.bindingState, 'bound');

  await runtime.enqueue(completion());
  await waitFor(() => events.length === 1);
  assert.equal(events[0].eventId, 'evt:sync-regression-session:turn-1');
  assert.equal(events[0].privacyMode, true);
  assert.equal(events[0].project, null);
  assert.equal(events[0].model, null);
  assert.equal(events[0].summary, null);
  assert.equal(events[0].durationMs, null);

  await runtime.enqueue(completion());
  assert.equal(runtime.publicStatus().outbox.total, 0);
  assert.equal(events.length, 1);

  await runtime.setPrivacyMode(false);
  await runtime.enqueue(completion('turn-2'));
  await waitFor(() => events.length === 2);
  assert.equal(events[1].privacyMode, false);
  assert.equal(events[1].project, 'token-m');
  assert.equal(events[1].model, 'gpt-5');
  assert.equal(events[1].summary, 'local completion summary');
  assert.equal(events[1].durationMs, 42);

  offline = true;
  await assert.doesNotReject(() => runtime.enqueue(completion('turn-3')));
  await waitFor(() => runtime.publicStatus().outbox.pending >= 1);
  assert.equal(runtime.publicStatus().bindingState, 'bound');
});
