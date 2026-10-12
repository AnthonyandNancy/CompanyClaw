# Implementation Plan

**Date:** 2026-10-10
**Feature:** CompanyClaw v5 — 三档权限语义澄清、云端视觉开关修复、GUI 工具可达性修复
**Revision:** rev.2 — 基于 2026-10-10 实盘核实结论修订（撤回原 Step 4，新增缺参可读拒绝步骤）
**Source:** `docs/companyclaw/v5/` ADR 系列 + 产品负责人裁决（2026-10-10）

---

## 1. Goal

### 1.1 本次修改目标

**需求 1 — 电脑操作权限档位语义**

| 档位 id（不变） | 显示名（新） | 语义 |
|---|---|---|
| `BASIC` | 仅查看 | 已授权范围内查询、查看、受控浏览器阅读与只读任务；新应用操作、文件修改、业务写入需确认 |
| `FULL_DAILY` | 需审核 | 正常打开应用与网站、切换窗口、查找控件、普通导航与输入；重大业务提交、对外发消息、敏感文件外发、删除、付款、提权需确认 |
| `CUSTOM` | 完全权限 | **所有操作一律放行，不需要人为确认，不存在不放行的情况** |

产品负责人裁决 ③：`FULL_DAILY`（完全权限）下，即使 `remoteAuthorization` 未开启也放行。

产品负责人裁决：首次启用「完全权限」显示**一次**确认弹窗；此后切换不再弹。档位 id 保持 `BASIC`/`FULL_DAILY`/`CUSTOM` 不变（id 是 `permissions.json` 的持久化字段，改名会破坏既有安装配置），仅改显示层文案。

**需求 2 — 云端视觉开关修复**

「允许本地 AI 使用云端视觉」和「允许微信远程 AI 使用云端视觉」当前打开无效。已确认根因三层：

1. 取值源错误：开关从「授权记录」而非「已配置模型」取 provider/model，初始为空串，必然报错；
2. 授权记录从未被消费：`runtime.evaluateVision()` 无任何生产调用方；
3. 图像从不到达模型：MCP 层只组装文本块。

修复后按 **(a-2)** 语义生效：`vision.local` / `vision.remote` 两条记录**任一已启用即放行**；完全权限档位下同时短路 `remote-authorization-missing` 约束。

**需求 3 — 后台进程中的应用可被发现与打开**

已确认真实故障为**两层**（原调查中的"最小化窗口被过滤"经实盘核证**不成立**，见 §2.4）：

1. `broker/dist` 陈旧，缺 `adapters/`、不含任何 v2 操作 → `unsupported-operation`；
2. `launch-app` 传给 upstream 的参数名错误（传 `app`，upstream 要 `name`）→ upstream 抛 `TypeError`。

**贯穿性产品约束（产品负责人原话口径）**

> 「windows_mcp一律采用内置的，我需要的是小白式的且不报错的。」

落地为两条硬约束：

- **约束 A（内置且零改动）**：`windows_mcp` 一律使用包内 `server/windows_mcp/`，**不修改 vendored Python 任何文件**（实测该目录全部 `.py` 受 MANIFEST 哈希校验，改动必致 `HASH_MISMATCH`，见 §2.4）
- **约束 B（不报错）**：所有失败路径必须返回**可读中文说明**，不得把 Python 异常/英文堆栈透给用户

### 1.2 不包含哪些内容

- 不修改 vendored `windows_mcp` 的任何文件（Python、PS1 探针均不改该目录）
- 不修改 `ActionCategory` 的 4 张分类表语义
- 不修改 `mcp-endpoint.ts` 的传输契约（loopback + per-launch token + 仅 `/mcp`）
- 不修改 `permission-policy.ts` 文档结构与 `permission-store.ts` 持久化机制
- 不修改 `policy/execution-origin.ts`、`approval-ticket.ts`、`broker/ticket-verify.ts`
- 不修改 `browser-policy.ts`、`appcontainer/**`、`windows-node-mxc*.ts`
- 不修改 `main.ts:1854` 的 origin 硬编码（已确认放行不依赖来源识别，见 §2.4）
- 不处理 `BrowserAdapter` / `authorizeBrowserAction` 死代码
- 不重构、不提前抽象、不做需求外优化

### 1.3 成功标准

**需求 1**
- 三档显示名分别为「仅查看」「需审核」「完全权限」
- 「完全权限」下 `decideAction` 对**任意** action 返回 `allow`（例外仅 §2.4 的 4 项结构性限制）
- 「需审核」下 mutating 操作仍逐次弹审批
- 「仅查看」下只放行读类操作
- 完全权限下的 mutating 调用**仍携带有效票据**（防伪造，非确认）
- 首次启用弹一次确认，此后不弹

**需求 2**
- 点击开关不再报"请先在模型设置中配置服务商与模型"
- `permissions.json` 的 `vision.local.enabled = true`，provider/baseUrl/model 与 `openclaw.json` 的 `agents.defaults.model.primary` 一致
- 两个开关任一开启，`screenshot` 通过视觉闸门
- 视觉授权开启后，**模型实际收到图像内容**（`content[]` 含 `type:"image"` 块）
- 授权关闭时 `screenshot` 不发图像，且拒绝原因可读

**需求 3**
- `broker/dist` 重新编译后含 `companyclaw.broker.v2`
- `list-installed-apps` 返回应用清单，不再 `unsupported-operation`
- 后台/最小化进程的程序能被列出、能被带回前台
- **缺参调用返回可读中文拒绝，不抛异常**（约束 B）

**工程标准**
- `desktop` / `broker` / `renderer` 三套测试全绿（基线见 §5.4）
- `typecheck` 与 `lint` 无**新增**错误
- 依赖旧档位语义/文案的既有断言已按新语义更新

---

## 2. Current Understanding

### 2.1 当前实现方式

**权限判定链**

```
PermissionSettings.vue (三张卡)
  → api.permissions.setPreset({preset, acknowledged})
  → ipc.ts  companyclaw:permission:set-preset  → isPermissionPreset()
  → runtime.setPreset()  → permissions.json 落盘 (contract companyclaw.permission-policy.v2)
  → decideAction() (policy/risk-classifier.ts)
       ← preset + origin + taskGranted + remoteAuthorization
       唯一取用处：presetSuppressesRoutinePrompts(preset) === (preset === "FULL_DAILY")
       仅影响一条规则：R2 且 taskGranted 时 allow
```

**工具调用链**

```
对话 → OpenClaw Gateway → MCP client (streamable-http)
  → mcp-endpoint.ts (127.0.0.1, per-launch token)
  → main.ts:1899 runAgentToolCall({name, arguments})
  → main.ts:1851 runtime.handleAgentToolCall({origin: "local-ui" ← 硬编码})
  → tool-facade.ts ComputerUseToolFacade.handle()
       validateToolCall → decideToolAction → dispatch / require-approval / deny
  → runtime.executeStepWithLock() → ExecutionBridge.execute() ← 第二道判定
  → createBrokerTransport() → broker.call()
  → broker-client.ts (child process, stdio)
  → broker/dist/main.js ← 运行产物
  → broker/server.ts executeAuthorized()
       v1 ops → broker/uia.ts (PowerShell 只读探针)
       v2 ops → WindowsMcpExecutionAdapter → WindowsMcpSession → 内置 Python
```

**内置 Python 的加载链（实测确认）**

```
session.ts:138  spawn(pythonExecutable, ["-m","windows_mcp","serve","--transport","stdio"])
                  pythonExecutable = <payload>/python-runtime/Scripts/python.exe
session.ts:141  cwd: layout.serverDir  = <payload>/server
                ⇒ python -m 把 cwd 置于 sys.path[0]
                ⇒ 实际加载 <payload>/server/windows_mcp/__init__.py   ✅ 内置副本
                  （python-runtime/Lib/site-packages/windows_mcp/ 存在但不会被加载）
```

**视觉授权链**

```
PermissionSettings.vue:160 toggleVision(origin, enabled)
  → 取值源: vision.value[origin] ← 授权记录本身（初始全空串）✗ 缺陷
  → api.vision.set({provider, baseUrl, model})
  → ipc.ts companyclaw:vision:set → runtime.authorizeVision()
       provider/baseUrl/model 必填非空
  → permissions.json  vision.local / vision.remote 落盘
  → vision-gate.ts selectVisionRecord(policy, origin) ← 按 origin 单选 ✗ 死码
  → evaluateVisionRequest() ← 无生产调用方 ✗ 从未执行
```

### 2.2 涉及模块

