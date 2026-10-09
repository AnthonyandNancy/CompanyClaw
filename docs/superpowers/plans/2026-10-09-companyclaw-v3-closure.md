# CompanyClaw V3.0 闭环收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本计划是 `docs/CompanyClaw__修改实施书3.0.md`（需求，747 行）在**当前实际源码基线**上的落地文档。
> 遇到需要扩大修改范围时必须先输出 Plan Adjustment 并停下等待确认（见文末）。

**Goal:** 让 CompanyClaw 从"策略层完备、执行层无生产调用方"变成"资源完整、执行通路真实存在"的可发行状态，员工侧始终只需安装一个 EXE、配置个人模型、扫码微信。

**Architecture:** 保留既有分层——`desktop/src/companyclaw/**` 是唯一授权裁决点（`CompanyClawRuntime`），`broker/**` 是独立受限执行器并做服务端二次校验，`plugins/openclaw-weixin/**` 只做可信来源转发而不做裁决。本次不新增第二套 Agent/Broker/安装器，只把已存在但**没有生产调用方**的执行链路（`runtime.execute` / `BrokerClient.call` / `authorizeBrowserAction` / `TaskOrchestrator` / `validateArtifact` / `buildApprovalMessage`）接起来，并把发行资源装配补全。

**Tech Stack:** TypeScript 5.9（desktop 主进程 CommonJS / broker 独立项目）、Electron 33 + electron-builder 26（NSIS Per-User x64）、Vue 3 + Pinia + Element Plus（renderer）、Vitest 4、Node 26.7（构建与私有运行时）、PowerShell UIA 脚本、腾讯官方 `openclaw-weixin` 2.4.6（vendored）。

## Global Constraints

以下约束贯穿本计划每一个 Step，逐字来自需求与项目既有决策：

