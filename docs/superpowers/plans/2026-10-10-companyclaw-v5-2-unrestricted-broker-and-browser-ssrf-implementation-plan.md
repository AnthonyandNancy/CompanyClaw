# CompanyClaw V5.2 — 完全权限放开 broker 白名单 & 浏览器 fake-IP 环境放行 Implementation Plan

**日期：** 2026-10-10
**来源：** 产品负责人裁决（2026-10-10）+ 现场反馈两条
**前置轮次：** `2026-10-10-companyclaw-v5-permission-vision-gui-fix-implementation-plan.md`（V5.1）

---

## 1. Goal

### 1.1 本次修改目标

**需求 1 — QQ 被 `process-not-allowed` 拒绝**

现场：*"我qq已经登录，打开qq，找到qq群聊的『我与赌毒不共戴天①』这个群，然后发消息 … 但是回复『又是 已拒绝：process-not-allowed —— QQ 进程被策略禁止操作。』"*

目标：完全权限档位下，broker 的进程白名单与窗口标题白名单不再构成拒绝理由，使用户能用自然语言完成 QQ 群聊操作。

产品负责人裁决：**完全权限放开 broker 进程白名单。**

**需求 2 — 浏览器导航被 SSRF 策略拦截**

现场：*"帮我打开『https://www.sheapi.top』这个网站 …『browser navigation blocked by policy』"*

目标：本机 Clash/Mihomo TUN **fake-IP** 环境下，任何网站的导航都不再被 SSRF 策略拦截。

产品负责人裁决：**使用 `allowRfc2544BenchmarkRange` 全局豁免，保证任何网站都能打开**；并确认**同时加 `dangerouslyAllowPrivateNetwork: true`**（代价：浏览器可访问 `127.0.0.1` 本地服务与企业内网）。

### 1.2 不包含哪些内容

- 不修改 vendored `windows_mcp` 任何文件（MANIFEST 逐文件哈希约束，见 §2.4）
- 不修改 `desktop/src/companyclaw/policy/browser-policy.ts` 与 `runtime.authorizeBrowserAction()`（**无生产调用方的死代码**，本次拦截来自 OpenClaw SSRF，与它无关）
- 不修改 `policy/risk-classifier.ts`（完全权限分支已正确放行，审计日志已证实）
- 不修改 `tools/tool-facade.ts` / `bridge/broker-transport.ts` / `bridge/execution-bridge.ts`（V5.1 已修好参数与票据链路）
- 不修改 `tools.web.fetch.ssrfPolicy`（独立路径，管媒体抓取而非浏览器导航）
- 不修改 `appcontainer/**`、`windows-node-mxc*.ts`
- 不重构 `BrokerPolicy` 的其余校验（身份/时效/目标/票据一律保留）
- 不做需求外的文案统一或 UI 改版

### 1.3 成功标准

**需求 1**
- 完全权限（`FULL_DAILY`）下，`process-not-allowed` 与 `window-title-not-allowed` 不再出现
- 该放行**仅**在完全权限档位下生效；切回「仅查看」或「需审核」后，白名单重新生效
- 身份 / 时效 / 目标必填 / 票据四类校验在完全权限下**仍然生效**（防止把整道闸一起放开）
- 用户已有的 `allowedProcesses` 在切档往返后**完整恢复**，不被空集覆盖
- QQ 群聊端到端：打开 QQ → 找到目标群 → 输入并发送消息，全链路无 `process-not-allowed`

**需求 2**
- 对话「帮我打开 https://www.sheapi.top」可成功打开
- **不止该站点**：`baidu.com` / `github.com` / `example.com` 等同样可打开（本机所有公网域名都解析到 `198.18.0.0/15`，见 §2.4）
- 配置写入后无需人工干预：`first-run` 补齐逻辑在下次启动生效
- 用户已有的 `browser.ssrfPolicy` 不被覆盖

**工程标准**
- 三套测试全绿且基线不下降
- `typecheck` / `build` 通过；`lint` 无新增错误
- 两条需求均经**实盘端到端**验证（前三轮已三次证明单元测试全绿仍漏链路缺陷）

---

## 2. Current Understanding

### 2.1 需求 1 的当前实现与数据流

```
对话 → MCP tools/call focus-window / snapshot-ui-tree / type-text / click
  → runAgentToolCall（main.ts）
  → runtime.handleAgentToolCall
  → tool-facade.ComputerUseToolFacade.handle()
       策略层：完全权限 → decision: "allow"          ✓（审计日志已证实）
  → createBrokerTransport → broker.call()
       targetFor(request) 从【工具参数】取 windowTitle / processName
       ↑ V5.1 Step 8b 新增；此前只传 windowTitle，故 broker 白名单从未被触发
  → broker-client.ts:178
       COMPANYCLAW_BROKER_ALLOWED_PROCESSES: this.options.allowedProcesses.join(",")
  → broker/main.ts:62  splitList(env.COMPANYCLAW_BROKER_ALLOWED_PROCESSES)
  → broker/main.ts:74  toPolicyConfig() → BrokerPolicyConfig.allowedProcesses
  → broker/policy.ts:90-93
       if (request.target?.processName && !this.isProcessAllowed(...))
         return { allowed: false, reason: "process-not-allowed" }      ✗
  → broker/policy.ts:95-101
       if (target.windowTitle && allowedWindowTitles.length > 0 && !匹配)
         return { allowed: false, reason: "window-title-not-allowed" } ✗
```

**`isProcessAllowed`（`broker/policy.ts:119-124`）是纯白名单精确匹配**：

