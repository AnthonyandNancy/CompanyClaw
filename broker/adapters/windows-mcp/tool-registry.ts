import type { ToolPolicyEntry } from "./tool-policy-map";
import {
  isToolAllowedFor,
  PINNED_UPSTREAM_TOOLS,
  reconcileToolList,
  wrappedUpstreamTools,
  type BrokerCapability,
} from "./tool-policy-map";

/**
 * The MCP client half of the adapter: initialize, discover tools, call them.
 *
 * The registry exists so the product can answer "how many controlled tools are
 * loaded" with a real number, and so an upstream upgrade cannot silently change
 * what the agent can do. It records the tools the server actually advertises and
 * compares them with the pinned allow-map; the comparison is what turns an
 * unclassified tool into a refusal instead of a new capability.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type SendLine = (line: string) => Promise<void> | void;

export interface ToolRegistryOptions {
  /** Writes one JSON-RPC frame to the server's stdin. */
  send: SendLine;
  /** Milliseconds to wait for each response. */
  timeoutMs?: number;
}

export interface HandshakeResult {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  tools: McpToolDescriptor[];
  /** Tools the agent may use, from the pinned map. */
  controllable: string[];
  /** Tools the server offers that must never be called. */
  blocked: string[];
  /** Advertised but unclassified; refused until reviewed. */
  unclassified: string[];
  matchesPinnedRelease: boolean;
}

export type ToolCallResult =
  | { ok: true; content: unknown }
  | { ok: false; reason: string };

/**
 * Frames a request as a single line.
 *
 * The MCP stdio transport is line-delimited JSON, so a payload containing a raw
 * newline would be read as two frames. Encoding through `JSON.stringify` escapes
 * them, and this guard makes the invariant explicit.
 */
export function encodeFrame(message: JsonRpcRequest | JsonRpcNotification): string {
  const line = JSON.stringify(message);
  if (line.includes("\n")) {
    throw new Error("MCP frame must not contain a raw newline");
  }
  return line;
}

export function buildInitializeRequest(id = 1): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "companyclaw-broker", version: "1.0.0" },
    },
  };
}

export function buildInitializedNotification(): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
}

export function buildToolsListRequest(id = 2): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

export function buildToolCallRequest(id: number, tool: string, args: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } };
}

export function parseFramedLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // An array or a scalar is valid JSON but is not a JSON-RPC frame; treating
    // it as one would let a stray line masquerade as a server response.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readServerInfo(frame: Record<string, unknown>): {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
} | null {
  const result = frame.result;
  if (typeof result !== "object" || result === null) return null;
  const info = (result as Record<string, unknown>).serverInfo;
  if (typeof info !== "object" || info === null) return null;
  const record = info as Record<string, unknown>;
  return {
    protocolVersion: String((result as Record<string, unknown>).protocolVersion ?? ""),
    serverName: String(record.name ?? ""),
    serverVersion: String(record.version ?? ""),
  };
}

export function readToolList(frame: Record<string, unknown>): McpToolDescriptor[] {
  const result = frame.result;
  if (typeof result !== "object" || result === null) return [];
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const descriptors: McpToolDescriptor[] = [];
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    descriptors.push({
      name: record.name,
      description: typeof record.description === "string" ? record.description : undefined,
      inputSchema: record.inputSchema,
    });
  }
  return descriptors;
}

/**
 * Runs the handshake and classifies what came back.
 *
 * `matchesPinnedRelease` being false is not itself fatal — a capability may have
 * disappeared upstream without the product becoming unsafe — but the caller is
 * expected to log it, because a wrap-listed tool that vanished means the feature
 * built on it is gone.
 */
export function classifyHandshake(
  serverInfo: { protocolVersion: string; serverName: string; serverVersion: string },
  tools: McpToolDescriptor[],
): HandshakeResult {
  const names = tools.map((tool) => tool.name);
  const reconciliation = reconcileToolList(names);
  const blocked = new Set(reconciliation.denied);
  return {
    protocolVersion: serverInfo.protocolVersion,
    serverName: serverInfo.serverName,
    serverVersion: serverInfo.serverVersion,
    tools,
    controllable: names.filter((name) => !blocked.has(name) && isAllowedAnywhere(name)),
    blocked: [...blocked],
    unclassified: reconciliation.unclassified,
    matchesPinnedRelease: reconciliation.matchesPinnedRelease,
  };
}

function isAllowedAnywhere(tool: string): boolean {
  return wrappedUpstreamTools().includes(tool);
}

/**
 * Decides whether one call may proceed.
 *
 * Two independent conditions must hold, and they fail for different reasons: the
 * tool must be allowed for the capability being served, and the arguments must
 * not be a `command`/`exec` style payload that would turn a wrapped tool into an
 * arbitrary execution.
 */
export function authorizeToolCall(input: {
  tool: string;
  capability: BrokerCapability;
  args: Record<string, unknown>;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!isToolAllowedFor(input.tool, input.capability)) {
    return {
      allowed: false,
      reason: `upstream tool "${input.tool}" is not permitted for capability "${input.capability}"`,
    };
  }
  const forbidden = ["command", "code", "script", "exec", "shell", "arguments"];
  for (const key of forbidden) {
    if (key in input.args) {
      return { allowed: false, reason: `argument "${key}" is not accepted by this adapter` };
    }
  }
  return { allowed: true };
}

/**
 * The tool counts the health page shows.
 *
 * Derived from the pinned map rather than from a live handshake so the number is
 * available before the server has started; the handshake feeds
 * `classifyHandshake` when it does.
 */
export function loadedToolSummary(): { controllable: number; blocked: number; total: number } {
  const wrapped = wrappedUpstreamTools();
  return {
    controllable: wrapped.length,
    blocked: PINNED_UPSTREAM_TOOLS.length - wrapped.length,
    total: PINNED_UPSTREAM_TOOLS.length,
  };
}

export type { ToolPolicyEntry };
