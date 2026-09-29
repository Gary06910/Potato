# POTATO_ANDROID_EFFICIENCY_IMPLEMENTATION_REPORT

STATUS: PASS_WITH_DEPLOYMENT_GATE
BASE: ca18de7ae0a957f5272326970a28786f8dd17dfb
IMPLEMENTATION_HEAD: a5d0deaaed53dc37d246f64e1c48c9e3539b0b3e
BRANCH: feat/potato-android-efficiency
Final delivered Git HEAD (including this evidence commit) is verified in the chat handoff.

## Audit and implementation

BACKGROUND_POLLING: NO. Pairing retains two visible-page timers (1s local countdown / 5s remote status); hide/unload/paired/expired stops both. Already in-flight RPCs can finish after hide.
FOREGROUND_NETWORK_REDUNDANCY: fixed short sequential consent/registration churn; concurrent Launch/Show still share bootstrap. Foreground reconciliation uses 30s session preflight freshness and registration success state.
DEVICE_REGISTRATION_REDUNDANCY: memory-only owner/session/permission/app-version/label/CID fingerprint. CID discovery after 30s on an eligible foreground/action; no timer. Changed CID or owner binds CID; metadata/permission-only changes and unchanged-CID heartbeat update business device without redundant identity binding. Six-hour opportunistic heartbeat. Failure/reset/reconfirmation/activation retry fresh registration. No new persistent CID/token/credential copy.
CONSENT_REDUNDANCY: current-only 30s preflight reuse; every protected server business RPC checks current consent in the same invocation. Protected bootstrap statistics require consent. Permission remains usable before consent and does not read those statistics. Consent/device-disable/account/history teardown remain reachable for recovery. Rejected access clears all snapshots, stops Push, requires reconfirmation on consent rejection, redirects; late old-account errors do not purge new-account data.
CACHE_POLICY: dashboard/tasks 30s, desktops/settings 60s. Existing owner/session/revision/expiry barriers and mutation/Push/manual invalidation retained. Settings 300s deferred because another client can change the setting without local invalidation.
DASHBOARD_OVERFETCH: one getAndroidDashboard RPC, DB count today/active desktops, at most three recent task records and two recent active desktops, at most three owner-checked desktop lookups for task labels. No mobile-device history scan or full task-history materialization. getSettings reads only user setting. Legacy getDashboard response remains available for other callers.
TASK_QUERY_SCALABILITY: IMPLEMENTED. Filters, compound cursor, order and limit+1 pushed into repository criteria/where; identical cursor/results verified against the former filtering semantics over 320 records, timestamp ties, owner isolation, combined filters, null/absent tombstones and history watermark. Production query plan/index performance unmeasured.

## BEFORE_AFTER

Same reproducible settled-path offline A-H scenarios from AUDIT.md; cloud totals include setPushCid, local CID API excluded. User interaction timing and success preconditions are explicit, not production telemetry.

| SCENARIO | CLOUD_RPC_BEFORE | CLOUD_RPC_AFTER | PUSH_CID_BEFORE | PUSH_CID_AFTER | DEVICE_WRITE_BEFORE | DEVICE_WRITE_AFTER |
|---|---:|---:|---:|---:|---:|---:|
| A cold launch | 7 | 4 | 1 | 1 | 1 | 1 |
| B 10s resume | 7 | 0 | 1 | 0 | 1 | 0 |
| C 30s resume | 7 | 2 | 1 | 1 | 1 | 0 |
| D tab cycle | 12 | 2 | 0 | 0 | 0 | 0 |
| E pull refresh | 4 | 1 | 0 | 0 | 0 | 0 |
| F Push receive/no click | 0 | 0 | 0 | 0 | 0 | 0 |
| G Notifications enter/return | 4 | 0 | 1 | 0 | 1 | 0 |
| H active Pairing 60s | 14 | 13 | 0 | 0 | 0 | 0 |

REMOTE_CALL_REDUCTION: 55 -> 22, reduction 33 across the eight independent fixtures.
MOBILE_DEVICE_WRITE_REDUCTION: 4 -> 1, reduction 3.
DASHBOARD_RPC_REDUCTION: fresh Home business calls 3 -> 1; aggregate legacy dashboard 6 -> 0 with Android bundle 3 (settings no longer fetches dashboard).
PRIVACY_PREFLIGHT_REDUCTION: 15 -> 2, reduction 13.
LIST_TASKS: 6 -> 1. LIST_DESKTOPS: 7 -> 1. GET_PUSH_CLIENT_ID: 4 -> 2. SET_PUSH_CID: 4 -> 1. REGISTER_MOBILE_DEVICE: 4 -> 1.
Full per-method and per-scenario counts, cache classifications and timers are in REQUEST_BUDGET.md and before-budget.json/after-budget.json. Omitted methods are zero.

## IMPLEMENTED