```ts
private isProcessAllowed(processName: string): boolean {
  const normalized = processName.replace(/\.exe$/i, "").toLowerCase();
  return this.config.allowedProcesses.some(
    (allowed) => allowed.replace(/\.exe$/i, "").toLowerCase() === normalized,
  );
}
```

空数组 ⇒ 全部拒绝。

**实测现状**

| 项 | 实测值 |
|---|---|
| `broker-targets.json` | **不存在** |
| `permissions.json` 的 `trustedApps` | **空数组** |
| `permissions.json` 的 `preset` | `FULL_DAILY` |
| QQ 进程 | 7 个（`processName = "QQ"`） |

**根因**：`runtime.setPreset()`（`:371-387`）只写 `permissionPolicy.preset`，与 broker 白名单**零联动**。完全权限在策略层放行，但 broker 的第二道闸仍按空白名单拒绝。

**这是 V5.1 Step 8b 暴露的既有缺陷**——修好参数透传后，QQ 操作首次携带 `processName`，broker 白名单才第一次被触发。

### 2.2 需求 2 的当前实现与数据流

```
对话「打开 https://www.sheapi.top」
  → OpenClaw browser 工具 → assertBrowserNavigationAllowed
      dist/chrome-CGpnReO4.mjs:243
  → :256 await resolvePinnedHostnameWithPolicy(hostname, { policy: opts.ssrfPolicy })
  → dist/ssrf-BqLj-h8H.mjs:184  isBlockedHostnameOrIp → SsrFBlockedError
  → :200  assertAllowedResolvedAddressesOrThrow → SsrFBlockedError
  → dist/errors-6hPg4OWh.mjs:125  映射为
       BROWSER_NAVIGATION_BLOCKED_MESSAGE = "browser navigation blocked by policy"（:11）
```

策略来源（已实测确认配置键为 `browser.ssrfPolicy`）：

```
dist/config-n_aIDo5k.mjs:253   ssrfPolicy: resolveBrowserSsrFPolicy(cfg)
dist/config-n_aIDo5k.mjs:117   const rawPolicy = cfg?.ssrfPolicy
调用方 dist/browser-cli-extension-BK9pc3n2.mjs:864   resolveBrowserConfig(cfg.browser, cfg)
```

**实测当前配置**：`browser` 段只有 `{"enabled": true}`，**没有 `ssrfPolicy`**。

**本机 DNS 实测（决定性）**

```
www.sheapi.top  → 198.18.0.78
www.baidu.com   → 198.18.0.90
www.google.com  → 198.18.0.91
github.com      → 198.18.0.45
www.qq.com      → 198.18.0.92
www.taobao.com  → 198.18.0.93
example.com     → 198.18.0.94      ← 连 example.com 都是
```

**全部落在 `198.18.0.0/15`（RFC 2544）。** 这是 Clash / Mihomo 在 TUN 模式下 **fake-IP** 的典型行为：DNS 返回保留段假地址，真实连接由代理接管。

**修正结论**：不是「`sheapi.top` 这个站点特殊」，而是**本机任何网站**都会这样。现场观察到的「浏览器上网被禁止」是**全量失效**。

### 2.3 涉及模块

| 层 | 模块 | 职责 |
|---|---|---|
| Broker 策略 | `broker/policy.ts` | `authorize()` 六类校验；`isProcessAllowed` 白名单 |
| Broker 启动 | `broker/main.ts` | `parseBootstrap()` 读 env、`toPolicyConfig()` 组装 |
| Broker 客户端 | `desktop/src/companyclaw/broker-client.ts` | spawn env 传递、`updateTargets()` 重启 |
| Broker 目标存储 | `desktop/src/companyclaw/broker-targets.ts` | `broker-targets.json` 读写与归一化 |
| 运行时 | `desktop/src/companyclaw/runtime.ts` | `setPreset()` / `setBrokerTargets()` / `getBrokerTargets()` |
| IPC | `desktop/src/companyclaw/ipc.ts` | `broker:get-targets` / `broker:set-targets` |
| 首次运行配置 | `desktop/src/companyclaw/first-run-init.ts` | `planFirstRunConfig()` / `planBrowserConfig()` |
| 配置写入 | `desktop/src/main.ts` | `ensureCompanyClawFirstRunConfiguration()`（`:1595`）、`assertConfigWriteAllowed` 调用点（`:1618`） |
| 配置写入策略 | `desktop/src/config-write-policy.ts` | `ALLOWED_TOP_LEVEL_KEYS`（含 `browser`） |
| UI | `desktop/renderer/src/components/PermissionSettings.vue` | 完全权限档位说明文案 |

### 2.4 已确认的影响范围

**Broker 白名单链路的关键事实**

| 事实 | 位置 |
|---|---|
| `allowedProcesses`/`allowedWindowTitles` 通过 **env** 传递，因此变更必须**重启 broker 进程** | `broker-client.ts:176-180`、`updateTargets()` 注释 `:234-237` |
| `updateTargets()` 会 `await this.stop()`，而 `stop()` **恢复重启预算**（注释明写"editing the list a few times must not lock the user out"） | `broker-client.ts:238-249` |
| `normalizeProcessEntry()` 拒绝路径/通配/空白，`*` 与空串被排除 | `broker-targets.ts:45-57` |
| 读取旧文件时若契约/数组形状不符，返回 `EMPTY` + warning | `broker-targets.ts:88-96` |
| `save()` 会去重并重新归一化，丢弃无法表达的条目 | `broker-targets.ts:117-133` |

**浏览器 SSRF 的判定顺序（决定性，已实测）**

