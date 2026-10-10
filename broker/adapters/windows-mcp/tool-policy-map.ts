/**
 * Which upstream Windows-MCP tools may ever reach the agent.
 *
 * The upstream server ships twenty-one tools, and several of them are a
 * complete command surface in disguise: `PowerShell` runs arbitrary commands,
 * `FileSystem` reads and deletes any path, `Registry` edits system
 * configuration, `Process` kills processes, `Clipboard` reads whatever the user
 * copied, and `Scrape` performs network fetches that would bypass the browser
 * policy. Handing those to a model would make "one-click daily operation" mean
 * "unbounded shell", which the requirement forbids outright.
 *
 * So every upstream tool is classified before it can be called:
 *
 *   * `deny`  — never exposed, not even behind an approval;
 *   * `wrap`  — exposed, but only through a CompanyClaw capability that applies
 *               its own target, scope and audit checks (see the capability map);
 *   * `unknown` — a tool this build has never seen. Treated as denied, because
 *               an upstream upgrade must not silently widen the surface.
 *
 * The classification is data, not logic, so the allow-map can be reviewed and
 * tested without reading the adapter.
 */

export type ToolDisposition = "wrap" | "deny";

export interface ToolPolicyEntry {
  tool: string;
  disposition: ToolDisposition;
  /** Which CompanyClaw capabilities this tool may be used for. */
  capabilities: readonly BrokerCapability[];
  reason: string;
}

/** The CompanyClaw-facing capabilities (requirement W01–W18). */
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
 * The allow-map for the pinned upstream release (0.8.7).
 *
 * Kept exhaustive on purpose: a reviewer can compare this list against
 * `tools/list` output and see immediately whether an upgrade added something.
 */
export const TOOL_POLICY_MAP: readonly ToolPolicyEntry[] = [
  {
    tool: "PowerShell",
    disposition: "deny",
    capabilities: [],
    reason: "任意命令执行面；等价于给模型一个 Shell",
  },
  {
    tool: "FileSystem",
    disposition: "deny",
    capabilities: [],
    reason: "任意路径读写与删除，必须走 CompanyClaw 的文件与产物管线",
  },
  {
    tool: "Registry",
    disposition: "deny",
    capabilities: [],
    reason: "系统配置面；不得由模型直接修改",
  },
  {
    tool: "Process",
    disposition: "deny",
    capabilities: [],
    reason: "可结束任意进程，含安全软件与系统进程",
  },
  {
    tool: "Clipboard",
    disposition: "deny",
    capabilities: [],
    reason: "剪贴板常含凭据，读取即数据外泄",
  },
  {
    tool: "Scrape",
    disposition: "deny",
    capabilities: [],
    reason: "自带网络抓取，会绕过浏览器域名策略与 SSRF 校验",
  },
  {
    tool: "Notification",
    disposition: "deny",
    capabilities: [],
    reason: "与任务无关的系统通知，扩大噪声与欺骗面",
  },
  {
    tool: "MultiSelect",
    disposition: "deny",
    capabilities: [],
    reason: "批量选择会一次施加多个副作用，本版不开放",
  },
  {
    tool: "MultiEdit",
    disposition: "deny",
    capabilities: [],
    reason: "批量输入绕过逐字段的目标校验，本版不开放",
  },
  {
    tool: "App",
    disposition: "wrap",
    capabilities: ["listInstalledApps", "launchApp", "focusWindow"],
    reason: "启动与切窗需经已安装应用发现与白名单校验",
  },
  {
    tool: "Snapshot",
    disposition: "wrap",
    capabilities: ["snapshotUiTree", "findControl", "verifyState"],
    reason: "界面树读取，需限定目标窗口并脱敏",
  },
  {
    tool: "Screenshot",
    disposition: "wrap",
    capabilities: ["screenshot"],
    reason: "截图需经云端视觉闸门，本地可用不等于允许上传",
  },
  {
    tool: "DisplayInventory",
    disposition: "wrap",
    capabilities: ["snapshotUiTree", "click"],
    reason: "多屏与 DPI 坐标换算的前提数据",
  },
  {
    tool: "Click",
    disposition: "wrap",
    capabilities: ["click", "invokeControl"],
    reason: "坐标点击须绑定截图、窗口与时效，动作前复核窗口未变",
  },
  {
    tool: "Type",
    disposition: "wrap",
    capabilities: ["typeText"],
    reason: "文本输入须先验证焦点控件",
  },
  {
    tool: "Scroll",
    disposition: "wrap",
    capabilities: ["scroll"],
    reason: "仅允许在目标窗口或控件范围内滚动",
  },
  {
    tool: "Move",
    disposition: "wrap",
    capabilities: ["dragDrop", "click"],
    reason: "拖拽按 W13 必修；来源与目标窗口必须校验",
  },
  {
    tool: "Shortcut",
    disposition: "wrap",
    capabilities: ["hotkey"],
    reason: "仅允许显式列举的常用组合，禁止无界任意组合",
  },
  {
    tool: "Wait",
    disposition: "wrap",
    capabilities: ["waitForWindowOrControl"],
    reason: "等待必须有上限，不得无界阻塞",
  },
  {
    tool: "WaitFor",
    disposition: "wrap",
    capabilities: ["waitForWindowOrControl", "inspectNotificationOrDialog"],
    reason: "条件等待在本进程内轮询，需带超时",
  },
] as const;

