# 会话不可用与微信通道退出 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`（本仓库既有惯例，见 `docs/superpowers/plans/2026-10-09-companyclaw-v3-closure.md`）。
> 每个 Step 必须输出 **Execution Log**；一旦发现影响范围扩大或本 Plan 与实际代码不符，必须先输出 **Plan Adjustment** 并停下等待确认，不得边改边扩。
>
> 本 Plan 基于**当前实际源码基线 + 2026-10-09 21:19–21:45 的真实运行日志**，不基于需求书推测。

- 计划文件：`docs/superpowers/plans/2026-10-09-companyclaw-sessionkey-weixin-channel-implementation-plan.md`
- 代码基线：`feat/companyclaw-foundation` / `250c96a`（工作区含既有未提交改动，详见 §4）
- 需求来源：用户实测确认的两条缺陷
  1. **没办法新建会话**（点击「创建新对话」无任何效果，旧会话发送也失败）
  2. **没办法通过微信会话跟应用联系，也无法操作电脑**（已开启"远程操作"）
- 前置已完成：需求确认 → 代码调查 → Impact Map → Mini Plan → 正式化（本文件）
- 验证限制：微信**真机**扫码往返回复受 `BLOCKERS.md` B1（无微信测试账号）阻塞；本次只验到"通道不再退出 + provider 加载 + 桌面链路带前缀发送成功"。

---

## 1. Goal

### 1.1 本次修改目标

把两条实测缺陷修到「可自证、可复现」的程度：

1. **新建会话可用**：点击「创建新对话」真正产生新会话；新建会话在**多 agent 配置**下发送不再被 Gateway 拒绝（会话键一律带 `agent:<id>:` 前缀）。
2. **历史会话可用**：侧栏既有的裸键会话（如 `session-1791536153880-capfil`）在切换时被归一化为 agent 限定键，发送/加载历史不再报 `no explicit owner`。
3. **微信通道可用**：内置 `openclaw-weixin` 插件不再因宿主 SDK 子路径缺失而启动即退出；且**改动能真正生效到已安装副本**（载荷指纹驱动的重装），使微信消息能进入应用。

### 1.2 不包含（明确排除）

- **不**接线"让 AI 真正操作电脑"的受控执行链（`BrokerClient.start/call` → `createBrokerTransport` → `TaskOrchestrator` → UIA/Broker 允许列表）。原因：这不是小缺陷，而是产品主线能力（F03/F08/P0-C）的完整接线工作，工作量与本次两个缺陷不是一个量级，需用户单独确认后另出 Plan。
- **不**做远程授权（`RemoteAuthorization`）的持久化与启动恢复（同上，属执行链范畴）。
- **不**修 `usage:get-stats` / `usage:get-detailed-stats` 的 `sessions.usage` 缺 owner 报错（同根因但用户未反馈，列为已知遗留）。
- **不**升级/降级 OpenClaw（2026.9.3）、Node、Electron、Element Plus 及任何依赖。
- **不**改 `gateway-client.ts` 的 RPC 透传、`ChatView.vue` 的输入框门控、Broker/策略/审批/任务/产物模块、打包脚本主体（`electron-builder.yml`、`build.ps1`）。
- **不**重构 `stores/chat.ts`、不新增抽象层、不为未来功能预留开关、不调整 UI 视觉。

### 1.3 成功标准

| # | 标准 | 判定证据 |
|---|---|---|
| S1 | 插件源码中每个 `openclaw/plugin-sdk/*` 导入都存在于宿主 2026.9.3 导出表 | 新增 `weixin-sdk-contract.test.ts` 由 FAIL → PASS |
| S2 | 载荷指纹变化时自动重装插件；指纹一致时不重装 | `weixin-plugin-install.test.ts` 新增 3 个用例 PASS |
| S3 | 应用启动后 `dev-electron.log` 不再出现 `channel exited: Package subpath './plugin-sdk/channel-runtime'`，出现 `starting weixin provider` 且无 `auto-restart` | 启动后日志检查 |
| S4 | 新建会话（默认 agent 与其它 agent）键均为 `agent:<id>:session-…` | `chat.test.ts` 断言更新 + 新增用例 PASS |
| S5 | 点击「创建新对话」后主区回到欢迎态，发送成功：日志出现 `⇄ res ✓ chat.send`，键为 `agent:main:session-…` | 手工操作 + 日志 |
| S6 | 点击历史裸键会话后 `chat.history` 返回 `✓` 而非 `INVALID_REQUEST no explicit owner` | 手工操作 + 日志 |

---

## 2. Current Understanding

### 2.1 当前实现方式（与两条缺陷直接相关的部分）