```js
// dist/ssrf-BqLj-h8H.mjs:186  resolveHostnamePolicyChecks
const skipPrivateNetworkChecks = shouldSkipPrivateNetworkChecks(normalized, policy);
if (!skipPrivateNetworkChecks) assertAllowedHostOrIpOrThrow(normalized, policy);
//                              ^ skip 在断言之前计算，因此 skip=true 时确实跳过

:115 shouldSkipPrivateNetworkChecks(hostname, policy)
  → isPrivateNetworkAllowedByPolicy(policy) || allowedHostnames.includes(hostname)
:111 isPrivateNetworkAllowedByPolicy(policy)
  → policy.dangerouslyAllowPrivateNetwork === true || policy.allowPrivateNetwork === true

// :286 解析后
if (!skipPrivateNetworkChecks) assertAllowedResolvedAddressesOrThrow(results, params.policy);
else if (!isPrivateNetworkAllowedByPolicy(params.policy))
  assertAllowedTrustedHostnameResolvedAddressesOrThrow(results, normalized);
// ⇒ dangerouslyAllowPrivateNetwork:true 使两个分支都不执行
```

**陷阱已排除**（`dist/chrome-CGpnReO4.mjs:250`）：

```js
if (opts.ssrfPolicy && opts.ssrfPolicy.dangerouslyAllowPrivateNetwork === false && ...)
  throw new InvalidBrowserNavigationUrlError("Navigation blocked: strict browser SSRF policy requires an IP-literal URL ...")
```

实测三种写入经 `resolveBrowserSsrFPolicy()` 的解析结果：

| 写入 | 解析结果 | 触发 IP 字面量要求 |
|---|---|---|
| 仅 `allowRfc2544BenchmarkRange` | `{"allowRfc2544BenchmarkRange":true}` | 否 |
| 仅 `dangerouslyAllowPrivateNetwork:true` | `{"dangerouslyAllowPrivateNetwork":true}` | 否 |
| **两个都写（本方案）** | `{"dangerouslyAllowPrivateNetwork":true,"allowRfc2544BenchmarkRange":true}` | 否 |

`resolveBrowserSsrFPolicy`（`config-n_aIDo5k.mjs:122-130`）有改写逻辑：显式设置任一 private 字段时会 `delete resolved.allowPrivateNetwork`，并把 `dangerouslyAllowPrivateNetwork` 设为两者或值。**方案 C 安全。**

**配置键由官方 schema 确认**

```
dist/schema-C9vBoeg0.mjs:744  "browser.ssrfPolicy"
                       :745  "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork"
                       :748  "browser.ssrfPolicy.allowRfc2544BenchmarkRange"
                             — "Allow RFC 2544 benchmark-range IPs (198.18.0.0/15)
                                for trusted fake-IP proxy environments."
```

`:748` 的描述原文即 **"for trusted fake-IP proxy environments"**，说明该字段是 OpenClaw 官方为代理 fake-IP 场景提供的正规配置项。

**写入可行性**：`ALLOWED_TOP_LEVEL_KEYS` 含 `browser`（`config-write-policy.ts:12`），且 `assertConfigWriteAllowed` 只校验**顶层键**，不校验嵌套——写入 `browser.ssrfPolicy` 合法。

**结构性限制（本次放行也无法覆盖）**

1. Windows UAC 安全桌面不可交互（OS 事实）
2. AppContainer 沙箱边界
3. broker 票据完整性校验：`broker/policy.ts:105-113` 的 mutating 票据要求**保留**
4. `enterpriseRestrictions.stricterRules`（当前为空）
5. 非 http/https 协议导航（`assertBrowserNavigationAllowed` 的 `NETWORK_NAVIGATION_PROTOCOLS` 判定）
6. 带凭据的 URL（`InvalidBrowserNavigationUrlError` 的 username/password 拒绝）

**产品负责人裁决对需求书的覆盖（明确记录，不自行改需求）**

`docs/CompanyClaw__修改实施书5.0.md`：

| 位置 | 原文要点 | 本次裁决 |
|---|---|---|
| `:225` | "不得用『无条件完全控制整台电脑』的承诺误导" | 覆盖范围进一步扩大 |
| `:512` | 列有"不得被永久预批准"的动作清单 | 覆盖 |
| `:741` | "普通『全面日常操作』使 R3、UAC 绕过或敏感写入永久自动允许"列为禁止项 | 覆盖 |

按硬闸要求，本 Plan **不修改需求文档**，仅在 Step 6 记入 `docs/companyclaw/v5/` 的 ADR。

---

## 3. Implementation Steps

### Step 1

#### Target

- 文件：`broker/policy.ts`
- 模块：`BrokerPolicyConfig`、`BrokerPolicy.authorize()`
- 测试：`broker/policy.test.ts`

#### Current Behavior

```ts
// :12-23
export interface BrokerPolicyConfig {
  ownerSid: string;
  deviceId: string;
  allowedProcesses: readonly string[];
  allowedWindowTitles: readonly string[];
  requireApprovalForMutations: boolean;
}

// :87-101
if (TARGET_REQUIRED.has(request.operation) && !request.target?.processName) {
  return { allowed: false, reason: "target-required" };
}
if (request.target?.processName) {
  if (!this.isProcessAllowed(request.target.processName)) {
    return { allowed: false, reason: "process-not-allowed" };
  }
}
if (request.target?.windowTitle && this.config.allowedWindowTitles.length > 0) {
  const title = request.target.windowTitle.toLowerCase();
  const ok = this.config.allowedWindowTitles.some((allowed) =>
    title.includes(allowed.toLowerCase()),
  );
  if (!ok) return { allowed: false, reason: "window-title-not-allowed" };
}
```

空 `allowedProcesses` ⇒ 每个带进程名的请求都被拒。

#### Change

