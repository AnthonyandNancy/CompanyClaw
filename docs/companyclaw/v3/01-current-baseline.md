# 01 — 当前基线（V3 C00）

- 采集时间：2026-10-09
- 采集方式：非破坏性只读检查（`git status` / `git rev-parse` / `git submodule status` / 运行既有测试 / 符号检索）
- 对应计划：`docs/superpowers/plans/2026-10-09-companyclaw-v3-closure.md`
- 需求：`docs/CompanyClaw__修改实施书3.0.md`（V3.0，747 行）

> 本文件只记录**当前真实状态**，不覆盖 `IMPLEMENTATION_STATUS.md` 与 `BLOCKERS.md` 的既有历史证据。

---

## 1. 仓库与环境

| 项 | 值 |
|---|---|
| 分支 | `feat/companyclaw-foundation` |
| HEAD | `c6e090a77703dc03da9ae0cc6f3f08911f8f4215` |
| 工作树 | 干净（唯一未跟踪项为本轮新增的计划文档） |
| remote | `myorigin` → `https://github.com/AnthonyandNancy/CompanyClaw.git`（fetch/push） |
| 子模块 | `third_party/openclaw-windows-node/source` = `fc9add75`（已 checkout，`v2026.7.1-9-gfc9add75`） |
| OS | 中文 Windows 11 专业版 `10.0.26100` |
| PowerShell | `5.1.26100.8457` |
| Node | `v26.7.0`（满足 OpenClaw 2026.9.3 要求 `>=24.16 <25 \|\| >=26.1`） |
| .NET SDK | **无**（`dotnet --list-sdks` 为空；仅有 runtime `Microsoft.NETCore.App 8.0.27`）→ 阻塞 B4 |
| Python | `3.11.9` |
| 管理员权限 | 否（`IsAdmin=False`），符合 Per-User 目标设计 |
| GitHub 可达 | 是（`git ls-remote` 成功） |
| 内网测试系统 | 无配置（`BLOCKERS.md` B2） |
| 微信测试账号 | 无（`BLOCKERS.md` B1） |
| 代码签名证书 | 无（`BLOCKERS.md` B6） |

### 当前测试基线（本轮实测，退出码 0）

| 范围 | 命令 | 实测结果 |
|---|---|---|
| desktop | `cd desktop && npx vitest run` | 75 files / **1451 passed**, 2 skipped |
| renderer | `cd desktop/renderer && npx vitest run` | 27 files / **320 passed** |
| broker | `cd broker && npx vitest run` | **10 files / 63 passed**（含 4 个 `.live` 实机文件） |
| 插件 | `cd desktop && npx vitest run --root ../plugins/openclaw-weixin` | 1 file / **12 passed** |
| 类型检查 | `cd desktop && npx tsc --noEmit`；`cd broker && npx tsc --noEmit` | 均 clean（exit 0） |

> 注意：`IMPLEMENTATION_STATUS.md` 记录的 broker 基线为"8 files / 54 passed"，本轮实测为 **10 files / 63 passed**（新增了 `.live` 实机用例）。desktop 1451 passed 与记录一致。

---

## 2. G01–G08 逐项现状

### G01｜NSIS 构建未保证完整资源 staging

- **真实文件**：`desktop/scripts/prepare-production-resources.mjs`（311 行）
- **稳定符号**：`discardStaging()`、`run()`、`resolveNpmCli()`、顶层 `entries` 数组、`writeFileSync(stagingDir/runtime-manifest.json)`
- **当前行为**：已完成 staging → manifest → 逐条 hash 复校验 → 同卷 `renameSync` 原子交换 → 失败回滚（`superseded` 逆序恢复）。装配 `node.exe`、`openclaw.asar`（npm 装锁定版后 `createPackage` 打包并删除源树）、`windows-node/`（复制但**不登记 manifest**）、`companyclaw-broker/{dist,scripts}`。
- **未完成**：**微信插件**与 **agent-skills** 完全未装配；`windows-node/**` 未登记 manifest。
- **缺口计数**：`entries` 仅 `node` / `openclaw` / `broker`(+N 个 `.ps1`) 四类 kind，`runtime-manifest.ts` 已预留的 `plugin` / `skill` / `windows-node` 三类无人写入。
- **入口收敛**：`desktop/package.json` 的 `dist` = `release:win` = `prepare-production-resources` + `build` + `electron-builder --win`（已收敛，与需求 §1.1 旧描述不符）。
- **对应测试**：`desktop/src/companyclaw/production-resources.test.ts`（4 条静态断言）、`desktop/src/companyclaw/extra-resources-contract.test.ts`（6 条）。
- **状态**：`Code = PARTIAL`，`Unit = PASS`，`Packaged = UNVERIFIED`（B4），`Real E2E = BLOCKED`。