| 层 | 模块 | 职责 |
|---|---|---|
| 策略 | `desktop/src/companyclaw/policy/permission-preset.ts` | 三档定义、文案、语义函数 |
| 策略 | `desktop/src/companyclaw/policy/risk-classifier.ts` | `decideAction()` 唯一判定点 |
| 策略 | `desktop/src/companyclaw/policy/action-category.ts` | 4 张类别表 |
| 策略 | `desktop/src/companyclaw/policy/execution-origin.ts` | 渠道来源 |
| 策略 | `desktop/src/companyclaw/vision/vision-gate.ts` | 视觉闸门 + 记录选择 |
| 权限 | `desktop/src/companyclaw/permissions/*` | 单一权威文档 |
| 工具 | `desktop/src/companyclaw/tools/computer-use-tools.ts` | 16 工具定义 |
| 工具 | `desktop/src/companyclaw/tools/tool-facade.ts` | 工具 → 策略 → 分发 |
| 桥 | `desktop/src/companyclaw/bridge/broker-transport.ts` | 工具名 → broker 操作 |
| 桥 | `desktop/src/companyclaw/bridge/execution-bridge.ts` | 第二道判定 + 票据校验 |
| MCP | `desktop/src/companyclaw/mcp/mcp-bridge.ts` | JSON-RPC + inputSchema |
| MCP | `desktop/src/companyclaw/mcp/mcp-endpoint.ts` | loopback HTTP 监听 |
| 核心 | `desktop/src/companyclaw/runtime.ts` | 权限/任务/审批/审计/执行聚合 |
| 核心 | `desktop/src/companyclaw/ipc.ts` | IPC 注册 |
| 核心 | `desktop/src/main.ts` | 生命周期 + `runAgentToolCall` + `startMcpBridge` |
| 桥接 | `desktop/src/preload.ts` | `window.openclaw.companyClaw` |
| UI | `desktop/renderer/src/components/PermissionSettings.vue` | 权限设置页 |
| Broker | `broker/main.ts` / `server.ts` / `protocol.ts` / `policy.ts` / `uia.ts` | 执行宿主 |
| Broker | `broker/adapters/windows-mcp/*` | upstream 适配 |
| Broker | `broker/scripts/*.ps1` | 只读 UIA 探针（broker 自有，非 vendored） |
| 上游 | `desktop/resources/companyclaw-broker/windows-mcp/server/windows_mcp/**` | **内置 vendored，本次零改动** |

### 2.3 数据流 / 调用链关键点

**第一道闸（策略）** — `risk-classifier.ts:195-268 decideAction()` 判定顺序：

```
:204  R3 且 isNeverAllowed(category)           → deny
:212  remote 且 R3                             → deny
:220  remote 且 remoteAuthorization != enabled → deny
:233  taskGranted 且 R2 且 preset 抑制         → allow
:245  R0 / R1 / isRoutine                      → allow
:249  commitInterceptable === false            → deny
:260  !isLocallyConfirmable(category)          → deny
:268  兜底                                      → require-approval
```

**第二道闸（执行）** — `ExecutionBridge.execute()`（`execution-bridge.ts:50-87`）独立再跑一次 `decideAction`，并对 mutating 操作校验票据。

**第三道闸（broker）** — `broker/policy.ts:69-117 authorize()`：
- 身份 / 时效 / 目标校验
- `:105` mutating 操作在 `requireApprovalForMutations` 下必须带有效票据
- `broker/main.ts:76` 该开关**硬编码为 `true`**
- 已确认对 GUI 工具是空转：`:90` 的 `process-not-allowed` 需要 `target.processName`，而 `main.ts:1831-1834` 的 `targetFor` 只传 `windowTitle`；`broker-targets.json` 无自动写入方

**实测决策矩阵**（临时探针枚举全部 16 工具 × 3 档 × 2 origin，探针文件已移入回收站）：

```
工具实际产生的 action kind 只有 3 种：
DISTINCT_KINDS = ["read", "write", "attachment-to-third-party"]
→ read  (9 个): list-installed-apps / list-windows / snapshot-ui-tree / find-control /
                read-control / screenshot / wait-for-condition / inspect-dialog / verify-state
→ write (6 个): launch-app / focus-window / click / type-text / hotkey / scroll
→ attachment-to-third-party (1 个): drag-drop

六类 never-allowed（payment / system-config / bypass-security /
arbitrary-command / unknown-program / high-risk）在工具面上不可达：
全仓只有 tool-facade.ts:362 的 default 分支会构造 high-risk，
而它只对不在 AGENT_TOOLS 里的工具名生效，工具表是闭集。
```

**完全权限的关键约束**：`R0`/`R1`/`isRoutine` 仅覆盖 `read` 与部分 `write`；`write` 走 `:268` 兜底为 `require-approval`。这就是"选了完全权限仍逐个弹窗"的原因。

### 2.4 已确认的影响范围

**需求 3 的真实故障（实测）**

| 层 | 事实 | 证据 |
|---|---|---|
| ① 产物陈旧 | `broker/dist/main.js` mtime `10-09 17:31`；`dist/` 无 `adapters/`；`dist/protocol.js` 与 `dist/server.js` 中 `companyclaw.broker.v2` 出现 **0** 次 | `grep -c` 实测 |
| ① 无自动编译 | `broker/package.json` 有 `build: tsc`，但 `desktop/package.json` 的 `dev:electron`（`tsc && electron .`）与 `build` 都不调用它；`broker/dist` 被 `broker/.gitignore` 忽略 | 脚本对比 |
| ① 实测复现 | 向运行中的端点发 `tools/call list-installed-apps` 返回 `已拒绝：unsupported-operation` | 实盘调用 |
| ② 参数名错 | upstream `App` 参数为 `mode`/`name`/`window_loc`/`window_size`/`executable`/`args`/`cwd`，**无 `app`** | `tools/app.py:89-98` vs `execution-adapter.ts:159` |
| ② 异常而非可读失败 | `d.app('launch', None, None, None)` → `TypeError: expected string or bytes-like object, got 'NoneType'` | 实盘调用 |
| ② focus 缺参同样抛异常 | `d.app('switch', None, None, None)` → `ValueError: Error switching app: expected string or bytes-like object, got 'NoneType'` | 实盘调用 |
| ② 发现能力无承载者 | upstream 无任何工具调用 `get_apps_from_start_menu()`；但该函数**本身可用**，实测返回 **184** 项，`QQ`/`微信`/`Google Chrome` 均可模糊匹配 | `grep` + 实盘调用 |

**已撤回的假设（原调查有误，实盘推翻）**

| 原假设 | 实测反证 |
|---|---|
| ~~`IsWindowVisible` 把最小化窗口过滤掉，导致后台程序找不到~~ | `IsWindowVisible` 对最小化窗口返回 **true**。429 个有标题窗口中 11 个最小化，其中 10 个 `visible=true`。broker 脚本 `list-windows.ps1` 与 upstream `get_windows()` **返回同样的 14 个窗口**，含全部 11 个最小化窗口 |
| ~~`switch_app` 无法恢复最小化窗口~~ | `d.app('switch', 'MuMuNxDevice', ...)` → **`'Restored Mumunxdevice from minimized and switched to it.'`** 成功。`bring_window_to_top` 既有 `IsIconic` + `SW_RESTORE` 路径工作正常 |

**结论**：需求 3 的"后台进程找不到"是 ①（v2 工具链整体不可用）+ ②（参数名错）造成的**表象**，最小化窗口本身从来不是障碍。**不改 `list-windows.ps1`、不改 `broker/uia.ts` 的 `WindowDescriptor`、不改 vendored Python。**

**内置 windows_mcp 的加载与哈希约束（实测）**

```
加载实测：
  cd <payload>/server && ../python-runtime/Scripts/python.exe -c "import windows_mcp; print(windows_mcp.__file__)"
  → D:\...\windows-mcp\server\windows_mcp\__init__.py      ✅ 内置副本

MANIFEST 覆盖实测：
  MANIFEST.json：upstreamVersion 0.8.7 / upstreamCommit b455c2766c63 / files 66
  66 个条目**全部**是 windows_mcp/**/*.py
  process-manager.ts:158-175 逐文件 sha256 校验，不符 → health "HASH_MISMATCH"
  → 改 server/windows_mcp/*.py 必致用户可见的"组件校验失败"
  → 改 python-runtime/Lib/site-packages/windows_mcp/ 不被校验，但**根本不被加载**

两份副本关系：diff -q 无内容差异（site-packages 仅多 __pycache__）
```

**处置：vendored Python 零改动。** 这同时满足约束 A（一律采用内置）与约束 B（不报错）。

**需求 2 的三层故障**

| 层 | 事实 | 证据位置 |
|---|---|---|
| ① 取值源错 | `const current = vision.value[origin]`，`vision` 来自 `policy.vision`（授权记录，初始空串） | `PermissionSettings.vue:169-181` |
| ② 无消费方 | `runtime.evaluateVision()` 全仓无生产调用方；`ipc.ts`/`preload.ts`/`main.ts` 均未暴露 | `grep -rn evaluateVision desktop/src` 仅 2 处 |
| ② 按 origin 单选是死码 | 工具调用永远以 `local-ui` 进入（`main.ts:1854` 硬编码），故 `vision.remote` 永不被读取 | `vision-gate.ts:75-80`、`runtime.ts:1024` |
| ③ 图像不到模型 | `mcp-bridge.ts:265-272` 只回 `[{type:"text", text}]`；`BridgeToolResult`（`:50-52`）无图像字段 | `grep` 实测 |

**图像载荷通道的两处精确断点（逐层核实）**