1. `BrokerPolicyConfig` 增加：

   ```ts
   /**
    * True while the employee has selected the widest preset.
    *
    * It lifts the two *configuration* gates — which application and which window
    * titles the broker may touch — because those express the employee's own
    * allow list and the preset already says "no confirmation". It does not touch
    * identity, freshness, target-required or the mutation ticket: those are not
    * preferences, and dropping them would remove the broker's own integrity
    * checks rather than a confirmation.
    */
   unrestricted?: boolean;
   ```

2. `authorize()` 中两处判定改为受 `unrestricted` 保护：

   ```ts
   if (request.target?.processName && !this.config.unrestricted) {
     if (!this.isProcessAllowed(request.target.processName)) {
       return { allowed: false, reason: "process-not-allowed" };
     }
   }
   if (
     !this.config.unrestricted &&
     request.target?.windowTitle &&
     this.config.allowedWindowTitles.length > 0
   ) { /* 原判定不变 */ }
   ```

3. `isProcessAllowed` **不改**：它在 `unrestricted` 为真时不被调用，保留其精确匹配语义供窄档位使用。

#### Reason

需求 1 的核心闸门。裁决要求完全权限放开进程白名单；`unrestricted` 是显式语义字段，避免用"空数组"同时表达「全拒」与「不限」两种相反含义（`broker-targets.ts:5-7` 的注释明确说明空数组的 fail-safe 语义就是要全拒）。

#### Risk

- 该字段是本次影响面最大的安全让步：完全权限下可驱动任意进程（含任务管理器、注册表编辑器、安全软件界面）
- 必须确保**只在**完全权限下为真，否则窄档位的白名单保护失效
- `TARGET_REQUIRED` 的 `target-required` 判定**不受影响**，`set-value` 等 v1 元素操作仍需要 `processName`——`unrestricted` 不能让缺少目标的请求通过

#### Verification

```bash
npm test --prefix broker -- policy
```

新增测试：
- `unrestricted: true` + `processName: "QQ"` + 空白名单 ⇒ `allowed: true`
- `unrestricted: true` + 非空 `allowedWindowTitles` + 不匹配标题 ⇒ `allowed: true`
- `unrestricted: true` + 错 `ownerSid` ⇒ 仍 `deny: "owner-mismatch"`
- `unrestricted: true` + 过期请求 ⇒ 仍 `deny: "expired"`
- `unrestricted: true` + mutating 无票据 ⇒ 仍 `deny: "approval-required"`
- `unrestricted: true` + `TARGET_REQUIRED` 操作无 `processName` ⇒ 仍 `deny: "target-required"`
- `unrestricted: false` ⇒ 现有全部行为不变

---

### Step 2

#### Target

- 文件：`broker/main.ts`
- 模块：`parseBootstrap()`、`toPolicyConfig()`
- 测试：`broker/main.test.ts`

#### Current Behavior

```ts
// :44-69
export function parseBootstrap(env: NodeJS.ProcessEnv): BootstrapParseResult {
  ...
  return {
    ok: true,
    value: {
      token, ownerSid, deviceId,
      allowedProcesses: splitList(env.COMPANYCLAW_BROKER_ALLOWED_PROCESSES),
      allowedWindowTitles: splitList(env.COMPANYCLAW_BROKER_ALLOWED_WINDOW_TITLES),
      scriptDir,
      ticketSecret: ticketSecret ?? "",
    },
  };
}

// :71-79
export function toPolicyConfig(bootstrap: BrokerBootstrap): BrokerPolicyConfig {
  return {
    ownerSid: bootstrap.ownerSid,
    deviceId: bootstrap.deviceId,
    allowedProcesses: bootstrap.allowedProcesses,
    allowedWindowTitles: bootstrap.allowedWindowTitles,
    requireApprovalForMutations: true,
  };
}
```

#### Change

1. `BrokerBootstrap` 类型增加 `unrestricted: boolean`。
2. `parseBootstrap` 读取：`unrestricted: env.COMPANYCLAW_BROKER_UNRESTRICTED === "true"`（严格字符串比较，缺省即 `false`）。
3. `toPolicyConfig` 透传该字段。

#### Reason

`unrestricted` 必须从桌面端传到 broker 进程。既有 env 传递模式已定型（`broker-client.ts:176-180`），照此扩展最小。

#### Risk

- `parseBootstrap` 对缺失字段返回 `ok: false`，而 `unrestricted` 是**可选**的：缺失必须解析为 `false` 而非失败，否则旧桌面端配新 broker 会整体不可用
- `broker/main.test.ts` 的 `BASE_ENV` 与既有断言需保持通过

#### Verification

```bash
npm test --prefix broker -- main
```

新增测试：
- `COMPANYCLAW_BROKER_UNRESTRICTED: "true"` ⇒ `unrestricted === true`
- 缺失该 env ⇒ `unrestricted === false` 且 `ok: true`
- `"false"` / `"1"` / `"TRUE"` ⇒ `unrestricted === false`（只有精确 `"true"` 生效）
- `toPolicyConfig` 透传该字段

---

### Step 3

#### Target

- 文件：`desktop/src/companyclaw/broker-client.ts`
- 模块：`BrokerClientOptions`、`spawnProcess()` 的 env、`updateTargets()`
- 测试：`desktop/src/companyclaw/broker-client-spawn.test.ts`

#### Current Behavior

```ts
// :176-180（spawn env）
COMPANYCLAW_BROKER_ALLOWED_PROCESSES: this.options.allowedProcesses.join(","),
COMPANYCLAW_BROKER_ALLOWED_WINDOW_TITLES: this.options.allowedWindowTitles.join(","),

// :238-249
async updateTargets(targets: {
  allowedProcesses: string[];
  allowedWindowTitles: string[];
}): Promise<void> {
  const wasRunning = this.isRunning();
  this.options.allowedProcesses = [...targets.allowedProcesses];
  this.options.allowedWindowTitles = [...targets.allowedWindowTitles];
  if (!wasRunning) return;
  await this.stop();
}
```

