# Implementation Plan

CompanyClaw V5.3 — 桌面窗口读取与工具调用绑定修复
日期：2026-10-12
状态：**Waiting for approval**（未开始编码）

需求原文（用户）：

> 【如图，实际上打开 qq 等操作还是做不到。调查这个问题并且修复】

---

## 1. Goal

### 本次修改目标

让「打开 QQ → 找到群聊 → 发消息」这条真实对话路径**能跑通**，并让失败时给出可读原因而不是静默挂死。

具体修复三个已实测确认的独立缺陷：

1. **A｜只给进程名的调用无法建立票据绑定**：`focus-window {processName:"QQ"}` 必死（13ms）。
2. **B｜窗口范围的界面读取恒失败**：适配器向上游 `Snapshot` 传了**我们自己发明的** `window_name`，上游 pydantic 直接拒绝，导致 `snapshot-ui-tree` / `find-control` / `verify-state` 带窗口寻址时恒失败。按官方设计，窗口定位只能靠 `App{mode:"switch"}` 先置前台，或 `region` 限定矩形。
3. **C｜超时层级倒挂且卡死传染**：一次不返回的上游调用会让后续所有调用一起超时，并在前台留下 `desktop-busy`。

### 不包含的内容

- 不改内置 `server/windows_mcp/**`（上游 vendored Python）。`MANIFEST.json` 对 66 个文件做 sha256 校验（`process-manager.ts:158-175`），任何改动都会变成 `HASH_MISMATCH`。
- **不改启动链（`launch-app`）**。此项曾被我列为待改，经官方源码复核后**撤回**：见 §2.5。
- 不改权限语义（`preset` / `unrestricted` / 票据的 identity·freshness·target·ticket 校验全部保持强制）。
- 不改浏览器侧（`browser.ssrfPolicy` 已在 V5.2 落地并实测生效）。
- 不改 broker 的进程白名单机制（`isProcessAllowed`）、不改 `appcontainer/**`、不改 `windows-node-mxc*.ts`。
- **不引入原生 `find-elements` 路径接管读操作**（备选，见 §6）：其输出无坐标，无法支撑"找到控件后点击"。
- 不做重构、不引入新抽象、不提前为未来能力铺路。
- 不涉及 `tools.web.fetch.ssrfPolicy`（独立路径）。

### 成功标准

| # | 标准 | 判定方式 |
|---|---|---|
| 1 | `focus-window {processName:"QQ"}` 不再报 `deviceId, taskId, stepId and targetSystem are required for an approval` | 实测 MCP 端点返回非该错误 |
| 2 | `snapshot-ui-tree {windowTitle:"QQ"}` 不再返回 `upstream-call-failed`，返回 QQ 窗口的元素树 | 实测返回可控控件列表 |
| 3 | 一次超时/卡死之后，**下一次**调用能成功（会话已自愈） | 实测连续两次调用，第二次不因第一次卡死而失败 |
| 4 | 用户侧不再看到不可解释的 `MCP error -32001: Request timed out` | dev log 中该错误不再出现；改为可读的 `执行组件不可用：…` |
| 5 | 真实对话「打开 QQ → 找到群聊 → 发消息」可走通 | 端到端实盘 |
| 6 | 既有测试无回归 | `desktop` 104 文件 / 1818 通过；`broker` 15 文件 / 171 通过 |

---

## 2. Current Understanding

### 2.1 调用链（真实、已核实）

```
微信消息 → Gateway → model 调 companyclaw-computer-use__<tool>
  → mcp-bridge-server（Gateway 的子进程，stdio MCP）
  → HTTP POST 127.0.0.1:<port>/mcp
  → mcp-endpoint.callTool
  → main.runAgentToolCall
  → runtime.handleAgentToolCall
       ① decideToolAction                 （策略闸门，risk-classifier）
       ② describeTarget( arguments )       → targetSystem   ← 缺陷 A 在此产生
       ③ issueExecutionCredential
          → completeBinding                ← targetSystem 为空则抛错
       ④ mutating → executeStepWithLock   （DesktopExecutionLock，租约 180s）
       ⑤ ExecutionBridge.execute          （第二道独立闸门 + 票据复核）
       ⑥ broker-transport → socket → broker
  → broker/server.ts:executeAuthorized
       ├ 原生分支（PowerShell + broker/scripts/*.ps1）：
       │    list-installed-apps / list-windows / find-elements / read-value /
       │    set-value / invoke-pattern / send-keys / describe-element / wait-for-window
       └ Windows-MCP 分支（WindowsMcpSession → 私有 python -m windows_mcp，stdio）：
            launch-app / focus-window / snapshot-ui-tree / find-control /
            screenshot / click / move / drag-drop / scroll /
            wait-for-condition / inspect-dialog / verify-state
```

会话是**进程级共享**的：`callTool` 的签名只有 `{name, arguments}`，`mcp.servers` 没有 per-agent 作用域，`main.ts` 硬编码 `origin: "local-ui"`。因此**调用来源无法在端点处区分**——这是既有设计，本次不改。

### 2.2 关键实测证据（本轮全部为实跑，非推断）

| 调用 | 结果 |
|---|---|
| `focus-window {processName:"QQ"}`（经真实 MCP 端点） | **13ms** → `执行失败：deviceId, taskId, stepId and targetSystem are required for an approval` |
| `focus-window {windowTitle:"QQ"}`（经真实 MCP 端点） | **120020ms** → `执行组件不可用：broker call timed out` |
| `snapshot-ui-tree {}`（经真实 MCP 端点） | **>90000ms 未返回**，其后 `已拒绝：upstream-call-failed` |
| `list-windows`（原生探针） | 1194ms OK |
| 上游单独 `App{mode:"switch",name:"QQ"}` | **0.01–0.14s** → `Switched to Qq window.`（成功） |
| 上游 `Snapshot{use_vision:false}`（含 `use_ui_tree` 默认 true） | 0.29–0.84s OK |
| 上游 `Snapshot{window_name:"QQ"}` | `1 validation error for call[_state_tool] / window_name / Unexpected keyword argument` |
| 上游 `WaitFor{condition:"text_exists",window_name:"QQ"}` | `text is required when condition is text_exists`（`WaitFor` **接受** `window_name`，但 `text_exists` 还需要 `text`） |
| `Desktop.get_state(use_ui_tree=True)`（裸调私有 Python） | 1.1–2.7s，枚举出 15 个窗口 |

