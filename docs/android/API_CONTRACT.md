# Potato Android API contract — Phase 2

## Scope and authentication

The Phase 1 runtime baseline remains the foundation: pairing, Desktop
credential authentication, completion-event submission, cloud task
persistence, and authenticated Android task reads were verified before this
notification phase. Phase 2 adds a server-side notification-submission
decision after task persistence; it does not redefine pairing, credentials,
Desktop authentication, or task ownership.

## Mobile Cloud Object

Object name: `tokenm-co`.

Every method requires a valid official uni-id token. `_before` derives `uid`; request bodies never accept `ownerId`, CID, source IP, or provider credentials. Business errors use stable `errCode` values and safe public messages.

| Method | Input | Result |
| --- | --- | --- |
| `bootstrap` | `{}` | user settings/consent plus resource counts |
| `getDashboard` | `{ dayStart?, dayEnd? }` | settings, active/resource/today counts, latest task |
| `listTasks` | `{ limit?, desktopId?, notificationStatus?, notificationStatuses?, privacyMode?, cursor? }` | `{ tasks, nextCursor }` |
| `getTask` | `{ taskId }` | one owner-visible task |
| `listDesktops` | `{}` | owner desktops, newest first |
| `createPairingCode` | `{}` | session ID, six-digit code, expiry, TTL |
| `getPairingStatus` | `{ sessionId? }` | owned session state and paired Desktop ID when available |
| `renameDesktop` | `{ desktopId, name }` | updated active Desktop |
| `unbindDesktop` | `{ desktopId, confirmation: 'UNBIND' }` | revoked Desktop |
| `updateSettings` | `{ notificationsEnabled }` | updated settings |
| `getPrivacyConsent` | `{}` | required/accepted version and current fact |
| `updatePrivacyConsent` | `{ version }` | updated consent fact |
| `registerMobileDevice` | `{ enabled?, deviceLabel?, pushRegistrationStatus?, notificationPermissionState? }` | trusted client identity plus stored business device state |
| `clearTaskHistory` | `{ confirmation: 'CLEAR' }` | deleted count and `cleanupPending` |
| `deleteAccount` | `{ confirmation: 'DELETE' }` | custom-data cleanup state |

`dayStart` and `dayEnd` must be supplied together as exact ISO timestamps and may span at most 26 hours. The app supplies its local calendar-day bounds, so “今日完成” follows the phone's day.

`notificationStatus` is one of `not_requested`, `skipped_disabled`,
`skipped_no_target`, `pending`, `submitted`, or `failed`.
`notificationStatuses` accepts a unique non-empty list from that set. The two
filters cannot be combined. `notificationReason`, when present, is one of
`notifications_disabled`, `privacy_consent_required`, `no_eligible_device`,
`cid_unavailable`, `provider_rejected`, or `provider_error`.

Task notification metadata is server-owned. `notificationTargetCount` is an
integer from 0 through 500; `notificationAttemptedAtMs` and
`notificationSubmittedAtMs` are epoch-millisecond timestamps; and
`notificationProviderCode` is a bounded provider result code. These fields do
not contain a CID, notification body, task content, or a delivery receipt.

Phase 1 task rows historically started and remained at `not_requested`. In
Phase 2 that value means no notification decision/attempt has been claimed;
the server may transition it to a skip, a bounded `pending` attempt, or its
submission result.

The task cursor is:

```json
{
  "createdAtMs": 1787472000000,
  "taskId": "tsk_<random UUID>"
}
```

The literal value above illustrates shape only. Production identifiers are returned by the server.

## Desktop URLized function

Function: `tokenm-desktop-http`.

Current支付宝云 production URLized base:

```text
https://env-00jy6pbiul92.dev-hz.cloudbasefunction.cn/tokenm-desktop-http
```

The `api-hz.cloudbasefunction.cn` request domain is used by ordinary uniCloud client calls; it is not the URLized HTTP-function domain. The current URLized route was verified with an unauthenticated status request returning HTTP 401.

The function consumes支付宝云 integrated HTTP events and returns `mpserverlessComposedResponse: true`, JSON content type, and `cache-control: no-store`. Request bodies are limited to 16 KiB.

| Route | Authentication | Request |
| --- | --- | --- |
| `POST /v1/desktop/pair` | six-digit active pairing code | `{ schemaVersion: 1, code, deviceName }` |
| `GET /v1/desktop/status` | `Authorization: Bearer <tm_uc_d1 credential>` | no body |
| `POST /v1/desktop/events` | bearer credential | completion event below |
| `POST /v1/desktop/unpair-self` | bearer credential | `{ confirmation: 'UNPAIR' }` |

