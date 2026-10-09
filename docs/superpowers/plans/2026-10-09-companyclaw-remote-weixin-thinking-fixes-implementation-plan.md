# Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`（本仓库既有惯例，见 `docs/superpowers/plans/2026-10-09-companyclaw-v3-closure.md`）。执行中若发现影响范围扩大或本 Plan 不准确，必须先输出 **Plan Adjustment** 并停下等待确认。

- 计划文件：`docs/superpowers/plans/2026-10-09-companyclaw-remote-weixin-thinking-fixes-implementation-plan.md`
- 代码基线：`feat/companyclaw-foundation` / `250c96aae0815877289141bdab570dd74f908b13`
- 需求来源：已确认的三条小需求
  1. 点击「远程操作」报 `companyclaw:set-remote-authorization` / `ownerSid, deviceId and channelUserId are required to enable remote operation`（截图 1）。
  2. 微信插件无法开启频道登录和扫码（截图 2：只显示「等待扫码 / 登录进程运行中」，没有二维码）。
  3. 大模型的思考挡位无法设置。
- 前置已完成：需求确认 → 代码调查 → Impact Map → Mini Plan（见对话记录，本文件是其正式化落地）。
- **待确认假设（本 Plan 以此为执行前提）**：需求 1 的 `channelUserId` 来源采用「微信扫码登录成功后由主进程自动绑定本机微信身份」。若否决该假设，需先输出 Plan Adjustment 再进入 Coding。
- 责任主体标注沿用 `BLOCKERS.md`：**[构建方]** 由构建机/CI 解决；**[验证方]** 记 `BLOCKED`/`UNVERIFIED`。

---

## 0. Global Constraints（执行原则）

1. 只修改本 Plan「4. Changed Files Tracking」中列出的文件；不额外重构、不提前抽象、不改既有架构与代码风格。
2. 每个 Step 走 TDD：先写失败测试（可测的改动）→ 跑失败 → 最小实现 → 跑通过 → 该步结束前更新「Execution Log」。
3. 修改文件前先备份到 `backups/2026-10-09-mini-fixes/`（见 Step 0）。
4. 需求 2 的真机扫码验收受 B1（无微信测试账号）阻塞：本机只验证到「二维码产出 / provider 已加载 / 绑定文件生成」，扫码成功与消息往返记 `BLOCKED`，不得用 Mock 冒充 PASS。
5. 发现新增文件、范围扩大、原 Plan 与实际不符 → 立即停下输出 **Plan Adjustment**，等待确认。
6. 每个 Step 完成后可按 Step 粒度提交一次（commit message 采用仓库现有 `fix(companyclaw): ...` / `feat(companyclaw): ...` 风格），是否提交由执行者与用户约定；本 Plan 默认每步提交。

---

## 1. Goal

### 1.1 本次修改目标

把三条用户实测缺陷修到「主流程可用 + 失败原因可见」：

1. **远程操作授权可用**：主进程在渲染层没有提供 `channelUserId` 时，回落到本机已绑定的微信身份；并在未绑定时给出可执行的中文提示，而不是内部字段名报错。
2. **微信频道登录/扫码可用**：让网关真正加载 `openclaw-weixin`（开发态也安装已编译的插件、启用后自动重启网关），`web.login.start/wait` 显式指定 `channel`，快路径失败原因在界面上可见。
3. **思考挡位可设置**：在「设置 → 大模型」补上推理强度（思考挡位）控件，落盘到 `agents.defaults.models[<modelRef>].params.thinking` 与 provider model 的 `reasoning`，重启网关后回读仍生效。
4. 配套：登录成功后自动建立「微信身份 → 设备 → SID」绑定（`identity-binding.json`），这是需求 1 成立的前提，也是实施书 §15.1/§15.2「扫码绑定」的缺失实现。

### 1.2 不包含（明确排除）

- 不改 `desktop/src/companyclaw/ipc.ts` 的其它 handler、`preload.ts` 的 API 形状、`identity-binding.ts` 的存储契约。
- 不改 Broker / Browser / 审批 / 任务系统 / 安全策略 / MXC 路径。
- 不改打包链路（`electron-builder.yml`、`build.ps1`、`prepare-production-resources.mjs`）。
- 不改 `ModelSetupDialog.vue` 的建模型流程，不改首启向导已有的推理强度写入逻辑。
- 不修「`ArtifactDelivery.boundChannelUserId` 启动快照」问题（首次扫码后产物投递需等下次启动才拿到绑定值）——列为后续项，不在本次范围。
- 不为 GitHub Copilot（`auth-managed`）模型设计特殊写入路径：设置页对该类模型禁用档位选择。
- 不升级/降级 OpenClaw、Electron、Element Plus 及任何依赖。
- 不做 UI 视觉重构、不新增抽象层、不为未来功能预留开关。

### 1.3 成功标准

| # | 标准 | 判定证据 |
|---|---|---|
| S1 | 已有绑定身份时，只传 `enabled/ownerSid/deviceId/ttlMinutes` 也能开启远程操作 | `runtime.test.ts` 新增用例 PASS |
| S2 | 未绑定时开启远程操作给出中文可执行提示 | 手工点「开启远程操作」+ 代码检查 `ipc.ts` 分支 |
| S3 | 微信扫码登录成功后本机生成身份绑定 | `<stateDir>/identity-binding.json` 出现且 `TasksView` 显示「已绑定」 |
| S4 | 开发态启动后网关能看到微信插件 | `<stateDir>/extensions/openclaw-weixin/package.json` 存在；`openclaw.json` 出现 `plugins.installs.openclaw-weixin` |
| S5 | 插件启用后网关自动重启并加载插件 | 日志出现 `[restart] Enabling the WeChat plugin`；点击「登录微信」出现二维码 canvas，而不是 CLI 终端 |
| S6 | `web.login.start/wait` 请求带 `channel: "openclaw-weixin"` | 代码检查 + 网关日志无 `web login provider is not available` |
| S7 | 设置页可切换思考挡位并落盘 | `openclaw.json` 的 `agents.defaults.models[ref].params.thinking` 与 provider model `reasoning` 随选择变化；重启后 UI 回读一致 |
| S8 | 全量 test / build / lint 不回归 | `npm test`、`npm run build`（desktop + renderer）、`npm run lint` |

### 1.4 本机可达性与已知阻塞

- 本机存在 OpenClaw 运行时 `~/.openclaw-node/node_modules/openclaw`（dev 解析入口可用），dev 态 `userData = %APPDATA%/MicroClaw`。
- 开发态插件源为构建产物 `desktop/resources/openclaw-weixin`（`prepare-production-resources.mjs` 生成，`.gitignore` 忽略；本机已存在且含 `dist/`、`node_modules/`）。干净检出缺该目录时，按 S4 的错误提示先执行 `npm run prepare-production-resources`。
- **B1 [验证方]**：无微信测试账号 → 真实扫码、消息收发、远程任务闭环只能记 `BLOCKED`/`UNVERIFIED`；本 Plan 用「账号文件夹具」验证绑定读取链路，不冒充真实扫码。

---

## 2. Current Understanding