```
upstream Screenshot (_snapshot_helpers.py:238)
  → response.append(Image(data=screenshot_bytes, format="png"))   ← 图像在此产生
  → broker session.ts:236   return { ok: true, content: result }   ← 完整保留 ✓
  → execution-adapter.ts:127  data: result.content                 ← 完整保留 ✓
  → server.ts:610           data: result.data                      ← 完整保留 ✓
  → stdio 回传 desktop
  → broker-transport.ts:135
      return { status:"ok", detail: JSON.stringify(result.data).slice(0, 2_000) }
      ▲ 断点 1：截断到 2000 字符，base64 PNG 必被截断
      ▲ 且 BridgeResponse 只有 detail: string，无图像字段
  → execution-bridge.ts:16-19  BridgeResponse / BridgeResult 仅 detail
  → tool-facade.ts:80-83       FacadeDispatchResult 仅 executed{detail}
  → main.ts:1865               runAgentToolCall 返回 { ok, text }
  → mcp-endpoint.ts:32-35      callTool 返回 { ok, text }
  → mcp-bridge.ts:265-272
      content: [{ type:"text", text: result.text }]
      ▲ 断点 2：MCP 层只组装文本块
```

已有可复用钩子：`mcp-bridge.ts:51` 的 `BridgeToolResult.structured?: unknown` 与 `:270` 的 `structuredContent` 已存在，但 MCP 图像须作为 `content[]` 中的 `{type:"image", data, mimeType}` 块，不能走 `structuredContent`。

**MCP 端点为进程级共享连接（决定裁决 ③ 的落地方式）**

| 事实 | 证据 |
|---|---|
| 端点 `callTool` 签名只有 `{name, arguments}`，不含会话/来源信息 | `mcp-endpoint.ts:32-35`，实现 `:116-119` |
| OpenClaw MCP client 按 server 名统一管理连接 | `dist/mcp-client-lifecycle-C_HKlKHp.mjs:257` |
| `mcp.servers` 无 per-agent 作用域（`agents.tools` 存在，`agents.*.mcp` 不存在） | `grep` openclaw dist 实测 |

**结论**：本机对话与微信对话共用同一 MCP server 连接，端点侧收不到可信来源信息。裁决 ③ **不能**通过"识别来源"实现，只能通过"按档位统一放行"实现。`main.ts:1854` 的 origin 硬编码**无需修改**。

**产品负责人裁决对需求书的覆盖（必须记录）**

`docs/CompanyClaw__修改实施书5.0.md` 有三处与本次裁决直接冲突：

| 位置 | 原文要点 | 裁决 |
|---|---|---|
| `:225` | "不得用『无条件完全控制整台电脑』的承诺误导" | 被覆盖：明确以「完全权限」为档位名 |
| `:741` | "普通『全面日常操作』使 R3、UAC 绕过或敏感写入永久自动允许"列为禁止项 | 被覆盖：完全权限下 R3 类亦放行 |
| `:512` | 列有"不得被永久预批准"的动作清单 | 被覆盖 |

按 A3 硬闸，本 Plan **不修改需求文档**，仅在 §2.4 与 Step 9 记录为"产品负责人显式覆盖"。

**结构性限制（无法用代码放行的 4 项）**

以下不是策略性拒绝，是物理或架构事实，即使在完全权限下也无法放行：

1. **Windows UAC 安全桌面不可交互** — 操作系统限制
2. **AppContainer 沙箱边界** — 进程隔离边界，不在策略层
3. **broker 票据完整性校验** — `broker/policy.ts:105-113`，防伪造凭证而非用户确认；放行等于取消整条链路的防篡改
4. **`enterpriseRestrictions.stricterRules`** — 企业策略字段，当前为空数组

---

## 3. Implementation Steps

### Step 1

#### Target

- 文件：`desktop/package.json`（主）、`broker/package.json`（如已含 `build` 则不修改）
- 模块：dev / build 脚本链
- 字段：`scripts.dev:electron`、`scripts.build`

#### Current Behavior

```jsonc
// desktop/package.json
"dev:electron": "tsc && electron .",
"build": "tsc && cd renderer && npm run build",
```

`broker/package.json` 有 `"build": "tsc"`，但上述两条命令都不调用它。`broker/dist` 被 `broker/.gitignore` 忽略，因此冻结在 `10-09 17:31`：无 `adapters/`、无任何 v2 操作名。运行中的 broker 对 `list-installed-apps` 返回 `unsupported-operation`。

#### Change

1. `dev:electron` 前置 broker 编译：
   ```jsonc
   "dev:electron": "npm run build --prefix ../broker && tsc && electron ."
   ```
2. `build` 同前置：
   ```jsonc
   "build": "npm run build --prefix ../broker && tsc && cd renderer && npm run build"
   ```
3. 不改 `prepare-production-resources.mjs`（`broker/dist` 的打包路径已在 `:374-382` 独立处理）

#### Reason

需求 3 的第①层，**前置必做**。不修这条，后续所有 broker 侧改动在开发模式下都不生效，且会以"工具不可用"掩盖真实故障。复用既有 `build: tsc`，不引入新构建系统。

#### Risk

- 每次 `npm run dev` 增加一次全量 `tsc`（broker 规模小，可接受）
- 若 broker 侧存在既有类型错误，`dev` 会因此失败——这是**期望行为**（暴露问题而非静默跳过）
- 不影响打包链路（`prepare-production-resources.mjs:374` 已独立编译）

#### Verification

```bash
npm run build --prefix broker
test -f broker/dist/adapters/windows-mcp/execution-adapter.js && echo "adapters OK"
grep -c "companyclaw.broker.v2" broker/dist/protocol.js   # 期望 ≥ 1
```

---

### Step 2

#### Target

- 文件：`broker/adapters/windows-mcp/execution-adapter.ts`
- 函数：`WindowsMcpExecutionAdapter.buildArguments()` 的 `launchApp` 分支
- 同步测试：`broker/adapters/windows-mcp/execution-adapter.test.ts`

#### Current Behavior

```typescript
// :150-160
case "launchApp": {
  const app = typeof raw.app === "string" ? raw.app.trim() : "";
  if (!app) return { refused: "app-required" };
  if (app.includes("\\") || app.includes("/")) {
    return { refused: "application-path-not-accepted" };
  }
  return { value: { mode: "launch", app } };     // ✗ 传 `app`
}
```

upstream `App` 签名为 `mode` / `name` / `window_loc` / `window_size` / `executable` / `args` / `cwd`（`tools/app.py:89-98`），**没有 `app` 参数**。`launch` 模式调用 `get_desktop().app(mode, name, window_loc, window_size)`，`name` 缺失时实盘抛：

```
TypeError: expected string or bytes-like object, got 'NoneType'
```

#### Change

1. `launchApp`：`{ mode: "launch", app }` → `{ mode: "launch", name: app }`
2. 保留全部校验（空值拒绝、路径拒绝）不变
3. 同步测试断言 `execution-adapter.test.ts:34`：
   ```typescript
   expect(calls[0].args).toMatchObject({ mode: "launch", name: "QQ" });
   ```
4. `focusWindow` 的 `name` 传窗口标题的语义经实盘验证**正确**（`switch_app` 在窗口标题上模糊匹配），**保持不改**

#### Reason

需求 3 的第②层。参数名错误使 `launch-app` 即使到达 upstream 也必失败。纯参数名修正，不改变安全性质。

#### Risk

- `tool-registry.ts:208` 的禁键表含 `arguments`（复数），与 upstream `launch_executable` 用的 `args`（复数）不冲突；本 Plan 不使用 `launch_executable`，无需调整
- 该修正是 Step 3 可读拒绝的**必要前提**：参数名对了，缺参场景才会落到显式校验而非 upstream 异常

#### Verification

```bash
npm test --prefix broker -- execution-adapter
```

新增断言：`launch-app` 传出参数含 `name` 且**不含** `app`。

---

### Step 3

#### Target

- 文件：`broker/adapters/windows-mcp/execution-adapter.ts`
- 函数：`buildArguments()` 的 `focusWindow` 分支
- 关联文件：`desktop/src/companyclaw/mcp/mcp-bridge.ts`（`focus-window` 的 inputSchema）
- 测试：`broker/adapters/windows-mcp/execution-adapter.test.ts`

#### Current Behavior

```typescript
// :162-165
case "focusWindow": {
  if (!windowName && !processName) return { refused: "target-required" };
  return { value: { mode: "switch", ...(windowName ? { name: windowName } : {}) } };
}
```

`focus-window` 的 `inputSchema` 是 `object({windowTitle, processName}, [])` —— **两个字段都不是必填**（`mcp-bridge.ts:93-99`）。因此模型可以只给 `processName`：

```
只给 processName → buildArguments 返回 { mode: "switch" }（无 name）
  → upstream d.app('switch', None, ...)
  → 实盘抛 ValueError: Error switching app: expected string or bytes-like object, got 'NoneType'
  → server.ts:611 转成 status:"failed"，用户看到英文堆栈式消息   ✗ 违反约束 B
```

#### Change

1. `buildArguments()` 的 `focusWindow` 分支改为按可得信息构造可用参数：
   - 有 `windowTitle` → `{ mode: "switch", name: windowTitle }`（保持现状）
   - 只有 `processName` → **在 broker 侧解析出该进程的窗口标题后再传 `name`**；解析失败时返回 `{ refused: "window-not-found" }`，而非让 upstream 抛异常
   - 两者都缺 → `{ refused: "target-required" }`（保持现状）
