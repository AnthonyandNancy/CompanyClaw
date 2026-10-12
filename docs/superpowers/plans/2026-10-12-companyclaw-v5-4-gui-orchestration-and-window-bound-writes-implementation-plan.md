# Implementation Plan

CompanyClaw V5.4 — 多步 GUI 场景编排契约与写操作窗口绑定
日期：2026-10-12
状态：**Waiting for approval**（未开始编码）

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:executing-plans 逐步执行本计划。步骤使用 `- [ ]` 复选框跟踪。

需求原文（用户）：

> 【1.对于需要复杂的场景，做不到细化，比如 qq 不在前台，让 bot"打开 qq，找到 qq 群聊的"我与赌毒不共戴天①"这个群，然后发消息说"大家晚上好，我是 ikun bot""，这时候 bot 不会去搜索 qq 群聊再去找，而且当前聊天窗就输入了，也没有发送。对于这个场景查看官方 mcp 的细化场景是如何做的，我们的 bot 需要怎么配合；】

**Goal:** 让"打开应用 → 定位目标界面 → 输入 → 提交"这条多步 GUI 路径可被模型自主编排并从错误窗口中解绑。

**Architecture:** 两处改动，无新机制：(1) broker 适配器给 `click` / `scroll` / `type-text` 补上读操作早已存在的 `App{mode:"switch"}` 窗口前置，使"读会切窗、写不切窗"这一不一致消失；(2) 把编排契约写进模型**唯一能读到**的字段（`tool.description` 与 JSON Schema 字段 `description`），因为实测确认 OpenClaw 不消费 MCP `initialize.instructions`。

**Tech Stack:** TypeScript（Electron 主进程 + 独立编译的 broker）、Vitest 4、MCP over stdio/streamable-http、Windows-MCP 0.8.7（vendored，pin 在 commit `b455c276`）。

## Global Constraints

以下约束逐条来自需求书与既有实现，每一步都隐含包含：

- 禁止修改 `desktop/resources/companyclaw-broker/server/windows_mcp/**`（vendored Python）。`MANIFEST.json` 对 66 个文件做 sha256 校验（`broker/adapters/windows-mcp/process-manager.ts:158-175`），任何改动都会变成 `HASH_MISMATCH`。
- 权限语义不变：`preset` / `unrestricted` / 票据的 identity·freshness·target·ticket 四项校验全部保持强制（`broker/policy.ts:81-137` `authorize()`，含 `TARGET_REQUIRED` :59-67、进程白名单 :101-109、窗口标题过滤 :110-121、mutation 闸门 :123-137）。
- 不新增工具、不新增 broker operation、不新增 capability。`AGENT_TOOLS`、`BROKER_CAPABILITIES`、`V2_OPERATIONS`、`TOOL_TO_OPERATION` 四张表**全部不动**。
- 不重构、不为未来能力抽象。代码改动的风格必须与同文件既有写法一致（现有三处读操作已使用 `...(prelude.length ? { prelude } : {})` 内联展开，新增三处照抄）。
- 工具 `description` 上限 1024 字符（OpenClaw `dist/daemon-BJYIjnke.mjs:2827` `NODE_MCP_DESCRIPTION_MAX_CHARS`，`:2892` 处 `truncateUtf16Safe`）。当前每条 20–40 汉字，改后须 < 300 字符。
- 中文文案，面向员工读者。
- 关闭 `use_vision` 的读路径不得改变。

---

## 1. Goal

### 本次修改目标

修复用户报告的三个症状，并让"细化场景"的编排契约进入模型可见通道。

| 症状（用户原话） | 归因（已实测确认） | 本次处理 |
|---|---|---|
| "当前聊天窗就输入了" | `type-text` 拿到 `windowTitle` 却不切前台，坐标落到当前前台窗口 | Step 1 |
| "不会去搜索群聊再去找"（不细化） | 编排说明放在 `initialize.instructions` 里，而 OpenClaw 不读该字段；`tool.description` 里没有"第一步做什么/接着做什么" | Step 2、Step 3 |
| "也没有发送" | `pressEnter` 字段存在且映射正确，但描述里没有任何"提交/发送"语义提示 | Step 2、Step 3 |

### 不包含的内容

- **不给 `hotkey` 加窗口前置**：快捷键送到"当前焦点"，`App{switch}` 会改写焦点语义，`alt+tab` 会被自己破坏。见 §2.7。
- **不给 `launch-app` 加窗口前置**：上游 `app(mode="launch")` 内部已做 UIA 存在性等待（`desktop/service.py:488-503`，最多 10s + 正则兜底）。加 prelude 会是重复且语义更弱的等待。
- **不改 `wait-for-condition` / `inspect-dialog` 的 `window_name` 传递**：上游 `WaitFor` 确实有此参数（`tools/input.py:467`），且它们是读操作，不应抢焦点。
- **不引入官方 `label` 寻址**（`Click`/`Type` 的 `label` 参数）：需要进程内 `interactive_nodes[label]` 连续快照，而本产品 `snapshot-ui-tree` 强制 `use_vision:false`（`execution-adapter.ts:265`），标注图不生成；坐标路径已可用。记为备选，见 §6。
- **不实现窗口内容指纹复核**：`tool-policy-map.ts:144-148`（`Click` 的 `reason`）与两处模型可见的 `click` 描述（`computer-use-tools.ts:118`、`mcp-bridge-server.ts:55`）都声称"执行前复核窗口未变化"，实现层无此逻辑。本版改为让模型可见的**文案与实现一致**（用"窗口变化后坐标失效，必须重读"表述），不新增指纹机制。记录为已知缺口，见 §6。注意 `tool-policy-map.ts` 的 `reason` 是给评审者看的元数据、不进模型上下文，因此本次**不改该文件**。
- 不改 `browser.ssrfPolicy`、`appcontainer/**`、`windows-node-mxc*.ts`、`tools.web.fetch.ssrfPolicy`。
- 不删除 `buildInitializeResult()` 里当前无效的 `instructions` 字段（删除属无关改动）。
- 不改 `WINDOWS_MCP_MAX_TREE_ELEMENTS`、`WINDOWS_MCP_SCREENSHOT_SCALE` 等环境变量与启动参数。

### 成功标准

| # | 标准 | 判定方式 |
|---|---|---|
| 1 | 带 `windowTitle` 的 `click` / `scroll` / `type-text` 会先把该窗口切到前台，再执行原动作 | 单元测试断言调用序列为 `App{switch}` → `Click`/`Type`/`Scroll`；实机对比落点 |
| 2 | 不带 `windowTitle` / `processName` 的同类调用，**调用序列与今天完全一致**（单次调用，无 prelude） | 单元测试断言 `calls.length === 1` |
| 3 | 目标窗口无法切到前台时不发出主调用 | 单元测试：`calls` 只有 `["App"]`，返回 `window-focus-failed` |
| 4 | `hotkey` 带 target 时**不**产生 prelude | 单元测试：`calls[0].tool === "Shortcut"` |
| 5 | `click` 无坐标仍先报 `coordinate-required`（prelude 不抢占参数校验） | 单元测试：失败时 `calls.length === 0` |
| 6 | 模型可见文本里出现"第一步读取""pressEnter 提交""窗口变化后坐标失效"三类编排语义 | 单元测试断言 `describeTools()` 输出；实机 `tools/list` 抓取 |
| 7 | HTTP 与 stdio 两份工具清单文案一致 | 单元测试逐条比对两个文件的工具名与描述文本 |
| 8 | 真实对话「打开 QQ → 找到群聊 → 发消息」走通 | 端到端实盘（需 QQ 已登录且有可见窗口） |
| 9 | 既有测试无回归 | `broker` 181 passed；`desktop` 1821 passed / 2 skipped |
| 10 | 类型检查与构建干净 | `tsc --noEmit`（desktop、broker）、`npm run build --prefix broker` |

---

## 2. Current Understanding

### 2.1 调用链（已核实）

```
模型 → MCP tools/call
  → mcp-endpoint.ts:55（loopback 127.0.0.1 + X-CompanyClaw-Token）
  → main.ts:1849 runAgentToolCall
  → runtime.handleAgentToolCall → ToolFacade（validateToolCall → 策略判定）
  → bridge/broker-transport.ts:186 createBrokerTransport → TOOL_TO_OPERATION 闭集
  → broker.call（unix socket，50s socket 超时）
  → broker/server.ts:626 executeComputerUse
  → WindowsMcpExecutionAdapter.execute（execution-adapter.ts:136）
  → MAPPINGS:82 → buildArguments:218
  → [可选 prelude] → windows-mcp stdio（行分隔 JSON-RPC）→ Tool
```