- 员工侧**唯一**要求：安装一个 EXE → 配置个人大模型 → 微信扫码；任何"请员工先装 Node/Python/.NET SDK/Git/OpenClaw/npm"的结论判为不合格。
- 不重新 Fork MicroClaw；不新建第二套 Electron 客户端、独立 Agent 或第二套 Broker；不重写已通过测试的现有协议。
- 保持 `appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`skills/**` 的原生语义，**不放开 MXC ingress**（`securityMode` 默认 `appcontainer`）。
- 安全内核不改弱：R3 无开关恒拒绝；`ExecutionBridge` 失败关闭；票据一次性 + nonce 防重放；loopback 不免鉴权。
- `main.ts` 只做装配、IPC 注册与既有生命周期管理；新业务策略写入 `desktop/src/companyclaw/` 独立模块。
- 腾讯插件改动最小化（只允许追加适配层），不做同一 channel 的双插件注册。
- 缺真实微信 / 内网系统 / 目标 Win11 / 签名证书时记 `BLOCKED` 或 `UNVERIFIED`，**不得写 PASS**，不得用 mock 冒充 E2E。
- 修改任何重要文件前先复制到项目根 `backups/`；本计划产生的临时测试文件用后移入回收站，不做永久删除。
- 提交粒度：每个 Step 一次提交，提交信息说明原因、影响文件、测试证据与是否改变公开接口。

## 基线事实（本计划成立的前提，均已核对）

| 项 | 值 |
|---|---|
| 分支 / HEAD | `feat/companyclaw-foundation` / `c6e090a`，工作树干净 |
| 子模块 | `third_party/openclaw-windows-node/source` = `fc9add75`（已 checkout） |
| OpenClaw 锁定版本 | `2026.9.3`（`deployer/openclaw_version.py`） |
| 本机环境 | 中文 Win11 26100、非管理员、Node v26.7.0、Python 3.11.9、**无 .NET SDK**、UIA 可用 |
| 现有测试 | desktop 75 files/1451、renderer 27/320、broker 8/54（含 9 项实机 UIA）、plugin 12 |

**需求文档与源码不一致的 4 处（按"源码事实优先"，只修描述，不降验收要求）：**

1. §1.1 "`dist` 只调 `prepare-windows-node-resources`，`dist:msix` 才调完整准备" → **已修复**：`dist` = `release:win` = `prepare-production-resources` + `build` + `electron-builder --win`。
2. §1.1 "未发现 `companyclaw-broker` 的 `extraResources`" → **已存在**（`extraResources` 含 `companyclaw-broker/dist|scripts`）。
3. §1.1 "`broker-client.ts` 使用 `process.execPath`" → **已改为 `nodePath`**（`adc0520`），含中文/空格路径与"无 nodePath 时回退"用例。
4. §1.1 "`prepare-resources.mjs` 含直接重建资源目录逻辑，应改为 staging" → 生产脚本 `prepare-production-resources.mjs` **已是 staging + hash 校验 + rename 原子交换**；仍全量 `rmSync(resourcesDir)` 的是 legacy `prepare-resources.mjs`（仅挂在 `npm run prepare-resources`，不在发行链）。

---

## 需求 C00–C12 → Step 映射（全覆盖核对）

| 需求阶段 | 落点 Step | 说明 |
|---|---|---|
| C00 基线与影响面 | Step 1 | 只落盘文档 |
| C01 统一依赖锁定与资源装配 | Step 2、3、4、5 | 装配 + 插件/技能产物 + extraResources + 负向判据 |
| C02 私有 Node / Broker 生产启动 | Step 6、7 | 校验码 + 生命周期/重启上限 |
| C03 Gateway 与插件生产运行 | Step 8、9 | 插件落盘 + 分项诊断 |
| C04 NSIS 自包含与清洁机安装 | Step 2、4、5（装配完整性）+ Step 16（PKG 证据与未签名标注） | 安装行为（Per-User/无提权/无 Defender 例外）已由既有 `installer-scope.test.ts` 钉住，本次**不改**；缺件即构建失败由 Step 2/5 保证 |
| C05 首次引导 | Step 10 | 4 步向导 |
| C06 Browser 实际受控执行 | Step 11 | ADR + 适配器 |
| C07 UIA 生产操作与混合任务 | Step 12 | transport + 两个操作 + 独占锁 |
| C08 微信入站→任务→双向审批 | Step 13 | 可信上下文 + 任务 + 出站卡片 |
| C09 文件成果真回传 | Step 14 | 校验 + 发送闭环 |
| C10 生命周期/隔离/升级 | Step 15 | 升级判定 + 派发前复查 |
| C11 PKG-01–10 / E01–20 实机 | Step 16（索引）+ 外部环境 | 真实状态一律 `BLOCKED`/`UNVERIFIED` |
| C12 发行与文档收敛 | Step 16 | 必交文件清单 |

---

# 1. Goal

### 本次修改目标

1. **C01 资源装配完整化**：把**微信插件**、**agent-skills**、**windows-node** 纳入唯一生产资源流水线与 `runtime-manifest.json`，缺件即构建失败。
2. **C02 Broker 生产启动加固**：私有 `node.exe` 与 `broker/dist/main.js` 前置校验 + 明确错误码；子进程退出检测、重启上限、停止收口（无孤儿）。
3. **C03 Gateway/插件生产运行**：首启把包内插件落到 `${stateDir}/extensions/openclaw-weixin`（经官方 `plugins install`，使 `plugins.installs` 有真实来源），并新增分项健康诊断。
4. **C05 首次向导**：补"环境自检"与"开启远程操作"两步，员工侧不出现任何 CLI/JSON 步骤。
5. **C06/C07/C08/C09 执行通路接线**：为 `authorizeBrowserAction` / `runtime.execute` / `BrokerClient.call` / `TaskOrchestrator` / `validateArtifact` / `buildApprovalMessage` 建立**真实生产调用方**，并把全局布尔 `lastInputFromRemote` 替换为按消息绑定的可信上下文。
6. **C10 生命周期与隔离**：升级/失败恢复不丢凭据与任务历史；远程授权关闭后不派发新动作。
7. **C00/C11/C12 证据与文档**：基线、影响面、证据索引、发行说明落盘；外部条件缺失项如实标注。

### 不包含的内容（本计划明确不做）

- 不产出正式签名安装包，不做 PKG-01–10 与 E01–20 的**真实**实机验收（受 B1 微信账号、B2 内网系统、B4 .NET SDK、B6 签名、B7 目标机阻塞）。
- 不改 `appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`skills/**`。
- 不改腾讯插件核心逻辑（`src/{api,auth,cdn,config,media,monitor,storage,util}/**` 一行不动）。
- 不重构 `main.ts`、`deployer/**`、`installer/**`；不删除 V1/V2 文档与旧测试编号。
- 不为未来功能预留抽象（不提前做多设备路由、任务模板、报表编排框架）。
- 不引入新的第三方运行时依赖（若某 Step 必须新增，先 Plan Adjustment）。

### 成功标准

| # | 判据 | 证据 |
|---|---|---|
| S1 | `npm run release:win` 产出的 `desktop/resources/` 含 `node.exe` / `openclaw.asar` / `windows-node/` / `companyclaw-broker/{dist,scripts}` / `openclaw-weixin/`（含 `dist/` 与 `node_modules/{zod,qrcode-terminal}`）/ `agent-skills/`，且 `runtime-manifest.json` 覆盖以上全部 | 流水线 stdout + manifest 打印 + 单测 |
| S2 | 移除任一关键资源后同一命令**失败**且旧 `resources/` 完好 | 单测 + 本机实跑 |
| S3 | 打包态 Broker 由 `resources/node.exe` 启动；缺件时返回 `BROKER_RUNTIME_NOT_FOUND` / `BROKER_ENTRY_INVALID`；被 kill 后不产生孤儿、重启不超过上限 | 单测（现有 `broker-client-spawn.test.ts` 扩展） |
| S4 | 首启后 `plugin:weixin:get-status` 的 `installed`/`enabled` 为真且插件来自包内 | 单测 + 打包态手工核对（真机扫码仍 BLOCKED） |
| S5 | 向导显示 4 步且全部中文、无 CLI 指令；远程操作默认关闭、需本人开启 | renderer 单测 + 手工核对 |
| S6 | 每个执行器入口都有生产调用方：任务动作 → policy → (票据) → Broker/Browser → 回读；未授权/无票据在**执行层**被拒 | 单测（含负向）+ 代码检索无"仅测试引用" |
| S7 | 微信入站消息带不可由文本自报的 `TrustedRemoteContext`（含 `messageId`/`deviceId`/`ownerSid`） | 单测（含"用户文本冒充来源"负向） |
| S8 | 既有测试零回归：desktop 1451、renderer 320、broker 54、plugin 12 | 各命令退出码 0 |
| S9 | `IMPLEMENTATION_STATUS.md` / `BLOCKERS.md` / `docs/companyclaw/v3/**` 与源码一致，且未成熟的项仍为 `PARTIAL`/`BLOCKED` | 文档核对 |

---

# 2. Current Understanding

### 当前实现方式（源码事实）

**安全内核（消费方只有 IPC）**：`desktop/src/companyclaw/runtime.ts` 的 `CompanyClawRuntime`（628 行）承载任务状态机、审批票据、执行桥、Browser 策略、身份绑定、远程授权、产物校验。`ipc.ts` 注册 17 个 `companyclaw:*` 通道（`ipc-contract.test.ts` 断言数量与 preload 一致）。

**无生产调用方的执行链路（本次要接的核心）**：

| 能力 | 定义位置 | 当前调用方 |
|---|---|---|
| `CompanyClawRuntime.execute()` | `runtime.ts:492` | 仅 `runtime.test.ts` |
| `BrokerClient.call()` | `broker-client.ts:220` | 仅测试 |
| `BrokerClient.start()` | `broker-client.ts:105` | 仅 `call()` 内部 → 即仅测试 |
| `authorizeBrowserAction()` | `runtime.ts:231` | 仅 `runtime.test.ts` |
| `TaskOrchestrator` | `tasks/task-orchestrator.ts:72` | 仅 `task-orchestrator.test.ts` |
| `validateArtifact()` | `results/artifact-validator.ts:76` | 仅 `artifact-validator.test.ts` |
| `advanceWithReceipt()` | `results/delivery-status.ts` | 仅 `requirement-invariants.test.ts` |
| `buildApprovalMessage()` | `runtime.ts:408` | **无任何调用方** |
| `installAgentOwnedSkills()` | `agent-owned-skills.ts:211` | 生产已接入（仅 `rednote-publisher`） |

**入站链路（已通）**：

```
plugins/openclaw-weixin/src/messaging/process-message.ts:74 processOneMessage
  ├─ slash 命令分支（上游既有）
  ├─ publishSessionSource → process.send({type:'session-source'})
  │    → desktop/src/main.ts:4242 仅缓存 cachedRemoteSource 与全局布尔 lastInputFromRemote
  ├─ forwardApprovalReply → process.send({type:'approval-reply-request'})
  │    → main.ts:4211 isRemoteCallerAuthorized() → runtime.applyApprovalReply()
  └─ 其余文本原样进 OpenClaw Agent
```

**Broker 现状**：`BrokerClient.startInternal()` 用 `options.nodePath ?? process.execPath` spawn `brokerDir/dist/main.js`，令牌经环境变量 `COMPANYCLAW_BROKER_TOKEN` 传递（不进 argv），stdout 首行 JSON 报端口，60s 超时。**无** `existsSync` 前置校验、**无** 退出监听、**无** 重启上限。`broker/server.ts:424` 对 `describe-element` / `wait-for-window` 返回 `not-implemented`。

**装配现状（`desktop/scripts/prepare-production-resources.mjs`，311 行）**：已有 staging + manifest + hash 复校验 + rename 原子交换 + 失败清理。已装配 `node.exe`、`openclaw.asar`（npm 装锁定版后打包，删源树）、`windows-node/`、`companyclaw-broker/{dist,scripts}`。**未装配**：微信插件、agent-skills（除 `extraResources` 里的 `rednote-publisher`）；`windows-node` 只复制**未登记** manifest。

**插件打包现状（关键缺口）**：仓库 `plugins/openclaw-weixin/` = vendored tarball 内容 + 我们的 2 处补丁（`src/messaging/desktop-bridge.ts` 新增、`process-message.ts` 与 `index.ts` 追加）。tarball 内自带 `dist/`（36 个编译产物）**但不含我们的补丁**；仓库侧**无 `dist/`、无 tsconfig**。桌面侧**无任何代码**把插件写入 `${stateDir}/extensions/`，也**无写入方**产生 `config.plugins.installs["openclaw-weixin"]`——即打包后 `plugin:weixin:get-status` 的 `installed` 恒为 false。legacy `deployer/windows_setup.py:3981` 用 `openclaw plugins install --force <dir>` 完成安装，员工主线（NSIS）没有对应实现。

### 数据流 / 调用链（目标态要经过的层）

```
用户/微信消息 → main.ts(IPC 或 gateway 子进程消息) → CompanyClawRuntime(唯一裁决)
   → TaskStore(状态机) → ExecutionBridge(R0–R3 + 票据) → BridgeTransport
        ├→ BrowserAdapter（OpenClaw 原生 Browser，经 domain/action 策略）
        └→ BrokerClient.call() → broker/server.ts（服务端二次校验）→ PowerShell UIA
   → 回读校验 → 产物目录 jobs/<taskId>/artifacts → 送达状态机 → 微信出站
```

### 涉及模块

`desktop/scripts/prepare-production-resources.mjs`、`desktop/electron-builder.yml`、`desktop/package.json`、`desktop/src/main.ts`（仅装配点）、`desktop/src/companyclaw/**`（新增 `guardian.ts`、`bridge/broker-transport.ts`、`browser/browser-adapter.ts`、`remote/trusted-context.ts`、`plugins/weixin-plugin-install.ts`）、`desktop/src/companyclaw/ipc.ts`、`desktop/src/preload.ts`、`desktop/renderer/src/{views/SetupWizard.vue,stores/companyclaw.ts,views/TasksView.vue}`、`desktop/src/companyclaw/broker-client.ts`、`broker/server.ts`（+ 对应 `.ps1`）、`plugins/openclaw-weixin/src/messaging/{desktop-bridge.ts,process-message.ts}`。

### 已确认的影响范围

直接修改 14 个既有文件 + 新增 8 个文件（见第 4 节）；确认不动 `appcontainer/**`、`windows-node-host/**`、`windows-node-mxc*.ts`、`skills/**`、插件上游核心、`deployer/**`。

---

# 3. Implementation Steps

### Step 1：C00 基线与影响面落盘（无代码变更）

**Target**
- 新增 `docs/companyclaw/v3/01-current-baseline.md`
- 新增 `docs/companyclaw/v3/02-impact-map.md`

**Current Behavior**
`docs/companyclaw/v3/` 目录不存在；G01–G08 的现状只散落在 `IMPLEMENTATION_STATUS.md`（基线 `929a995`）与上一轮对话中，未按需求 §1.4 的格式落盘。

**Change**
1. `01-current-baseline.md`：分支/HEAD/工作树/子模块/remote/OS/PowerShell/Node/SDK/网络可达性；G01–G08 每项写"真实文件路径 + 稳定符号名 + 当前行为 + 已完成/未完成 + 对应测试"（行号只作辅助）；记录上文 4 条"旧描述 → 源码事实"修订；逐条标注 `IMPLEMENTATION_STATUS.md` 与 `BLOCKERS.md` 现有条目是否仍成立，保留历史不覆盖。
2. `02-impact-map.md`：文件 → 调用入口 → 调用出口 → 修改点 → 测试 → 风险。

**Reason** 需求 §1.4 与 §C00-G 闸门要求；让下一个 Agent 不必重复整轮调查。

**Risk** 只写文档、无代码验证；若与源码漂移则误导后续。缓解：每条结论附路径与符号名，不写行号依赖。

**Verification** `ls docs/companyclaw/v3/01-current-baseline.md docs/companyclaw/v3/02-impact-map.md`；G01–G08 八项齐全；随机抽 5 条符号名用 `rg` 能在源码命中。

---

### Step 2：C01a 统一流水线纳入插件、skills 与 windows-node manifest

**Target**
- Modify: `desktop/scripts/prepare-production-resources.mjs`（新增 stage 5/6/7；扩展 `entries`）

**Current Behavior**
脚本 Stage 2d 复制 `windows-node` 到 staging 但不写 manifest 条目；Stage 2e 复制 broker dist/scripts 并逐 `.ps1` 登记。插件与 agent-skills 完全不装配；`entries` 只有 `node` / `openclaw` / `broker`（3 + N 条）。

**Change**
1. 新增 Stage 5「微信插件」：把 `plugins/openclaw-weixin/`（`index.ts`、`src/**`、`package.json`、`openclaw.plugin.json`、`LICENSE`、`README*`、`CHANGELOG*`、`vendor/*.tgz`）复制到 `stagingDir/openclaw-weixin/`；**编译 `dist/`**（见 Step 3）；安装运行期依赖（见 Step 3）。
2. 新增 Stage 6「agent-skills」：复制 `skills/{excel-xlsx,word-docx,powerpoint-pptx,officecli,desktop-organizer,security-practice,rednote-publisher}` 到 `stagingDir/agent-skills/`，与 `agent-catalog.ts` 的 `SHARED_SKILL_IDS ∪ AGENT_OWNED_SKILL_IDS` 中**实际存在于 `skills/`** 的集合逐一对齐；集合缺一即失败。
3. 新增 Stage 7「windows-node manifest 登记」：递归枚举 `stagingDir/windows-node/**`，为每个文件写 `kind: "windows-node"`、`version` 取 `windows-node/RUNTIME.json` 的 `mxcVersion`、`license` 取 `third_party/openclaw-windows-node/LICENSE` 说明。
4. `entries` 追加：插件侧逐个文件 `kind: "plugin"`；`agent-skills/**` 逐个文件 `kind: "skill"`；同时保留既有 3 条与 `.ps1` 条目。
5. 装配期断言（在写 manifest 之前）：插件目录必须含 `package.json`、`openclaw.plugin.json`、`dist/index.js`、`dist/src/messaging/desktop-bridge.js`；每个 skill 目录必须含 `SKILL.md`。任一缺失 `throw`。

**Reason** 需求 §5.2/§5.4 要求"全部 extraResources 与可执行辅助文件列入，打包前后分别校验"；`runtime-manifest.ts` 的 `RuntimeResourceKind` 已预留 `plugin` / `skill` / `windows-node` 三个 kind，当前无人写入。

**Risk** manifest 条目数从 ~10 增至数百，`verifyRuntimeManifest` 在启动时逐文件 `sha256` 可能拖慢首启（约 300+ 个小文件，量级可控，但需实测）；插件被逐文件登记后，未来插件升级必须同步 manifest（正是 S2 要证明的行为）。缓解：Step 5 记录首启校验耗时。

**Verification** 本机跑 `cd desktop && npm run prepare-production-resources`（预期在 `dotnet publish` 处因 B4 失败，但**失败前**打印应显示插件与 skills 已 stage）；单测断言 manifest 覆盖 `windows-node/**`、`openclaw-weixin/package.json`、`agent-skills/excel-xlsx/SKILL.md`。

---

### Step 3：C01b 插件运行时产物（把我们的补丁编译为可加载的 dist 与离线依赖）

**Target**
- Modify: `desktop/scripts/prepare-production-resources.mjs`（新增 `buildWeixinPluginDist()` 与 `installWeixinPluginDeps()` 两个局部函数）

**Current Behavior**
仓库插件无 `dist/`、无 tsconfig；vendored tarball 的 `dist/` 是**未含补丁**的旧产物（tarball 内无 `desktop-bridge.ts`）。OpenClaw 宿主按 `package.json#openclaw.runtimeExtensions = ["./dist/index.js"]` 加载，缺 `dist/` 会报 `requires compiled runtime output for TypeScript entry index.ts`。插件的真实运行期导入：`zod`（`src/config/config-schema.ts` 静态 import）、`qrcode-terminal`（`src/auth/login-qr.ts` 动态 import）、`openclaw/plugin-sdk/*`（宿主提供）。

**Change**
1. `buildWeixinPluginDist()`：用 **desktop 已有的** TypeScript（`desktop/node_modules/typescript/bin/tsc`，实测 5.9.3）以**临时生成的 tsconfig**（写入 staging，不提交仓库）编译 `plugins/openclaw-weixin/{index.ts,src/**/*.ts}`（排除 `*.test.ts` 与 `src/**/*.test.ts`）到 `stagingDir/openclaw-weixin/dist/`；关键编译选项：`module: "esnext"`、`moduleResolution: "bundler"`、`target: "es2022"`、`skipLibCheck: true`、`noCheck: true`（仅转译、不做类型检查，避免为宿主类型引入新依赖）、`outDir`、`rootDir` 指向插件目录、`declaration: false`。
2. 编译后断言 `dist/index.js` 与 `dist/src/messaging/desktop-bridge.js` 存在，否则 `throw`。
3. `installWeixinPluginDeps()`：用构建机 `npm`（`resolveNpmCli()` 既有）以 `--prefix` 安装 **vendor 内的 tgz**，实现完全离线：`npm install --prefix <staging>/openclaw-weixin --omit=dev --omit=peer --legacy-peer-deps --no-package-lock --no-save --ignore-scripts <vendor>/zod-4.4.3.tgz <vendor>/qrcode-terminal-0.12.0.tgz`。`--omit=peer` + `--legacy-peer-deps` 用于**阻止 npm 自动联网安装 `peerDependencies.openclaw`**。安装后断言 `node_modules/zod/package.json`、`node_modules/qrcode-terminal/package.json` 存在。
4. `stagingDir/openclaw-weixin/package.json` 保持原样（不改版本、不改 `openclaw` 字段），确保后续 `openclaw plugins install` 能读到 `runtimeExtensions`。

**Reason** 需求 §5.1 要求"预装配、固定版本并打包"且"员工机首次启动不执行 npm install"；插件补丁是我们闭环的一部分，不能只发上游旧 dist。

**Risk** ① `noCheck: true` 依赖 TS ≥5.6（本机 5.9.3 满足，但构建机版本需固定/校验）→ 增加一条 `tsc --version` 下限断言。② 编译产物与原 tarball `dist/` 可能存在差异（ESM 说明符、`.js` 后缀）→ 用 `dist/index.js` 实际 `node -e "import()"` 冒烟验证 `register` 导出存在（宿主 API 不可用，仅验证模块可加载）。③ 若 OpenClaw 宿主对 `dist/` 有额外产物期望，风险在 Step 8 打包态验证时暴露。

**Verification** 单测断言 tsconfig 关键字段与两条 `npm install` 参数（`--omit=peer`、`--legacy-peer-deps`）存在于脚本源码；本机跑流水线后 `node --input-type=module -e "await import('file:///<staging>/openclaw-weixin/dist/index.js')"` 不抛模块解析错误（`openclaw/plugin-sdk/*` 无法解析属预期，仅确认我们自己的产物路径正确，因此该冒烟改为静态检查 `dist/src/messaging/desktop-bridge.js` 内含 `publishSessionSource`）。

---

### Step 4：C01c extraResources 契约对齐

**Target**
- Modify: `desktop/electron-builder.yml`
- Modify: `desktop/src/companyclaw/extra-resources-contract.test.ts`

**Current Behavior**
`extraResources` 只有 `../skills/rednote-publisher/` → `agent-skills/rednote-publisher/`；插件、其余 6 个 skill 不在包内。`extra-resources-contract.test.ts` 用**三分组**（流水线产物申报 / 构建产物申报 / 检出内必需并断言存在）校验每个来源，并用 `product-identity.test.ts` 钉住"不得出现 `from: resources/openclaw/"`。

**Change**
1. 把 `- from: ../skills/rednote-publisher/` 替换为 `- from: resources/agent-skills/` → `to: agent-skills/`（改由流水线统一 stage，保持"单一装配入口"；`agent-owned-skills.ts:207` 的 `resolveAgentOwnedSkillBundleRoot` 已读 `resources/agent-skills`，路径不变）。
2. 新增 `- from: resources/openclaw-weixin/` → `to: openclaw-weixin/`。
3. `extra-resources-contract.test.ts` 的两个来源改归"流水线产物"组，并按既有断言结构登记。
4. 保持 `files:`、`nsis:`、`win:`、`appx:` 段不动。

**Reason** 需求 §5.2："全部 extraResources 与可执行辅助文件列入，打包前后分别校验"；`resources/agent-skills` 与 `resources/openclaw-weixin` 是流水线产物，必须由同一入口装配，避免第二个事实来源。

**Risk** `product-identity.test.ts` 断言"不得包含 `resources/openclaw/`"（前缀会匹配 `resources/openclaw-weixin/`？——该断言用的是具体字符串 `from: resources/openclaw/`，带斜杠，不会被 `openclaw-weixin` 误命中，但**必须实跑确认**）。缓解：改完立即跑 `npx vitest run src/companyclaw/product-identity.test.ts src/companyclaw/extra-resources-contract.test.ts`。

**Verification** 上述两条测试通过；`rg -n 'from: resources/(agent-skills|openclaw-weixin)/' desktop/electron-builder.yml` 命中 2 条。

---

### Step 5：C01d 流水线负向测试与构建期失败判据

**Target**
- Modify: `desktop/src/companyclaw/production-resources.test.ts`
- 新增: `desktop/src/companyclaw/resource-pipeline.test.ts`（纯逻辑，读脚本源码 + 临时目录）

**Current Behavior**
`production-resources.test.ts` 只有 4 条静态断言（入口、stage 组件名、不删 live 目录、版本真源），没有"缺件即失败""篡改后失败""残留 staging 不被误用"的判据。

**Change**
1. 扩展静态断言：脚本必须包含插件与 skills 的装配标记（`openclaw-weixin`、`agent-skills`）与三条断言字符串（`package.json`/`SKILL.md`/`dist/src/messaging/desktop-bridge.js`）。
2. 新增负向单测（不依赖真实构建）：在 `os.tmpdir()` 下造一个假的 `staging` 形状，调用 `verifyRuntimeManifest()` 断言三种失败各自返回预期 problem 关键字——`missing:`（缺件）、`hash-mismatch:`（篡改）、`entry-duplicated:`（重复）；再断言脚本源码含 `discardStaging` 与 `.staging-` 前缀清理逻辑（残留 staging 不被误用）。
3. 新增一条测试：`electron-builder.yml` 中每个 `from: resources/...` 来源，其 `to:` 目标路径必须与 `runtime-manifest.ts` 校验时使用的 `process.resourcesPath` 相对布局一致（即 `to` 不得加前缀目录）。

**Reason** 需求 §5.6 与 §17.1 第 1、2 行的硬性要求（"任意缺少 node.exe/OpenClaw 真入口/微信插件/broker/dist/main.js 或必要 UIA 脚本：构建立即失败"；"修改 Broker 产物内容而不更新 manifest：验证失败"）。

**Risk** 单测无法覆盖真实 527MB staging 场景（本机受 B4 阻塞）；负向用例基于 `verifyRuntimeManifest` 这一**已存在**的纯函数，覆盖到"校验语义"，真实流水线失败仍由 Step 2 的 `throw` 保证。

**Verification** `cd desktop && npx vitest run src/companyclaw/resource-pipeline.test.ts src/companyclaw/production-resources.test.ts` 全绿；三态 problem 关键字断言逐条通过。

---

### Step 6：C02a Broker 运行时与入口的显式校验

**Target**
- Modify: `desktop/src/companyclaw/broker-paths.ts`（新增解析器）
- Modify: `desktop/src/companyclaw/broker-client.ts:116`（`startInternal()` 前置校验 + 错误码）
- Modify: `desktop/src/companyclaw/broker-paths.test.ts`、`desktop/src/companyclaw/broker-client-spawn.test.ts`

**Current Behavior**
`resolveBrokerDir()` 只解析 broker 目录，不解析私有 Node；`BrokerClient.startInternal()` 直接 `spawn(this.options.nodePath ?? process.execPath, [entry])`，文件不存在时只能等到 spawn 的 `error`/`exit` 事件才失败，错误语义是 `broker startup timed out` 或 `broker exited during startup with code 1`——不区分"运行时缺失"与"入口无效"。

**Change**
1. `broker-paths.ts` 新增 `resolveBrokerRuntimePaths({ isPackaged, resourcesPath, appPath, nodePathOverride? })` → `{ nodePath, brokerDir, entryPath }`；打包态 `nodePath = <resources>/node.exe`，开发态保持既有 `app.getAppPath()/../broker` 语义；保留 `resolveBrokerDir` 与 `resolveBrokerScriptDir` 签名不变（`ipc.ts` 与测试继续可用）。
2. `startInternal()` 在 spawn 前校验：`existsSync(nodePath)` → 否则 `throw new Error("BROKER_RUNTIME_NOT_FOUND: <path>")`；`existsSync(entryPath)` → 否则 `throw new Error("BROKER_ENTRY_INVALID: <path>")`。两类错误必须可被调用方按前缀识别（`message.startsWith`），并写入 `lastFailureReason`。
3. `main.ts` 的装配点（`resolveBrokerDir` 调用处）改用新解析器，把 `nodePath` 与 `brokerDir` 一并传入 `createCompanyClawRuntime`（现有字段名不变，仅来源改为同一个解析结果）。
4. 保留"无 `nodePath` 时回退 `process.execPath`"这一既有测试语义（源码 checkout / 单测可用），但打包态一律走 `resources/node.exe`。

**Reason** 需求 §6.2 第 3 条明确要求两个错误码；`resolveNodePath()` 已能解析 `resources/node.exe`，但**当前并不校验**、也不区分错误。

**Risk** `resolveNodePath()` 会沿候选链回落到系统 Node（`process.env.ProgramFiles\nodejs\node.exe`），这在打包态是**不受管理**的运行时；本次不改变回退顺序（避免影响 dev 与既有 10 条测试），但把它作为 Step 9 Guardian 的一项显式诊断输出，避免"看起来能跑"。

**Verification** `cd desktop && npx vitest run src/companyclaw/broker-paths.test.ts src/companyclaw/broker-client-spawn.test.ts`；新增用例：临时目录下缺 `node.exe` → 抛 `BROKER_RUNTIME_NOT_FOUND`；缺 `dist/main.js` → 抛 `BROKER_ENTRY_INVALID`；两者都**不产生 spawn 调用**（用既有 `spawnProcess` 注入断言零调用）。

---

### Step 7：C02b Broker 子进程生命周期与重启上限

**Target**
- Modify: `desktop/src/companyclaw/broker-client.ts`（退出监听、重启上限、`stop()` 收口）
- Modify: `desktop/src/companyclaw/broker-client-spawn.test.ts`、`ipc.ts`（状态字段透传，如需要）

**Current Behavior**
`child` 只在 `awaitPort()` 里监听一次性 `error`/`exit`；端口返回后**不再监听**退出，`isRunning()` 依据 `port > 0 && child !== null` 恒为真（进程死后仍报 alive）。`stop()` 只 kill 不加标记，`call()` 遇到不可达会再次 `start()`，无重启计数。

**Change**
1. spawn 成功后注册**常驻** `child.once("exit", ...)`：置 `this.port = 0`、`this.child = null`、`lastFailureReason = "broker exited (code=<c>)"`；若进程由 `stop()` 主动终止则不记为失败。
2. 新增 `private restarts = 0` 与常量 `MAX_BROKER_RESTARTS = 2`（模块内，不复用 `constants.ts`，避免影响 appcontainer 常量面）；`call()` 触发的自动重启在超限后返回 `{ ok:false, reason:"broker-restart-limit", unavailable:true }`，不抛异常。
3. `stop()` 置 `stopping = true`、`child.kill()`、等待 exit 或 5s 超时后 `child.kill("SIGKILL")`；`stopping` 期间禁止自动重启。
4. `getStatus()` 增加 `restarts` 字段（既有字段保持不变，`ipc.ts` 与 renderer `TasksView` 已消费 `running/nodePath/lastSuccessfulCallAt/lastFailureReason`，新增字段不破坏）。

**Reason** 需求 §6.2 第 6 条（"同一 SID 只能存在当前受控实例、健康检查、启动超时、退出检测、错误返回、重启上限、停止时资源收敛，避免孤儿进程"）。

**Risk** 退出监听与 `updateTargets()` 的"停-改-起"流程交互：`updateTargets` 会主动 `stop()` 再 `start()`，必须不被记入 `restarts` 上限，否则用户改白名单两次后 Broker 永久不可用。缓解：单测覆盖"updateTargets 两次后仍可 start"。

**Verification** 单测：模拟 child 发 exit → `isRunning()` 为 false 且 `lastFailureReason` 非空；连续 3 次失败重启 → 第 3 次返回 `broker-restart-limit`；`stop()` 后 exit 事件不触发重启；`updateTargets` 不计入上限。

---

### Step 8：C03a 首启把包内插件安装到 OpenClaw state dir

**Target**
- 新增: `desktop/src/companyclaw/plugins/weixin-plugin-install.ts`
- 新增: `desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts`
- Modify: `desktop/src/main.ts`（在 `ensureCompanyClawFirstRunConfiguration()` 之后、`startGateway()` 之前调用）

**Current Behavior**
桌面侧**没有任何**代码把插件放进 `${stateDir}/extensions/openclaw-weixin`，也没有写入方产生 `config.plugins.installs["openclaw-weixin"]`；`plugin:weixin:get-status`（`main.ts:5619`）因此恒报 `installed: false`。legacy deployer 用 `openclaw plugins install --force <dir>` + 完整备份/回滚事务实现，员工主线（NSIS）缺失。

**Change**
1. 新模块导出 `ensureWeixinPluginInstalled(input)`：入参 `{ resourcesPath, isPackaged, nodePath, entryPath, stateDir, runCli }`；`runCli` 是既有模式的可注入封装（`spawn(nodePath, [entryPath, ...args], { env: { OPENCLAW_STATE_DIR, NODE_COMPILE_CACHE }, windowsHide, creationFlags: CREATE_NO_WINDOW })`，与 `plugin:weixin:login` 完全一致的既有写法）。
2. 逻辑：非打包态直接返回 `{ skipped: "not-packaged" }`；校验 `<resources>/openclaw-weixin/package.json` 存在（否则返回 `{ ok:false, reason:"PLUGIN_RESOURCE_MISSING" }`）；读取 `openclaw.json` 判断 `plugins.installs["openclaw-weixin"]` 与 `extensions/openclaw-weixin` 是否已存在且 payload 匹配（mtime+size 快速判定，不做全树 hash）→ 已匹配则跳过；否则执行 `plugins install --force <resources>/openclaw-weixin`，超时 120s，stdout/stderr 采集，退出码非 0 返回 `{ ok:false, reason:"PLUGIN_INSTALL_FAILED", detail }`。
3. 追加写 `config.plugins.entries["openclaw-weixin"].enabled = true` 与 `plugins.allow` 去重追加——**复用** `main.ts:5647` 既有 `plugin:weixin:set-enabled` 的同一段逻辑，抽成 `planWeixinPluginEnable(config)` 纯函数放在新模块内，`set-enabled` 调用同一函数（消除第二份规则）。
4. `main.ts` 调用点失败时经既有 `gateway:log` 通道输出中文可诊断信息（"微信插件未能安装：…，请在任务中心重试或重新运行安装包修复"），**不静默、不自动重装、不删用户数据**。
5. 不实现独立备份/回滚事务（deployer 的 5000 行事务机制不复用）；失败时保持原状态不变即可——`plugins install` 失败不会破坏既有 `extensions` 目录（以单测与打包态手工核对确认，若实测发现会破坏，则升级为 Plan Adjustment）。

**Reason** 需求 §7.2 第 1/7 条与 §C03 证据要求；同时消除"`installed` 无来源"这一直接影响员工扫码的缺口。

**Risk** ① 依赖 `openclaw` CLI 行为（本地目录安装、离线）——用 vendor tgz + `--omit=peer` 保证无网络；若 CLI 在缺 peer 时报错，需 Plan Adjustment。② `plugins install` 属于写配置，必须断言 `config-write-policy.ts` 的允许键列表已含 `plugins`（已含）。③ 首启耗时增加（120s 上限），需在 Guardian 输出耗时。

**Verification** 单测：非打包态返回 `skipped`；缺 `package.json` 返回 `PLUGIN_RESOURCE_MISSING` 且 `runCli` 零调用；CLI 退出码 1 返回 `PLUGIN_INSTALL_FAILED` 且带 detail；CLI 成功时断言 argv 为 `["plugins","install","--force", <resources>/openclaw-weixin]` 且 env 含 `OPENCLAW_STATE_DIR`；`planWeixinPluginEnable` 对已有 `allow` 不去重失败。

---

### Step 9：C03b 分项健康诊断（Guardian）

**Target**
- 新增: `desktop/src/companyclaw/guardian.ts` + `guardian.test.ts`
- Modify: `desktop/src/companyclaw/ipc.ts`（新增 1 个通道 `companyclaw:health:report`）、`desktop/src/preload.ts`、`desktop/src/companyclaw/ipc-contract.test.ts`（`REQUIRED_CHANNELS` 计数 +1）

**Current Behavior**
只有零散的 `setGatewayStatus()` / `BrokerClientStatus` / `gateway:log` 文本，没有"逐项分别报告"的统一诊断；需求明确禁止用单个"运行正常"遮蔽错误。

**Change**
1. `guardian.ts` 定义 `GuardianReport { items: Array<{ id: GuardianItemId; state: "ok"|"degraded"|"failed"|"blocked"|"unknown"; detail: string; hint?: string }> }`，`GuardianItemId` = `gateway-process` | `gateway-auth` | `model-reply` | `tool-call` | `weixin-channel` | `broker-runtime` | `broker-uia` | `browser-binary` | `plugin-installed` | `runtime-manifest`。
2. 采集函数由 `main.ts` 注入（`collectGateway()` 等），保证模块本身无 Electron 依赖、可单测：`gateway-process` 读模块级 `gatewayStatus`（`main.ts:405`，无 getter，注入取值函数而非新增导出）；`gateway-auth` 用既有 `gwClient.connected`；`plugin-installed` 复用 `plugin:weixin:get-status`（`main.ts:5620`）的同一计算（抽函数复用，不复制规则）；`broker-runtime` 用 `BrokerClient.getStatus().nodePath` 是否指向 `<resources>/node.exe`；`runtime-manifest` 复用 `reportRuntimeIntegrity()` 的结果。
3. `main.ts` 在 IPC 注册处新增 handler，返回 `guardian.buildReport()`；启动完成后写一条汇总到 `gateway:log`（每项一行，中文）。
4. 未探测项（`model-reply` / `tool-call`）在未跑探针时返回 `unknown` 而非 `ok`。

**Reason** 需求 §7.2 第 4 条逐项要求；同时给 Step 10 的向导第 1 步提供数据源（避免向导自己算一套）。

**Risk** 通道数增加会打破 `ipc-contract.test.ts` 的数量断言，必须同一次提交内更新（该测试是防漂移资产，不是障碍）。状态语义若与 renderer 期望不一致会导致 UI 误报——用 `unknown`/`blocked` 显式区分"未测"与"失败"。

**Verification** 单测覆盖：全 ok / 部分失败 / 未探测项为 `unknown`；`ipc-contract.test.ts` 更新后通过（通道数与 preload 数量一致）；`npx eslint src/companyclaw` clean。

---

### Step 10：C05 首次向导补"环境自检"与"开启远程操作"

**Target**
- Modify: `desktop/renderer/src/views/SetupWizard.vue`
- Modify: `desktop/renderer/src/stores/companyclaw.ts`（新增 `healthReport` 只读状态与 `refreshHealth()`）
- Modify: `desktop/preload.ts` 类型面（随 Step 9 通道）
- Modify: `desktop/renderer/src/i18n/zh-CN.ts` 与 `desktop/renderer/src/i18n/en-US.ts`（各新增约 14 个键，命名沿用既有 `setup.*` / `cc.*` 前缀；两文件必须成对补齐）

**Current Behavior**
`SetupWizard.vue`（519 行）只有"模型 + 能力探针 + 绑定微信"三段；远程授权开关只在 `TasksView.vue` 的 CompanyClaw 卡片里，对首次使用者不可见；无环境自检页。

**Change**
1. 结构改为 4 步（沿用现有单页多段风格，不引入新路由）：① 环境自检（读 `companyclaw:health:report`，逐项中文 + "重新检测"按钮；异常给中文原因，不给命令行修复步骤）；② 我的模型（现有内容不变，含能力探针三态）；③ 绑定微信（现有二维码入口不变，附加 `plugin-installed` 状态提示）；④ 开启远程操作（中文说明"仅此 Windows 登录账户/电脑需在线且可交互/关键修改需微信确认"，本人手动开启，默认关闭）。
2. 第 4 步复用 `store.enableRemoteOperation({ ttlMinutes })`（既有）；未绑定微信时禁用并提示先完成第 3 步；不暴露 Broker Token / MCP JSON / AllowFrom。
3. `loading` / `empty` / `error` / `success` 四态按项目既有 Element Plus 用法实现（`el-alert` / `el-tag` / `el-skeleton` 为现有依赖，无新增 UI 依赖）。
4. 权限表现：`bridge()` 不可用时（非 Electron / IPC 缺失）该步骤显示"当前环境不支持"，不得默认显示为已开启。

**Reason** 需求 §9.1 明确要求"最多四个可见步骤""本人手动开启，默认关闭""不要求手动填 Broker Token"；§9.3 验收要求全新账号不必打开终端或编辑 JSON。

**Risk** 既有 renderer 测试（27 files/320）可能断言向导段数或键集合；改动需同批更新对应测试。i18n 键必须中英文同时补齐，否则既有校验测试失败。

**Verification** `cd desktop/renderer && npx vitest run`（320 基线不回归 + 新增用例：4 步可见、未绑定微信时第 4 步禁用、bridge 缺失时显示不支持、远程默认关闭）；手工核对无任何 CLI 或 JSON 字样。

---

### Step 11：C06 受控 Browser 执行器

**Target**
- 新增: `docs/companyclaw/ADR/0004-browser-execution-path.md`
- 新增: `desktop/src/companyclaw/browser/browser-adapter.ts` + `browser-adapter.test.ts`
- Modify: `desktop/src/companyclaw/policy/browser-policy.ts`（**仅**在需要时扩展动作名/校验点，不重写既有规则）

**Current Behavior**
`authorizeBrowserAction()` 已实现"远程授权 + 域名 + 能力开关"双闸门并区分失败原因，但**无任何调用方**；`first-run-init.ts` 只写 `browser.enabled` 与 `browser.executablePath`（Edge）；仓库无 CDP/Playwright 依赖，无工作 Profile 管理。

**Change**
1. ADR 先回答需求 §10.2 的强制问题：当前 OpenClaw 2026.9.3 的**工具注册入口/中间件/权限收口点**是否可被外部可靠拦截。结论落 ADR 后再写代码；若不可拦截，则采纳需求给出的备选：**对微信远程会话关闭原生 `browser`/`exec` 可达性**，只暴露受控 Browser 工具代理（本地原生能力与远程安全基线分开验收）。
2. `browser-adapter.ts` 导出 `createBrowserAdapter({ authorize, execute, readBack })`，单一入口 `runBrowserAction({ taskId, stepId, ownerSid, action, url, params })`：
   - 先调 `runtime.authorizeBrowserAction({ action, url })`；`allowed:false` 直接返回 `denied`（不透传到执行层）。
   - `risk: "read"` → 直接执行；`risk: "write"` → 必须带 `approvalTicket`，否则 `denied: "approval-required"`；`risk: "high-risk"` → 恒拒绝（与 `risk-classifier` 的 R3 语义一致，不新增第二套）。
   - 每次**导航、重定向、新标签、下载 URL** 都单独调用一次 `authorize`（不能只校验初始域名）。
   - 执行后强制回读：返回 `{ outcome: "verified", evidence }` 仅在回读匹配时给出，否则 `partial`（对齐 `TaskOrchestrator` 的 PARTIAL 语义）。
3. `execute` / `readBack` 以**依赖注入**方式传入，生产实现走 OpenClaw 原生 Browser（按其真实 SDK 对齐，避免假定内置 `browser` 工具可被简单外部重载）；本 Step 只保证适配器与策略闭环，真实驱动接入按 ADR 结论拆分。
4. 工作 Profile：使用独立持久 Profile（不默认复用员工个人 Chrome 会话/cookies）。

**Reason** 需求 §10.1/§10.2/§10.3 与 §17.2（"BrowserPolicy 与 Windows Broker policy 共享任务授权语义与审计格式，不重复定义两套 R0–R3"）。

**Risk** ① 这是本计划中**唯一需要新设计**的部分，ADR 结论可能推翻 Step 4 的实现假设 → 必须先写 ADR、再写代码，ADR 若得出"原生不可拦截"，则本 Step 拆成"策略代理 + 远程工具面收窄"两小步。② Browser 真实驱动可能引入新依赖 → 触发 Plan Adjustment。③ 无内网测试站点（B2），真实 Web 写入只能 `BLOCKED`。

**Verification** 单测（全部离线）：未授权 → `denied: remote-not-authorized`；域名不在白名单 → `denied: domain-not-allowed`；`write` 无票据 → 不调用 `execute`（注入 spy 断言零调用）；`high-risk` → 恒拒绝；重定向到非白名单 → 第二次 `authorize` 被拒；回读不匹配 → `partial`；回读匹配 → `verified`。

---

### Step 12：C07 Broker 接入任务执行与 UIA 能力补齐

**Target**
- 新增: `desktop/src/companyclaw/bridge/broker-transport.ts` + `broker-transport.test.ts`
- 新增: `desktop/src/companyclaw/locks/desktop-execution-lock.ts` + `desktop-execution-lock.test.ts`
- Modify: `broker/server.ts`（`describe-element` / `wait-for-window` 两个 case）
- Modify: `broker/server.test.ts`（`reports not-implemented for the operations that are still genuinely absent` 用例必须改）
- **不新增任何 `.ps1`**（见 Change 2/3：两者均可完全复用既有脚本与既有 `uia.ts` 函数）

**Current Behavior**
`broker/server.ts:424` 对 `describe-element` / `wait-for-window` 返回 `{ status:"failed", reason:"not-implemented" }`；`BrokerClient.call()` 接受 `operation/taskId/stepId/payloadHash/target/args/approvalTicket`，**无生产调用方**；`runtime.execute(transport, …)` 也是空转。
既有可复用资产（已核对）：`uia.ts` 的 `runFindElements()` → `FindElementsResult { window, elements: ElementDescriptor[] }`，`ElementDescriptor` 已含 `name/automationId/controlType/className/isEnabled/processId/depth`；`runListWindows()` → `WindowDescriptor[]`；`_uia-common.ps1` 提供 `CC_SEL_*` 选择器镜像（`selectorToEnv`）；既有脚本 `list-windows.ps1`、`find-elements.ps1`、`read-value.ps1`、`set-value.ps1`、`invoke-pattern.ps1`、`send-keys.ps1`。

**Change**
1. `broker-transport.ts`：把 `BrokerClient.call()` 适配成 `ExecutionBridge` 所需的 `BridgeTransport`，并做**双向**校验：只允许 `READ_ONLY_OPERATIONS ∪ MUTATING_OPERATIONS` 的封闭集；`R3` 类动作由 `runtime.execute` 在桥之前拒绝（本模块不得放行）；票据原样透传到 `approvalTicket`，由 broker 服务端**再次**校验（双层强制，桌面侧不替代 broker 侧）。
2. `describe-element`：**复用既有 `runFindElements()`**（其 `ElementDescriptor` 即需求要的结构化快照），服务端仅补参数校验（必须给 `target.processName`，可选 `selector`/`windowTitle`/深度与数量上限）并把结果按既有 `{ status:"ok", data }` 返回；`selector` 命中多个时返回全部并由桌面侧判定唯一性，**不引入坐标定位**。
3. `wait-for-window`：轮询**既有 `runListWindows()`**（用 `target.processName` + 可选标题过滤）直到命中或超时（默认 30s、上限 120s、间隔 500ms，均为服务端常量）；命中返回窗口 `name/processId`，超时返回专用 reason `wait-timeout` 而非泛化失败。
4. 桌面独占执行锁：`desktop-execution-lock.ts` 实现同一 SID + 同一交互会话一次只允许一个**焦点敏感**任务（`set-value` / `send-keys` / `invoke-pattern`）；读类操作（`list-windows` / `describe-element` / `find-elements` / `read-value` / `wait-for-window`）不取锁。锁被占用时返回 `denied: desktop-busy`（不排队、不抢占键盘）。
5. 专用错误：`window-not-foreground` / `user-interacting` / `uac-elevation` / `session-locked` 由 broker 侧识别并返回，桌面侧只透传不重解释；实现优先复用既有 `_uia-common.ps1` 的既有判定，若现有脚本无法区分则**先 Plan Adjustment**（可能触及 `.ps1`）。
6. 每步严格绑定 `taskId/stepId/ownerSid/deviceId`（协议已有字段，本 Step 只做传递与断言）。

**Reason** 需求 §11.2 第 1/3/4/5 条（"补齐 describe-element、wait-for-window 或同等能力，先确认最新代码是否已实现"——现已确认基础脚本与结构体都在，属**接线**而非新造）；§C07 验收要求"一条任务跨工具、taskId 不变"；§17.2 要求两套执行器共享授权语义而不重复定义 R0–R3。

**Risk** ① `broker/server.test.ts:329` 明确断言这两个操作返回 `not-implemented`，实现后必须同批改写该用例（否则测试失败被误读为回归）。② 本机 UIA 可用（9 项实机通过）→ 新操作可实机验证，但仍**不得**替代打包态证据。③ 锁粒度设计过粗会让正常连续任务互相阻塞 → 以"焦点敏感动作"为锁范围。④ 桌面侧需确保 `BrokerClient.call()` 的每次调用都带最近票据，避免 Broker 收到无票据写请求。

**Verification** `cd broker && npx vitest run`（54 基线，含被改写的 2 条用例）；新增 `describe-element` / `wait-for-window` 实机用例（本机可跑：对一个已知窗口调用并断言返回 `name/processId` 与元素数组非空）；`cd broker && npx tsc --noEmit` clean；桌面侧单测：R3 → transport 零调用；无票据写 → 零调用；`desktop-busy` 时第二任务不执行且不改键盘焦点。

---

### Step 13：C08 可信来源 → 任务 → 双向审批闭环

**Target**
- 新增: `desktop/src/companyclaw/remote/trusted-context.ts` + `trusted-context.test.ts`
- Modify: `desktop/src/main.ts`（`session-source` 分支 4242 行附近；审批回复分支；退出清理）
- Modify: `plugins/openclaw-weixin/src/messaging/desktop-bridge.ts` 与 `process-message.ts`（**仅追加**：随 `session-source` 附带 `messageId`；`desktop-bridge.test.ts` 同步）
- Modify: `desktop/src/companyclaw/runtime.ts`（新增 `createTaskFromRemote()` 组合入口，复用既有 `createTask` + `identity.resolveOwner`）
- Modify: `desktop/src/companyclaw/tasks/task-orchestrator.ts`（**仅**增加 `AWAITING_APPROVAL` 分支的恢复入口，不重写循环）

**Current Behavior**
`session-source` 只设置全局布尔 `lastInputFromRemote` 与 `cachedRemoteSource`（`main.ts:561/562/4245`，`5485` 复位）；需求 §12.2 明确该布尔不足以作为安全依据。消息**不创建任务**（`runtime.createTask` 仅被测试调用）；`TaskOrchestrator` 无生产调用方；`buildApprovalMessage()` 无调用方，审批卡片**发不出去**；入站审批回复已通（`isRemoteCallerAuthorized` → `applyApprovalReply`）。

**Change**
1. `trusted-context.ts` 定义 `TrustedRemoteContext { channel, channelAccountId, senderId, conversationId, messageId, deviceId, ownerSid, receivedAt, originAttestation }`（对齐需求 §12.2 字段，`originAttestation` 由桌面侧在本机可信边界生成，**绝不取消息文本**）。
2. `main.ts` 的 `session-source` 分支改为：构造 `TrustedRemoteContext`（`ownerSid` 经 `identity.resolveOwner()` 解析，**不由文本决定**）→ `messageId` 去重（同 `messageId` 二次到达直接丢弃，覆盖通道重投递）→ 经 `runtime.createTaskFromRemote()` 创建/恢复任务（`idempotencyKey` 用 `messageId`，复用既有 `createTaskIdempotencyKey`）→ 交给 `TaskOrchestrator.run()`。
3. 删除 `lastInputFromRemote` 的安全用途（`notifyRemotePermissionNeeded()` 的判定改为"存在当前活跃的 `TrustedRemoteContext`"）；保留变量仅用于 UI 提示时必须在文档中注明其**非安全用途**（若无法彻底移除，则改名并加注释，避免被误用为授权依据）。
4. 审批出站：R2 动作由 `TaskOrchestrator` 的注入回调触发 → `runtime.requestApproval()` → `runtime.buildApprovalMessage(ownerSid)` → 经**既有**出站通道发送（Step 14 建立发送函数；本 Step 先接到 `cachedRemoteSource` 的 userId，发送失败要落任务 `resultSummary` 并保持 `AWAITING_APPROVAL`，不得伪报）。
5. 审批入站：现有 `applyApprovalReply` 保持；解析出的审批号必须**绑定该 sender 的待审项**（既有 `listPendingApprovals(ownerSid)` 已满足），补一条"另一 sender 回复同一编号被拒"的用例。
6. 异步不丢任务：`AWAITING_APPROVAL` 已持久化于 `tasks.json`，重启后 `TaskOrchestrator` 可从该状态恢复（本 Step 增加恢复入口 + 用例），不依赖阻塞的聊天函数等待。
7. 超时/取消/窗口切换后审批失效：复用既有 `ApprovalStore` TTL 与 `nextStateForControl`，不改语义。

**Reason** 需求 §12.1–§12.4 全部条目；其中 §12.4 第 8 条（异步审批不能因回合结束丢失）与第 7 条（Agent 不能自己批准自己）是硬约束。

**Risk** ① `main.ts` 是 8226 行巨文件，改动必须限定在既有两个分支内部，抽出的逻辑一律放 `companyclaw/`。② 去重键若只用 `messageId` 而插件不提供，则退化为 `senderId+receivedAt` 哈希，需在 ADR 0003 追加说明。③ `lastInputFromRemote` 与既有 permissions 流程耦合，移除用途时须确认 `notifyRemotePermissionNeeded()` 仍能工作（该项属上游功能，不能破坏）。④ 真机验证 `BLOCKED`（B1）。

**Verification** 单测：伪造 `session-source`（含他人 senderId）→ `resolveOwner` 返回 null → 不创建任务；同 `messageId` 二次到达 → 任务数不增；文本里写 `"from": "owner"` 等字段 → 不改变 `ownerSid`；`AWAITING_APPROVAL` 任务重启后仍可恢复；另一 sender 回复 `确认 1234` → 拒绝。`cd desktop && npx vitest run --root ../plugins/openclaw-weixin` 保持 12 + 新增用例通过。

---

### Step 14：C09 产物校验与微信文件真回传

**Target**
- 新增: `desktop/src/companyclaw/results/weixin-delivery.ts` + `weixin-delivery.test.ts`
- Modify: `desktop/src/companyclaw/runtime.ts`（新增组合入口 `deliverArtifact()`，串联既有 `resolveArtifactDir` → `acceptArtifact` → `validateArtifact` → `delivery-status`）

**Current Behavior**
`validateArtifact()`、`DeliveryStatus`、`task-artifacts.ts`（含 `isPathInsideTaskDir` 包含性检查）均已实现且已测试，但**无生产调用方**；桌面侧唯一的微信出站是 `main.ts:3165 sendWeixinNotification()` 的**纯文本** HTTP 直发；插件侧 `sendWeixinMediaFile()`（`src/messaging/send-media.ts`，按 MIME 走 video/image/file 三条既有上传路径）无桌面调用方。

**Change**
1. `deliverArtifact({ taskId, ownerSid, filePath, toUserId })` 顺序执行：`resolveArtifactDir(create:false)` → `acceptArtifact`（必须在 `jobs/<taskId>/artifacts` 内且叶子名可用）→ `validateArtifact`（存在、非空、大小上限、魔数/MIME 一致、拒绝 symlink/junction 与路径遍历）→ 生成 `SEND_REQUESTED`。
2. 发送：经由**插件**的既有媒体发送能力（不自己实现上传），发送目标必须等于该 `taskId` 绑定的本人聊天（
`identity.resolveOwner()` 对应的 `channelUserId`），不允许传入任意 `toUserId`（入参仅用于断言相等）。
3. 状态机：调用成功（有 `messageId`）→ `SENT`；无官方回执 → **不得**置 `DELIVERED`；异常 → `FAILED`；超时或结果不确定 → `UNKNOWN`，并在任务结果里给出"是否可能已发送"的明确提示（避免重试导致重复发送）。
4. UI：`TasksView.vue` 的 CompanyClaw 卡片展示产物与结果状态（复用既有 `delivery-status` 文案键），不在聊天窗口显示"文件已送达"。
5. 文件名规范化复用 `sanitizeArtifactFileName()`（已实现控制字符/分隔符/保留名处理），不新增第二份规则。

**Reason** 需求 §13.1 全部 9 条；尤其第 5、6 条（真实媒体发送函数 + SENT/DELIVERED 不可混淆）与第 2 条（symlink/junction 误指）。

**Risk** ① 桌面主进程直连插件内部函数不可行（跨进程/跨包）→ 需要通过既有 IPC/Gateway 通道或让插件承担发送，具体路径需在实现前确认（若必须新增插件侧 IPC 通道，属追加式改动，仍在本计划范围内）。② 真机收件验证 `BLOCKED`（B1）。③ 大文件与超时语义需要明确上限。

**Verification** 单测：任务目录外路径 → 拒绝；symlink 指向他人文件 → 拒绝；空文件/魔数不符 → 拒绝；发送成功 → `SENT` 而非 `DELIVERED`；超时 → `UNKNOWN` 且重复调用不产生第二次发送（幂等键为 `taskId+artifactSha256`）。

---

### Step 15：C10 生命周期、隔离与升级校验

**Target**
- Modify: `desktop/src/companyclaw/ipc.ts`（升级前校验入口）
- 新增: `desktop/src/companyclaw/upgrade/upgrade-guard.ts` + `upgrade-guard.test.ts`
- Modify: `desktop/src/companyclaw/runtime.ts`（远程授权关闭后停止派发的断言点）

**Current Behavior**
`runtime-manifest.ts` 的 `verifyRuntimeManifest()` 已能校验运行时资源；**无**"升级前校验数据 schema 与组件兼容性、失败保留旧程序与凭据"的逻辑；`RemoteAuthorization` 支持 revoke/expire，但关闭后**没有派发点的显式断言**（因为当前根本没有派发点）。

**Change**
1. `upgrade-guard.ts`：`planUpgrade({ installedVersion, incomingVersion, manifest, dataSchemaVersion })` → 返回 `{ allowed } | { blocked, reason }`；规则：组件 manifest 不匹配 → `blocked`（不破坏旧安装）；数据 schema 主版本下降 → `blocked`；同主版本 → `allowed`。
2. 升级/失败恢复**不重置** API Key、微信 token、审批日志、任务历史（断言：既有文件路径 `userData/companyclaw/**` 与 `${stateDir}/openclaw.json|.env` 均不在升级清理范围内）。
3. 远程授权关闭/过期/撤销后，`TaskOrchestrator` 与执行器**在派发前**再次检查（`authorization() !== "enabled"` → 拒绝），补用例覆盖"关闭后排队任务不再执行新动作"。
4. 数据隔离：`userData/companyclaw/**` 已是 per-user；补一条断言测试（多 SID 场景下路径必须含 SID 或位于用户 `userData` 下，不新增共享目录）。

**Reason** 需求 §14.3 与 §14.1；§C10 验收要求"升级和回滚不丢凭据"。

**Risk** 真实升级/回滚需要两个版本产物（受 B4/B6 阻塞）→ 本 Step 只交付**可测的判定逻辑**与隔离断言，真实 PKG-06/E19 保持 `BLOCKED`。

**Verification** 单测四类：schema 下降拒绝、manifest 不符拒绝、同主版本允许、授权关闭后零派发。

---

### Step 16：C11/C12 证据索引与发行文档

**Target**
- 新增: `docs/companyclaw/v3/03-packaging-guide.md`、`04-employee-guide.md`、`05-it-admin-guide.md`、`06-release-evidence.md`
- 新增: `docs/companyclaw/v3/07-adr-upgrade-compat.md`（记录 `openclaw-approval-replay-compat.mjs` 与 OpenClaw 2026.9.3 的 SHA 白名单耦合与升级重测清单）
- Modify: `docs/companyclaw/IMPLEMENTATION_STATUS.md`、`BLOCKERS.md`（按 C 阶段更新，保留历史）
- Modify: 根 `README.md` / `README.zh-CN.md`（消除"请先安装 Node/.NET SDK"误导，保留上游版权与许可证）

**Current Behavior**
`docs/companyclaw/v3/` 由 Step 1 建立；`IMPLEMENTATION_STATUS.md` 仍是 V2 基线（`929a995`），当前 HEAD 为 `c6e090a`；README 仍是上游 MicroClaw 品牌叙述（含装 SDK 的构建说明）。

**Change**
1. 打包指南：构建机环境、唯一发行命令（`npm run release:win`）、CI、重建方式、兼容版本表、签名状态与回滚。
2. 员工指南：仅安装、模型设置、微信扫码、远程授权、任务与报表；**不得出现任何 npm/PowerShell 步骤**。
3. IT 指南：解绑、浏览器白名单、远程写入授权、日志导出与清理、分发/升级/回滚/数据保留。
4. 证据文档：PKG-01–10 与 E01–20 逐项真实状态（当前预期：多数 `BLOCKED`/`UNVERIFIED`）、证据路径 `docs/companyclaw/evidence/<release-id>/<test-id>/`、release gate。
5. 状态文档更新到本计划实际 HEAD 与真实测试数；每项保留 `Code/Unit/Packaged/Real E2E` 四字段。
6. 明确标注"未签名技术预览"（`B6`），不得暗示已通过企业发行审核。
7. 更新根 README 的安装说明，区分"构建机"与"员工机"，不误导同事手动装开发工具。

**Reason** 需求 §16.1 必交文件清单与 §C12；§18 第 5 条要求每阶段更新状态与阻塞文档。

**Risk** 文档不得出现未经实测的 PASS；须逐条与 S1–S8 的实际证据对应。

**Verification** 逐条核对 §16.1 的 9 类交付物是否都有落点；`docs/companyclaw/v3/**` 中每项 `BLOCKED` 都写明解除条件；`rg -n 'npm install|pip install|dotnet' docs/companyclaw/v3/04-employee-guide.md` 必须**零命中**。

---

# 4. Changed Files Tracking

执行过程中每修改一个文件都必须更新本表。

| File | Action | Reason | Step | Status |
|---|---|---|---|---|
| `docs/companyclaw/v3/01-current-baseline.md` | Add | C00 基线要求 §1.4 | 1 | ☐ |
| `docs/companyclaw/v3/02-impact-map.md` | Add | C00 影响面要求 | 1 | ☐ |
| `desktop/scripts/prepare-production-resources.mjs` | Modify | 装配 plugin/skills/windows-node manifest | 2,3 | ☐ |
| `desktop/electron-builder.yml` | Modify | extraResources 契约 | 4 | ☐ |
| `desktop/src/companyclaw/extra-resources-contract.test.ts` | Modify | 来源分组同步 | 4 | ☐ |
| `desktop/src/companyclaw/production-resources.test.ts` | Modify | 装配断言扩展 | 5 | ☐ |
| `desktop/src/companyclaw/resource-pipeline.test.ts` | Add | 负向判据 | 5 | ☐ |
| `desktop/src/companyclaw/broker-paths.ts` | Modify | 运行时路径解析器 | 6 | ☐ |
| `desktop/src/companyclaw/broker-paths.test.ts` | Modify | 解析器用例 | 6 | ☐ |
| `desktop/src/companyclaw/broker-client.ts` | Modify | 校验码 + 生命周期 + 重启上限 | 6,7 | ☐ |
| `desktop/src/companyclaw/broker-client-spawn.test.ts` | Modify | 校验/生命周期用例 | 6,7 | ☐ |
| `desktop/src/companyclaw/plugins/weixin-plugin-install.ts` | Add | 首启插件安装 | 8 | ☐ |
| `desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts` | Add | 安装用例 | 8 | ☐ |
| `desktop/src/companyclaw/guardian.ts` | Add | 分项健康诊断 | 9 | ☐ |
| `desktop/src/companyclaw/guardian.test.ts` | Add | 诊断用例 | 9 | ☐ |
| `desktop/src/companyclaw/ipc.ts` | Modify | 新增 health / 安装入口通道 | 9,15 | ☐ |
| `desktop/src/companyclaw/ipc-contract.test.ts` | Modify | 通道计数同步 | 9 | ☐ |
| `desktop/src/preload.ts` | Modify | 新通道暴露 | 9,10 | ☐ |
| `desktop/renderer/src/views/SetupWizard.vue` | Modify | 4 步向导 | 10 | ☐ |
| `desktop/renderer/src/stores/companyclaw.ts` | Modify | health 状态与刷新 | 10 | ☐ |
| `desktop/renderer/src/{views/TasksView.vue}` | Modify | 产物与结果状态展示 | 14 | ☐ |
| `desktop/renderer/src/i18n/zh-CN.ts` | Modify | 新增 i18n 键 | 10 | ☐ |
| `desktop/renderer/src/i18n/en-US.ts` | Modify | 新增 i18n 键 | 10 | ☐ |
| `docs/companyclaw/ADR/0004-browser-execution-path.md` | Add | Browser 拦截结论 | 11 | ☐ |
| `desktop/src/companyclaw/browser/browser-adapter.ts` | Add | 受控 Browser 入口 | 11 | ☐ |
| `desktop/src/companyclaw/browser/browser-adapter.test.ts` | Add | Browser 用例 | 11 | ☐ |
| `desktop/src/companyclaw/bridge/broker-transport.ts` | Add | 执行桥传输 | 12 | ☐ |
| `desktop/src/companyclaw/bridge/broker-transport.test.ts` | Add | 传输用例 | 12 | ☐ |
| `desktop/src/companyclaw/locks/desktop-execution-lock.ts` | Add | 桌面独占锁 | 12 | ☐ |
| `broker/server.ts` | Modify | describe-element / wait-for-window（复用既有 uia.ts + 脚本） | 12 | ☐ |
| `broker/server.test.ts` | Modify | 改写 `not-implemented` 两条用例 + 新增用例 | 12 | ☐ |
| `desktop/src/companyclaw/locks/desktop-execution-lock.test.ts` | Add | 独占锁用例 | 12 | ☐ |
| `desktop/src/companyclaw/remote/trusted-context.ts` | Add | 可信消息上下文 | 13 | ☐ |
| `desktop/src/companyclaw/remote/trusted-context.test.ts` | Add | 上下文用例 | 13 | ☐ |
| `desktop/src/main.ts` | Modify | 装配接线（仅分支内） | 8,9,13 | ☐ |
| `plugins/openclaw-weixin/src/messaging/desktop-bridge.ts` | Modify | 追加 messageId | 13 | ☐ |
| `plugins/openclaw-weixin/src/messaging/process-message.ts` | Modify | 追加字段传递 | 13 | ☐ |
| `plugins/openclaw-weixin/src/messaging/desktop-bridge.test.ts` | Modify | 桥接用例 | 13 | ☐ |
| `desktop/src/companyclaw/runtime.ts` | Modify | 组合入口（不改既有裁决） | 13,14 | ☐ |
| `desktop/src/companyclaw/tasks/task-orchestrator.ts` | Modify | AWAITING_APPROVAL 恢复入口 | 13 | ☐ |
| `desktop/src/companyclaw/results/weixin-delivery.ts` | Add | 产物发送闭环 | 14 | ☐ |
| `desktop/src/companyclaw/results/weixin-delivery.test.ts` | Add | 发送用例 | 14 | ☐ |
| `desktop/src/companyclaw/upgrade/upgrade-guard.ts` | Add | 升级判定 | 15 | ☐ |
| `desktop/src/companyclaw/upgrade/upgrade-guard.test.ts` | Add | 升级用例 | 15 | ☐ |
| `docs/companyclaw/v3/03..07*.md` | Add | 发行与证据文档 | 16 | ☐ |
| `docs/companyclaw/IMPLEMENTATION_STATUS.md` | Modify | 状态同步 | 16 | ☐ |
| `BLOCKERS.md` | Modify | 阻塞同步 | 16 | ☐ |
| `README.md` / `README.zh-CN.md` | Modify | 消除装 SDK 误导 | 16 | ☐ |

**明确不在本表内（禁止修改）**：`appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`skills/**`、`plugins/openclaw-weixin/src/{api,auth,cdn,config,media,monitor,storage,util}/**`、`deployer/**`、`installer/**`、`broker/policy.ts` 的既有判定语义。

---

# 5. Verification Checklist

### 主流程验证

- [ ] `cd desktop && npx vitest run`（基线 75 files / 1451 passed，零回归）
- [ ] `cd desktop && npx vitest run src/companyclaw`（基线 15 files / 113 passed，零回归 + 新增模块全绿）
- [ ] `cd desktop && npm run prepare-production-resources`：**失败路径**必须验证三件事——失败时旧 `desktop/resources/` 完好、无残留 `.staging-*`、错误信息指明确切缺件（B4 阻塞下预期在 `dotnet publish` 处失败）
- [ ] `cd desktop && npx vitest run src/companyclaw/resource-pipeline.test.ts`（缺件 / 篡改 / 重复三类 problem）
- [ ] 首启链路（打包态受 B4/B6 阻塞，改为：单测 + 开发态手工）：插件安装失败 → `gateway:log` 出现中文可诊断信息且不静默

### 关联流程验证

- [ ] `cd desktop/renderer && npx vitest run`（基线 27 files / 320 passed，零回归）
- [ ] `cd broker && npx vitest run`（基线 8 files / 54 passed，零回归）
- [ ] `cd desktop && npx vitest run --root ../plugins/openclaw-weixin`（基线 12 passed，零回归）
- [ ] 执行链路端到端（离线部分）：任务 → policy → 票据 → broker transport（使用注入的假 transport）→ 回读 → COMPLETED；以及 R3 / 无票据 / 重放三条拒绝路径
- [ ] 任务中心 UI：`AWAITING_APPROVAL` 任务在列表可见、审批后状态推进、产物状态展示

### 边界情况验证

- [ ] 中文与空格路径（Broker nodePath、brokerDir、产物文件名）
- [ ] 同一 `taskId+stepId+payloadHash` 重放 → 只执行一次（`consumedNonces`）
- [ ] 同 `messageId` 二次投递 → 不重复创建任务
- [ ] 他人 sender 回复 `确认 1234` → 拒绝；过期/重复回复 → 拒绝
- [ ] 未绑定 sender / 远程授权关闭 → 不派发任何动作
- [ ] Browser：非白名单域、重定向越权、`file://`、裸 IP、`write` 无票据、`high-risk` → 全部拒绝且**不调用执行层**
- [ ] 产物：任务目录外、symlink、空文件、魔数不符 → 拒绝
- [ ] Broker：缺 `node.exe` / 缺 `dist/main.js` / 进程被 kill / 重启超限 / `stop()` 后无孤儿

### Test / Build / Lint / Typecheck

- [ ] `cd desktop && npx vitest run`
- [ ] `cd desktop/renderer && npx vitest run`
- [ ] `cd broker && npx vitest run`
- [ ] `cd desktop && npx vitest run --root ../plugins/openclaw-weixin`
- [ ] `cd desktop && npx tsc --noEmit`（clean）
- [ ] `cd broker && npx tsc --noEmit`（clean）
- [ ] `cd desktop && npx eslint src/companyclaw`（clean）
- [ ] `cd desktop && npm run lint:weixin`（clean）
- [ ] 根 `npm run format:check`
- [ ] `npm run lint`（根，全包）
- [ ] `python -m unittest discover -s tests`（安装器策略测试；本机 Python 3.11 有 2 个既有 error，需与基线一致）

### 明确记为 BLOCKED / UNVERIFIED（不得写 PASS）

- [ ] PKG-01/02/03/04/05/06/07/08/09/10（需清洁 Win11 + .NET SDK + 签名产物）
- [ ] E01–E20 中依赖真实微信（B1）、内网系统（B2）、目标机（B7）的全部项
- [ ] Browser 真实 Web 写入（B2）、微信真机收发与文件回传（B1）
- [ ] 打包态 Gateway/Broker/UIA 实机（B4 缺 `AppContainerLauncher.exe` 与 `dotnet publish`）

---

## Plan Adjustment 规则（执行期遇到即暂停）

出现以下任一情况，**停止编码**并输出 `## Plan Adjustment`（原计划 / 新发现 / 为什么需要调整 / 新增修改范围 / 等待确认）：

1. 需要修改 `appcontainer/**`、`windows-node-host/**`、`skills/**`、`desktop/src/windows-node-mxc*.ts`；
2. 需要改动 `plugins/openclaw-weixin/src/` 超出 Step 13 声明的"字段追加"，或动到上游核心逻辑；
3. 需要新增第三方运行时依赖（含 esbuild、Playwright、tar 库等）；
4. 影响范围超出第 4 节 `Changed Files Tracking` 已登记文件；
5. ADR 0004 结论推翻 Step 11 的实现假设；
6. `openclaw plugins install --force <local-dir>` 在离线/无 peer 依赖下不可用；
7. 需要重新设计既有模块（而非接线）。

## Execution Log

执行期维护，每完成一个 Step 追加：`### Step N Completed`（Modified / Changes / Reason / Verification）。

