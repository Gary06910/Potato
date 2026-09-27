# Potato uni-push 2.0 notification contract — Phase 2

Phase 1 is a historical runtime baseline, not the current notification
contract. Pairing, Desktop credentials, event persistence, and authenticated
Android task reads remain unchanged and remain independently reliable.

## Phase 1 path retained

```text
Desktop event accepted
  -> random task record persisted
  -> notificationStatus = not_requested
  -> Android reads the task through authenticated tokenm-co
```

The unique `(desktopId, eventId)` invariant prevents a repeated Desktop event
from creating another task. An identical retry returns `duplicate` with the
original task ID and stored notification status; a different allowed payload
for that identity returns `event_conflict`. A duplicate never sends Push.

Phase 1 records only `not_requested`. Phase 2 keeps that state on the same
task record and adds a bounded provider-submission step after persistence; it
does not introduce a delivery collection or a provider abstraction.

## Android client registration contract

After login, acceptance of the current privacy version, and an explicit user
notification action, the unchanged Android client requests a runtime CID from
uni-push 2.0 when the SDK makes one available, and passes it only to the
official identity API:

```js
uniIdCo.setPushCid({ pushClientId: cid })
```

The Potato business API does not accept or store the CID. `uni-id-device` is
the official server-side CID source. `tokenm-mobile-devices` records only safe
business facts: enabled state, a label, notification-permission state,
registration state, trusted platform/app version, trusted client device
identity, status, and timestamps. Its unique `(ownerId, deviceId)` key is
upserted on refresh; it is not a CID cache.

## Eligibility and delivery path

The backend requires all of the following before attempting Push:

- authenticated task owner and `tokenm-users.notificationsEnabled` is true;
- current Potato privacy consent;
- an active business device with `pushRegistrationStatus: ready` and
  `notificationPermissionState: authorized` on an Android platform; and
- a current, non-empty official `uni-id-device.push_clientid` bound to that
  same authenticated owner, AppID, and trusted device identity.

The event path is:

```text
Desktop event
  -> authenticate and validate
  -> deduplicate (desktopId, eventId)
  -> persist tokenm-task FIRST
  -> evaluate notification eligibility
  -> conditional update not_requested -> pending
  -> one uni-push 2.0 sendMessage call
  -> conditional result update submitted or failed
```

Missing setting/consent becomes `skipped_disabled`; no eligible device or no
usable CID becomes `skipped_no_target`. The reason is recorded separately as
`notifications_disabled`, `privacy_consent_required`, `no_eligible_device`,
or `cid_unavailable`.

The conditional update matching the task ID and
`notificationStatus: not_requested` is the atomic event-level claim. One
request contains all initial eligible CIDs after deduplication, with a maximum
of 500 targets. Only the successful claimant calls the provider. The provider
call has its own four-second bound inside the cloud function; there is no
retry, fallback provider, or retry queue. A provider rejection is
`failed/provider_rejected`; a thrown/provider error is `failed/provider_error`.
Provider failure never rolls back the task or makes the Desktop event fail.

## Status and provider semantics

The finite task status set is:

```text
not_requested
skipped_disabled
skipped_no_target
pending
submitted
failed
```

`notificationTargetCount` records the deduplicated targets in the attempted
request (0 for a skip). `notificationAttemptedAtMs` records the claim time;
`notificationSubmittedAtMs` is written only after provider acceptance;
`notificationProviderCode` is a bounded result category/code. `submitted`
means that the uni-push provider accepted the request. It does not mean the
Android device displayed a system notification and is never labelled
`delivered`.

## Single provider and minimal payload

The only provider is DCloud uni-push 2.0 through the uniCloud push manager:

```js
uniCloud.getPushManager({ appId: '__UNI__46C9063' }).sendMessage({
  push_clientid: ['<deduplicated eligible CIDs>'],
  platform: 'app-android',
  title: 'Potato',
  content: '任务完成' /* or `任务完成 · <电脑名>` */,
  payload: { taskId: '<task id>' },
  force_notification: true
})
```

The safe data payload has only `taskId`. The title/body contain no prompt,
reply, cwd, terminal output, source, conversation, credential, token, task
正文, or summary. The Android `onPushMessage` listener handles click routing
only; it does not create a second local notification, so the provider system
notification is the one notification path.

Honor and Xiaomi vendor Push remain OFF. No vendor SDK, manifest change,
vendor configuration, or offline-channel claim belongs to this phase.

## Android/build boundary

The existing uni-app x Android source and current Phase 1 APK path are
unchanged for this backend contract. No Android source edit or new Cloud Build
is implied by Phase 2 notification-state/backend work.

The local listener and CID registration contract do not prove delivery.
Foreground/background/lock-screen arrival, vendor classification, and signed
device behavior remain separate runtime acceptance facts. This document does
not claim a real CID, a real provider send, or a displayed notification.

Official references verified for Phase 2:

- https://doc.dcloud.net.cn/uni-app-x/api/uni-push.html
- https://doc.dcloud.net.cn/uniCloud/uni-cloud-push/api.html
- https://doc.dcloud.net.cn/uniCloud/uni-id/cloud-object