### 2.1 三条链路的当前实现（已核实，含行号）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 远程授权 UI | `desktop/renderer/src/views/TasksView.vue:48-56`、`SetupWizard.vue:205-218` | 只传 `{ enabled:true, ttlMinutes }`，从不传 `channelUserId` |
| 远程授权 store | `desktop/renderer/src/stores/companyclaw.ts:251-270` | 支持可选 `channelUserId`，调用点未使用 |
| 远程授权 IPC | `desktop/src/companyclaw/ipc.ts:158-178` | 主进程补 `ownerSid/deviceId`，`channelUserId: input?.channelUserId ?? ""` |
| 远程授权核心 | `desktop/src/companyclaw/runtime.ts:317-343` | `331-335` 三个字段任一为空即抛英文错误 |
| 远程授权消费 | `runtime.ts:294-301`（`isRemoteCallerAuthorized`）、`main.ts:4574-4612`（审批回执与 `session-source`） | 绑定 + 授权同时满足才接受；绑定缺失时入站消息被忽略 |
| 身份绑定存储 | `desktop/src/companyclaw/remote/identity-binding.ts`、`main.ts:181-192 / 251-279` | 存储/查询/绑定能力齐全 |
| 身份绑定调用 | `preload.ts:604-613` 暴露 `identity.bind`；渲染层无任何调用点 | **绑定从未发生**；启动时快照只用于产物投递（`main.ts:8427`） |
| 插件开关 | `desktop/src/main.ts:6003-6014` | 只写 `openclaw.json`，不重载网关；i18n 明确提示「请重启网关」 |
| 插件安装 | `main.ts:1590-1628` → `weixin-plugin-install.ts:89-96` | `!app.isPackaged` 直接 `skipped`，dev 永不安装 |
| 插件安装实测 | `%APPDATA%/microclaw/openclaw-state` | `plugins.entries.openclaw-weixin.enabled=true`、无 `plugins.installs`、无 `extensions/` |
| QR 登录快路径 | `desktop/src/gateway-client.ts:540-556` | `web.login.start/wait` 不带 `channel` |
| QR 登录主进程 | `main.ts:6103-6148` | 网关未连接/请求失败 → `{ok:false,error}`，渲染层静默转 CLI |
| QR 登录界面 | `PluginsView.vue:253-330`、`ChannelsView.vue:239-316` | 快路径失败后进入无 TTY 的 CLI 兜底，只显示「等待扫码/登录进程运行中」 |
| 思考挡位入口 | `SetupWizard.vue:71-79 / 245-253 / 443-490` | 仅首启向导可设，写 `agents.defaults.models[ref].params.thinking` |
| 思考挡位设置页 | `SettingsView.vue:223-300`（models 区块） | 无控件；`settings.reasoningEffort/reasoning*`（zh 482-489 / en 511-518）无使用点 |
| 可复用写配置能力 | `renderer/src/utils/model-provider.ts:119-153 / 295-305`、`SettingsView.vue:2300-2326` | `updateModelProviderConfig`（含 reasoningEffort）已导出未使用；`persistAndRestart` 已具备写配置+重启+回读 |

### 2.2 数据流 / 调用链

远程操作：
```
TasksView / SetupWizard
  → store.enableRemoteOperation({ ttlMinutes })
    → window.openclaw.companyClaw.setRemoteAuthorization({ enabled:true, ttlMinutes })
      → ipcMain "companyclaw:set-remote-authorization"        (ipc.ts:158)
        → runtime.setRemoteAuthorization({ ownerSid, deviceId, channelUserId:"" })   ← 断点
          → RemoteAuthorization.setEnabled → 写 remote-authorization.json
消费侧：runtime.isRemoteCallerAuthorized(identity.isAuthorized && state==="enabled")
```

微信登录：
```
PluginsView/ChannelsView
  → plugin.weixin.setEnabled(true) → ipc "plugin:weixin:set-enabled" → 只写 openclaw.json（网关未重载）
  → plugin.weixin.loginQrStart({accountId:"default"})
      → ipc "plugin:weixin:login-qr-start" → gwClient.weixinLoginQrStart
        → RPC "web.login.start"（无 channel）→ 无可解析 provider → INVALID_REQUEST
  → 失败 → plugin.weixin.login() → spawn `openclaw channels login --channel openclaw-weixin`（无 TTY、插件未安装）→ 挂起
前置：ensureWeixinPluginAvailable() → ensureWeixinPluginInstalled() → dev 直接 skip（extensions/ 为空）
```

思考挡位：
```
SetupWizard（首启）→ config.write(agents.defaults.models[ref].params.thinking) + models.providers[..].models[].reasoning
SettingsView 读：applyModelsConfig() → ModelEntry.reasoningEffort ← params.thinking（无控件可写）
```

### 2.3 已确认的影响范围

- 直接修改：`runtime.ts(/test)`、`main.ts`、`weixin-plugin-install.ts(/test)`、`gateway-client.ts`、`PluginsView.vue`、`ChannelsView.vue`、`SettingsView.vue`、`i18n/zh-CN.ts`、`i18n/en-US.ts`。
- 关联检查：`ipc.ts`（仅 Step 1c 增加中文分支）、Guardian 探针、首次运行向导的 `weixinBound` 显示、`stores/companyclaw.test.ts` 与 `SetupWizard.test.ts` 既有断言。
- 确认无需修改：`identity-binding.ts`、`preload.ts`、`stores/companyclaw.ts`、`TasksView.vue`、`SetupWizard.vue`、`ModelSetupDialog.vue`、`model-provider.ts`（复用即可）、Broker/审批/策略模块。

### 2.4 需求文档与现有代码不一致（需在验收中记录）

- 实施书 §15.1「显示二维码 → 扫码绑定」与 §15.2「微信连接：…已绑定身份…」要求扫码即形成绑定；代码里 `identity.bind` 从未被调用。本 Plan 按 §1 假设在登录成功后自动绑定。
- 实施书 §15.2 要求失败原因「中文可解释」；当前远程授权未绑定场景返回英文内部字段名。本 Plan Step 1c 补中文提示。

---

## 3. Implementation Steps

### Step 0（执行前）备份改动文件

#### Target

- `backups/2026-10-09-mini-fixes/`（新建目录与备份文件）

#### Current Behavior

- 仓库根已有 `backups/` 目录，但本轮要改的文件尚无备份。

#### Change

在仓库根执行（Windows bash）：

```bash
cd /d/code/ai/MicroClaw/code/CompanyClaw
mkdir -p backups/2026-10-09-mini-fixes
cp --parents \
  desktop/src/companyclaw/runtime.ts \
  desktop/src/companyclaw/runtime.test.ts \
  desktop/src/main.ts \
  desktop/src/companyclaw/plugins/weixin-plugin-install.ts \
  desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts \
  desktop/src/gateway-client.ts \
  desktop/renderer/src/views/PluginsView.vue \
  desktop/renderer/src/views/ChannelsView.vue \
  desktop/renderer/src/views/SettingsView.vue \
  desktop/renderer/src/i18n/zh-CN.ts \
  desktop/renderer/src/i18n/en-US.ts \
  backups/2026-10-09-mini-fixes/
```