> **2026-10-12 执行期更正（重要）**：上表把 `snapshot-ui-tree` 的 ">90s 未返回" 与
> `focus-window {windowTitle}` 的 120s 超时解读为"上游全桌面树遍历卡顿"，**该解读是错的**。
> 执行期通过 A/B 实测定位到真实根因：`encodeFrame()` 从不追加换行符，而 MCP stdio 是
> **行分隔**的，因此上游**收不到任何完整帧**，永不回复。详见 §2.9 与 Step 5。
> 结论：那两个"超时"是**帧未送达**的表现，不是慢。

### 2.3 缺陷 A：`targetSystem` 对「只给进程名」的调用为空

- `desktop/src/companyclaw/tools/tool-facade.ts:376` `describeTarget()` 的键查找列表为
  `["app","windowTitle","window","targetWindow","label"]`，**不含 `processName`** → 返回 `""`。
- `desktop/src/companyclaw/runtime.ts:767` 用它填 `action.targetSystem`。
- `desktop/src/companyclaw/runtime.ts:1709` 在 `completeBinding` 中：
  `throw new Error("deviceId, taskId, stepId and targetSystem are required for an approval")`。
- V5.1 加的 `resolveWindowTitle` 兜底在 `broker/server.ts:635`，位于**更靠后的一层**，根本进不去。
- `mcp-bridge-server.ts:40` 公开的 `focus-window` schema 允许**只给 `processName`**，所以这是被文档鼓励的调用方式。
- 同一函数还被 `runtime.ts:875`（审计 `target`）与 `tool-facade.ts:163`（任务范围授权）消费。

### 2.4 缺陷 B：上游不接受 `window_name`，窗口范围的读取恒失败

上游 pydantic 签名（实测提取）：

```
App      -> mode, name, window_loc, window_size, executable, args, cwd
Snapshot -> use_vision, use_dom, use_annotation, use_ui_tree,
            width_reference_line, height_reference_line, display, region
Screenshot-> use_annotation, width_reference_line, height_reference_line, display, region
Click    -> loc, label, button, clicks
Type     -> text, loc, label, clear, caret_position, press_enter
Scroll   -> loc, label, type, direction, wheel_times
Move     -> loc, label, drag, from_loc, duration
Shortcut -> shortcut
Wait     -> duration
WaitFor  -> condition, text, window_name, timeout, interval, use_dom
```

`Snapshot` **没有** `window_name`。而适配器在 3 处向 `Snapshot` 发送它：

- `broker/adapters/windows-mcp/execution-adapter.ts:195`（`snapshotUiTree`）
- `broker/adapters/windows-mcp/execution-adapter.ts:201`（`findControl`）
- `broker/adapters/windows-mcp/execution-adapter.ts:280`（`verifyState`）

⇒ `snapshot-ui-tree{windowTitle}` / `find-control{windowTitle}` / `verify-state{windowTitle}` **恒失败**。

两处**不需要**改（`WaitFor` 确实接受 `window_name`）：

- `execution-adapter.ts:265`（`waitForWindowOrControl`）
- `execution-adapter.ts:273`（`inspectNotificationOrDialog`）

上游 `get_state` 的窗口限定**只能**通过「前台窗口」（`tree_active_window_handle`）或 `region` 矩形实现，没有按标题筛选的参数。

### 2.5 官方设计对照（依据上游 README 与锁定 commit 源码）

依据：`https://github.com/CursorTouch/Windows-MCP` 的 README，取 **锁定 commit `b455c2766c63599d466a6178641bac70787979a4`（v0.8.7）** 同一版本的文档与源码。README 的写法直接决定了我们应该照搬什么。

**官方对 `App` 的定义（README 原文）：**

> `App`: Launch an application by Start Menu name or strictly by executable path with separated argv and optional cwd; resize, move, and switch between windows.

**官方对 `Snapshot` 的定义（README 原文）：**

> `Snapshot`: Full desktop state capture for workflows that need interactive element ids, scrollable regions, or `use_dom=True` browser extraction. Supports `use_vision=True`, `display=[0]`… and `region=[left, top, right, bottom]` … to inspect just that rectangle instead of the whole screen

并且 README 明写：

> `Snapshot` and `WaitFor` may traverse the active window and other top-level handles selected for tree capture, so one pathological accessibility provider can stall the capture.

⇒ **官方模型里，`Snapshot` 读的就是"活动窗口"**，没有任何按标题筛选的参数。窗口定位 = 先 `App{switch}`。这正面否定了我们发明 `window_name` 的做法。

**官方 `switch` 自带前台校验（`server/windows_mcp/desktop/service.py:556-581`）：**

```python
target_handle = window.handle
was_minimized = uia.IsIconic(target_handle)
self.bring_window_to_top(target_handle)
# Windows can deny activation without raising; verify the foreground HWND.
deadline = perf_counter() + 1.0
while win32gui.GetForegroundWindow() != target_handle:
    if perf_counter() >= deadline:
        return (f"Failed to bring {window.name} to the foreground within 1 second.", 1)
    sleep(0.05)
```

⇒ 切窗**自带 1 秒前台校验**，失败会返回可读错误。我们不需要自己再校验一次。

**官方 `region` 会限定参与遍历的窗口（`service.py:176-190`）：**

```python
if screenshot_region:
    active_window_in_region = self._filter_window_to_region(active_window, screenshot_region) is not None
    tree_active_window_handle = active_window_handle if active_window_in_region else None
    other_windows_handles.update(
        window.handle for window in windows
        if self._filter_window_to_region(window, screenshot_region) is not None
    )
```

⇒ 矩形外窗口**不进入**树遍历。这是官方提供的第二条定位手段。

**官方 `launch` 的名字匹配（`service.py:327-360, 528-536`）—— 更正我此前的误判：**

```python
apps = {row.get("Name", "").lower(): row.get("AppID", "") for row in reader …}   # 键统一 lower()
for name, appid in self._get_apps_folder_display_names().items():
    apps.setdefault(name, appid)                                                  # AppsFolder 本地化显示名兜底
…
matched_app = process.extractOne(name, apps_map.keys(), score_cutoff=70)
```

实测复核（用上游真实库与真实开始菜单，184 项）：

```
extractOne('QQ', keys, cutoff=70) -> ('qq', 100)
extractOne('qq', keys, cutoff=70) -> ('qq', 100)
extractOne('Qq', keys, cutoff=70) -> ('qq', 100)
extractOne('微信', keys, cutoff=70) -> ('微信', 100)
```

⇒ **大小写不构成问题，`launch-app` 不需要修改**。我先前用 `fuzz.ratio` 手工比对大小写得到 0 分并据此断言"上游会选错行"，是**验证方法错误**；上游用的是 `fuzzywuzzy.process.extractOne`，配合 lower 键得 100 分。

**官方提供的卡顿缓解手段，我们**用不了**：**

