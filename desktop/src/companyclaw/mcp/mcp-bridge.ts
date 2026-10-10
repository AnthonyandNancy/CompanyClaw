/**
 * The MCP server the agent actually connects to.
 *
 * This is the piece that was missing: the adapter, the tool map and the policy
 * facade all existed, but nothing exposed them to OpenClaw, so the model had no
 * GUI tools at all and correctly reported that it could not operate anything.
 *
 * The bridge speaks MCP over stdio, because that is what OpenClaw launches for a
 * configured server, and it exposes *only* the promoted tool surface. Two
 * properties are deliberate and are the whole reason this file exists rather
 * than the agent being wired to the broker directly:
 *
 *   * every call goes through `ComputerUseToolFacade`, so the channel, the task
 *     scope and the approval rules apply exactly as they do for a local task;
 *   * the tool definitions carry no approval field, so a model cannot approve its
 *     own request (see `validateToolCall`).
 *
 * Discovery is answered from a static list rather than from a live upstream
 * probe: the agent must see the same tool names whether or not the vendored
 * Windows-MCP payload happens to be healthy, because "the tool is missing" and
 * "the tool is broken" are different faults and only the second one is the
 * payload's.
 */

import { AGENT_TOOLS, type AgentToolDefinition } from "../tools/computer-use-tools";

export const MCP_BRIDGE_CONTRACT = "companyclaw.mcp-bridge.v1";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC error codes the bridge uses, kept to the reserved range. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export interface BridgeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type BridgeToolResult =
  | { ok: true; text: string; structured?: unknown }
  | { ok: false; text: string; reason: string };

export interface McpBridgeDependencies {
  /** Runs one tool call through the facade; the bridge never bypasses it. */
  callTool: (call: BridgeToolCall) => Promise<BridgeToolResult>;
  /** Optional hook for the log; receives every rejected or failed call. */
  onDiagnostic?: (message: string) => void;
}

/**
 * The MCP `inputSchema` for one tool.
 *
 * Written per tool rather than generated, because the schema *is* the model's
 * instructions: it is where "give me a verified coordinate" and "name the
 * window" are communicated. A generic `{type: "object"}` would invite exactly
 * the guesses the policy layer then has to refuse.
 */
