# URL化 integration boundary — Phase 2 uni-push 2.0

The Phase 1 Desktop authentication, pairing, event validation, deduplication,
and task-visibility behavior remains the baseline. Phase 2 adds only the
server-side notification decision after the task is persisted.

Configure this ordinary cloud function as a URL化 endpoint. The platform passes
the integrated request (`path`, `httpMethod`, `headers`, `body`, and
`isBase64Encoded`) as the first argument and the platform context as the second
argument. Pairing reads only `context.CLIENTIP`; it never trusts a request
header for the client IP. A valid address becomes the short-lived rate subject
`client-ip:<ip>` and is not hashed or persisted as a credential.

The function has exactly four routes:

| Endpoint | Request and response | Auth, ownership, errors, idempotency |
| --- | --- | --- |
| `POST /v1/desktop/pair` | JSON `{schemaVersion, code, deviceName}`; `201` returns `{status:"paired", desktop, credential, requestId}`. | No Bearer. The six-digit code is owner-created, expires after 600 seconds, and is one-time. `context.CLIENTIP` is required; invalid/missing configuration returns `503 configuration_required`, an invalid/expired/used code returns `404 pairing_invalid`, and a short-lived per-IP limit returns `429 rate_limited`. |
| `GET /v1/desktop/status` | Bearer request; `200` returns the public desktop status and `serverTime` plus `requestId`. | Bearer credential authenticates one desktop; all data is owner-scoped. The read updates `lastSeenAt`. Invalid/revoked credentials return `401 unauthenticated` or `401 desktop_revoked`. |
| `POST /v1/desktop/events` | Bearer plus JSON event; `201` returns `{status:"created", taskId, notificationStatus, requestId}`; duplicate returns `200` with the stored notification status. | Bearer credential authenticates the desktop and its owner. `desktopId` must match the credential. The `(desktopId,eventId)` unique key makes retries idempotent; different payload for that key returns `409 event_conflict`. Invalid privacy/event data returns `422`; unauthorized ownership returns `403`. The task is accepted even when notification submission fails. |
| `POST /v1/desktop/unpair-self` | Bearer plus JSON `{confirmation:"UNPAIR"}`; `200` returns `{ok:true, requestId}`. | Bearer credential can revoke only its own desktop. The credential is immediately invalid after revocation. Invalid confirmation returns `422`; a revoked credential returns `401 desktop_revoked`. |

Only the owner-side pairing-code creation and the unauthenticated desktop-pair
exchange are rate-limited. The former uses the authenticated uni-id owner; the
latter uses the validated short-lived `client-ip:<ip>` subject. Status, events,
and unpair-self have no application rate-limit rule in this phase.

## Phase 2 event and notification contract

The event handler keeps the Phase 1 ordering and then performs one bounded
notification step:

```text
authenticate Desktop
  -> validate event and deduplicate (desktopId, eventId)
  -> persist tokenm-task FIRST
  -> evaluate owner/device/official-CID eligibility
  -> conditional update not_requested -> pending
  -> one uni-push 2.0 sendMessage call
  -> persist submitted or failed
  -> return event accepted
```

The mobile registration API is not part of this Desktop HTTP boundary. The
Android client binds its runtime CID only through official
`uniIdCo.setPushCid`; the backend reads current CIDs from official
`uni-id-device`. `tokenm-mobile-devices` stores no CID and is selected by
authenticated owner, trusted device identity, active status,
`pushRegistrationStatus: ready`, and `notificationPermissionState: authorized`.
Eligibility also requires `tokenm-users.notificationsEnabled` and current
privacy consent.

The claim is an atomic database update matching the task ID and
`notificationStatus: "not_requested"`. It records `pending` and the attempted
timestamp before calling the provider. One request includes all initial
eligible CIDs after deduplication, at most 500 targets. A duplicate event
returns the existing task state and never calls Push again. There is no retry,
fallback provider, retry queue, or second attempt for a selected target. The
single provider call is bounded to four seconds so an unavailable provider
cannot consume the cloud function's entire ten-second request window.

The only provider is DCloud uni-push 2.0 through
`uniCloud.getPushManager({ appId: "__UNI__46C9063" }).sendMessage(...)`. The
minimal notification uses title `Potato`, body `任务完成` optionally followed
by the safe computer name, `force_notification: true`, and data
`{ taskId }` only. Prompt, reply, cwd, terminal output, source, conversation,
credential, token, task正文, and summary content are forbidden. Provider
acceptance becomes `submitted`; rejection/error becomes `failed` with a safe
reason/code. `submitted` is not device-display evidence.

The task states are `not_requested`, `skipped_disabled`, `skipped_no_target`,
`pending`, `submitted`, and `failed`. Notification failure never rolls back
`tokenm-tasks` or changes the Desktop event acceptance result. Honor and
Xiaomi vendor channels remain OFF. The `uni-cloud-push` extension is required
for the DCloud send helper; no vendor adapter or provider framework is used.

The Phase 2 backend contract does not change Android source or require a new
Cloud Build. This document does not assert a real CID, a real provider send,
or a displayed notification.