#### Change

1. `BrokerClientOptions` 增加 `unrestricted?: boolean`（默认 `false`）；对应私有字段初始化为 `false`。
2. spawn env 增加 `COMPANYCLAW_BROKER_UNRESTRICTED: String(this.options.unrestricted === true)`。
3. `updateTargets()` 的入参类型与实现增加 `unrestricted: boolean`，写入 `this.options.unrestricted`。

#### Reason

`updateTargets` 是档位联动的执行末梢：它改的是**下一次 spawn** 的 env，因此档位切换必须经它。

#### Risk

- `updateTargets` 会 `await this.stop()`，即档位切换会**重启 broker 进程**。切换期间在途调用会以 `unavailable` 结束，这是既有语义（注释明确说明）
- `stop()` 恢复重启预算，因此频繁切档不会锁定用户——但每次切换仍有真实的重启开销
- 若 `wasRunning === false`，只记录不重启（既有行为，保留）

#### Verification

```bash
npm test --prefix desktop -- broker-client
```

新增/更新测试：
- spawn env 含 `COMPANYCLAW_BROKER_UNRESTRICTED: "true"` / `"false"`
- `updateTargets({..., unrestricted: true })` 后重启，新进程 env 为 `"true"`
- 未运行时 `updateTargets` 不触发 spawn

---

### Step 4

#### Target

- 文件：`desktop/src/companyclaw/broker-targets.ts`
- 模块：`BrokerTargets`、`TargetsEnvelope`、`BrokerTargetsStore.inspect()`、`.save()`
- 测试：`desktop/src/companyclaw/broker-targets.test.ts`

#### Current Behavior

```ts
// :16-19
export interface BrokerTargets {
  allowedProcesses: string[];
  allowedWindowTitles: string[];
}

// :26-31
interface TargetsEnvelope {
  contract: typeof COMPANYCLAW_BROKER_TARGETS_CONTRACT;
  schemaVersion: typeof COMPANYCLAW_BROKER_TARGETS_SCHEMA;
  allowedProcesses: string[];
  allowedWindowTitles: string[];
}

// :39
const EMPTY: BrokerTargets = { allowedProcesses: [], allowedWindowTitles: [] };
```

`inspect()` 对不符合契约的文件返回 `EMPTY`；`save()` 归一化去重后写入。

#### Change

1. `BrokerTargets` 与 `TargetsEnvelope` 增加 `unrestricted: boolean`。
2. `EMPTY` 增加 `unrestricted: false`。
3. `inspect()` 读取时：`unrestricted: envelope.unrestricted === true`（缺失或非布尔 ⇒ `false`，保证旧文件向后兼容）。
4. `save()` 归一化时透传 `unrestricted: targets.unrestricted === true`。
5. `enqueueWrite()` 写入 envelope 时带上该字段。
6. **不改** `normalizeProcessEntry`（`*`/空串/路径仍被拒）——`unrestricted` 是独立的显式语义，不复用通配。

#### Reason

`unrestricted` 需要跨进程持久化（档位在 UI 上切换后，下次启动 broker 时仍应带上正确的值）。放进既有 `broker-targets.json` 是最小改法；该文件的契约字段也随之从 v1 语义扩展到含 `unrestricted`，但**契约字符串与 schemaVersion 保持不变**，因为新增字段是可选且向后兼容的。

#### Risk

- `unrestricted` 落盘后会成为**可被手动编辑**的字段。若手动置 `true` 而档位是 BASIC，会出现「档位说需审核、broker 说全放行」的不一致。**缓解**：Step 5 中由档位作为权威来源，在每次档位变更时重写该字段；启动时也以档位为准做一次同步（见 Step 5 第 4 点）
- 旧文件的 `inspect()` 路径有四处返回 `EMPTY`，都需带上 `unrestricted: false`
- `save()` 的返回值被 `runtime.setBrokerTargets()` 直接推给 broker-client，字段必须完整

#### Verification

```bash
npm test --prefix desktop -- broker-targets
```

新增测试：
- 写入含 `unrestricted: true` 后读回为 `true`
- 旧格式文件（无该字段）读回 `unrestricted: false` 且无 warning
- 契约不符的文件 ⇒ `EMPTY`，`unrestricted: false`
- `save()` 归一化后字段保留

---

### Step 5

#### Target

- 文件：`desktop/src/companyclaw/runtime.ts`
- 模块：`setPreset()`、`setBrokerTargets()`、新增私有同步点
- 测试：`desktop/src/companyclaw/runtime-permissions.test.ts`（或就近新增）

#### Current Behavior

```ts
// :371-387
async setPreset(input: { preset: PermissionPreset; acknowledged?: boolean }): Promise<PermissionPolicy> {
  if (input.preset === "FULL_DAILY" && input.acknowledged !== true) {
    throw new Error("启用「完全权限」前需要确认授权范围");
  }
  if (this.permissionPolicy.preset === input.preset) return this.getPermissionPolicy();
  this.permissionPolicy = {
    ...this.permissionPolicy,
    preset: input.preset,
    presetChangedAt: this.now().toISOString(),
    policyVersion: this.permissionPolicy.policyVersion + 1,
  };
  await this.permissions.save(this.permissionPolicy);
  return this.getPermissionPolicy();
}
```

`setPreset` 完全不触碰 broker targets。

#### Change

