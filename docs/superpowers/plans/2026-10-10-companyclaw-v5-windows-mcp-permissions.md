# CompanyClaw V5.0｜Windows-MCP 内置、完整 Computer Use、傻瓜式权限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本计划是 `docs/CompanyClaw__修改实施书5.0.md`（原始需求）+ 已确认 Requirement（Q1–Q9、Q-A–Q-E 裁决）
> + 已确认技术设计在**当前实际源码基线**上的落地文档。任何会改变业务需求或技术设计的发现，
> 必须输出 `# Plan 偏差` 并停下，不得静默改变方向。

**Goal:** 让普通员工安装一个 EXE、配置模型、扫码微信、点一次「全面日常操作」后，即可通过自然语言让 Agent
操作 Windows 软件（含 QQ 类复杂 UI）、浏览器与 Office 文件；日常普通操作不反复弹窗，真正高风险动作由
独立执行层按渠道分级控制。

**Architecture:** 保留既有分层——`desktop/src/companyclaw/**` 是唯一授权裁决点（`CompanyClawRuntime`），
`broker/**` 是独立受限执行器并做服务端二次校验，`plugins/openclaw-weixin/**` 只做可信来源转发而不做裁决。
本次**不新增第二套 Agent/Broker/安装器**；核心工作是：①把「Agent 工具调用 → 策略 → Broker/Windows-MCP」这段
**当前不存在**的生产链路建立起来；②把策略从「远程单一开关」升级为**渠道感知**的多授权维度裁决；
③把 Windows-MCP 作为受限执行后端内置。

**Tech Stack:** TypeScript 5.9（desktop 主进程 CommonJS / broker 独立项目）、Electron 33 + electron-builder 26（NSIS Per-User x64）、
Vue 3 + Pinia + Element Plus（renderer）、Vitest 4、Node 26.7（私有运行时）、
PowerShell UIA 脚本（既有 8 操作）、Python 3.14 + uv（Windows-MCP 私有运行时）、
腾讯官方 `openclaw-weixin` 2.4.6（vendored）。

## Global Constraints

逐字来自需求与项目既有决策，每个 Task 的 Step 都隐含包含本节：

- 员工侧**唯一**要求：安装一个 EXE → 配置个人大模型 → 微信扫码 → 点一次「全面日常操作」。
  任何「请员工先装 Node/Python/.NET SDK/Git/OpenClaw/npm/uv」的结论判为不合格。
