# POTATO_ANDROID_EFFICIENCY_AUDIT_REPORT

CURRENT_HEAD: ca18de7ae0a957f5272326970a28786f8dd17dfb

Phase A completed before product changes. Evidence: actual UTS algorithms executed offline by tests/android/efficiencyBudget.test.js with runtime-fixture.js; before-budget.json captured on baseline. No production traffic. MOBILE_DEVICE_WRITES counts successful registration RPCs: application.registerMobileDevice performs exactly one insert/update in its transaction. setPushCid is a separate identity write, excluded from this device-write column.

BACKGROUND_TIMERS: none outside visible Pairing. Pairing has local 1s countdown and 5s remote status intervals; hide/unload/paired/expired stop both. An already pending RPC may finish after hide. BACKGROUND_NETWORK_ACTIVITY: no continuing polling; SDK Push listener retained. No app heartbeat timer.

FOREGROUND_BOOTSTRAP_CALL_GRAPH: App.onLaunch and App.onShow -> bootstrapClientRuntime -> runBootstrapClientRuntime -> refreshConsentFact -> getPrivacyConsent -> startEligiblePushRuntime -> startPushRuntime -> refreshMobileRegistration -> registerCurrentMobileDevice -> getOfficialPushClientId -> uni.getPushClientId -> uniIdCo.setPushCid -> tokenmCo.registerMobileDevice -> one mobile-device write. bootstrapInFlight deduplicates simultaneous work only; cleared after resolution, so serial foregrounds repeat all steps.

PAGE_ONSHOW_CALL_GRAPH:
- Dashboard: restoreCached -> prepareClientPage (remote consent) -> getDashboard cache -> getDashboard + listTasks(limit 5) + listDesktops cache. UI renders only 3 tasks and 2 desktops.
- Tasks: restoreCached -> ensureProtectedClientRoute -> prepareClientPage -> listDesktops and listTasks; in-flight desktop reads share one cache request. Pagination concat retains all pages.
- Desktops: restoreCached -> ensureProtectedClientRoute -> listDesktops.
- Settings: restoreCached -> prepareClientPage -> getNotificationSettings (getDashboard if settings stale).
- Notifications: bootstrapClientRuntime -> getNotificationSettings. Returning Home runs prepareClientPage again.
- Permission: bootstrapClientRuntime -> bootstrap for account, counts and consent. CTA acceptance/update/registration are intentional writes.
- Pairing: onLoad -> ensureProtectedClientRoute -> createPairingCode; onShow timers only, 12 status RPCs in 60 seconds at ticks 5..60, if still active.
- Task detail: onLoad -> ensureProtectedClientRoute -> getTask -> cached listDesktops. No separate onShow data loop.
- privacy/account-service/task-management: mutations are explicit user actions; task delete/clear/history clear invalidate task-derived snapshots; account/logout clear all.

BEFORE_CALL_BUDGET

Protocol: signed in, current consent, activated Push, authorized permission, successful RPCs. A: concurrent Launch/Show followed by settled Home. B/C: warmed Home at t0, foreground bootstrap then Home at t10/t30. D: warm Home at t0; Home/Tasks/Desktops/Settings/Home at t1/7/13/19/25 seconds. E: immediately after warm Home, expire dashboard and desktops as actual pull-refresh does. F: receive without click, no page refresh. G: immediate Notifications enter and Home return. H: warm Home, protected Pairing open with active code for all 12 ticks. Fixtures run the same service paths for before and after. Actual platform scheduling may coalesce consent reads more; these are reproducible settled-path budgets, not device latency measurements. Zero omitted method counts include bootstrap and updateSettings in all A-H.

