# Honor vendor-channel setup

## Code state

Potato explicitly selects the Honor offline SDK in the uni-app x manifest:

```json
{
  "app-android": {
    "distribute": {
      "modules": {
        "uni-push": {
          "honor": {}
        }
      }
    }
  }
}
```

For the standard HBuilderX cloud-build path, this module selection is the dependency declaration. DCloud's build service supplies the compatible uni-push, Getui Honor adapter, and Honor SDK dependencies. Potato does not carry a parallel Gradle project or pin direct vendor SDK versions. If the project is later exported as a native Android project, use the dependency versions documented for that exact DCloud native SDK release; the direct Honor SDK release number alone is not a compatibility decision.

The Android manifest declares notification permission and disables framework auto-request. The app initializes `DcloudChannelID` only through the already consent-gated push runtime, with default importance, system sound, vibration enabled, and public lock-screen visibility. Android and MagicOS user settings remain authoritative.

The server adds the current Getui/DCloud Honor classification mapping:

```js
options: {
  android: {
    HO: { '/android/notification/importance': 'NORMAL' }
  }
}
```

This value means service-and-communications to Honor. Potato uses it for a user-enabled notification that the user's own Desktop task completed. It must not be treated as an approved classification until the Honor self-classification application is accepted. No top-level uni-push `category` is set for Honor because the current DCloud contract lists that field only for HarmonyOS, Huawei, and vivo.

## MANUAL_PREREQUISITE — identity and signing

Before any Honor-capable build or provider test, the owner must complete all of the following with one immutable release identity:

1. Choose the final Android package name.
2. Create or select the release JKS and preserve it outside the repository.
3. Record the release key alias and passwords outside the repository.
4. Obtain the release certificate fingerprint in the format required by Honor.
5. Create the real DCloud AppID and register the same package name and release signature in DCloud application settings.
6. Put the real DCloud AppID into `manifest.json` through HBuilderX; do not invent or copy another application's value.

Debug and release certificates are different identities. A package signed with an unregistered certificate is not a valid Honor verification artifact.

## MANUAL_PREREQUISITE — Honor developer console

In Honor Developer Services:

1. Complete developer verification.
2. Apply for Push Service as a mobile application using the final application name, package name, and release certificate fingerprint.
3. Accept the Honor APIs agreement, Push Service agreement, and data-processing addendum.
4. Obtain the application's Honor App ID, App Secret, Client ID, and Client Secret. Never put any of them in this repository, logs, screenshots, or test output.
5. Apply for self-classification rights under Push Service > Other rights. Honor currently states a review window of up to 15 business days.
6. Confirm that Potato task-completion messages are accepted as the service-reminder scenario before enabling real sends with `NORMAL`.
7. For complete vendor delivery statistics, configure the Honor receipt endpoint documented by DCloud/Getui: `https://thirdrcp-hz.getui.com/ho`.

The current Honor application form does not list app-store publication as a Push Service prerequisite. This supports preparing a signed sideload test, but only a real signed-device run can establish whether the registered application is accepted end to end.

## MANUAL_PREREQUISITE — DCloud uni-push console

Only the DCloud application owner can operate the uni-push configuration. In DCloud Developer Center:

1. Open uni-push 2.0 for the real DCloud AppID.
2. Register the exact Android package name and DCloud-required release signature value.
3. Under vendor push settings, enter the Honor App ID, Client ID, and Client Secret issued for that same application. The current DCloud guide does not ask for Honor App Secret in this form; keep it private unless the current console explicitly requires it.
4. Bind the same DCloud application and the支付宝 uniCloud service space used by Potato.
5. Build a custom signed base or signed APK. The standard base uses DCloud's package and certificate and cannot validate the application's real vendor push identity.

No vendor value is represented by the empty `honor: {}` manifest node. That node selects the SDK only; credentials remain in the provider consoles.

## Real-device acceptance

Provider `submitted` is not an Honor delivery result. The P0 gate requires a release-signed installation on a supported Honor/MagicOS device and separate checks while the app is foregrounded, backgrounded, removed from recents, process-reclaimed, and locked. For each check, verify notification appearance, sound/vibration subject to user settings, tap-to-task routing, stored task availability, and the provider/vendor receipt data where available.

Do not include Android Settings > Force stop in the pass criterion. Do not declare Honor background Push passed before these device observations exist.

Official references checked on 2026-08-23:

- https://doc.dcloud.net.cn/uni-app-x/collocation/manifest-android.html
- https://doc.dcloud.net.cn/uni-app-x/uni-push/vendor_config.html
- https://doc.dcloud.net.cn/uniCloud/uni-cloud-push/options.html
- https://doc.dcloud.net.cn/uni-app-x/api/uni-push.html
- https://developer.honor.com/cn/docs/11002/guides/app-registration
- https://developer.honor.com/cn/docs/11002/guides/notification-class
- https://developer.honor.com/cn/docs/11002/guides/configuration-content
- https://developer.honor.com/cn/docs/11002/guides/sdk-base-api
- https://developer.honor.com/cn/docs/11002/guides/kit-history