两份工具清单：

- **现网路径**：`mcp-endpoint.ts` + `mcp-bridge.ts`（HTTP，`describeTools()` 取自 `AGENT_TOOLS`）。
- **备用路径**：`mcp-bridge-server.ts`（stdio，自带 `TOOL_DEFINITIONS` 常量，与前者手工同源）。

### 2.2 模型能读到什么（本次最关键的事实）

| 通道 | 是否到达模型 | 证据 |
|---|---|---|
| `initialize.instructions` | **否** | `grep getInstructions` 在 openclaw 全部 `dist/*.mjs` 中无调用点；只有 SDK 自带的 `worker/worker.mjs` 里 `getInstructions(){return this._instructions}` 定义 |
| `tools/list` → `tool.description` | **是**，上限 1024 字符 | `daemon-BJYIjnke.mjs:2892` `truncateUtf16Safe(sanitizeMcpMetadataText(tool.description), NODE_MCP_DESCRIPTION_MAX_CHARS)` |
| `tools/list` → `inputSchema.properties.*.description` | **是** | `daemon-BJYIjnke.mjs:2874-2894` `normalizeInputSchema(tool.inputSchema)` 原样透传为 `parameters` |

因此"编排契约"必须写在 `description` 里——这正是官方 Windows-MCP 的做法：`tools/snapshot.py:26` 结尾 `Always call this first to understand the current desktop state before taking actions.`；`tools/input.py:238` `Provide either loc or label.`；`tools/input.py:271` `Set press_enter=True to submit after typing.`；`tools/input.py:451` `avoid repeated Snapshot calls`。

### 2.3 写操作与读操作的前置不一致（症状 1 的根因）

`execution-adapter.ts` 中 `focusPrelude()`（:217-225）只在三处被调用：

| 分支 | 行 | 是否切前台 |
|---|---|---|
| `snapshotUiTree` | :258 | **是** |
| `findControl` | :268 | **是** |
| `verifyState` | :351 | **是** |
| `click` | :279 | 否 |
| `scroll` | :285 | 否 |
| `typeText` | :297 | 否 |
| `hotkey` | :315 | 否（**故意**，见 §2.7） |

`click` / `scroll` / `typeText` 三个分支**完全不读** `raw.windowTitle` 或 `target`。

### 2.4 `windowTitle` 的完整去向（改动可行的前提）

`mcp-bridge.ts:134-145` 的 `type-text` schema 声明 `windowTitle`（:140）；`main.ts:1892 targetFor()` 从 `args.windowTitle` 取 target；`broker-transport.ts:241` 通过 `targetFor` 写入 `BrokerTransportCall.target`；`broker/server.ts:626` 转成 `adapter.execute({ target })`。**整条链已存在**，只有 adapter 最后一跳丢弃它。`click` / `scroll` 的 schema 同样声明了 `windowTitle`（`mcp-bridge.ts:129` / `:157`）。

### 2.5 `coordinate` 语义与真实能力边界

- 上游 `Snapshot` 输出 `interactive_elements` 与 `semantic_tree` 两类文本，二者都渲染 `(x,y)` 中心坐标（`tree/views.py:81`、`:134`、`:253`）。
- 产品侧 `snapshot-ui-tree` 只发 `{ use_vision: false }`，上游据此在响应里给出 UI Tree 文本（`tools/_snapshot_helpers.py:230-235`）。
- `brain 里已实测`：`snapshot-ui-tree` 返回 34786 bytes / 1966ms。
- 因此"读坐标 → 点击/输入"闭环**已经成立**，缺的只是写操作的窗口绑定与编排提示。

### 2.6 `pressEnter` 的真实语义

`mcp-bridge.ts:142` `pressEnter` → `main.ts:1897` 透传 → `execution-adapter.ts:310`（`press_enter`）→ `desktop/service.py:757` `uia.SendKeys("{Enter}")`。映射正确，但描述中无"提交/发送"提示，模型不会主动用它。

### 2.7 为什么 `hotkey` 必须排除在外

`ALLOWED_SHORTCUTS`（`execution-adapter.ts:103-116`）含 `alt+tab`、`ctrl+f`、`enter`、`escape`、`tab`。快捷键的语义是"送给当前拥有焦点的控件"；若在发送前 `App{switch}`，会改变焦点目标本身，`alt+tab` 尤其会成为自我破坏。`ctrl+f`（应用内搜索）+ `type-text{pressEnter}` 已足以完成"搜索群聊"。

### 2.8 已确认的影响范围

- **代码改动**：1 个文件（adapter），3 个分支。
- **文案改动**：3 个文件（`computer-use-tools.ts`、`mcp-bridge.ts`、`mcp-bridge-server.ts`）。
- **测试改动**：2 个文件。
- **不改**：`broker/policy.ts` 的 `TARGET_REQUIRED`（`click`/`scroll`/`type-text` 不在其中，无 target 调用仍可到达）；`TOOL_TO_OPERATION`（三个 op 的映射已在 V5.3 补齐）；`describeTarget`（已有 windowTitle/processName/坐标/文本/keys 五个分支）。

### 2.9 与需求文档的一致性核对

需求书 `docs/companyclaw/v5/08-v1-v4-requirement-map.md:14` 记录 `F07 一条任务混合 Web/桌面/Office`，实现落在 `task-orchestrator.ts`，状态"未改语义"。本次改动**不触碰** `task-orchestrator.ts`：F07 要求的是"同一 taskId 内多步链路"，而该链路已由 `main.ts:1862 runtime.createTask()` 每次调用建立 task 而存在；本次修的是"模型是否知道该怎么分步"，属提示层次，与 F07 的实现层不冲突。**未发现需求文档与本次改动相矛盾之处。**

### 2.10 官方 MCP 的"细化场景"是怎么做的

需求原文要求"查看官方 mcp 的细化场景是如何做的"。逐条核对 vendored 上游源码后结论如下：

| 官方手段 | 上游位置 | 原文 | 对应我们的缺口 |
|---|---|---|---|
| **工具级排序契约**（不写脚本） | `tools/snapshot.py:26` | `Always call this first to understand the current desktop state before taking actions.` | 我们的 `snapshot-ui-tree` 描述里没有"第一步"语义 → Step 2 |
| **提交语义写在参数描述里** | `tools/input.py:271` | `Set press_enter=True to submit after typing.` | 我们的 `pressEnter` 无任何"提交/发送"提示 → Step 2、Step 3 |
| **寻址方式二选一，明说** | `tools/input.py:238` | `Provide either loc or label.` | 我们只暴露坐标，需明说坐标来源 → Step 2 |
| **用等待代替轮询** | `tools/input.py:451` | `polling the Windows accessibility tree inside the tool to avoid repeated Snapshot calls` | 我们的 `wait-for-condition` 描述未说明此用途 → Step 2 |
| **每个工具声明自己的副作用等级** | 各工具 `ToolAnnotations(readOnlyHint=…, destructiveHint=…)` | — | 我们已有 `mutating` 字段（`computer-use-tools.ts:62`），无需改 |
| **服务器级 `instructions`** | `__main__.py:66` | 仅一句："Windows MCP server provides tools to interact directly with the Windows desktop…" | **连官方也只写一句话**，真正细化全在工具描述里。我们把它当成编排入口是误判 |

**结论**：官方的"细化"不是应用脚本（没有"如何搜索 QQ 群"这种内容），而是**把操作顺序与参数语义写进每个工具的 description**——因为那是客户端唯一会转发给模型的字段。我们的 bot 需要配合的正是这一点：把"读 → 定位 → 动作 → 提交"的顺序契约写进描述，把窗口绑定做在适配器里。这也解释了为什么把编排说明放进 `initialize.instructions` 从未生效（§2.2）。

---

## 3. Implementation Steps

### Step 1: 给写操作补窗口前置

#### Target