/**
 * The tool names the pinned release actually advertises.
 *
 * Verified against a real `tools/list` handshake on the locked commit
 * (`is the map complete?`), so `reconcileToolList` can distinguish "the upstream
 * dropped a capability" from "this build forgot to classify one". `reconcile`
 * is called after every handshake and its result is logged.
 */
export const PINNED_UPSTREAM_TOOLS: readonly string[] = [
  "App",
  "DisplayInventory",
  "PowerShell",
  "FileSystem",
  "Snapshot",
  "Screenshot",
  "Click",
  "Type",
  "Scroll",
  "Move",
  "Shortcut",
  "Wait",
  "WaitFor",
  "Scrape",
  "MultiSelect",
  "MultiEdit",
  "Clipboard",
  "Process",
  "Notification",
  "Registry",
] as const;

const BY_TOOL = new Map(TOOL_POLICY_MAP.map((entry) => [entry.tool, entry]));

export function dispositionFor(tool: string): ToolPolicyEntry | null {
  return BY_TOOL.get(tool) ?? null;
}

/**
 * True only when the upstream tool may be called for this capability.
 *
 * An unknown tool is refused: a new upstream release must be reviewed and added
 * to the map deliberately, never inherited.
 */
export function isToolAllowedFor(tool: string, capability: BrokerCapability): boolean {
  const entry = dispositionFor(tool);
  if (!entry || entry.disposition !== "wrap") return false;
  return entry.capabilities.includes(capability);
}

/**
 * Capabilities served by the existing broker rather than by an upstream tool.
 *
 * The pre-V5 UI Automation path already implements window enumeration, value
 * reading and structured error reporting, and those results are what the agent
 * has been using. Keeping them on the broker side means an upstream release
 * cannot remove a capability the product promises, and it keeps the fallback
 * available when the vendored server is missing or refuses a call.
 */
export const BROKER_NATIVE_CAPABILITIES: readonly BrokerCapability[] = [
  "listWindows",
  "readControl",
  "captureExecutionError",
] as const;

/** Every tool the adapter will refuse to call, for the health report and logs. */
export function deniedUpstreamTools(): string[] {
  return TOOL_POLICY_MAP.filter((entry) => entry.disposition === "deny").map((entry) => entry.tool);
}

/** Every tool the adapter may call, for the "已加载 N 项受控工具" line. */
export function wrappedUpstreamTools(): string[] {
  return TOOL_POLICY_MAP.filter((entry) => entry.disposition === "wrap").map((entry) => entry.tool);
}

/**
 * Reconciles what upstream actually advertises against the pinned map.
 *
 * Called after `tools/list`. Returns the disagreements so a version bump cannot
 * pass unnoticed: a tool that disappeared may mean the capability is gone, and a
 * tool that appeared is unclassified and therefore denied.
 */
export function reconcileToolList(advertised: readonly string[]): {
  missing: string[];
  unclassified: string[];
  denied: string[];
  /** True when the advertised set matches the pinned release exactly. */
  matchesPinnedRelease: boolean;
} {
  const seen = new Set(advertised);
  const known = new Set(TOOL_POLICY_MAP.map((entry) => entry.tool));
  const missing = TOOL_POLICY_MAP.filter(
    (entry) => entry.disposition === "wrap" && !seen.has(entry.tool),
  ).map((entry) => entry.tool);
  const unclassified = advertised.filter((tool) => !known.has(tool));
  const denied = deniedUpstreamTools().filter((tool) => seen.has(tool));
  return {
    missing,
    unclassified,
    denied,
    matchesPinnedRelease:
      unclassified.length === 0 &&
      missing.length === 0 &&
      advertised.length === PINNED_UPSTREAM_TOOLS.length,
  };
}
