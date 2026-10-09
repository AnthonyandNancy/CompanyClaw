# 00 — 源码审计（入口、调用链、复用清单）

- 上游 commit：`6f080a07f43bd65b8b27ec6f859438fc038bb912`
- 审计方式：直接读取源码与 `git grep`，不推断。未读到证据的结论标 `UNVERIFIED`。

## 1. 桌面端（`desktop/`）

| 关注点 | 真实位置 | 审计结论 |
|---|---|---|
| 主进程入口 | `desktop/src/main.ts`（8046 行，实测 `wc -l`） | 承载 Gateway 生命周期、约 130 个 IPC handler、沙箱编排、MXC 事务、权限分发 |
| 生命周期顺序 | `main.ts` `app.whenReady().then(...)` | `verifySkillIntegrity()` → `startApplicationServices().catch(...)` → `mainWindow.loadFile(indexPath)`；顺序由 `src/startup-order.test.ts` 锁定 |
| preload 桥 | `desktop/src/preload.ts`（455 行） | `contextBridge.exposeInMainWorld("openclaw", {...})`，23 个命名空间，`namespace:action` 命名 |
| 渲染端路由 | `desktop/renderer/src/router.ts` | 5 条路由：`/chat/:agentId?`、`/chat/catalog`、`/settings/:section?`、`/setup`、`/plugins` |
| 任务视图 | `desktop/renderer/src/views/TasksView.vue` + `stores/tasks.ts` | **只读 cron 列表**（id/name/cron/agentId/enabled/lastRun），无状态机、无审批 |
| 设置分节 | `desktop/renderer/src/views/SettingsView.vue` `VALID_SECTIONS` | general / usage / models / channels / skills / security / privacy / about |
| Gateway 鉴权 | `desktop/src/gateway-protocol.ts` | `minProtocol 3`、`maxProtocol 4`、scope `operator.admin/read/write/approvals`、Ed25519 设备签名 |
| 设备身份 | `desktop/src/device-identity.ts` `loadOrCreateDeviceIdentity()` | Ed25519，`deviceId` = 公钥 SHA-256 指纹 |
| 配置写入闸门 | `desktop/src/config-write-policy.ts` | 顶层键白名单含 `mcp`、`browser`、`permissions`、`tools` |
| 沙箱网关注入 | `desktop/src/tool-sandbox.ts` `getGatewayEnv()` | 设置 `COMSPEC=AppContainerLauncher.exe` 与 `NODE_OPTIONS --require sandbox-preload.js` |
| 敏感路径屏蔽 | `desktop/src/sensitive-shield.ts` | `.ssh`、`.gnupg`、`.aws`、`.azure`、`.config/gcloud` 硬拒 |

## 2. 真实调用链

### 本地聊天

```
ChatView.vue → stores/chat.ts → preload.ts
→ IPC chat:send-message（main.ts，置 lastInputFromRemote=false）
→ GatewayClient（WS JSON-RPC :18789 loopback + Ed25519 签名握手）
→ 本地 OpenClaw Gateway 子进程
→ Agent 循环 → 工具调用
→ 流式事件回推 → chat.ts → ChatMessageList.vue
```

### 权限审批（既有唯一路径）

```
沙箱需要权限
→ sandbox-preload.js + sandbox-fs-hooks.js / sandbox-cp-hooks.js（NODE_OPTIONS 注入）
→ 同步 IPC 到 main.ts
→ 分支 A：PermissionDialog.vue（AppContainer，60s 自动拒绝）
   分支 B：handleWindowsNodeMxcGatewayApproval（MXC，exec.approval.request）
→ 写 response-<uuid>.json 或 request("exec.approval.resolve")
→ Atomics.wait 解除阻塞
```

### 微信

```
微信 → 腾讯 ilink getUpdates 长轮询（monitor.ts）
→ processOneMessage（先 slash 命令拦截分支 → 媒体下载 → MsgContext）
→ channelRuntime 派发 → Agent
→ send.ts / send-media.ts 回发
```

### MXC（实验，与上者互斥）

```
settings.securityMode = "windows-node-mxc"
→ applyWindowsNodeMxcGatewayPolicy()：channels/hooks/plugins/cron 全部 enabled=false，tools 只 allow ["exec"]
→ 拉起 bundled MicroClaw.WindowsNodeHost（.NET 10）
→ 自证 microclaw.windows-cwd.v1 + microclaw.windows-activation.v1
→ @microsoft/mxc-sdk 0.7.0 wxc-exec.exe → 容器内子进程
```