2. 解析实现：复用 `context.listWindows()`（broker 自有只读探针）按 `processName` 过滤；但 `buildArguments` 是同步函数且无 context 访问，因此**改在 `execute()` 内、调用 `callTool` 之前**完成解析，或在 `execution-adapter` 注入一个 `resolveWindowTitle(processName)` 依赖（与既有 `callTool` 注入同构）
3. **兜底（约束 B 的核心）**：在 `execute()` 外包一层异常归一化——`callTool` 抛出的异常统一转为 `{ status: "failed", reason: <可读中文> }`，其中 `reason` 不得直接拼接原始英文异常文本作为用户可见消息。用户可见文案由 `mcp-bridge` 层组装为中文说明
4. 可选（若代价小）：把 `focus-window` 的 `inputSchema` 改为 `required: []` 但描述中明确"至少提供一个"；或在 description 里加入"建议同时提供窗口标题"。**不把 `windowTitle` 改成必填**（会破坏只用进程名的既有调用）

#### Reason

约束 B（不报错）的直接落实。当前缺参路径必然抛 Python 异常并透出英文堆栈，与"小白式且不报错"冲突。同时这是需求 3"能打开后台程序"的可靠性补强：用户用自然语言说"打开 QQ"时，模型很可能只给进程名。

#### Risk

- `resolveWindowTitle` 需要在 `execute()` 内做额外一次窗口枚举，增加一次本地调用开销（可接受，`list-windows` 探针为只读）
- 异常归一化若过宽，可能掩盖真实故障——因此**日志保留原始异常**（`console.warn`/stderr 诊断），仅**用户可见文案**做归一化。需在实现中区分这两个通道
- 若实现中发现需要改动 `broker/server.ts` 的 `windowsMcp` 调用约定，属范围**维持**（同链路的错误路径），记入 Execution Log；若需改动 `broker/policy.ts` 或协议，走 Plan Adjustment

#### Verification

```bash
npm test --prefix broker -- execution-adapter session
```

新增测试：
- `focus-window` 只给 `processName` 且该进程有窗口 → 传出 `{mode:"switch", name:<解析到的标题>}`
- `focus-window` 只给 `processName` 且找不到窗口 → 返回 `refused`，**不抛异常**
- `callTool` 抛异常 → `execute()` 返回 `{status:"failed", reason:<可读文案>}`，无英文堆栈

---

### Step 4

#### Target

- 新增文件：`broker/scripts/list-installed-apps.ps1`
- 修改文件：`broker/uia.ts`、`broker/server.ts`、`broker/adapters/windows-mcp/tool-policy-map.ts`、`broker/adapters/windows-mcp/execution-adapter.ts`
- 镜像文件：`desktop/src/companyclaw/broker-protocol.ts`
- 测试：`broker/protocol.test.ts`、`broker/adapters/windows-mcp/tool-policy-map.test.ts`

#### Current Behavior

`list-installed-apps` 走 v2 上游路径：

```typescript
// execution-adapter.ts:54
"list-installed-apps": { tool: "App", capability: "listInstalledApps" },
// :147-148
case "listInstalledApps":
  return { value: {} };      // ✗ 空参数，upstream App 收到 mode 默认 "launch" + name=None → 抛异常
```

而 upstream **没有任何工具**调用 `get_apps_from_start_menu()`（`grep` 全 `tools/` 无结果），该能力在 upstream 侧无承载者。但该函数本身可用：实盘返回 **184** 项，`QQ` / `微信` / `Google Chrome` 模糊匹配正常。

#### Change

1. **新增** `broker/scripts/list-installed-apps.ps1`，仿 `broker/scripts/list-windows.ps1` 的形状（`_uia-common.ps1` 约定 + `ConvertTo-Json -Compress -Depth 4` 包裹对象，避免 PS 5.1 的 `-AsArray` 不兼容）：
   ```powershell
   # 输出 JSON { apps: [ { name, appId } ] }
   $rows = Get-StartApps | Select-Object Name, AppID
   # 回退：Start Menu .lnk 扫描（PROGRAMDATA + APPDATA）
   $payload = [pscustomobject]@{ apps = @($result) }
   $payload | ConvertTo-Json -Compress -Depth 4
   ```
   **注意**：该脚本位于 `broker/scripts/`（broker 自有目录），**不在 vendored `windows_mcp` 内**，不触发 MANIFEST 校验
2. **`broker/uia.ts`** 新增与 `runListWindows` 同构的读取器：
   ```typescript
   export interface InstalledAppDescriptor { name: string; appId: string }
   export function parseInstalledApps(raw: string): UiaProbeResult<InstalledAppDescriptor[]>
   export function runListInstalledApps(options: ProbeOptions): Promise<UiaProbeResult<InstalledAppDescriptor[]>>
   ```
   复用既有 `runScript` 机制，不新增执行通道。`parseInstalledApps` 内置条数上限（2000）防异常
3. **`broker/server.ts`** 在 `executeAuthorized` 的 v1 switch 内（`list-windows` case 附近）新增：
   ```typescript
   case "list-installed-apps": {
     const result = await context.listInstalledApps({ scriptDir: context.scriptDir });
     if (!result.ok) return { status: "failed", reason: result.reason };
     return { status: "ok", data: { apps: result.value } };
   }
   ```
   并在 `ConnectionContext` 的 `Pick<>`、`createConnectionContext` 的默认装配（`options.listInstalledApps ?? ((opts) => runListInstalledApps({...}))`）中登记，模式与 `listWindows`（`:56` / `:171-172` / `:231`）一致
4. **`tool-policy-map.ts`**：`App` 条目的 `capabilities` 去掉 `listInstalledApps`（`:122`），只保留 `launchApp` / `focusWindow`
5. **`execution-adapter.ts`**：`MAPPINGS` 移除 `"list-installed-apps"`；`buildArguments` 的 `listInstalledApps` case 改为返回 `{ refused: "native-capability" }`，使"走错路径"显式失败而非假装成功
6. **镜像同步** `desktop/src/companyclaw/broker-protocol.ts`（与 `broker/protocol.ts` 逐字一致）
7. `broker/protocol.ts` 的 `list-installed-apps` 保持在 `READ_ONLY_OPERATIONS`（当前已在 `:96`），补注释说明其由 broker 原生承载

#### Reason

需求 3。`list-installed-apps` 是"发现可打开的程序"的唯一入口，upstream 无实现，必须落在 broker 原生能力。这符合 `tool-policy-map.ts:236-249` 已确立的模式（`listWindows` / `readControl` / `captureExecutionError` 已在此列），保证 upstream 升级不会移除产品承诺的能力。**且不触碰 vendored Python**（约束 A）。

#### Risk

- `Get-StartApps` 在 Windows 10/11 均可用；回退路径覆盖精简系统
- 输出规模：常见机器 100–300 条（实测 184），需在 `parseInstalledApps` 限制上限
- `broker/protocol.ts` 与 `desktop/src/companyclaw/broker-protocol.ts` 是**两份手工镜像**，必须同步（既有 `broker-protocol.test.ts` 会钉住）
- 与 Step 2 的 `launch-app` 配合：发现用 broker 原生、启动用 upstream `App`（参数名已修正）。两条路径都可用

#### Verification

```bash
npm run build --prefix broker && npm test --prefix broker
# 实盘：重启 dev 后向端点发 tools/call list-installed-apps
# 期望：返回应用清单（实测应含 184 项），不再 unsupported-operation
```

新增测试：`parseInstalledApps` 正常/异常 JSON/空列表/超限截断；协议镜像一致性。

---

### Step 5

#### Target

- 文件：`desktop/src/companyclaw/policy/permission-preset.ts`、`desktop/src/companyclaw/policy/risk-classifier.ts`、`desktop/renderer/src/components/PermissionSettings.vue`
- 函数：`decideAction()`、`PRESET_DESCRIPTIONS`

#### Current Behavior

`permission-preset.ts:64-66`：

```typescript
export function presetSuppressesRoutinePrompts(preset: PermissionPreset): boolean {
  return preset === "FULL_DAILY";
}
```

`risk-classifier.ts:233-243` 是 preset 的**唯一**取用点：

```typescript
if (context.taskGranted && classification.level === "R2"
    && presetSuppressesRoutinePrompts(context.preset ?? "BASIC")) {
  return { ..., decision: "allow" };
}
```

因此 `write` 类操作（`launch-app`/`focus-window`/`click`/`type-text`/`hotkey`/`scroll`）仍走 `:268` 兜底为 `require-approval`。

`PRESET_DESCRIPTIONS`（`:40-58`）当前文案为「基础权限」「全面日常操作」「高级自定义」。

#### Change

1. **`permission-preset.ts`** 新增：
   ```typescript
   /**
    * True for the preset the product owner defined as "完全权限": every action is
    * allowed without a human confirmation, including the categories that are
    * otherwise refused on every channel.
    *
    * Product-owner ruling 2026-10-10 explicitly overrides requirement §225/§512/§741.
    */
   export function presetAllowsEveryAction(preset: PermissionPreset): boolean {
     return preset === "FULL_DAILY";
   }
   ```
   保留 `presetSuppressesRoutinePrompts`（`risk-classifier.ts:236`、`runtime.ts:613` 仍用）