**聊天发送链路**

```
ChatView.vue (Enter / 发送按钮)
  └─ stores/chat.ts#sendMessage
       └─ preload window.openclaw.chat.sendMessage(sessionKey, …)
            └─ main.ts ipc "chat:send-message"（仅校验 gwClient.connected）
                 └─ gateway-client.ts#sendChat → WS 方法 chat.send { sessionKey, message }
                      └─ 宿主 OpenClaw 2026.9.3 做 owner 校验
```

**会话键的三种来源**
- 初始 `sessionKey = ref("main")`；连接握手 `extractMainSessionKey()` → `setMainSessionKey()` 把它规范化为 `agent:main:main`。
- `newSession(agentId)`（`stores/chat.ts:1325`）：`agentId && agentId !== "main" ? \`agent:${agentId}:${suffix}\` : suffix` → **默认 agent 得到裸键**。
- 两处回落同样生成裸键：`deleteSession()`（`:1523`）、`clearAllHistory()`（`:1563`）。

**侧栏「创建新对话」**（`components/SidePanel.vue`）
- `createNewChat()` → `ensureEmptySession()`：仅当 `messages.length > 0 || currentSessionAgentId !== targetAgentId` 才 `newSession()`；否则只 `router.push`（**空操作**）。
- `visibleSessions` 过滤 `(session.agentId || "main") === currentAgentId`；空会话不落库（`_syncToSessionStore()` 在无消息时早退）。

**微信通道**
- `main.ts#ensureWeixinPluginAvailable()` → `companyclaw/plugins/weixin-plugin-install.ts#ensureWeixinPluginInstalled()`：**已安装即短路**（`weixinPluginInstalled()` 为真则返回 `already-present`，从不比对内容）。
- 安装源：dev = `<appPath>/resources/openclaw-weixin`（由 `scripts/prepare-production-resources.mjs#buildWeixinPluginDist()` 用本仓库 `plugins/openclaw-weixin/src` 编译）；打包 = `<resources>/openclaw-weixin`。
- 插件运行期：宿主从 `<stateDir>/extensions/openclaw-weixin` 加载 `dist/index.js`。
- 入站桥接：插件 `process-message.ts` → `publishSessionSource()` → 主进程 `session-source` IPC → `handleTrustedRemoteMessage()` → `runtime.createTaskFromRemote()`。

### 2.2 已确认的根因（有运行证据）

**需求①（新建会话不可用）——三处叠加**

1. **按钮空操作**：`session-1791536153880-capfil` 的 `chat.history` 持续报错 → `messages` 恒为空；裸键的 `currentSessionAgentId` 回落 `"main"`，与当前 agent 相同 → `ensureEmptySession()` 两个条件都不成立 → 不新建。
   证据：`desktop/dev-electron.log:235,271,295,320,334,346,358,408,435,464`（21:24:36–21:25:26 每 5 秒一次 `chat.history … INVALID_REQUEST`）。
2. **裸键被 Gateway 拒绝**：配置了 2 个 agent（`agents.list = [main(default), code-geek]`，宿主启动时打印 `Moved agents.list to keyed agents.entries.; Materialized legacy per-surface agent ownership.`），宿主不再规范化裸键。
   证据：`dev-electron.log:236,247,259,283,423` → `Use an agent-prefixed session key or select an agent explicitly.`
   反证：本次运行唯一成功的 `chat.send` 用的是带前缀的 `agent:main:__microclaw_warmup__`（`:132`）。
3. **应用无法自愈**：旧卡被反复恢复为当前会话，5 秒轮询持续失败。

补充实测（宿主包 2026.9.3，只读探针）：`resolveRequestedSessionAgentId(cfg, "session-…")` → `ok:false/INVALID_REQUEST`；`resolveRequestedSessionAgentId(cfg, "agent:main:session-…")` → `ok:true`；`resolveSessionStoreKey` 的规范键为 `agent:main:session-…`。

**需求②（微信联系不上）——硬阻断 + 无法生效**

1. **硬阻断**：插件 `src/messaging/process-message.ts:4` 导入 `openclaw/plugin-sdk/channel-runtime`，该子路径在宿主 2026.9.3 **不存在** → channel 启动即退出，重试 10 次后放弃，health-monitor 再拉起重试。
   证据：`dev-electron.log:99,128–129,654–656,719–720,736–741`；打包态 `resources/openclaw.asar` 内 `node_modules/openclaw/package.json` 同为 2026.9.3 且同样**无** `channel-runtime`。
   替代导出：`./plugin-sdk/channel-message` 导出 `createTypingCallbacks`，参数（`start/stop/onStartError/onStopError/keepaliveIntervalMs`）与返回（`{onReplyStart,onIdle,onCleanup}`）与插件用法一致（已实测导入并逐个函数比对；插件其余 10 个 SDK 子路径在 dev 与打包态均存在）。
   注：vendored 上游 `tencent-weixin-openclaw-weixin-2.4.6.tgz` 内为同一行，属插件与宿主的版本断代，非本仓库引入。
