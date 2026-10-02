'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');

const { collectUsageOnce, deriveClientStatus } = require('../../src/shared/collector');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

const CODEX_HOME_FIXTURE = path.join(__dirname, '..', 'fixtures', 'codex-home');

function stableUsage(summary) {
  return {
    allTime: summary.allTime.totalTokens,
    clients: summary.allTime.clients,
    sessions: Object.keys(summary.allTime.sessions).length
  };
}

// These are the two independent fixture sessions, after cumulative-event and
// archived-copy deduplication. Native --today/--month use the host calendar,
// not collectUsageOnce's injected snapshot clock.
function expectedCalendarUsage(now) {
  const sessions = [
    { at: new Date('2026-08-16T00:00:02.000Z'), tokens: 70 },
    { at: new Date('2026-08-17T00:00:04.000Z'), tokens: 250 }
  ];
  let today = 0;
  let month = 0;
  for (const { at, tokens } of sessions) {
    if (at.getFullYear() !== now.getFullYear() || at.getMonth() !== now.getMonth()) continue;
    month += tokens;
    if (at.getDate() === now.getDate()) today += tokens;
  }
  return { today, month };
}

async function scanWithCalendarAssertions(homeDir) {
  const started = new Date();
  const summary = await scanFixture(homeDir);
  const finished = new Date();
  // The native scans are sequential and can straddle midnight. Either endpoint
  // is valid for each period; all-time totals must remain exactly idempotent.
  const expected = [expectedCalendarUsage(started), expectedCalendarUsage(finished)];
  for (const period of ['today', 'month']) {
    assert.ok(expected.some((value) => value[period] === summary[period].totalTokens),
      `${period} must match the native scan's host calendar`);
  }
  return summary;
}

test('fixture calendar expectations cover fixture days and a later month', () => {
  const first = new Date('2026-08-16T00:00:02.000Z');
  const second = new Date('2026-08-17T00:00:04.000Z');
  assert.deepEqual(expectedCalendarUsage(first), { today: 70, month: 320 });
  assert.deepEqual(expectedCalendarUsage(second), { today: 250, month: 320 });
  assert.deepEqual(expectedCalendarUsage(new Date(2026, 7, 20, 12)), { today: 0, month: 320 });
  assert.deepEqual(expectedCalendarUsage(new Date(2026, 8, 10, 12)), { today: 0, month: 0 });
});

async function scanFixture(homeDir) {
  return collectUsageOnce({
    clients: 'codex',
    allTimeSince: '2020-01-01',
    commandTimeoutMs: 30_000,
    deviceId: 'codex-fixture',
    homeDir,
    platform: 'linux',
    historyEnabled: false,
    projectsEnabled: false,
    now: new Date('2026-08-17T12:00:00.000Z')
  });
}

async function withIsolatedTokscalePricingFixture(run) {
  const savedEnv = new Map(['HOME', 'CODEX_HOME', 'TOKSCALE_CONFIG_DIR', 'TOKSCALE_PRICING_CACHE_ONLY']
    .map((key) => [key, process.env[key]]));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-codex-pricing-'));
  try {
    const profileRoot = path.join(temporaryRoot, 'profile');
    const configRoot = path.join(temporaryRoot, 'tokscale-config');
    fs.cpSync(path.join(CODEX_HOME_FIXTURE, '.codex'), path.join(profileRoot, '.codex'), { recursive: true });
    const cacheDir = path.join(configRoot, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Tokscale 4.17.0's canonical cache envelopes, with synthetic positive
    // pricing. Cache-only mode makes network availability irrelevant.
    const timestamp = Math.floor(Date.now() / 1000);
    const pricing = {
      'gpt-5': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.000001
      }
    };
    for (const name of ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json']) {
      const data = name === 'pricing-litellm.json' ? pricing : {};
      fs.writeFileSync(path.join(cacheDir, name), JSON.stringify({ timestamp, data }));
    }

    process.env.TOKSCALE_CONFIG_DIR = configRoot;
    process.env.TOKSCALE_PRICING_CACHE_ONLY = '1';
    return await run({ temporaryRoot, profileRoot });
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('Codex usage scan aligns tokscale with the profile home and stays idempotent', async () => {
  await withIsolatedTokscalePricingFixture(async ({ profileRoot }) => {
    // Reproduce the Windows failure: Node's profile home and the inherited HOME
    // point at different trees. collectUsageOnce must pass its profile home to
    // tokscale instead of letting the child silently scan this empty override.
    process.env.HOME = path.join(profileRoot, 'unrelated-home');

    const first = await scanWithCalendarAssertions(profileRoot);
    const second = await scanWithCalendarAssertions(profileRoot);

    // The nested live fixture uses the current cumulative total_token_usage
    // schema (250 tokens), contains one malformed JSONL line, and is duplicated
    // under archived_sessions. The legacy archived fixture carries only
    // last_token_usage (70 tokens). Neither the cumulative snapshots nor the
    // cross-root duplicate may be added more than once.
    // Calendar periods are checked separately against the host clock. The fixed
    // snapshot clock above must not be mistaken for a clock override in tokscale.
    assert.deepEqual(stableUsage(first), {
      allTime: 320,
      clients: { codex: 320 },
      sessions: 2
    });
    assert.deepEqual(stableUsage(second), stableUsage(first));
    assert.ok(first.allTime.costUsd > 0);
  });
});

test('an explicit CODEX_HOME remains authoritative over the aligned profile home', async () => {
  await withIsolatedTokscalePricingFixture(async ({ temporaryRoot, profileRoot }) => {
    process.env.HOME = path.join(temporaryRoot, 'unrelated-environment-home');
    process.env.CODEX_HOME = path.join(profileRoot, '.codex');

    const result = await scanFixture(path.join(temporaryRoot, 'unrelated-profile-home'));
    assert.equal(result.allTime.totalTokens, 320);
    assert.deepEqual(result.allTime.clients, { codex: 320 });
  });
});

test('an existing Codex source with no valid usage remains waiting at zero', () => {
  assert.deepEqual(
    deriveClientStatus('codex', { totalTokens: 0, clients: {} }, {
      sourceChecks: { codex: [{ id: 'codex-sessions', exists: true }] }
    }),
    { codex: 'waiting' }
  );
});
