# Android release Kotlin compatibility

## Scope and baseline

This audit covers only `apps/tokenm-android`, its Alipay uniCloud source, and the official uni-id/uni-push modules that the Android client directly requires. Generated Kotlin under `unpackage/` is evidence only and must never be edited as source.

Baseline state: `TOKEN_M_ANDROID_RELEASE_KOTLIN_TYPE_BLOCKED` at `:app:compileReleaseKotlin` with HBuilderX `5.24.2026081301`, uni-app x, and VDOM. The full cloud diagnostic stream was not saved in the repository or HBuilderX logs, so the exact raw diagnostic count is unavailable and must not be invented. The retained generated Kotlin and the reported cloud diagnostics confirm all twelve root-cause families below. Counts in this document refer to confirmed source sites, not to compiler messages after cascading.

## Initial error manifest

| Family | Generated evidence | Source evidence | Root cause | Source fix |
| --- | --- | --- | --- | --- |
| A. Callback Promise to Unit | `components/tm-header/tm-header.kt:32`; page callback sites across Dashboard, Desktops, Login, Notifications, Onboarding, Pairing, Permission, Privacy, Register, Settings, Task Detail, and Tasks | `tm-header.uvue:30`; four async `showModal.success` callbacks; lifecycle and directly bound async handlers | API, lifecycle, timer, and component callbacks require `Unit`, but expression-bodied navigation or `async` callbacks return `UTSPromise` | Use block-bodied synchronous boundary callbacks which start separately named async functions |
| B. Anonymous defaults | `index.kt:747,883,1127,1310,1449,1727`; Dashboard `:34`, Desktops `:37`, Notifications `:33`, Settings `:35`, Tasks `:49` | `auth-service.uts:38`; `push-runtime.uts:83`; `client-runtime.uts:182`; `presentation.uts:24,120`; `tokenm-service.uts:164-166`; five page load helpers | Kotlin forbids default values on generated anonymous functions | Remove all eleven defaults and pass every argument explicitly |
| C. uni-id generated type/API | `index.kt:706,735-775,939` and no `GenCloudObjUniIdCo.kt` | `services/auth-service.uts:7,25-72`; `services/mobile-device.uts:32` | The project has no official `uni-id-pages-x`/`uni-id-co`, `uni-id-common`, `uni-captcha`, or `uni-config-center` source, so the compiler cannot generate the cloud-object type; downstream method errors are cascading | Import the official modules locally, retain the documented `uni-id-co` methods, and regenerate; never create a fake generated class |
| D. uni-push API | `index.kt:891` | `services/push-runtime.uts:87` | HBuilderX 5.24 local typings define `onPushMessage(callback)` only; `OnPushMessageOptions` does not exist | Remove the second argument; retain typed `getPushClientId(options)` and `offPushMessage(callback)` |
| E. Promise.all inference | `index.kt:1710-1714,1746-1749,1760-1763` | `services/tokenm-service.uts:144-148,176-179,189-192` | Heterogeneous cloud result promises cannot share one inferable Kotlin `Promise.all` element type | Await each small initialization request explicitly and sequentially |
| F. Nullable receivers | Dashboard `index.kt:135-214`; Notifications `index.kt:154-234`; Settings `index.kt:165-263` | Dashboard `index.uvue:104-105`; Notifications `:104-105`; Settings `:74-76` | A template guard does not smart-cast mutable `Ref.value` for Kotlin | Use business-valid, typed non-null initial view models while the existing load state controls skeleton/error/ready rendering |
| G. Lifecycle signature | Login `index.kt:89`; Onboarding `:63`; Pairing `:161`; Register `:99`; Task Detail `:57`; Tasks `:154`, plus five `onShow` sites | Six `onLoad` and five `onShow` callbacks | `onLoad` requires `(OnLoadOptions) -> Unit`; hooks currently omit the argument and/or return `UTSPromise` | Accept `OnLoadOptions` and invoke an async page loader from a synchronous block callback |
| H. Missing arguments | Calls to generated functions in the same files as family B | Single-argument `presentError`, single-argument `formatRelativeTime`, four-argument `listTasks`, and no-argument page loads | JavaScript-style omitted arguments remain after invalid anonymous defaults are rejected | Pass fallback text, `Date.now()`, limit `20`, and explicit booleans at each call |
| I. Typed/value mismatch | `tasks/index.kt:61-67`; `index.kt:991-997,1304,1314`; Pairing `index.kt:62` | Tasks `index.uvue:114-116`; `client-runtime.uts:60-64`; `presentation.uts:19,26`; Pairing `index.uvue:61` | Object literals infer as `UTSJSONObject`; cloud error code is `Any`; Android `Date` construction expects a number, not an ISO string | Construct typed filter items, normalize the error code at the boundary, and parse ISO strings before numeric date construction |
| J. Page Companion to String | Reported for Dashboard, Desktops, and Tasks; not reproduced in the retained local generation | Literal `variant`/`selected` bindings currently lower to string literals | Likely cascading or from a different generated snapshot; no current bare identifier is proven | Regenerate after A-I; only add explicit typed string bindings if the error remains |
| K. `startsWith` receiver | `index.kt:1473` | `services/presentation.uts:123-130` | `UniCloudError.errCode` remains `Any`, so the receiver is not a string | Produce a real string error code before comparison and `startsWith` |
| L. Missing function | Notifications `index.kt:95` calls local value declared at `:118` | `pages/notifications/index.uvue:157,173` | Kotlin local values cannot be referenced before declaration | Move the real navigation function before the async action and keep its behavior |

