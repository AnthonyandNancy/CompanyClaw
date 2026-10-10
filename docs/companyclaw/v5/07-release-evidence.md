# 07 — V5.0 发行证据

- 生成时间：2026-10-10
- 需求：`docs/CompanyClaw__修改实施书5.0.md` + Q1–Q9 / Q-A–Q-E 裁决
- 计划：`docs/superpowers/plans/2026-10-10-companyclaw-v5-windows-mcp-permissions.md`
- 状态诚实性：本机可完成的项全部实跑；依赖真实微信账号、内网系统、清洁机与签名证书的项记
  `BLOCKED` / `ENV-BLOCKED`，**不以单测或文档折算为「已通过」**。

## 测试基线对比

| 套件 | 改动前 | 改动后 | 命令 |
|---|---|---|---|
| desktop 主进程 | 87 files / 1574 passed | **101 files / 1737 passed / 2 skipped** | `cd desktop && npx vitest run` |
| broker | 8 files / 54 passed | **15 files / 150 passed** | `cd broker && npx vitest run` |
| renderer | 27 files / 320 passed | **29 files / 340 passed** | `cd desktop/renderer && npx vitest run` |

## 真实执行证据

| ID | 内容 | 状态 | 证据 |
|---|---|---|---|
| V5-EV-01 | 上游 Windows-MCP 源码锁定与真实握手 | `PASS` | `windows-mcp==0.8.7` @ `b455c276`，真实 `initialize`+`tools/list` 返回 20 工具，名与 `PINNED_UPSTREAM_TOOLS` 完全一致 |
| V5-EV-02 | 内置 payload 装配 | `PASS` | `desktop/scripts/prepare-windows-mcp-resources.mjs` 产出 66 文件 / 235 MB（server 1.1 MB + 私有运行时 234 MB） |
| V5-EV-03 | 内置 payload 完整性校验 | `PASS` | `windows-mcp-payload.live.test.ts`：真实 payload 通过 `probeWindowsMcpLayout`，`health=READY` |
| V5-EV-04 | 私有运行时实机握手 | `PASS` | `docs/companyclaw/v5/scripts/verify-windows-mcp-handshake.py` 使用 **payload 自带解释器** 输出 `OK: 20 tools, allow-map in sync`，不依赖系统 Python |
| V5-EV-05 | 端到端工具链（策略→票据→执行） | `PASS` | `runtime-tool-chain.test.ts` 9 用例：读取免提示、敏感动作转审批、批准后带票据执行、拒绝不放行、远程未授权拒绝、**20 次受覆盖操作 0 弹窗** |
| V5-EV-06 | 票据防重放与请求绑定 | `PASS` | `broker/ticket-verify.test.ts` 10 用例：换载荷/换操作/换任务/换密钥/过期全部拒绝；无密钥 broker 拒绝一切变更 |
| V5-EV-07 | 权限落盘与重启不复活 | `PASS` | `runtime-permissions.test.ts`：远程授权跨重启保留；撤销后重启不复活；旧白名单迁移为 `scope=local` 且 `preset=BASIC` |
| V5-EV-08 | 一键恢复安全默认值 | `PASS` | `reset-to-defaults.test.ts` 8 用例：清全部授权、作废未消费审批、暂停本地+远程任务、保留模型/微信/历史/产物、重启不复活 |
| V5-EV-09 | 云端视觉独立授权 | `PASS` | `vision-gate.test.ts` 16 用例：默认关闭、换服务商/模型即失效、远程不超远程授权期限、本地不受该上限约束 |

## 通用测试夹具（V5 §10.1）实测

| 项 | 状态 | 证据 |
|---|---|---|
| 夹具可运行（脚本版） | `PASS` | `tools/testapp/CompanyClawTestApp.ps1` 启动成功 |
| 夹具可编译（编译版，无需 SDK） | `PASS` | `tools/testapp/build-fixture.ps1` 用 Windows 自带 `csc.exe` 生成 `CompanyClawTestApp.exe`（10 KB） |
| 窗口可被 Broker 探针发现 | `PASS` | `broker/scripts/find-elements.ps1` 返回 `WINDOW=CompanyClaw Test App`、`COUNT=220` |
| 语义控件级定位（按 AutomationId） | `UNVERIFIED` | 本机会话中 WinForms 经 MSAA 桥接暴露为匿名 `Pane` 节点（automationId 为句柄），需交互式桌面会话实测；**如实记录，不宣称通过** |

第 4 项不是夹具缺陷：它正是需求要求「UIA 不可用时必须视觉兜底、不得宣布应用不支持」的真实场景。
夹具已就位，语义树可用的会话上无需改动即可精确寻址。

## T01–T45 覆盖状态（V5 §10.1）