#### Reason

- 执行宪法 D1：修改重要文件前先备份到 `backups/`。

#### Risk

- 无（仅新增备份文件，不改代码）。

#### Verification

- `ls backups/2026-10-09-mini-fixes/desktop/src` 能看到对应文件。

---

### Step 1 远程授权回落到本机绑定身份

#### Target

- 文件：`desktop/src/companyclaw/runtime.ts`（`setRemoteAuthorization`，317-343）
- 文件：`desktop/src/companyclaw/runtime.test.ts`（新增用例）
- 文件：`desktop/src/companyclaw/ipc.ts`（`companyclaw:set-remote-authorization` handler，158-178）

#### Current Behavior

- 渲染层不传 `channelUserId`，IPC 补 `""`，`runtime.setRemoteAuthorization` 直接抛 `ownerSid, deviceId and channelUserId are required to enable remote operation`（截图 1）。
- 即使本机已有 `identity-binding.json`，该绑定也不参与远程授权。

#### Change

1a. `runtime.ts` 的 `setRemoteAuthorization`：

```ts
    // The renderer may not know the paired channel user: the grant is bound to
    // whoever this machine has actually paired. Fail closed when neither exists.
    const channelUserId = input.channelUserId || this.identity.get()?.channelUserId || "";
    if (!input.ownerSid || !input.deviceId || !channelUserId) {
      throw new Error(
        "ownerSid, deviceId and channelUserId are required to enable remote operation",
      );
    }
    this.authorization.setEnabled({
      ownerSid: input.ownerSid,
      deviceId: input.deviceId,
      channelUserId,
      ttlMs: ttlMinutes * 60_000,
    });
```

1b. `runtime.test.ts` 在「enables remote operation only with an explicit grant and expiry」之后新增：

```ts
  it("uses the bound WeChat identity when the caller omits channelUserId", async () => {
    const { runtime } = makeRuntime();
    await runtime.bindIdentity({
      channelType: "weixin",
      channelUserId: "wx-owner",
      deviceId: "device-a",
    });
    const granted = runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      ttlMinutes: 60,
    });
    expect(granted).toMatchObject({ state: "enabled", channelUserId: "wx-owner" });
  });
```

1c. `ipc.ts` handler：把「无绑定 + 无入参」翻译成中文可执行提示（核心仍保留英文契约）：

```ts
  ipcMain.handle(
    "companyclaw:set-remote-authorization",
    (
      _event,
      input: {
        enabled: boolean;
        ttlMinutes?: number;
        channelUserId?: string;
      },
    ) => {
      // The renderer cannot choose its own ownership: the main process supplies
      // the SID, the device and the paired channel user the grant is bound to.
      const channelUserId =
        input?.channelUserId || runtime.getIdentityBinding()?.channelUserId || "";
      if (input?.enabled === true && !channelUserId) {
        throw new Error("微信身份未绑定：请先在「微信连接」完成扫码登录，再开启远程操作。");
      }
      return runtime.setRemoteAuthorization({
        enabled: input?.enabled === true,
        ownerSid: options.ownerSid,
        deviceId: options.deviceId,
        channelUserId,
        ttlMinutes: input?.ttlMinutes,
      });
    },
  );
```

#### Reason

- 需求 1 的直接根因就是「没有任何调用方提供 `channelUserId`」；绑定是远程消息能通过 `isRemoteCallerAuthorized` 的唯一身份来源，回落到它是唯一既安全又可用来源。
- IPC 分支把「真的没绑定」变成用户可执行的动作提示，满足实施书 §15.2 的中文可解释要求。

#### Risk

- `Runtime.setRemoteAuthorization` 行为变宽松（缺参时会读本机绑定）；已有测试均显式传 `channelUserId`，不受影响；新增用例覆盖新分支。
- 若本机绑定被替换（解绑后重新扫码），授权记录里的 `channelUserId` 仍是旧的；远程消息校验以绑定为准，因此旧的授权记录不会越权（`isRemoteCallerAuthorized` 要求两者同时成立），无需迁移。

#### Verification

```bash
cd desktop && npx vitest run src/companyclaw/runtime.test.ts
```
预期：新用例 PASS，原有 TTL/撤销/越权用例不回归。

---

### Step 2 扫码登录成功后自动绑定微信身份（含启动补偿）

#### Target

- 文件：`desktop/src/main.ts`
  - 模块级变量：`companyClawOwnerSid`（371 行附近）旁新增 `companyClawDeviceId`
  - `registerCompanyClawIpcHandlers` 调用处（8377-8395）赋值
  - `readWeixinPluginStatus`（1636-1664）之后新增两个 helper
  - 调用点：`startApplicationServices`（1712-1717）、`plugin:weixin:login-qr-wait`（6126-6148）、`plugin:weixin:login` 的 `close(code===0)`（6061-6083）

#### Current Behavior

- `identity.bind` 从未被调用；`identity-binding.json` 不存在，`TasksView` 永远显示「未绑定」；远程授权/远程消息因此无法真正成立。

#### Change

2a. 模块级变量与赋值：

```ts
let companyClawOwnerSid = "";
let companyClawDeviceId = "";
```
```ts
    companyClawOwnerSid = resolveOwnerSid();
    companyClawDeviceId = deviceIdentity.deviceId;
```

2b. 在 `readWeixinPluginStatus` 之后新增 helper：

```ts
/**
 * The WeChat user id of the account that logged in on this machine.
 *
 * OpenClaw's QR login result does not carry the platform user id, but the
 * plugin persists it in its own account file; that file is the trusted source
 * for the identity this device is paired with.
 */
function readWeixinAccountUserId(): string | null {
  try {
    const weixinDir = path.join(getOpenClawStateDir(), "openclaw-weixin");
    const accountsIndexPath = path.join(weixinDir, "accounts.json");
    if (!fs.existsSync(accountsIndexPath)) return null;
    const accounts = JSON.parse(fs.readFileSync(accountsIndexPath, "utf-8"));
    if (!Array.isArray(accounts)) return null;
    for (const accountId of accounts) {
      if (typeof accountId !== "string" || !accountId) continue;
      const accountPath = path.join(weixinDir, "accounts", `${accountId}.json`);
      if (!fs.existsSync(accountPath)) continue;
      const account = JSON.parse(fs.readFileSync(accountPath, "utf-8"));
      const userId = typeof account?.userId === "string" ? account.userId.trim() : "";
      if (userId) return userId;
    }
  } catch (error) {
    console.warn("[companyclaw] Cannot read the WeChat account identity:", error);
  }
  return null;
}

/**
 * Pairs the WeChat account that logged in on this machine, once.
 *
 * Binding is what lets an inbound message prove who sent it, so nothing else
 * (remote authorization included) works without it. A second call is a no-op:
 * a restart must never overwrite an existing pairing.
 */
async function ensureWeixinIdentityBound(): Promise<void> {
  if (!companyClawRuntime || !companyClawDeviceId) return;
  try {
    if (companyClawRuntime.runtime.getIdentityBinding()?.channelUserId) return;
    const channelUserId = readWeixinAccountUserId();
    if (!channelUserId) return;
    await companyClawRuntime.runtime.bindIdentity({
      channelType: "weixin",
      channelUserId,
      deviceId: companyClawDeviceId,
    });
    console.log("[companyclaw] Bound the WeChat identity to this device");
  } catch (error) {
    console.error("[companyclaw] WeChat identity binding failed:", error);
  }
}
```