export function toolInputSchema(definition: AgentToolDefinition): Record<string, unknown> {
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const stringType = { type: "string" };
  const coordinate = {
    type: "array",
    items: { type: "number" },
    minItems: 2,
    maxItems: 2,
    description: "屏幕坐标 [x, y]，必须来自最近一次界面读取",
  };

  switch (definition.name) {
    case "list-installed-apps":
    case "list-windows":
    case "screenshot":
      return object({});
    case "launch-app":
      return object({ app: { ...stringType, description: "已安装应用的显示名，不接受路径" } }, ["app"]);
    case "focus-window":
      return object(
        {
          windowTitle: { ...stringType, description: "窗口标题（用于定位目标窗口）" },
          processName: { ...stringType, description: "进程名（不含 .exe）" },
        },
        [],
      );
    case "snapshot-ui-tree":
    case "verify-state":
      return object({ windowTitle: stringType });
    case "find-control":
      return object(
        {
          label: { ...stringType, description: "控件名称或可访问标签" },
          windowTitle: stringType,
        },
        ["label"],
      );
    case "read-control":
      return object({ label: stringType, windowTitle: stringType }, ["label"]);
    case "click":
      return object(
        {
          x: { type: "number" },
          y: { type: "number" },
          windowTitle: stringType,
          clicks: { type: "number", description: "0=悬停，1=单击，2=双击" },
        },
        ["x", "y"],
      );
    case "type-text":
      return object(
        {
          text: { ...stringType, description: "要输入的文本，支持中文" },
          windowTitle: stringType,
          clear: { type: "boolean", description: "是否先清空现有内容" },
          pressEnter: { type: "boolean", description: "输入后是否回车提交" },
        },
        ["text"],
      );
    case "hotkey":
      return object(
        { keys: { ...stringType, description: "快捷键组合，如 ctrl+c、ctrl+v" } },
        ["keys"],
      );
    case "scroll":
      return object({
        x: { type: "number" },
        y: { type: "number" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        wheelTimes: { type: "number" },
        windowTitle: stringType,
      });
    case "drag-drop":
      return object(
        {
          from: coordinate,
          to: coordinate,
          sourceWindow: stringType,
          targetWindow: stringType,
        },
        ["from", "to", "sourceWindow", "targetWindow"],
      );
    case "wait-for-condition":
      return object({
        text: stringType,
        windowTitle: stringType,
        timeoutSeconds: { type: "number", description: "等待上限（秒），最大 120" },
      });
    case "inspect-dialog":
      return object({ windowTitle: stringType });
    default:
      // An unknown tool must not gain a permissive schema by default.
      return object({}, []);
  }
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * What `tools/list` returns.
 *
 * Counted from this product's own tool surface — not from the upstream server's
 * — because the employee-facing claim is about what CompanyClaw will actually
 * do on their behalf.
 */
export function describeTools(): McpToolDescriptor[] {
  return AGENT_TOOLS.map((definition: AgentToolDefinition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: toolInputSchema(definition),
  }));
}

export function buildInitializeResult(): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "companyclaw-computer-use", version: "1.0.0" },
    instructions:
      "CompanyClaw 电脑操作工具：可以打开已安装应用、读取界面元素、点击、输入、滚动与拖拽。" +
      "所有调用都会经过本机权限判定；敏感操作需要用户本人确认，被拒绝时不要重试同样的动作。",
  };
}

export function buildToolsListResult(): Record<string, unknown> {
  return { tools: describeTools() };
}

/**
 * Handles one parsed JSON-RPC message and returns the response, or null for a
 * notification (which must not be answered).
 */
export async function handleBridgeMessage(
  message: JsonRpcMessage,
  deps: McpBridgeDependencies,
): Promise<JsonRpcMessage | null> {
  const method = message.method;

  if (method === "initialize") {
    return { jsonrpc: "2.0", id: message.id, result: buildInitializeResult() };
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return null;
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id: message.id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: buildToolsListResult() };
  }
  if (method === "tools/call") {
    return await handleToolCall(message, deps);
  }
  return {
    jsonrpc: "2.0",
    ...(message.id !== undefined ? { id: message.id } : {}),
    error: { code: RPC_METHOD_NOT_FOUND, message: `unsupported method: ${String(method)}` },
  };
}

async function handleToolCall(
  message: JsonRpcMessage,
  deps: McpBridgeDependencies,
): Promise<JsonRpcMessage> {
  const params = message.params;
  if (typeof params !== "object" || params === null) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: RPC_INVALID_PARAMS, message: "tools/call requires a params object" },
    };
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: RPC_INVALID_PARAMS, message: "tools/call requires a tool name" },
    };
  }
  const rawArguments = (params as { arguments?: unknown }).arguments;
  const args =
    typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)
      ? (rawArguments as Record<string, unknown>)
      : {};

  const result = await deps.callTool({ name, arguments: args });
  if (result.ok) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: result.text }],
        ...(result.structured !== undefined ? { structuredContent: result.structured } : {}),
      },
    };
  }

  // A refusal is a *result*, not a protocol error: the model has to see the
  // reason and adjust, and an MCP error would only surface as a transport fault.
  deps.onDiagnostic?.(`tool ${name} refused: ${result.reason}`);
  return {
    jsonrpc: "2.0",
    id: message.id,
    result: {
      isError: true,
      content: [{ type: "text", text: result.text }],
    },
  };
}

/**
 * Parses one stdio frame.
 *
 * A malformed line is reported as a parse error rather than being dropped
 * silently, so a caller cannot be left waiting for a response that never comes.
 */
