# 02 — Impact Map（V3 C00）

- 采集时间：2026-10-09
- 基线：`c6e090a`（`feat/companyclaw-foundation`）
- 对应计划：`docs/superpowers/plans/2026-10-09-companyclaw-v3-closure.md`
- 配套基线：`docs/companyclaw/v3/01-current-baseline.md`

> 格式：文件 → 调用入口 → 调用出口 → 修改点 → 测试 → 风险。
> 只保留与 V3.0 收口需求实际相关的内容。

---

## 1. 当前实现调用链（真实存在）

### 1.1 微信入站（已通，但只到"缓存"为止）

```
员工手机微信
  → 腾讯 openclaw-weixin channel（plugins/openclaw-weixin/src/channel.ts）
  → monitor.ts 长轮询 → process-message.ts:74 processOneMessage()
       ├─ textBody 以 "/" 开头 → handleSlashCommand()（上游既有）
       ├─ desktop-bridge.ts:53 publishSessionSource()
       │     → process.send({ type: "session-source", source })
       │     → desktop/src/main.ts:4242 消费者
       │          → lastInputFromRemote = true（全局布尔，561）
       │          → cachedRemoteSource = source（562）
       ├─ desktop-bridge.ts:95 forwardApprovalReply()
       │     → process.send({ type: "approval-reply-request", requestId, text, channelUserId })
       │     → main.ts:4210 消费者
       │          → runtime.isRemoteCallerAuthorized({channelType:"weixin", channelUserId})
       │          → runtime.applyApprovalReply(ownerSid, text)（裁决在桌面侧）
       │          → child.send({ type:"approval-reply-response", requestId, handled })  ← 总是应答
       └─ 其余文本 → 上游 Agent 管道（原样）
```

**终点缺口**：`session-source` 只变成全局布尔；消息**不创建任务**；`cachedRemoteSource` 的唯一使用者是 `main.ts:3226 notifyRemotePermissionNeeded()`（上游权限提示功能，非安全授权）。

### 1.2 桌面 IPC → 安全内核（唯一裁决点）

```
renderer（Vue/Pinia: stores/companyclaw.ts）
  → preload.ts:459 `window.openclaw.companyClaw.*`（17 个通道）
  → companyclaw/ipc.ts registerCompanyClawIpcHandlers()
       → CompanyClawRuntime（runtime.ts，唯一授权裁决点）
            ├─ tasks/     任务状态机与持久化
            ├─ approvals/ 审批生命周期
            ├─ policy/    risk-classifier（R0–R3）、approval-ticket（HMAC 一次性）
            ├─ bridge/    execution-bridge（失败关闭 + nonce 防重放）
            ├─ results/   artifact-validator、delivery-status、task-artifacts
            ├─ remote/    identity-binding、remote-authorization、approval-message
            └─ policy/browser-policy
  → 落盘 userData/companyclaw/{tasks,approvals,identity-binding,broker-targets}.json
```

### 1.3 执行侧（**全部无生产调用方**）

| 能力 | 定义 | 当前调用方 | 需求要求 |
|---|---|---|---|
| `CompanyClawRuntime.execute()` | `runtime.ts:492` | 仅 `runtime.test.ts` | G06/G07 |
| `BrokerClient.call()` | `broker-client.ts:220` | 仅测试 | G02/C07 |
| `BrokerClient.start()` | `broker-client.ts:105` | 仅 `call()`（即仅测试） | G02 |
| `authorizeBrowserAction()` | `runtime.ts:231` | 仅 `runtime.test.ts` | G04/C06 |
| `TaskOrchestrator.run()` | `task-orchestrator.ts:76` | 仅 `task-orchestrator.test.ts` | G05/C08 |
| `validateArtifact()` | `artifact-validator.ts:76` | 仅 `artifact-validator.test.ts` | G07/C09 |
| `advanceWithReceipt()` | `delivery-status.ts` | 仅 `requirement-invariants.test.ts` | G07/C09 |
| `buildApprovalMessage()` | `runtime.ts:408` | **无任何调用方** | G06/C08 |

### 1.4 资源装配与启动