2. **改动无法生效**：`extensions/openclaw-weixin/dist/src/messaging/process-message.js` 与仓库 staged 副本 **sha256 完全相同**（`9ee883e1…`），而安装逻辑对"已存在"直接短路 → 必须让重装逻辑识别载荷变化。

**需求②的"无法操作电脑"（本次不修，仅记录结论）**

- 远程授权只在内存（`runtime.ts:169` `new RemoteAuthorization({ now })` 未传 write/load；`companyclaw/` 下无授权文件），重启即丢。
- 远程授权不 gate 任何实际执行：`decideAction` 只被 `ExecutionBridge` / `runtime.requestApproval` 调用，而这两者**无生产调用者**。
- 受控执行通道未启动/未接线：`BrokerClient.start()` 仅由 `BrokerClient.call()` 懒触发，而 `call` 无生产调用者；`createBrokerTransport`、`TaskOrchestrator`、`new BrowserAdapter`、`runtime.execute` 均只被测试引用；`broker-targets.json` 不存在（默认拒绝一切应用操作）；日志中 `broker` 仅出现 1 次（注册行）。
- 结论：微信消息即便到达，也只走 Agent 自身工具（AppContainer 沙箱内、需桌面弹窗授权），**不会**走 CompanyClaw 受控桌面操作通道。

### 2.3 已确认的影响范围（Impact Map 摘要）

- 直接修改：`plugins/openclaw-weixin/src/messaging/process-message.ts`、`desktop/src/companyclaw/plugins/weixin-plugin-install.ts`(+test)、新增 `desktop/src/companyclaw/plugins/weixin-sdk-contract.test.ts`、`desktop/renderer/src/stores/chat.ts`(+test)、`desktop/renderer/src/components/SidePanel.vue`、`desktop/src/main.ts`（重装日志分支）。
- 关联检查：`stores/sessions.ts`（历史会话的 agentId 归属）、`gateway-client.ts`（透传无需改但要复核）、`scripts/prepare-production-resources.mjs`（必须重编译 staging）、`runtime-manifest.ts`（打包态插件逐文件 sha256，需走流水线重生成）、`config-write-policy.ts`（不含 `bindings`，本次不涉及）。
- 确认无需修改：宿主/Node/Electron 版本、插件其余文件、`ChatView.vue` 门控、`planWeixinPluginEnable`、打包脚本主体。

---

## 3. Implementation Steps

### Step 0（前置）备份

- Target：`backups/2026-10-09-mini-fixes/`
- Change：把本 Plan §4 中所有「Modify」的既有文件复制到备份目录（保留相对路径），再开始改动。
- Reason：宪法 D1（改重要文件前先备份）。
- Verification：`ls -R backups/2026-10-09-mini-fixes/` 能看到对应文件。

---

### Step 1 插件宿主 SDK 子路径对齐（TDD）

#### Target

- Modify：`plugins/openclaw-weixin/src/messaging/process-message.ts`（第 4 行）
- Add：`desktop/src/companyclaw/plugins/weixin-sdk-contract.test.ts`

#### Current Behavior

```ts
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";
```
宿主 2026.9.3 的 `exports` 没有 `./plugin-sdk/channel-runtime` → 运行时抛
`Package subpath './plugin-sdk/channel-runtime' is not defined by "exports"` → channel 退出。

#### Change

1. 先写失败测试（契约测试）：扫描 `plugins/openclaw-weixin/{index.ts,src/**/*.ts}`，用正则提取所有 `from "openclaw/plugin-sdk/<sub>"`，断言每一项都在**钉住的宿主 2026.9.3 导出白名单**内；若 `desktop/resources/openclaw.asar` 存在，再交叉校验一次（读 asar 内 `node_modules/openclaw/package.json` 的 `exports`）。
   白名单（实测自 `openclaw@2026.9.3`）：`core, plugin-entry, channel-config-schema, channel-contract, reply-runtime, command-auth, hook-runtime, infra-runtime, plugin-runtime, account-id, channel-message, routing`。
2. 运行测试确认 FAIL（报 `channel-runtime` 不在白名单）。
3. 最小实现：把导入改为

