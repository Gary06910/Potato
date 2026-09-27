# Potato 1.0.0

## Potato first independently maintained release

Potato 1.0.0 is the first release prepared under Potato's independent maintenance and release ownership. Potato is derived in part from Javis603/token-monitor; the applicable upstream MIT attribution and license notices are retained. The current Desktop architecture has been modernized from that upstream baseline, and future upstream changes will be selectively adopted rather than synchronized automatically.

## What's included

- An independent Desktop project and release channel owned by `Gary06910/Potato`; the updater feed and release metadata do not use the upstream `Javis603/token-monitor` binary or release channel.
- A contemporary collector, provider and UI foundation, including the pinned Tokscale `4.17.0` integration.
- Android notification delivery through `Desktop → uniCloud → uni-push 2.0 → Android`, including pairing, task synchronization and system notifications.
- Codex Stop Hook integration for forwarding completed tasks to the paired Android device.
- Privacy mode and full mode for controlling which task details leave the Desktop.
- A durable Android outbox with stable event identity for restart recovery and duplicate-safe delivery.
- Android task management for reviewing, acknowledging and clearing synchronized tasks.
- Background-notification guidance for Android. Honor and Xiaomi vendor Push paths are not enabled in this release; background delivery still depends on the user's device settings, and a Recents swipe-away is not guaranteed to preserve delivery.
- Windows Codex profile/HOME compatibility and preservation of the established Token Monitor data location under `%APPDATA%\Token Monitor`.
- Existing settings, credentials, usage history, Android pairing data, outbox data and Stop Hook configuration remain on their established paths. A source-to-installed path transition may require enabling and trusting the Hook for the installed executable.
- WeChat integration remains legacy/frozen and is not the primary notification path; Android is the primary path for current Potato notification work.

## What's Changed

<!-- github-generated-release-notes -->

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Gary06910/Potato/compare/v0.58.0...v1.0.0">v0.58.0...v1.0.0</a></summary>
</details>

The compare range starts at the retained upstream-baseline tag; it is not a prior public Potato release.

## Downloads

- Windows installer: `Potato-Setup-1.0.0.exe`
- Windows portable: `Potato-1.0.0.exe`
- Official desktop binary distribution: Windows x64 only.
- Android is a separate Potato mobile client and is not part of the Desktop GitHub Release workflow.
- macOS/Linux source and build support may exist, but official macOS/Linux binaries are not provided in 1.0.0.
- Code signing policy: [Potato Code Signing Policy](../docs/CODE_SIGNING_POLICY.md) (planned/intended; SignPath Foundation approval is pending).

<!-- app-update-notes:zh:start -->
### Potato 首个独立维护版本
- 1.0.0 使用 Potato 自有发布与更新源，并保留适用的上游 MIT 许可与署名。
- 桌面端包含 Tokscale 4.17.0、Codex Stop Hook、隐私/完整模式，以及稳定事件身份和持久 outbox。

### Android 通知与升级兼容
- 通知链路为 Desktop → uniCloud → uni-push 2.0 → Android，保留已有配对、设置、历史、凭据和 Stop Hook 数据路径。
- Android 是当前主路径；Honor/Xiaomi 厂商 Push 未启用，后台通知仍需按设备指引配置，划掉最近任务不保证持续送达。
<!-- app-update-notes:zh:end -->

<!-- app-update-notes:en:start -->
### Independent release and compatibility
- 1.0.0 uses the Potato release and update source while retaining applicable upstream MIT attribution.
- The Desktop keeps existing settings, credentials, usage history, Android pairing/outbox data and Stop Hook paths.

### Desktop, Android and delivery
- Includes Tokscale 4.17.0, Codex Stop Hook, privacy/full mode, stable event identity and a durable outbox.
- Android is the primary notification path. Honor/Xiaomi vendor Push is not enabled, and background delivery still follows the device guidance.
<!-- app-update-notes:en:end -->

<!-- app-update-notes:zh-TW:start -->
### Potato 首個獨立維護版本
- 1.0.0 使用 Potato 自有發佈與更新來源，並保留適用的上游 MIT 授權與署名。
- 桌面端包含 Tokscale 4.17.0、Codex Stop Hook、隱私/完整模式，以及穩定事件識別與持久 outbox。

### Android 通知與升級相容性
- 通知鏈路為 Desktop → uniCloud → uni-push 2.0 → Android，保留既有配對、設定、歷史、憑證與 Stop Hook 資料路徑。
- Android 是目前主要路徑；Honor/Xiaomi 廠商 Push 未啟用，背景通知仍需依裝置指引設定。
<!-- app-update-notes:zh-TW:end -->

<!-- app-update-notes:ko:start -->
### Potato 최초 독립 유지보수 릴리스
- 1.0.0은 Potato의 자체 릴리스 및 업데이트 소스를 사용하며 해당 업스트림 MIT 라이선스와 저작자 표시를 유지합니다.
- Tokscale 4.17.0, Codex Stop Hook, 개인정보 보호/전체 모드, 안정적인 이벤트 식별자와 영속 outbox를 포함합니다.

### Android 알림 및 호환성
- 알림 경로는 Desktop → uniCloud → uni-push 2.0 → Android이며 기존 페어링, 설정, 기록, 자격 증명 및 Stop Hook 경로를 유지합니다.
- Android가 현재 기본 경로입니다. Honor/Xiaomi 제조사 Push는 활성화되지 않았으며 백그라운드 알림은 기기 안내에 따릅니다.
<!-- app-update-notes:ko:end -->

<!-- app-update-notes:ja:start -->
### Potato 初の独立メンテナンスリリース
- 1.0.0 は Potato 独自のリリースおよび更新ソースを使用し、適用される upstream MIT ライセンスと帰属表示を保持します。
- Tokscale 4.17.0、Codex Stop Hook、プライバシー/フルモード、安定したイベント識別子、永続 outbox を含みます。

### Android 通知と互換性
- 通知経路は Desktop → uniCloud → uni-push 2.0 → Android で、既存のペアリング、設定、履歴、資格情報、Stop Hook のパスを保持します。
- 現在の主経路は Android です。Honor/Xiaomi のベンダー Push は有効化されておらず、バックグラウンド通知は端末の案内に従います。
<!-- app-update-notes:ja:end -->

Manual upgrade: choose the Windows installer and the existing install directory. Do not delete `%APPDATA%\Token Monitor`. Code signing and the real installed-version upgrade remain local acceptance gates. After moving from a source launch to an installed app, enable the Codex Hook in the installed app and confirm trust in Codex.

Based in part on Javis603/token-monitor under MIT. See the included LICENSE and retain the applicable upstream attribution.