2c. 调用点：

- `startApplicationServices()`（`ensureWeixinPluginAvailable();` 之后）：

```ts
  ensureWeixinPluginAvailable();
  await ensureWeixinIdentityBound();
```

- `plugin:weixin:login-qr-wait`（拿到 `result` 后）：

```ts
      try {
        const result = await gwClient.weixinLoginQrWait(params);
        if (result?.connected) await ensureWeixinIdentityBound();
        return result;
      } catch (err: any) {
        // 原有 catch 保持不变
      }
```

- `plugin:weixin:login` 的 `child.on("close", (code) => { ... })` 内、`if (code === 0) {` 分支开头：

```ts
        if (code === 0) {
          void ensureWeixinIdentityBound();
          // 原有“2 秒后重启网关”逻辑保持不变
```

#### Reason

- 这是需求 1 成立与实施书 §15.1/§15.2「扫码绑定」的共同前置；`openclaw-weixin/accounts/<id>.json` 是插件唯一持久化平台用户 id 的位置。
- 启动补偿覆盖「用户先登录、后升级/重启」的历史状态，避免只有重新扫码才能用。

#### Risk

- 自动绑定把「本机扫码登录的微信」设为唯一远程身份；`TasksView` 的解绑入口仍可解除，解绑后需重新扫码或重启补偿。
- 若账号文件损坏/缺失：不绑定、不抛错，远程授权会按 Step 1c 给出中文提示（fail-closed）。
- `companyClawDeviceId` 必须在 `registerCompanyClawIpcHandlers` 之前赋值；若注册失败（try/catch）则保持空串，helper 直接返回，行为与现状一致。

#### Verification

```bash
cd desktop && npx vitest run src/companyclaw/runtime.test.ts
cd desktop && npx tsc --noEmit
```
手工夹具验证（无真实微信账号，仅验证读取/绑定链路，不冒充真实扫码）：
1. 在 `<stateDir>/openclaw-weixin/accounts.json` 写入 `["default"]`，在 `accounts/default.json` 写入 `{"token":"x","userId":"wx-fixture"}`；
2. 启动 dev 应用 → `TasksView` 显示「已绑定 / weixin / wx-fixture」，`<stateDir>/identity-binding.json` 出现；
3. 删除夹具文件并解绑后，恢复未绑定状态。

---

### Step 3 开发态安装微信插件 + 启用后自动重启网关

#### Target

- 文件：`desktop/src/companyclaw/plugins/weixin-plugin-install.ts`（`WeixinPluginInstallInput` 28-36、`ensureWeixinPluginInstalled` 83-140）
- 文件：`desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts`
- 文件：`desktop/src/main.ts`（import 60-63、`ensureWeixinPluginAvailable` 1590-1628、`plugin:weixin:set-enabled` 6003-6014）
- 文件：`desktop/renderer/src/i18n/zh-CN.ts:197`、`desktop/renderer/src/i18n/en-US.ts:208-209`

#### Current Behavior

- `ensureWeixinPluginInstalled` 在 `!app.isPackaged` 时返回 `{ok:true,state:"skipped"}`，dev 永不安装；实测 `openclaw-state/extensions/` 为空、`plugins.installs` 缺失 → 网关没有该 channel plugin。
- `plugin:weixin:set-enabled` 只写配置文件，运行中的网关不会加载新插件（i18n 让用户自己重启）。

#### Change

3a. `weixin-plugin-install.ts`：入参改为显式插件源目录，删除打包态判断：

```ts
export interface WeixinPluginInstallInput {
  /** Directory that holds the plugin to install (packaged payload or dev staging). */
  pluginSourceDir: string;
  nodePath: string | null;
  openClawEntry: string | null;
  stateDir: string;
  /** Injected so tests can drive the CLI without spawning a process. */
  runCli?: (args: string[]) => { status: number | null; output: string };
}
```

```ts
export function ensureWeixinPluginInstalled(
  input: WeixinPluginInstallInput,
): WeixinPluginInstallOutcome {
  const pluginDir = input.pluginSourceDir;
  if (!fs.existsSync(path.join(pluginDir, "package.json"))) {
    return { ok: false, reason: "PLUGIN_RESOURCE_MISSING", detail: pluginDir };
  }
  if (weixinPluginInstalled(input.stateDir)) {
    return { ok: true, state: "already-present" };
  }
  if (!input.nodePath || !input.openClawEntry) {
    return { ok: false, reason: "PLUGIN_INSTALL_UNAVAILABLE", detail: "missing OpenClaw entry" };
  }
  // …以下 runCli/spawnSync 与失败返回保持不变，仅把安装目标从 resourcesPath 换成 pluginDir：
  const result = run(["plugins", "install", "--force", pluginDir]);
  // …
}
```

同时更新模块头注释：说明 dev 与打包态都安装到「应用私有的 `<userData>/openclaw-state/extensions`」，不再有「不碰开发者 state」的跳过分支。

3b. `main.ts` import 增加 `WEIXIN_PLUGIN_RESOURCE_DIR`，新增源目录解析：

```ts
function resolveWeixinPluginSourceDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, WEIXIN_PLUGIN_RESOURCE_DIR);
  // A source checkout has no packaged payload: the build step stages the
  // compiled plugin under resources/, and dev uses the same layout.
  return path.join(app.getAppPath(), "resources", WEIXIN_PLUGIN_RESOURCE_DIR);
}
```

`ensureWeixinPluginAvailable()` 中改为：

```ts
    outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: resolveWeixinPluginSourceDir(),
      nodePath,
      openClawEntry,
      stateDir: getOpenClawStateDir(),
    });
```

失败提示按运行模式区分：

```ts
  const message =
    outcome.reason === "PLUGIN_RESOURCE_MISSING"
      ? app.isPackaged
        ? `微信插件资源缺失（${outcome.detail ?? ""}）。请重新运行 CompanyClaw 安装包修复安装。`
        : `微信插件资源缺失（${outcome.detail ?? ""}）。请在 desktop 目录运行 npm run prepare-production-resources 后重启应用。`
      : `微信插件未能安装：${outcome.detail ?? outcome.reason}。可在任务中心重新尝试，或重新运行安装包修复安装。`;
```

3c. `plugin:weixin:set-enabled`：

```ts
  ipcMain.handle("plugin:weixin:set-enabled", async (_event, enabled: boolean) => {
    assertWindowsNodeMxcConfigurationMutable();
    const existing = readConfig() || {};
    // One set of enable rules, shared with first-run installation: an enable
    // has to reach both entries.enabled and plugins.allow or the Gateway may
    // load the plugin asynchronously.
    const config = planWeixinPluginEnable(existing, enabled);
    const stateDir = getOpenClawStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
    // A plugin entry only takes effect when the Gateway loads it: without the
    // restart the next QR login finds no provider and silently falls back to a
    // CLI that cannot show a QR code.
    await restartManagedGateway(
      enabled ? "Enabling the WeChat plugin" : "Disabling the WeChat plugin",
    );
    return { ok: true };
  });
```