Pair success returns status, Desktop ID/name, the credential once, and a request ID. Status refreshes `lastSeenAt`. Unpair revokes the current Desktop credential.

The completion event is:

```json
{
  "schemaVersion": 1,
  "eventId": "evt:<sessionId>:<turnId>",
  "event": "codex.task.completed",
  "desktopId": "dev_<random UUID>",
  "occurredAt": "2026-08-23T08:00:00.000Z",
  "privacyMode": true,
  "sessionId": "session-identifier",
  "project": null,
  "model": null,
  "summary": null,
  "durationMs": null
}
```

For an accepted new event the HTTP status is `201` with `status: "created"`;
the task is persisted before notification eligibility is evaluated. The
response includes the task ID and the resulting notification status. A
provider rejection or provider error therefore leaves the event accepted and
the task readable, while returning `failed` for the notification attempt.
An identical duplicate is `200` with `status: "duplicate"`, the existing task
ID, and its stored notification status. A duplicate never calls the provider
again. Reusing the same event identity with different allowed fields returns
`event_conflict`.

Pairing creation is limited per authenticated owner. The unauthenticated pair exchange is limited per validated支付宝云 `context.CLIENTIP`. The HTTP function never trusts forwarded/request headers as the limiter identity; missing or malformed platform context fails closed with `configuration_required`. Status, event submission, and self-unpair have no application rate-limit rule.

## Public Desktop errors

| Code | HTTP status |
| --- | --- |
| `body_too_large` | 413 |
| `configuration_required` | 503 |
| `desktop_revoked` | 401 |
| `event_conflict` | 409 |
| `invalid_request` | 422 (or 404/405 for route mismatch) |
| `pairing_invalid` | 404 |
| `privacy_payload_rejected` | 422 |
| `rate_limited` | 429 |
| `unauthenticated` | 401 |
| `unauthorized` | 403 |
| `internal_error` | 500 |

Error responses contain only `{ error: { code, message }, requestId }`. They do not reflect request bodies, credentials, task content, internal stack data, source IP, or user-agent strings.

## Notification boundary

The Android client never sends a CID to a Potato business method. After the
authenticated official uni-id session is current, the current privacy version
is accepted, and the user has explicitly enabled the notification path, the
client obtains the runtime CID from uni-push 2.0 and binds it through the
official `uniIdCo.setPushCid({ pushClientId })` method. The official
`uni-id-device` identity collection is the CID source for server delivery;
`tokenm-mobile-devices` is only a business-state mirror and has no CID field.

`tokenm-co._before` authenticates the official token and derives the current
`uid`. `registerMobileDevice` uses that authenticated owner and trusted
`clientInfo.deviceId`, `platform`, and `appVersion`; client input cannot name
another owner or supply a CID. Registration is an owner/device upsert, so a
refresh, reinstall, logout/relogin, or device disablement does not create a
second row for the same `(ownerId, deviceId)` key.

The Desktop event path is:

```text
authenticate Desktop
  -> validate and deduplicate (desktopId, eventId)
  -> persist tokenm-task first
  -> evaluate user/device eligibility
  -> conditional update not_requested -> pending
  -> one uni-push 2.0 sendMessage attempt
  -> persist submitted or failed
```

Eligibility requires the authenticated task owner, `tokenm-users.notificationsEnabled`,
current Potato privacy consent, an active business device with
`pushRegistrationStatus: ready` and `notificationPermissionState: authorized`,
an Android platform identity, and a current non-empty CID in official
`uni-id-device`. All initial eligible devices are selected, duplicate CIDs are
removed, and one bounded `sendMessage` request carries at most 500 targets.
The conditional task update is the event-level at-most-once claim; there is no
automatic retry. Push failure never rolls back task persistence or changes the
Desktop event acceptance result.

The sole Phase 2 provider path is DCloud uni-push 2.0 through the uniCloud
push manager (`uniCloud.getPushManager({ appId }).sendMessage(...)`). The
minimal request uses `platform: "app-android"`, `title: "Potato"`, body
`"任务完成"` or `"任务完成 · <电脑名>"`, `force_notification: true`, and the
safe data payload `{ "taskId": "<task id>" }`. It never includes prompt,
reply, cwd, terminal output, source, conversation, credential, token, or task
summary content. Provider acceptance is recorded as `submitted`; it is not a
claim that Android displayed the notification. A client push listener handles
the click route only and does not create a second local notification.

Honor and Xiaomi vendor Push remain OFF. This contract makes no claim that a
CID exists in the current runtime, that a real provider send has occurred, or
that a device has displayed a notification; those are separate runtime
acceptance facts.