| 分组 | 覆盖 | 说明 |
|---|---|---|
| T01–T05 打包与 MCP 协议 | 部分 `PASS` | T02/T03/T04/T05 有真实用例（缺件阻断、schema 对账、真实 tools/list、高危工具拒绝）；**T01 需要安装态（`ENV-BLOCKED`）** |
| T06–T07 应用启动（本地/微信） | 代码 `PASS`，实机 `UNVERIFIED` | 适配层真实实现；需交互式桌面会话实测 |
| T08 相似窗口不误输入 | `PASS`（策略层） | 目标身份进入票据绑定；实机待测 |
| T09–T14 UIA/视觉/DPI/IME/延迟/窗口变化 | `UNVERIFIED` | 夹具已就位（`tools/testapp/`），窗口发现与元素枚举**实测通过**；语义控件级与视觉兜底需交互式桌面会话 |
| T15 键鼠串行 | `PASS` | `desktop-execution-lock` 接线 + `executeStepWithLock` |
| T16 取消 | `PASS` | 任务状态机既有用例 |
| T17 回执丢失先回读 | 设计保证 | `TaskOrchestrator` 的 `VERIFYING→PARTIAL` |
| **T18 20 次 0 弹窗** | **`PASS`** | `runtime-tool-chain.test.ts` 实测 20 次连续操作，审批数 0 |
| T19 BASIC 模式需确认 | `PASS` | `runtime-tool-policy.test.ts` |
| T20–T21 免手填应用/域名 | `PASS`（策略层） | `trustApp`/`trustSite` + 任务级目标 |
| T22 危险跳转被阻断 | `PASS`（策略层） | `browser-policy` 既有用例 |
| T23 伪造授权文本无效 | `PASS` | `validateToolCall` 拒绝模型自报身份/审批 |
| T24/T25 未知程序与系统工具 | `PASS` | `tool-policy-map` 拒绝 `PowerShell`/`FileSystem`/`Registry`/`Process` 等 |
| T26–T28 审批通过/拒绝/过期与重放 | `PASS` | `runtime-tool-chain.test.ts` + `approval-wait-window.test.ts` |
| T29 外发消息需审批 | `PASS`（策略层） | `message-single-recipient` = R2；`message-group`/`message-bulk` = R3 |
| T30–T33 身份隔离与旁路 | `PASS`（策略层） | 既有用例 + `deriveChildOrigin` 权限只继承不收窄反向 |
| T34 原生旁路 | `PARTIAL` | 工具面唯一入口已建立；既有 MXC 策略未改动，需实机复核 |
| T35–T37 产物与送达 | `PASS` | 既有 `results/*` 用例未退化 |
| T38 MCP 进程断开 | 代码 `PASS` | `broker-client` 重启上限 2 + `McpHealth` 状态 |
| T39 重启恢复 | `PASS` | `runtime-permissions.test.ts` |
| T40 锁屏/UAC | `UNVERIFIED` | 需实机 |
| T41 普通用户安装 | `ENV-BLOCKED` | 无 .NET SDK / 无清洁机 |
| T42–T44 升级与首次配置 | 部分 `PASS` | 迁移与恢复默认值有真实用例；安装态 `ENV-BLOCKED` |
| T45 跨工具多步任务 | 代码 `PASS` | 同一 `taskId` 多步链路；实机待测 |

## 安全硬阻断（V5 §10.2）核对

| 项 | 状态 | 依据 |
|---|---|---|
| 未绑定微信用户可操作电脑 | 已阻断 | 既有身份绑定 + `runtime-tool-chain.test.ts` |
| 模型自报 `origin=local` 取得本地权限 | 已阻断 | `validateToolCall` 返回 `model-supplied-identity` |
| 通过直接 MCP / exec / Skills 绕过策略 | 已阻断（工具面唯一入口） | `tool-policy-map` DENY 清单 + 仅 16 项受控工具 |
| 普通「全面日常操作」使 R3 自动放行 | 已阻断 | `decideToolAction` 对 R3 恒拒绝，`taskGranted` 不改变 R3 |
| 目标变化后盲目输入 / 失效票据重复消费 | 已阻断 | 票据绑定载荷与操作；租约与窗口复核在 WP4 适配层 |
| 无授权对外发送却称安全 | 已阻断 | `message-group`/`sensitive-exfil` 拒绝 |
| 安装包隐式 `pip/uvx/npm install` | 已阻断 | payload 在构建期装配；员工端零安装 |
| 任意微信用户读取跨用户产物 | 已阻断 | 既有 owner 校验用例 |

## 阻塞

见 `BLOCKERS.md`。**未产出 NSIS 安装包**（无 .NET SDK），因此 T01/T41/T44 安装态项记 `ENV-BLOCKED`。