```ts
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-message";
```
4. 运行测试确认 PASS。
5. 重新编译插件 staging（见 Step 5 的编译命令）——dist 未更新时 Step 2/3 仍装的是旧代码。

#### Reason

这是需求②"微信联系不上"的唯一直接根因；替代导出契约一致，无需改任何调用点（`createReplyDispatcherWithTyping({ …, typingCallbacks })` 用法不变）。

#### Risk

- 若宿主某版本两者都不存在，契约测试会失败而非静默通过（这是期望行为）。
- 插件 dist 未重编译会让人误判"改了没用" → 必须执行编译 + 观察重装日志。

#### Verification

- `npx vitest run src/companyclaw/plugins/weixin-sdk-contract.test.ts`（工作目录 `desktop`）→ PASS。
- 手工：`node -e "import('openclaw/plugin-sdk/channel-message')"` 等价检查（已实测通过），或直接进入 Step 5 的启动验证。

---

### Step 2 载荷指纹驱动的插件重装

#### Target

- Modify：`desktop/src/companyclaw/plugins/weixin-plugin-install.ts`
- Modify：`desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts`
- Modify：`desktop/src/main.ts`（`ensureWeixinPluginAvailable()` 的日志分支）

#### Current Behavior

```ts
if (weixinPluginInstalled(input.stateDir)) {
  return { ok: true, state: "already-present" };
}
```
只要 `extensions/openclaw-weixin/package.json` 存在就直接跳过 → 已安装的坏副本永不更新（本机实测：安装副本与 staged 副本 sha256 相同）。

结果类型：`{ ok: true; state: "installed" | "already-present" | "skipped" }`。

#### Change

1. 新增导出函数：
   ```ts
   /** Fingerprint of the payload the installer would install.
    *  Covers package.json + every file under dist/ (relative path + content);
    *  node_modules is excluded because the host resolves it at load time. */
   export function weixinPluginPayloadFingerprint(pluginDir: string): string | null
   ```
   用 `node:crypto` 的 sha256，逐文件按**排序后的相对路径**喂入；目录缺失或不可读返回 `null`。
2. 安装成功后把指纹写入 `<stateDir>/extensions/openclaw-weixin/.companyclaw-payload.json`（内容：`{ contract: "companyclaw.weixin-payload.v1", fingerprint }`）。
3. `ensureWeixinPluginInstalled()` 改为：
   - 未安装 → 安装（并写指纹），`state: "installed"`；
   - 已安装且指纹文件存在且等于当前 payload 指纹 → `{ ok: true, state: "already-present" }`，**不调用 CLI**；
   - 已安装但指纹缺失/不一致 → 走同一条 `plugins install --force --accept-capabilities <pluginSourceDir>`，成功后写指纹，`state: "refreshed"`。
4. 结果类型增加 `"refreshed"`；`main.ts#ensureWeixinPluginAvailable()` 在 `state === "installed" || state === "refreshed"` 时打日志（`refreshed` 用"已更新微信插件载荷"字样），沿用现有 `console.log` + `gateway:log` 风格。
5. 测试（新增 3 例，沿用现有 `runCli` 注入与 `stagedResources()` 辅助）：
   - 指纹一致 → `already-present` 且 `runCli` 未被调用；
   - 指纹不一致 → `runCli` 被调用一次、参数含 `--force --accept-capabilities`、返回 `refreshed`、指纹文件被更新；
   - 指纹文件缺失但目录已存在（= 当前机器状态）→ 判定为需重装（`refreshed`）。

#### Reason

不改这一步，Step 1 的修复在**本机与员工机**都不会生效（两份副本字节相同，短路逻辑永远命中）。

#### Risk

- 指纹算法必须排除 `node_modules`，否则 dev/packaged 布局差异会导致每次启动都重装并反复重启插件。
- 重装发生在 `startApplicationServices()` 内、`startGateway()` 之前，属于既有顺序，不引入启动竞态；但若 `plugins install` 失败必须保持原有失败上报（中文提示 + `gateway:log`），不得静默。

#### Verification

- `npx vitest run src/companyclaw/plugins/weixin-plugin-install.test.ts`（`desktop`）→ 全 PASS（含原有 "skips an installation that is already present"，该用例需按新语义更新：目录存在但无指纹 → 会重装，因此用例改为"指纹一致时跳过"）。
- 启动后检查：`extensions/openclaw-weixin/.companyclaw-payload.json` 存在且等于 staged 载荷指纹；连续启动两次，第二次日志**不应**再出现重装/重启。

---

### Step 3 会话键一律 agent 限定

#### Target