3d. i18n 文案随自动重启更新：

- `zh-CN.ts`：`"plugins.weixinEnabled": "微信插件已启用，网关正在重启…"`
- `en-US.ts`：`"plugins.weixinEnabled": "WeChat plugin enabled. Restarting the gateway…"`

3e. `weixin-plugin-install.test.ts` 调整：

- 删除 `it("does nothing in a source checkout", ...)`；
- 所有用例把 `isPackaged/resourcesPath` 换成 `pluginSourceDir`：
  - 资源缺失：`pluginSourceDir: path.join(root, "resources", "openclaw-weixin")`；
  - 安装：`pluginSourceDir: path.join(resourcesPath, "openclaw-weixin")`，断言 `[["plugins","install","--force", path.join(resourcesPath,"openclaw-weixin")]]`；
  - 已存在跳过 / 安装失败 / 运行时缺失：同样改用 staged 目录。
- 用例标题从「installs the packaged plugin through OpenClaw」改为「installs the staged plugin through OpenClaw」。

#### Reason

- 网关只在 `<stateDir>/extensions/` 发现插件，dev 跳过安装是实测「无二维码」的直接根因。
- 启用后不重载 = 下一次 `web.login.start` 依然找不到 provider；自动重启把「用户需要知道按哪个按钮」变成默认正确行为。

#### Risk

- 开关操作现在会触发网关重启（秒级重连），UI 的 switch loading 已存在；`plugins.weixinEnabled` 文案已同步。
- 干净检出缺 `desktop/resources/openclaw-weixin` 时不会静默：dev 提示先跑 `prepare-production-resources`。
- `openclaw plugins install` 首次安装需数秒（spawnSync，120s 超时）；已有「已存在即跳过」，只在首次支付成本。
- 不再有「dev 不碰 state」保护；当前 state 为 `<userData>/openclaw-state`（应用私有），若显式设置 `OPENCLAW_STATE_DIR` 指向共享目录，安装会写入该目录——执行前确认本机未设置该变量（本机未设置）。

#### Verification

```bash
cd desktop && npx vitest run src/companyclaw/plugins/weixin-plugin-install.test.ts
cd desktop && npx tsc --noEmit
```
手工验证：
1. 删除 `<stateDir>/extensions/openclaw-weixin` 与 `plugins.installs` 后启动 dev → `extensions/openclaw-weixin/package.json` 重新出现，`openclaw.json` 的 `plugins.installs.openclaw-weixin` 出现，日志有 `WeChat plugin installed from the bundled payload`；
2. 插件页切换开关 → 日志出现 `[restart] Enabling the WeChat plugin`，网关恢复 running。

---

### Step 4 `web.login.*` 显式 channel + 快路径失败可见

#### Target

- 文件：`desktop/src/gateway-client.ts`（540-556）
- 文件：`desktop/renderer/src/views/PluginsView.vue`（`startLogin`，278-330）
- 文件：`desktop/renderer/src/views/ChannelsView.vue`（`startLogin`，264-316）

#### Current Behavior

- `web.login.start/wait` 不带 `channel`，OpenClaw 只能从「已加载且声明 web.login.* 的 channel plugin」中解析 provider；解析失败返回 `web login provider is not available`。
- 渲染层拿到失败后静默进入 CLI 兜底，界面只显示「等待扫码…」，真实原因不可见。

#### Change

4a. `gateway-client.ts`：

```ts
/** Channel plugin id that owns the WeChat QR login. */
const WEIXIN_WEB_LOGIN_CHANNEL = "openclaw-weixin";
```
```ts
  weixinLoginQrStart(params?: {
    accountId?: string;
    force?: boolean;
    timeoutMs?: number;
  }): Promise<{ qrDataUrl?: string; message: string; sessionKey?: string }> {
    return this.request("web.login.start", { channel: WEIXIN_WEB_LOGIN_CHANNEL, ...params });
  }

  weixinLoginQrWait(params: {
    sessionKey?: string;
    accountId?: string;
    timeoutMs?: number;
  }): Promise<{ connected: boolean; message: string; accountId?: string }> {
    return this.request("web.login.wait", { channel: WEIXIN_WEB_LOGIN_CHANNEL, ...params });
  }
```

4b. `PluginsView.vue` / `ChannelsView.vue` 的 `startLogin`，在 `const ok = await fetchAndRenderQr();` 分支之后、转 CLI 兜底之前插入：

```ts
  if (qrError.value) {
    // The CLI fallback runs without a TTY and cannot display a QR code, so a
    // silent fallback would look like a stuck scan. Show the real reason first.
    ElMessage.warning(t("plugins.loginFailed", { error: qrError.value }));
  }
```

（两个文件同样插入；`ElMessage` 已在两个文件中导入。）

#### Reason

- `channel` 是 OpenClaw schema 的可选字段（Control UI 亦显式传 `channel`），显式传值消除 provider 解析歧义；
- 失败可见对应需求 2 的「无法扫码」体验：不再让用户对着一个不会出码的终端等待 180s。

#### Risk

- `qrError` 也可能来自网关未连接，提示同样成立；
- 不改变原兜底行为（仍会尝试 CLI），只是把原因提前告诉用户。

#### Verification

```bash
cd desktop && npx tsc --noEmit
cd desktop/renderer && npx vue-tsc --noEmit
```
手工验证：插件启用后点「登录微信」→ 出现二维码 canvas；断开网关再点 → 弹出 `登录失败: Gateway not connected` 而非静默等待。

---

### Step 5 设置页新增思考挡位（推理强度）

#### Target

- 文件：`desktop/renderer/src/views/SettingsView.vue`
  - import 块 1254-1263 增加 `updateModelProviderConfig`
  - models 区块模板 264-290（当前模型行之后）
  - `selectedModel`/`selectedModelEntry` 定义处 1886-1903 附近新增状态与选项
  - `persistAndRestart`（2300-2326）之后新增 handler
- 文件：`desktop/renderer/src/i18n/zh-CN.ts`、`en-US.ts`：新增 `settings.reasoningSaved`

#### Current Behavior

- 设置页 models 区块只有「当前模型」下拉与删除按钮；`ModelEntry.reasoningEffort` 只读不写；用户只能在首启向导设置思考挡位。

#### Change

5a. import 增加：

```ts
import {
  normalizeModelInput,
  removeModelProviderConfig,
  selectPrimaryModelConfig,
  retainOnlyProvider,
  updateModelProviderConfig, // 新增：写 params.thinking + model.reasoning
  type ModelApiFormat,
  type ModelInputCapability,
  type ModelReasoningEffort,
} from "@/utils/model-provider";
```

5b. 状态与选项（`selectedModelEntry` 定义之后）：

