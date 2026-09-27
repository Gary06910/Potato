# Database and official-module boundary

The six active `tokenm-*` collections are server-only: `users`, `desktops`,
`pairing-sessions`, `tasks`, `mobile-devices`, and `rate-limits`. Every schema
denies client `read`, `create`, `update`, `delete`, and `count`; Android access
goes through the authenticated `tokenm-co` Cloud Object. Index files include
支付宝云 `Type` values. Phase 2 keeps delivery state on `tokenm-tasks`; it
does not create a delivery/audit collection or a retry framework. Application
code checks pairing expiry and rate buckets against server time on every read
or mutation.

Only active pairing records retain `code` and `activeOwnerKey`; terminal records clear both fields. Two always-present uniqueness keys contain the code/owner while active and fresh random UUID tombstones when terminal. Ordinary unique indexes on those keys enforce concurrent code and owner exclusion without nullable or sparse index behavior and without retaining an old code.

The official identity modules own their own collections. Import and configure the current official modules through HBuilderX/uni_modules rather than copying schemas or module code here. Expected official dependencies include `uni-id-users`, `opendb-verify-codes`, `uni-id-device`, `opendb-device`, and `opendb-tempdata`; the exact set must be confirmed after importing the current official `uni-id-co` and `uni-id-common` modules.

Official `uni-id-co` remains responsible for username/password registration
and login, account identity lifecycle, and platform notification identity
lifecycle. The official `uni-id-device` collection is the CID source after the
client binds the runtime CID through `uniIdCo.setPushCid`; Potato's
`tokenm-mobile-devices` collection is only a business-state mirror and has no
CID field. Its `(ownerId, deviceId)` uniqueness key is upserted by the
authenticated `tokenm-co` context, while device identity/platform/app version
come from trusted client information rather than request-supplied ownership.

An eligible target requires `tokenm-users.notificationsEnabled`, current
Potato privacy consent, an active business device with
`pushRegistrationStatus: ready` and `notificationPermissionState: authorized`,
an Android platform identity, and a current non-empty official CID. CID
refreshes and reinstall/relogin lifecycle changes update the current device
row; the CID itself is never copied into the business schema.

Phase 1's persistence-only behavior is historical. Phase 2 persists the task
first, then conditionally claims `not_requested -> pending` with a database
update before one uni-push 2.0 `sendMessage` attempt. All initial eligible
deduplicated CIDs are included in one request, up to 500 targets. The result is
`submitted` or `failed`; disabled/no-target decisions are
`skipped_disabled`/`skipped_no_target`. The event-level claim allows at most
one automatic attempt per selected target and there is no retry or fallback.
Provider `submitted` is not device display evidence.

The only secret used by Potato backend code is `TOKEN_M_DESKTOP_CREDENTIAL_KEY`, configured as a 32-byte base64url environment variable. No SpaceID, cloud binding, provider secret, or production deployment configuration is stored here.

`tokenm-users` stores acceptance of the internal privacy protocol version `tokenm-android-v1`; this identifier does not represent legal-text approval. Publication requires final review of the privacy text and version, and any later text change must explicitly bump the version. Account deletion removes only Potato custom data. The client must repeat `deleteAccount` until `cleanupPending` is `false`, then separately call the current official `uniIdCo.closeAccount()` method; Potato does not proxy or imitate that official identity operation.

Platform validation references (accessed 2026-08-23):

- https://doc.dcloud.net.cn/uniCloud/schema
- https://doc.dcloud.net.cn/uniCloud/db-index.html
- https://doc.dcloud.net.cn/uniCloud/cf-database.html#start-transaction
- https://doc.dcloud.net.cn/uniCloud/uni-id/cloud-common.html
- https://doc.dcloud.net.cn/uniCloud/uni-id/cloud-object
