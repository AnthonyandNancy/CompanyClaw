import type { ExecutionOrigin } from "../policy/execution-origin";

/**
 * The W-capability names.
 *
 * Mirrored from `broker/adapters/windows-mcp/tool-policy-map.ts` rather than
 * imported: the broker is a separate compilation with its own root, and pulling
 * its sources into the desktop build would move the desktop's source root.
 * `computer-use-tools.test.ts` reads the broker's file and pins the two lists
 * together, the same way the wire protocol is pinned.
 */
export const BROKER_CAPABILITIES = [
  "listInstalledApps",
  "launchApp",
  "listWindows",
  "focusWindow",
  "snapshotUiTree",
  "findControl",
  "readControl",
  "invokeControl",
  "typeText",
  "hotkey",
  "click",
  "scroll",
  "dragDrop",
  "screenshot",
  "waitForWindowOrControl",
  "inspectNotificationOrDialog",
  "verifyState",
  "captureExecutionError",
] as const;

export type BrokerCapability = (typeof BROKER_CAPABILITIES)[number];

/**
 * The tool surface the agent is allowed to see, and the boundary it enters.
 *
 * Requirement V5 §7.1 is explicit that the desktop conversation and the WeChat
 * conversation must reach *the same* executor, and §5.6 that the model's tool
 * call has to pass through the task orchestrator and the policy layer. This
 * module is the shape of that entry point: it declares what a tool call looks
 * like, and — importantly — what it may *not* carry.
 *
 * Two fields are deliberately absent from `AgentToolCall`:
 *
 *   * an approval ticket, because §5.2 forbids letting the model fill one in;
 *   * an origin, because the trusted context is minted at the boundary the
 *     message actually arrived through, never taken from the model's output.
 */

export interface AgentToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** The W-capability this tool serves, for the allow-map and the health page. */
  capability: BrokerCapability;
  /** True when the tool can change state and therefore needs a decision. */
  mutating: boolean;
}

/**
 * The tools exposed to the model.
 *
 * Descriptions are written for a Chinese-speaking employee reading the model's
 * own reasoning, and each says what the tool does *not* do — a model that
 * understands "启动会打开已安装的应用，但不会执行命令" is far less likely to
 * attempt the command path.
 */
export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "list-installed-apps",
    description: "列出本机已安装的应用（显示名）。用于发现可打开的程序，无需用户提供路径。",
    capability: "listInstalledApps",
    mutating: false,
  },
  {
    name: "launch-app",
    description: "打开一个已安装的应用。只能按显示名打开，不接受路径或命令参数。",
    capability: "launchApp",
    mutating: true,
  },
  {
    name: "list-windows",
    description: "列出当前用户会话中的窗口（标题、进程、是否可见）。",
    capability: "listWindows",
    mutating: false,
  },
  {
    name: "focus-window",
    description: "把指定窗口切到前台。会先核对窗口与进程身份，避免操作到错误窗口。",
    capability: "focusWindow",
    mutating: true,
  },
  {
    name: "snapshot-ui-tree",
    description: "读取目标窗口的界面元素树（按钮、输入框、列表等），用于定位可操作控件。",
    capability: "snapshotUiTree",
    mutating: false,
  },
  {
    name: "find-control",
    description: "按名称或角色查找控件。返回的引用有有效期，窗口变化后会失效。",
    capability: "findControl",
    mutating: false,
  },
  {
    name: "read-control",
    description: "读取控件当前的值或状态。",
    capability: "readControl",
    mutating: false,
  },
  {
    name: "click",
    description: "在指定坐标点击。坐标必须来自最近一次界面读取，执行前会复核窗口未变化。",
    capability: "click",
    mutating: true,
  },
  {
    name: "type-text",
    description: "向已聚焦的输入控件输入文本，支持中文与中英混输。",
    capability: "typeText",
    mutating: true,
  },
  {
    name: "hotkey",
    description: "执行常用快捷键（如 ctrl+c、ctrl+v）。只能在支持列表内选择。",
    capability: "hotkey",
    mutating: true,
  },
  {
    name: "scroll",
    description: "在目标窗口或控件范围内滚动，用于浏览长列表或长文本。",
    capability: "scroll",
    mutating: true,
  },
  {
    name: "drag-drop",
    description: "把文件或元素从一处拖到另一处。必须同时给出来源与目标窗口，任一不明确都会拒绝。",
    capability: "dragDrop",
    mutating: true,
  },
  {
    name: "screenshot",
    description: "截取目标窗口的图像。仅在需要视觉识别且已获得视觉授权时可用。",
    capability: "screenshot",
    mutating: false,
  },
  {
    name: "wait-for-condition",
    description: "等待文本、窗口或控件出现，带时间上限，不会无限等待。",
    capability: "waitForWindowOrControl",
    mutating: false,
  },
  {
    name: "inspect-dialog",
    description: "读取普通弹窗与错误提示。Windows 安全桌面（UAC）不可交互，会被拒绝。",
    capability: "inspectNotificationOrDialog",
    mutating: false,
  },
  {
    name: "verify-state",
    description: "执行后回读目标窗口、控件或文件状态，用于确认动作真的发生了。",
    capability: "verifyState",
    mutating: false,
  },
] as const;

/** Tool names as a set, for validating an inbound call. */
export function findTool(name: string): AgentToolDefinition | null {
  return AGENT_TOOLS.find((tool) => tool.name === name) ?? null;
}

export interface ToolCallContext {
  /** Minted at the trusted boundary; never supplied by the model. */
  origin: ExecutionOrigin;
  taskId: string;
  stepId: string;
  ownerSid: string;
  deviceId: string;
}

export type ToolCallRejection =
  | "unknown-tool"
  | "model-supplied-identity"
  | "model-supplied-approval"
  | "missing-task-context";

/**
 * Validates one inbound call before it reaches the policy layer.
 *
 * The three rejections are the requirement's own prohibitions, made mechanical:
 * a model may not name its own identity, may not present an approval, and may
 * not run outside a task.
 */
export function validateToolCall(
  call: AgentToolCall,
  context: ToolCallContext | null,
): { ok: true; definition: AgentToolDefinition } | { ok: false; reason: ToolCallRejection } {
  const definition = findTool(call.tool);
  if (!definition) return { ok: false, reason: "unknown-tool" };

  if (
    "origin" in call.arguments ||
    "ownerSid" in call.arguments ||
    "deviceId" in call.arguments ||
    "taskId" in call.arguments
  ) {
    return { ok: false, reason: "model-supplied-identity" };
  }
  if (
    "approvalTicket" in call.arguments ||
    "approved" in call.arguments ||
    "approvalId" in call.arguments
  ) {
    return { ok: false, reason: "model-supplied-approval" };
  }
  if (!context || !context.taskId || !context.stepId) {
    return { ok: false, reason: "missing-task-context" };
  }
  return { ok: true, definition };
}

/**
 * The names the health page counts as "已加载 N 项受控工具".
 *
 * Only the tools defined here — never the upstream server's full list — because
 * the employee-facing claim is about what this product will actually do.
 */
export function loadedAgentToolNames(): string[] {
  return AGENT_TOOLS.map((tool) => tool.name);
}