```
desktop/scripts/prepare-production-resources.mjs
  ├─ Stage 1 版本锁：deployer/openclaw_version.py → OPENCLAW_TARGET_VERSION = "2026.9.3"
  ├─ Stage 2a node.exe（复制构建机自身 node）
  ├─ Stage 2b OpenClaw（npm install 锁定版 → createPackage → openclaw.asar，删源树）
  ├─ Stage 2d windows-node/（委托 prepare-windows-node-resources.mjs → 需 dotnet publish）
  ├─ Stage 2e companyclaw-broker/{dist,scripts}（npm run build）
  ├─ Stage 3 runtime-manifest.json（kind: node/openclaw/broker）
  ├─ Stage 4 逐条 hash 复校验 → 同卷 rename 原子交换（失败逆序回滚）
  └─ 【缺口】插件、agent-skills 未参与

desktop/electron-builder.yml（extraResources）
  ├─ dist/github-copilot-auth-worker.js、src/openclaw-approval-replay-compat.mjs
  ├─ resources/{node.exe, openclaw.asar, windows-node/, companyclaw-broker/**, runtime-manifest.json}
  ├─ ../appcontainer/{AppContainerLauncher.exe, sandbox-*.js, path-extraction.js}
  └─ ../skills/rednote-publisher/ → agent-skills/rednote-publisher/   ← 唯一 ship 的 skill；插件缺失

运行时启动（desktop/src/main.ts）
  ├─ ensureCompanyClawFirstRunConfiguration() → 写 gateway.auth.token/mode/port + browser.{enabled,executablePath}
  ├─ reportRuntimeIntegrity() → verifyRuntimeManifest(manifest, process.resourcesPath)
  ├─ resolveOpenClawEntry() → 打包态 bundled-runtime.materializeRuntimeArchive(openclaw.asar → userData/runtime/openclaw)
  ├─ resolveNodePath() → 打包态优先 resources/node.exe
  ├─ spawn(nodePath, [entry, "gateway", "run", ...], { stdio:[...,"ipc"] })
  └─ createCompanyClawRuntime({ nodePath, broker:{brokerDir: resolveBrokerDir(...)} })
```

---

## 2. 现状数据模型（可复用清单）

| 数据 | 位置 | 形状要点 | 复用判断 |
|---|---|---|---|
| 任务记录 | `userData/companyclaw/tasks.json` | `taskId/ownerSid/deviceId/channel/objective/state/stepId/executor/resultSummary/createdAt/updatedAt/terminalAt` | **直接复用**（C08/C09 只需加调用方） |
| 任务状态枚举 | `tasks/task-state.ts` | `CREATED/AUTHENTICATED/PLANNING/RUNNING/AWAITING_APPROVAL/PAUSE_REQUESTED/PAUSED/RESUMING/VERIFYING/COMPLETED/PARTIAL/FAILED/CANCELLED/EXPIRED` + 合法转换表 + `nextStateForControl()` | **直接复用**，不新增状态 |
| 审批记录 | `approvals.json` | `approvalId/ownerSid/taskId/stepId/actionType/targetSystem/recordId/field/oldValue/newValue/bindingHash/status/expiresAt` | **直接复用** |
| 审批票据 | 内存签发 | `ApprovalTicket{nonce,bindingHash,signature,...}` + `consumedNonces:Set` | **直接复用** |
| 身份绑定 | `identity-binding.json` | 单条 `{channelType, channelUserId, deviceId, ownerSid, boundAt}` + `resolveOwner()` | **直接复用**（C08 用它替换全局布尔） |
| 远程授权 | 内存 `RemoteAuthorization` | `state: disabled/enabled/expired/revoked`、`ownerSid/deviceId/channelUserId/grantedAt/expiresAt/revokedAt` | **直接复用** |
| Broker 白名单 | `broker-targets.json` | `{allowedProcesses[], allowedWindowTitles[]}` | **直接复用** |
| Browser 策略 | 内存 `browserConfig` | `{allowedDomains[], allowDownloads, allowUploads}` | **直接复用** |
| 产物 | `userData/companyclaw/jobs/<taskId>/artifacts/` | 目录名经 `taskDirName()` 规范化；`mode 0o700` | **直接复用** |
| 运行时清单 | `resources/runtime-manifest.json` | `{contract, arch, buildSha, entries:[{path,kind,version,arch,sha256,license}]}`，`kind ∈ node/openclaw/broker/windows-node/appcontainer/plugin/skill` | **扩展复用**（C01 写 plugin/skill/windows-node） |
| Broker 线协议 | `broker/protocol.ts` ↔ `desktop/.../broker-protocol.ts`（双份镜像，契约由测试钉住） | 8 个操作：`list-windows/describe-element/find-elements/read-value/invoke-pattern/set-value/send-keys/wait-for-window`；`MUTATING = invoke-pattern/set-value/send-keys` | **直接复用**，操作集不变 |
| 插件契约 | `plugins/openclaw-weixin/package.json#openclaw.runtimeExtensions = ["./dist/index.js"]` | 宿主加载编译产物 | 需**生成** `dist/`（含补丁） |