## 3. 关键事实（影响架构判断）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **Gateway 进程本身不在 AppContainer 内**；沙箱只包裹 `exec()` 派生的子进程 | `appcontainer/README.md` 架构图（`Gateway (Node.js) ─ COMSPEC=AppContainerLauncher.exe`） |
| 2 | `spawn()` / `execFile()` **绕过** AppContainer | `tool-sandbox.ts` 注释：`child_process.spawn() and execFile() are NOT affected (they bypass COMSPEC)` |
| 3 | `sandboxExternalApps` 默认含 `chrome`/`msedge`/`excel`/`winword`/`powerpnt`/`outlook`/`firefox`/`code` | `main.ts` settingsStore `defaults.sandboxExternalApps` |
| 4 | `session-source` IPC **有消费者无生产者** | 全库仅 `main.ts:543`（注释）与 `main.ts:4106`（判断）；`plugins/openclaw-weixin/` 内 `process.send`/`ipc` 零结果 |
| 5 | `lastInputFromRemote` 是单布尔值 | `main.ts:542`，由 `chat:send-message` 置 false |
| 6 | `notifyRemotePermissionNeeded()` **从不生效** | `main.ts:3121`，依赖恒为 `undefined` 的 `cachedRemoteSource` |
| 7 | 微信发送返回**本地 clientId**，非送达回执 | `send.ts` `return { messageId: clientId }`、`return { messageId: lastClientId }` |
| 8 | `windows-node-host` **零 UI 能力** | `grep AutomationElement\|SendInput\|UIAutomation\|Screenshot\|SetForeground` 于 `windows-node-host/*.cs` 零结果 |
| 9 | MXC 模式**强制禁用** channels/plugins/hooks/cron | `windows-node-mxc.ts` `applyWindowsNodeMxcGatewayPolicy` |
| 10 | `securityMode` 二值互斥 | `sandbox:set-enabled` 抛错 "AppContainer and Windows Node + MXC modes are mutually exclusive" |
| 11 | 安装器**默认添加 Defender 排除项** | `deployer/windows_setup.py` `ensure_defender_exclusions`（流程第 6 步）— **本项目已改为默认关闭** |
| 12 | 卸载**曾无条件删除 `~/.openclaw`** | `scripts/windows/uninstall-dependencies.ps1` Step 6 — **本项目已改为需显式 `-PurgeUserData`** |
| 13 | 仓库**无 browser 技能** | `skills/` 仅 7 个目录 |

## 4. 复用清单（本项目实际复用）

| 能力 | 复用方式 |
|---|---|
| AppContainer 双层沙箱 + 敏感路径屏蔽 | 不改动，作为文件/命令边界保留 |
| 一次性 HMAC 审批证明设计 | 借鉴语义（短 TTL、单次消费、多字段绑定、失效即不授权），在 `policy/approval-ticket.ts` 独立实现 |
| 版本化存储惯用法 | 沿用 `contract` + `schemaVersion`（对齐 `windows-node-mxc-durable-approvals.ts`） |
| 依赖注入以便单测 | 沿用 `WindowsNodeMxcDurableApprovalStore` 的 `dependencies` 模式 |
| 原子写 | 0600 + 临时文件 + rename |
| Ed25519 设备身份 | 直接复用 `loadOrCreateDeviceIdentity()` |
| IPC/preload 命名规范 | 新增 `companyclaw:*` 通道，沿用 `namespace:action` |
| 中文 Windows 上的 UIA | 本机实测可用（14 窗口枚举成功），作为 Broker 实现路径的前提 |

## 5. 明确未复用的上游机制（及其原因）

| 机制 | 未复用原因 |
|---|---|
| `PermissionDialog` 的风险分级（low/medium/high） | 属展示层；只读判定来自被调用方自报，不能作为安全依据 |
| `lastInputFromRemote` | 裁决明令废弃 |
| `notifyRemotePermissionNeeded()` | 无生产者，且只做单向通知 |
| MXC 的 ingress 隔离 | 裁决要求原样保留，不通过放开它满足需求 |

---

## V2 一致性修正（基线 `929a995`）

V2 实施书基于较早的 SHA 编写，以下引用与结论已按当前源码修正。定位统一采用
「Commit SHA + 文件路径 + 函数/符号」，行号仅作辅助。

| 原表述 | 实测（含符号） | 结论 |
|---|---|---|
| `main.ts:543`、`main.ts:4106` | 失效。实为 `desktop/src/main.ts` 的 `cachedRemoteSource` 声明与 `startGatewayInner()` 内的 `child.on("message")` 分支 | 引用已修正 |
| §1.1「已有 Browser 配置/目标限制逻辑」 | **生产功能缺失**。`browser.executablePath` 仅由旧 Python 安装器 `deployer/windows_setup.py` 写入；桌面端只有 `desktop/src/companyclaw/policy/browser-policy.ts` 策略层，**无执行器**；`skills/` 内无 playwright/chromium；`README.md` 记为 `Optional: Microsoft Edge` | 需求保留，实现待补（见 12-known-limitations） |
| `dist` 已备好资源 | **不成立**。修正前 `desktop/package.json` 的 `dist` 只跑 `prepare-windows-node-resources`；`desktop/resources/` 被 `.gitignore` 忽略且在干净检出中不存在 | 已由统一流水线修复 |
| `extraResources` 含 `resources/openclaw/` | 该目录由流水线装配后立即删除，且 `desktop/src/bundled-runtime.ts` 只读 `openclaw.asar` —— 属**死引用**；同时**缺少** `companyclaw-broker` | 已修复并加契约测试 |
| Broker 启动用 `process.execPath` | 确认属实：`desktop/src/companyclaw/broker-client.ts` 的 `startInternal()`。打包后该值为 `CompanyClaw.exe` | 已改为 `resolveNodePath()` |
| 首次运行已生成 Gateway 令牌 | **不成立**。`desktop/src/main.ts` 只读 `gateway.auth.token`；唯一写入者是 `deployer/windows_setup.py`（`auth["token"] = secrets.token_hex(24)`） | 已由 `ensureCompanyClawFirstRunConfiguration()` 补齐 |
| 任务链已完成 | `desktop/src/companyclaw/tasks/task-orchestrator.ts` 的 `TaskOrchestrator` 与 `CompanyClawRuntime.execute()` **无生产调用方**，仅测试引用 | 需求保留，接线待补 |
