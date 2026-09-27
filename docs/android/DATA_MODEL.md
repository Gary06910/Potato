# Potato Android data model — Phase 2

Phase 1 runtime facts remain the baseline for this model: the authenticated
owner, paired Desktop, completion event, task persistence, and Android task
visibility were verified before notification delivery was introduced. Phase
2 adds notification state to the existing task record; it does not add a
second task store or change the Phase 1 ownership boundary.

## Ownership boundary

All six Phase 1 `tokenm-*` collections deny direct client operations. Android reads and writes them only through authenticated `tokenm-co`; Desktop uses only `tokenm-desktop-http`. `ownerId` is derived or resolved on the server and is never accepted from a Desktop request.

Official identity/push collections are installed and managed by the current
DCloud modules. Potato does not duplicate their schemas. The official
`uni-id-device` collection is the server-side source for the uni-push CID
bound by `uniIdCo.setPushCid`; `tokenm-mobile-devices` is only a business-state
mirror and has no CID field.

## Custom collections

| Collection | Purpose | Important fields |
| --- | --- | --- |
| `tokenm-users` | User-level Android settings and consent fact | `_id`, `ownerId`, `notificationsEnabled`, `privacyConsentVersion`, `privacyConsentAtMs`, `historyClearedAtMs`, timestamps |
| `tokenm-desktops` | Paired Desktop identity and credential state | `_id`, `ownerId`, `name`, `status`, `encryptedSecret`, `lastSeenAtMs`, `lastEventAtMs`, `revokedAtMs`, timestamps |
| `tokenm-pairing-sessions` | Short-lived six-digit pairing session | `_id`, `ownerId`, `code`, `status`, `attemptCount`, `maxAttempts`, `expiresAtMs`, uniqueness keys, `desktopId`, timestamps |
| `tokenm-tasks` | Owner-scoped completion record and notification submission state | `_id`, `ownerId`, event allowlist fields, `notificationStatus`, optional notification reason/target/timestamp/provider fields, timestamps |
| `tokenm-mobile-devices` | UI and eligibility state for each app installation | `_id`, `ownerId`, trusted `deviceId`, platform, label, registration/permission facts, app version, `status`, last-seen and timestamps; never a CID |
| `tokenm-rate-limits` | Pairing-only fixed-window buckets | `_id`, scope, subject, optional owner, bucket, count, limit, window, expiry and timestamps |

## Required uniqueness and query indexes

- `tokenm-users.ownerId` is unique.
- `tokenm-mobile-devices(ownerId, deviceId)` is unique.
- `tokenm-pairing-sessions.codeUniquenessKey` and `ownerUniquenessKey` are individually unique while active; terminal records receive fresh random tombstones.
- `tokenm-tasks(desktopId, eventId)` is unique.
- `tokenm-rate-limits(scope, subject, bucket)` is unique.
- Owner/time indexes support Desktop, task, and settings views.
- Task indexes support tuple pagination plus Desktop, notification-status, and privacy filters.

No TTL index is assumed. Pairing expiry and stale rate buckets are evaluated against server time during application operations.

## Task record

Allowed event fields are:

```text
schemaVersion
eventId
event
desktopId
occurredAt
privacyMode
sessionId
project
model
summary
durationMs
```

When `privacyMode` is true, `project`, `model`, `summary`, and `durationMs` must be null or absent at the Desktop boundary and are stored as null. Prompt text, full responses, working-directory paths, terminal output, source code, conversation data, credentials, and tokens are not fields in this model.

The optional notification fields are server-owned:

```text
notificationStatus: not_requested | skipped_disabled | skipped_no_target
                   | pending | submitted | failed
notificationReason: notifications_disabled | privacy_consent_required
                    | no_eligible_device | cid_unavailable
                    | provider_rejected | provider_error
notificationTargetCount: integer 0..500
notificationAttemptedAtMs: epoch-millisecond long
notificationSubmittedAtMs: epoch-millisecond long
notificationProviderCode: bounded provider result code (max 80 characters)
```