```ts
const reasoningEffort = ref<ReasoningEffort>("off");
const reasoningSaving = ref(false);

const reasoningEffortOptions: Array<{ value: ReasoningEffort; labelKey: string }> = [
  { value: "off", labelKey: "settings.reasoningOff" },
  { value: "minimal", labelKey: "settings.reasoningMinimal" },
  { value: "low", labelKey: "settings.reasoningLow" },
  { value: "medium", labelKey: "settings.reasoningMedium" },
  { value: "high", labelKey: "settings.reasoningHigh" },
  { value: "xhigh", labelKey: "settings.reasoningXHigh" },
  { value: "adaptive", labelKey: "settings.reasoningAdaptive" },
];

watch(
  selectedModelEntry,
  (entry) => {
    reasoningEffort.value = entry?.reasoningEffort ?? "off";
  },
  { immediate: true },
);
```

5c. 模板：在「当前模型」行所在 `card-row` 之后（仍在 `template v-if="customModels.length"` 内）插入：

```html
            <div class="card-row">
              <span class="row-label">{{ t("settings.reasoningEffort") }}</span>
              <el-select
                v-model="reasoningEffort"
                size="small"
                style="width: 180px"
                :loading="reasoningSaving"
                :disabled="
                  reasoningSaving ||
                  Boolean(switchingModelRef) ||
                  Boolean(removingModelRef) ||
                  copilotDisconnecting ||
                  !selectedModelEntry ||
                  selectedModelEntry.source === 'auth-managed'
                "
                @change="changeReasoningEffort"
              >
                <el-option
                  v-for="option in reasoningEffortOptions"
                  :key="option.value"
                  :label="t(option.labelKey)"
                  :value="option.value"
                />
              </el-select>
            </div>
```

5d. handler（放在 `selectModel` 附近）：

```ts
/**
 * Writes the thinking level for the selected model.
 *
 * Reuses the shared config mutation so `params.thinking` and the provider
 * model's `reasoning` flag are written together, then restarts the Gateway and
 * re-reads the config — the selector must show what is actually stored.
 */
async function changeReasoningEffort(value: ReasoningEffort): Promise<void> {
  const entry = selectedModelEntry.value;
  if (!entry || entry.source === "auth-managed") {
    reasoningEffort.value = entry?.reasoningEffort ?? "off";
    return;
  }
  reasoningSaving.value = true;
  try {
    await persistAndRestart(
      (config) =>
        updateModelProviderConfig(config, {
          providerKey: entry.providerKey,
          baseUrl: entry.baseUrl ?? "",
          apiKey: entry.apiKey ?? "",
          apiFormat: entry.apiFormat ?? "openai-chat",
          modelName: entry.id,
          originalModelName: entry.id,
          displayName: entry.name,
          reasoningEffort: value,
        }),
      t("settings.reasoningSaved"),
    );
  } finally {
    reasoningSaving.value = false;
  }
}
```

5e. i18n：

- `zh-CN.ts`：`"settings.reasoningSaved": "思考挡位已更新"`
- `en-US.ts`：`"settings.reasoningSaved": "Reasoning effort updated"`

#### Reason

- 需求 3 的缺口就是「设置页没有可写入口」；`updateModelProviderConfig` 与 `persistAndRestart` 都是现成能力，只是此前未接线。
- `off` 时删除 `params.thinking` 与 `model.reasoning`、其余档位写 `thinking=<level>` + `reasoning:true` 的行为由 `writeProviderModel` 统一保证，与首启向导一致。

#### Risk

- 写配置会重启网关（既有 `persistAndRestart` 语义，与切换模型一致）；UI 用 `reasoningSaving` 防重复操作。
- `auth-managed`（GitHub Copilot）模型禁用该控件：它们没有 `models.providers` 条目，写回会产生空 provider。
- OpenClaw 还支持 `max` 档；本 Plan 与首启向导保持一致（off..adaptive），不新增档位。

#### Verification

```bash
cd desktop/renderer && npx vue-tsc --noEmit
cd desktop/renderer && npx vitest run src/utils/model-provider.test.ts
```
手工验证：
1. 设置 → 大模型 → 推理强度选 `High` → `openclaw.json` 出现 `agents.defaults.models["<provider>/<model>"].params.thinking === "high"`，且 `models.providers.<provider>.models[<id>].reasoning === true`；
2. 切回「关闭」→ 上述两处被删除；
3. 重启应用后 UI 回读显示所选档位（`applyModelsConfig` 的 `params.thinking` 映射）。

---

### Step 6 全量回归与记录收口

#### Target

- 本 Plan 文件：`docs/superpowers/plans/2026-10-09-companyclaw-remote-weixin-thinking-fixes-implementation-plan.md`（更新第 4、5 节与 Execution Log）
- 代码：无新增修改（只跑验证）

#### Current Behavior

- 前 5 步完成后需要一次性确认没有回归、并把证据写回文档。

#### Change

执行第 5 节全部命令与手工路径；把每个 Step 的 Execution Log（Modified / Changes / Reason / Verification）追加到本文件末尾；若出现范围外问题，停下输出 Plan Adjustment。

#### Reason

- 交付需要可复核的证据，且 BLOCKERS 约定「未验证不得标记 PASS」。

#### Risk

- 无（只读验证 + 文档更新）。

#### Verification

- 见「5. Verification Checklist」全部条目。

---

## 4. Changed Files Tracking

> 根据实际代码修改结果填写（Action：Add / Modify / Delete）。不含未修改文件。

| File | Action | Change |
| ---- | ------ | ------ |
| `backups/2026-10-09-mini-fixes/**`（12 个文件） | Add | 改动前备份（Step 0） |
| `desktop/src/companyclaw/runtime.ts` | Modify | `setRemoteAuthorization`：`channelUserId` 为空时回落到 `this.identity.get()?.channelUserId`，仍为空则 fail-closed 抛错 |
| `desktop/src/companyclaw/runtime.test.ts` | Modify | 新增用例「uses the bound WeChat identity when the caller omits channelUserId」 |
| `desktop/src/companyclaw/ipc.ts` | Modify | `companyclaw:set-remote-authorization`：优先取本机绑定身份；请求启用且无绑定 → 抛中文提示「微信身份未绑定：请先在「微信连接」完成扫码登录，再开启远程操作。」 |
| `desktop/src/main.ts` | Modify | ①新增 `companyClawDeviceId`；②新增 `readWeixinAccountUserId()` 与 `ensureWeixinIdentityBound()`，并在启动、`login-qr-wait` 成功、CLI 登录成功后调用；③`ensureWeixinPluginAvailable` 改用 `resolveWeixinPluginSourceDir()`（打包=resources，dev=`desktop/resources/openclaw-weixin`）并区分 dev 资源缺失提示；④`plugin:weixin:set-enabled` 写配置后 `restartManagedGateway`；⑤`readWeixinPluginStatus.installed` 改为 `weixinPluginInstalled(stateDir) \|\| config.plugins.installs[...]` |
| `desktop/src/companyclaw/plugins/weixin-plugin-install.ts` | Modify | 入参 `pluginSourceDir` 取代 `isPackaged/resourcesPath`；删除 dev skip 分支；安装命令增加 `--accept-capabilities`；更新模块注释 |
| `desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts` | Modify | 删除 skip 用例；全部改用 `pluginSourceDir`；安装断言改为 `["plugins","install","--force","--accept-capabilities",<dir>]` |
| `desktop/src/gateway-client.ts` | Modify | `weixinLoginQrStart/Wait` 请求体固定带 `channel: "openclaw-weixin"` |
| `desktop/renderer/src/views/PluginsView.vue` | Modify | `startLogin` 快路径失败时先 `ElMessage.warning(登录失败: <原因>)` 再走 CLI 兜底 |
| `desktop/renderer/src/views/ChannelsView.vue` | Modify | 同上（与 PluginsView 保持一致） |
| `desktop/renderer/src/views/SettingsView.vue` | Modify | models 区新增「推理强度」`el-select`；新增 `reasoningEffort/reasoningSaving/options` 与 `watch(selectedModelEntry)` 同步；新增 `changeReasoningEffort()`（`updateModelProviderConfig` + `persistAndRestart`）；`auth-managed` 模型禁用 |
| `desktop/renderer/src/i18n/zh-CN.ts` | Modify | `plugins.weixinEnabled` 改为「微信插件已启用，网关正在重启…」；新增 `settings.reasoningSaved` |
| `desktop/renderer/src/i18n/en-US.ts` | Modify | 同步英文：`plugins.weixinEnabled`、`settings.reasoningSaved` |
| `docs/superpowers/plans/2026-10-09-companyclaw-remote-weixin-thinking-fixes-implementation-plan.md` | Add | 本执行文档（计划 + Plan Adjustment + Verification Results + Execution Log） |