- Modify：`desktop/renderer/src/stores/chat.ts`（`newSession` 1331–1336、`deleteSession` 1523–1525、`clearAllHistory` 1563–1565）
- Modify：`desktop/renderer/src/stores/chat.test.ts`

#### Current Behavior

```ts
const key = agentId && agentId !== "main" ? `agent:${agentId}:${suffix}` : suffix;   // newSession
const newKey = mainSessionKey.value ?? `session-${Date.now()}-…`;                     // deleteSession / clearAllHistory
```
默认 agent 得到裸键 → 多 agent 配置下 `chat.send` / `chat.history` 被宿主拒绝。

#### Change

```ts
// newSession
const effectiveAgentId = agentId ?? "main";
const key = `agent:${effectiveAgentId}:${suffix}`;
pendingSessionAgentId.value = effectiveAgentId;
```
```ts
// deleteSession / clearAllHistory 回落
const newKey = mainSessionKey.value ?? `agent:main:session-${Date.now()}-${…}`;
pendingSessionAgentId.value = "main";
```
同步更新既有断言：
- `chat.test.ts:572` `/^session-/` → `/^agent:main:session-/`
- `chat.test.ts:603`（用例名 "keeps a bare session key for the default (main) agent"）→ 改为断言 `/^agent:main:session-/` 并重命名为 "keeps the main agent in the key"（宿主提示语作为依据写入注释）
- `chat.test.ts:1063`（删除最后一个会话后的草稿键）→ `/^agent:main:/`
新增用例（TDD：先写后跑 FAIL）：
- `newSession()`（无参）→ `/^agent:main:session-/`；
- `newSession("main")` 与 `newSession("coder")` → `/^agent:main:session-/` 与 `/^agent:coder:session-/`。

#### Reason

宿主 2026.9.3 在 ≥2 个 agent 时只接受 `agent:<id>:` 前缀或显式 `agentId`（实测）；本仓库已有前缀惯例（`agent:main:__microclaw_warmup__`、标题会话键），复用即可。

#### Risk

- 既有的 `/^session-/` 断言会失败，必须同步更新（否则误判为回归）。
- 历史会话记录（localStorage）中的裸键不受本步影响 → 由 Step 4 处理。
- `canonicalAgentId("main")` 必须返回 `"main"`（现有 `currentSessionAgentId` 依赖它），已确认存在。

#### Verification

- `npx vitest run src/stores/chat.test.ts`（`desktop/renderer`）→ 全 PASS。
- 手工：新建会话发送 → 日志 `⇄ res ✓ chat.send`。

---

### Step 4 历史裸键归一化 + 「创建新对话」真正新建

#### Target

- Modify：`desktop/renderer/src/stores/chat.ts`（`switchSession` 750–751）
- Modify：`desktop/renderer/src/components/SidePanel.vue`（`createNewChat` 494–497）
- Modify：`desktop/renderer/src/stores/chat.test.ts`（新增 switchSession 用例）

#### Current Behavior

```ts
// chat.ts
async function switchSession(key: string) {
  const targetKey = key === "main" ? mainSessionKey.value || key : key;
```
→ 历史裸键原样透传，继续报 `no explicit owner`；`mainSessionKey` 为空时还会退回裸 `"main"`。

```ts
// SidePanel.vue
function createNewChat() {
  ensureEmptySession();          // 空会话 + 同 agent 时不新建 → 点击无任何效果
  router.push(`/chat/${agentStore.currentAgentId}`);
}
```

#### Change

```ts
// chat.ts
/** The Gateway only accepts agent-qualified keys once more than one agent is
 *  configured; sidebar entries created before that (or by older builds) are bare. */
function qualifySessionKey(key: string, agentId?: string): string {
  if (!key || key.startsWith("agent:")) return key;
  return `agent:${agentId || "main"}:${key}`;
}

async function switchSession(key: string) {
  const sessionStore = useSessionStore();
  const targetKey =
    key === "main"
      ? mainSessionKey.value ?? "agent:main:main"
      : qualifySessionKey(key, sessionStore.sessions.find((s) => s.key === key)?.agentId);
  …
}
```
```ts
// SidePanel.vue：显式按钮 = 一定新建；agent 切换路径保持 ensureEmptySession() 语义不变
function createNewChat() {
  chatStore.newSession(agentStore.currentAgentId);
  router.push(`/chat/${agentStore.currentAgentId}`);
}
```
新增用例（先写后 FAIL）：
- 切换历史裸键（sessions store 里记录了 `agentId: "main"`）→ `sessionKey === "agent:main:<原键>"`，且 `window.openclaw.chat.loadHistory` 以该键被调用；
- 切换记录为 `agentId: "coder"` 的裸键 → `agent:coder:<原键>`；
- `mainSessionKey` 为空时 `switchSession("main")` → `"agent:main:main"`；
- 已带前缀的键切换后保持不变。