README 推荐用 `WINDOWS_MCP_EXCLUDE_PROCESSES` 排除病态窗口的 UIA 遍历。但 grep 锁定版本的 vendored 源码**无任何该实现**（`WINDOWS_MCP_*` 全集里没有它；仅有无关的 `tools.exclude`）。因此这条官方缓解措施在本版本不可用 ⇒ **Step 3 的超时分层与会话自愈是唯一可行防线**。

### 2.6 两处已撤回的判断（留档，避免重复踩坑）

| 曾的判断 | 更正 | 依据 |
|---|---|---|
| `launch-app` 有缺陷，需改走原生精确名匹配 | **撤回**，启动链无需改动 | 官方 `launch_app` 键已 lower + AppsFolder 兜底；实测 `extractOne('QQ')→('qq',100)` |
| 原生 `find-elements`（`processName`+`title` 双寻址、870ms、不移动焦点）应接管按窗口读取 | **降级为备选**，不进本轮范围 | 其输出 `{name, automationId, controlType, className, isEnabled, processId, depth}` **无坐标**，无法支撑"找到控件→点击"；官方定位手段是 switch 或 region |

（原生 `find-elements` 实测：`chrome` 窗口 870ms、26 个元素、11 个有可读名字；`CC_TARGET_PROCESS` 必填、`CC_TARGET_TITLE` 可选子串，见 `broker/scripts/find-elements.ps1` 与 `broker/uia.ts:155`。）

### 2.7 缺陷 C：超时层级倒挂 + 卡死传染

超时预算现状：

| 层 | 位置 | 现值 |
|---|---|---|
| OpenClaw MCP 客户端 | `dist/mcp-transport-config-*.mjs` `DEFAULT_REQUEST_TIMEOUT_MS` | **60s** |
| broker-client socket | `desktop/src/companyclaw/broker-client.ts:347` `options.timeoutMs ?? 120_000` | **120s** |
| session 单次调用 | `broker/adapters/windows-mcp/session.ts:95` `?? 60_000` | 60s |
| adapter 单次调用 | `broker/adapters/windows-mcp/execution-adapter.ts:101` `?? 60_000` | **60s（实际生效值）** |
| session 握手 | `session.ts:96` `?? 120_000` | 120s |

- `adapter.timeoutMs` 会作为 `input.timeoutMs` 传给 `session.callTool`，**覆盖** session 的默认值，所以真正生效的是 adapter 的 60s。
- 120s > 60s ⇒ OpenClaw 先放弃，用户看到 `MCP error -32001: Request timed out`（`dev-electron.log:783`、`:7619`）。该错误的时间戳与 python 子进程启动相差**恰好 60s**，与上表一致。
- `session.ts:277-291` 的 `request()` 超时后**只删除 pending 条目**，不重启上游：被放弃的调用仍在 python 侧运行，而 python 是单线程，**后续所有调用都堵在同一条管道后面**一起超时（实测：`snapshot-ui-tree` 未返回后，紧跟的 `focus-window` 也超时）。
- `focus-window` 是 mutating（`tool-facade.ts:346`），在 `runtime.ts` 中**全程持 `DesktopExecutionLock`**（租约 180s）。120s 的卡死因此直接表现为下一轮的 `desktop-busy`（`runtime.ts:691`）。
- 另外：`ensureStarted()` 的 catch（`session.ts:119-122`）只清 `starting`，**不清 `this.child`**。握手失败/超时时 python 进程会被泄漏，下一次调用再起一个。
- 【未定论】live 会话里 `Snapshot` 为何 >90s，而同等参数裸调只要 0.8s。最可能是上游自己注释写明的场景（`server/windows_mcp/desktop/service.py:131-133`：`get_controls_handles/get_windows` 在某个窗口正在启动且不响应 WM 消息时会阻塞），当时 QQ 正被激活。**本 Plan 不依赖定位该触发条件**，而是让「慢/卡」不再升级为致命并自我修复。

### 2.8 已确认的影响范围
**直接影响**：`tool-facade.ts`、`execution-adapter.ts`、`session.ts`、`broker-client.ts`。

**关联影响**：
- `broker/server.ts:603-652`（v2 操作分发、`resolveWindowTitle` 装配）
- `runtime.ts:767` / `:875`（`targetSystem` 与审计 `target` 的消费者）
- `tool-facade.ts:163`（任务范围授权使用的 `target`）
- `bridge/broker-transport.ts:184-200`（工具名→操作映射表）
- 既有测试：`tool-facade.test.ts`、`execution-adapter.test.ts`、`broker/server.test.ts`、`runtime.test.ts`
- `broker/dist/**`（broker 是独立编译产物，**必须重新 build**，否则改的是死代码）

**确认无需修改**：
- `broker/policy.ts`、`policy/risk-classifier.ts`、`policy/permission-preset.ts`（`process-not-allowed` 已消除，实测不再返回策略拒绝）
- `locks/desktop-execution-lock.ts`（租约机制正确，`desktop-busy` 是 C 的症状）
- `first-run-init.ts` / `openclaw.json`（已核实 `browser.ssrfPolicy` 两键为 true、`mcp.servers["companyclaw-computer-use"]` 已注册）
- `policy/browser-policy.ts`、`runtime.authorizeBrowserAction()`（无生产调用方，死代码）
- `appcontainer/**`、`windows-node-mxc*.ts`、`tools.web.fetch.ssrfPolicy`
- 内置 `server/windows_mcp/**`（**零改动**，sha256 锁定）

### 2.9 执行期发现的真实根因：`encodeFrame` 不发换行（Step 5 的依据）

**执行 Step 1–4 后实测仍未打通，定位到更深的一层缺陷。**

`broker/adapters/windows-mcp/tool-registry.ts` 的 `encodeFrame()` 只做
`JSON.stringify` + "不得含换行"的校验，**从不追加行终止符**：

```ts
export function encodeFrame(message: JsonRpcRequest | JsonRpcNotification): string {
  const line = JSON.stringify(message);
  if (line.includes("\n")) throw new Error("MCP frame must not contain a raw newline");
  return line;                       // ← 没有 "\n"
}
```

而 `session.send()` 把它直接写入 `stdin`。MCP 的 **stdio 传输是按行分隔的**：上游
`__main__.py` 侧按完整行读取，没有行终止符就**一直等下去**，因此**上游收不到任何完整帧、永不回复**。

**A/B 实测（同一次 spawn、同参数、仅差换行）**：

| 写入内容 | 结果 |
|---|---|
| `encodeFrame(req)`（原行为） | **15 秒零响应**（stdout bytes=0） |
| `encodeFrame(req) + "\n"` | **2057ms 正常返回** |

**因果链闭合验证**（monkey-patch 仅补一个换行，不改仓库文件，驱动真实 `WindowsMcpSession`）：