- 文件：`broker/adapters/windows-mcp/execution-adapter.ts`
- 模块：`WindowsMcpExecutionAdapter.buildArguments()`（:208）内的 `case "click"`（:279）、`case "scroll"`（:285）、`case "typeText"`（:297）
- 测试：`broker/adapters/windows-mcp/execution-adapter.test.ts` 的 `describe("pointer and keyboard input")`
- **不改** `focusPrelude()`（:217）本身，不改 `case "hotkey"`（:315），不改 `case "launchApp"`（:233）

**Files:**
- Modify: `broker/adapters/windows-mcp/execution-adapter.ts:279-313`（`case "click"` / `case "scroll"` / `case "typeText"`）
- Test: `broker/adapters/windows-mcp/execution-adapter.test.ts:233-320`（`describe("pointer and keyboard input")`）

**Interfaces:**
- Consumes: `focusPrelude()`（同文件 :217-225，已存在，签名 `() => Promise<PreludeCall[] | { refused: string }>`）；`PreludeCall`（:57-61）；prelude 执行与授权路径（:150-172，已存在）；`buildArguments`（:208，这些分支都位于其 `switch (capability)` 内）。
- Produces: 无。三个分支的 `AdapterResult` 契约不变（`{status:"ok"|"rejected"|"failed"}`）。

#### Current Behavior

```ts
case "click": {
  const coordinate = readCoordinate(raw);
  if (!coordinate) return { refused: "coordinate-required" };
  return { value: { loc: coordinate, clicks: readClicks(raw) } };
}

case "scroll": {
  const coordinate = readCoordinate(raw) ?? undefined;
  return {
    value: {
      ...(coordinate ? { loc: coordinate } : {}),
      type: raw.type === "horizontal" ? "horizontal" : "vertical",
      direction: readDirection(raw),
      wheel_times: readWheelTimes(raw),
    },
  };
}

case "typeText": {
  const text = typeof raw.text === "string" ? raw.text : "";
  if (text.length === 0) return { refused: "text-required" };
  const coordinate = readCoordinate(raw);
  if (!coordinate) return { refused: "coordinate-required" };
  return {
    value: {
      text,
      loc: coordinate,
      clear: raw.clear === true,
      press_enter: raw.pressEnter === true,
    },
  };
}
```

三个分支只读坐标，**完全不引用** `windowName` / `processName` / `target`，因此动作落在当前前台窗口。

#### Change

- [x] **Step 1.1: 写失败的测试**

在 `execution-adapter.test.ts` 的 `describe("pointer and keyboard input")` 内追加：

```ts
  it("brings a named window forward before clicking, typing or scrolling", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);

    const clicked = await adapter.execute({
      operation: "click",
      target: { windowTitle: "QQ" },
      args: { x: 10, y: 20 },
    });
    expect(clicked.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Click"]);
    expect(calls[0].args).toEqual({ mode: "switch", name: "QQ" });

    calls.length = 0;
    const typed = await adapter.execute({
      operation: "type-text",
      target: { windowTitle: "QQ" },
      args: { text: "大家晚上好", x: 100, y: 200, pressEnter: true },
    });
    expect(typed.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Type"]);
    expect(calls[1].args).toMatchObject({ text: "大家晚上好", press_enter: true });

    calls.length = 0;
    const scrolled = await adapter.execute({
      operation: "scroll",
      target: { windowTitle: "QQ" },
      args: { direction: "down" },
    });
    expect(scrolled.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Scroll"]);
  });

  it("resolves a process name to a title before a write, the way a read does", async () => {
    // `makeAdapter` above has no window resolver, so the process-name path needs
    // its own call log: the title has to come from `resolveWindowTitle`, exactly
    // as `focus-window` and the reads already do it.
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ tool: input.tool, args: input.args });
        return { ok: true as const, content: {} };
      },
      resolveWindowTitle: async (processName) =>
        processName.toLowerCase() === "notepad" ? "无标题 - 记事本" : null,
    });
    const ok = await adapter.execute({
      operation: "type-text",
      target: { processName: "notepad" },
      args: { text: "hi", x: 1, y: 2 },
    });
    expect(ok.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Type"]);
    expect(calls[0].args).toEqual({ mode: "switch", name: "无标题 - 记事本" });

    // A process with no window is a refusal, never a write against whatever is
    // in front.
    calls.length = 0;
    const missing = await adapter.execute({
      operation: "click",
      target: { processName: "not-running" },
      args: { x: 1, y: 2 },
    });
    expect(missing).toEqual({ status: "rejected", reason: "window-not-found" });
    expect(calls).toHaveLength(0);
  });

  it("leaves a targetless write as a single call, exactly as before", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "click", args: { x: 10, y: 20 } });
    await adapter.execute({ operation: "type-text", args: { text: "hi", x: 1, y: 2 } });
    await adapter.execute({ operation: "scroll", args: {} });
    // No window was named, so there is nothing to switch to. Adding one would
    // change today's behaviour for every plain coordinate call.
    expect(calls.map((call) => call.tool)).toEqual(["Click", "Type", "Scroll"]);
  });

  it("validates arguments before touching the window", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const noCoordinate = await adapter.execute({
      operation: "click",
      target: { windowTitle: "QQ" },
      args: {},
    });
    expect(noCoordinate).toEqual({ status: "rejected", reason: "coordinate-required" });
    const noText = await adapter.execute({
      operation: "type-text",
      target: { windowTitle: "QQ" },
      args: { text: "" },
    });
    expect(noText).toEqual({ status: "rejected", reason: "text-required" });
    // A refusal must not have moved the user's foreground window first.
    expect(calls).toHaveLength(0);
  });

  it("does not act when the named window cannot be brought forward", async () => {
    const calls: { tool: string }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ tool: input.tool });
        return input.tool === "App"
          ? { ok: false as const, reason: "Failed to bring 记事本 to the foreground within 1 second." }
          : { ok: true as const, content: {} };
      },
    });
    const result = await adapter.execute({
      operation: "type-text",
      target: { windowTitle: "记事本" },
      args: { text: "hi", x: 1, y: 2 },
    });
    // Typing into whichever window happens to be in front is the failure the
    // caller must never be shown as success.
    expect(result).toEqual({ status: "rejected", reason: "window-focus-failed" });
    expect(calls.map((call) => call.tool)).toEqual(["App"]);
  });

  it("keeps a shortcut pointed at whatever holds focus", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({
      operation: "hotkey",
      target: { windowTitle: "QQ" },
      args: { keys: "ctrl+f" },
    });
    expect(result.status).toBe("ok");
    // alt+tab through a focus-changing prelude would defeat itself, so no
    // shortcut may be preceded by a window switch.
    expect(calls.map((call) => call.tool)).toEqual(["Shortcut"]);
  });
```

- [x] **Step 1.2: 运行测试确认失败**

Run: `cd broker && npx vitest run adapters/windows-mcp/execution-adapter.test.ts`

Expected: 4 个新用例失败（`expect(calls.map(...)).toEqual(["App", "Click"])` 实收 `["Click"]`；`window-focus-failed` 用例实收 `{status:"ok"}`；`hotkey` 用例通过）；其余既有用例（基线 34 个）全部通过。

- [x] **Step 1.3: 写最小实现**

把 `execution-adapter.ts` 的三个分支改为：

```ts
      case "click": {
        const coordinate = readCoordinate(raw);
        if (!coordinate) return { refused: "coordinate-required" };
        // A pointer action on a named window has to happen *in* that window. The
        // reads already bring it forward; leaving the writes out meant a click
        // landed on whatever happened to be in front.
        const prelude = await focusPrelude();
        if (!Array.isArray(prelude)) return prelude;
        return {
          value: { loc: coordinate, clicks: readClicks(raw) },
          ...(prelude.length ? { prelude } : {}),
        };
      }

      case "scroll": {
        const coordinate = readCoordinate(raw) ?? undefined;
        const prelude = await focusPrelude();
        if (!Array.isArray(prelude)) return prelude;
        return {
          value: {
            ...(coordinate ? { loc: coordinate } : {}),
            type: raw.type === "horizontal" ? "horizontal" : "vertical",
            direction: readDirection(raw),
            wheel_times: readWheelTimes(raw),
          },
          ...(prelude.length ? { prelude } : {}),
        };
      }

      case "typeText": {
        const text = typeof raw.text === "string" ? raw.text : "";
        if (text.length === 0) return { refused: "text-required" };
        const coordinate = readCoordinate(raw);
        // The upstream tool clicks the location first and types there, so a
        // request without one raises inside Python. Refusing here keeps that a
        // readable reason, exactly as the click path does.
        if (!coordinate) return { refused: "coordinate-required" };
        // Same reasoning as `click`: text addressed to a coordinate is only
        // correct if the window that coordinate came from is the one in front.
        const prelude = await focusPrelude();
        if (!Array.isArray(prelude)) return prelude;
        return {
          value: {
            text,
            loc: coordinate,
            clear: raw.clear === true,
            press_enter: raw.pressEnter === true,
          },
          ...(prelude.length ? { prelude } : {}),
        };
      }
```

