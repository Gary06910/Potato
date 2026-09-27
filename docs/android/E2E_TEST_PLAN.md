# Potato Android v1 real-device E2E plan

## Entry gate

Do not start until `MANUAL_PREREQUISITES.md` items for DCloud identity, package, release signing, cloud binding, official modules, environment configuration, uni-push 2.0, Honor Push/classification, and a physical Honor device are complete. Every external write or real send also requires explicit user authorization.

Use a dedicated test account and one explicitly paired Desktop. Do not reuse a legacy WeChat credential. Do not include confidential Codex content in the test task.

## Build validation

1. Open `apps/tokenm-android` in the current stable HBuilderX.
2. Compile all `.uvue` and `.uts` pages for Android VDOM and resolve every compiler error.
3. Confirm the custom base/APK uses the final DCloud AppID, package, release certificate identity, Honor module, Xiaomi-compatible manifest selection, and `POST_NOTIFICATIONS` declaration.
4. Confirm the standard DCloud base is not the vendor acceptance artifact.
5. Install the release-signed APK on the test Honor device.

Evidence: HBuilderX compiler result, artifact identity shown by approved tooling, installation result, app version. Do not capture signing passwords or vendor credentials.

## First-run account and permission path

1. Launch Potato after a clean installation.
2. Register or log in with username/password through official uni-id-co.
3. Confirm the current privacy text/version.
4. Verify no notification prompt appears before the explicit CTA.
5. Tap “开启系统通知” once.
6. Choose Allow in the Android 13+ system dialog.
7. Confirm settings independently report login, current privacy consent, authorized system permission, and ready device registration.
8. Confirm the official user/device association and `tokenm-mobile-devices` business record refer to the authenticated owner without exposing a CID in Potato data.

Expected: one user-driven permission request; later tasks require no per-task approval.

## Desktop pairing and event path

1. Generate a six-digit code in the Android pairing page.
2. Configure Desktop with the approved uniCloud API origin and pair using the Android destination.
3. Verify the pairing page reports the exact session as `paired`.
4. Verify the Desktop credential uses the `tm_uc_d1` namespace and is kept in Desktop private credential storage.
5. Complete one real, non-sensitive Codex task.
6. Observe Desktop creating `evt:<sessionId>:<turnId>` and sending the same explicit event through the Android outbox.
7. Verify the cloud creates one random task and one delivery record.
8. Verify the delivery is claimed once and the provider attempt count is exactly one.
9. Record whether provider status becomes `submitted`, `failed`, or `unknown`; do not relabel `submitted` as delivered.

## Honor notification matrix

Repeat one new non-sensitive task in each device state:

| Device/app state | Required observation |
| --- | --- |
| App foreground | task appears; system presentation behavior recorded; tap route checked if notification is shown |
| App background | system notification appears with fixed title/body; tap opens the matching task |
| Device locked | lock-screen notification follows approved category and user settings; tap/unlock opens matching task |
| App removed from recents | notification still arrives through Honor system channel; tap opens task |
| App process reclaimed by system | notification still arrives; app cold-start routes to task after auth/consent checks |

For every row verify:

- title is exactly `Potato`;
- body is exactly `任务已完成`;
- no task summary, project, model, path, prompt, conversation, credential, or source content appears;
- sound/vibration follow the approved category and the user's current settings;
- tapping opens the task identified by payload `taskId`;
- the authenticated backend returns the correct task and Desktop;
- task persistence remains correct if notification display fails;
- provider/vendor receipts are recorded only at the stages they actually prove.

Android Settings > Force stop is not part of this matrix.

## Negative and recovery cases

- Deny the Android notification permission: the app must display denied, keep registration/display facts separate, and retain tasks.
- Disable Potato task notifications: a new task must persist with `skipped_disabled` and no provider call.
- Disable or invalidate all eligible mobile devices: a new task must persist with `skipped_no_target`.
- Submit the identical Desktop event again: receive `duplicate`, same task ID, and no second provider attempt.
- Reuse an event identity with changed allowed fields: receive `event_conflict`.
- Unbind Desktop: subsequent bearer calls fail and existing tasks remain visible.
- Clear task history: old deep links return to the task list.
- Revoke/update privacy consent version in a controlled test: push runtime stops until the user confirms the current version again.
- Log out: listener stops, the business device is disabled, and protected pages require login.

## Acceptance states

Use only these conclusions:

- `TOKEN_M_ANDROID_CODE_READY_FOR_REAL_DEVICE`: code and local contracts pass, but signed-device/cloud evidence is incomplete.
- `TOKEN_M_ANDROID_P0_E2E_PASS`: every Honor matrix row and end-to-end assertion above has direct evidence.
- Xiaomi P1 is reported separately and requires its approved channel/template plus a real HyperOS observation.

Never infer P0 pass from a successful build, cloud upload, `submitted` provider result, foreground-only observation, or standard-base run.