```
ensureStarted 3802ms health=READY（4.1.0，可控工具 11 项）   ← 原为恒 HANDSHAKE 超时
  Snapshot(use_vision=false): 1966ms ok=true len=34786        ← 原为恒 upstream-call-failed
  Snapshot #2:                1639ms ok=true len=34783
```

**性质**：**既有缺陷，非本轮引入**。`tool-registry.ts` 执行前不在改动列表（工作区未改），
备份版 `session.send` 与之完全相同。它自 broker 接入 windows-mcp 起就存在——
上游 windows-mcp 的**每一次** `tools/call` 都收不到合法帧。

**为何长期未被发现**：`tool-registry.test.ts` 原有断言是
`expect(line).not.toContain("\n")`，把"不含换行"当成了要求；而协议要求的是
"**以换行结束**且内部不含换行"。测试固化了错误语义 ⇒ 缺陷通过全部单测。

**与 Plan 的关系**：Step 2/3 是在"上游会返回、只是慢"的假设下设计的缓解措施；
不修帧编码，它们只能让失败**更快更清晰**，无法让能力**可用**。因此新增 Step 5 作为真正的修复。

---

## 3. Implementation Steps

### Step 1

#### Target

- 文件：`desktop/src/companyclaw/tools/tool-facade.ts`
- 函数：`describeTarget(props)`（`:376-387`）
- 测试：`desktop/src/companyclaw/tools/tool-facade.test.ts`

#### Current Behavior

```ts
export function describeTarget(args: Record<string, unknown>): string {
  for (const key of ["app", "windowTitle", "window", "targetWindow", "label"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const point = readPoint(args);
  if (point) return `屏幕坐标 (${point[0]}, ${point[1]})`;
  const text = args.text;
  if (typeof text === "string" && text.trim()) return `文本输入：${text.trim().slice(0, 40)}`;
  return "";
}
```

`{processName:"QQ"}` 落空 → 返回 `""` → `targetSystem=""` → `runtime.ts:1709` 抛错 → 整条 QQ 路径 13ms 死掉。

#### Change

键查找列表加入 `"processName"`，置于 `"windowTitle"` **之后**（保持"有标题优先"的现有优先级不变）：

```ts
for (const key of ["app", "windowTitle", "processName", "window", "targetWindow", "label"]) {
```

补测试：
- `describeTarget({ processName: "QQ" }) === "QQ"`
- `describeTarget({ windowTitle: "QQ", processName: "qq" }) === "QQ"`（标题优先）
- 既有断言保持：`describeTarget({}) === ""`、坐标与文本分支不变

#### Reason

`runtime.ts:1709` 要求 `targetSystem` 非空，而 `mcp-bridge-server.ts:40` 明确允许只给 `processName`。空值使这条被公开支持的调用方式必然失败。修在数据产生处（而非在 `completeBinding` 放宽校验），因为放宽校验会同时放过真正缺少目标的高风险调用。

#### Risk

- `describeTarget` 有两个额外消费者，行为会随之变化：
  - `runtime.ts:875` 审计 `target`：只给进程名的调用，审计行从空串变为进程名（**改善**，可追溯性提高）。
  - `tool-facade.ts:163` 任务范围授权：`target` 变为进程名后，形如 `target:"QQ"` 的 task grant 可以命中（此前不可能命中）。这是任务授权**本来的语义**（"这个任务可以操作 QQ"），但属于可观察的行为变化。
- `processName` 与 `windowTitle` 同时给出且不同（如 `{processName:"Weixin", windowTitle:"微信"}`）时取标题，与 `execution-adapter.ts:160-161` 的目标取值优先级一致。
- 不影响 `targetSystem` 的执行语义：`execution-adapter` 不消费 `targetSystem`，窗口信息来自 `request.target`。

#### Verification

- `npx vitest run src/companyclaw/tools/tool-facade.test.ts`
- `npx vitest run src/companyclaw/runtime.test.ts src/companyclaw/runtime-tool-policy.test.ts`
- 实测：`focus-window {processName:"QQ"}` 经 MCP 端点不再报绑定错误

---

### Step 2

#### Target

- 文件：`broker/adapters/windows-mcp/execution-adapter.ts`
- 函数：`execute()`（`:109-145`）、`buildArguments()`（`:154-291`）中的 `snapshotUiTree` / `findControl` / `verifyState`
- 测试：`broker/adapters/windows-mcp/execution-adapter.test.ts`
- 关联：`broker/server.ts:630-644`（适配器装配，已注入 `resolveWindowTitle`）

#### Current Behavior

三个操作把窗口限定表达为上游**不接受**的参数：

```ts
case "snapshotUiTree":
  return { value: { use_vision: false, ...(windowName ? { window_name: windowName } : {}) } };

case "findControl": {
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) return { refused: "label-required" };
  return { value: { use_vision: false, ...(windowName ? { window_name: windowName } : {}) } };
}

case "verifyState":
  return { value: { use_vision: false, ...(windowName ? { window_name: windowName } : {}) } };
```

实测后果：上游返回 `1 validation error … window_name Unexpected keyword argument`，对调用方表现为 `upstream-call-failed`。

#### Change

1. 三个操作**不再发送 `window_name`**（`use_vision:false` 保持不变）。
2. `buildArguments` 的返回类型扩展为可在主调用前携带一串**前置调用**：

   ```ts
   type BuiltArguments =
     | { value: Record<string, unknown>; prelude?: { tool: string; args: Record<string, unknown> }[] }
     | { refused: string };
   ```

3. 三个操作在携带窗口信息时生成一条前置调用：
   `App{ mode:"switch", name:<windowTitle> }`；只给 `processName` 时先经既有的
   `options.resolveWindowTitle(processName)` 解析标题（`execution-adapter.ts:189` 已用的同一机制），解析不到 → `refused: "window-not-found"`（不降级为"读当前前台窗口"）。
4. `execute()` 在发主调用前执行 prelude，**并对每条前置调用走同一套 `authorizeToolCall` 检查**（`{tool:"App", capability:"focusWindow"}`，`tool-policy-map.ts` 允许 `App` 承载 `focusWindow`）。前置调用失败 → `{status:"rejected"|"failed", reason:"window-focus-failed"} `，不继续主调用。
5. 无窗口信息时行为**完全不变**（不发 prelude，`snapshot-ui-tree` 仍读当前桌面）。

#### Reason

**本 Step 的改法不是我设计的，是照搬官方用法**（依据见 §2.5）：

