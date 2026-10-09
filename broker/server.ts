import { createServer, type Server, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerPolicy, type BrokerPolicyConfig } from "./policy";
import {
  buildBrokerResponse,
  parseBrokerRequest,
  type BrokerRequest,
  type BrokerOutcome,
} from "./protocol";
import {
  runFindElements,
  runInvokePattern,
  runListWindows,
  runReadValue,
  runSendKeys,
  runSetValue,
  type ElementDescriptor,
  type ElementSelector,
  type ElementSummary,
  type WindowDescriptor,
  type WindowIdentity,
} from "./uia";

/**
 * Broker IPC server.
 *
 * Transport is a loopback-only TCP socket bound to 127.0.0.1 with a per-run
 * token. It never listens on a public interface, and every request is
 * re-authorized by BrokerPolicy before any UIA call happens. This is the
 * "narrowing proxy" the architecture decision requires: the agent reaches UIA
 * only through this gate.
 */

export const BROKER_DEFAULT_PORT = 0;

export interface BrokerServerOptions {
  policyConfig: BrokerPolicyConfig;
  /** Directory holding the PowerShell probe scripts. */
  scriptDir: string;
  /** Execution token; the client must present it or the connection is dropped. */
  token: string;
  now?: () => Date;
  verifyTicket?: (request: BrokerRequest) => boolean;
  listWindows?: (options: {
    scriptDir: string;
  }) => Promise<{ ok: true; value: WindowDescriptor[] } | { ok: false; reason: string }>;
  /** Injectable element reader; defaults to the real UIA probe. */
  findElements?: (options: FindElementsProbeOptions) => Promise<
    | {
        ok: true;
        value: { window: { name: string; processId: number }; elements: ElementDescriptor[] };
      }
    | { ok: false; reason: string }
  >;
  /** Injectable element operations; default to the real UIA probes. */
  readValue?: (options: ElementOperationOptions) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          value: string | null;
          valueReadable: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  setValue?: (options: ElementOperationOptions & { newValue: string }) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          previousValue: string | null;
          newValue: string;
          observedValue: string | null;
          verified: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  invokePattern?: (
    options: ElementOperationOptions & { pattern?: "Invoke" | "SelectionItem" },
  ) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          pattern: string;
          invoked: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  sendKeys?: (options: ElementOperationOptions & { text: string; append?: boolean }) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          typed: string;
          expected: string;
          observedValue: string | null;
          verified: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  /** Overridable so tests do not have to wait real time. */
  wait?: (ms: number) => Promise<void>;
}

export interface ElementOperationOptions {
  scriptDir: string;
  processName: string;
  windowTitle?: string;
  selector: ElementSelector;
  maxDepth?: number;
  maxVisited?: number;
}

export interface FindElementsProbeOptions {
  scriptDir: string;
  processName: string;
  windowTitle?: string;
  maxDepth?: number;
  maxElements?: number;
}

export interface BrokerServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** One line in, one line out. Oversized input is rejected, not buffered. */
const MAX_FRAME_BYTES = 256 * 1024;

interface BrokerFrame {
  token?: string;
  request?: unknown;
}

export function resolveDefaultScriptDir(baseDir: string): string {
  return path.join(baseDir, "scripts");
}

export function defaultScriptDir(): string {
  // dist/main.js -> repo/broker/scripts
  return path.join(__dirname, "scripts");
}