export function parseBridgeFrame(line: string): JsonRpcMessage | { parseError: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { parseError: "frame must be a JSON object" };
    }
    return parsed as JsonRpcMessage;
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error) };
  }
}

export function encodeBridgeFrame(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * The `mcp.servers` entry OpenClaw needs.
 *
 * The agent spawns this command and speaks MCP over its stdio; the process
 * itself is a thin proxy to the main process, because the permission document,
 * the task store and the policy engine all live there and a second copy would be
 * a second source of truth.
 *
 * The interpreter is the same private Node the broker already runs on: a system
 * Node is not the runtime this product validated, and the employee's machine is
 * required to have none installed.
 */
export const MCP_SERVER_NAME = "companyclaw-computer-use";

export interface McpServerEntryInput {
  /** Loopback port the main process listens on. */
  port: number;
  /** Per-launch secret; never written to a log and never put in the URL. */
  token: string;
}

/**
 * Builds the server entry.
 *
 * The transport is **streamable-http on loopback**, not `stdio`, and that choice
 * is not cosmetic. OpenClaw launches a `stdio` server by spawning a child
 * process, and this machine's AppContainer sandbox rewrites that spawn — the
 * child starts and immediately reports "Connection closed", so the agent ends up
 * with no tools at all. That was the observed failure, twice.
 *
 * Pointing at a loopback URL avoids the child process entirely: the main process
 * already listens, and the sandbox demonstrably permits loopback HTTP (the
 * Gateway reaches its model provider at `http://127.0.0.1:8317` the same way).
 *
 * The security properties are unchanged: the listener is bound to 127.0.0.1, and
 * every request must carry the per-launch token, which travels in a header rather
 * than in the URL so it does not end up in a log.
 */
export function buildMcpServerEntry(input: McpServerEntryInput): Record<string, unknown> {
  return {
    transport: "streamable-http",
    url: `http://127.0.0.1:${input.port}/mcp`,
    headers: { "X-CompanyClaw-Token": input.token },
  };
}

/**
 * Writes the server entry into an existing OpenClaw config object.
 *
 * Only the one key is touched: every other setting belongs to the employee or to
 * the other installers, and rewriting them would be the kind of silent config
 * edit this project has already been burned by. `mcp.servers` is the key
 * OpenClaw reads for user-configured servers (verified against
 * `dist/mcp-connection-resolver-*.mjs` in the pinned release).
 */
export function applyMcpServerConfig(
  config: Record<string, unknown>,
  entry: Record<string, unknown>,
): { config: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...config };
  const mcp =
    typeof next.mcp === "object" && next.mcp !== null && !Array.isArray(next.mcp)
      ? { ...(next.mcp as Record<string, unknown>) }
      : {};
  const servers =
    typeof mcp.servers === "object" && mcp.servers !== null && !Array.isArray(mcp.servers)
      ? { ...(mcp.servers as Record<string, unknown>) }
      : {};

  const current = servers[MCP_SERVER_NAME];
  if (JSON.stringify(current) === JSON.stringify(entry)) {
    return { config, changed: false };
  }
  servers[MCP_SERVER_NAME] = entry;
  mcp.servers = servers;
  next.mcp = mcp;
  return { config: next, changed: true };
}

/** Removes this product's server entry, leaving every other setting alone. */
export function removeMcpServerConfig(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  changed: boolean;
} {
  const mcp = config.mcp;
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    return { config, changed: false };
  }
  const servers = (mcp as Record<string, unknown>).servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { config, changed: false };
  }
  if (!Object.hasOwn(servers as Record<string, unknown>, MCP_SERVER_NAME)) {
    return { config, changed: false };
  }
  const nextServers = { ...(servers as Record<string, unknown>) };
  delete nextServers[MCP_SERVER_NAME];
  return {
    config: { ...config, mcp: { ...(mcp as Record<string, unknown>), servers: nextServers } },
    changed: true,
  };
}
