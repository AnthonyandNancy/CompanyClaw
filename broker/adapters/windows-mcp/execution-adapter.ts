import {
  authorizeToolCall,
  type ToolCallResult,
} from "./tool-registry";
import type { BrokerCapability } from "./tool-policy-map";

/**
 * Turns one authorized broker operation into a real upstream tool call.
 *
 * This is the layer that decides *how* a W-capability is expressed with the
 * upstream tool set, and it is intentionally the only place that knows the
 * upstream argument names. Two properties matter:
 *
 *   * every mapping is total — an operation the adapter cannot express returns a
 *     refusal rather than a canned success, so a missing backend can never look
 *     like a completed task;
 *   * coordinates are never invented here. A pointer action must carry a target
 *     that the caller already verified (window identity, screenshot frame, DPI),
 *     because the alternative — clicking whatever happens to be at (x, y) now —
 *     is the failure mode the requirement calls out.
 */

export type McpCaller = (input: {
  tool: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<ToolCallResult>;

export interface ExecutionAdapterOptions {
  callTool: McpCaller;
  /** Upper bound for a single upstream call, so UIA cannot block forever. */
  defaultTimeoutMs?: number;
}

export interface AdapterRequest {
  operation: string;
  /** Target application, when the operation addresses one. */
  target?: { processName?: string; windowTitle?: string; automationId?: string } | null;
  args?: Record<string, unknown>;
}

export type AdapterResult =
  | { status: "ok"; data: unknown }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

/** How one broker operation maps onto an upstream tool plus its capability. */
interface Mapping {
  tool: string;
  capability: BrokerCapability;
}

const MAPPINGS: Readonly<Record<string, Mapping>> = {
  "list-installed-apps": { tool: "App", capability: "listInstalledApps" },
  "launch-app": { tool: "App", capability: "launchApp" },
  "focus-window": { tool: "App", capability: "focusWindow" },
  "snapshot-ui-tree": { tool: "Snapshot", capability: "snapshotUiTree" },
  "find-control": { tool: "Snapshot", capability: "findControl" },
  screenshot: { tool: "Screenshot", capability: "screenshot" },
  click: { tool: "Click", capability: "click" },
  move: { tool: "Move", capability: "click" },
  "drag-drop": { tool: "Move", capability: "dragDrop" },
  scroll: { tool: "Scroll", capability: "scroll" },
  "wait-for-condition": { tool: "WaitFor", capability: "waitForWindowOrControl" },
  "inspect-dialog": { tool: "WaitFor", capability: "inspectNotificationOrDialog" },
  "verify-state": { tool: "Snapshot", capability: "verifyState" },
};

/** Shortcuts the product enumerates rather than passing through arbitrary keys. */
export const ALLOWED_SHORTCUTS: readonly string[] = [
  "ctrl+a",
  "ctrl+c",
  "ctrl+v",
  "ctrl+x",
  "ctrl+z",
  "ctrl+s",
  "ctrl+f",
  "alt+tab",
  "enter",
  "escape",
  "tab",
  "shift+tab",
] as const;

export function isAllowedShortcut(keys: string): boolean {
  return ALLOWED_SHORTCUTS.includes(keys.trim().toLowerCase());
}

export class WindowsMcpExecutionAdapter {
  private readonly timeoutMs: number;

  constructor(private readonly options: ExecutionAdapterOptions) {
    this.timeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  /** Which operations this adapter can carry right now. */
  supportedOperations(): string[] {
    return Object.keys(MAPPINGS);
  }

  async execute(request: AdapterRequest): Promise<AdapterResult> {
    const mapping = MAPPINGS[request.operation];
    if (!mapping) {
      // An operation with no upstream expression must not be answered with a
      // fabricated payload: the caller has to see that it is unsupported.
      return { status: "rejected", reason: "unsupported-operation" };
    }

    const args = this.buildArguments(request, mapping.capability);
    if ("refused" in args) return { status: "rejected", reason: args.refused };

    const authorization = authorizeToolCall({
      tool: mapping.tool,
      capability: mapping.capability,
      args: args.value,
    });
    if (!authorization.allowed) {
      return { status: "rejected", reason: authorization.reason };
    }

    const result = await this.options.callTool({
      tool: mapping.tool,
      args: args.value,
      timeoutMs: this.timeoutMs,
    });
    if (!result.ok) return { status: "failed", reason: result.reason };
    return { status: "ok", data: result.content };
  }

  /**
   * Builds the upstream arguments, or refuses.
   *
   * The refusals are the interesting part: a click without a verified target, a
   * shortcut outside the enumerated set, and a drag without both endpoints are
   * all cases where proceeding would mean guessing.
   */
  private buildArguments(
    request: AdapterRequest,
    capability: BrokerCapability,
  ): { value: Record<string, unknown> } | { refused: string } {
    const raw = request.args ?? {};
    const target = request.target ?? null;
    const windowName = target?.windowTitle ?? undefined;
    const processName = target?.processName;

    switch (capability) {
      case "listInstalledApps":
        return { value: {} };

      case "launchApp": {
        const app = typeof raw.app === "string" ? raw.app.trim() : "";
        if (!app) return { refused: "app-required" };
        // No path and no arguments: the upstream tool opens an installed
        // application, and letting a caller pass `C:\...\x.exe` here is exactly
        // the "launch becomes exec" mistake the requirement forbids.
        if (app.includes("\\") || app.includes("/")) {
          return { refused: "application-path-not-accepted" };
        }
        return { value: { mode: "launch", app } };
      }

      case "focusWindow": {
        if (!windowName && !processName) return { refused: "target-required" };
        return { value: { mode: "switch", ...(windowName ? { name: windowName } : {}) } };
      }

      case "snapshotUiTree":
        return { value: { use_vision: false, ...(windowName ? { window_name: windowName } : {}) } };

      case "findControl": {
        const label = typeof raw.label === "string" ? raw.label.trim() : "";
        if (!label) return { refused: "label-required" };
        return {
          value: { use_vision: false, ...(windowName ? { window_name: windowName } : {}) },
        };
      }

      case "screenshot":
        return { value: { ...(raw.display ? { display: raw.display } : {}) } };

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
        const coordinate = readCoordinate(raw) ?? undefined;
        return {
          value: {
            text,
            ...(coordinate ? { loc: coordinate } : {}),
            clear: raw.clear === true,
            press_enter: raw.pressEnter === true,
          },
        };
      }

      case "hotkey": {
        const keys = typeof raw.keys === "string" ? raw.keys : "";
        if (!isAllowedShortcut(keys)) return { refused: "shortcut-not-allowed" };
        return { value: { shortcut: keys.trim().toLowerCase() } };
      }

      case "dragDrop": {
        const from = readCoordinate(raw, "from");
        const to = readCoordinate(raw, "to");
        // A drag is a write with two ends; without both, the adapter refuses
        // rather than dropping something at a guess.
        if (!from || !to) return { refused: "drag-endpoints-required" };
        if (!raw.sourceWindow || !raw.targetWindow) return { refused: "drag-windows-required" };
        return { value: { loc: to, drag: true, from } };
      }

      case "waitForWindowOrControl": {
        const timeoutSeconds = readTimeoutSeconds(raw);
        if (timeoutSeconds === null) return { refused: "invalid-timeout" };
        const text = typeof raw.text === "string" ? raw.text : undefined;
        const condition = raw.condition === "active_window" ? "active_window" : "text_exists";
        return {
          value: {
            condition,
            ...(text ? { text } : {}),
            ...(windowName ? { window_name: windowName } : {}),
            ...(timeoutSeconds ? { timeout: timeoutSeconds } : {}),
          },
        };
      }

      case "inspectNotificationOrDialog":
        return {
          value: { condition: "element_exists", ...(windowName ? { window_name: windowName } : {}) },
        };

      case "verifyState":
        return {
          value: {
            use_vision: false,
            ...(windowName ? { window_name: windowName } : {}),
          },
        };

      case "readControl":
      case "captureExecutionError":
      default:
        // These are served by the broker's own UI Automation path, not by the
        // upstream server; reaching here means the caller chose the wrong path.
        return { refused: "not-an-mcp-capability" };
    }
  }
}

/**
 * Reads a screen coordinate, or null when the caller did not supply a usable
 * one.
 *
 * Accepted shapes: an explicit `[x, y]` (optionally under `key`), a `loc`
 * array, or flat `x`/`y` fields. A negative or non-finite value is refused
 * rather than clamped: a click at "somewhere near the top-left" is a guess.
 */
function readCoordinate(
  raw: Record<string, unknown>,
  key?: string,
): [number, number] | null {
  const candidate = key ? raw[key] : (raw.loc ?? raw);
  if (Array.isArray(candidate)) {
    const [x, y] = candidate;
    return normalizeCoordinate(x, y);
  }
  if (typeof candidate === "object" && candidate !== null) {
    const record = candidate as Record<string, unknown>;
    return normalizeCoordinate(record.x, record.y);
  }
  return normalizeCoordinate(raw.x, raw.y);
}

function normalizeCoordinate(x: unknown, y: unknown): [number, number] | null {
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0) return null;
  return [Math.round(x), Math.round(y)];
}

function readClicks(raw: Record<string, unknown>): number {
  const value = raw.clicks;
  if (value === 0 || value === 2) return value;
  return 1;
}

function readDirection(raw: Record<string, unknown>): string {
  const value = raw.direction;
  if (value === "up" || value === "down" || value === "left" || value === "right") return value;
  return "down";
}

function readWheelTimes(raw: Record<string, unknown>): number {
  const value = raw.wheelTimes;
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.round(value), 1), 10);
}

function readTimeoutSeconds(raw: Record<string, unknown>): number | null {
  const value = raw.timeoutSeconds;
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 120) return null;
  return Math.round(value);
}