export async function startBrokerServer(options: BrokerServerOptions): Promise<BrokerServerHandle> {
  const now = options.now ?? (() => new Date());
  const policy = new BrokerPolicy(options.policyConfig, {
    now,
    verifyTicket: options.verifyTicket,
  });
  const listWindows =
    options.listWindows ?? ((opts) => runListWindows({ scriptDir: opts.scriptDir }));
  const findElements =
    options.findElements ?? ((opts) => runFindElements({ ...opts, scriptDir: opts.scriptDir }));
  const readValue =
    options.readValue ?? ((opts) => runReadValue({ ...opts, scriptDir: opts.scriptDir }));
  const setValue =
    options.setValue ?? ((opts) => runSetValue({ ...opts, scriptDir: opts.scriptDir }));
  const invokePattern =
    options.invokePattern ?? ((opts) => runInvokePattern({ ...opts, scriptDir: opts.scriptDir }));
  const sendKeys =
    options.sendKeys ?? ((opts) => runSendKeys({ ...opts, scriptDir: opts.scriptDir }));
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const server: Server = createServer((socket) => {
    handleConnection(socket, {
      policy,
      scriptDir: options.scriptDir,
      token: options.token,
      now,
      listWindows,
      findElements,
      readValue,
      setValue,
      invokePattern,
      sendKeys,
      wait,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: never 0.0.0.0, and never a LAN-reachable interface.
    server.listen(BROKER_DEFAULT_PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface ConnectionContext {
  policy: BrokerPolicy;
  scriptDir: string;
  token: string;
  now: () => Date;
  listWindows: (options: {
    scriptDir: string;
  }) => Promise<{ ok: true; value: WindowDescriptor[] } | { ok: false; reason: string }>;
  findElements: (options: FindElementsProbeOptions) => Promise<
    | {
        ok: true;
        value: { window: { name: string; processId: number }; elements: ElementDescriptor[] };
      }
    | { ok: false; reason: string }
  >;
  readValue: (options: ElementOperationOptions) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          value: string | null;
          valueReadable: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  setValue: (options: ElementOperationOptions & { newValue: string }) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          previousValue: string | null;
          newValue: string;
          observedValue: string | null;
          verified: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  invokePattern: (
    options: ElementOperationOptions & { pattern?: "Invoke" | "SelectionItem" },
  ) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          pattern: string;
          invoked: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  sendKeys: (options: ElementOperationOptions & { text: string; append?: boolean }) => Promise<
    | {
        ok: true;
        value: {
          window: WindowIdentity;
          element: ElementSummary;
          typed: string;
          expected: string;
          observedValue: string | null;
          verified: boolean;
        };
      }
    | { ok: false; reason: string }
  >;
  /**
   * Pause between window-list polls; injectable so wait-for-window can be
   * tested without real delays.
   */
  wait: (ms: number) => Promise<void>;
}

function handleConnection(socket: Socket, context: ConnectionContext): void {
  let buffer = "";
  socket.setEncoding("utf8");

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      void respondToLine(socket, line, context);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  socket.on("error", () => {
    socket.destroy();
  });
}

async function respondToLine(
  socket: Socket,
  line: string,
  context: ConnectionContext,
): Promise<void> {
  const outcome = await handleLine(line, context);
  socket.write(`${JSON.stringify(outcome)}\n`);
}

async function handleLine(line: string, context: ConnectionContext): Promise<unknown> {
  let frame: BrokerFrame;
  try {
    frame = JSON.parse(line) as BrokerFrame;
  } catch {
    return buildBrokerResponse({
      requestId: "unknown",
      outcome: { status: "rejected", reason: "malformed-frame" },
      now: context.now,
    });
  }

  if (typeof frame?.token !== "string" || frame.token !== context.token) {
    return buildBrokerResponse({
      requestId: "unknown",
      outcome: { status: "rejected", reason: "bad-token" },
      now: context.now,
    });
  }

  const parsed = parseBrokerRequest(frame.request);
  if (!parsed.ok) {
    return buildBrokerResponse({
      requestId: "unknown",
      outcome: { status: "rejected", reason: parsed.reason },
      now: context.now,
    });
  }

  const request = parsed.request;
  const authorization = context.policy.authorize(request);
  if (!authorization.allowed) {
    return buildBrokerResponse({
      requestId: request.requestId,
      outcome: { status: "rejected", reason: authorization.reason },
      now: context.now,
    });
  }

  const outcome = await executeAuthorized(request, context);
  return buildBrokerResponse({ requestId: request.requestId, outcome, now: context.now });
}

/**
 * Only read-only operations are implemented here. Mutating operations parse and
 * authorize today but report `not-implemented` rather than pretending to work —
 * a fake success would be exactly the "misreport as done" failure the
 * requirements forbid.
 */
export async function executeAuthorized(
  request: BrokerRequest,
  context: Pick<
    ConnectionContext,
    | "scriptDir"
    | "listWindows"
    | "findElements"
    | "readValue"
    | "setValue"
    | "invokePattern"
    | "sendKeys"
    | "wait"
    | "now"
  >,
): Promise<BrokerOutcome> {
  switch (request.operation) {
    case "list-windows": {
      const result = await context.listWindows({ scriptDir: context.scriptDir });
      if (!result.ok) return { status: "failed", reason: result.reason };
      const processName = request.target?.processName;
      // Filter on the real executable base name the OS reported. The policy has
      // already vetted it; this only narrows the output to the target app.
      const windows = processName
        ? result.value.filter(
            (window) =>
              window.processName.replace(/\.exe$/i, "").toLowerCase() ===
              processName.replace(/\.exe$/i, "").toLowerCase(),
          )
        : result.value;
      return { status: "ok", data: { windows } };
    }
    case "find-elements": {
      const processName = request.target?.processName;
      if (!processName) return { status: "rejected", reason: "target-required" };
      const maxDepth =
        typeof request.args?.maxDepth === "number" ? request.args.maxDepth : undefined;
      const maxElements =
        typeof request.args?.maxElements === "number" ? request.args.maxElements : undefined;
      const result = await context.findElements({
        scriptDir: context.scriptDir,
        processName,
        ...(request.target?.windowTitle ? { windowTitle: request.target.windowTitle } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxElements !== undefined ? { maxElements } : {}),
      });
      if (!result.ok) return { status: "failed", reason: result.reason };
      return { status: "ok", data: result.value };
    }
    case "read-value": {
      const elementOptions = buildElementOptions(request, context.scriptDir);
      if (!elementOptions.ok) return { status: "rejected", reason: elementOptions.reason };
      const result = await context.readValue(elementOptions.value);
      if (!result.ok) return { status: "failed", reason: result.reason };
      return { status: "ok", data: result.value };
    }
    case "set-value": {
      const elementOptions = buildElementOptions(request, context.scriptDir);
      if (!elementOptions.ok) return { status: "rejected", reason: elementOptions.reason };
      const newValue = request.args?.newValue;
      if (typeof newValue !== "string") {
        return { status: "rejected", reason: "missing-new-value" };
      }
      const result = await context.setValue({ ...elementOptions.value, newValue });
      if (!result.ok) return { status: "failed", reason: result.reason };
      // A write that did not survive read-back is not a success. The operation
      // ran, but the broker must not claim the change took effect.
      if (!result.value.verified) {
        return {
          status: "failed",
          reason: "verification-failed",
        };
      }
      return { status: "ok", data: result.value };
    }
    case "invoke-pattern": {
      const elementOptions = buildElementOptions(request, context.scriptDir);
      if (!elementOptions.ok) return { status: "rejected", reason: elementOptions.reason };
      const pattern = request.args?.pattern;
      if (pattern !== undefined && pattern !== "Invoke" && pattern !== "SelectionItem") {
        return { status: "rejected", reason: "unsupported-pattern" };
      }
      const result = await context.invokePattern({
        ...elementOptions.value,
        ...(pattern ? { pattern } : {}),
      });
      if (!result.ok) return { status: "failed", reason: result.reason };
      if (!result.value.invoked) return { status: "failed", reason: "invoke-not-confirmed" };
      return { status: "ok", data: result.value };
    }
    case "send-keys": {
      const elementOptions = buildElementOptions(request, context.scriptDir);
      if (!elementOptions.ok) return { status: "rejected", reason: elementOptions.reason };
      const text = request.args?.text;
      if (typeof text !== "string" || text.length === 0) {
        return { status: "rejected", reason: "missing-text" };
      }
      const append = request.args?.append === true;
      const result = await context.sendKeys({ ...elementOptions.value, text, append });
      if (!result.ok) return { status: "failed", reason: result.reason };
      if (!result.value.verified) {
        // The text did not reach the control; never report that it did.
        return { status: "failed", reason: "verification-failed" };
      }
      return { status: "ok", data: result.value };
    }
    case "describe-element": {
      // Reuses the existing control-tree probe: an element summary already
      // carries name / automationId / controlType / className / isEnabled /
      // processId, which is what a caller needs to address a control without
      // ever relying on screen coordinates.
      const processName = request.target?.processName;
      if (!processName) return { status: "rejected", reason: "target-required" };
      // Validate the request before touching the desktop: a malformed selector
      // must not cost a probe.
      const selector = normalizeElementSelector(request.args?.selector);
      if (!selector.ok) return { status: "rejected", reason: selector.reason };
      const described = await context.findElements({
        scriptDir: context.scriptDir,
        processName,
        ...(request.target?.windowTitle ? { windowTitle: request.target.windowTitle } : {}),
        ...(typeof request.args?.maxDepth === "number" ? { maxDepth: request.args.maxDepth } : {}),
        ...(typeof request.args?.maxElements === "number"
          ? { maxElements: request.args.maxElements }
          : {}),
      });
      if (!described.ok) return { status: "failed", reason: described.reason };
      const matchedElements = selector.value;
      const matched = matchedElements
        ? described.value.elements.filter((element) => matchesSelector(element, matchedElements))
        : described.value.elements;
      // Ambiguity is reported rather than resolved: silently picking one of
      // several matches would automate whichever record the tree happened to
      // list first.
      return {
        status: "ok",
        data: {
          window: described.value.window,
          elements: matched,
          matchCount: matched.length,
          unique: matched.length === 1,
        },
      };
    }
    case "wait-for-window": {
      const processName = request.target?.processName;
      if (!processName) return { status: "rejected", reason: "target-required" };
      const timeoutMs = readBoundedNumber(request.args?.timeoutMs, 30_000, 1_000, 120_000);
      if (timeoutMs === null) return { status: "rejected", reason: "invalid-timeout" };
      const windowTitle = request.target?.windowTitle;
      const wanted = processName.replace(/\.exe$/i, "").toLowerCase();
      // Uses the context clock rather than Date.now(): the deadline then
      // follows the same notion of time as the rest of the request, so a test
      // can drive it without waiting for the wall clock.
      const deadline = context.now().getTime() + timeoutMs;
      for (;;) {
        const listed = await context.listWindows({ scriptDir: context.scriptDir });
        if (!listed.ok) return { status: "failed", reason: listed.reason };
        const found = listed.value.filter(
          (window) =>
            window.processName.replace(/\.exe$/i, "").toLowerCase() === wanted &&
            (!windowTitle || window.name.includes(windowTitle)),
        );
        if (found.length > 0) return { status: "ok", data: { windows: found } };
        if (context.now().getTime() >= deadline) {
          // Its own reason: "the window never appeared" is a different fault
          // from "the probe failed", and callers react differently to each.
          return { status: "failed", reason: "wait-timeout" };
        }
        await context.wait(WINDOW_POLL_INTERVAL_MS);
      }
    }
    default:
      return { status: "rejected", reason: "unsupported-operation" };
  }
}

/** How often wait-for-window re-reads the window list while waiting. */
const WINDOW_POLL_INTERVAL_MS = 500;

/** Parses a numeric argument, bounded on both sides; null when unusable. */
function readBoundedNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < min || raw > max) return null;
  return raw;
}

/**
 * Normalizes a `describe-element` selector.
 *
 * An empty selector is rejected: without a filter the caller would receive the
 * whole tree and could then act on the wrong control.
 */
function normalizeElementSelector(
  raw: unknown,
): { ok: true; value: ElementSelector | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, reason: "invalid-selector" };
  const record = raw as Record<string, unknown>;
  const selector: ElementSelector = {};
  for (const key of ["automationId", "name", "controlType", "className"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) selector[key] = value;
  }
  if (Object.keys(selector).length === 0) return { ok: false, reason: "empty-selector" };
  return { ok: true, value: selector };
}

function matchesSelector(element: ElementSummary, selector: ElementSelector): boolean {
  if (selector.automationId && element.automationId !== selector.automationId) return false;
  if (selector.controlType && element.controlType !== selector.controlType) return false;
  if (selector.className && element.className !== selector.className) return false;
  // Names are matched by containment: controls often prefix their label with
  // state ("* Amount"), and an exact match would find nothing.
  if (selector.name && !element.name.includes(selector.name)) return false;
  return true;
}

/** Builds the element-addressing options the three element scripts share. */
function buildElementOptions(
  request: BrokerRequest,
  scriptDir: string,
): { ok: true; value: ElementOperationOptions } | { ok: false; reason: string } {
  const processName = request.target?.processName;
  if (!processName) return { ok: false, reason: "target-required" };
  const selectorRaw = request.args?.selector;
  if (typeof selectorRaw !== "object" || selectorRaw === null) {
    return { ok: false, reason: "missing-selector" };
  }
  const selectorRecord = selectorRaw as Record<string, unknown>;
  const selector: ElementSelector = {};
  for (const key of ["automationId", "name", "controlType", "className"] as const) {
    const value = selectorRecord[key];
    if (typeof value === "string" && value.length > 0) selector[key] = value;
  }
  if (typeof selectorRecord.index === "number" && Number.isInteger(selectorRecord.index)) {
    if (selectorRecord.index < 0) return { ok: false, reason: "invalid-selector-index" };
    selector.index = selectorRecord.index;
  }
  // An empty selector would address the first arbitrary descendant, which is
  // exactly the "click something that looks right" failure the requirements
  // forbid.
  if (Object.keys(selector).length === 0) {
    return { ok: false, reason: "empty-selector" };
  }
  const maxDepth = typeof request.args?.maxDepth === "number" ? request.args.maxDepth : undefined;
  const maxVisited =
    typeof request.args?.maxVisited === "number" ? request.args.maxVisited : undefined;
  return {
    ok: true,
    value: {
      scriptDir,
      processName,
      selector,
      ...(request.target?.windowTitle ? { windowTitle: request.target.windowTitle } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxVisited !== undefined ? { maxVisited } : {}),
    },
  };
}

export function describeHost(): { hostname: string; platform: NodeJS.Platform } {
  return { hostname: os.hostname(), platform: process.platform };
}