**历史兼容逻辑**：`config-write-policy.ts` 允许顶层键含 `plugins`（C03a 写启用状态合法）；`path-resolver.getOpenClawStateDir()` 优先 `~/.openclaw`（含 `openclaw.json`）否则 `%APPDATA%/openclaw`；legacy `deployer/windows_setup.py` 的插件安装（`openclaw plugins install --force <dir>`）可作为语义参照，但**不复用其 5000 行事务机制**。

---

## 3. 模块职责

| 模块 | 拥有什么 | 谁修改它 | 谁读取它 |
|---|---|---|---|
| `desktop/src/companyclaw/runtime.ts` | **全部授权裁决**、任务/审批/票据/产物/Browser 策略门面 | 自身方法 | `ipc.ts`、`main.ts` 审批分支、测试 |
| `desktop/src/companyclaw/tasks/task-store.ts` | 任务持久化与状态推进 | `runtime.ts`、`TaskOrchestrator` | `ipc.ts`（列表/详情）、UI |
| `desktop/src/companyclaw/bridge/execution-bridge.ts` | R0–R3 判定 + 票校验 + 失败关闭 | 自身 | `runtime.execute()` |
| `broker/**` | UIA 执行 + **服务端独立**策略复校验 | 自身 | `BrokerClient` |
| `desktop/src/main.ts` | Electron 生命周期、IPC 注册、Gateway spawn、装配 | 本次仅装配点 | renderer、插件（IPC） |
| `plugins/openclaw-weixin/src/**` | 微信通道（上游）+ 最小桥接（本仓库补丁） | 仅允许追加 | OpenClaw 宿主 |
| `desktop/src/path-resolver.ts` / `bundled-runtime.ts` | Node / OpenClaw 入口与 asar 物化 | 自身 | `main.ts`、`gateway-manager.ts` |
| `desktop/scripts/prepare-production-resources.mjs` | 发行 payload 唯一装配入口 | 自身 | `electron-builder.yml` |

**规则副本（需要避免新增第二份）**：R0–R3 语义只在 `policy/risk-classifier.ts`；文件名规范化只在 `results/task-artifacts.ts`；域名判定只在 `policy/browser-policy.ts`；插件启用状态写入规则目前在 `main.ts:5645 plugin:weixin:set-enabled` 内联（C03a 抽出复用，避免两份）。

---

## 4. 直接影响（必然修改）

| 模块 / 文件 | 需求条目 | 为什么必须改 |
|---|---|---|
| `desktop/scripts/prepare-production-resources.mjs` | G01 §5.2/§5.4 | 插件、agent-skills、windows-node manifest 三重缺口 |
| `desktop/electron-builder.yml` | G01 §5.2 | extraResources 缺插件；`agent-skills` 应改为单一来源 |
| `desktop/src/companyclaw/broker-client.ts` | G02 §6.2-3/6 | 无前置校验与错误码、退出后仍报 alive、无重启上限 |
| `desktop/src/companyclaw/broker-paths.ts` | G02 §6.2-1 | 需要运行时（node.exe）与入口的统一解析 |
| `desktop/src/main.ts`（仅装配点） | G03/C03a、C08 | 安装插件到 state dir、可信上下文接线、审批出站触发 |
| `desktop/src/companyclaw/runtime.ts` | G05/G06/G07 | 需要组合入口（`createTaskFromRemote` / `deliverArtifact`），不改既有裁决 |
| `desktop/src/companyclaw/ipc.ts` + `preload.ts` | C05/C03b | 新增健康诊断通道；`ipc-contract.test.ts` 数量断言同步 |
| `desktop/renderer/src/views/SetupWizard.vue` | C05 §9.1 | 缺"环境自检"与"开启远程操作"两步 |
| `desktop/renderer/src/i18n/{zh-CN,en-US}.ts` | C05 | 新增键须成对补齐 |
| `broker/server.ts` | C07 §11.2-1 | `describe-element` / `wait-for-window` 当前为 `not-implemented` |
| `plugins/openclaw-weixin/src/messaging/desktop-bridge.ts` | C08 §12.2 | 需随来源附带 `messageId`（去重依据） |
| `desktop/renderer/src/views/TasksView.vue` | C09 §13.1-9 | 需展示产物与结果状态 |