FOREGROUND_BOOTSTRAP_DEDUP: YES
MOBILE_REGISTRATION_THROTTLE: YES
PRIVACY_RPC_OPTIMIZATION: YES
SERVER_PRIVACY_ENFORCEMENT_PRESERVED: YES (strengthened in source; deployment gate below)
CACHE_TTL_OPTIMIZATION: YES
DASHBOARD_CONSOLIDATION: YES
TASK_QUERY_PUSHDOWN: YES
PAIRING_BACKOFF: NOT_NEEDED
PRODUCTION_PERF_LOG_CHANGE: NOT_NEEDED

## ENERGY / SECURITY / PUSH

NEW_BACKGROUND_TIMER: NO
NEW_WAKELOCK: NO
NEW_FOREGROUND_SERVICE: NO
NEW_PERIODIC_JOB: NO
BACKGROUND_POLLING: NO
MEASURED_BATTERY_PERCENT: NOT_MEASURED
BATTERY_PROXY_IMPROVEMENT: 33 fewer modeled remote calls and 3 fewer device writes; ordinary 10s resume has zero wake-triggered app RPCs/writes. No measured mAh/CPU/latency percentage.
PRIVACY_GATE_WEAKENED: NO, provided cloud-first deployment gate is honored.
PROTECTED_READ_SERVER_ENFORCEMENT: contract tested on all protected cloud-object methods; active registration checks consent. Identity token/owner checks preserved.
CID_PERSISTED_BY_NEW_CODE: NO
TOKEN_OR_CREDENTIAL_CACHE_ADDED: NO
PUSH_LISTENER_CHANGED: NO; subscription implementation untouched, access-rejection recovery stops it when consent/session is invalid.
FORCE_NOTIFICATION_CHANGED: NO
CHANNEL_CHANGED: NO
ICON_BINDING_CHANGED: NO
TASK_CACHE_INVALIDATION_ON_PUSH: PRESERVED, no extra RPC on receipt.

## RESPONSIVENESS

CACHE_HIT_BEHAVIOR: main cached pages restore real historical values synchronously before asynchronous reconciliation; fresh hits return no data request.
NAVIGATION_LOADING_BEHAVIOR: existing ready pages retain cached content; refresh failure displays banner without replacing content with loading skeleton. Owner/consent rejection clears access instead of retaining forbidden data. Existing PageTiming shell/cached/fresh proxies retained. No handset render timings measured.
DASHBOARD_FRESH_LOAD: one business RPC, bounded response; no need to wait for three separate cloud responses.

## VALIDATION

NPM_CI: PASS
LINT: PASS
TEST: TOTAL=4928 PASS=4919 FAIL=0 SKIP=9 (final verify full suite). Standalone npm test also passed before the last two additional contract cases; final verify executed them all.
VERIFY: PASS (npm run lint && npm test)
GIT_DIFF_CHECK: PASS
Coverage includes Android, backend/cloud, Desktop HTTP API/notification ingestion, Electron client and Server Agent. Skips are existing platform/optional conditions, including Windows-unavailable Linux symlink/bash cases. No real Android cloud build, uniCloud deployment, Android profiler or installed-device acceptance executed. UTS algorithms execute after type-syntax removal; this is not Kotlin compilation evidence.

## VERSION / CLOUD

VERSION_NAME: 0.1.1
VERSION_CODE: 6
PACKAGE: com.gary.tokenm
APPID: __UNI__46C9063
TOKENM_CORE_CHANGED: YES
TOKENM_CO_CHANGED: YES
UNICLOUD_DEPLOY_EXECUTED: NO
UNICLOUD_DEPLOY_REQUIRED: YES
TOKENM_CORE_DEPLOY_REQUIRED: YES
DEPENDENT_FUNCTION_REFRESH_REQUIRED: YES
DEPENDENT_FUNCTIONS: tokenm-co, tokenm-desktop-http (the only package.json tokenm-core consumers found).
Required order: deploy common/tokenm-core and refresh both consumers, validate server consent rejection and new RPCs in the intended space, then build/install the versionCode=6 client. Do not release the optimized client against the previous cloud implementation: the short preflight reuse relies on the new server enforcement. Validate compound queries/index behavior in the intended cloud space without altering ownership/history semantics. Production refresh and Android build remain separate authorized follow-up work.

## USER_WORK / DEFERRED

ORIGINAL_POTATO_BRAND_WORKTREE_TOUCHED: NO
USER_PUSH_PNG_MODIFICATIONS_TOUCHED: NO (same five modified resource paths remain).
FORMAL_MAIN_TOUCHED: NO
AGENTS_MD_MODIFIED: NO
FORCE: NO

DEFERRED_OPTIMIZATIONS:
- Task virtualization: concat grows row count at 100/500/1000 records, but no device evidence establishes a current bottleneck. Preserve complete pagination rather than truncate or introduce complex list behavior.
- Settings 300s TTL: no cross-client invalidation event; 60s is a more conservative freshness bound.
- Legacy getDashboard replacement: other callers may need latestTask/total/device counts; Android moves to the bounded bundle while preserving their response.

NEXT_EXECUTOR: ChatGPT / project lead