---

## 5. Verification Checklist

### 5.1 Test

- [ ] `cd desktop && npx vitest run src/companyclaw/runtime.test.ts src/companyclaw/plugins/weixin-plugin-install.test.ts src/companyclaw/ipc-contract.test.ts`
- [ ] `cd desktop/renderer && npx vitest run src/stores/companyclaw.test.ts src/views/SetupWizard.test.ts src/utils/model-provider.test.ts`
- [ ] 根目录 `npm test`（等价于 desktop + renderer 全量）

### 5.2 Build / Typecheck / Lint

- [ ] `cd desktop && npm run build`（tsc 主进程编译）
- [ ] `cd desktop/renderer && npm run build`（vue-tsc + vite build）
- [ ] `cd desktop && npx tsc --noEmit`
- [ ] `cd CompanyClaw && npm run lint`（desktop + renderer + weixin 三段 lint）

### 5.3 主流程验证（dev 实机）

- [ ] 启动：`cd desktop && npm run dev`
- [ ] 插件安装：`<stateDir>/extensions/openclaw-weixin/package.json` 存在；`openclaw.json` 出现 `plugins.installs.openclaw-weixin`；日志含 `WeChat plugin installed from the bundled payload`
- [ ] 插件启用：插件页开关 → 日志 `[restart] Enabling the WeChat plugin` → 网关 running → 点「登录微信」出现二维码 canvas（不再进 CLI 终端）
- [ ] 身份绑定（真实扫码路径）：扫码成功后 `TasksView` 显示「已绑定」，`identity-binding.json` 出现
- [ ] 身份绑定（无账号夹具路径，仅验证读取逻辑，标注为夹具证据而非真实扫码）：账号文件写入 `userId` → 重启应用后自动绑定
- [ ] 远程操作：点「开启远程操作」→ 不再报字段错误，状态为 enabled、有效期正确；「关闭远程操作」→ state=disabled/revoked

### 5.4 关联流程验证

- [ ] 禁用插件 → 网关自动重启，`TasksView` 身份绑定仍显示（绑定与插件启用是两件事）
- [ ] 未绑定 + 未登录时点「开启远程操作」→ 中文提示「微信身份未绑定：请先在「微信连接」完成扫码登录…」
- [ ] 已登录但未绑定的历史状态 → 重启应用触发 Step 2 启动补偿，`TasksView` 变为已绑定
- [ ] 切换模型（`selectModel`）与删除模型（`removeCustomModel`）不回归，推理强度随新选中模型刷新
- [ ] Guardian / 首次运行向导：`pluginInstalled/pluginEnabled` 在安装+启用后为真

### 5.5 边界情况验证

- [ ] `desktop/resources/openclaw-weixin` 缺失时 dev 提示「请运行 npm run prepare-production-resources」，不静默超时
- [ ] 网关未连接时点「登录微信」→ 立刻看到 `Gateway not connected` 提示
- [ ] TTL 越界（0 / 30 天）仍被拒绝，提示含 `ttlMinutes`
- [ ] `auth-managed` 模型下思考挡位控件禁用
- [ ] `securityMode=windows-node-mxc` 时插件开关被拒绝（MXC 锁定路径不受本次改动影响）

### 5.6 受限项（如实记录，不标 PASS）

- [ ] 真实微信扫码确认、微信消息收发、审批卡片、远程任务闭环：**BLOCKED（B1 无微信测试账号）**；执行完成后在 `BLOCKERS.md` 或本 Plan 的 Execution Log 中记录未覆盖范围
- [ ] 打包态 NSIS 包体回归：本机无 .NET SDK，记 `BLOCKED`（沿用 B4 结论，本次不涉及打包改动）

---

## 6. Plan Adjustment 触发条件

出现以下任一情况必须停下，追加 Plan Adjustment 并等待确认：

1. `identity.bind` 自动绑定的假设被否决；
2. `openclaw plugins install --force <stagedDir>` 在 dev 态失败（此时需要新增构建/软链方案，超出本 Plan 文件清单）；
3. 网关热重载行为与预期不符，需要新增/修改网关配置或插件加载路径；
4. 出现本表之外的文件必须修改（例如 `preload.ts`、`stores/companyclaw.ts`、`electron-builder.yml`）。

---

## 7. Verification Results（执行记录）

执行时间：2026-10-09；环境：dev（OpenClaw 2026.9.3，`~/.openclaw-node` 运行时，state = `%APPDATA%/MicroClaw/openclaw-state`）。

### 7.1 Test

| 命令 | 结果 |
|---|---|
| `cd desktop && npx vitest run` | **86 files / 1569 passed, 2 skipped（既有跳过）** |
| `cd desktop/renderer && npx vitest run` | **28 files / 326 passed** |
| `cd desktop && npx vitest run src/companyclaw/runtime.test.ts src/companyclaw/plugins/weixin-plugin-install.test.ts src/companyclaw/ipc-contract.test.ts` | 65 passed（含新增回落用例） |

### 7.2 Typecheck / Build / Lint

| 项 | 命令 | 结果 |
|---|---|---|
| Typecheck（主进程） | `cd desktop && npx tsc --noEmit` | exit 0 |
| Typecheck（渲染层） | `cd desktop/renderer && npx vue-tsc --noEmit` | exit 0 |
| Build | `cd desktop && npm run build` | exit 0（tsc + vite build，约 12s；仅既有 chunk 体积告警） |
| Lint | `cd CompanyClaw && npm run lint` | exit 1，**2 errors / 116 warnings 全部为既有**（`desktop/src/chat-attachments.ts:105`、`desktop/src/openclaw-upgrade-recovery.ts:235`）；本次修改的 12 个文件 0 条告警 |
| Prettier（仅本次文件） | `npx prettier --check <12 files>` | 仅 `desktop/src/main.ts` 不合规，且**改动前备份同样不合规**（既有问题），未做全文件格式化以免产生无关 diff |