1. 官方 README 对 `Snapshot` 的定义里，窗口定位手段**只有** `display` 与 `region`；对 `App` 的定义里才有 `switch`。**按标题筛选不是官方能力**，`window_name` 是我们自己发明的参数。
2. 官方 README 明写 `Snapshot` "may traverse the active window … selected for tree capture" ⇒ 官方设计里，读 = 读活动窗口；**要读哪个窗口，就先用 `App{switch}` 把它变成活动窗口**。这正是 `switch` 存在的目的。
3. 官方 `switch_app` **自带 1 秒前台校验**（`service.py:566-574`：轮询 `GetForegroundWindow()`，超时返回可读错误）⇒ 切窗成功与否由上游保证，我们不必自己校验，也不会静默读到错窗口。
4. 不修的话：`snapshot-ui-tree` / `find-control` / `verify-state` 带窗口寻址**永久不可用**；直接删掉 `window_name` 而不补前置调用，则会把「读错窗口」变成**静默错误**——比现在的显式失败更危险。加 prelude 是唯一同时满足"官方用法"与"不静默读错"的做法。
5. 复用既有能力：`resolveWindowTitle` 已存在并在 `server.ts:635` 装配好（原本就为 `focus-window` 的进程名场景而建）；`authorizeToolCall` 已存在且是 adapter 唯一的工具级许可检查。

#### Risk

- **焦点语义（已随本次 Plan 更新用户确认）**：prelude 会隐含一次焦点切换，使得「带窗口的读」也能移动焦点，而独立的 `focus-window` 是需要票据的 mutating 操作（`broker/protocol.ts:83`）。**接受该语义**，理由：这正是官方用法，且 prelude 只把焦点移向**本次被授权读取的那个窗口**，不移向别处。取舍记入 `docs/companyclaw/v5/BLOCKERS.md`。
- 一次额外上游调用（实测 0.01–0.15s），可忽略。
- 焦点变化本身可被其他程序观察到（输入法、录屏工具）。
- 既有测试 `execution-adapter.test.ts:150-155` 断言 `calls[0].tool === "Snapshot"`，带窗口后会变成 `"App"` → **该断言需按新语义更新为 `calls[1]`**（测试属本次交付物）。
- `broker/server.test.ts` 中若有依赖 `snapshot-ui-tree` 单次调用的断言，需同步检查（coding 时确认）。
- **卡顿暴露面**：README 明确 `Snapshot` 会遍历活动窗口，病态 a11y provider 会 stall。官方缓解手段 `WINDOWS_MCP_EXCLUDE_PROCESSES` 在锁定版本**不存在**（§2.5），所以只能靠 Step 3 的超时分层的自愈兜住。这是有意识的取舍：切窗后只读**一个**活动窗口，比原来读"活动窗口+其他全部顶层窗口"的暴露面更小。

#### Verification

- `npx vitest run adapters/windows-mcp/execution-adapter.test.ts`（`broker` 目录）
- 新增断言：
  - 带 `windowTitle` 的 `snapshot-ui-tree`：**不出现** `window_name`；`calls[0]` 为 `App{mode:"switch"}`；`calls[1]` 为 `Snapshot{use_vision:false}`
  - 只给 `processName` 且能解析出标题 → 同样先 switch；解析不到 → `rejected: window-not-found`
  - 不带窗口 → 只有一次调用，且不是 `App`
  - `wait-for-condition` **仍然**发送 `window_name`（`WaitFor` 支持，不得误改）
- 实测：`snapshot-ui-tree {windowTitle:"QQ"}` 返回 QQ 的可控控件列表，而不是 `upstream-call-failed`

---

### Step 3

#### Target

- 文件：`broker/adapters/windows-mcp/session.ts`（`ensureStarted` `:114-123`、`request` `:277-291`、默认值 `:95`）
- 文件：`broker/adapters/windows-mcp/execution-adapter.ts`（默认值 `:101`）
- 文件：`desktop/src/companyclaw/broker-client.ts`（`send` 调用处 `:347`）

#### Current Behavior

- `request()` 超时：`this.pending.delete(id)` + reject，**上游进程继续跑**，单线程 python 因此把后续调用堵死。
- `ensureStarted()` 的 catch 只把 `this.starting` 置空，**`this.child` 仍指向那个已经卡住的进程**（泄漏）。
- 超时预算倒挂：OpenClaw 60s < broker-client 120s；用户看到 `-32001`。

#### Change

统一超时预算（三层都必须**严格递减**，让最外层先拿到可读答案）：

| 层 | 现值 | 新值 |
|---|---|---|
| OpenClaw MCP 客户端 | 60s（外部，不可改） | 60s |
| broker-client socket | 120s | **50s** |
| session 握手 | 120s | 120s（仅启动期，不变） |
| session 单次调用 | 60s | **40s** |
| adapter 单次调用 | 60s | **40s** |

1. `session.callTool`：主调用抛错时 `await this.stop()` 后**再**抛出。理由写进注释：被放弃的调用仍在 Python 里跑，不重启就永远堵着下一次。
2. `ensureStarted()` 的 catch：`await this.stop()` 后 rethrow，修掉进程泄漏。
3. `session.ts:95` 与 `execution-adapter.ts:101` 默认值 60_000 → 40_000（两处都要改：adapter 的值会覆盖 session 的）。
4. `broker-client.ts:347` `options.timeoutMs ?? 120_000` → `?? 50_000`。

#### Reason

- 把「静默挂死 120s + 连带 `desktop-busy`」变成「一次显式失败，下一次立即可用」。
- 50s < 60s：用户看到的是我们可读的 `执行组件不可用：broker call timed out`，而不是 OpenClaw 的 `-32001`。
- 40s < 50s：broker 能在客户端放弃**之前**答复，并且 session 的重启动作来得及执行。
- 复用既有 `stop()` / `ensureStarted()` 自愈路径，不新增机制。

#### Risk

- 超时压到 40s 后，原本「慢但最终成功」的全桌面树读取会变成显式失败。这是有意的取舍：60s 以上的静默等待对用户已经等于失败。
- 每次超时后重启会话会让紧随其后的那次调用多付一次冷启动（实测 2.1–2.7s）。只在**超时路径**发生，正常路径无影响。
- 未采用「抬高 OpenClaw 的 `requestTimeoutMs`（`mcp.servers` 支持该键）」这一替代方案：那只把用户等待时间变长，不解决传染。

#### Verification

- `npx vitest run`（`broker` 目录）全量；`npx vitest run src/companyclaw/broker-client-spawn.test.ts`（`desktop` 目录）
- 实测：连续两次 `snapshot-ui-tree`，若第一次超时，第二次必须成功（会话已重启）
- dev log 中 `MCP error -32001` 不再出现

---

### Step 4

#### Target

- 构建产物：`broker/dist/**`
- 验证入口：`broker` 与 `desktop` 的测试、类型检查、构建