- 不重新 Fork；不新建第二套 Electron 客户端、独立 Agent 或第二套 Broker；不重写已通过测试的现有协议。
- 保持 `appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`skills/**` 的原生语义，
  **不放开 MXC ingress**（不得把 MXC 锁定模式改为「所有插件/命令完全开放」），**不全局关闭 AppContainer**。
- 安全内核不改弱：**票据一次性 + nonce 防重放**；`ExecutionBridge` 失败关闭；loopback 不免鉴权；
  票据只能由 Policy Engine 生成，Agent 工具 schema **不得暴露** `approvalTicket` 字段。
- **一键授权 ≠ 管理员权限、≠ 无边界 Shell、≠ 关闭沙盒。**
  `FULL_DAILY` 不得实现为 `sandbox=false` / `policy.allowAll=true` / `shell.*=allow` / `R2|R3 自动批准`。
- **本地与微信远程独立判定**：R3 在微信远程恒拒绝；本地**不作全局恒拒绝**，但不得借本地绕过 UAC/企业安全策略/系统权限。
- 审批两段式：微信等待窗口 **600s**、执行票据 TTL **≤120s**；本机审批沿用现有生效配置（超时默认拒绝）。
  **不得靠延长票据有效期解决等待问题。**
- 云端视觉默认关闭，独立于权限档位；本地与远程**分别授权**；provider/baseUrl/model 变更即失效。
- 一键恢复安全默认值：对**本地与远程同时生效**；确认前展示完整影响清单；重启后旧授权不得复活。
- `main.ts` 只做装配、IPC 注册与既有生命周期管理；新业务策略写入 `desktop/src/companyclaw/` 独立模块。
- 不得为了通过测试而弱化安全判断；不得把所有点击标记成只读来消灭弹窗。
- 缺真实微信 / 内网系统 / 目标 Win11 / 签名证书时记 `BLOCKED` / `UNVERIFIED` / `ENV-BLOCKED`，**不得写 PASS**，不得用 mock 冒充 E2E。
- 修改重要文件前先复制到项目根 `backups/<date>-<topic>/`；临时测试文件用后移入回收站，不做永久删除。
- 提交粒度：每个 WP 内每个 Step 一次提交，提交信息说明原因、影响文件、测试证据与是否改变公开接口。

## 基线事实（本计划成立的前提，均已在本机核对）

| 项 | 值 |
|---|---|
| 分支 / HEAD | `feat/companyclaw-foundation` / `fb63f003` |
| 工作树 | 仅 `desktop/dev-electron.log` 被修改（无关文件，不触碰） |
| desktop 测试基线 | **87 files / 1574 passed / 2 skipped**（`cd desktop && npx vitest run`） |
| 上游 Windows-MCP | `CursorTouch/Windows-MCP` @ **`b455c2766c63599d466a6178641bac70787979a4`**，v0.8.7，MIT，`requires-python >=3.14` |
| 上游工具面 | 21 个（含 `PowerShell` / `FileSystem` / `Registry` / `Process` / `Clipboard` → **必须 allow-map**，见 WP4） |
| 本机 Python | 3.14.3 可用（`py -3.14`）；uv 0.11.30 可用 |
| 本机环境 | 中文 Win11、非管理员、无 .NET SDK（B4）、无微信账号（B1）、无签名证书（B6） |

## 需求 → WP 映射（全覆盖核对）

| 需求条目 | 落点 |
|---|---|
| Q3 七级权限优先级链 | WP1 |
| Q1 / Q-A / Q-B 风险分级与渠道分化 | WP1 |
| Q6 / Q-D 一键恢复安全默认值 | WP2（数据）+ WP7（编排） |
| Q8 旧授权版本化迁移 | WP2 |
| Q5 / Q-E 两段式审批时效 | WP3 |
| V5 §2.2 / §5.1 / §6 Windows-MCP 真实内置 | WP4 + WP10 |
| V5 §3.1 W01–W18 完整 Computer Use（含 W13 拖拽必修） | WP4 + WP5 |
| V5 §7.1 Agent 可调用（禁止只写 Demo） | WP5 |
| Q2 / Q-C 云端视觉独立授权 | WP6 |
| V5 §4.4 / §4.5 权限页与弹窗小白化 | WP9 |
| V5 §6.4 组件自检与一键修复 | WP10 |
| V5 §10 通用测试夹具与测试矩阵 | WP11 |
| V5 §11 / §12 证据与交叉验收 | WP12 |

---

## 执行进度（随实施更新）

| WP | 状态 | 说明 |
|---|---|---|
| WP0 | ✅ 完成 | 基线、ADR 两份、状态/阻塞/依赖锁定文档 |
| WP1 | ✅ 完成 | 渠道感知策略引擎；16 个裁决级用例 |
| WP2 | ✅ 完成 | 单一权限数据源 + 迁移 + 落盘；29 个用例 |
| WP3 | ✅ 完成 | 两段式审批时效（600s / ≤120s）；7 个用例 |
| WP4 | ✅ 完成 | 协议 v2 + Adapter + 真实票据校验 + 真实 MCP 握手；55 + 10 个用例 |
| WP5 | ✅ 完成 | 工具面 + Facade + 审计 + 端到端链路；31 + 9 个用例 |
| WP6 | ✅ 完成 | 云端视觉闸门；16 个用例 |
| WP7 | ✅ 完成 | 一键恢复安全默认值；8 个用例 |
| WP8 | ✅ 完成 | 17 个新 IPC channel + preload |
| WP9 | ✅ 完成 | 权限页 + i18n；8 个组件用例 |
| WP10 | ⚠️ 部分 | 自检与打包链路完成、payload 已装配并实机握手；NSIS 产出 `ENV-BLOCKED`（无 .NET SDK） |
| WP11 | ⚠️ 部分 | 夹具可运行、窗口与 220 元素实测通过；语义控件级 `UNVERIFIED` |
| WP12 | ✅ 完成 | 证据、映射、负向测试文档；三套件全绿 |

**中断恢复点：WP10（NSIS 产出）+ WP11（语义控件级实测）需外部环境；其余已完成。**

## WP0：基线与决策记录

**Files:**
- Create: `docs/companyclaw/v5/00-baseline.md`
- Create: `docs/companyclaw/v5/01-mcp-adapter-adr.md`
- Create: `docs/companyclaw/v5/02-permission-preset-adr.md`
- Create: `docs/companyclaw/v5/IMPLEMENTATION_STATUS.md`
- Create: `docs/companyclaw/v5/BLOCKERS.md`
- Create: `docs/companyclaw/v5/DEPENDENCY_LOCK.md`

- [x] **Step 0.1** 落盘基线（HEAD、测试基线、环境阻塞项、上游锁定 SHA、工具 allow-map 决策、两段式时效、风险分级矩阵、迁移策略）。验证：文件存在且内容与本节表格一致。

---

## WP1：渠道感知策略引擎

**修改位置**：`desktop/src/companyclaw/policy/risk-classifier.ts`（扩展）+
新增 `desktop/src/companyclaw/policy/execution-origin.ts`、
`desktop/src/companyclaw/policy/action-category.ts`、`desktop/src/companyclaw/policy/policy-engine.ts`

**当前行为**：`ActionKind` 是粗粒度枚举且 `delete`/`publish` 直接归入 `R3_KINDS`；
`decideAction()` 在 `context.remoteAuthorization !== "enabled"` 时**对所有渠道一律 deny**，
因此本地路径整体不可用（见 `risk-classifier.ts:106-115`）。

**修改内容**：
- 新增 `ExecutionOrigin = "local-ui" | "weixin-private" | "automation" | "subagent" | "cron"`。
- `ActionKind` 新增按 Q-A/Q-B 拆细的类目：`delete-to-recycle-bin`、`delete-permanent`、`delete-batch-irreversible`、
  `overwrite-recoverable`、`overwrite-unrecoverable`、`task-temp-cleanup`、`message-single-recipient`、
  `message-group`、`message-bulk`、`publish-public`、`sensitive-exfil`、`payment`。
  保留旧类目名不删除（旧测试继续通过）。
- 新增 `classifyActionKind(action)` 与 `decideAction(action, context)`：
  - `context` 增加 `origin`、`preset`、`taskGrant` 命中信息。
  - **R3 远程恒拒绝**；本地对「可恢复性明确的高风险文件操作」返回 `require-approval`（不 deny）；
    `payment`/`bypass-security`/`system-config`/`arbitrary-command` 在**任何渠道**均 deny。
  - 本地不再被 `remoteAuthorization` 短路。
- 新增 `policy-engine.ts`：按 Q3 的 7 级优先级链顺序裁决并返回带 `reasonCode` 与 `policyVersion` 的结果。

**对应需求**：Q1、Q-A、Q-B、Q3、V5 §4.2。

**依赖**：无（WP2 依赖本步的类型）。

**验证方式**：`cd desktop && npx vitest run src/companyclaw/policy/` 全绿；
新增用例覆盖：同一 `delete-to-recycle-bin` 在 `local-ui` 得 `require-approval`、在 `weixin-private` 得 `require-approval`；
`delete-permanent` 在 `weixin-private` 得 `deny`；`message-single-recipient` 在 `weixin-private` 得 `require-approval`（**不再是 deny**）；
`message-group` 在 `weixin-private` 得 `deny`；本地 `arbitrary-command` 仍 `deny`。

---

## WP2：单一版本化权限数据源与迁移

**修改位置**：新增 `desktop/src/companyclaw/permissions/permission-policy.ts`、
`desktop/src/companyclaw/permissions/permission-store.ts`、`desktop/src/companyclaw/permissions/migrate.ts`；
修改 `desktop/src/companyclaw/runtime.ts`、`desktop/src/companyclaw/ipc.ts`

**当前行为**：授权分散在 4 个文件；`RemoteAuthorization`（`runtime.ts:169`）与浏览器策略（`runtime.ts:209`）
**仅内存、重启即失效**；无 preset、无任务级授权、无视觉授权。

**修改内容**：
- 新增契约 `companyclaw.permission-policy.v2`，字段见设计文档 §数据；归属 `CompanyClawRuntime` 唯一读写。
- `preset: BASIC | FULL_DAILY | CUSTOM`、`policyVersion: number`（变更时自增）、
  `remote`、`trustedApps[]`、`trustedSites[]`、`workFolders[]`、`taskGrants[]`、
  `vision.{local,remote}`、`legacyRuleReferences[]`、`enterpriseRestrictions`。
- 迁移：文件不存在 → `BASIC` + 空集；`broker-targets.json` schema1 → `trustedApps`（`scope:"local"`、`legacy:true`）；
  损坏 → 回退安全默认 + 保留 `.corrupt.<ts>.bak`。**旧授权不升档、不扩大范围、不转远程**。
- `Runtime` 新增 `getPermissionPolicy()`、`setPreset(preset, {acknowledged})`、
  `revokeTrustedApp()`、`trustSite()`、`listTaskGrants()`、`revokeTaskGrant()`、
  `grantTaskScope(taskId, targets, ttlMs)`、`isTaskGranted(taskId, target)`。
- `RemoteAuthorization` 状态改由 `permission-policy.remote` 派生并**落盘**；浏览器策略同样落盘。

**对应需求**：Q6、Q8、V5 §4.6。

**依赖**：WP1（类型）。

**验证方式**：`npx vitest run src/companyclaw/permissions/ src/companyclaw/runtime.test.ts` 全绿；
新增用例：文件不存在 → BASIC；损坏文件 → BASIC + 备份文件存在；
旧 `broker-targets.json` 迁移后条目 `scope === "local"` 且 `preset === "BASIC"`；
`setPreset('FULL_DAILY')` 后 `policyVersion` 递增；**重启后 `remote.enabled` 仍保留**（落盘验证）。

---

## WP3：两段式审批时效

**修改位置**：`desktop/src/companyclaw/approvals/approval-store.ts`、`desktop/src/companyclaw/runtime.ts`

**当前行为**：审批 TTL 单一 `COMPANYCLAW_APPROVAL_TTL_MS = 300_000`（`runtime.ts:36`），票据 TTL 120s。

**修改内容**：
- 审批记录新增 `waitWindowExpiresAt`（默认 **600_000ms**）、`origin`、`resolutionChannel`、`actionCategory`。
- `expiresAt` 语义收敛为「执行票据可用窗口」，保持 ≤120s 由 `COMPANYCLAW_TICKET_TTL_MS` 控制。
- 过期判定：`waitWindowExpiresAt` 超时 → 审批 `expired` 且**不执行**。

**对应需求**：Q5、Q-E。

**依赖**：WP2。

**验证方式**：`npx vitest run src/companyclaw/approvals/`；
新增用例：`waitWindowExpiresAt` 默认 = requestedAt + 600s；超 600s 后 `inspect()` 报 `expired`；
票据 TTL 常量仍为 120_000 且有测试钉住。

---

## WP4：Broker 协议 v2 与 Windows-MCP Adapter

**修改位置**：`broker/protocol.ts`、`desktop/src/companyclaw/broker-protocol.ts`（镜像）、
`broker/server.ts`、`broker/main.ts`、`broker/policy.ts`；
新增 `broker/adapters/windows-mcp/`（`process-manager.ts`、`tool-registry.ts`、`tool-policy-map.ts`、
`execution-adapter.ts`、`health.ts`）与 `desktop/src/companyclaw/bridge/mcp-transport.ts`

**当前行为**：协议仅 8 个 UIA 操作；`broker/main.ts:81-85` **未注入 `verifyTicket`**，`BrokerPolicy`
默认校验器为 `() => false`（`policy.ts:66`），即所有变更类操作必然被拒；无 Windows-MCP 任何痕迹。

**修改内容**：
- 协议保持 `companyclaw.broker.v1` 可读，新增 `companyclaw.broker.v2` + 能力协商字段；
  新增操作：`list-installed-apps`、`launch-app`、`focus-window`、`snapshot-ui-tree`、
  `find-control`（返回带失效期租约）、`screenshot`、`click`、`move`、`drag-drop`、`scroll`、
  `wait-for-condition`、`verify-state`。**不删除旧操作**。
- `broker/main.ts` **注入真实 `verifyTicket`**（用 `broker-proof` 的 HMAC 校验请求载荷）。
- Windows-MCP Adapter：
  - `McpProcessManager`：固定路径 + 哈希校验启动上游 Server（禁止任意 `command/args`）。
  - `McpToolRegistry`：真实 `initialize` + `tools/list`，持久化工具清单与 schema 版本。
  - `tool-policy-map`：**allow / wrap / deny** 三分。`PowerShell`、`FileSystem`、`Registry`、`Process`、`Clipboard`、
    `Scrape`、`Notification` 一律 **DENY**；`App`/`Snapshot`/`Screenshot`/`Click`/`Type`/`Scroll`/`Move`/`Shortcut`/`Wait`/`WaitFor`/`DisplayInventory` **wrap**；
    其余按真实 `tools/list` 逐项判定，未知一律 **DENY**。
  - `health`：`NOT_PACKAGED / START_FAILED / HANDSHAKE_FAILED / TOOLS_MISSING / SESSION_LOCKED / READY`。
- `mcp-transport.ts`：把 W01–W18 动作映射到 Broker v2 操作，**不暴露 `approvalTicket` 给模型**。

**对应需求**：V5 §2.2、§3.1、§5.1–§5.3、Q7（W13 拖拽必修）。

**依赖**：WP1（`ActionKind`）。

**验证方式**：`cd broker && npx vitest run`（含既有 9 项实机 UIA 用例）+
`cd desktop && npx vitest run src/companyclaw/broker-protocol.test.ts`（镜像一致性）；
新增用例：v1 请求仍被接受；未知操作被拒；**未授权时 `PowerShell` 在 allow-map 中为 DENY**；
`broker/main.ts` 注入校验器后「无票据的 `set-value`」返回 `approval-required` 而非静默拒绝。
上游 Server 实际握手记 `UNVERIFIED` 需实机确认（本机可尝试）。

---

## WP5：Agent 工具面与任务接线

**修改位置**：新增 `desktop/src/companyclaw/tools/computer-use-tools.ts`、
`desktop/src/companyclaw/tools/tool-facade.ts`；
修改 `desktop/src/companyclaw/runtime.ts`、`desktop/src/main.ts`

**当前行为**：**Agent → 策略 → Broker 这段完全不存在**。`runtime.execute()`（`runtime.ts:554`）无生产调用方；
`createBrokerTransport()`（`bridge/broker-transport.ts:69`）与 `TaskOrchestrator`、
`DesktopExecutionLock` 均**已实现但未接线**。任务创建唯一入口是微信私聊，且 `objective` 传空串（`main.ts:3607`）。

**修改内容**：
- `tool-facade.ts`：Agent 可见工具的唯一入口。接收调用 → 校验服务端铸造的 `origin/taskId` →
  转发 `TaskOrchestrator` → `Runtime.execute`（含 `ExecutionBridge`）→ `mcp-transport`。
  工具定义**不含** `approvalTicket` 属性。
- 接线 `DesktopExecutionLock`：同一 `taskId` 可重入，异任务返回 `desktop-busy`。
- 新增**本地任务入口**：本地聊天发起时创建任务并携带真实 `taskId/stepId`、`objective`。
- 结果回读：复用 `TaskOrchestrator` 的 `VERIFYING → COMPLETED | PARTIAL`。

**对应需求**：V5 §5.6、§7.1、§7.2。

**依赖**：WP1、WP2、WP4。

**验证方式**：`npx vitest run src/companyclaw/tools/ src/companyclaw/tasks/`；
新增用例：同一任务连续两步不抢锁、异任务 `desktop-busy`；
工具 schema 中**不含** `approvalTicket`/`approved` 字段；
`origin` 无法由模型文本自证（伪造 `origin:"local"` 的调用被拒）。

---

## WP6：云端视觉授权闸门

**修改位置**：新增 `desktop/src/companyclaw/vision/vision-gate.ts`；修改 `runtime.ts`

**当前行为**：完全不存在。

**修改内容**：
- 授权绑定 user + device + provider + baseUrl + model + origin + captureScope + expiresAt。
- 默认关闭；本地与远程**分别开关**；`FULL_DAILY` **不联动**。
- 失效条件：撤销、provider/baseUrl/model 变更、微信重新绑定、用户/设备身份变化、远程授权到期或撤销、
  一键恢复、企业策略收紧、采集范围超出授权。
- 采集限目标窗口/必要区域；无法可靠排除敏感内容 → 阻断上传并要求额外确认。
- 有效期默认 7 天；**远程**视觉授权 ≤ 远程授权剩余期限（本地不受此上限约束，见设计文档的待确认项裁决）。

**对应需求**：Q2、Q-C。

**依赖**：WP2。

**验证方式**：`npx vitest run src/companyclaw/vision/`；
新增用例：未授权 → 阻断；授权后同范围连续放行；**改 model 后立即失效**；
撤销后不再发起上传；`FULL_DAILY` 开启不改变视觉授权状态。

---

## WP7：一键恢复安全默认值

**修改位置**：新增 `desktop/src/companyclaw/recovery/reset-to-defaults.ts`；修改 `runtime.ts`、`ipc.ts`

**修改内容**：
- `preview()` 返回影响清单：档位、将撤销的远程授权、将关闭的本地/远程视觉授权、
  将清理的信任应用/站点/目录计数、**将暂停的任务数（本地+远程）**、**将作废的未消费审批数**、明确保留项。
- `apply(previewToken)`：落盘先行（清空用户授予集合、`preset=BASIC`、`policyVersion++`）→
  作废全部未消费票据（已消费只读保留）→ 清除 `taskGrants` → 对全部活跃任务执行 `pause`（`PAUSE_REQUESTED`）。
- **不**关闭 QQ/浏览器/Office；**不**删除任务历史与产物；保留模型 Key、微信绑定、聊天历史、审计、产物。
- 持久化且重启后不复活。

**对应需求**：Q6、Q-D。

**依赖**：WP2、WP3。

**验证方式**：`npx vitest run src/companyclaw/recovery/`；
新增用例：预览计数与真实计数一致；apply 后 `preset === "BASIC"` 且全部信任集合为空；
活跃任务进入 `PAUSE_REQUESTED`；**重建 Runtime 后授权仍为清空态**（不复活）；
保留项（模型配置键、微信绑定、已完成任务、产物目录）未被删除。

---

## WP8：IPC 与 preload

**修改位置**：`desktop/src/companyclaw/ipc.ts`、`desktop/src/preload.ts`

**修改内容**：按设计文档 §API 新增 channel：
`permission:get-policy|set-preset|list-trusted-apps|revoke-trusted-app|trust-current-site|list-task-grants|revoke-task-grant`、
`vision:get|set|revoke`、`recovery:preview|apply`、`audit:query`、`tools:list`。
**既有 channel 全部保持向后兼容**（只增不改）。

**对应需求**：V5 §4.4、§4.5。

**依赖**：WP2、WP6、WP7。

**验证方式**：`npx vitest run src/companyclaw/ipc.test.ts`（新增）；
每个新 handler 有输入校验用例；既有 handler 返回结构未变。

---

## WP9：权限 UI

**修改位置**：`desktop/renderer/src/views/SettingsView.vue`、
`desktop/renderer/src/stores/companyclaw.ts`、新增 `desktop/renderer/src/components/PermissionSettings.vue`

**当前行为**：`SettingsView.vue`（3728 行）**没有** CompanyClaw 权限区块；store 只读展示。

**修改内容**：新增一级设置「电脑操作权限」：三档单选 + 副文案 + 「与 Windows 管理员权限无关」说明 +
微信远程开关/期限（1/7/30 天，默认 7）+ **本地/远程视觉双开关** + 正在允许的任务（查看与撤销）+
[查看本次授权范围] + [一键恢复安全默认值]（先预览后确认）+ 高级设置折叠区。
状态：loading / empty / error（**不得显示为已允许**）/ success / 「应用中/需重启」。

**对应需求**：V5 §4.4、Q2、Q6。

**依赖**：WP8。

**验证方式**：`cd desktop/renderer && npx vitest run`；
新增组件测试：三档切换调用 IPC 而非本地写状态；`FULL_DAILY` 首次需 `acknowledged`；
恢复默认值走 preview → apply 两步；桥不可用时显示不可用。

---

## WP10：组件自检与打包

**修改位置**：`desktop/src/companyclaw/guardian.ts`、`desktop/src/companyclaw/runtime-manifest.ts`、
`desktop/scripts/prepare-production-resources.mjs`、`desktop/electron-builder.yml`

**修改内容**：
- `guardian.ts` 新增 `windows-mcp`、`mcp-tools`（受控工具数）、`vision` 条目与中文故障码
  （`WINDOWS_MCP_NOT_PACKAGED` 等）；`tool-call` 类型产出真实条目。
- `runtime-manifest.ts` 的 `kind` 增加 `mcp` / `python-runtime` / `native`。
- `prepare-production-resources.mjs` 新增 Windows-MCP 私有运行时装配 + 哈希 + 许可证 + 失败阻断。
- `electron-builder.yml` 的 `extraResources` 加入 MCP payload。

**对应需求**：V5 §6.1–§6.4。

**依赖**：WP4。

**验证方式**：`npx vitest run src/companyclaw/guardian.test.ts src/companyclaw/runtime-manifest.test.ts`；
负向用例：manifest 缺 MCP 条目 → 构建阻断或启动报 `WINDOWS_MCP_NOT_PACKAGED`。
（完整 NSIS 产出受 .NET SDK 阻塞 → 记 `ENV-BLOCKED`。）

---

## WP11：通用测试夹具与测试矩阵

**修改位置**：新增 `desktop/src/companyclaw/testing/`（Web fixture 驱动）+
`tools/testapp/`（Windows TestApp：标准 UIA 控件、自绘按钮、滚动区、延迟弹窗、模拟联系人、
模拟「发送」最终提交点、错误弹窗、**拖拽接收区**）

**对应需求**：V5 §10.1 T01–T45、T18（连续 20 次零弹窗）、T45（跨工具多步任务）。

**依赖**：WP5。

**验证方式**：夹具可运行；至少覆盖 T18（20 次普通操作 0 弹窗）、T26/T27（审批通过/拒绝）、
T28（过期/重放）、T25（cmd/regedit 拒绝）、Q7 的**真实拖拽成功**一项。
无 Windows 交互会话的项记 `ENV-BLOCKED` 并给复现命令。

---

## WP12：回归与证据

**修改位置**：新增 `docs/companyclaw/v5/07-release-evidence.md`、
`08-v1-v4-requirement-map.md`、`05-security-negative-tests.md`

**验证方式**：
- `cd desktop && npx vitest run`（基线 87/1574 不得减少）
- `cd desktop/renderer && npx vitest run`
- `cd broker && npx vitest run`
- 交叉验收：F01–F14 逐项映射；E01–E20 / PKG-01–10 契约不退化。

---

## 执行顺序与恢复入口

```text
WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7 → WP8 → WP9 → WP10 → WP11 → WP12
                （WP3/WP6/WP7 均只依赖 WP2，可并行）
```

**中断恢复**：阅读本文件 → 读 `docs/companyclaw/v5/IMPLEMENTATION_STATUS.md` 的完成状态表 →
从未勾选的第一个 Step 继续。每个 Step 完成后必须更新 `IMPLEMENTATION_STATUS.md`。

## Plan 偏差处理

小偏差（文件位置不同、可复用既有方法、某步无需修改）→ 直接调整并在 `IMPLEMENTATION_STATUS.md` 记录原因。
大偏差（数据模型假设错误、核心流程无法按设计实现、发现遗漏的跨模块影响、需改需求）→
停止该步并输出 `# Plan 偏差`（发现 / 原 Plan / 实际代码 / 影响 / 建议），不得偷偷改变需求。
