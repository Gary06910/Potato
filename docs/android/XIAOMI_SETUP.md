# Xiaomi and HyperOS vendor-channel setup

## Code state

Potato selects Xiaomi alongside the frozen Honor P0 path in the uni-app x manifest:

```json
{
  "app-android": {
    "distribute": {
      "modules": {
        "uni-push": {
          "honor": {},
          "xiaomi": {}
        }
      }
    }
  }
}
```

For the standard HBuilderX cloud-build path, DCloud owns the compatible uni-push, Getui Xiaomi adapter, and MiPush SDK dependency set. Potato does not carry a parallel Gradle project or independently pin a MiPush SDK version.

The server's Xiaomi provider mapping is deployment-owned and conditional:

```js
XM: {
  '/extra.channel_id': process.env.TOKEN_M_XIAOMI_CHANNEL_ID,
  '/extra.template_id': process.env.TOKEN_M_XIAOMI_TEMPLATE_ID
}
```

The `XM` object is emitted only when both values are present. Missing or incomplete configuration leaves it absent, preserves the Honor request mapping, and does not invent a Xiaomi category. Do not enable the Xiaomi vendor configuration in DCloud until the real pair is approved and ready.

## Message-category plan

As of 2026-08-23, Xiaomi's rules effective from 2026-08-01 require newly integrated private messages to use both an approved channel and a template. Potato should apply under the private-message category `任务进程`, subject to Xiaomi's decision:

- Trigger: the same user has initiated a real Codex work task on a paired Desktop.
- State change: the accepted event reports that assigned task's completion.
- Notification title: fixed `Potato`.
- Notification body: fixed `任务已完成`.
- Destination: the stored task record for that same authenticated owner.
- Exclusions: no marketing, recommendation, engagement prompt, inferred task, test text, task summary, project name, model name, or conversation content.

Do not apply as `安装/卸载任务进程`; Potato is reporting an AI work-task completion, not an application installation, removal, or update. `任务进程` is only a candidate until approved. If Xiaomi rejects this mapping, keep Xiaomi P1 disabled and revise the product/category plan before another application; do not route the same content through a public category or another private category.

Use a custom fixed-text private template matching the two strings above. Xiaomi supports fixed text in both title and content structures. Because this template has no variables, Potato omits `/extra.template_param`; it never sends task data as a template variable. If the console requires a different structure, stop and update the reviewed server contract before configuring production IDs.

## MANUAL_PREREQUISITE — application identity

Before enabling Xiaomi push, the owner must establish one final Android identity:

1. Choose the final package name.
2. Create or select the release JKS and retain it outside the repository.
3. Preserve the release key alias and passwords outside the repository.
4. Create the matching real DCloud application and place its real AppID into `manifest.json` through HBuilderX.
5. Produce a custom release-signed base or APK. A DCloud standard base does not carry Potato's final package and signing identity and is not an end-to-end vendor verification artifact.

Do not put signing material or any real vendor credential in this repository, source maps, logs, screenshots, test fixtures, or phase reports.

## MANUAL_PREREQUISITE — Xiaomi push console

Using the final package identity in the Xiaomi Push operations platform:

1. Complete Xiaomi developer-account registration and review.
2. Create or select the Potato Android application with the final application name and package name.
3. Read and accept the message-classification rules, Push Service agreement, privacy policy, and data-protection terms shown by the current console.
4. Enable Push Service. Xiaomi currently states that developer-account review generally takes 1–3 business days and an initial notification-category review takes 3–5 business days.
5. Apply for a private `任务进程` notification category using the exact scenario and content boundaries above.
6. After the channel is approved, record its channel ID outside the repository.
7. In Template Management, apply for a custom fixed-text template bound to that category. Record the approved template ID outside the repository.
8. Obtain the application's Xiaomi AppID, AppKey, and AppSecret. Treat all three as deployment credentials and never commit them.

Xiaomi's current console can also expose official templates. Use one only if its approved title and content structure exactly preserve Potato's fixed private notification. Otherwise use the reviewed custom template.

## MANUAL_PREREQUISITE — DCloud and cloud function

Only after the Xiaomi channel and template are approved:

1. Enable uni-push 2.0 for the real DCloud application.
2. In DCloud's Xiaomi vendor settings, enter the AppID, AppKey, and AppSecret issued for the same package.
3. Keep the支付宝 uniCloud service space bound to that same DCloud application.
4. Configure `TOKEN_M_XIAOMI_CHANNEL_ID` and `TOKEN_M_XIAOMI_TEMPLATE_ID` together on `tokenm-desktop-http`.
5. Confirm `TOKEN_M_DCLOUD_APP_ID` and the official `uni-cloud-push` extension dependency remain configured.
6. Build and install a custom release-signed artifact containing the Xiaomi module.

No real ID belongs in the empty `xiaomi: {}` manifest node. That node selects the vendor module only. A single configured function variable is intentionally ignored by the adapter; treat that state as an incomplete deployment and correct it before any provider test.

## HyperOS background acceptance

Xiaomi documents notification-bar messages as using a system channel that does not require the application to remain resident in the background. This is a platform capability, not a Potato acceptance result. Provider `submitted` likewise means only that uni-push accepted the request.

The Xiaomi P1 gate requires observations from a release-signed installation on a current HyperOS device while the app is foregrounded, backgrounded, removed from recents, process-reclaimed, and locked. For every state verify:

- the fixed title and body are displayed;
- sound and vibration follow the approved private channel and the user's system settings;
- tapping opens the correct stored task without exposing task details in the notification;
- the task remains available even if notification submission or display fails;
- DCloud/Getui and Xiaomi diagnostics agree as far as their receipt stages permit.

Do not include Android Settings > Force stop as a pass condition. Do not declare Xiaomi/HyperOS background Push passed before these signed-device observations and the approved channel/template pair exist.

Official references checked on 2026-08-23:

- https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2322
- https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2321
- https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2314
- https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1542
- https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1533
- https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1657
- https://docs.getui.com/getui/server/rest_v2/third_party/
- https://doc.dcloud.net.cn/uni-app-x/collocation/manifest-android.html
- https://doc.dcloud.net.cn/uni-app-x/uni-push/vendor_config.html