| Scenario | CLOUD_RPC_COUNT (includes setPushCid) | PUSH_CID_CALLS | DEVICE_REGISTRATION_CALLS / MOBILE_DEVICE_WRITES | Exact methods |
|---|---:|---:|---:|---|
| A | 7 | 1 | 1 | {"getPrivacyConsent":2,"getPushClientId":1,"setPushCid":1,"registerMobileDevice":1,"getDashboard":1,"listTasks":1,"listDesktops":1} |
| B | 7 | 1 | 1 | {"getPrivacyConsent":2,"getPushClientId":1,"setPushCid":1,"registerMobileDevice":1,"getDashboard":1,"listTasks":1,"listDesktops":1} |
| C | 7 | 1 | 1 | {"getPrivacyConsent":2,"getPushClientId":1,"setPushCid":1,"registerMobileDevice":1,"getDashboard":1,"listTasks":1,"listDesktops":1} |
| D | 12 | 0 | 0 | {"getPrivacyConsent":5,"listTasks":2,"listDesktops":3,"getDashboard":2} |
| E | 4 | 0 | 0 | {"getPrivacyConsent":1,"getDashboard":1,"listTasks":1,"listDesktops":1} |
| F | 0 | 0 | 0 | {} |
| G | 4 | 1 | 1 | {"getPrivacyConsent":2,"getPushClientId":1,"setPushCid":1,"registerMobileDevice":1} |
| H | 14 | 0 | 0 | {"getPrivacyConsent":1,"createPairingCode":1,"getPairingStatus":12} |

TIMERS: A-G zero; H two visible-page intervals. CACHE_HITS/MISSES: A all cold; B/C dashboard/desktops stale (5s), settings seeded; D Home t1 hit, Tasks miss, desktops t7/t13/t25 miss, settings t19 miss, Home t25 miss; E forced miss; F snapshots expired without RPC; G settings/Home hits; H no page snapshot reads. Fresh dashboard performs 3 business RPCs (2 if desktops fresh).

FOREGROUND_BOOTSTRAP_REDUNDANCY: PROVEN. Serial bootstrap repeats consent, CID, binding and device write; page adds separate consent. DEVICE_REGISTRATION_REDUNDANCY: PROVEN. No owner/permission/label/version/CID/heartbeat success fingerprint. Required triggers: first process registration, account/session switch, permission/activation/reconfirmation change, failure retry, app version/device label/CID change, long heartbeat. Ordinary tabs do not directly register but Notifications and App foreground do.

Privacy audit: tokenm-co _before authenticates token but does not uniformly enforce consent. Core checks active mobile registration and notification ingestion consent; dashboard/tasks/detail/desktops/pairing/settings currently rely on client preflight. PATH A is safe only after server protected-operation enforcement is introduced; short in-memory consent TTL then removes serial preflight, while every new business RPC checks current consent within server invocation. PATH B removes round-trip by same invocation enforcement. Never remove preflight first or introduce an unchecked multi-minute privacy bypass. Recovery must clear snapshots, stop listener when protected rejection proves revoked access, and redirect.

DASHBOARD_OVERFETCH: getDashboard reads task history (adapter default 500) only for latestTask, which Android ignores; also all mobile devices. Android then fetches tasks/desktops again. New Android bundle can bound recent tasks to 3, active desktops to 2, DB count today and active desktops, resolve at most 3 recent-task desktop names. Preserve existing dashboard response for other callers.

TASK_QUERY_PUSHDOWN: candidate IMPLEMENT_NOW. Existing taskHistoryCriteria supports tombstone/watermark/day; adapters can add exact filter and compound cursor to this same contract, retaining sort(createdAtMs DESC,_id DESC), limit+1. Existing owner_created_id/owner_desktop_created/owner_status_created/owner_privacy_created indexes match owner and individual filters; combined filters may still require DB filtering/index validation. No repository rewrite necessary. Add equivalence tests and adapter command tests before accepting.