2. **`permission-preset.ts`** 更新 `PRESET_DESCRIPTIONS` 三档文案为「仅查看」「需审核」「完全权限」，`detail` 与 `confirmations` 同步新语义
3. **`risk-classifier.ts`** 在 `decideAction()` 的 `:204` **之前**插入最高优先级分支：
   ```typescript
   if (presetAllowsEveryAction(context.preset ?? "BASIC")) {
     return {
       ...classification,
       decision: "allow",
       reasons: [...classification.reasons, "完全权限：不需要人为确认"],
     };
   }
   ```
   该分支先于永禁类别、remote R3、remote 授权状态、`commitInterceptable`、本地可确认性检查，**同时实现裁决 ③**（`remoteAuthorization` 未开启也放行）
4. **`PermissionSettings.vue`** 的 `presetCards`（`:33-59`）三条 `title` / `detail` / `confirmations` 改为新文案；`acknowledgeDialog` **保留**（首次启用弹一次），弹窗文案与新档位语义一致
5. **不改**档位 id：id 是 `permissions.json` 的持久化字段，改名会破坏既有安装并使 `migrate.ts` 的 `presetAfterMigration` 回落默认档。仅改显示层

#### Reason

需求 1 核心。当前分支位于 `:233`，只覆盖"R2 + taskGranted"；产品要求"完全权限下所有操作免确认"，必须提升为最高优先级短路。这也使 `runtime.execute()` 那条非 GUI 入口自动一致（两处共用 `decideAction`）。

#### Risk

- **本次改动中安全影响最大的单点。** 需求书 `:225`/`:512`/`:741` 三处冲突已在 §2.4 记录为产品负责人显式覆盖，并将在 Step 9 同步到 `docs/companyclaw/v5/`
- `presetSuppressesRoutinePrompts` 在新分支下变成不可达。**保留该函数与 `:233` 的分支**：① 是 `decideAction` 被单独调用（不传 preset 或传其他档）时的既有契约；② 删除会牵连 `runtime.ts:613` 与既有测试。仅在其上方加注释说明已被更高优先级分支覆盖
- 审计日志新增 `完全权限：不需要人为确认` reason，既有断言若对 `reasons` 做全等比较需同步
- `classifyAction` 仍算出 R3 等级，故 `level` 可能与 `decision:"allow"` 并存（如 `high-risk` → R3 + allow）。这不是缺陷：`level` 描述后果分类，`decision` 描述是否放行；审计保留二者以便事后追溯

#### Verification

```bash
npm test --prefix desktop -- risk-classifier v5-channel-policy runtime-tool-policy
npm test --prefix desktop/renderer -- PermissionSettings
```

新增矩阵测试（三档 × 2 origin × 全部 `ActionKind`）：
- `FULL_DAILY` + 任意 kind + 任意 origin + `remoteAuthorization:"disabled"` → `allow`
- `BASIC` 下 `write` → `require-approval`
- `CUSTOM` 下 `write` → `require-approval`
- `FULL_DAILY` 下 `payment` / `bypass-security` / `high-risk` → `allow`（覆盖需求书反例清单）

---

### Step 6

#### Target

- 文件：主要为测试新增，预期**无生产代码改动**
- 模块：`desktop/src/companyclaw/tools/tool-facade.ts`、`desktop/src/companyclaw/runtime.ts`、`broker/policy.ts`
- 测试：`desktop/src/companyclaw/runtime-tool-chain.test.ts`

#### Current Behavior

`tool-facade.ts:228-230`：

```typescript
const grant: FacadeExecutionGrant | undefined = definition.mutating
  ? { action, origin: context.origin, target }
  : undefined;
```

`runtime.ts:729-740`：`dispatchInput.executionGrant && dispatchInput.tool.mutating` 时调 `issueExecutionCredential()` 生成票据。

`broker/main.ts:76` 硬编码 `requireApprovalForMutations: true`，`broker/policy.ts:105-113` 对 mutating 操作强制校验票据。

**预期结论**：grant 生成条件（`definition.mutating`）与 preset 无关，完全权限下票据链路应**已自动成立**，无需改代码。

#### Change

无生产代码改动。新增测试锁定该状态：
1. `FULL_DAILY` 下 `click` 调用 → facade 返回 `executed`（而非 `approval-required`）
2. 断言 `dispatch` 收到的 `executionGrant` 非空
3. 断言 `issueExecutionCredential` 被调用且 `ticket.nonce` 唯一
4. 断言 `ExecutionBridge` 的 `consumedNonces` 正确消费票据

若测试暴露票据链路在完全权限下断裂（如 grant 未生成），触发 Plan Adjustment。

#### Reason

需求 1 最容易漏的一环：产品要求"不需要人为确认"，但 broker 的**票据校验不是确认而是防伪造**。若误把票据一起放行，等于取消整条链路的防篡改。本步骤用测试锁定"免确认但仍有票据"。

#### Risk

- 若既有测试断言完全权限下带票据（不应有），需核对而非直接改断言
- `broker/policy.ts` 无需改动；若测试显示需要改，属范围扩大，走 Plan Adjustment

#### Verification

```bash
npm test --prefix desktop -- runtime-tool-chain tool-facade
```

---

### Step 7

#### Target

- 文件：`desktop/src/companyclaw/vision/vision-gate.ts`、`desktop/src/companyclaw/runtime.ts`、`desktop/src/companyclaw/ipc.ts`、`desktop/src/preload.ts`、`desktop/renderer/src/components/PermissionSettings.vue`
- 函数：`selectVisionRecord()`、`evaluateVisionRequest()`、`runtime.evaluateVision()`、`runtime.authorizeVision()`
- 测试：`desktop/src/companyclaw/vision/vision-gate.test.ts`

#### Current Behavior

```typescript
// vision-gate.ts:75-80
export function selectVisionRecord(policy, origin): VisionAuthorizationRecord {
  return isRemoteOrigin(origin) ? policy.vision.remote : policy.vision.local;
}
```

```typescript
// runtime.ts:1024-1025
const record = selectVisionRecord(this.permissionPolicy, input.origin);
return evaluateVisionRequest(record, { ... }, this.now());
```

`evaluateVision()` 无生产调用方。

```typescript
// PermissionSettings.vue:169-181
const current = vision.value[origin];
if (!current?.provider || !current?.model) {
  error.value = "请先在模型设置中配置服务商与模型，再授权云端视觉识别";
  return;
}
await api.vision.set({ origin, provider: current.provider, baseUrl: current.baseUrl, model: current.model });
```

`vision.value` 来自 `policy.vision`（授权记录），初始全空串 → 必然报错。

`vision-gate.ts:152-167` 的 `remote-authorization-missing` 判定依赖 origin，而工具调用永远以 `local-ui` 进入 → `vision.remote` 是死码。

#### Change

1. **`vision-gate.ts`** — 新增合并选择函数，**保留** `selectVisionRecord` 不动（既有测试 `:113-140` 钉住它）：
   ```typescript
   /**
    * The record that applies to a request, with both channel records merged.
    *
    * Product-owner ruling (a-2), 2026-10-10: either switch being enabled is
    * enough — the two records are two ways for the owner to say "yes", not two
    * separate authorities. Picking by origin made the remote record unreadable,
    * because every tool call reaches the endpoint through the same shared
    * connection and is therefore always `local-ui`.
    */
   export function selectVisionRecordForRequest(policy, origin): VisionAuthorizationRecord {
     const byOrigin = selectVisionRecord(policy, origin);
     if (byOrigin.enabled && !byOrigin.revokedAt) return byOrigin;
     const other = isRemoteOrigin(origin) ? policy.vision.local : policy.vision.remote;
     if (other.enabled && !other.revokedAt) return other;
     return byOrigin;
   }
   ```
2. **`vision-gate.ts`** — `evaluateVisionRequest()` 增加可选参数 `allowWithoutRemoteAuthorization?: boolean`（默认 `false`），在 `:152` 的 remote 分支前置：
   ```typescript
   if (isRemoteOrigin(context.origin) && !allowWithoutRemoteAuthorization) {
     // ...原有 remote-authorization-missing 判定
   }
   ```
   裁决 ③ 要求完全权限下短路该约束，故由 `runtime.evaluateVision()` 按 preset 传入
3. **`runtime.ts:1016 evaluateVision()`**：
   - 改用 `selectVisionRecordForRequest`
   - 传入 `allowWithoutRemoteAuthorization: presetAllowsEveryAction(this.permissionPolicy.preset)`
4. **`runtime.ts:959 authorizeVision()`**：保留 `provider/baseUrl/model` 必填校验（"说清数据发给谁"的性质）
5. **`runtime.ts` 新增 `getConfiguredModel()`**：
   ```typescript
   /**
    * The provider/endpoint/model currently configured for the model in use.
    *
    * Read from the OpenClaw config rather than from the vision record: the
    * record is the *authorization*, and it is empty until the switch is turned
    * on — reading the provider from there is why the switch could never be
    * enabled. No credential is read or returned.
    */
   getConfiguredModel(): { provider: string; baseUrl: string; model: string } | null
   ```
   - 读 `agents.defaults.model.primary`（形如 `bendi/deepseek-v4.1-flash`）
   - 按 provider id 读 `models.providers[<id>]` 的 `baseUrl` 与该模型条目
   - `baseUrl` 归一化**沿用** `main.ts:2540-2544` 的补 `/v1` 规则，避免与 `evaluateVisionRequest:130-140` 的三者全等校验不一致
   - **不读取、不返回任何 apiKey**
   - 实现方式：由 `main.ts` 注入 config 读取器（`RuntimeDependencies` 已有注入模式），避免 `runtime.ts` 直接依赖 `main.ts` 的 `getConfigPath()`