## 5. 上游影响（谁创建 / 谁触发）

| 入口 | 影响 |
|---|---|
| 微信插件 `processOneMessage()` | 唯一远程入站入口；C08 在此之后由桌面侧建任务 |
| `main.ts` `session-source` 分支（4242） | 唯一来源消费者；目前只写全局布尔 |
| `main.ts` `approval-reply-request` 分支（4210） | 唯一审批入站入口，已通，C08 补"他人 sender 交叉"用例 |
| `main.ts` `plugin:weixin:set-enabled`（5645） | 唯一的启用写入方；C03a 抽函数复用 |
| `ensureCompanyClawFirstRunConfiguration()`（1461） | 首启唯一配置写入点；C03a 在其后追加插件安装 |
| `desktop/package.json` 的 `dist`/`pack`/`release:win` | 三条命令共用同一资源入口（已收敛），C01 不新增第二入口 |
| `build.ps1` Step 3（`npm run release:win`） | 历史构建入口；C01 仅确认委托关系，不改流程 |

## 6. 下游影响（谁读取 / 谁展示 / 谁判定）

| 消费者 | 依赖字段 / 状态 | 本次变化 |
|---|---|---|
| `ipc.ts` 的 17 个通道 + `preload.ts` | 任务/审批/授权/策略/Broker 状态 | 新增健康通道（数量同步） |
| `stores/companyclaw.ts`（renderer） | `RemoteAuthorizationView`、`TaskSummary`、`PendingApproval`、`BrokerTargets`、`BrowserPolicyView` | 新增 health 只读状态 |
| `TasksView.vue` | 远程授权卡片、待审批、任务控制 | 产物与送达状态展示 |
| `main.ts:reportRuntimeIntegrity()` | `verifyRuntimeManifest()` 结果 | C01 后条目数大增（启动校验耗时需观测） |
| `main.ts` 健康监控 `startHealthMonitor()` | `gatewayStatus`、`gwClient.connected` | C03b 复用为 Guardian 数据源 |
| `notifyRemotePermissionNeeded()`（3226） | `lastInputFromRemote` + `cachedRemoteSource` | C08 改为"存在活跃可信上下文"，**保留该上游功能可用** |
| `agent-owned-skills.ts:resolveAgentOwnedSkillBundleRoot()` | `resources/agent-skills/<id>` | C01 使全部 skill 可被安装 |
| `plugin:weixin:get-status`（5620） | `config.plugins.installs/enabled` + `accounts.json` | C03a 使其首次为真 |

## 7. 横向影响（同一业务对象的多处出现）

| 对象 | 列表 | 详情 | 创建 | 编辑 | 审批 | 通知 |
|---|---|---|---|---|---|---|
| 任务 | `companyclaw:tasks:list` + `TasksView` | `tasks:get` | `createTask`（无生产调用方 → C08 接） | `tasks:control` | `AWAITING_APPROVAL`（→ C08 出站） | 任务结果 → C09 微信 |
| 审批 | `approvals:list-pending` | `PendingApproval` | `requestApproval`（无生产调用方 → C08 接） | `approvals:resolve` | 入站回复（已通） | `buildApprovalMessage()`（无调用方 → C08 接） |
| 产物 | `TasksView`（本次新增展示） | `artifacts:resolve` | 执行器落盘 | — | — | `deliverArtifact`（C09 新增） |
| Broker 白名单 | `broker:get-targets` | `broker:set-targets` | UI 写入 | `BrokerTargetsStore.save` | 写操作需票据 | `broker:get-status` |
| Browser 策略 | `browser:get-policy` | `browser:set-policy` | UI 写入 | `configureBrowser` | R2 需票据 | — |

## 8. 间接依赖

