<p align="right"><a href="README.md">English</a> | <strong>简体中文</strong></p>

<p align="center"><img src="assets/icon.png" width="88" alt="Potato 标志"></p>
<h1 align="center">Potato</h1>
<p align="center">把 AI 编程工具的 Token、额度、费用和任务完成通知，集中到一个地方。</p>
<p align="center"><a href="#download"><strong>下载</strong></a> · <a href="#features">功能一览</a> · <a href="#android-companion">Android 配套应用</a></p>
<p align="center">
  <a href="https://github.com/Gary06910/Potato/releases"><img src="https://img.shields.io/github/v/release/Gary06910/Potato?include_prereleases&amp;style=flat-square&amp;label=preview&amp;color=56866b" alt="Potato 最新预览版"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-56866b?style=flat-square" alt="MIT 许可证"></a>
</p>
<p align="center">Windows x64 · macOS Apple Silicon · Android · Linux Server Agent</p>

<a id="download"></a>
## 下载

[前往 GitHub Releases 下载最新预览版。](https://github.com/Gary06910/Potato/releases) 按设备选择对应文件：

| 平台 | 下载文件 | 适合用途 |
| --- | --- | --- |
| **Windows x64** | [安装版](https://github.com/Gary06910/Potato/releases) · `Potato-Setup-1.0.0.exe` | 日常桌面使用，推荐选择 |
| **Windows x64** | [便携版](https://github.com/Gary06910/Potato/releases) · `Potato-1.0.0.exe` | 无需安装，直接运行 |
| **macOS Apple Silicon** | [DMG](https://github.com/Gary06910/Potato/releases) · `Potato-1.0.0-arm64.dmg` | M 系列 Mac（arm64） |
| **Android** | [手机配套应用](https://github.com/Gary06910/Potato/releases) · `Potato-Android-0.1.1-code6.apk` | 接收任务通知，查看任务记录 |
| **Linux x64** | [Server Agent](https://github.com/Gary06910/Potato/releases) · `To-Know-Agent-1.0.0-linux-x64.tar.gz` | 服务器无界面采集；提供命令行工具，不含桌面 GUI |

发布页附有 SHA256 校验文件。本预览版的 macOS 下载仅适用于 Apple Silicon。

<p align="center"><img src=".github/assets/readme/hero-dashboard.png" width="360" alt="macOS 上的 Potato 首页，展示实时 Token、估算费用、Codex 额度、模型用量和活动热力图"></p>
<p align="center"><sub>今日用量、剩余额度和近期活动，一眼就能看到。</sub></p>

## Potato 能做什么

- **随时掌握用量。** 编程时实时查看 Token 消耗和估算费用。
- **提前了解额度。** 集中查看支持的提供方与账号的额度窗口、剩余额度和重置时间。
- **看懂使用习惯。** 按工具、模型、会话或项目查看明细，通过热力图和历史趋势回顾使用情况。
- **放心离开电脑。** 配对 Android 后，接收 Codex 任务完成通知，随时查看任务记录。
- **连接多台设备。** 单机直接使用；需要汇总多台电脑时，再开启同步。

## 三步开始使用

1. **安装 Potato。** Windows 推荐运行 `Potato-Setup-1.0.0.exe`，便携版 `Potato-1.0.0.exe` 可直接启动。macOS 下载 `Potato-1.0.0-arm64.dmg`，打开后将 Potato 拖入“**应用程序**”，再启动 Potato。
2. **打开应用。** Potato 会自动采集支持的本地 AI 工具日志。单机使用以本地采集为主，无需配置 hub。
3. **按需配置。** 在“AI 工具额度”中添加提供方账号、[配对 Android 手机](#android-companion)，或开启[多设备同步](#multi-device)。

如果 macOS 首次启动时拦截 Potato，前往“**系统设置 → 隐私与安全性 → 仍要打开**”。

<a id="android-companion"></a>
## 离开电脑，也能知道任务什么时候完成

Potato Desktop 会通过你配置的 Potato 服务，将 Codex 任务完成记录发送到 Android 配套应用。手机收到通知后，还能在任务列表中回看记录。桌面端重启后，配对关系会保留。

1. 在手机上安装 `Potato-Android-0.1.1-code6.apk`，打开 Potato，登录并允许通知。
2. 打开 Android 配对页面，获取**六位配对码**。在桌面端“**设置 → 手机通知**”中填入与 Android 应用一致的 Potato 服务地址，输入配对码并连接。
3. 开启“**Codex 完成通知**”。首次使用时，在 Codex 中输入 `/hooks` 并信任 **Potato Stop Hook**。保持 Potato Desktop 运行，即可发送完成记录。

默认开启隐私模式，仅同步完成记录，不上传任务正文。可按应用内的后台保护指引配置手机，让应用在后台也能接收通知。

<a id="features"></a>
## 看看实际界面

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <strong>Token 都用在哪里</strong><br><br>
      <img src=".github/assets/readme/usage-breakdown.png" width="310" alt="按工具展示 Token 总量和估算费用，并展开 Claude Code 的输入、输出及缓存命中明细"><br>
      <sub>比较各工具用量，展开查看输入、输出和缓存。</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <strong>每个模型花了多少</strong><br><br>
      <img src=".github/assets/readme/model-breakdown.png" width="310" alt="按模型展示 Token 总量、估算费用和展开的缓存用量"><br>
      <sub>跨工具汇总模型用量与费用。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <strong>回顾一段时间的活动</strong><br><br>
      <img src=".github/assets/readme/activity-dashboard.png" width="460" alt="用量看板展示活动热力图、连续使用天数，以及工具和模型对比"><br>
      <sub>查看活跃日期、连续使用天数与主要工具。</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <strong>发现用量变化</strong><br><br>
      <img src=".github/assets/readme/trends.png" width="460" alt="按 AI 编程工具堆叠的每日用量柱状趋势图"><br>
      <sub>选择时间范围，按工具或模型比较每日趋势。</sub>
    </td>
  </tr>
</table>

**融入日常工作。** 在 macOS 菜单栏或 Windows 系统托盘查看用量，也可以使用悬浮小窗，调整主题、配色、字体和窗口外观。支持跟踪多个提供方账号，并将已保存的 Codex 账号切换为当前使用账号。

<details>
<summary>更多查看与自定义方式</summary>

- **会话与项目：** 查看支持的本地会话明细，或按项目归类用量；会话详情保留在本机。
- **时间与币种：** 支持今日、本月、累计、本周、最近 7 天和最近 30 天；费用可显示为 USD、TWD、HKD 或 CNY。
- **历史与导出：** 来源会话删除后仍可保留已观测到的每日用量，支持手动或自动导出 CSV + JSON。参见[导出指南](docs/export.md)。
- **自己安排界面：** 显示、隐藏、置顶和排序工具及首页模块，自定义菜单栏与悬浮小窗布局，以及显示／隐藏快捷键。
- **可选功能：** 实时 Token 速率、服务状态、第三方 Codex 额度重置预测、订阅记录和 Discord Rich Presence。
- **WSL（Windows）：** 自动识别运行中发行版的用量；SQLite 数据源可能需要[在 WSL 内运行采集代理](docs/wsl-sqlite-setup.md)。

设置中的 AI 工具额度（提供方选择、额度与凭据）集中管理额度查询。采集、外观、账号与同步选项见[配置参考](docs/configuration.md)。

</details>

## 支持的 AI 工具

Potato 覆盖 **37 项工具与提供方集成**，其中 **30 项**支持 Token 用量，**24 项**支持 AI 工具额度，两者存在重叠。包括 Claude Code、Codex、Cursor、GitHub Copilot、OpenCode 等。下表分别列出用量、额度和会话明细支持情况。

<details>
<summary>展开完整工具支持矩阵</summary>

| 图标 | 工具 | 数据路径 | Token 用量 | AI 工具额度 | 会话明细 |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`、`~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/`（`sessions/`、`archived_sessions/`） | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/`（`opencode*.db`、`storage/message/`） | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor IDE / Cursor CLI | `~/.config/tokscale/cursor-cache/`（账号层级用量导出） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.gemini/`（`antigravity/`、`antigravity-ide/`、`antigravity-backup/`、`antigravity-cli/conversations/`） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks（`.../saoudrizwan.claude-dev/tasks/`）、`~/.cline/data/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/amp.png" width="28" alt="Amp" /> | Amp | `~/.local/share/amp/threads/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/droid.png" width="28" alt="Factory Droid" /> | Factory Droid | `~/.factory/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code / Kimi Work | `~/.kimi/sessions/`、`~/.kimi-code/sessions/`、`<platform-app-data>/kimi-desktop/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `~/.grok/`（`sessions/`、`logs/unified.jsonl`） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`、`~/.copilot/`（`otel/`、`data.db`） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi / Oh My Pi | `~/.pi/agent/sessions/`、`~/.omp/agent/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kilo.png" width="28" alt="Kilo" /> | Kilo | `~/.local/share/kilo/kilo.db`；VS Code globalStorage tasks（`.../kilocode.kilo-code/tasks/`）—— 扩展记录仅限 Linux 与远程/WSL | ✅ | — | — |
| <img src=".github/assets/tools-icon/commandcode.png" width="28" alt="Command Code" /> | Command Code | `~/.commandcode/projects/**/*.jsonl` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/`（`projects/`、`cli/db/db.sqlite`） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`、Kiro IDE globalStorage 与 `kiro-cli` 数据库 | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` 与 IDE / VS Code 扩展日志 | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`、`~/.workbuddy/workbuddy.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder | `<platform-app-data>/QoderCN/SharedClientCache/cache/db/local.db`（仅限中国版） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/reasonix.png" width="28" alt="Reasonix" /> | Reasonix | `~/.reasonix/`（`stats/`、`sessions/`、`projects/*/sessions/`） | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek / DeepSeek Harness | `~/.dsh/sessions/`（`session.jsonl`、`session.jsonl.zstd`） | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/cherrystudio.png" width="28" alt="Cherry Studio" /> | Cherry Studio | `<platform-app-data>/CherryStudio/`（`Data/Agents/.claude/projects/` V2、`.claude/projects/` legacy） | ✅ | — | — |
| <img src=".github/assets/tools-icon/lmstudio.png" width="28" alt="LM Studio" /> | LM Studio | `~/.lmstudio/server-logs/**/*.log` | ✅ | — | — |
| <img src=".github/assets/tools-icon/unsloth.png" width="28" alt="Unsloth" /> | Unsloth Studio | `~/.unsloth/studio/studio.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openrouter.png" width="28" alt="OpenRouter" /> | OpenRouter | OpenRouter API 密钥（查询用量／密钥上限；获授权访问 credits 时显示余额，官方文档指定 Management 密钥） | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API 密钥（通过 Minimax API 查询 Token Plan 额度） | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key 或火山引擎 AK/SK（通过火山引擎 API 查询火山方舟 Coding Plan / Agent Plan 额度） | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie（通过 ollama.com/settings 查询 session／每周用量） | — | ✅ | — |
| <img src=".github/assets/tools-icon/trae.png" width="28" alt="Trae CN" /> | Trae CN | Trae CN access token（通过 trae.cn 查询 Trae CN／SOLO credits） | — | ✅ | — |
| <img src=".github/assets/tools-icon/alibaba.png" width="28" alt="Alibaba Cloud" /> | Alibaba Cloud | 阿里云控制台 cookie（百炼／Model Studio Token Plan 额度，团队版与个人版） | — | ✅ | — |
| <img src=".github/assets/tools-icon/thirdparty.gif" width="28" alt="第三方 API" /> | 第三方 API | New API / Sub2API 兼容账号预设方案（包括兼容的 One API 分支）、New API 密钥预设方案与自定义余额端点 | — | ✅ | — |

</details>

<details>
<summary>采集说明与自定义数据路径</summary>

- 表中列出默认路径。采集遵循对应工具支持的环境变量覆盖，包括 `$XDG_DATA_HOME`、`$CODEX_HOME`、`$GROK_HOME`、`$HERMES_HOME`、`$KIMI_CODE_HOME`、`$UNSLOTH_STUDIO_HOME`、`$LM_STUDIO_HOME`、`$DSH_HOME`、`$REASONIX_STATE_HOME`、`$REASONIX_HOME` 和 `$CLINE_*` 系列。额外扫描目录可在设置中添加。
- LM Studio 采集覆盖服务器日志中的 `/v1/chat/completions` 和 `/v1/responses`。内置 Chat 界面与原生 `/api/v1/chat` 请求不在此采集范围内。
- Unsloth Studio 统计 Studio 聊天和本地 API 的推理用量。本地推理 API 费用为零，计费提供方使用价格估算；不含训练 Token。详见 [Unsloth 数据来源说明](docs/providers/unsloth.md)。
- Command Code 的 Token 数量由会话文本估算。模型归属和估算费用使用可获取的模型配置，可能与历史请求使用的模型不同。
- Cursor 用量来自账号级导出，同时覆盖 IDE 和 CLI。自动识别桌面端已登录账号，也可在设置中手动添加；刚完成的会话可能需要几分钟才出现在提供方导出数据中。
- MiMo Code 和 Qoder CN 采集需手动开启。MiMo 导入的 Claude Code 会话可能与 Claude Code 用量重叠。
- Qoder CN 读取本地 SQLite 数据库，可在采集设置中开启。默认路径：macOS 为 `~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db`，Windows 为 `%APPDATA%\QoderCN\SharedClientCache\cache\db\local.db`，Linux 为 `~/.config/QoderCN/SharedClientCache/cache/db/local.db`。可用 `TOKEN_MONITOR_QODER_CN_DB_PATH` 覆盖。读取需有 `sqlite3` 命令行工具，或支持免标志 `node:sqlite` 的 Node（23.4+）；费用按模型价格估算。
- 第三方集成支持 New API / Sub2API 兼容账号预设、New API API-key 预设，以及 Custom 余额接口。Custom 从 GET 余额接口的 JSON 数值字段读取余额；仅有聊天补全接口并不能提供余额数据。

</details>

<a id="multi-device"></a>
## 连接电脑与服务器

需要在桌面端汇总多台电脑时，在一台常开电脑的“**设置 → 多设备同步**”中选择“**在此设备上托管 hub**”，再让其他桌面端通过 hub 地址和密钥连接。托管电脑需保持 Potato 运行。也可通过 Node 或 [Cloudflare Workers](worker/README.md) 托管；Worker 指南还提供 iPhone 的 Widgy 和 Scriptable 小组件用法。

**Linux x64 Server Agent** 用于无界面服务器的用量采集，支持后台运行。它是命令行配套工具，不是 Linux 桌面应用。详见 [Server Agent 安装与服务指南](docs/TO_KNOW_SERVER_AGENT_LINUX_SERVICE.md)；同步设置与集成方式见[配置参考](docs/configuration.md)和 [hub API](docs/API.md)。

<details>
<summary>本地数据与历史保留</summary>

在“设置 → 采集”中开启“**保留已删除会话用量**”，即可在本地保留已观测到的每日工具／模型用量。热力图和同步采用 370 天滚动窗口，本地归档保留更早的记录。采集从设备上仍存在的数据开始。

对于会自动清理会话的来源工具，请在旧文件过期前调整保留期。Claude Code 使用 `~/.claude/settings.json` 中的 `cleanupPeriodDays`；设为 `370` 可保留滚动一年的来源会话。其他工具见 tokscale 的[会话保留参考](https://github.com/junhoyeo/tokscale#session-data-retention)。

卸载 Potato 后，应用数据会保留。现有数据目录名称为：macOS 的 `~/Library/Application Support/Token Monitor/`、Windows 的 `%APPDATA%/Token Monitor/`；从源码运行的 Linux 桌面端使用 `~/.config/Token Monitor/`。迁移本地设置与历史前，请备份该目录。

从源码运行 Node hub 或无界面采集代理时，将 `.env.example` 复制为 `.env` 并配置连接信息与密钥。`npm run hub` 启动 hub，`npm run agent` 持续采集，`npm run agent:once` 执行一次采集。[配置参考](docs/configuration.md)说明了 CLI 和环境变量选项。

</details>

## 本地优先与隐私

Potato 在设备上读取 AI 工具用量。可选的多设备同步将统计发送到你配置的 hub；Android 通知将完成记录发送到你配置的 Potato 服务。提供方集成会访问对应服务。各功能使用的数据见[隐私政策](docs/privacy.md)。

## 从源码运行与构建

使用 **Node.js 22.15+**，在本地仓库目录运行：

```bash
npm ci
npm start
```

`npm start` 用于启动本地开发版桌面应用。打包脚本见 [package.json](package.json)，各平台安装包可从 [Releases](https://github.com/Gary06910/Potato/releases) 下载。开发命令与项目约定见[贡献指南](AGENTS.md)。

## 致谢

Potato 独立维护，包含基于 [Token Monitor](https://github.com/Javis603/token-monitor) 的 MIT 开源工作。[LICENSE](LICENSE) 中保留了版权与许可声明。感谢 [tokscale](https://github.com/junhoyeo/tokscale) 提供日志解析和 Token 统计，以及 [CodexBar](https://github.com/steipete/CodexBar) 的 AI 工具额度研究。

## 许可证

[MIT](LICENSE) · Copyright © 2026 Javis。完整声明见 LICENSE。