#### Reason

用户侧栏里就是这些历史会话（截图「1111」）；不归一化则修复后仍不可用。按钮语义必须与"新建"一致，否则用户永远无法脱离旧会话。

#### Risk

- 归一化后的键在宿主里对应同一 transcript（实测 `resolveSessionStoreKey("session-X") === "agent:main:session-X"`），因此历史应能读回；若读回为空，属宿主侧无该会话（不是本步回归），如实记录。
- `SidePanel` 无既有测试文件，本步的按钮行为只做**手工验证**（不做组件级自动化测试，避免为一个按钮新搭组件测试脚手架）；store 层行为由新增用例覆盖。

#### Verification

- `npx vitest run src/stores/chat.test.ts` → PASS。
- 手工：点「创建新对话」→ 出现欢迎态（无消息）；发送 → 成功；点旧卡「1111」→ `chat.history` 返回 ✓。

---

### Step 5 重新编译插件载荷并启动验证

#### Target

- 产物：`desktop/resources/openclaw-weixin/dist/**`（gitignored 的 staging，必须重编译）
- 运行态：`<stateDir>/extensions/openclaw-weixin`

#### Current Behavior

staging 里的 `dist/src/messaging/process-message.js` 仍是含 `channel-runtime` 的旧编译产物（与安装副本同 hash）。

#### Change

用与 `prepare-production-resources.mjs#buildWeixinPluginDist()` 相同的方式重编译（tsc + 同款 compilerOptions）：

```bash
# 工作目录：<repo>/desktop
node node_modules/typescript/bin/tsc \
  --target es2022 --module esnext --moduleResolution bundler \
  --rootDir ../plugins/openclaw-weixin \
  --outDir resources/openclaw-weixin/dist \
  --skipLibCheck --noCheck --declaration false --sourceMap false \
  ../plugins/openclaw-weixin/index.ts
```
（若网络可用且需要走完整流水线，等价命令为 `npm run prepare-production-resources`；本机不依赖它。）

随后启动应用（`npm run dev:electron` 或已打开的 dev 会话），由 Step 2 的指纹逻辑自动把新载荷装到 `extensions/openclaw-weixin`。

#### Reason

插件 dist 由本仓库源码编译；不重编译则 Step 1 的修复不会进入安装源。

#### Risk

- 手工 tsc 参数与脚本若不一致，可能出现 dist 结构差异 → 必须核对生成路径为 `resources/openclaw-weixin/dist/src/messaging/process-message.js`，且 `index.js` 位于 `dist/index.js`。
- 打包态还需走完整流水线重生成 `runtime-manifest.json`（插件逐文件 sha256），否则打包启动会报完整性告警；本次仅要求记录该事项，不在本机打包。

#### Verification

- `grep -rn "channel-runtime" desktop/resources/openclaw-weixin/dist` **无输出**；`grep -c "channel-message" …/process-message.js` ≥ 1。
- 启动后日志：无 `channel exited: … channel-runtime`，出现 `starting weixin provider (https://ilinkai.weixin.qq.com)`，且 5 分钟内无 `auto-restart attempt`。

---

## 4. Changed Files Tracking

> 以下为**执行完成后按实际改动**填写的最终记录（非计划表）。