They contain no CID, notification body, task content, or claim of device
display. `submitted` records provider acceptance only.

## Mobile device and official CID state

`tokenm-mobile-devices` has the unique key `(ownerId, deviceId)` and stores
only the business mirror:

```text
ownerId
deviceId
platform
deviceLabel
pushRegistrationStatus: notStarted | ready | error
notificationPermissionState: notDetermined | authorized | denied
appVersion
status: active | disabled
lastSeenAtMs
createdAtMs / updatedAtMs
```

The server derives `ownerId` from the authenticated uni-id context and derives
`deviceId`, platform, and app version from trusted client information. The
client cannot choose another owner or provide a CID. Registration is an
upsert: CID refresh, reinstall, logout/relogin ownership changes, and device
disablement update the current business row rather than creating a duplicate.

The official identity record is resolved separately by authenticated owner,
the Potato DCloud AppID, and trusted device identity. A target is eligible
only when the business row is active and ready/authorized for an Android
installation and the official identity has a current non-empty `push_clientid`
whose provider expiry has not passed. The business row deliberately does not
mirror that CID.

Task pagination is ordered by `(createdAtMs desc, _id desc)`. The cursor is an object with `createdAtMs` and the random `taskId`; same-millisecond rows are not lost.

## Pairing lifecycle

An active session contains one six-digit code, expires after 600 seconds, allows at most five submitted pairing attempts, and is single use. Creating a new session supersedes the owner's existing active session. Terminal session states are `paired`, `expired`, `superseded`, or `locked`; active lookup fields are cleared.

The pairing response returns the Desktop credential once. The server stores only the encrypted secret fields needed to authenticate later requests. Unbinding changes the Desktop to `revoked` and removes the encrypted secret.

## Phase 1 historical persistence state

```text
Desktop event accepted
  -> one owner-scoped task is stored
  -> notificationStatus = not_requested
  -> Android reads the task through tokenm-co
```

This was the verified Phase 1 path. A duplicate Desktop event never creates a
second task; the `(desktopId, eventId)` unique constraint remains the
deduplication boundary.

## Phase 2 notification state

The existing task row now carries the finite delivery-submission state. The
server persists the task first, then evaluates the owner setting, current
privacy consent, business-device state, official identity, and CID. A disabled
setting or missing current consent transitions `not_requested` to
`skipped_disabled` with a reason. No active/ready/authorized device, or no
current CID, transitions it to `skipped_no_target` with the corresponding
reason.

When targets exist, a conditional database update matching the task ID and
`notificationStatus: not_requested` changes it to `pending` and records the
attempt timestamp and target count. Only the successful update owner may call
the provider. One uni-push 2.0 `sendMessage` call contains all initial eligible
targets after CID deduplication, with a maximum of 500. Provider acceptance
transitions `pending` to `submitted`; rejection or a thrown provider error
transitions it to `failed`. There is no retry queue, fallback provider, or
automatic retry. The event-level claim means every target in that one request
receives at most one automatic provider attempt for the event.

The state is a submission record, not a device-delivery receipt. Android task
visibility and task persistence do not depend on provider success. Duplicate
events return the stored task state and never call `sendMessage` again.

No separate Push delivery collection is introduced. Honor and Xiaomi vendor
channels remain OFF.

`tokenm-rate-limits` is used only for authenticated pairing-code creation and unauthenticated Desktop pair exchange. The latter subject comes only from支付宝云 `context.CLIENTIP`; request headers are not trusted and the address is not hashed. Expired Desktop-pair buckets are removed in a bounded cleanup during later pairing attempts; no TTL index is claimed.

## Cleanup semantics

Task-history clearing removes tasks in bounded server transactions and advances `historyClearedAtMs`; the app repeats the operation only while `cleanupPending` is true. Account deletion similarly clears the six Potato custom collections before the client calls the official account-close operation.

There is no import of WeChat task history. Existing CloudBase records remain in the legacy system.

The executable schemas and支付宝 index definitions are in `apps/tokenm-android/uniCloud-alipay/database` and are the authoritative deployment artifacts.