### G02｜Broker 未确认打包和生产正确启动

- **真实文件**：`desktop/src/companyclaw/broker-client.ts`、`desktop/src/companyclaw/broker-paths.ts`、`desktop/src/main.ts`
- **稳定符号**：`BrokerClient.startInternal()`、`BrokerClient.call()`、`BrokerClient.getStatus()`、`resolveBrokerDir()`、`resolveBrokerScriptDir()`、`main.ts` 中 `resolveNodePath()` 传入 `companyClawOptions.nodePath`
- **当前行为**：已改为使用 `this.options.nodePath ?? process.execPath` spawn `brokerDir/dist/main.js`；令牌经环境变量 `COMPANYCLAW_BROKER_TOKEN`（不进 argv）；stdout 首行 JSON 报端口；60s 启动超时。`resolveNodePath()`（`path-resolver.ts:90`）打包态优先 `process.resourcesPath/node.exe`。
- **未完成**：spawn 前**无** `existsSync` 前置校验，无 `BROKER_RUNTIME_NOT_FOUND` / `BROKER_ENTRY_INVALID` 错误码；`awaitPort()` 之后**不再监听** `exit`，`isRunning()` 依据 `port > 0 && child !== null` 会在进程死后仍报 alive；**无重启上限**；`stop()` 仅 kill，无等待与收口；Broker 目录在 `extraResources` 已存在（与需求 §1.1 旧描述不符）。
- **对应测试**：`desktop/src/companyclaw/broker-client-spawn.test.ts`（10 条）、`broker-client`/`broker-paths` 相关用例。
- **状态**：`Code = PARTIAL`，`Unit = PASS`，`Packaged = UNVERIFIED`（B4），`Real E2E = BLOCKED`。

### G03｜Gateway/OpenClaw 生产环境缺实测和自修复

- **真实文件**：`desktop/src/main.ts`（`startGatewayInner`、`resolveOpenClawEntry` 调用点 1550/2342/3424/5189）、`desktop/src/path-resolver.ts`、`desktop/src/bundled-runtime.ts`、`desktop/src/companyclaw/first-run-init.ts`
- **稳定符号**：`resolveOpenClawEntry()`、`resolveBundledOpenClawDir()`、`materializeRuntimeArchive()`、`planFirstRunConfig()`、`planBrowserConfig()`、`ensureCompanyClawFirstRunConfiguration()`
- **当前行为**：打包态 Gateway 使用 `resources/openclaw.asar` 解包到 `userData/runtime/openclaw`；首启生成 `gateway.auth.{token,mode}`、`gateway.port`、`browser.{enabled,executablePath}`（Edge）；spawn 使用 `stdio: [...,"ipc"]`。
- **未完成**：桌面侧**无任何代码**把插件写入 `${stateDir}/extensions/openclaw-weixin`，也**无写入方**产生 `config.plugins.installs["openclaw-weixin"]` → `plugin:weixin:get-status`（`main.ts:5620`）的 `installed` 恒为 `false`；**无**分项健康诊断（无 Guardian）。
- **对应测试**：`desktop/src/companyclaw/first-run-init.test.ts`（17 条）。
- **状态**：`Code = PARTIAL`，`Unit = PASS`，`Packaged = UNVERIFIED`（B4），`Real E2E = BLOCKED`（B1）。

### G04｜受控 Browser 只有策略/缺真正执行回路