1. `setPreset()` 在落盘 `permissionPolicy` **之后**，追加一次 broker targets 同步：

   ```ts
   // The broker's own allow list is delivered through its environment, so the
   // preset has to be pushed to it explicitly: without this the policy layer
   // says "no confirmation" while the broker still refuses every process it was
   // never told about. Only the flag changes here — the employee's own list is
   // preserved so that leaving the widest preset restores exactly what they had.
   const current = this.brokerTargets.get();
   const next = { ...current, unrestricted: presetAllowsEveryAction(input.preset) };
   if (next.unrestricted !== current.unrestricted) {
     await this.setBrokerTargets(next);
   }
   ```

2. 启动时的权威同步：在构造/初始化路径中（`runtime.ts` 现有 `brokerTargets` 初始化之后），若落盘的 `unrestricted` 与当前档位不一致，以**档位为准**重写一次，避免手动编辑造成的不一致。

3. `setBrokerTargets()` **不改签名**（仍接收完整 `BrokerTargets`，现已含新字段）。

4. 复用 `presetAllowsEveryAction()`（`policy/permission-preset.ts`，V5.1 已引入）——档位语义只有一个来源。

#### Reason

需求 1 的联动点。裁决是「完全权限放开白名单」，因此权威来源必须是档位，而不是一个可能与档位脱节的独立开关。

#### Risk

- **首次启用完全权限会重启 broker**（`updateTargets` 语义），期间工具调用短暂不可用
- 必须在 `permissions.save()` **之后**同步，否则落盘失败时会留下"档位没变但 broker 已放开"的不一致
- `presetAllowsEveryAction` 已存在（V5.1 Step 5 引入），此处**复用而不重复实现**
- 若用户在完全权限下手动调用 `broker:set-targets`，不应把 `unrestricted` 关掉——IPC 层需要保留该字段（Step 6 处理）

#### Verification

```bash
npm test --prefix desktop -- runtime-permissions broker-targets
```

新增测试：
- `setPreset({preset:"FULL_DAILY", acknowledged:true})` ⇒ broker targets 的 `unrestricted === true`
- 随后 `setPreset({preset:"BASIC"})` ⇒ `unrestricted === false`，且**原有 `allowedProcesses` 完整保留**
- 预先放入 `allowedProcesses: ["notepad"]`，切到 FULL_DAILY 再切回 ⇒ 仍为 `["notepad"]`
- 落盘失败（mock write 抛错）时，broker targets 不被改动

---

### Step 6

#### Target

- 文件：`desktop/src/companyclaw/ipc.ts`
- 模块：`companyclaw:broker:get-targets`、`companyclaw:broker:set-targets`、`broker.updateTargets` 的应用点（`:181-185`）
- 测试：`desktop/src/companyclaw/ipc-contract.test.ts` 视需要

#### Current Behavior

```ts
// :324
ipcMain.handle("companyclaw:broker:get-targets", () => runtime.getBrokerTargets());

// :331-339
ipcMain.handle(
  "companyclaw:broker:set-targets",
  (_event, input: { allowedProcesses?: string[]; allowedWindowTitles?: string[] }) =>
    runtime.setBrokerTargets({
      allowedProcesses: Array.isArray(input?.allowedProcesses) ? input.allowedProcesses : [],
      allowedWindowTitles: Array.isArray(input?.allowedWindowTitles)
        ? input.allowedWindowTitles
        : [],
    }),
);
```

#### Change

1. `set-targets` 的入参类型增加 `unrestricted?: boolean`；构造 `BrokerTargets` 时**保留当前值**而非默认关闭：

   ```ts
   (_event, input: {...; unrestricted?: boolean }) => {
     const current = runtime.getBrokerTargets();
     return runtime.setBrokerTargets({
       allowedProcesses: ...,
       allowedWindowTitles: ...,
       // The flag follows the preset; a manual allow-list edit must not silently
       // turn the widest preset's behaviour off.
       unrestricted: typeof input?.unrestricted === "boolean"
         ? input.unrestricted
         : current.unrestricted,
     });
   }
   ```

2. `:181-185` 的应用点（`setBrokerTargetsApplier`）：`broker.updateTargets(targets)` 现在需要传递 `unrestricted`。

#### Reason

`unrestricted` 是 `BrokerTargets` 的组成部分，两个 IPC 通道与 broker 应用点都必须携带它，否则要么类型不通、要么手动编辑会意外关掉完全权限的行为。

#### Risk

- `get-targets` 的返回值结构变化（多一个字段）会暴露给渲染层；设置页若做全等比较需同步（`PermissionSettings.vue` 未消费该通道，风险低）
- 应用点漏传会导致 broker 重启后 `unrestricted` 归 `false`，表现为"切了档位但没生效"

#### Verification

```bash
npm test --prefix desktop -- ipc-contract
```

- `set-targets` 保留当前 `unrestricted`
- `set-targets` 显式传入布尔值时采用该值
- broker 应用点传递完整 `BrokerTargets`

---

### Step 7

#### Target

- 文件：`desktop/src/companyclaw/first-run-init.ts`
- 模块：`planBrowserConfig()`
- 测试：`desktop/src/companyclaw/first-run-init.test.ts`

#### Current Behavior

```ts
// :71-93
export function planBrowserConfig(
  config: Record<string, unknown>,
  edgePath: string | null,
): BrowserConfigResult {
  const next: Record<string, unknown> = { ...config };
  const changed: string[] = [];
  const browser = isPlainObject(next.browser) ? { ...next.browser } : {};

  if (typeof browser.enabled !== "boolean") {
    browser.enabled = true;
    changed.push("browser.enabled");
  }
  if (edgePath && (typeof browser.executablePath !== "string" || ...)) {
    browser.executablePath = edgePath;
    changed.push("browser.executablePath");
  }
  next.browser = browser;
  return { config: next, changed };
}
```

