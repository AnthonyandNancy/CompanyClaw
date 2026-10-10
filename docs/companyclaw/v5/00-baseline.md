# 00 — V5.0 基线

- 采集时间：2026-10-10
- 采集方式：非破坏性只读检查（`git status` / `git rev-parse` / 运行既有测试 / 符号检索）
- 对应计划：`docs/superpowers/plans/2026-10-10-companyclaw-v5-windows-mcp-permissions.md`
- 需求：`docs/CompanyClaw__修改实施书5.0.md` + 已确认 Requirement（Q1–Q9、Q-A–Q-E 裁决）

---

## 1. 仓库与环境

| 项 | 值 |
|---|---|
| 分支 | `feat/companyclaw-foundation` |
| HEAD | `fb63f003270ffc4d871dd61bcc645f2c7485880a` |
| 工作树 | 仅 `desktop/dev-electron.log` 被修改（既有无关改动，本计划不触碰） |
| OS | 中文 Windows 11 |
| 管理员权限 | 否 |
| Node | v26.7.0 |
| Python | 3.11.9 / 3.14.3（`py -3.14`）、uv 0.11.30 |
| .NET SDK | 无 → NSIS 完整产出 `ENV-BLOCKED`（沿既有 B4） |
| 微信测试账号 | 无 → 微信实机验收 `BLOCKED`（沿既有 B1） |
| 代码签名证书 | 无 → 签名/分发 `BLOCKED`（沿既有 B6） |

## 2. 测试基线（改动前）

| 套件 | 命令 | 结果 |
|---|---|---|
| desktop 主进程 | `cd desktop && npx vitest run` | **87 files / 1574 passed / 2 skipped** |
| broker | `cd broker && npx vitest run` | 8 files / 54 passed（含 9 项实机 UIA） |
| renderer | `cd desktop/renderer && npx vitest run` | 27 files / 320 passed |

**回归红线**：以上通过数不得减少。

## 3. 现状关键事实（决定 WP 顺序）

1. **Agent → 策略 → Broker 的生产链路完全不存在**：`CompanyClawRuntime.execute()` 无生产调用方；
   `createBrokerTransport()`、`TaskOrchestrator`、`DesktopExecutionLock` 均已实现但未接线。
2. **Broker 生产票据校验未注入**：`broker/main.ts` 未传 `verifyTicket`，`BrokerPolicy` 默认 `() => false`，
   且桌面侧白名单为空 → 变更类操作在当前生产状态下全部被拒。
3. **本地被远程开关短路**：`decideAction()` 在 `remoteAuthorization !== "enabled"` 时对所有渠道 deny。
4. **权限状态不落盘**：`RemoteAuthorization` 与浏览器策略仅内存，重启即失效。
5. **任务创建唯一入口是微信私聊**，且 `objective` 传空字符串。

## 4. 上游 Windows-MCP 锁定

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/CursorTouch/Windows-MCP` |
| 锁定 SHA | `b455c2766c63599d466a6178641bac70787979a4` |
| 版本 | `0.8.7` |
| 许可证 | MIT |
| `requires-python` | `>=3.14`（不同于 manifest 的 `>=3.13`，以 `pyproject.toml` 为准） |
| 依赖 | click, comtypes, dxcam, fastmcp, fuzzywuzzy, markdownify, pillow, platformdirs, posthog, psutil, pygments, python-levenshtein, pywin32, requests, tabulate, thefuzz, uuid7 |
| 遥测 | `ANONYMIZED_TELEMETRY` 默认 `true` → **必须置为 `false`** |
| Watchdog | `WINDOWS_MCP_WATCHDOG` 默认 `false` → **保持关闭**（README 明确其可导致 server 崩溃） |

### 工具 allow-map 决策（21 项）

| 上游工具 | 决策 | 理由 |
|---|---|---|
| `PowerShell` | **DENY** | 等价任意 Shell，违反「不得暴露任意命令面」 |
| `FileSystem` | **DENY** | 任意文件读写/删除，须走 CompanyClaw 文件管线 |
| `Registry` | **DENY** | 系统配置面 |
| `Process` | **DENY** | 可 kill 任意进程 |
| `Clipboard` | **DENY** | 剪贴板可含凭据 |
| `Scrape` | **DENY** | 网络抓取绕过 BrowserPolicy |
| `Notification` | **DENY** | 非任务所需 |
| `App` | **WRAP** | 启动/切窗，须经应用发现与白名单校验 → W01/W02/W04 |
| `Snapshot` | **WRAP** | → W05 W06 |
| `Screenshot` | **WRAP** | → W14，须经视觉闸门 |
| `Click` | **WRAP** | → W11，坐标点击须绑定截图/窗口/DPI |
| `Type` | **WRAP** | → W09 |
| `Scroll` | **WRAP** | → W12 |
| `Move` | **WRAP** | → W13 拖拽 |
| `Shortcut` | **WRAP** | → W10，仅允许显式列举的常用组合 |
| `Wait` / `WaitFor` | **WRAP** | → W15，须有上限 |
| `DisplayInventory` | **WRAP** | 多屏/DPI 支持 |
| `MultiSelect` / `MultiEdit` | **DENY** | 批量输入扩面，本版不开放 |
| `ControlStatus` | **WRAP** | 只读状态，可用于用户接管检测 |

决策原则：**先取真实 `tools/list`，未在清单中的工具一律 DENY**。

## 5. 已确认的关键裁决（实现依据）

- 风险分级：`delete-to-recycle-bin`/`overwrite-recoverable`/`message-single-recipient` = R2；
  `delete-permanent`/`delete-batch-irreversible`/`overwrite-unrecoverable`/`message-group`/`message-bulk`/
  `publish-public`/`sensitive-exfil`/`payment` = R3。**R3 微信远程恒拒绝；本地不作全局恒拒绝，
  但付款/转账须本人在官方应用亲自完成最终提交，且任何渠道不得绕过 UAC。**
- 审批两段式：微信等待窗口 **600s**，执行票据 TTL **≤120s**；本机审批沿用现有 60s 倒计时且超时默认拒绝。
- 云端视觉：默认关闭，本地与远程分别授权，有效期默认 7 天，provider/baseUrl/model 变更即失效。
- 一键恢复安全默认值：本地与远程同时生效，确认前展示影响清单，重启后不复活。
- 7 级优先级链：系统/企业限制 > 不可绕过规则 > 更严格企业管控 > 员工档位 > 任务授权 > 一次性审批 > Agent 请求。

## 6. 阻塞项

见 `BLOCKERS.md`。本机可完成：代码、单测、类型检查、broker 实机 UIA/适配层；
不可完成：真实微信 E2E、内网系统、清洁机安装、签名分发。