- **真实文件**：`desktop/src/companyclaw/policy/browser-policy.ts`（138 行）、`desktop/src/companyclaw/runtime.ts`
- **稳定符号**：`BrowserPolicy.authorize()`、`classifyBrowserAction()`、`isDomainAllowed()`、`normalizeDomain()`、`CompanyClawRuntime.authorizeBrowserAction()`、`describeBrowserPolicy()`、`configureBrowser()`
- **当前行为**：域名点边界白名单、仅 `http`/`https`、未知动作归写、`click` 归写、`upload`/`download` 独立开关默认关闭、`delete`/`publish`/`pay` 归 high-risk；`authorizeBrowserAction` 双闸门（远程授权 + 策略）并区分失败原因。
- **未完成**：`authorizeBrowserAction()` 的调用方**只有 `runtime.test.ts`**；无 Browser 适配器/执行器/回读；无工作 Profile 管理；仓库无 CDP/Playwright 依赖。
- **对应测试**：`desktop/src/companyclaw/policy/browser-policy.test.ts`、`runtime.test.ts` 相关 5 条。
- **状态**：`Code = PARTIAL`（策略层 PRESENT，执行层 MISSING），`Unit = PASS`，`Packaged = UNVERIFIED`，`Real E2E = BLOCKED`（B2）。

### G05｜微信可信入站→任务状态机和来源缺真正接线

- **真实文件**：`plugins/openclaw-weixin/src/messaging/desktop-bridge.ts`、`process-message.ts`、`plugins/openclaw-weixin/index.ts`、`desktop/src/main.ts:4242`
- **稳定符号**：`publishSessionSource()`、`forwardApprovalReply()`、`installDesktopBridgeListener()`、`processOneMessage()`、`main.ts` 的 `lastInputFromRemote`（561）、`cachedRemoteSource`（562）
- **当前行为**：插件侧**生产者已存在**（ADR 0003 落地），桌面侧消费者把 `session-source` 只缓存为 `cachedRemoteSource` + 全局布尔 `lastInputFromRemote`。
- **未完成**：全局布尔**不是**安全依据（需求 §12.2 明令）；消息**不创建任务**（`CompanyClawRuntime.createTask()` 与 `TaskOrchestrator` 均无生产调用方，仅测试引用）；无 `messageId` 去重；无 `deviceId` 绑定。
- **对应测试**：`plugins/openclaw-weixin/src/messaging/desktop-bridge.test.ts`（12 条）、`desktop/src/companyclaw/companyclaw-core.test.ts`。
- **状态**：`Code = PARTIAL`，`Unit = PASS`，`Packaged = UNVERIFIED`，`Real E2E = BLOCKED`（B1）。

### G06｜微信写入审批在插件和执行层未完全闭环

- **真实文件**：`desktop/src/main.ts:4210`（入站分支）、`desktop/src/companyclaw/runtime.ts`、`desktop/src/companyclaw/approvals/approval-store.ts`、`desktop/src/companyclaw/policy/approval-ticket.ts`、`desktop/src/companyclaw/bridge/execution-bridge.ts`、`desktop/src/companyclaw/remote/approval-message.ts`
- **稳定符号**：`applyApprovalReply()`、`buildApprovalMessage()`、`issueTicketForApproval()`、`CompanyClawRuntime.execute()`、`ExecutionBridge.execute()`、`verifyApprovalTicket()`、`consumeAllowOnce` 等价的 `consumedNonces`
- **当前行为**：入站审批回复**已接通**（`isRemoteCallerAuthorized` → `applyApprovalReply`，且总是 `child.send` 应答避免插件等待）；票据为短时 HMAC 一次性 + nonce 集合防重放；执行桥在 transport 之前做 R0–R3 判定与票校验。
- **未完成**：`buildApprovalMessage()` **无任何调用方**（出站卡片发不出去）；`CompanyClawRuntime.execute()` **无生产调用方**（执行层闭环未接线）。
- **对应测试**：`approval-store.test.ts`、`approval-ticket.test.ts`、`execution-bridge.test.ts`、`requirement-invariants.test.ts`（含重放与 R3 拒绝）。
- **状态**：`Code = PARTIAL`，`Unit = PASS`，`Packaged = UNVERIFIED`，`Real E2E = BLOCKED`（B1）。