Additional numeric prop audit: `maxlength` is a numeric input prop but is currently supplied as a static string in Desktops, Login, and Register. Bind numeric values explicitly.

## Official API findings for HBuilderX 5.24

- The official `uni-id-co` API includes `createCaptcha({ scene })`, `refreshCaptcha({ scene })`, `login({ username, password, captcha? })`, `registerUser({ username, password, captcha })`, `logout()`, `closeAccount()`, and `setPushCid({ pushClientId })`.
- `setPushCid` is the official user/device/CID association path. Potato must not write a custom CID field to its user collection.
- HBuilderX 5.24 local uni-push typings define `getPushClientId(options)`, `onPushMessage(callback)`, and `offPushMessage(callback)`. They do not define `OnPushMessageOptions`.
- The current online push documentation exposes a newer optional permission option that is absent from the installed compiler typings. Release compatibility follows the installed compiler.

## Regeneration gates

After each source pass, regenerate with the installed HBuilderX compiler and verify that generated Kotlin contains:

- no anonymous `fun(... = ...)` declarations from application source;
- no `GenCloudObjUniIdCo` reference without its generated class;
- no `OnPushMessageOptions` or two-argument `onPushMessage` call;
- no heterogeneous `UTSPromise.all` call;
- no API/lifecycle callback returning `UTSPromise` where `Unit` is required;
- no nullable view-model receiver in the three audited page render functions.

`appResource` success proves source generation, not `:app:compileReleaseKotlin`. If no official local release Gradle path exists, the terminal status is `TOKEN_M_ANDROID_RELEASE_KOTLIN_FIX_READY_FOR_CLOUD_RETRY`, never `APK_BUILD_PASS`.

## Resolution snapshot — 2026-08-24

All twelve manifest families are closed in the freshly regenerated Kotlin evidence. The original cloud log did not retain an exact diagnostic count, so the initial total remains `unavailable`; the current known manifest regression count is `0`.

| Regression gate | Baseline source/generated sites | Fresh generation |
| --- | ---: | ---: |
| Anonymous callback defaults | 11 | 0 |
| Async lifecycle callbacks returning a promise | 11 | 0 |
| Async modal callbacks returning a promise | 4 | 0 |
| Async timer callbacks returning a promise | 1 | 0 |
| Promise-returning component/event bindings | 58 | 0 |
| Expression-bodied navigation returns | 26 | 0 |
| Heterogeneous `Promise.all` calls | 3 | 0 |
| Missing `GenCloudObjUniIdCo` declaration | 1 | 0 |
| `OnPushMessageOptions` / two-argument registration | 1 | 0 |
| Untyped `DesktopFilterItem` collection construction | 1 | 0 |
| Non-string `startsWith` receiver | 1 | 0 |
| `goPermission` use before declaration | 1 | 0 |

The local official dependency set was copied from DCloud's `hello-uni-id-pages-x` repository at commit `c5b6ec591ba6ab6e10c76c8ec21f2199c3148fa4`. It includes `uni-id-pages-x` 1.2.4, `uni-id-co` 1.1.22, and the directly required official modules. This was a local source installation only: no cloud object, database schema, or production resource was uploaded.

The installed HBuilderX command-line compiler reported:

```text
compiler: 5.24 (uni-app x)
renderer: VDOM
project compile: PASS
Android appResource export: PASS
```

Fresh output contains 22 Kotlin files in each generated tree. The build and resource trees have identical relative names and identical content. The real generated cloud-object classes now include `GenCloudObjUniIdCo`, `GenCloudObjUniCaptchaCo`, and `GenCloudObjTokenmCo`.

The generated audit also confirms explicit `OnLoadOptions` parameters, `Unit` lifecycle/modal/timer boundaries, one-argument `uni_onPushMessage`, sequential initialization awaits, non-null typed page view models, numeric `maxlength` props, a real `UTSArray<DesktopFilterItem>`, string literal page props, a string error-code receiver, and numeric date construction.

Local validation:

- Android client/presentation: 24/24 passed.
- Backend-independent Android: 36/36 passed.
- Android/Desktop integration: 13/13 passed.
- Full Android suite: 68/71 passed. The remaining three assertions require an empty AppID or enabled Honor/Xiaomi SDKs and therefore contradict the frozen release identity and vendor settings; they are not Kotlin compiler failures.
- Repository lint: passed.
- `git diff --check`: passed at handoff.

No official local Gradle project exposes `:app:compileReleaseKotlin`, so release Kotlin compilation is `NOT_AVAILABLE_LOCALLY`. No Android cloud build was run. The handoff state is therefore `TOKEN_M_ANDROID_RELEASE_KOTLIN_FIX_READY_FOR_CLOUD_RETRY`, not `APK_BUILD_PASS`.