| 类型 | 位置 | 与需求的关系 |
|---|---|---|
| 事件 / 消息 | `process.send` IPC（`stdio: [..., "ipc"]`） | C08 唯一可信通道；不得用自由文本传来源（§12.4-2） |
| 定时任务 | `main.ts startHealthMonitor()`（10s 间隔） | C03b 复用其数据源，不新增轮询 |
| 中间件 / 钩子 | `openclaw-approval-replay-compat.mjs`（`registerHooks` + 模块 SHA 白名单） | **仅在 `securityMode === windows-node-mxc` 时 `--import`**（默认 `appcontainer`）；与 OpenClaw 2026.9.3 强耦合，升级即失效 → Step 16 记录兼容关系 |
| 权限 | `config-write-policy.ts` 允许键（含 `plugins`/`browser`/`tools`） | C03a 写 `plugins.entries/allow` 合法 |
| 路由 | `TasksView` / `SetupWizard` | C05/C09 只改这两个现有入口 |
| 外部服务 | 腾讯 `ilink/bot/*`（`sendmessage`/`getuploadurl`/`getupdates`） | C09 复用插件既有上传+发送函数，不自造 |
| 沙箱 / AppContainer | `appcontainer/**`、`windows-node-mxc*.ts` | **不修改**（§2-1） |
| 子模块 | `third_party/openclaw-windows-node/source` | C01 的 `dotnet publish` 输入，本机受 B4 阻塞 |

## 9. 确认无需修改

| 位置 | 理由 |
|---|---|
| `desktop/src/companyclaw/policy/browser-policy.ts` | 域名点边界、未知动作归写、`click` 归写、开关独立均符合 §10.3；只缺调用方 |
| `desktop/src/companyclaw/policy/{risk-classifier.ts,approval-ticket.ts}` | R0–R3 与一次性票据语义符合 §12.4-6；不改 |
| `desktop/src/companyclaw/bridge/execution-bridge.ts` | 失败关闭 + 重放阻断符合 §12.5；不改 |
| `desktop/src/companyclaw/results/{artifact-validator.ts,task-artifacts.ts,delivery-status.ts}` | 校验/包含性/状态机符合 §13.1；只缺调用方 |
| `desktop/src/companyclaw/remote/{remote-authorization.ts,identity-binding.ts,approval-message.ts}` | 授权 TTL、绑定、消息解析符合 §12.2/§12.4；只缺"按消息绑定"的组合方 |
| `desktop/src/companyclaw/tasks/task-state.ts` | 状态集与转换表满足 §12.4-8 的异步审批；不新增状态 |
| `plugins/openclaw-weixin/src/{api,auth,cdn,config,media,monitor,storage,util}/**` | 腾讯 vendored 上游；§7.2-7（群聊默认不可远程操作）已由硬编码 `isGroup:false` 天然满足 |
| `broker/{policy.ts,protocol.ts,uia.ts}` | 服务端策略、封闭操作集、UIA 探针均满足；`describe-element`/`wait-for-window` 可**纯接线**复用 `runFindElements`/`runListWindows` |
| `appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`skills/**` | §2-1 明令保持，不放开 MXC ingress |
| `deployer/**`、`installer/**`、`MicroClawDeployer.spec` | legacy 通道，§8.1 允许保留，不作员工主线 |
| `desktop/src/companyclaw/installer-scope.test.ts` | Per-User/禁提权/无 Defender 例外已钉住，需求未变 |

## 10. 风险 / 注意点

1. **最大风险是"策略完备"被误判为"功能可用"**：8 项缺口中 6 项的真实状态是"能力存在、无生产调用方"，任何只看 `browser-policy.ts` 或单测通过的结论都会高估进度（§16.2 明令不得宣称交付）。
2. `lastInputFromRemote` 是全局布尔，§12.2 明确不足为安全依据，但它是 `notifyRemotePermissionNeeded()` 上游功能的输入 → 改动时必须保留该功能可用。
3. `broker/server.test.ts:329` 显式断言两个操作 `not-implemented`：实现后必须同批改写，否则失败会被误读为回归。
4. `openclaw-approval-replay-compat.mjs` 用模块文件名 + SHA256 白名单 patch OpenClaw：升级 OpenClaw 会让它直接失效，且当前**默认不生效**（仅 MXC 模式 `--import`）→ 不得据此宣称写入安全由它保证。
5. 插件 `dist/` 必须**由我们编译**（vendored tarball 的 dist 不含 `desktop-bridge.ts`），否则桥接在打包态静默消失。
6. `runtime-manifest` 条目将从约 10 条增至数百条（逐文件 sha256），首启校验耗时会上升，需实测。
7. 外部阻塞决定可交付边界：B1（微信）、B2（内网）、B4（.NET SDK）、B6（签名）、B7（目标机）→ 相关 E/PKG 项只能 `BLOCKED`/`UNVERIFIED`。