只补齐 `enabled` 与 `executablePath`，不涉及 `ssrfPolicy`。

#### Change

在 `planBrowserConfig()` 内追加一段，沿用「仅缺失时补齐、不覆盖用户值」模式：

```ts
// Browser tooling resolves its SSRF policy from `browser.ssrfPolicy`. Behind a
// Clash/Mihomo TUN proxy every public name resolves into the RFC 2544 benchmark
// range (198.18.0.0/15), which the guard rejects by default, so *no* site can be
// opened — not one particular site. `allowRfc2544BenchmarkRange` is the upstream
// setting for exactly that environment; `dangerouslyAllowPrivateNetwork` covers
// the remaining special-use ranges and is what the employee asked for when
// choosing the widest preset.
const existingPolicy = isPlainObject(browser.ssrfPolicy) ? { ...browser.ssrfPolicy } : {};
const policy = { ...existingPolicy };
if (typeof policy.dangerouslyAllowPrivateNetwork !== "boolean") {
  policy.dangerouslyAllowPrivateNetwork = true;
  changed.push("browser.ssrfPolicy.dangerouslyAllowPrivateNetwork");
}
if (typeof policy.allowRfc2544BenchmarkRange !== "boolean") {
  policy.allowRfc2544BenchmarkRange = true;
  changed.push("browser.ssrfPolicy.allowRfc2544BenchmarkRange");
}
browser.ssrfPolicy = policy;
```

#### Reason

需求 2。实测本机**所有**公网域名解析到 `198.18.0.0/15`，被 OpenClaw SSRF 拦为 RFC 2544 保留段。`schema-C9vBoeg0.mjs:748` 明确该字段是"for trusted fake-IP proxy environments"的正规配置项。

两个字段都必须写：
- `allowRfc2544BenchmarkRange` 覆盖 `198.18.0.0/15`（它**不在** `BLOCKED_IPV4_SPECIAL_USE_RANGES` 集合内，是独立判定）
- `dangerouslyAllowPrivateNetwork` 覆盖其余 8 类保留段，并让解析链路整体跳过

#### Risk

- **这是安全边界的实质让步**：浏览器此后可访问 `127.0.0.1`（含 CompanyClaw 自己的 MCP 端点与 Gateway）、企业内网 `10.x`/`192.168.x`、路由器管理页。若页面内容或模型被诱导可形成 SSRF。产品负责人已明确裁决接受，需在 Step 8 记入 ADR 与 BLOCKERS
- 必须保持"不覆盖用户已有值"：若用户显式设了 `dangerouslyAllowPrivateNetwork: false`，**不得**改写为 `true`
- 写入 `browser.ssrfPolicy` 不会被 `assertConfigWriteAllowed` 拒绝（`ALLOWED_TOP_LEVEL_KEYS` 含 `browser` 且只校验顶层键）
- 生效时机：`planBrowserConfig` 只在 `changed` 非空时写入，下次启动加载

#### Verification

```bash
npm test --prefix desktop -- first-run-init
```

新增测试：
- 空配置 ⇒ 写入 `ssrfPolicy` 两个字段，`changed` 含对应两项
- 已有 `ssrfPolicy: { dangerouslyAllowPrivateNetwork: false }` ⇒ **保持 `false`**，仅补 `allowRfc2544BenchmarkRange`
- 已有完整 `ssrfPolicy` ⇒ `changed` 不含该路径，配置对象不变
- `enabled` / `executablePath` 的既有行为不变

---

### Step 8

#### Target

- 文件：`docs/companyclaw/v5/02-permission-preset-adr.md`、`docs/companyclaw/v5/BLOCKERS.md`、`docs/companyclaw/v5/IMPLEMENTATION_STATUS.md`
- 可选：`desktop/renderer/src/components/PermissionSettings.vue`（完全权限说明文案复核）

#### Current Behavior

`02-permission-preset-adr.md` §7 已记录 V5.1 的裁决（三档语义、裁决 ③、a-2），但未覆盖本次两处扩展。`BLOCKERS.md` 有 V5-B6/B7/B8 三条遗留项。

#### Change

1. `02-permission-preset-adr.md` §7 追加子节：
   - 完全权限覆盖 broker 进程白名单与窗口标题白名单（`unrestricted`）
   - 保留的四类校验（身份/时效/目标/票据）——说明为什么它们不是"确认"
   - 需求书 `:225`/`:512`/`:741` 的覆盖范围进一步扩大
2. `BLOCKERS.md` 新增：
   - V5-B9：完全权限下 broker 无进程级兜底
   - V5-B10：`browser.ssrfPolicy` 让步——浏览器可访问本机与内网，含 SSRF 风险说明
3. `IMPLEMENTATION_STATUS.md` 追加 V5.2 修复轮表格
4. `PermissionSettings.vue` 的完全权限卡片说明复用现有「与 Windows 管理员权限无关」表述即可；**仅在文案与新行为直接矛盾时**才调整

#### Reason

需求书与裁决的冲突必须有显式记录，否则后续审查会把"完全权限放行任意进程 / 浏览器访问内网"判定为回归。

#### Risk

- 纯文档，无代码风险
- 按硬闸要求不修改 `docs/CompanyClaw__修改实施书5.0.md`

#### Verification

人工复核文档内容与代码实际行为一致。

---

## 4. Changed Files Tracking

| File | Action | Reason |
| ---- | ------ | ------ |
| | | |

（执行阶段按实际修改回填）

---

## 5. Verification Checklist

### 5.1 主流程验证

