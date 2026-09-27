# Potato Android client integration boundary

Verified against official DCloud documentation on 2026-08-23:

- uni-id-co cloud object: https://doc.dcloud.net.cn/uniCloud/uni-id/cloud-object
- uni-id-pages-x prerequisites: https://doc.dcloud.net.cn/uniCloud/uni-id/app-x
- uni-captcha: https://doc.dcloud.net.cn/uniCloud/uni-captcha.html
- uniCloud client API and local session inspection: https://doc.dcloud.net.cn/uni-app-x/api/unicloud/utils.html
- uni-push 2.0 client API: https://doc.dcloud.net.cn/uni-app-x/api/uni-push.html
- Android app authorization state: https://doc.dcloud.net.cn/uni-app-x/api/get-app-authorize-setting.html
- custom Android manifest: https://doc.dcloud.net.cn/uni-app-x/collocation/app-nativeresource-android.html

The client calls only the current official username/password methods: `createCaptcha({ scene })`, `refreshCaptcha({ scene })`, `registerUser({ username, password, captcha })`, `login({ username, password, captcha? })`, `logout()`, `closeAccount()`, and `setPushCid({ pushClientId })`. Registration uses scene `register`; login uses scene `login` only for its optional/risk-triggered captcha. The repository includes the unmodified official `uni-id-pages-x` 1.2.4 module and its declared dependency closure from DCloud's formal `master` branch so HBuilderX can generate the `uni-id-co` client type. Its local schemas and `uni-config-center` defaults are source inputs only; they have not been uploaded or initialized in `tokenm-prod`.

Push initialization is fail-closed. Neither `onPushMessage` nor `getPushClientId` is called until the official local session is current, the server reports the current Potato consent version accepted, and the user has explicitly tapped the notification CTA at least once. The listener is a module-level singleton and is removed with the same callback on logout. The CID is sent only to `uniIdCo.setPushCid`; the Potato business device call contains only enabled state, label, permission state, and push-registration state. `tokenm-co` adds platform, app version, and device identity from trusted `clientInfo` and rejects a CID in its input.

`AndroidManifest.xml` disables framework-level automatic notification permission requests. The notification CTA requests `POST_NOTIFICATIONS` through the HBuilderX 5.24 `UTSAndroid.requestSystemPermission` API before the single-argument `uni.onPushMessage(callback)` registration. Its package keeps Android's built-in `${applicationId}` placeholder. The frozen compiler is HBuilderX 5.24.2026081301. Verify Android 12 and Android 13+ permission flows, deny/don't-ask-again recovery, one listener across foreground/background cycles, CID refresh, cold-start notification clicks, malformed payload fallback, session expiry, consent-version rollover, logout device disablement, and account-close logout failure. No real push was initialized or sent during this phase.