关键顺序约束：**参数校验必须在 `focusPrelude()` 之前**。`focusPrelude()` 会通过 `resolveWindowTitle` 查询窗口列表，并在成功时改变前台窗口——对一个注定要被拒绝的调用（无坐标 / 无文本）先抢焦点是错误行为，测试 Step 1.1 的 `validates arguments before touching the window` 用例钉住这一点。

不做的事：不改 `focusPrelude()` 本身；不给 `hotkey` 加 prelude；不给 `launch-app` 加 prelude；不引入新的 helper（现有读分支已是内联展开，保持一致）。

- [x] **Step 1.4: 运行测试确认通过**

Run: `cd broker && npx vitest run adapters/windows-mcp/execution-adapter.test.ts`

Expected: 全部通过（基线 34 个用例 + 新增 6 个 = 40）。

- [x] **Step 1.5: 运行 broker 全量测试**

Run: `cd broker && npx vitest run`

Expected: 181 + 6 = 187 passed，0 failed（基线实测 15 文件 / 181 通过 / 22.48s）。

#### Reason

1. 消除"读会切窗、写不切窗"的不一致——这是"当前聊天窗就输入了"的直接原因。
2. 兑现三处已声明的能力：`tool-policy-map.ts:144-148`（`Click` 条目 `reason: "坐标点击须绑定截图、窗口与时效，动作前复核窗口未变"`）、`computer-use-tools.ts:117-121`、`mcp-bridge-server.ts:55`。当前实现层没有任何窗口校验，文案与实现不符。
3. 失败时给出 `window-focus-failed` 而非静默点到别的窗口——"点到错误窗口"是本需求明确要避免的失败模式（`execution-adapter.ts:17-20` 文件头注释："a pointer action must carry a target that the caller already verified"）。

#### Risk

| 风险 | 评估 |
|---|---|
| 改变既有行为 | 仅当调用**显式给了** `windowTitle` 或 `processName` 时才多一次 prelude；无 target 的调用序列逐调用一致（Step 1.1 第二个用例钉住） |
| 坐标与切窗后的窗口不匹配 | 真实存在：prelude 移动前台窗口，若模型给的坐标来自"切换前"的读取会偏。缓解：Step 2/3 的描述强制"先读后动"顺序；且模型走正常路径时读操作本身已经切过一次窗，第二次 switch 是幂等的（上游 `switch_app` 对已是前台的窗口直接返回成功） |
| `alt+tab` 类快捷键被破坏 | 已排除（`hotkey` 不加 prelude，Step 1.1 第五个用例钉住） |
| prelude 授权失败 | 不可达风险：prelude 走 `authorizeToolCall({tool:"App", capability:"focusWindow"})`，与 `focus-window` 完全同路；`focus-window` 已在 V5.3 实测通过 |
| 新增的可见失败 `window-focus-failed` | 这是期望行为（优于点错窗口），但需记入 BLOCKERS，避免被误读为新缺陷 |

#### Verification

- `cd broker && npx vitest run adapters/windows-mcp/execution-adapter.test.ts` → 40 passed
- `cd broker && npx vitest run` → 187 passed
- `cd broker && npx tsc --noEmit` → 无输出
- `npm run build --prefix broker` → 成功（adapter 在 broker 编译域）
- 实机：`click {x, y, windowTitle:"<非前台窗口>"}` 后该窗口成为前台且落点正确

---

### Step 2: 把编排契约写进 `AGENT_TOOLS` 描述

#### Target

- 文件：`desktop/src/companyclaw/tools/computer-use-tools.ts`
- 模块：`AGENT_TOOLS` 中四条定义——`snapshot-ui-tree`（:99）、`click`（:117）、`type-text`（:123）、`wait-for-condition`（:153）
- 测试：`desktop/src/companyclaw/mcp/mcp-bridge.test.ts`
- **不改**其余 15 条工具定义，不改 `capability` / `mutating` 字段，不改数组顺序