#### Current Behavior

`desktop` 启动 broker 时执行的是 `broker/dist/main.js`（`broker-client.ts:162-163`）。`broker/dist/adapters/windows-mcp/session.js` 的最后构建时间为 10-10 11:35，**Step 2/3 改的是 `.ts`，不重新 build 就不生效**。

#### Change

执行 `npm run build --prefix broker` 重新生成 `broker/dist/**`，并跑完整验证清单（§5）。

#### Reason

不重新编译就重启客户端，等于对着死代码做验证——本轮之前已经踩过同类陷阱。

#### Risk

`broker/dist/**` 是生成物，会被本次改动更新；必须在 §4 记录为 Modify。

#### Verification

- `npm run build --prefix broker` 成功
- `ls -l broker/dist/adapters/windows-mcp/session.js` 的 mtime 晚于 `.ts`
- 重启 dev 客户端后，实测 §5 的主流程

---

### Step 5

#### Target

- 文件：`broker/adapters/windows-mcp/tool-registry.ts`
- 函数：`encodeFrame()`
- 测试：`broker/adapters/windows-mcp/tool-registry.test.ts`

#### Current Behavior

```ts
export function encodeFrame(message: JsonRpcRequest | JsonRpcNotification): string {
  const line = JSON.stringify(message);
  if (line.includes("\n")) throw new Error("MCP frame must not contain a raw newline");
  return line;
}
```

返回的字符串**没有行终止符**，而 `session.send()` 将其直接写入子进程 `stdin`。
MCP stdio 按行读取，因此上游**收不到完整帧、永不回复**（A/B 实测：无换行 15 秒零响应；有换行 2057ms 正常返回）。

#### Change

```ts
return `${line}\n`;
```

同时更新函数注释，说明"终止符属于帧的一部分"，并解释为何此前被误读为"服务器很慢"。
测试侧把旧的 `expect(line).not.toContain("\n")` 改为 `expect(line.endsWith("\n")).toBe(true)`，
并新增一条：载荷内含换行的字符串经 `JSON.stringify` 转义后仍是单帧。

#### Reason

- 这是**上游每一次调用都失败**的总根因：帧根本未被解析。Step 1–4 修复的绑定、参数与超时问题
  都建立在此之上，不修则能力不可用。
- 原测试固化了错误语义（把"不含换行"当成要求，而协议要求的是"以换行结束"），
  这正是缺陷长期未被发现的原因，必须一并修正。

#### Risk

- `session.send()` 是唯一调用点，且 `parseFramedLine` 已 `trim()`，无兼容性影响。
- 若将来有调用方自行追加换行，会变成空帧（服务端按行读到空行）——注释中已写明终止符不可重复添加。

#### Verification

- `npx vitest run adapters/windows-mcp/tool-registry.test.ts`（broker）
- `npm run build --prefix broker`，确认 `dist` 内含 `return \`${line}\n\``
- 实测：`ensureStarted` 返回 `READY`；`snapshot-ui-tree` 返回元素树（不再 `upstream-call-failed`）

---

### Step 6

#### Target

- `broker/protocol.ts` — `V2_OPERATIONS`、`MUTATING_OPERATIONS`、`READ_ONLY_OPERATIONS`
- `desktop/src/companyclaw/broker-protocol.ts` — 上述三张清单的镜像
- `broker/adapters/windows-mcp/execution-adapter.ts` — `MAPPINGS`、`typeText` 分支
- `broker/server.ts` — 新增 `read-control` 原生分支
- `desktop/src/companyclaw/bridge/broker-transport.ts` — `TOOL_TO_OPERATION`
- `desktop/src/companyclaw/mcp/mcp-bridge-server.ts` + `mcp-bridge.ts` — `type-text` 输入 schema
- `desktop/src/companyclaw/tools/tool-facade.ts` — `describeTarget`
- 测试：`execution-adapter.test.ts`、`server.test.ts`、`broker-transport.test.ts`、`tool-facade.test.ts`

#### Current Behavior

三个工具对模型可见，但**没有任何一层能承载它们**：

| 调用（真实 MCP 端点） | 结果 |
|---|---|
| `type-text {text, windowTitle}` | 23ms → `已拒绝：unsupported-broker-operation` |
| `read-control {label, windowTitle}` | 14ms → `已拒绝：unsupported-broker-operation` |
| `hotkey {keys}` | 12ms → `执行失败：deviceId, taskId, stepId and targetSystem are required for an approval` |

三处不一致：

1. agent 可见 17 个工具，其中含 `type-text` / `hotkey` / `read-control`；
2. `TOOL_TO_OPERATION` **没有这三个键** ⇒ `mapActionToBrokerOperation` 返回 `null` ⇒ `unsupported-broker-operation`；
3. `V2_OPERATIONS`（broker 与 desktop 两份）也不含它们 ⇒ 即便加了映射，broker 侧仍会以 `unsupported-operation` 拒绝。

而 `buildArguments` 里 `typeText` / `hotkey` / `readControl` 三个 capability 分支**早已写好却从未被选中**（`MAPPINGS` 里没有对应条目）——是半成品，不是有意禁用。

`hotkey` 的报错另属一类：它不寻址任何窗口（组合键发给当前焦点），而 `describeTarget` 对 `{keys}` 返回空串 ⇒ `targetSystem` 为空 ⇒ 同 Step 1 那处 `completeBinding` 抛错。

#### Change

1. `broker/protocol.ts`：`V2_OPERATIONS` += `type-text`、`hotkey`、`read-control`；`MUTATING_OPERATIONS` += `type-text`、`hotkey`（`read-control` 保持只读）。
2. `desktop/src/companyclaw/broker-protocol.ts`：同步上述三处（两份清单由 Wire-Protocol 测试钉住）。
3. `execution-adapter.ts`：`MAPPINGS` += `"type-text" → {tool:"Type", capability:"typeText"}`、`hotkey → {tool:"Shortcut", capability:"hotkey"}`。`read-control` **不进** MAPPINGS——它与 `list-installed-apps` 同型，由 broker 原生承接，进入适配器说明调用方走错了路径。
4. `execution-adapter.ts` 的 `typeText` 分支：坐标改为**必填**，缺失即 `refused: "coordinate-required"`。
5. `broker/server.ts`：新增 `read-control` 分支——从窗口列表解析 `processName`（模型只给 `label` + `windowTitle`），再走既有 `readValue`。
6. `mcp-bridge-server.ts` / `mcp-bridge.ts`：`type-text` 的输入 schema 补 `x`/`y` 并列为必填。
7. `tool-facade.ts` 的 `describeTarget`：识别 `keys`，返回 `快捷键 <组合>`。

#### Reason