- [ ] **需求 1**：QQ 已登录 → 对话「打开 QQ，找到群聊"我与赌毒不共戴天①"，发送"大家晚上好，我是 ikun bot"」→ 全链路无 `process-not-allowed`，消息实际送达
- [ ] **需求 1**：完全权限下 `launch-app` 可打开白名单外应用
- [ ] **需求 1 档位回归**：切回「需审核」/「仅查看」后，白名单重新生效（同一 QQ 操作应被拒或需确认）
- [ ] **需求 2**：对话「帮我打开 https://www.sheapi.top」→ 页面打开，无 `navigation blocked by policy`
- [ ] **需求 2 非单点**：另测 `baidu.com`、`github.com`、`example.com` 均可打开（本机全部域名都在 fake-IP 段）
- [ ] **需求 2 持久性**：重启客户端后配置仍在，无需人工编辑

### 5.2 关联流程验证

- [ ] 完全权限下四类校验仍生效：构造过期票据、错 `ownerSid` 的 broker 请求，验证仍被拒
- [ ] 完全权限下 mutating 操作仍带有效票据（票据链路未被本次改动影响）
- [ ] 档位切换触发 broker 重启期间，工具调用返回可读错误，恢复后立即可用
- [ ] 档位往返后用户 `allowedProcesses` 完整恢复（放入 `["notepad"]` → FULL_DAILY → BASIC → 仍为 `["notepad"]`）
- [ ] 手动编辑 `broker-targets.json` 的 `unrestricted` 后，档位同步会以档位为准纠正
- [ ] `guardian` 健康探针在 broker 重启期间能表达该状态
- [ ] `tools.web.fetch.ssrfPolicy` 未被误改（仍是独立路径）

### 5.3 边界情况验证

- [ ] QQ 多开（本机实测 7 个进程）时的窗口与控件定位
- [ ] 群名含 `①` 与全角引号
- [ ] 旧格式 `broker-targets.json`（无 `unrestricted`）向后兼容读取
- [ ] `COMPANYCLAW_BROKER_UNRESTRICTED` 缺失/`"false"`/`"TRUE"` ⇒ 均为 `false`
- [ ] 浏览器：`http` vs `https`、带端口 URL、IP 字面量 URL（确认未落入"要求 IP 字面量"拒绝分支）
- [ ] 浏览器：非 http/https 协议（如 `file://`）仍被拒（结构性限制，应保留）
- [ ] 已有用户 `browser.ssrfPolicy` 不被覆盖
- [ ] 缓存/会话刷新：配置改动后 Gateway 与 broker 均重新加载（`ensureCompanyClawFirstRunConfiguration` 在启动序列中、broker 由 `updateTargets` 重启）

### 5.4 Test

```bash
npm test --prefix desktop          # 基线 104 files / 1807 passed / 2 skipped
npm test --prefix broker           # 基线 15 files / 161 passed
npm test --prefix desktop/renderer # 基线 29 files / 342 passed
```

- [ ] 三套全绿，基线不下降
- [ ] 新增 `broker/policy.test.ts`：`unrestricted` 六条（放行两条 + 四类校验仍拒）
- [ ] 新增 `broker/main.test.ts`：env 解析四条
- [ ] 新增 `broker-client-spawn.test.ts`：env 传递
- [ ] 新增 `broker-targets.test.ts`：持久化与向后兼容
- [ ] 新增 `runtime-permissions.test.ts`：档位联动与授权集恢复
- [ ] 新增 `first-run-init.test.ts`：`ssrfPolicy` 形状与"不覆盖用户值"

### 5.5 Build

```bash
npm run build --prefix broker      # dev/build 已前置该步骤
cd desktop && ./node_modules/.bin/tsc --noEmit
```

- [ ] broker 编译通过（`broker/dist` 含 `adapters/` 与 `companyclaw.broker.v2`）
- [ ] desktop typecheck 通过

### 5.6 Lint

```bash
npm run lint --prefix desktop
npm run lint --prefix desktop/renderer
```

- [ ] 无新增错误
- [ ] 既存（不计入）：desktop 5 errors（`chat-attachments.ts:105`、`mcp-endpoint.ts:5-6`、`main.ts:69`、`openclaw-upgrade-recovery.ts:235`）；renderer 1 error（`PermissionSettings.vue:18`）

### 5.7 实盘端到端（必须执行）

前 V5.1 轮已三次证明单元测试全绿仍会漏掉链路缺陷（参数被丢弃、结果被截断、锁泄漏），因此：

- [ ] 重启 dev 客户端，确认 broker 编译 → MCP 注册 → Gateway ready 顺序正确
- [ ] 从对话发起需求 1 与需求 2 的完整指令，观察真实结果
- [ ] 检查 `dev-electron.log` 无新增 error
- [ ] 检查审计日志记录 `decision: "allow"` 且 `reason` 合理

---

## 6. Open Items（执行中需就地确认）

1. **Step 5 的启动同步位置**：`runtime.ts` 构造函数中 `brokerTargets` 的初始化点之后是否已有适合插入同步的时机；若需改构造函数签名则属范围扩大，走 Plan Adjustment。
2. **Step 8 的文案**：`PermissionSettings.vue` 完全权限卡片的 `confirmations` 文案当前写"付款、提权与系统级操作仍由 Windows 自身的限制拦在应用之外"。放开 broker 白名单后该表述**仍然成立**（Windows 限制确实仍在），预计无需改动；若实测发现矛盾再调整并记入 Plan Adjustment。
3. **broker 重启对在途调用的影响**：档位切换会 `stop()` broker，若此时有正在执行的 mutation，其表现需在实盘验证中确认（预期为 `unavailable` 且可读）。