FINDINGS:
- P0: missing uniform server consent enforcement is the blocking prerequisite for preflight optimization. ROOT_CAUSE: identity and ownership are enforced separately from consent. ENERGY/NETWORK/LATENCY: extra preflight every protected route. RISK: privacy bypass if merely cached/deleted. RECOMMENDED_FIX: protected cloud-object contract guard, exempt consent/recovery operations, regression all protected methods.
- P1: serial mobile registration churn. ROOT_CAUSE: concurrency guard only. ENERGY: wake-triggered CID/binding/write. NETWORK: two cloud writes each foreground. LATENCY: registration awaited. RISK: account/session/CID transitions. FIX: session-scoped memory success fingerprint, 6h opportunistic heartbeat; discover CID on foreground at 30s maximum freshness, skip binding/write unless CID/fingerprint/heartbeat changed. No sensitive persistent copies.
- P1: dashboard repeated reads/history scan. FIX: separate bounded Android dashboard RPC, preserve legacy getDashboard. RISK: names/history/tombstones; test bounded owner-safe projection and counts.
- P2: 5s snapshot TTL discards normal navigation reuse. FIX: dashboard/tasks 30s, desktops 60s, settings 60s. Settings 300s rejected: another device can mutate same-account setting without local invalidation; 60s bounds this delay. Push/mutation/session/manual invalidation preserved. No extra timers.
- P2: batch=100 JS cursor/filter scan. FIX: adapter criteria extension and limit+1; require equivalence for filters, ties, watermark and tombstones.
- P3: task list grows O(n) views via concat. At 100/500/1000 tasks approximately 100/500/1000 task rows plus child views, without virtualization. No measured device bottleneck or acceptance threshold. DEFERRED pending on-device evidence; don't truncate access or introduce complex list changes.
- P3: PageTiming logs at most three render proxies per navigation, no loop or payload; NOT_NEEDED to disable without evidence.

IMPLEMENTATION_PLAN

IMPLEMENT_NOW: server consent guard + 30s session consent freshness (server enforcement always on business RPC); foreground lifecycle reconciliation using shared bootstrap and registration freshness; cache TTLs 30/30/60/60; bounded Android bundle; task filter/cursor pushdown with equivalence tests; versionCode 6; regression/budget/report/precise commits/non-force push.
DEFER: virtualization (unmeasured device need), settings 300s (cross-client mutations), legacy getDashboard replacement (other callers' response contract).
DO_NOT_CHANGE: Pairing 5s polling (responsive visible workflow, only 6 calls could be saved in second half of a minute but worsens response); Push listener/channel/icons/force_notification; ownership/privacy payload/at-most-once/Server Agent protocol; original user worktree; production deployment/cloud build.

MEASURED_BATTERY_PERCENT: NOT_MEASURED

## Measured cache-request classifications and timer inventory

Snapshot read entry classifications are counted by wrapping the actual snapshot read functions. Stale retains existing data; it is a network miss. Seeds are not cache reads. Timers are the static visible-page inventory, not handset wake measurements. Baseline budgets were reproduced by reading only UTS sources from the unchanged baseline checkout, with the same offline runner.

| Scenario | Hit | Cold miss | Stale refresh | In-flight reuse | Local/remote timers |
|---|---:|---:|---:|---:|---|
| A | 0 | 2 | 0 | 0 | 0/0 |
| B | 0 | 0 | 2 | 0 | 0/0 |
| C | 0 | 0 | 2 | 0 | 0/0 |
| D | 1 | 1 | 5 | 0 | 0/0 |
| E | 0 | 0 | 2 | 0 | 0/0 |
| F | 0 | 0 | 0 | 0 | 0/0 |
| G | 2 | 0 | 0 | 0 | 0/0 |
| H | 0 | 0 | 0 | 0 | 1/1 |

Implementation refinement: protected bootstrap now also requires current server consent. Permission continues to expose acceptance/recovery, and postpones account counts/settings until current consent, without a protected bootstrap call beforehand. Settings now uses a dedicated getSettings RPC with current-consent enforcement; it reads no task/desktop/mobile history. Core getAndroidDashboard/getSettings enforce consent internally; existing cloud-object protected methods enforce at their authenticated boundary. Explicit exemptions are getPrivacyConsent/updatePrivacyConsent and account/device/history teardown; active device registration retains its own consent check.