6. **`ipc.ts`** 新增只读通道 `companyclaw:vision:get-configured-model`
7. **`preload.ts`** 在 `vision` 命名空间暴露 `getConfiguredModel()`
8. **`PermissionSettings.vue:160-189`** `toggleVision()`：取值源改为 `getConfiguredModel()`；`vision.value` 仅用于渲染授权状态；未配置模型时给出可读错误（保留现有文案语义）
9. **`vision-gate.test.ts`** 新增 `describe("vision gate merges the two channel records (ruling a-2)")`：
   - 本地开启 → 本地与远程 origin 都放行
   - 远程开启 → 本地与远程 origin 都放行
   - 都未开 → 拒绝（`vision-not-authorized`）
   - 本地已撤销、远程开启 → 放行（取未撤销者）
   - 完全权限 + 远程未授权 → 放行（裁决 ③）

#### Reason

需求 2 + 裁决 (a-2) + 裁决 ③。取值源错误是"打开无效"的直接原因；按 origin 单选使远程记录不可读；(a-2) 使两个开关成为"两种说 yes 的方式"；完全权限短路 `remote-authorization-missing` 落实裁决 ③。

#### Risk

- 既有测试 `vision-gate.test.ts:113-140` 的 4 条断言中，`:123 stops a remote upload when the remote operation authorization is gone` 会因新合并逻辑与可选参数而行为变化，需**重写为新的预期语义**，而非删除
- `getConfiguredModel()` 读 `openclaw.json`，该文件含 `apiKey` 字段（引用形式 `${OPENCLAW_MODEL_API_KEY}`）。实现中**只取 provider id / baseUrl / model 名**，禁止读取或记录 apiKey 字段值
- `baseUrl` 归一化不一致会导致"打开了但用不了"（`evaluateVisionRequest:130-140` 三者全等校验），必须在单测中覆盖归一化后的等值场景
- `authorizeVision` 的 `ttlMs` 与 `visionGrantLifetimeMs` 逻辑**不改**

#### Verification

```bash
npm test --prefix desktop -- vision-gate runtime-permissions
npm test --prefix desktop/renderer -- PermissionSettings
```

实盘：打开开关 → 不再报错 → 检查 `permissions.json` 的 `vision.local.enabled === true` 且 provider/model 与 `openclaw.json` 一致。

---

### Step 8

#### Target

- 文件：`desktop/src/companyclaw/bridge/broker-transport.ts`、`desktop/src/companyclaw/bridge/execution-bridge.ts`、`desktop/src/companyclaw/tools/tool-facade.ts`、`desktop/src/companyclaw/runtime.ts`、`desktop/src/main.ts`、`desktop/src/companyclaw/mcp/mcp-endpoint.ts`、`desktop/src/companyclaw/mcp/mcp-bridge.ts`
- 类型：`BridgeResponse`、`BridgeResult`、`FacadeDispatchResult`、`BridgeToolResult`、`McpEndpointDependencies.callTool`

#### Current Behavior

图像在 `_snapshot_helpers.py:238` 产生，经 broker 内部完整保留（`session.ts:236` → `execution-adapter.ts:127` → `server.ts:610`），但在到达 desktop 后于**两处**断裂：

**断点 1** — `broker-transport.ts:135`：
```typescript
return { status: "ok", detail: JSON.stringify(result.data).slice(0, 2_000) };
```
截断到 2000 字符；且 `BridgeResponse`（`execution-bridge.ts:16-19`）只有 `detail: string`。

**断点 2** — `mcp-bridge.ts:265-272`：
```typescript
result: {
  content: [{ type: "text", text: result.text }],
  ...(result.structured !== undefined ? { structuredContent: result.structured } : {}),
}
```
只组装文本块；`McpEndpointDependencies.callTool` 返回类型（`mcp-endpoint.ts:32-35`）只有 `{ ok, text }`。

#### Change

新增一条**图像载荷旁路**，不复用 `detail` 字符串（避免截断与转义膨胀）：

1. **`broker-transport.ts`**
   - `BrokerTransportCaller` 返回类型扩展：`{ ok: true; data: unknown; images?: ImagePayload[] }`
   - `:135` 保持不变（文本仍截断到 2000）；新增从 `result.data` 提取 `type:"image"` 块：
     ```typescript
     function extractImages(data: unknown): ImagePayload[] | undefined
     ```
     **必须在 `JSON.stringify` 之前从原始对象提取**
   - 返回 `{ status: "ok", detail, ...(images ? { images } : {}) }`
2. **`execution-bridge.ts`**
   - 定义并导出 `export interface ImagePayload { data: string; mimeType: string }`
   - `BridgeResponse` 与 `BridgeResult` 的 `ok` / `executed` 变体增加 `images?: ImagePayload[]`（可选字段，向后兼容）
   - `:76` 透传 images
3. **`tool-facade.ts`**
   - `FacadeDispatchResult` 的 `executed` 变体增加 `images?: ImagePayload[]`
   - `FacadeDispatch` 增加 `images?: ImagePayload[]`
   - `handle()` 与 `dispatchOnce()` 透传；`ToolFacadeResult` 的 `executed` 变体增加 `images?`
4. **`runtime.ts`**
   - `handleAgentToolCall()` 的 `dispatch` 回调透传 images
   - **在此处接入视觉闸门**（Step 7 的 `evaluateVision()`）：
     ```typescript
     // 图像离开本机前的最后一道闸：截图本地可用不等于允许上传给模型。
     if (dispatchInput.tool.name === "screenshot") { /* evaluateVision，拒绝则不返回 images */ }
     ```
     选择此位置而非 `tool-facade`：`dispatch` 已持有 `taskId`/`stepId`/`origin`/`deviceId`，是 `evaluateVision()` 所需上下文的现成来源，且保持 `tool-facade` "只做策略判定"的单一职责
   - **不变式：闸门拒绝时 `images` 必须为 `undefined`，不得先传后拒**
5. **`main.ts:1796 runAgentToolCall()`** 返回类型扩展为 `{ ok: boolean; text: string; images?: ImagePayload[] }`；`:1865` 的 `executed` 分支透传
6. **`mcp-endpoint.ts:32-35`** `callTool` 返回类型扩展 `images?: { data: string; mimeType: string }[]`；`:119` 透传到 `BridgeToolResult`
7. **`mcp-bridge.ts`**
   - `BridgeToolResult` 的 `ok: true` 变体新增 `images?: { data: string; mimeType: string }[]`
   - `:265-272` 组装 content 时追加图像块：
     ```typescript
     content: [
       { type: "text", text: result.text },
       ...(result.images ?? []).map((image) => ({
         type: "image",
         data: image.data,
         mimeType: image.mimeType,
       })),
     ],
     ```
   - **不用 `structuredContent`**：MCP 图像必须是 `content[]` 中的独立块
8. **`broker/adapters/windows-mcp/execution-adapter.ts`**：确认 `screenshot` 的 `data: result.content` 完整保留（已核实 `:127` 无截断），**无需改**

#### Reason

需求 2 的决定性一环。前序核实已确认：即使开关能存盘、`evaluateVision()` 被接线，若图像不到模型，产品语义仍是空转。产品负责人已将本项纳入本轮范围。

#### Risk

- **载荷体积**：PNG base64 可达数 MB。需在 `extractImages` 中设置上限（建议 8 MB 原始字节），超限时返回明确失败而非静默丢弃。**不提高 `MAX_BODY_BYTES`**（`mcp-endpoint.ts:53` 管的是入站请求，不受影响）
- **截断语义**：`detail` 仍截断到 2000 字符，图像走旁路。`extractImages` 必须在 `JSON.stringify` **之前**从原始对象提取，而非从已截断字符串解析
- 类型扩展波及多处签名，需同步更新既有测试的 mock 返回形状（`broker-transport.test.ts`、`execution-bridge.test.ts`、`tool-facade.test.ts`、`mcp-bridge.test.ts`、`mcp-endpoint.test.ts`）
- **安全前提**：图像只能在视觉闸门通过后进入 `images`。闸门拒绝时 `images` 必须为 `undefined`
- `BridgeResponse` 增加字段属向后兼容扩展（可选字段），不破坏既有调用方
- 若发现 `session.ts:314 extractText` 在无文本块时返回 `malformed-tool-result` 而阻碍截图路径，属范围扩大，走 Plan Adjustment

#### Verification

```bash
npm test --prefix desktop -- bridge mcp tool-facade
npm test --prefix broker
```

**实盘验收（本步骤关键实证）**：
1. 开启视觉授权
2. 发一条需要看屏的自然语言指令
3. 确认返回的 `tools/call` 响应 `content[]` 含 `type:"image"` 块
4. 关闭视觉授权后重复 → 图像块消失且拒绝原因可读
5. 检查 `dev-electron.log` 无 base64 泄漏到日志

---

### Step 9

#### Target

- 文件：`docs/companyclaw/v5/01-mcp-adapter-adr.md`、`docs/companyclaw/v5/02-permission-preset-adr.md`、`docs/companyclaw/v5/IMPLEMENTATION_STATUS.md`、`docs/companyclaw/v5/BLOCKERS.md`
- 新增：`docs/companyclaw/v5/09-vision-payload-channel-adr.md`