| File | Action | Change |
| ---- | ------ | ------ |
| `plugins/openclaw-weixin/src/messaging/process-message.ts` | Modify | 第 4 行导入由 `openclaw/plugin-sdk/channel-runtime` 改为 `openclaw/plugin-sdk/channel-message`（宿主 2026.9.3 已移除前者） |
| `desktop/src/companyclaw/plugins/weixin-sdk-contract.test.ts` | Add | 新增契约测试：扫描插件源码全部 `openclaw/plugin-sdk/*` 导入，断言都在钉住宿主导出白名单内；若存在打包态 asar 再交叉校验宿主自身导出表 |
| `desktop/src/companyclaw/plugins/weixin-plugin-install.ts` | Modify | 新增 `weixinPluginPayloadFingerprint()`（package.json + dist/** 逐文件哈希，排除 node_modules）、指纹读写（`.companyclaw-payload.json`）、`"refreshed"` 状态；已安装但指纹缺失/不一致时走 `--force --accept-capabilities` 重装并回写指纹 |
| `desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts` | Modify | "已存在即跳过"用例改为"指纹一致才跳过"；新增 2 例：载荷变化 → `refreshed` 且第二次不再重装、无指纹记录 → 重装修复 |
| `desktop/src/main.ts` | Modify | `ensureWeixinPluginAvailable()` 增加 `refreshed` 分支：打印 `payload refreshed` 并向渲染层发 `[info] 已更新微信插件到当前版本` |
| `desktop/renderer/src/stores/chat.ts` | Modify | `newSession()` 一律生成 `agent:<id>:session-…`（默认 `main`）；`deleteSession()`/`clearAllHistory()` 回落键改为 `agent:main:session-…`；新增 `qualifySessionKey()` 并在 `switchSession()` 归一化历史裸键与 `main` 别名，同时调用 `_canonicalizeSessionKey()` 把旧卡并入规范键（避免同一会话出现两张侧栏卡） |
| `desktop/renderer/src/stores/chat.test.ts` | Modify | 更新 3 处裸键断言为 `agent:main:` 前缀；新增 5 例切换旧键用例（含"旧卡并入规范键"）+ 1 例无参 `newSession()` 用例；用例名 "keeps a bare session key…" 改为 "keeps the default (main) agent in the session key" |
| `desktop/renderer/src/components/SidePanel.vue` | Modify | `createNewChat()` 由 `ensureEmptySession()` 改为直接 `chatStore.newSession(currentAgentId)`，使显式按钮一定新建 |
| `desktop/resources/openclaw-weixin/dist/**` | Modify（gitignored 构建产物） | 用仓库源码重新编译插件载荷；`channel-runtime` 不再出现，`process-message.js` 引用 `channel-message` |

> 上表之外无任何文件被本次改动触碰；出现表外文件即触发 Plan Adjustment（本次未触发）。

---

## 5. Verification Checklist

**主流程**
- [x] 点「创建新对话」→ 主区回到欢迎态（无历史消息），侧栏不新增空项 —— 通过 CDP 真实点击验证：键由 `agent:main:session-1791557848603-mdy23m` 变为 `agent:main:session-1791557885126-5qvw2a`，欢迎页可见，侧栏空草稿不落库
- [x] 输入文字发送 → 发送成功且助手回复 —— 真实 UI 输入 + 点击发送：会话键 `agent:main:session-1791536153880-capfil`，`messages` 为 `[user, assistant]`，界面出现助手回复「收到」，`lastError` 为 `null`
- [x] 应用启动后日志无 `channel exited: Package subpath './plugin-sdk/channel-runtime'` —— 重启后 `channel exited` 计数为 0（重启前为每 5 分钟一次）
- [x] 日志出现 `starting weixin provider` 且无 `auto-restart attempt` —— 22:50:11 / 22:55:21 均出现 `starting weixin provider` + `weixin monitor started`，无 `auto-restart`、无 `giving up`

**关联流程**
- [x] 点击历史裸键会话（「1111」）→ 归一化为 `agent:main:session-1791536153880-capfil`（日志 `⇄ res ✓ chat.history`），并在该会话内发送成功
- [x] 微信真实入站消息到达应用 —— 日志 `[session] Remote source: channel=weixin user=o9cq80xZ…@im.wechat` + `[companyclaw] Task created for remote message (task=…)` 连续多条
- [ ] 切到 `code-geek` 新建发送 → 键为 `agent:code-geek:…` —— **未实机验证**（store 层由既有/新增单测覆盖 `agent:coder:session-` 形态，未在 UI 上切 agent 实测）
- [x] 删除会话 / 清空历史后 → 新草稿键为 `agent:main:…` —— 单测 "does not persist a generated empty draft after deleting the last session" 断言 `/^agent:main:session-/`
- [x] 连续启动两次 → 第二次不触发插件重装 —— 首次（无指纹记录）打印 `WeChat plugin payload refreshed from the bundled payload`，重启后不再打印
- [x] 微信插件状态 —— 网关日志 `http server listening (3 plugins: browser, memory-core, openclaw-weixin)`，通道进入 `weixin monitor started`

**边界**
- [x] 空输入时发送按钮保持禁用 —— 既有行为未改动（`ChatView.vue` 未触碰）
- [x] `mainSessionKey` 尚未从握手获得时 `switchSession("main")` 不产生裸键 —— 新增单测 "never resolves the main alias to a bare key" 通过
- [x] 指纹文件中缺失/损坏 → 只触发一次重装 —— 实测：移走指纹记录后重启仅重装一次并回写指纹（`2034908093…ae438`），未进入重启循环
- [x] `sessions.usage` 报错仍会出现 —— 新运行日志中仍为 `⇄ res ✗ sessions.usage … "main" has no explicit owner`，属已知遗留（未修）

**命令**
- [x] `npm test --prefix desktop` → 87 文件 / 1574 通过 + 2 skipped
- [x] `npm test --prefix desktop/renderer` → 28 文件 / 331 通过
- [x] `npm run lint --prefix desktop` → 2 error 均为**既有**问题（`chat-attachments.ts`、`openclaw-upgrade-recovery.ts`，`git status` 证实本次未触碰）；本次改动文件单独 lint 为 0 error
- [x] `npm run lint --prefix desktop/renderer` → 本次改动文件 0 error
- [x] `npm run lint:weixin --prefix desktop` → 0 error（7 warning 全部既有）
- [x] `npm run build --prefix desktop` → tsc + vue-tsc + vite 全部成功

**不可验证（记录为 BLOCKED）**
- [x] 微信真机扫码往返、审批卡片、文件回传 → `BLOCKERS.md` B1（无测试微信账号）→ 本轮记 **BLOCKED**（本轮观察到的入站来自用户本人账号，非受控测试账号）

---

## 6. Plan Adjustment 记录（执行中如需要则追加）

（无。执行全程未超出本 Plan 文件范围，未触发 Additional Change Required。）

## 7. Execution Log

### Step 0 Completed（备份）

Changed：`backups/2026-10-09-mini-fixes/sessionkey-weixin/`（7 个待改文件的副本，保留相对路径）

### Step 1 Completed（插件宿主 SDK 子路径对齐）

Changed：`plugins/openclaw-weixin/src/messaging/process-message.ts`、`desktop/src/companyclaw/plugins/weixin-sdk-contract.test.ts`（新增）

Summary：先写契约测试并确认 FAIL（精确报出 `channel-runtime` 不在白名单），再把导入改为 `channel-message`，测试转 PASS。

Verification：`npx vitest run src/companyclaw/plugins/weixin-sdk-contract.test.ts` → 2 passed。

### Step 2 Completed（载荷指纹驱动重装）

Changed：`desktop/src/companyclaw/plugins/weixin-plugin-install.ts`(+test)、`desktop/src/main.ts`

Summary：新增载荷指纹与 `.companyclaw-payload.json` 记录；已安装但指纹过期时重装；`main.ts` 增加 `refreshed` 分支日志。

Verification：`npx vitest run src/companyclaw/plugins/weixin-plugin-install.test.ts` → 11 passed；真实 stateDir 探针：首次 `{"state":"refreshed"}`、再次 `{"state":"already-present"}`。

### Step 3 Completed（会话键一律 agent 限定）

Changed：`desktop/renderer/src/stores/chat.ts`(+test)

Summary：`newSession()` 默认 agent 也加前缀；两处回落键加前缀；更新 3 处既有断言并新增用例。

Verification：`npx vitest run src/stores/chat.test.ts` → 89 passed；协议探针：裸键 `REJECTED`、前缀键 `ACCEPTED by gateway`。

### Step 4 Completed（历史裸键归一化 + 按钮真正新建）

Changed：`desktop/renderer/src/stores/chat.ts`、`desktop/renderer/src/components/SidePanel.vue`、`desktop/renderer/src/stores/chat.test.ts`

Summary：新增 `qualifySessionKey()`，`switchSession()` 对历史裸键与 `main` 别名归一化；`createNewChat()` 改为一定新建。

Verification：新增 5 例切换用例通过；CDP 真实点击「创建新对话」产生新键、点击「1111」得到 `agent:main:session-1791536153880-capfil`。

**Step 4 执行中发现的补偿修复（Step 4b，未超出 Plan 文件范围）**：CDP 实测发现切换到历史裸键后，侧栏同时留下 `session-…` 旧卡与 `agent:main:session-…` 新卡（同一会话两张卡）。原因是 `switchSession()` 只做了键归一化，没有走既有的 `_canonicalizeSessionKey()` 合并路径（该方法专为此设计，`setMainSessionKey` 与流式事件路径都在用）。修复：在 `switchSession()` 中当 `targetKey !== key` 时调用 `_canonicalizeSessionKey(key, targetKey)`；新增单测 "merges the legacy card into the qualified key instead of keeping both"。复测侧栏由 4 项变为 3 项，旧卡消失。

### Step 5 Completed（重编译载荷并启动验证）

Changed：`desktop/resources/openclaw-weixin/dist/**`（gitignored 构建产物）

Summary：用仓库源码重编译插件 dist；应用启动后按指纹自动刷新已安装副本。

Verification：dist 中 `channel-runtime` 为 0 命中、`process-message.js` 引用 `channel-message`；重启后 `channel exited` 为 0，`weixin monitor started` 出现，真实微信消息进入应用并创建任务。