### 7.3 实机验证（可执行部分）

- **插件安装（应用真实参数）**：以 `OPENCLAW_STATE_DIR=<应用 state>` 执行
  `openclaw plugins install --force --accept-capabilities desktop/resources/openclaw-weixin`
  → `Installed plugin: openclaw-weixin`（exit 0）。
- **落盘证据**：`<state>/extensions/openclaw-weixin/package.json` 存在；`openclaw plugins list` 显示
  `openclaw-weixin | openclaw | enabled | global:openclaw-weixin/dist/index.js | 2.4.6`。
- **CLI 结论**：安装成功输出明确提示 `Restart the gateway to load plugins.`，与 Step 3c「启用后自动重启网关」一致。
- **状态判定**：`readWeixinPluginStatus().installed` 现按 `extensions/` 目录判定（见 Plan Adjustment PA-2），
  对当前 state 结果为 true；`loggedIn` 仍取决于真实登录账号（当前无账号 → false，正确）。

### 7.4 未执行项（UNVERIFIED / BLOCKED，不得标记 PASS）

- **GUI 主流程**：二维码 canvas 渲染、`identity-binding.json` 生成、设置页思考挡位落盘、点击「开启远程操作」——
  需要启动 Electron GUI 并交互；本执行环境未做 UI 自动化，记 **UNVERIFIED**（验证方法见 5.3，命令 `cd desktop && npm run dev`）。
- **真实微信扫码 / 消息收发 / 远程任务闭环**：**BLOCKED（B1 无微信测试账号）**。
- **打包态 NSIS 回归**：**BLOCKED（B4 无 .NET SDK）**，本次未改打包链路。

---

## 8. Plan Adjustment（执行中发现）

### PA-1 安装命令缺少能力授权（细节级，已在原文件范围内修正）

- 原计划：`run(["plugins","install","--force", pluginDir])`。
- 新发现：实测报 `Plugin "openclaw-weixin" requires capability consent. Use openclaw plugins install … with --accept-capabilities`，退出码 1。
- 调整：同一文件 `weixin-plugin-install.ts` 内把参数改为
  `["plugins","install","--force","--accept-capabilities", pluginDir]`，并同步单测断言与注释。
- 为什么需要：不修正则 dev 与打包态首次安装都失败，需求 2 无法达成；插件是本应用自带、受 runtime manifest 校验的 payload，显式确认其能力符合安装器语义。
- 新增修改范围：无新文件，仅同文件参数与测试。

### PA-2 安装记录位置与 `installed` 判定（细节级，已在原文件范围内修正）

- 原计划（S4 判定）：`openclaw.json` 出现 `plugins.installs.openclaw-weixin`。
- 新发现：OpenClaw 2026.9.3 把安装记录写入状态数据库（SQLite `config_machine_state` 的 `plugins.installedIndex`），
  `openclaw.json` 不再出现 `plugins.installs`；原判定恒为 false →
  `readWeixinPluginStatus().loggedIn`（要求 `installed && enabled`）恒为 false →
  向导第 4 步「开启远程操作」永久禁用、应用重启后登录态显示丢失、Guardian `pluginInstalled` 误报。
- 调整：`readWeixinPluginStatus().installed` 改为
  `weixinPluginInstalled(getOpenClawStateDir()) || !!config?.plugins?.installs?.["openclaw-weixin"]`（保留旧布局兜底）。
- 新增修改范围：无新文件，仅 `main.ts` 内 2 行判定 + import。

---

## 9. Execution Log

### Step 0 Completed

- Modified：`backups/2026-10-09-mini-fixes/**`（12 个文件）。
- Changes：改动前备份到仓库根 `backups/`。
- Verification：`find backups/2026-10-09-mini-fixes -type f | wc -l` → 12。

### Step 1 Completed

- Modified：`desktop/src/companyclaw/runtime.ts`、`runtime.test.ts`、`desktop/src/companyclaw/ipc.ts`。
- Changes：核心在 `channelUserId` 缺失时回落到本机绑定；IPC 未绑定场景给中文提示。
- Verification：新增用例先 RED（`ownerSid, deviceId and channelUserId are required…`）后 GREEN；
  `runtime.test.ts` 51 passed；主进程全量 1569 passed。

### Step 2 Completed

- Modified：`desktop/src/main.ts`。
- Changes：`companyClawDeviceId`、`readWeixinAccountUserId()`、`ensureWeixinIdentityBound()`；
  调用点 = 启动（`startApplicationServices`）、`plugin:weixin:login-qr-wait` 成功、CLI 登录 `code===0`。
- Verification：`tsc --noEmit` exit 0；GUI 绑定证据（`identity-binding.json`）记 **UNVERIFIED**（需实机扫码或夹具运行）。

### Step 3 Completed

- Modified：`desktop/src/companyclaw/plugins/weixin-plugin-install.ts`、其测试、`desktop/src/main.ts`、`desktop/renderer/src/i18n/{zh-CN,en-US}.ts`。
- Changes：显式 `pluginSourceDir` + 去掉 dev skip；`--accept-capabilities`（PA-1）；`ensureWeixinPluginAvailable` 按模式解析源目录；
  `set-enabled` 后重启网关；`installed` 判定修正（PA-2）；启用文案改为“网关正在重启…”。
- Verification：单测 9 passed（先 RED 5 失败）；实机安装 exit 0 且 `plugins list` 显示 enabled；`tsc`/build exit 0。

### Step 4 Completed

- Modified：`desktop/src/gateway-client.ts`、`desktop/renderer/src/views/PluginsView.vue`、`ChannelsView.vue`。
- Changes：`web.login.start/wait` 带 `channel`；快路径失败先提示真实原因。
- Verification：`tsc --noEmit`、`vue-tsc --noEmit` exit 0；渲染层 326 passed；
  二维码实际渲染记 **UNVERIFIED**（需 GUI + 网关运行）。

### Step 5 Completed

- Modified：`desktop/renderer/src/views/SettingsView.vue`、`desktop/renderer/src/i18n/{zh-CN,en-US}.ts`。
- Changes：models 区新增「推理强度」下拉（复用 `updateModelProviderConfig` + `persistAndRestart`），`auth-managed` 禁用；新增保存文案。
- Verification：`vue-tsc --noEmit` exit 0；`SettingsView.test.ts` 15 passed；渲染层全量 326 passed；
  `openclaw.json` 落盘效果的实机点击验证记 **UNVERIFIED**（需 GUI 运行）。

### Step 6 Completed

- Modified：本 Plan 文档（Changed Files Tracking / Verification Results / Plan Adjustment / Execution Log）。
- Changes：按实际修改结果回填；记录 2 条 Plan Adjustment 与 4 类未执行项。
- Verification：见第 7 节。