#### Current Behavior

`docs/companyclaw/v5/` 现存 ADR 记录 v5 原始设计口径，其中权限档位语义与本次裁决冲突；`IMPLEMENTATION_STATUS.md` 需反映本次实施结果；`BLOCKERS.md` 需更新既有条目（如 WP10 NSIS 的 `ENV-BLOCKED`）。

#### Change

1. `02-permission-preset-adr.md`：新增章节记录**产品负责人裁决 2026-10-10**，列出对需求书 `:225`/`:512`/`:741` 的显式覆盖、覆盖理由、以及 §2.4 的 4 项结构性限制
2. `01-mcp-adapter-adr.md`：记录 ① `list-installed-apps` 从 upstream 转为 broker 原生能力的决策；② "endpoint 为进程级共享连接、无法识别来源"的事实（裁决 ③ 的实现依据）；③ **内置副本加载机制与 MANIFEST 哈希约束**（vendored Python 零改动的技术依据）
3. 新增 `09-vision-payload-channel-adr.md`：记录图像载荷旁路的设计、两处断点位置、体积上限、"闸门拒绝时 images 必须为 undefined"的不变式
4. `IMPLEMENTATION_STATUS.md`：更新三条需求的完成状态与验证证据
5. `BLOCKERS.md`：记录既有条目；**不再新增"upstream 本地补丁"条目**（因本次零改动 vendored Python）

#### Reason

需求书与裁决的冲突必须有显式记录，否则后续审查会把"完全权限放行 R3"判定为回归。`docs/companyclaw/v5/` 是本需求的既有交付物目录。

#### Risk

- 纯文档，无代码风险
- 按 A3 不修改 `docs/CompanyClaw__修改实施书5.0.md` 本身

#### Verification

人工复核文档内容与代码实际行为一致。

---

## 4. Changed Files Tracking

> 本节按**实际修改结果**填写（rev.3，实施完成后回填）。

| File | Action | Reason |
| ---- | ------ | ------ |
| `desktop/package.json` | Modify | Step 1：`dev:electron` / `build` 前置 `npm run build --prefix ../broker`，消除 `broker/dist` 陈旧产物 |
| `broker/adapters/windows-mcp/execution-adapter.ts` | Modify | Step 2 参数名 `app`→`name`；Step 3 `focusWindow` 的 `processName` 兜底 + 异常归一化为 `upstream-call-failed`；Step 4 移除 `list-installed-apps` 映射并显式拒绝 |
| `broker/adapters/windows-mcp/execution-adapter.test.ts` | Modify | Step 2/3 断言同步与新增（参数名、可读拒绝、异常归一化、只给进程名的解析与拒绝） |
| `broker/adapters/windows-mcp/tool-policy-map.ts` | Modify | Step 4：`App.capabilities` 去掉 `listInstalledApps`；`listInstalledApps` 移入 `BROKER_NATIVE_CAPABILITIES` |
| `broker/adapters/windows-mcp/tool-policy-map.test.ts` | Modify | Step 4：能力归属断言更新 |
| `broker/scripts/list-installed-apps.ps1` | Add | Step 4：`Get-StartApps` 只读探针（含 Start Menu `.lnk` 回退） |
| `broker/scripts/_uia-common.ps1` | Modify | Plan 外（已批准）：UTF-8 输出编码，覆盖 4 个 dot-source 它的脚本 |
| `broker/scripts/list-windows.ps1` | Modify | Plan 外（已批准）：UTF-8 输出编码——此前中文窗口标题全部变成 U+FFFD |
| `broker/scripts/find-elements.ps1` | Modify | Plan 外（已批准）：同上 |
| `broker/uia.ts` | Modify | Step 4：`InstalledAppDescriptor` / `parseInstalledApps` / `runListInstalledApps`（含 2000 条上限） |
| `broker/uia.test.ts` | Modify | Step 4：解析器与探针测试 |
| `broker/server.ts` | Modify | Step 4：`list-installed-apps` 原生 case + 依赖注入；Step 3：`resolveWindowTitle` 装配 |
| `broker/server.test.ts` | Modify | Step 4：原生发现操作与失败路径测试 |
| `broker/protocol.ts` | Modify | Step 4：`list-installed-apps` 的能力归属注释 |
| `desktop/src/companyclaw/policy/permission-preset.ts` | Modify | Step 5：`presetAllowsEveryAction()`；三档文案改为「仅查看 / 需审核 / 完全权限」 |
| `desktop/src/companyclaw/policy/risk-classifier.ts` | Modify | Step 5：完全权限最高优先级 allow 分支（短路永禁/remote R3/remote 授权/commitInterceptable/本地可确认性） |
| `desktop/src/companyclaw/policy/v5-channel-policy.test.ts` | Modify | Step 5：新增裁决 ③ 矩阵（14 类 action × 2 origin）；旧 R3 断言按新语义拆分 |
| `desktop/renderer/src/components/PermissionSettings.vue` | Modify | Step 5 三档卡片与弹窗文案；Step 7 `toggleVision` 取值源改为已配置模型 |
| `desktop/renderer/src/components/PermissionSettings.test.ts` | Modify | Step 5/7：文案、卡位顺序、确认弹窗、取值源断言 |
| `desktop/src/companyclaw/vision/vision-gate.ts` | Modify | Step 7：`selectVisionRecordForRequest()`（(a-2) 合并选择）；`evaluateVisionRequest()` 增加 `allowWithoutRemoteAuthorization` |
| `desktop/src/companyclaw/vision/vision-gate.test.ts` | Modify | Step 7：裁决 ③ 与 (a-2) 四条新场景 |
| `desktop/src/companyclaw/runtime.ts` | Modify | Step 5 文案；Step 6 无改动；Step 7 `getConfiguredModel()` / `evaluateVision()` 合并选择 / 视觉闸门接入 dispatch；Step 8 图像与参数透传；Step 8b `arguments` 透传；锁只对 mutation |
| `desktop/src/companyclaw/runtime-tool-chain.test.ts` | Modify | Step 5/6：新语义断言 + 票据仍签发 + 每调用唯一 nonce |
| `desktop/src/companyclaw/runtime-tool-policy.test.ts` | Modify | Step 5 新语义；Step 8b 只读不持锁 / mutation 持锁并释放 |
| `desktop/src/companyclaw/recovery/reset-to-defaults.test.ts` | Modify | Step 5：改用「需审核」构造待处理审批（完全权限不再产生审批） |
| `desktop/src/companyclaw/ipc.ts` | Modify | Step 7：`companyclaw:vision:get-configured-model` 通道 + `readConfiguredModel` 注入 |
| `desktop/src/companyclaw/ipc-contract.test.ts` | Modify | Step 7：新增通道计入契约清单 |
| `desktop/src/preload.ts` | Modify | Step 7：暴露 `vision.getConfiguredModel()`（只读，无凭据） |
| `desktop/src/main.ts` | Modify | Step 7：`readConfiguredModelIdentity()` + `readConfiguredModelForVision` 归一化与注入；Step 8/8b：`runAgentToolCall` 返回类型、`targetFor` 改从参数取窗口身份、去掉恒空 `argsFor`、payloadHash 纳入参数；Step 8c：网关自愈重启；Step 8b：broker 票据改用 `issueBrokerTicket` |
| `desktop/src/companyclaw/bridge/execution-bridge.ts` | Modify | Step 8：`ImagePayload` 与 `images` 透传；Step 8b：`BridgeRequest.arguments` |
| `desktop/src/companyclaw/bridge/broker-transport.ts` | Modify | Step 8：`extractImages()`；Step 8b：`argsFor` 可选且默认透传 `arguments`；Step 8c：`summarizeResult()` 按结构截断，杜绝残缺 JSON |
| `desktop/src/companyclaw/bridge/broker-transport.test.ts` | Modify | Step 8b/8c：参数透传、185 项清单可解析、超长按条目缩短、不可缩短时报明原因 |
| `desktop/src/companyclaw/tools/tool-facade.ts` | Modify | Step 8：`images` 透传（`FacadeDispatchResult` / `ToolFacadeResult`） |
| `desktop/src/companyclaw/mcp/mcp-endpoint.ts` | Modify | Step 8：`callTool` 返回类型带 `images` |
| `desktop/src/companyclaw/mcp/mcp-bridge.ts` | Modify | Step 8：把图像组装为 `content[]` 的 `{type:"image"}` 块 |
| `desktop/src/companyclaw/locks/desktop-execution-lock.ts` | Modify | Step 8b：租约（`DESKTOP_LOCK_LEASE_MS`），持有超时自愈，避免一次卡住的调用永久拒绝后续工具 |
| `desktop/src/companyclaw/locks/desktop-execution-lock.test.ts` | Modify | Step 8b：租约到期自愈 + 同任务续租 |
| `desktop/dev-electron.log` | Modify | 运行产物（dev 客户端日志） |

**未修改（Plan 明确排除，已核实）**