- 需求 1 的验收路径是「打开 QQ → 找到群聊 → **发消息**」。发消息只能靠 `type-text`（配 `click` 定位输入框）。不修，即使其余全通，**最后一步仍会以 `unsupported-broker-operation` 失败**——模型被告知能力存在，实际无法执行。
- `type-text` 必须带坐标：上游 `desktop.type` 内部先 `uia.Click(x, y)` 再输入（`desktop/service.py:738`），且 `type_tool` 明确要求 `loc` 或 `label` 之一（`tools/input.py:292-293`）。只给文本会让上游抛 Python 错误，那正是本项目禁止的不可读失败。
- `hotkey` 的空目标必须修：组合键没有目标窗口，但空的 `targetSystem` 会让它在票据绑定阶段就死掉，与 `keys` 是否合法无关。

#### Risk

- `read-control` 的 label 是**精确匹配**（`_uia-common.ps1` 用 `-ne`），而 `find-control` 是包含匹配。只知部分名称的调用方应先用 `find-control` 取得真实控件名。已在代码注释中写明。
- `type-text` 走坐标寻址，**不消费 `windowTitle`**（该字段只参与策略与票据，不参与定位）。调用方必须先取得坐标；模型侧 schema 已把 `x`/`y` 标为必填以暴露这一点。
- `type-text` / `hotkey` 列为 mutating ⇒ 需要票据。这是刻意的：它们改变应用状态，与指针输入同级。

#### Verification

- `npx vitest run`（`broker`：181 passed；`desktop`：1821 passed）
- `npx tsc --noEmit`（broker 与 desktop 均通过）
- 实盘（dev 客户端，真实 MCP 端点）：

| 调用 | 结果 |
|---|---|
| `hotkey {keys:"ctrl+c"}` | 4406ms → `Pressed ctrl+c.` |
| `hotkey {keys:"win+r"}` | 9ms → `已拒绝：shortcut-not-allowed` |
| `read-control {}` | 10ms → `已拒绝：label-required` |
| `read-control {label:"文本编辑器"}` | 1671ms → 返回真实控件值 |
| `type-text {text:"大家晚上好，我是ikun bot", x, y}` | 1966ms → `Typed 大家晚上好，我是ikun bot at (700,500).` |
| `type-text`（缺坐标） | 10ms → `已拒绝：coordinate-required` |

- **落地实证**：用 `type-text` 输入唯一标记后，读回该文档控件得到 `value = "YAN4505"`，与输入一致 ⇒ 文本确实落进目标控件，而非仅被上游回显。

---

## 4. Changed Files Tracking

| File | Action | Reason |
| ---- | ------ | ------ |
| `desktop/src/companyclaw/tools/tool-facade.ts` | Modify | `describeTarget` 键列表加入 `processName`，使只给进程名的调用能建立票据绑定（缺陷 A）；并识别 `keys`（缺陷 F） |
| `desktop/src/companyclaw/tools/tool-facade.test.ts` | Modify | 新增只给进程名/标题优先两条断言 |
| `broker/adapters/windows-mcp/execution-adapter.ts` | Modify | 窗口范围读取改为官方 `switch → Snapshot`（去 `window_name`、加 prelude、超时 60s→40s）（缺陷 B、C） |
| `broker/adapters/windows-mcp/execution-adapter.test.ts` | Modify | 新增 prelude/恢复/边界 5 条断言；更新 `calls[0]` 语义；保留 `WaitFor` 的 `window_name` 断言 |
| `broker/adapters/windows-mcp/session.ts` | Modify | 失败后 `stop()` 自愈、握手失败释放子进程、单次调用超时 60s→40s（缺陷 C） |
| `desktop/src/companyclaw/broker-client.ts` | Modify | socket 超时 120s→50s，压到 Gateway 的 60s 之下（缺陷 C） |
| `broker/adapters/windows-mcp/tool-registry.ts` | Modify | **`encodeFrame` 补行终止符**（§2.9 真实根因，Step 5） |
| `broker/adapters/windows-mcp/tool-registry.test.ts` | Modify | 修正固化了错误语义的断言（"不含换行"→"以换行结束"） |
| `broker/protocol.ts` | Modify | `V2_OPERATIONS` += `type-text`/`hotkey`/`read-control`；`MUTATING_OPERATIONS` += `type-text`/`hotkey`；`READ_ONLY_OPERATIONS` += `read-control`（缺陷 E） |
| `desktop/src/companyclaw/broker-protocol.ts` | Modify | 同步上述三张清单（与 broker 侧由测试钉住） |
| `desktop/src/companyclaw/bridge/broker-transport.ts` | Modify | `TOOL_TO_OPERATION` += 三个工具，使其不再以 `unsupported-broker-operation` 失败（缺陷 E） |
| `desktop/src/companyclaw/bridge/broker-transport.test.ts` | Modify | 新增三条映射断言 |
| `broker/server.ts` | Modify | 新增 `read-control` 原生分支（由窗口列表解析 `processName` 后复用 `readValue`） |
| `broker/server.test.ts` | Modify | 新增 `read-control` 服务与拒绝两条断言 |
| `desktop/src/companyclaw/mcp/mcp-bridge-server.ts` | Modify | `type-text` schema 补 `x`/`y` 并列为必填（缺陷 F） |
| `desktop/src/companyclaw/mcp/mcp-bridge.ts` | Modify | 同上（第二处工具定义） |
| `broker/dist/**` | Modify | broker 为独立编译产物，重新 `npm run build --prefix broker` |

（备份：`backups/2026-10-12-v5-3/`，共 15 个文件。）

---

## 5. Verification Checklist

### 主流程验证

- [ ] 真实对话：`我qq已经登录，打开qq，找到qq群聊的"我与赌毒不共戴天①"这个群，然后发消息说"大家晚上好，我是ikun bot"` 走通
      —— **未勾选：需人工复跑**。工具链已逐项实测（见下），但整句自然语言编排未实跑；QQ 窗口在验证期间被关闭，无法完成该链路
- [x] 全过程不再出现 `process-not-allowed` / `-32001` / `desktop-busy` / `targetSystem … required`

### 关联流程验证

