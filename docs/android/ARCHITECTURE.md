# Potato Android architecture — Phase 2 uni-push 2.0

The Phase 1 runtime baseline remains intact: pairing, Desktop credential
authentication, Desktop event acceptance, cloud task persistence, and Android
task visibility were verified before notification delivery was added. Phase 2
extends the existing event path after persistence and leaves those boundaries
unchanged.

## Current implementation

Potato Android v1 is implemented in `apps/tokenm-android` as a uni-app x VDOM application with an支付宝云 uniCloud backend. It does not replace or modify the existing WeChat/CloudBase path during development.

```text
Codex completion
  -> existing Potato Desktop completion runtime
  -> explicit Android destination selected by the user
  -> tokenm-desktop-http URLized cloud function
  -> tokenm-core application service
  -> owner-scoped task persistence FIRST
  -> notification eligibility and atomic not_requested -> pending claim
  -> one uni-push 2.0 sendMessage attempt
  -> submitted or failed notification state
  -> authenticated Android task read

Android app
  -> official uni-id-co username/password session
  -> authenticated tokenm-co Cloud Object
  -> Potato server-only collections
```

The implemented client has four primary destinations: 首页, 任务, 电脑, 设置. Thirteen VDOM pages cover onboarding, authentication, privacy and permission onboarding, dashboard, task list/detail, desktops, pairing, notification settings, privacy controls, and about information.

## Component boundaries

| Component | Location | Responsibility |
| --- | --- | --- |
| Android UI | `apps/tokenm-android/pages`, `components`, `uni.scss` | Presentation, explicit user actions, loading/error/empty/refetch states |
| Client business facade | `apps/tokenm-android/services/tokenm-service.uts` | Typed Cloud Object DTO mapping for dashboard, tasks, desktops, pairing, and settings |
| Account/runtime boundary | `services/auth-service.uts`, `client-runtime.uts` | Official uni-id session, current privacy fact, permission fact, push lifecycle |
| Push runtime | `services/push-runtime.uts`, `mobile-device.uts` | Explicit permission CTA, one listener, official runtime CID binding, task click route; no local duplicate notification |
| Mobile Cloud Object | `uniCloud-alipay/cloudfunctions/tokenm-co` | Token validation and owner-scoped mobile methods |
| Shared application service | `cloudfunctions/common/tokenm-core` | Validation, ownership, pairing, Desktop authentication, task persistence, and deduplication |
| Desktop HTTP boundary | `cloudfunctions/tokenm-desktop-http` | Four fixed Desktop routes and bearer credential handling |
| Desktop integration | `src/electron/android*.js`, `androidNotificationRuntime.js` | New credential namespace, outbox, explicit event, destination selection |

The pages do not call `uniCloud.importObject`, databases, or push APIs directly. `tokenm-service.uts` is the only business-data facade used by the pages. Account, privacy, and push operations remain in their dedicated runtime services.

## Identity and ownership

The Android app uses the official `uni-id-co` username/password methods.
`tokenm-co._before` validates the current token with `uni-id-common`, derives
the authenticated `uid`, and passes that identity to every application-service
method. Mobile callers cannot choose an owner ID. `registerMobileDevice`
receives device identity, platform, and app version from trusted `clientInfo`;
its `(ownerId, deviceId)` row is an upsert.

Desktop authentication is independent. Pairing produces a random credential in the `tm_uc_d1` namespace. The long-lived secret is encrypted at rest with one deployment-owned AES-256-GCM key. Revocation removes the encrypted secret and immediately makes the credential unusable.

Every business collection is server-only. The client does not receive database
permissions and never stores or supplies a push CID to Potato business
methods. The official `uniIdCo.setPushCid()` lifecycle owns CID-to-user
association, and the official `uni-id-device` identity record is the backend
CID source. `tokenm-mobile-devices` remains a business-state mirror without a
CID field.

## Task and notification invariants

- A task ID is random.
- `(desktopId, eventId)` is unique.
- A repeated identical event returns `duplicate`; changed allowed fields return `event_conflict`.
- Every event first creates one owner-scoped task with `notificationStatus: not_requested`.
- The server then checks `notificationsEnabled`, current privacy consent, active/ready/authorized Android devices, and current official CIDs.
- A conditional update matching the task ID and `not_requested` atomically claims `pending`; only its winner may call uni-push.
- One `sendMessage` request contains all initial eligible, deduplicated CIDs, up to 500. The event claim gives each selected target at most one automatic attempt; there is no retry or fallback provider.
- Results are `skipped_disabled`, `skipped_no_target`, `submitted`, or `failed` (with optional reason/code metadata). `submitted` is provider acceptance, not device display.
- Task list and task detail are fetched only through authenticated, owner-scoped methods.
- The Desktop event allowlist excludes prompt, full reply, working-directory path, terminal output, source code, conversation data, credentials, and tokens.

## Vendor boundary

The generic uni-push 2.0 client module supports the explicit local
permission/CID contract. The server uses only DCloud's uniCloud push manager
and a minimal system-notification payload: `Potato`, `任务完成` optionally
with the computer name, and safe data `{ taskId }`. Honor and Xiaomi vendor
channels remain OFF: no vendor SDK/configuration, category, channel/template
ID, provider secret, or offline-channel behavior belongs to this phase.
Provider acceptance is never relabelled as device delivery.

## Legacy boundary and runtime identifiers

CloudBase, the WeChat Mini Program, the existing Stop Hook, and the original Desktop local task runtime remain intact. There is no CloudBase-to-uniCloud history copy and no dual write. The new Android destination is additive and failures do not stop local collection.

The real identifiers are AppID `__UNI__46C9063`, package `com.gary.tokenm`, provider `支付宝云`, and space `tokenm-prod` (`env-00jy6pbiul92`). Auth remains the protected baseline.

The real identifiers remain AppID `__UNI__46C9063`, package `com.gary.tokenm`,
provider `支付宝云`, and space `tokenm-prod`
(`env-00jy6pbiul92`). The Desktop function's URLized route is
`/tokenm-desktop-http` and its configured base is
`https://env-00jy6pbiul92.dev-hz.cloudbasefunction.cn/tokenm-desktop-http`.
Phase 2 rollout and runtime acceptance are tracked separately; this
architecture document does not assert a real CID, provider send, or device
display.

## Android source/build boundary

Phase 2 backend notification work does not change the existing uni-app x
Android source, HBuilderX version, renderer, package, or current installed APK
path. A new Cloud Build is not implied by these backend contract changes.

Official references checked through 2026-09-01:

- https://doc.dcloud.net.cn/uni-app-x/project
- https://doc.dcloud.net.cn/uni-app-x/collocation/manifest.html
- https://doc.dcloud.net.cn/uniCloud/concepts/space
- https://doc.dcloud.net.cn/uniCloud/cloud-obj.html
- https://doc.dcloud.net.cn/uniCloud/uni-id/cloud-object
- https://doc.dcloud.net.cn/uniCloud/uni-cloud-push/api.html
- https://doc.dcloud.net.cn/uni-app-x/api/uni-push.html
- https://doc.dcloud.net.cn/uniCloud/http