| File / Dir | 原因 |
|---|---|
| `desktop/resources/companyclaw-broker/windows-mcp/server/windows_mcp/**` | 内置副本受 MANIFEST 逐文件哈希校验，改必报 `HASH_MISMATCH` |
| `desktop/resources/companyclaw-broker/windows-mcp/python-runtime/**` | 不被加载（`cwd` + `python -m` 决定加载 `server/` 副本） |
| `broker/policy.ts` | 票据校验保留（防伪造，非用户确认） |
| `desktop/src/companyclaw/permissions/permission-policy.ts` | 文档结构不变 |
| `broker/adapters/windows-mcp/tool-registry.ts` | 禁键表无需调整 |

**测试基线（实施后）**

| 套件 | 结果 |
|---|---|
| `desktop` | 104 files / 1807 passed / 2 skipped |
| `desktop/renderer` | 29 files / 342 passed |
| `broker` | 15 files / 161 passed |
| `tsc --noEmit`（desktop / broker） | 通过 |
| `eslint`（desktop） | 121 problems — 5 errors 全部**既存**（`chat-attachments.ts:105`、`mcp-endpoint.ts:5-6`、`main.ts:69`、`openclaw-upgrade-recovery.ts:235`） |
| `eslint`（renderer） | 97 problems — 1 error **既存**（`PermissionSettings.vue:18` 未使用的 `store`） |


---

## 5. Verification Checklist

### 5.1 主流程验证

- [ ] **需求 1**：三档分别从对话发起 `list-windows`（read）、`launch-app`（write）、`click`（write）
  - 「仅查看」：read 放行，write 需确认
  - 「需审核」：每次弹一次审批，批准后执行
  - 「完全权限」：零弹窗全部直通
- [ ] **需求 1 裁决 ③**：`remoteAuthorization` 关闭时，完全权限下 `weixin-private` origin 的 `decideAction` 返回 `allow`
- [ ] **需求 1 文案**：设置页三档显示为「仅查看」「需审核」「完全权限」
- [ ] **需求 1 弹窗**：首次启用「完全权限」弹一次确认；此后切换不重复弹
- [ ] **需求 2**：打开「允许本地 AI 使用云端视觉」→ 不报错 → `permissions.json` 的 `vision.local.enabled === true`，provider/baseUrl/model 与 `agents.defaults.model.primary` 一致
- [ ] **需求 2**：两个开关任一开启 → `screenshot` 通过视觉闸门
- [ ] **需求 2**：发一条需看屏的指令 → **响应 `content[]` 含 `type:"image"` 块**
- [ ] **需求 3**：`list-installed-apps` 返回应用清单（实测基线 184 项），不再 `unsupported-operation`
- [ ] **需求 3**：最小化/后台程序能被列出，且 `launch-app` / `focus-window` 能带回前台
- [ ] **需求 3 约束 B**：缺参调用返回可读中文拒绝，不出现英文异常文本

### 5.2 关联流程验证

- [ ] `decideToolAction`（`runtime.ts:575`）与 `ExecutionBridge.execute`（`execution-bridge.ts:51`）判定一致，无"facade 放行、bridge 拒绝"
- [ ] 完全权限下 mutating 调用**仍携带有效票据**（Step 6）
- [ ] 完全权限下 `drag-drop`（`attachment-to-third-party`）直通
- [ ] 视觉授权后 `guardian.ts:354-357` 的 `visionAuthorized` 探针翻转为已授权
- [ ] 切换 provider/model 后旧视觉授权失效（`provider-changed`）
- [ ] 视觉授权过期后开关显示为未启用
- [ ] **关闭视觉授权后 `screenshot` 不发图像**，且拒绝原因可读
- [ ] 恢复默认：从「完全权限」reset → 回到「仅查看」，`vision.local` / `vision.remote` 双清
- [ ] `launch-app` → 应用确实启动（upstream 参数名修正的端到端证明）

### 5.3 边界情况验证

- [ ] **需求 3**：同名多窗口、中文/超长标题截断
- [ ] **需求 3**：`Get-StartApps` 不可用时回退 Start Menu `.lnk` 扫描
- [ ] **需求 3**：无 UWP AppID 的纯 Win32 程序
- [ ] **Step 3**：`focus-window` 只给 `processName` → 解析到窗口标题后成功；找不到窗口 → `refused` 而非异常
- [ ] **Step 3**：`callTool` 抛异常 → 用户可见文案为中文，原始异常仅入日志
- [ ] **需求 1**：`acknowledged` 缺失时 `runtime.setPreset` 仍抛错
- [ ] **需求 1**：`clearUserGrants` 后 preset 回落默认档
- [ ] **需求 2**：未配置模型时点击开关给出可读错误而非静默失败
- [ ] **需求 2**：`baseUrl` 归一化（补 `/v1`）后与 `evaluateVisionRequest` 全等校验一致
- [ ] **Step 8**：图像超体积上限时返回明确失败，不静默丢失
- [ ] **Step 8**：base64 图像不进日志
- [ ] **回归**：最小化窗口可被 `list-windows` 列出（原 Step 4 的前提，实测已通过，确保未被新改动破坏）

### 5.4 Test

```bash
npm test --prefix desktop                  # 基线 104 文件 / 1784 passed / 2 skipped
npm test --prefix broker                   # 基线 15 文件 / 150 passed
npm test --prefix desktop/renderer         # 基线 29 文件 / 340 passed
```

- [ ] 三套测试全绿
- [ ] 依赖旧档位语义/文案的既有断言已按新语义更新（`runtime-tool-policy.test.ts`、`v5-channel-policy.test.ts`、`tool-facade.test.ts`、`PermissionSettings.test.ts`、`reset-to-defaults.test.ts`、`risk-classifier.test.ts`）
- [ ] 新增：三档 × 2 origin × 全部 `ActionKind` 决策矩阵（含裁决 ③ 场景）
- [ ] 新增：`vision gate merges the two channel records (ruling a-2)`
- [ ] 新增：`launch-app` 参数名断言（含 `name`、不含 `app`）
- [ ] 新增：`focus-window` 只给 `processName` 的解析与拒绝路径
- [ ] 新增：`parseInstalledApps` 正常/异常/空/超限
- [ ] 新增：完全权限下票据仍签发（Step 6）
- [ ] 新增：图像块在闸门通过时出现在 `content[]`、拒绝时不出现（Step 8）
- [ ] 回归：最小化窗口枚举（§5.3 最后一条）

### 5.5 Build

```bash
npm run build --prefix broker              # 本次起为必经步骤
npm run build --prefix desktop
```

- [ ] `broker/dist/adapters/windows-mcp/execution-adapter.js` 存在
- [ ] `grep -c "companyclaw.broker.v2" broker/dist/protocol.js` ≥ 1
- [ ] desktop 构建通过

### 5.6 Lint

```bash
npm run lint --prefix desktop
npm run lint --prefix broker
npm run lint --prefix desktop/renderer
```

- [ ] 无**新增**错误
- [ ] 已知既存错误（非本次触及，不计入）：`desktop/src/chat-attachments.ts:105`、`desktop/src/openclaw-upgrade-recovery.ts:235`

### 5.7 Typecheck

```bash
npm run typecheck --prefix broker
npx tsc --noEmit --project desktop/tsconfig.json
```

- [ ] 无新增类型错误
- [ ] Step 8 的类型扩展在各层签名间自洽

---

## 6. Open Items（执行中需就地确认）

1. **Step 3**：`resolveWindowTitle` 的注入方式需与 `ExecutionAdapterOptions` 既有模式对齐（现只有 `callTool` 与 `defaultTimeoutMs`），实现时确认最小改法。若发现必须改动 `broker/server.ts` 的 `windowsMcp` 调用约定，记入 Execution Log（同链路错误路径，属范围维持）。
2. **Step 7**：`getConfiguredModel()` 的 config 注入方式需与 `RuntimeDependencies` 既有模式对齐，实现时确认最小改法。
3. **Step 8**：`extractImages` 的提取时机必须在 `JSON.stringify` 之前从原始对象取（已核实 `server.ts:610` 传的是结构化 `result.data`）。
4. **Step 8**：若 `session.ts:314 extractText` 在无文本块时返回 `malformed-tool-result` 而阻碍截图路径，属范围扩大，走 Plan Adjustment。

---

## 附录 A：修订记录（rev.1 → rev.2）

| 项 | rev.1 | rev.2 | 依据 |
|---|---|---|---|
| 原 Step 4（最小化窗口纳入枚举） | 改 `list-windows.ps1` + `broker/uia.ts` + vendored `service.py` | **整体撤回**，改为回归验证用例 | 实盘反证：`IsWindowVisible` 对最小化窗口返回 true；broker 脚本与 upstream 返回同样 14 个窗口；`switch_app` 成功恢复 |
| 新 Step 3 | — | 缺参可读拒绝 + `focus-window` 的 `processName` 兜底 | 实盘复现 `TypeError` / `ValueError`；约束 B |
| Step 编号 | 9 步 | 重排为 9 步（新增 Step 3，后续顺延） | — |
| vendored Python | Step 4 需改 | **零改动**，并记录 MANIFEST 哈希约束 | 实测：66 个条目全为 `windows_mcp/**/*.py`；改之必报 `HASH_MISMATCH` |
| 内置副本确认 | 未确认加载哪份 | 实测确认加载 `server/windows_mcp/`（`cwd` + `python -m` 的 `sys.path[0]` 机制） | 实盘 `import windows_mcp; print(__file__)` |
