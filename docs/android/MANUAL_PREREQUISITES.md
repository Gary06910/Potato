# TOKEN_M_ANDROID_MANUAL_ACTION_REQUIRED

## Gate result — 2026-08-23

The repository is code-ready for the real-device preparation stage, but the APK and Honor P0 E2E gates are not open.

Local evidence collected from this workspace:

| Gate item | Current evidence | Status |
| --- | --- | --- |
| DCloud AppID | `apps/tokenm-android/manifest.json` has an empty `appid` | REQUIRED |
| Final Android package | no final package identity is recorded in the project/build configuration | REQUIRED |
| Release signing | no JKS/keystore/APK/AAB is present in the Android project; an external release key was not available for verification | REQUIRED |
| HBuilderX | command and common installation paths are absent | REQUIRED |
| HBuilderX login | cannot be verified without HBuilderX | REQUIRED |
| Android device tooling | `adb` is absent; no connected phone can be verified | REQUIRED |
|支付宝 cloud binding | `uniCloud-alipay` contains source folders only; no verified HBuilderX association was available | REQUIRED |
| Target space | user-specified `tokenm-prod`, SpaceID `env-00jy6pbiul92`; no operation was performed | NOT TOUCHED |
| Cloud environment | required Potato values are absent from the current process | REQUIRED |
| uni-push 2.0 | owner enablement and service-space binding cannot be verified | REQUIRED |
| Honor application/Push | developer verification, registered application, credentials, and category approval cannot be verified | REQUIRED |
| Xiaomi P1 | application, credentials, channel, and fixed template cannot be verified | OPTIONAL FOR HONOR P0; REQUIRED FOR XIAOMI P1 |
| Local verification | Node 24.15.0, npm 11.12.1; full unit/integration regression and lint pass | PASS |

No cloud deployment, database initialization, provider send, signed build, store upload, or production cutover has occurred.

## Actions for the application owner

Complete these in order. Do not paste any credential, password, signing file, or environment value into chat, source control, documentation, screenshots, or logs.

### 1. Install and sign in to HBuilderX

Platform: DCloud/HBuilderX.

1. Install the current stable HBuilderX with uni-app x and uniCloud support.
2. Sign in using the DCloud account that owns the intended application. uni-push configuration currently requires the application owner; collaborator access is insufficient.
3. Open `apps/tokenm-android` as the uni-app x project and confirm HBuilderX recognizes the `uni-app-x` manifest node.

After completion, Codex can run source compilation/build validation from the configured environment and inspect compiler output.

### 2. Freeze application identity

Platforms: DCloud Developer Center and HBuilderX cloud-build dialog.

1. Create or select the real Potato DCloud application.
2. Put its assigned DCloud AppID into `apps/tokenm-android/manifest.json` through HBuilderX.
3. Choose the final reverse-domain Android package name and register the same package in DCloud, Honor, and later Xiaomi.
4. Do not reuse the package or DCloud AppID of an unrelated application.

After completion, Codex can verify that manifest, provider environment, console notes, and build identity all refer to the same application.

### 3. Prepare release signing outside the repository

Platforms: secure local storage and HBuilderX cloud build.

1. Create or select the release JKS.
2. Preserve the file, key alias, store password, and key password in a secure location outside the repository.
3. Obtain the release certificate identity/fingerprint formats required by DCloud and Honor.
4. Enter the JKS path and signing values directly into HBuilderX when producing the custom base/APK.

After completion, Codex needs only confirmation that the identity matches the vendor registrations. Do not provide the private key or passwords.

### 4. Bind支付宝云 and install official modules

Platform: HBuilderX and uniCloud web console.

1. Right-click `apps/tokenm-android/uniCloud-alipay` and choose the current “关联云服务空间或项目” action.
2. Select `tokenm-prod` / `env-00jy6pbiul92` only if you intend to bind this production target.
3. Import/configure the current official `uni-id-co`, `uni-id-common`, captcha dependencies, and their required official collections/config.
4. Add the official `uni-cloud-push` common extension dependency to `tokenm-desktop-http`.
5. Do not upload functions, schemas, or indexes until you explicitly authorize deployment.

After completion, Codex can validate the resolved project/module structure and, with separate explicit authorization, prepare the exact upload sequence.

### 5. Configure cloud-owned values

Platform: uniCloud cloud-function environment/secret configuration.

Configure without exposing values:

- `TOKEN_M_DESKTOP_CREDENTIAL_KEY`: one canonical 43-character base64url value representing exactly 32 random bytes; the same value must be available to both Potato function runtimes that read encrypted Desktop credentials.
- `TOKEN_M_DCLOUD_APP_ID`: the real `__UNI__...` value matching `manifest.json`.
- `TOKEN_M_XIAOMI_CHANNEL_ID` and `TOKEN_M_XIAOMI_TEMPLATE_ID`: configure together only after Xiaomi approval; omit both for the Honor-only P0 gate.

Do not rotate the Desktop credential key after real pairings unless a separately designed migration is approved; changing it makes existing encrypted Desktop credentials unreadable.

After completion, Codex can verify presence and shape through boolean/configuration checks without displaying values.

### 6. Enable uni-push 2.0

Platform: DCloud Developer Center.

1. As application owner, enable uni-push 2.0 for the real DCloud AppID.
2. Bind it to the same支付宝 service space used by the project.
3. Register the final Android package and release certificate identity.
4. Configure the Honor vendor fields issued for that same application.
5. Confirm no standard-base identity is being used for the vendor acceptance run.

After completion, Codex can perform provider contract validation in the approved cloud environment; provider acceptance will still not prove phone display.

### 7. Complete Honor P0 prerequisites

Platform: Honor Developer Services and DCloud vendor settings.

Complete every item in `HONOR_SETUP.md`, including developer verification, application registration, Push Service agreements, application credentials, self-classification approval for the real task-completion scenario, and the documented receipt endpoint. Enter credentials only into the official consoles.

After completion, Codex can build the signed artifact and execute the Honor matrix in `E2E_TEST_PLAN.md`.

### 8. Provide a real Honor test device

Platform: physical Android/Honor phone and Windows development machine.

1. Connect a supported Honor/MagicOS phone by USB and enable the device settings required for local signed-APK installation and debugging.
2. Install working Android platform tools or make the device available through HBuilderX.
3. Confirm the test account can log in and that mobile network/Wi-Fi access to the approved cloud endpoint is available.

After completion, Codex can run foreground/background/locked/process-reclaimed observations. Android Settings > Force stop is excluded.

### 9. Explicitly authorize each external action

Before Codex performs it, separately authorize:

- binding to `tokenm-prod` if not already bound;
- uploading cloud functions/objects/common modules;
- initializing custom schemas/indexes;
- creating test records in the target space;
- sending the first real uni-push notification;
- building/signing an APK with the release identity.

Production Desktop destination cutover requires a later explicit approval after Honor P0 E2E passes.

Official references checked on 2026-08-23:

- https://doc.dcloud.net.cn/uni-app-x/tutorial/app-package.html
- https://doc.dcloud.net.cn/uni-app-x/project
- https://doc.dcloud.net.cn/uniCloud/concepts/space
- https://doc.dcloud.net.cn/uni-app-x/uni-push/open.html
- https://developer.android.com/develop/ui/compose/notifications/notification-permission