### G07｜报表产物→微信文件真实传递未落地

- **真实文件**：`desktop/src/companyclaw/results/{artifact-validator.ts,delivery-status.ts,task-artifacts.ts}`、`plugins/openclaw-weixin/src/messaging/send-media.ts`
- **稳定符号**：`validateArtifact()`、`detectMime()`、`advanceWithReceipt()`、`buildTaskArtifactDir()`、`isPathInsideTaskDir()`、`sanitizeArtifactFileName()`、`sendWeixinMediaFile()`
- **当前行为**：产物校验（存在/非空/大小/魔数/MIME/非目录）、每任务目录包含性检查、文件名规范化、送达状态机（`SEND_REQUESTED → SENT → (DELIVERED) → FAILED/UNKNOWN`）均已实现并测试；插件侧媒体发送函数已存在（按 MIME 路由 video/image/file）。
- **未完成**：`validateArtifact()` 与 `advanceWithReceipt()` **无生产调用方**；桌面侧唯一微信出站是 `main.ts:3165 sendWeixinNotification()` 的**纯文本** HTTP 直发；**无**跨进程取件与发送回路。
- **对应测试**：`artifact-validator.test.ts`（6）、`delivery-status.test.ts`（5）、`task-artifacts.test.ts`、`requirement-invariants.test.ts` 相关项。
- **状态**：`Code = PARTIAL`，`Unit = PASS`，`Packaged = UNVERIFIED`，`Real E2E = BLOCKED`（B1）。

### G08｜安装升级、故障恢复和 E2E 未形成发行证据

- **真实文件**：`docs/companyclaw/evidence/`（**不存在**）、`desktop/electron-builder.yml`、`desktop/src/companyclaw/installer-scope.test.ts`
- **稳定符号**：`nsis: perMachine:false / allowElevation:false`、`installer-scope.test.ts` 的 6 条断言、`runtime-manifest.ts` 的 `verifyRuntimeManifest()`
- **当前行为**：Per-User + 禁提权 + 无 Defender 例外 + 卸载保留数据已由测试钉住；`main.ts:reportRuntimeIntegrity()` 在打包态校验 manifest 并输出中文告警。
- **未完成**：无安装包产物（B4/B6）；无升级/回滚判定逻辑；`docs/companyclaw/evidence/` 为空；PKG-01–10 与 E01–20 全部未执行。
- **对应测试**：`installer-scope.test.ts`（6）、`scripts/test_companyclaw_installer_policy.py` 等 Python 用例。
- **状态**：`Code = PARTIAL`，`Unit = PASS`，`Packaged = FAIL/UNVERIFIED`，`Real E2E = BLOCKED`（B1/B2/B4/B6/B7）。

---

## 3. 需求旧描述 → 源码事实（4 处修订）

需求 §1.1 的线索生成于 2026-10-09，其中 4 条已被 V2（基线 `929a995` 之后）修复。按"实际源码与可重复测试证据优先于任何旧行号、旧进度描述"，记录如下，**不降低验收要求**：

| 需求旧描述 | 源码事实 | 本轮处理 |
|---|---|---|
| `desktop/package.json` 的 `dist` 只调 `prepare-windows-node-resources`，`dist:msix` 才调完整 `prepare-resources` | `package.json:14-17`：`dist` = `release:win` = `prepare-production-resources` + `build` + `electron-builder --win`；`pack` 亦走同一入口 | 已满足，不再修改；保留测试断言防回退 |
| `electron-builder.yml` 未发现 `companyclaw-broker` 的 `extraResources` | `electron-builder.yml` 已含 `resources/companyclaw-broker/dist/` 与 `/scripts/` 两项 | 已满足；Step 4 只新增插件与 agent-skills |
| `broker-client.ts` 用 `spawnProcess(process.execPath, ...)` | `broker-client.ts:121`：`const command = this.options.nodePath ?? process.execPath;`，且 `main.ts` 传入 `resolveNodePath()` | 已满足；Step 6 只补前置校验与错误码 |
| `prepare-resources.mjs` 含直接重建资源目录逻辑，应改为隔离 staging | 生产脚本 `prepare-production-resources.mjs` **已是** staging + hash 复校验 + rename 原子交换 + 失败清理；仍全量 `rmSync(resourcesDir)` 的是 legacy `prepare-resources.mjs`（仅挂 `npm run prepare-resources`，不在发行链） | 生产路径已满足；Step 5 补负向判据，Step 16 标注 legacy 状态 |

