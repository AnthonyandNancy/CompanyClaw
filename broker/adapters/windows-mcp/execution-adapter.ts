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
  /**
   * Resolves a window title for one process name.
   *
   * `focus-window` may be called with only a process name, but the upstream
   * switch mode matches on *window titles*. Without a title the server raises a
   * Python error instead of refusing, so the adapter resolves one first and
   * refuses cleanly when the process owns no window.
   */
  resolveWindowTitle?: (processName: string) => Promise<string | null>;
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

/** An upstream call that has to succeed before the operation itself runs. */
interface PreludeCall {
  tool: string;
  capability: BrokerCapability;
  args: Record<string, unknown>;
}

/**
 * The upstream arguments plus whatever must happen first.
 *
 * A window-scoped read needs a prelude rather than a parameter: `Snapshot`
 * reads the *active* window and the pinned release documents only `display` and
 * `region` for scoping it, so there is no field that names another window. The
 * window is brought to the foreground first, through the same `switch` mode the
 * `focus-window` operation uses.
 */
type BuiltArguments =
  | { value: Record<string, unknown>; prelude?: PreludeCall[] }
  | { refused: string };

/** How one broker operation maps onto an upstream tool plus its capability. */
interface Mapping {
  tool: string;
  capability: BrokerCapability;
}

const MAPPINGS: Readonly<Record<string, Mapping>> = {
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
  // Text entry and shortcuts were reachable from the tool surface and implemented
  // in `buildArguments` below, but were missing from this table — so the branches
  // existed and could never be selected.
  "type-text": { tool: "Type", capability: "typeText" },
  hotkey: { tool: "Shortcut", capability: "hotkey" },
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
    // Below both the session's own default and the Gateway's MCP timeout, so a
    // slow call fails as our readable reason rather than as a transport timeout.
    this.timeoutMs = options.defaultTimeoutMs ?? 40_000;
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

    const args = await this.buildArguments(request, mapping.capability);
    if ("refused" in args) return { status: "rejected", reason: args.refused };

    // Prelude calls are checked with the same tool/capability pairing as the
    // operation itself: bringing a window forward is an `App` action, and it
    // must be permitted before anything is sent upstream.
    for (const prelude of args.prelude ?? []) {
      const allowed = authorizeToolCall({
        tool: prelude.tool,
        capability: prelude.capability,
        args: prelude.args,
      });
      if (!allowed.allowed) return { status: "rejected", reason: allowed.reason };
      try {
        const result = await this.options.callTool({
          tool: prelude.tool,
          args: prelude.args,
          timeoutMs: this.timeoutMs,
        });
        if (!result.ok) {
          // Continuing would read whichever window happens to be in front,
          // which is the failure the caller must never be shown as success.
          return { status: "rejected", reason: "window-focus-failed" };
        }
      } catch (error) {
        console.warn(`[windows-mcp] ${prelude.tool} prelude call failed:`, error);
        return { status: "failed", reason: "upstream-call-failed" };
      }
    }

    const authorization = authorizeToolCall({
      tool: mapping.tool,
      capability: mapping.capability,
      args: args.value,
    });
    if (!authorization.allowed) {
      return { status: "rejected", reason: authorization.reason };
    }

    let result: Awaited<ReturnType<McpCaller>>;
    try {
      result = await this.options.callTool({
        tool: mapping.tool,
        args: args.value,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      // A thrown upstream failure must stay a refusal with a stable code: the
      // server's own message is a Python traceback fragment, and letting it
      // through is exactly the unreadable failure this path must not produce.
      console.warn(`[windows-mcp] ${mapping.tool} call failed:`, error);
      return { status: "failed", reason: "upstream-call-failed" };
    }
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
  private async buildArguments(
    request: AdapterRequest,
    capability: BrokerCapability,
  ): Promise<BuiltArguments> {
    const raw = request.args ?? {};
    const target = request.target ?? null;
    const windowName = target?.windowTitle ?? undefined;
    const processName = target?.processName;
    /** Resolves the window this request addresses, for the reads below. */
    const focusPrelude = async (): Promise<PreludeCall[] | { refused: string }> => {
      if (windowName) {
        return [{ tool: "App", capability: "focusWindow", args: { mode: "switch", name: windowName } }];
      }
      if (!processName) return [];
      const resolved = await this.options.resolveWindowTitle?.(processName);
      if (!resolved) return { refused: "window-not-found" };
      return [{ tool: "App", capability: "focusWindow", args: { mode: "switch", name: resolved } }];
    };

    switch (capability) {
      case "listInstalledApps":
        // Served by the broker's own discovery probe, not by an upstream tool:
        // the server ships no way to enumerate installed applications.
        return { refused: "native-capability" };

      case "launchApp": {
        const app = typeof raw.app === "string" ? raw.app.trim() : "";
        if (!app) return { refused: "app-required" };
        // No path and no arguments: the upstream tool opens an installed
        // application, and letting a caller pass `C:\...\x.exe` here is exactly
        // the "launch becomes exec" mistake the requirement forbids.
        if (app.includes("\\") || app.includes("/")) {
          return { refused: "application-path-not-accepted" };
        }
        // `name` is the upstream parameter. Passing `app` left it unset, and the
        // server answers a missing name with a TypeError rather than a refusal.
        return { value: { mode: "launch", name: app } };
      }

      case "focusWindow": {
        if (!windowName && !processName) return { refused: "target-required" };
        if (windowName) return { value: { mode: "switch", name: windowName } };
        // Only a process name was addressed. The upstream switch mode matches on
        // window titles, so resolve one here; a process with no window is a
        // refusal, not a server-side exception.
        const resolved = await this.options.resolveWindowTitle?.(processName!);
        if (!resolved) return { refused: "window-not-found" };
        return { value: { mode: "switch", name: resolved } };
      }

      case "snapshotUiTree": {
        // `window_name` is not an upstream parameter — the pinned release
        // documents only `display` and `region` for scoping this call, and it
        // rejects an unknown field instead of ignoring it. The window is
        // therefore brought forward first, which is what `Snapshot` reads.
        const prelude = await focusPrelude();
        if (!Array.isArray(prelude)) return prelude;
        return { value: { use_vision: false }, ...(prelude.length ? { prelude } : {}) };
      }

      case "findControl": {
        const label = typeof raw.label === "string" ? raw.label.trim() : "";
        if (!label) return { refused: "label-required" };
        const prelude = await focusPrelude();
        if (!Array.isArray(prelude)) return prelude;
        return { value: { use_vision: false }, ...(prelude.length ? { prelude } : {}) };
      }

      case "screenshot":
        return { value: { ...(raw.display ? { display: raw.display } : {}) } };

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
        // Same reasoning as `click`: a wheel event goes to the window under the
        // pointer, so the window the coordinate came from must be in front.
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

      case "verifyState": {
        const prelude = await focusPrelude();
        if (!Array.isArray(prelude)) return prelude;
        return { value: { use_vision: false }, ...(prelude.length ? { prelude } : {}) };
      }

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