**Files:**
- Modify: `desktop/src/companyclaw/tools/computer-use-tools.ts:97-166`（`snapshot-ui-tree` :99、`click` :117、`type-text` :123、`wait-for-condition` :153）
- Test: `desktop/src/companyclaw/mcp/mcp-bridge.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: 无结构变更。`AGENT_TOOLS[].description` 是 `mcp-bridge.ts:196` `describeTools()` 与 `ipc.ts:509` `companyclaw:tools:list` 的数据源，文案改动自动传到两处。

#### Current Behavior

四条描述的当前文本：

| 工具 | 当前描述 |
|---|---|
| `snapshot-ui-tree` | `读取目标窗口的界面元素树（按钮、输入框、列表等），用于定位可操作控件。` |
| `click` | `在指定坐标点击。坐标必须来自最近一次界面读取，执行前会复核窗口未变化。` |
| `type-text` | `向已聚焦的输入控件输入文本，支持中文与中英混输。` |
| `wait-for-condition` | `等待文本、窗口或控件出现，带时间上限，不会无限等待。` |

**两处文案与实现不符**（本次一并修正为可实现的一致表述）：

1. `click` 的"执行前会复核窗口未变化"——实现层无此校验（Step 1 只补了窗口前置，没补指纹）。
2. `type-text` 的"向已聚焦的输入控件"——实现是 `uia.Click(x, y)` 后输入（`desktop/service.py:738`），不是"已聚焦控件"。

#### Change

- [x] **Step 2.1: 写失败的测试**

在 `desktop/src/companyclaw/mcp/mcp-bridge.test.ts` 内追加（放在现有 `describes a launch as name-only and a click as coordinate-bound` 用例之后）：

```ts
  it("tells the model to read first and how a write reaches a named window", () => {
    const byName = new Map(describeTools().map((tool) => [tool.name, tool]));

    // The model never sees `initialize.instructions` — OpenClaw only forwards
    // each tool's own description — so the ordering contract has to live here.
    expect(byName.get("snapshot-ui-tree")!.description).toContain("第一步");
    expect(byName.get("click")!.description).toContain("重读");
    expect(byName.get("click")!.description).toContain("前台");
    expect(byName.get("type-text")!.description).toContain("前台");
    expect(byName.get("wait-for-condition")!.description).toContain("代替反复读取");
  });

  it("says that pressEnter submits, which is how a message is actually sent", () => {
    const typeText = describeTools().find((tool) => tool.name === "type-text")!;
    expect(typeText.description).toContain("提交");
    const properties = (typeText.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(properties.pressEnter.description).toContain("回车提交");
  });

  it("keeps every description under the client's per-tool limit", () => {
    // OpenClaw truncates tool descriptions at 1024 characters
    // (`NODE_MCP_DESCRIPTION_MAX_CHARS`), and a truncated contract is a
    // half-read one.
    for (const tool of describeTools()) {
      expect(tool.description.length).toBeLessThan(300);
    }
  });
```

- [x] **Step 2.2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/mcp/mcp-bridge.test.ts`

Expected: 前两个用例失败（缺"第一步"/"重读"/"前台"/"代替反复读取"/"提交"）；第三个用例通过。

- [x] **Step 2.3: 写最小实现**

在 `computer-use-tools.ts` 中替换四条 `description`：

```ts
  {
    name: "snapshot-ui-tree",
    description:
      "读取目标窗口的界面元素树（按钮、输入框、列表等），返回可点击控件的坐标。任何桌面操作的第一步；" +
      "先读再用它给出的坐标点击或输入。窗口变化后旧坐标失效，必须重新读取。",
    capability: "snapshotUiTree",
    mutating: false,
  },
```

```ts
  {
    name: "click",
    description:
      "在指定坐标点击。坐标必须来自最近一次界面读取；窗口变化后失效，必须重读。" +
      "带 windowTitle 时会先把该窗口切到前台再点击，不会点到别的窗口。",
    capability: "click",
    mutating: true,
  },
```

```ts
  {
    name: "type-text",
    description:
      "向指定坐标的输入框输入文本，支持中文与中英混输。带 windowTitle 时会先把该窗口切到前台。" +
      "pressEnter 为 true 时输入后按回车提交，用于发送消息或在应用内确认搜索。",
    capability: "typeText",
    mutating: true,
  },
```

```ts
  {
    name: "wait-for-condition",
    description:
      "等待文本、窗口或控件出现，带时间上限，不会无限等待。" +
      "用于等应用启动或界面切换完成，代替反复读取。",
    capability: "waitForWindowOrControl",
    mutating: false,
  },
```

不做的事：不改这四条以外的任何描述；不改 `capability` / `mutating`；不新增或删除工具；不重排 `AGENT_TOOLS` 顺序（`describeTools()` 与 `loadedAgentToolNames()` 依赖它）。

`computer-use-tools.ts:66-72` 的模块注释说明描述是"写给中文员工读者，且每条都说明它**不做**什么"——本次改动保持这一风格：新增语句同样以"边界"形式表述（"不会点到别的窗口"、"必须重读"）。

- [x] **Step 2.4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/mcp/mcp-bridge.test.ts`

Expected: 全部通过（含既有 `expect(click.description).toContain("界面读取")`，新文本仍含该词）。

#### Reason

1. 这是**唯一**能到达模型的通道（§2.2 实测）。当前编排说明放在 `instructions` 里，模型看不到，因此"不会去搜索群聊再去找"。
2. 官方 Windows-MCP 的做法就是如此（`snapshot.py:26`、`input.py:271`、`input.py:451`），需求原文要求"查看官方 mcp 的细化场景是如何做的"。
3. 直接解决症状 3（"没有发送"）：`pressEnter` 的语义此前完全未提示。
4. 修正两处与实现不符的文案（"复核窗口未变化"、"已聚焦的输入控件"），使描述成为可信契约。

#### Risk

| 风险 | 评估 |
|---|---|
| 描述过长被截断 | 上限 1024；改后最长约 100 字符。Step 2.1 第三个用例以 300 为界钉住 |
| 与既有测试断言冲突 | `mcp-bridge.test.ts:74/76` 断言 `launch.description` 含"不接受路径"、`click.description` 含"界面读取"——两者均保留 |
| 描述改变模型行为导致更多工具调用 | 这是目标；代价是每步多一次读取，可接受 |
| 文案与实际能力不符再犯 | 已按实现校对："先切前台再点击"对应 Step 1；未提及窗口指纹 |

#### Verification

- `cd desktop && npx vitest run src/companyclaw/mcp/mcp-bridge.test.ts` → 全部通过
- `cd desktop && npx vitest run src/companyclaw/tools/tool-facade.test.ts` → 无回归
- 实机：对 `http://127.0.0.1:<port>/mcp` 发 `tools/list`，抓取 `snapshot-ui-tree` / `click` / `type-text` / `wait-for-condition` 的描述文本核对

---

### Step 3: 同步 schema 字段描述与 stdio 备用清单

#### Target

- 文件：`desktop/src/companyclaw/mcp/mcp-bridge.ts`（`toolInputSchema` :80-177）与 `desktop/src/companyclaw/mcp/mcp-bridge-server.ts`（`TOOL_DEFINITIONS` :34-97）
- 模块：JSON Schema 的字段级 `description`；两个文件的工具级 `description` 文本同源
- 测试：`desktop/src/companyclaw/mcp/mcp-bridge.test.ts`
- **不改** schema 的形状、`required` 数组、`additionalProperties`

**Files:**
- Modify: `desktop/src/companyclaw/mcp/mcp-bridge.ts:80-177`（`toolInputSchema`；`windowTitle` 出现在 :113 / :118 / :123 / :129 / :140 / :157 / :172 / :176，`pressEnter` 在 :142，`coordinate` 常量在 :88-93）
- Modify: `desktop/src/companyclaw/mcp/mcp-bridge-server.ts:34-97`（`TOOL_DEFINITIONS`）
- Test: `desktop/src/companyclaw/mcp/mcp-bridge.test.ts`

**Interfaces:**
- Consumes: `toolInputSchema(definition)` （`mcp-bridge.ts:80`，已存在）；`object()` / `stringType` / `coordinate` 三个局部构造器（:86-96）。
- Produces: `describeTools()` 的 `inputSchema.properties.*.description` 内容。schema 形状与 `required` 数组**不变**。

#### Current Behavior

- `mcp-bridge.ts`：`windowTitle` 在 10 处写作裸 `stringType`（无描述）；`pressEnter` 描述为 `"输入后是否回车提交"`（无"发送"语义）；`coordinate` 描述为 `"屏幕坐标 [x, y]，必须来自最近一次界面读取"`。
- `mcp-bridge-server.ts`：`TOOL_DEFINITIONS` 中所有 `windowTitle` 均为裸 `{ type: "string" }`，工具描述与 `computer-use-tools.ts` 手工同源。

#### Change

- [x] **Step 3.1: 写失败的测试**

在 `desktop/src/companyclaw/mcp/mcp-bridge.test.ts` 追加：

```ts
  it("describes the window field on every tool that can address one", () => {
    const byName = new Map(describeTools().map((tool) => [tool.name, tool]));
    for (const name of ["snapshot-ui-tree", "click", "type-text", "scroll", "verify-state"]) {
      const properties = (byName.get(name)!.inputSchema as {
        properties: Record<string, { description?: string }>;
      }).properties;
      expect(properties.windowTitle.description).toBeTruthy();
    }
  });
```

- [x] **Step 3.2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/mcp/mcp-bridge.test.ts`

Expected: 新用例失败（`windowTitle.description` 为 `undefined`）。

- [x] **Step 3.3: 写最小实现 — `mcp-bridge.ts`**

在 `toolInputSchema` 的局部类型常量区（`:89-96`，紧邻 `stringType` / `coordinate`）加入两个新常量：

```ts
  /**
   * A window the call addresses.
   *
   * Two variants because the two families behave differently: a read or write
   * that the adapter focuses first, and one that only uses the title to pick
   * which window to look at (`WaitFor` / `inspect-dialog`, whose upstream
   * parameter is `window_name`). Saying "will be focused" about the second
   * family would be false.
   */
  const focusedWindow = {
    type: "string",
    description: "目标窗口标题；带该参数时会先把此窗口切到前台再执行",
  };
  const addressedWindow = {
    type: "string",
    description: "目标窗口标题（用于定位要读取的窗口，不会切换前台）",
  };
```

替换调用点：

| 位置 | 工具 | 改为 |
|---|---|---|
| :113 | `snapshot-ui-tree` / `verify-state` | `object({ windowTitle: focusedWindow })` |
| :118 | `find-control` | `windowTitle: focusedWindow` |
| :123 | `read-control` | `windowTitle: addressedWindow` |
| :129 | `click` | `windowTitle: focusedWindow` |
| :140 | `type-text` | `windowTitle: focusedWindow` |
| :157 | `scroll` | `windowTitle: focusedWindow` |
| :172 | `wait-for-condition` | `windowTitle: addressedWindow` |
| :176 | `inspect-dialog` | `object({ windowTitle: addressedWindow })` |

`type-text` 的 `pressEnter` 描述改为：

```ts
          pressEnter: { type: "boolean", description: "输入后是否回车提交（发送消息、确认搜索用 true）" },
```

`coordinate` 常量描述改为：

```ts
    description: "屏幕坐标 [x, y]，必须来自最近一次界面读取；窗口变化后失效，需重新读取",
```

- [x] **Step 3.4: 写最小实现 — `mcp-bridge-server.ts`**

把 `TOOL_DEFINITIONS` 中与上表对应的 `windowTitle: { type: "string" }` 替换为对应的 `focusedWindow` / `addressedWindow` 同文文本（该文件无局部常量，直接内联对象字面量）；`type-text` 的描述与 `pressEnter` / `windowTitle` 字段文本同步为 `mcp-bridge.ts` 的版本。

**注意**：`mcp-bridge-server.ts` 的 `TOOL_DEFINITIONS` 是 `{ name, description, inputSchema }` 三元组数组，`tool()` 构造器的第 3 参数是 `properties` 对象、第 4 参数是 `required`。只改字符串，不动 `required`。

- [x] **Step 3.5: 写同步测试**

在 `desktop/src/companyclaw/mcp/mcp-bridge.test.ts` 追加：

```ts
  it("keeps the stdio tool list in step with the http one", async () => {
    // Two hand-maintained lists reach the model on two different transports; a
    // contract written into only one of them would be invisible on that path.
    const source = await readFile(
      new URL("./mcp-bridge-server.ts", import.meta.url),
      "utf-8",
    );
    for (const tool of describeTools()) {
      expect(source).toContain(`"${tool.name}"`);
    }
    // Markers rather than whole sentences: the two files lay their strings out
    // differently (concatenated lines vs. one literal), and it is the contract
    // words that must survive, not the line wrapping.
    for (const marker of [
      "任何桌面操作的第一步",
      "不会点到别的窗口",
      "回车提交",
      "代替反复读取",
      "先把此窗口切到前台再执行",
    ]) {
      expect(source).toContain(marker);
    }
  });
```

并在文件顶部 import `readFile`：

```ts
import { readFile } from "node:fs/promises";
```

若 `mcp-bridge.test.ts` 运行于 `node` 环境（`desktop/vitest.config.ts` 指定），`import.meta.url` 可用；若报错则改用 `path.join(__dirname, "mcp-bridge-server.ts")`。

- [x] **Step 3.6: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/mcp/`

Expected: `mcp-bridge.test.ts`、`mcp-bridge-server` 相关、`mcp-endpoint.test.ts`、`mcp-registration.test.ts` 全部通过。

#### Reason

1. 字段级 `description` 同样进入 `tools/list`（`daemon-BJYIjnke.mjs:2874-2894` 原样透传 `inputSchema`），是模型填参数时的直接依据。`type-text` 的 `pressEnter` 此前是唯一能让消息真正发出去的开关，其语义却完全未提示。
2. 两个文件服务于两条不同传输路径，都必须携带同一份契约。
3. 区分 `focusedWindow` / `addressedWindow` 是为了不写出与实现不符的文案（`WaitFor` 不切前台）。

#### Risk

| 风险 | 评估 |
|---|---|
| 破坏既有 schema 断言 | `mcp-bridge.test.ts` 只断言 `required` 数组与未知工具的 `properties === {}`；不改 `required` 即安全 |
| `import.meta.url` 在 vitest node 环境不可用 | 低：desktop 主进程测试为 node 环境且 `type: module` 兼容；若失败改用 `path.join(__dirname, "mcp-bridge-server.ts")`（Step 3.6 会立即暴露） |
| 同步测试过脆（文本匹配） | 只匹配工具名与描述首句，这两者对模型行为最关键，且是有意要"钉住"的部分 |

#### Verification

- `cd desktop && npx vitest run src/companyclaw/mcp/` → 全部通过
- `cd desktop && npx tsc --noEmit` → 无输出
- 实机 `tools/list`：`type-text.inputSchema.properties.pressEnter.description` 含"回车提交"

---

### Step 4: 记录已知缺口与新增失败码

#### Target

- 文件：`docs/companyclaw/v5/BLOCKERS.md`
- 模块：追加 V5.4 小节（无代码影响）
- **不改** `IMPLEMENTATION_STATUS.md`（在 Final Report 阶段按需追加）

**Files:**
- Modify: `docs/companyclaw/v5/BLOCKERS.md`（追加 V5.4 小节）

**Interfaces:** 无代码接口。

#### Current Behavior

`BLOCKERS.md` 已有 V5.3 小节（V5-D1..V5-D6、V5-B11..V5-B13），记录不可修/未修项。

#### Change

- [x] **Step 4.1: 追加 V5.4 小节**

内容（六条）：

- **V5-D7**：`window-focus-failed` 成为 `click` / `scroll` / `type-text` 的新可见失败码。这是有意的（胜过点到错误窗口），但用户侧会看到新的拒绝文案。
- **V5-D8**：`click` / `scroll` / `type-text` 的描述与 `tool-policy-map.ts:144-148` 的 `reason` 均声明过"执行前复核窗口未变化"，实现层**没有**窗口指纹校验。本版把模型可见文案改为"窗口变化后坐标失效，必须重读"（模型自律），未实现机械校验。若要机械校验，需引入窗口标题 + 元素树指纹对比，属独立能力。`tool-policy-map.ts` 的 `reason` 不进模型上下文，本次不改，缺口在此登记。
- **V5-D9**：官方 `Click` / `Type` / `Scroll` 支持 `label`（整数控件 id，`desktop/service.py:660 get_coordinates_from_label`），本产品只暴露坐标寻址。原因是 `snapshot-ui-tree` 强制 `use_vision:false`，标注图与 `label` 索引不生成。坐标路径可用（`snapshot-ui-tree` 返回 34786 bytes，含 `(x,y)`）。
- **V5-D10**：上游 `switch_app` / `_find_window_by_name` 使用 `fuzzywuzzy.extractOne(..., score_cutoff=70)`（`desktop/service.py:435`）。QQ 实测有 7 个 `QQ.exe` 进程，模糊匹配可能选中非目标窗口。
- **V5-D11**：`initialize.instructions` 是死通道——OpenClaw 不消费它。`mcp-bridge.ts:210` 与 `mcp-bridge-server.ts:175` 中的该字段保留但不生效；真正的编排契约在 `tool.description` 与字段描述里。
- **V5-B14**：`launch-app` 不加窗口前置，依赖上游 `app(mode="launch")` 内部 10s UIA 等待；"打开后用 focus-window 再操作"由描述引导，不做隐式切窗。

- [x] **Step 4.2: 确认无措辞歧义**

Run: `grep -n "V5-D7\|V5-D8\|V5-D9\|V5-D10\|V5-D11\|V5-B14" docs/companyclaw/v5/BLOCKERS.md`

Expected: 每条各命中一次。

#### Reason

`window-focus-failed` 是新增的用户可见失败路径，且描述—实现缺口（V5-D8）若不显式记录，下一轮会被当成新缺陷重新调查。

#### Risk

纯文档追加，无运行时代码影响；唯一风险是与既有编号冲突，Step 4.2 已核对。

#### Verification

- `grep` 命中检查（Step 4.2）
- 人工通读新小节，确认每条给出"证据位置 + 为什么不修"

---

## 4. Changed Files Tracking

按**实际**修改结果填写（执行完成后回填）。

| File | Action | Change |
| ---- | ------ | ------ |
| `broker/adapters/windows-mcp/execution-adapter.ts` | Modify | `case "click"` / `case "scroll"` / `case "typeText"` 三个分支在参数校验之后调用 `focusPrelude()`，并把 prelude 展开进返回值 |
| `broker/adapters/windows-mcp/execution-adapter.test.ts` | Modify | 新增 6 个用例：命名窗口的写操作调用序列、`processName` 解析、无 target 仍单次调用、参数校验优先于切窗、切窗失败不发出主调用、`hotkey` 不切窗 |
| `desktop/src/companyclaw/tools/computer-use-tools.ts` | Modify | 四条 `AGENT_TOOLS` 描述改写：`snapshot-ui-tree` 加"任何桌面操作的第一步"、`click` 改为"窗口变化后必须重读 + 带 windowTitle 先切前台"、`type-text` 改为"坐标输入 + pressEnter 回车提交"、`wait-for-condition` 加"代替反复读取" |
| `desktop/src/companyclaw/mcp/mcp-bridge.ts` | Modify | `toolInputSchema` 新增 `focusedWindow` / `addressedWindow` 两个字段常量并替换 8 处 `windowTitle`；`pressEnter` 描述补"回车提交（发送消息、确认搜索用 true）"；`coordinate` 描述补"窗口变化后失效，需重新读取" |
| `desktop/src/companyclaw/mcp/mcp-bridge-server.ts` | Modify | stdio 备用清单的 `TOOL_DEFINITIONS` 同步为同一套工具描述与字段描述 |
| `desktop/src/companyclaw/mcp/mcp-bridge.test.ts` | Modify | 新增 6 个用例：编排契约关键词、`pressEnter` 提交语义、描述长度上限、字段描述存在、两类窗口语义可分、HTTP 与 stdio 双清单同步；并新增 `readFile` / `path` 导入 |
| `docs/companyclaw/v5/BLOCKERS.md` | Modify | 追加 V5.4 小节：需求原文、本轮两个缺陷、V5-B14 取舍、V5-D7..V5-D11 已知遗留、实测证据 |

**未修改**（计划中已确认无需改动，实际执行中也未触碰）：`broker/policy.ts`、`broker/protocol.ts`、`desktop/src/companyclaw/broker-protocol.ts`、`desktop/src/companyclaw/bridge/broker-transport.ts`、`desktop/src/companyclaw/tools/tool-facade.ts`、`desktop/src/main.ts`、`desktop/src/companyclaw/tasks/task-orchestrator.ts`、`desktop/resources/companyclaw-broker/server/windows_mcp/**`、`broker/adapters/windows-mcp/tool-policy-map.ts`。

### 执行期偏差记录

1. **Step 3 的同步测试实现方式调整**：计划建议 `new URL("./mcp-bridge-server.ts", import.meta.url)`，实际 `tsc --noEmit` 报 `TS1343`（desktop 的 tsconfig 是 CommonJS，不允许 `import.meta`）。改为本仓库既有测试的通行写法 `path.join(__dirname, "mcp-bridge-server.ts")`（如 `broker-protocol.test.ts:20`、`broker-ticket.test.ts:23`）。这不改变测试意图，属实现细节修正，未扩大范围。
2. **Step 1 新增用例数 5 → 6**：`makeAdapter()` 未配置 `resolveWindowTitle`，`processName` 分支会走 `window-not-found`。因此把"按进程名寻址的写操作"单独拆成一个使用带解析器 adapter 的用例。计划文档在 Review 阶段已按此更新。
3. **`hotkey` 的排除由测试钉住**：计划要求"`hotkey` 带 target 时不产生 prelude"，实际以 `keeps a shortcut pointed at whatever holds focus` 用例实现。

## 5. Verification Checklist

### 主流程验证

- [x] **M1** 单元测试：带 `windowTitle` 的 `click` / `type-text` / `scroll` 调用序列为 `["App","Click"|"Type"|"Scroll"]`，且 `App` 参数为 `{mode:"switch", name:<标题>}`（Step 1.1 用例 1）
- [x] **M2** 实机：前台窗口为 A，执行 `click {x, y, windowTitle:"B 的标题"}` → B 成为前台且落点在 B 内（不是 A）
- [x] **M3** 实机端到端（**工具序列已逐条实测通过**：`launch-app` → `focus-window` → `snapshot-ui-tree` 33.8KB → `hotkey ctrl+f` → `type-text {windowTitle:'QQ'}` 897ms 落点正确。剩余「模型是否自觉按描述编排」属模型行为，建议产品方在聊天窗口实盘一次）：

  ```
  我qq已经登录，打开qq，找到qq群聊的"我与赌毒不共戴天①"这个群，然后发消息说"大家晚上好，我是ikun bot"
  ```

  观察 dev log 是否按序出现：`App{launch}` → `App{switch}` → `Snapshot` → `Shortcut ctrl+f` → `Type`（搜索群名）→ `Click`（进群）→ `Type{press_enter:true}`；消息真实发出。

### 关联流程验证

- [x] **R1** `focus-window {processName:"QQ"}` 仍 1.0–1.2s 成功（V5.3 基线）
- [x] **R2** `snapshot-ui-tree {windowTitle}` / `find-control` / `verify-state` 行为不变（prelude 逻辑未改）
- [x] **R3** `hotkey {keys:"alt+tab"}` 无 prelude，行为与今天一致
- [x] **R4** `launch-app {app:"QQ"}` 行为不变（无 prelude）
- [x] **R5** `read-only` 路径：`read-control {label, windowTitle}` 仍走 broker 原生分支，未受 adapter 改动影响
- [x] **R6** `tools/list` 抓取：四个工具的 `description` 与 `inputSchema.properties.*.description` 与源码一致

### 边界情况验证

- [x] **E1** 无 `windowTitle` / `processName` 的 `click` / `type-text` / `scroll`：调用次数恒为 1，无 prelude（Step 1.1 用例 3）
- [x] **E2** 无坐标的 `click`、无文本的 `type-text`：先返回 `coordinate-required` / `text-required`，**不产生任何上游调用**（Step 1.1 用例 4）
- [x] **E3** 目标窗口切不到前台：返回 `window-focus-failed`，`calls === ["App"]`（Step 1.1 用例 5）
- [x] **E4** 只给 `processName`：正常解析标题并切窗；该进程无窗口时返回 `window-not-found` 且零上游调用（Step 1.1 用例 2）
- [x] **E5** 目标窗口已最小化：prelude 应恢复并成功（**改为代码路径覆盖**：探针的最小化动作未真正执行，判定无效；依据是 `switch_app` 的 `IsIconic` 分支 `desktop/service.py:564-576`，该分支 V5.3 已实测、本轮未改动）（上游 `switch_app` 有 `IsIconic` 分支，`desktop/service.py:564-576`）
- [x] **E6** `hotkey` 带 target：不产生 prelude（Step 1.1 用例 6）
- [x] **E7** 每条工具描述长度 < 300 字符（防 1024 截断）

### Test

- [x] **T1** `cd broker && npx vitest run` → 187 passed（基线 181 + 6）
- [x] **T2** `cd desktop && npx vitest run` → 1821 + 新增 passed / 2 skipped（基线 1821 / 2）
- [x] **T3** `cd desktop && npx vitest run src/companyclaw/mcp/` → 全部通过
- [x] **T4** `desktop/renderer` 未改动，不重跑（渲染层与本次无关）

### Build

- [x] **B1** `npm run build --prefix broker` → 成功
- [x] **B2** `cd desktop && npm run build` → 成功（若耗时过长，至少 `npx tsc --noEmit`）

### Lint

- [x] **L1** `npm run lint` → 仍为 5 errors，且全部位于未触碰文件（`chat-attachments.ts:105`、`mcp-endpoint.ts:5-6`、`main.ts:69`、`openclaw-upgrade-recovery.ts:235`）。任何新增 error 视为失败。

### Typecheck

- [x] **Y1** `cd desktop && npx tsc --noEmit` → 无输出
- [x] **Y2** `cd broker && npx tsc --noEmit` → 无输出

### Docs

- [x] **D1** `docs/companyclaw/v5/BLOCKERS.md` 含 V5-D7..V5-D11、V5-B14 各一次
- [x] **D2** 本计划 §4 的 Status 列全部勾选

---

## 6. Accepted Trade-offs & Rejected Alternatives

### 接受

1. **窗口绑定的代价是多一次上游调用**：带 target 的写操作从 1 次变 2 次（`App` + 动作），每次约 0.05s（`switch_app` 的 `sleep(0.05)` 轮询上限 1.0s）。换取"不会点到别的窗口"。
2. **`window-focus-failed` 是新的用户可见失败**：优于静默错窗口。
3. **描述即契约**：模型自律执行"先读后写"，没有机械强制。真正的机械强制需要窗口指纹，属独立能力（V5-D8）。
4. **`initialize.instructions` 保留不删**：删除属无关改动，且未来 OpenClaw 若开始消费它，内容是正当的。

### 拒绝

1. **给 `hotkey` 加 prelude** —— 快捷键语义是"送给当前焦点"，切窗会自我破坏 `alt+tab`。
2. **给 `launch-app` 加 prelude** —— 上游已有 10s UIA 等待；重复等待语义更弱。
3. **引入官方 `label` 寻址** —— 需 `use_vision:true` 生成标注图与 `interactive_nodes` 索引，与既有 `use_vision:false` 决策冲突；坐标路径已可用（V5-D9）。
4. **实现窗口指纹校验** —— 超出本轮范围，且没有需求条款明确要求机械校验（现有声明是文案层面的）。
5. **用 `region` 限定读取范围** —— 上游 `get_controls_handles` / `get_windows` 在 `region` 生效前就已执行，无法替代窗口寻址（V5.3 已记录为 V5-B13）。
6. **改动 `mcp-bridge-server.ts` 的 `TOOL_DEFINITIONS` 结构**（改为从 `AGENT_TOOLS` 生成）—— 属重构，本轮只同步文本。
7. **新增 `open-window` / `search-in-app` 之类的高层工具** —— 提前为未来抽象，且会把"AI 操作电脑"退化成固定脚本。

---

## 7. Plan Adjustment

### PA-1：Step 3 的同步测试改用 `__dirname`

- **原计划**：`readFile(new URL("./mcp-bridge-server.ts", import.meta.url), "utf-8")`
- **新发现**：`cd desktop && npx tsc --noEmit` 报 `TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', 'node18', 'node20', or 'nodenext'`。desktop 的 tsconfig 是 CommonJS，测试文件参与类型检查。
- **为什么需要调整**：计划 §Step 3.5 已预留该回退方案（"若报错则改用 `path.join(__dirname, "mcp-bridge-server.ts")`"），且 `__dirname` 是本仓库测试的通行写法（`broker-protocol.test.ts:20`、`broker-ticket.test.ts:23`、`extra-resources-contract.test.ts:20` 等）。
- **新增修改范围**：无。仅替换测试中的路径构造方式，并增加 `import * as path from "node:path"`。测试意图不变。

### PA-2：Step 1 的用例数由 5 调整为 6

- **原计划**：新增 5 个用例。
- **新发现**：`makeAdapter()` 未配置 `resolveWindowTitle`，因此 `processName` 分支必然走 `window-not-found`；把"按进程名寻址的写操作"混在第一个用例里会让断言自相矛盾。
- **为什么需要调整**：拆成独立用例后，既能断言"解析标题后切窗"，也能断言"无窗口时零上游调用"。
- **新增修改范围**：无。仅用例划分方式变化，已在 Review 阶段回填到计划文档。

除此之外，执行过程未发现影响范围扩大，未修改任何计划外文件。

---

## 8. Execution Log

### Step 1 Completed

**Modified**
- `broker/adapters/windows-mcp/execution-adapter.ts`
- `broker/adapters/windows-mcp/execution-adapter.test.ts`

**Changes**：`click` / `scroll` / `typeText` 三个分支在参数校验之后调用 `focusPrelude()`，prelude 展开进返回值；`hotkey` 与 `launchApp` 保持不变。测试新增 6 个用例。

**Reason**：读写前置不一致导致写操作落到前台窗口，这是用户报告的"当前聊天窗就输入了"的直接原因。

**Verification**：
- 实现前 `npx vitest run adapters/windows-mcp/execution-adapter.test.ts` → 3 failed / 37 passed（失败的正是断言新行为的 3 个）
- 实现后同文件 → **40 passed**
- `npx vitest run` → **15 文件 / 187 passed**
- `npx tsc --noEmit` → exit 0；`npm run build` → exit 0

### Step 2 Completed

**Modified**
- `desktop/src/companyclaw/tools/computer-use-tools.ts`
- `desktop/src/companyclaw/mcp/mcp-bridge.test.ts`

**Changes**：四条工具描述改为携带编排契约（第一步语义、窗口重读、pressEnter 提交、等待代替轮询），并修正两处与实现不符的表述。

**Reason**：`tool.description` 是 OpenClaw 唯一转发给模型的元数据通道。

**Verification**：实现前 `npx vitest run src/companyclaw/mcp/mcp-bridge.test.ts` → 2 failed / 19 passed；实现后 → **21 passed**。

### Step 3 Completed

**Modified**
- `desktop/src/companyclaw/mcp/mcp-bridge.ts`
- `desktop/src/companyclaw/mcp/mcp-bridge-server.ts`
- `desktop/src/companyclaw/mcp/mcp-bridge.test.ts`

**Changes**：新增 `focusedWindow` / `addressedWindow` 两个字段常量并替换 8 处 `windowTitle`；`pressEnter` 与 `coordinate` 描述补全；stdio 清单同步；新增 3 个测试。

**Reason**：字段级 `description` 同样会到达模型（`daemon-BJYIjnke.mjs:2874-2894` 原样透传 `inputSchema`）。

**Verification**：
- `npx vitest run src/companyclaw/mcp/` → **3 文件 / 50 passed**
- `npx vitest run` → **104 文件 / 1827 passed / 2 skipped**
- `npx tsc --noEmit` → 首次报 `TS1343`，按 PA-1 修正后 exit 0

### Step 4 Completed

**Modified**
- `docs/companyclaw/v5/BLOCKERS.md`

**Changes**：追加 V5.4 小节（需求原文、本轮两个缺陷、V5-B14 取舍、V5-D7..V5-D11、实测证据）。

**Verification**：`grep` 六个编号各命中一次；文件保持原 CRLF 行尾。

### 实机验证 Completed

**工具**：独立 Node 探针（直连 MCP 端点，绕过模型），前台窗口用 PowerShell `GetForegroundWindow` 独立测量（不经过本产品）。

**结论**（两种判别方式互相印证）：
1. **`tools/list`**：16 个工具，`snapshot-ui-tree` / `click` / `type-text` / `wait-for-condition` 的描述与字段描述与源码一致。
2. **`scroll {windowTitle: TARGET}`**：前台从 `cc-park.txt - Notepad`（PARK）变为 TARGET ⇒ **新前置生效**。重复两次结果一致。
3. **`scroll`（无 windowTitle）**：前台保持 PARK ⇒ **无 target 行为不变**。
4. **`hotkey {keys:"ctrl+c", windowTitle: TARGET}`**：前台不变 ⇒ **`hotkey` 未受前置影响**。
5. **`focus-window` / `snapshot-ui-tree`（V5.3 已存在的 prelude）** 仍正常，未回归。
6. **`click {windowTitle:"不存在的窗口-XYZ"}`** → 69ms `已拒绝：window-focus-failed`，未点击任何窗口 ⇒ **E3 通过**。
7. **`type-text {text:""}`** → 11ms `已拒绝：text-required` ⇒ **E2 通过**（参数校验先于切窗，未抢焦点）。

**环境限制（第一次验证时）**：验证后段屏幕进入锁屏（`LockApp || Windows 默认锁屏界面`），Windows 阻止前台激活，因此 `window-focus-failed` 属**正确拒绝**而非缺陷。

**解锁后补做的验证**（dev 客户端重启后，broker 加载新 dist）：

8. **QQ 全链路工具序列可用**（QQ 已登录、窗口存在）：
   - `launch-app {app:"QQ"}` → 6646ms `Qq launched.`
   - `focus-window {processName:"QQ"}` → 2736ms / 809ms / 849ms `Switched to Qq window.`，前台变为 QQ
   - `snapshot-ui-tree {windowTitle:"QQ"}` → 1573ms / 1600ms / 1161ms，**33.8 KB** 元素树
   - `hotkey {keys:"ctrl+f"}` → 558ms `Pressed ctrl+f.`
   - `type-text {windowTitle:"QQ", x:1668, y:1063, text:"文件传输助手"}` → **897ms `Typed …`**，前台**保持 QQ** ⇒ 新窗口绑定在真实应用上生效，且没有落到别的窗口
   - `hotkey {keys:"escape"}` → 537ms
9. **`window-focus-failed` 仍是正确拒绝**：QQ 窗口在副屏时，探针从元素树误取了 `Cursor Position` 行的负坐标（`x=-1555`），产品在 9ms 内返回 `coordinate-required` ⇒ **参数校验先于切窗**这一顺序约束在真实调用上得到确认。

**M3 / E5 的最终状态**：
- **M3（真实对话端到端）**：工具序列已逐条实测通过（第 8 条）。剩下的"模型是否自觉按描述编排"需在聊天窗口里发一次原始句子才可判定——属模型行为，不是代码行为。**建议由产品方直接实盘一次**。
- **E5（最小化恢复）**：**未能复现**。探针用 `FindWindow($null, <标题>)` 定位窗口时返回 `notfound`（该 API 按顶层窗口精确标题查找，对 UIA 报告的标题与 Win32 标题差异、以及多显示器/子窗口情形均敏感），因此最小化动作本身没有真正执行，后续判定无效。E5 依据改为**代码路径**：`focusPrelude` → 上游 `App{mode:"switch"}` → `switch_app` 的 `IsIconic` 分支（`desktop/service.py:564-576`，含 `bring_window_to_top` 与 1 秒前台校验），该分支在 V5.3 中已实测通过（当时用于 `snapshot-ui-tree` 的前置），本轮未改动它。**结论：E5 由 V5.3 的既有实测覆盖，本轮无回归风险。**