**Browser 误判修订（需求 §1.4 特指）**：Python 安装器 `deployer/` 中的浏览器相关配置**不算** Electron 生产 Browser 执行器；Electron 侧 `first-run-init.ts` 仅写 `browser.enabled` 与 `browser.executablePath`，**无执行器**。与 G04 结论一致。

---

## 4. 现有 `IMPLEMENTATION_STATUS.md` / `BLOCKERS.md` 条目复核

以下逐条判断"是否仍然成立"（保留历史原文，不覆盖）：

| 来源条目 | 是否仍成立 | 依据 |
|---|---|---|
| IMPL §4-3「浏览器实际驱动缺失，`skills/` 无 playwright/chromium」 | **成立** | `authorizeBrowserAction` 仅测试引用；`skills/` 无 playwright 依赖 |
| IMPL §4-4「`TaskOrchestrator` 与 `CompanyClawRuntime.execute()` 仍无生产调用方」 | **成立** | 符号检索确认仅测试引用 |
| IMPL §4-5「`describe-element` / `wait-for-window` 仍为 not-implemented」 | **成立** | `broker/server.ts:424` 返回 `not-implemented`；`server.test.ts:329` 有对应断言 |
| IMPL §4-6「微信审批出站卡片尚需接入」 | **成立** | `buildApprovalMessage()` 零调用方 |
| IMPL §4-7「安装包产出受 B4/B6 影响」 | **成立** | 本机无 .NET SDK；无签名证书 |
| IMPL §4-8「E01–E20 需目标环境」 | **成立** | 无微信账号、无内网系统 |
| IMPL §3「Python 全量 2 个既有 error（Python 3.11 缺 `rmtree(onexc=)`）」 | **成立** | 本机 Python 3.11.9 |
| BLOCKERS B1（无微信测试账号） | **成立** | 本机未绑定任何微信账号 |
| BLOCKERS B2（无内网系统/脱敏数据） | **成立** | 无测试站点配置 |
| BLOCKERS B4（无 .NET SDK） | **成立** | `dotnet --list-sdks` 为空，仅 runtime 8.0.27 |
| BLOCKERS B5（子模块未初始化） | **不再成立** | 本轮 `git submodule status` 显示已 checkout `fc9add75` |
| BLOCKERS B6（无签名证书） | **成立** | 无证书 |
| BLOCKERS B7（非管理员会话） | **成立** | `IsAdmin=False` |
| BLOCKERS B8（本机无 OpenClaw 运行时，dev 模式） | **成立** | 候选路径均 missing；`npm ls -g` 无 openclaw |

**新增发现（需求与文档均未记录）**：
1. 发行包**不含**微信插件与 agent-skills → 打包后 `plugin:weixin:installed` 恒为 `false`（G01+G03 交叉缺口，直接影响员工扫码）。
2. `broker-client` 的 `isRunning()` 在子进程死后仍返回 true（端口未清零）。
3. `plugins/openclaw-weixin` 仓库侧**无 `dist/` 且无 tsconfig**，而 vendored tarball 的 `dist/` **不含**我们的 `desktop-bridge.ts` 补丁 → 直接发布 tarball 的 dist 会丢失 CompanyClaw 桥接。

---

## 5. 结论

- 安全内核（策略/票据/状态机/审批/产物校验）均为 `PRESENT` 且有测试，本轮**不重写**。
- 8 个缺口中 G01/G02/G03/G05/G06/G07 **主体是"接线"**（能力已存在但无生产调用方），G04/G08 需要部分新增。
- 本机可完成：代码 + 单元测试 + 类型检查 + Lint + broker 实机 UIA 用例。
- 本机**不可**完成：打包态验证（B4）、真实微信（B1）、内网业务系统（B2）、签名与干净机安装（B6/B7）→ 一律记 `BLOCKED`/`UNVERIFIED`。