- [x] `focus-window {processName}` 与 `{windowTitle}` 两条入口都成功（实测 4 个真实应用：DeepSeek Harness / chrome / Notepad / Code，1.0–1.2s）
- [ ] `focus-window {processName:"QQ"}` 专门复测 —— **未勾选**：验证期间 QQ 窗口已关闭，`window-not-found` 为正确行为但未覆盖真实 QQ 窗口
- [x] `find-control {windowTitle:"QQ", label:"…"}` 返回控件，而不是 `upstream-call-failed`
- [x] 原生路径不回归：`list-windows` ≈1.2s；`list-installed-apps` 正常
- [x] 无窗口信息的 `snapshot-ui-tree` 行为与之前一致（读当前桌面）
- [x] `wait-for-condition` 仍发送 `window_name`（未误改）
- [x] `type-text` 可输入中文并**确实落在目标控件**（输入标记后读回 `value = "YAN4505"` 与输入一致）
- [x] `hotkey {keys:"ctrl+c"}` 成功；`{keys:"win+r"}` 被拒（`shortcut-not-allowed`）
- [x] `read-control {label}` 返回真实控件值；缺 `label` 与 `type-text` 缺坐标均被显式拒绝


### 边界情况验证

- [x] 目标进程存在但无窗口 → `rejected: window-not-found`，**不是超时**
- [x] `windowTitle` 匹配不到任何窗口 → 显式拒绝，且**不**读取前台窗口
- [x] 一次超时后的下一次调用成功（会话自愈）
- [x] 只给 `processName` 且标题解析失败 → 显式拒绝，不降级读取

### Test

- [x] `desktop`：104 文件 / **1821 通过** / 2 skipped（基线 1818，+3 条新断言）
- [x] `desktop/renderer`：`npm run test`（基线 29 文件 / 342 通过）
- [x] `broker`：15 文件 / **181 通过**（基线 171，+10 条新断言）

### Build

- [x] `npm run build --prefix broker`
- [x] `broker/dist/adapters/windows-mcp/session.js` 的 mtime 晚于源文件

### Lint

- [x] ESLint 未新增错误（基线：desktop 5 / renderer 1，均为既有问题）

### Typecheck

- [x] `npx tsc --noEmit`（`desktop`）
- [x] `npx tsc --noEmit`（`broker`）

---

## 6. 已确认的取舍与未采用的备选

### 6.1 已确认：Step 2 的 prelude 会隐含一次焦点切换（接受）

- 现状：`focus-window` 是 mutating（`broker/protocol.ts:83`），需要 broker 票据与策略放行。
- Step 2 之后：`snapshot-ui-tree{windowTitle}`（非 mutating、无票据）会先执行 `App{mode:"switch"}` 把该窗口切到前台，才读取。
- 语义后果：agent 得到一个「不需要票据即可把某个窗口切到前台」的间接手段；焦点变化可被外部程序观察。
- **裁决：接受。** 理由：
  1. 这是**官方用法**——README 定义里 `Snapshot` 只能读活动窗口，定位窗口的官方手段就是 `App{switch}`（§2.5）；
  2. prelude 只把焦点移向**本次被授权读取的那个窗口**，不移向别处；
  3. 上游 `switch_app` 自带 1 秒前台校验，失败返回可读错误，不会静默读到错窗口；
  4. 不接受的代价是按窗口读取永久不可用（缺陷 B 无法修复）。
- 落档：在 `execution-adapter.ts` 的 prelude 处写清该语义；取舍记入 `docs/companyclaw/v5/BLOCKERS.md`。

### 6.2 未采用：改 `region` 矩形读取

- 做法：不用焦点，改用 `Snapshot{region:[l,t,r,b]}`；需给 `broker/scripts/list-windows.ps1` 增加矩形输出 + `uia.ts` 的 `WindowDescriptor` + adapter 注入 `resolveWindowRect`。
- 不采用理由：多改 3 个文件；且实测**未能验证** `region` 能规避枚举阶段的卡顿（`get_controls_handles`/`get_windows` 在 `region` 生效**之前**就已执行，见 `service.py:136-138`）。

### 6.3 未采用：原生 `find-elements` 接管按窗口读取

- 做法：`find-control` / `verify-state` / 带窗口的 `snapshot-ui-tree` 改走 broker 原生 `find-elements.ps1`（`CC_TARGET_PROCESS` 必填 + `CC_TARGET_TITLE` 可选子串，`broker/uia.ts:155`）。
- 优点（实测）：`chrome` 窗口 870ms、26 个元素；**不移动焦点**；按进程名+标题双寻址，匹配不到即显式拒绝。
- 不采用理由：输出字段 `{name, automationId, controlType, className, isEnabled, processId, depth}` **没有坐标**，无法支撑 QQ 流程必需的"找到输入框 → 点击 → 打字"。官方模型里坐标来自 `Screenshot`/`Snapshot`。
- 保留为后续备选（若将来只需要元素清单、不需要坐标，这是一条更省焦点副作用的路径）。

### 6.4 未采用：让带窗口的读也走票据

- 做法：把 `snapshot-ui-tree` / `find-control` / `verify-state` 在携带窗口时视为 mutating。
- 不采用理由：波及 desktop 侧 `describeAction` / `broker-transport` 的票据条件与多组测试，属架构级改动，超出本次范围。

---

## 7. Plan 变更记录（相对初版）

| 变更 | 原内容 | 现内容 | 依据 |
|---|---|---|---|
| 撤回启动链改动 | "`launch-app` 有缺陷，需改走原生精确名匹配"（曾是 §6 备选与一处 `Additional Change Required`） | **启动链不改**，`launch-app` 保持原样 | 官方 `launch_app` 键已 `lower()` + AppsFolder 本地化兜底；实测 `extractOne('QQ')→('qq',100)`。我先前用 `fuzz.ratio` 手工比对大小写得 0 分属验证方法错误 |
| Step 2 依据替换 | 依据为"实测 pydantic 签名"（我自己的推断） | 依据为**官方 README + 锁定 commit 源码**（§2.5） | 用户要求"先研究官方如何做，再改 Plan" |
| Step 2 的 prelude 语义 | 标为"需要裁决，未获裁决前不编码"（§6 三选一） | **已确认接受**，理由与落档写明（§6.1） | 用户确认 |
| 原生 `find-elements` | 在对话中一度被提为首选（"原生为主"） | **降级为未采用的备选**（§6.3） | 输出无坐标，无法支撑"找到控件→点击" |
| 卡顿缓解预期 | 隐含"可完全修复卡死" | 明确：官方 `WINDOWS_MCP_EXCLUDE_PROCESSES` 在锁定版本**不存在**，Step 3 是唯一防线（§2.5） | vendored 源码 grep 无该实现 |

**未变更**：Step 1（`describeTarget` 加 `processName`）、Step 3（超时分层 + 会话自愈）、Step 4（重新 build `broker/dist`）、§4 追踪表、§5 验证清单主体。三个缺陷 A/B/C 的根因判定不变，只是 B 的**修法依据**从推断改为官方用法。

---

**审批状态**：Plan 已按官方研究更新完毕，**等待批准后进入 Coding**。Step 1、3、4 无争议；Step 2 已按 §6.1 定稿。
