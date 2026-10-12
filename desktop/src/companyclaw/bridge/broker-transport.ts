import { MUTATING_OPERATIONS as BROKER_MUTATING_OPERATIONS, type BrokerOperation } from "../broker-protocol";
import type {
  BridgeRequest,
  BridgeResponse,
  BridgeTransport,
  ImagePayload,
} from "./execution-bridge";

/**
 * Connects the execution bridge to the Windows broker.
 *
 * The bridge already decided *whether* an action may run; this module only
 * chooses which closed-set broker operation carries it and hands the ticket
 * through. The broker re-checks identity, target and ticket on its own side, so
 * nothing here can widen access even if it were wrong.
 *
 * Coordinate input is never produced: a request that cannot be expressed as
 * automation-id/name-addressed UIA carries no target and is refused instead.
 */

export interface BrokerTransportCall {
  operation: BrokerOperation;
  taskId: string;
  stepId: string;
  payloadHash: string;
  target?: { processName?: string; windowTitle?: string };
  args?: Record<string, unknown>;
  approvalTicket?: unknown;
}

export type BrokerTransportCaller = (
  call: BrokerTransportCall,
) => Promise<{ ok: true; data: unknown } | { ok: false; reason: string; unavailable?: boolean }>;

/** Largest single image carried to the model; larger ones are refused, not cut. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Largest textual result the model receives, in characters.
 *
 * Sized to hold a real application list (a typical machine reports 150–300
 * entries) rather than to keep the log tidy: the model has to *parse* this to act
 * on it, so a payload cut in the middle is worse than no payload at all.
 */
export const MAX_RESULT_CHARS = 256 * 1024;

/**
 * Renders a tool result for the model without ever producing invalid JSON.
 *
 * Character-slicing a JSON document leaves a fragment that no parser accepts —
 * which is what the previous fixed 2 000-character cut did to `list-installed-apps`
 * and `snapshot-ui-tree`. The array entries are therefore dropped whole, with an
 * explicit marker, so an over-long result stays parseable and says what was left
 * out instead of silently breaking.
 */
export function summarizeResult(data: unknown): string {
  const full = JSON.stringify(data);
  if (full.length <= MAX_RESULT_CHARS) return full;

  const trimmed = truncateArrays(data);
  const rendered = JSON.stringify(trimmed);
  if (rendered.length <= MAX_RESULT_CHARS) return rendered;

  // Still too long: the shape is not one this helper can shorten structurally, so
  // the caller gets a parseable reason rather than a broken document.
  return JSON.stringify({
    truncated: true,
    reason: "result-too-large",
    originalChars: full.length,
  });
}

/**
 * Drops trailing array entries until the document fits, keeping it valid JSON.
 *
 * Halving the entry count converges in a handful of passes even for a payload far
 * over the limit, and it never empties a list outright: the model still receives
 * the first entries and can say the list was cut short.
 */
function truncateArrays(data: unknown): unknown {
  if (collectArrays(data).length === 0) return data;
  let limit = Number.MAX_SAFE_INTEGER;
  let best = data;
  for (let pass = 0; pass < 32; pass += 1) {
    best = shrinkArrays(data, limit);
    if (JSON.stringify(best).length <= MAX_RESULT_CHARS) return best;
    if (limit === 1) return best;
    limit = limit === Number.MAX_SAFE_INTEGER ? 64 : Math.max(1, Math.floor(limit / 2));
  }
  return best;
}

/** The array-valued paths reachable from the root, for structural truncation. */
function collectArrays(data: unknown, path: string[] = [], found: string[][] = []): string[][] {
  if (Array.isArray(data)) {
    found.push(path);
    return found;
  }
  if (typeof data === "object" && data !== null) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      collectArrays(value, [...path, key], found);
    }
  }
  return found;
}

/** Rebuilds `data` with every array shortened to `limit` entries. */
function shrinkArrays(data: unknown, limit: number): unknown {
  if (Array.isArray(data)) {
    return data.slice(0, limit).map((entry) => shrinkArrays(entry, limit));
  }
  if (typeof data === "object" && data !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = shrinkArrays(value, limit);
    }
    return out;
  }
  return data;
}

/**
 * Pulls MCP image blocks out of a tool result.
 *
 * The blocks are read from the structured payload *before* it is stringified for
 * the log: stringifying first would truncate a base64 PNG and leave a fragment
 * that still looks like an image. A block whose payload exceeds the size cap is
 * dropped with a warning rather than forwarded silently shortened.
 */
export function extractImages(data: unknown): ImagePayload[] | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const images: ImagePayload[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "image") continue;
    const payload = record.data;
    if (typeof payload !== "string" || !payload) continue;
    if (payload.length > MAX_IMAGE_BYTES) {
      console.warn(
        `[companyclaw] dropped an oversized screenshot (${payload.length} bytes > ${MAX_IMAGE_BYTES})`,
      );
      continue;
    }
    images.push({
      data: payload,
      mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png",
    });
  }
  return images.length > 0 ? images : undefined;
}

export function isMutatingBrokerOperation(operation: BrokerOperation): boolean {
  return BROKER_MUTATING_OPERATIONS.includes(operation);
}

/**
 * Maps an action descriptor onto the broker's closed operation set.
 *
 * Returns null for anything the broker cannot express: a generic click or an
 * arbitrary command has no UIA equivalent here, and inventing one would hand
 * the agent a wider surface than the protocol allows.
 */
export function mapActionToBrokerOperation(request: BridgeRequest): BrokerOperation | null {
  const fromTool = request.action.toolName;
  if (!fromTool) return null;
  return TOOL_TO_OPERATION[fromTool] ?? null;
}

/**
 * Agent tool name -> broker operation.
 *
 * The table is closed on purpose: a tool that is not listed here cannot reach
 * the broker at all, so widening the agent's surface requires an edit here plus
 * the protocol change behind it, rather than happening as a side effect of a new
 * tool name appearing upstream.
 */
const TOOL_TO_OPERATION: Readonly<Record<string, BrokerOperation>> = {
  // v1: UI Automation operations.
  "list-windows": "list-windows",
  "describe-element": "describe-element",
  "find-elements": "find-elements",
  "read-value": "read-value",
  "wait-for-window": "wait-for-window",
  "set-value": "set-value",
  "invoke-pattern": "invoke-pattern",
  "send-keys": "send-keys",
  // v2: computer-use operations (W01–W18).
  "list-installed-apps": "list-installed-apps",
  "launch-app": "launch-app",
  "focus-window": "focus-window",
  "snapshot-ui-tree": "snapshot-ui-tree",
  "find-control": "find-control",
  screenshot: "screenshot",
  click: "click",
  move: "move",
  "drag-drop": "drag-drop",
  scroll: "scroll",
  "wait-for-condition": "wait-for-condition",
  "inspect-dialog": "inspect-dialog",
  "verify-state": "verify-state",
  // Text entry, shortcuts and single-control reads. These are exposed to the
  // agent, so leaving them out of this closed table made them fail with
  // `unsupported-broker-operation` — the tool existed and nothing could carry it.
  "type-text": "type-text",
  hotkey: "hotkey",
  "read-control": "read-control",
};

export interface BrokerTransportOptions {
  call: BrokerTransportCaller;
  /** Hash bound to the ticket; supplied by the caller that built the approval. */
  payloadHashFor: (request: BridgeRequest) => string;
  targetFor: (request: BridgeRequest) => { processName?: string; windowTitle?: string } | undefined;
  /**
   * The upstream arguments for one request.
   *
   * Defaults to the request's own arguments, which is what the agent supplied.
   * An override exists for the v1 element operations, whose selectors are built
   * by the caller rather than taken verbatim from a tool call.
   */
  argsFor?: (request: BridgeRequest) => Record<string, unknown>;
  /**
   * Mints the broker-side envelope for a mutating call.
   *
   * The bridge has already verified the *policy* ticket; this produces the
   * second, execution-side credential so the broker can re-check the exact
   * request it is about to perform. Omitting it means mutations are refused by
   * the broker, which is the safe default rather than a silent widening.
   */
  issueTicket?: (input: {
    operation: BrokerOperation;
    taskId: string;
    stepId: string;
    payloadHash: string;
  }) => unknown;
}

export function createBrokerTransport(options: BrokerTransportOptions): BridgeTransport {
  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    const operation = mapActionToBrokerOperation(request);
    if (!operation) {
      // Not expressible as a UIA operation; fail closed rather than widening
      // the broker's surface to accommodate it.
      return { status: "rejected", reason: "unsupported-broker-operation" };
    }
    const target = options.targetFor(request);
    const payloadHash = options.payloadHashFor(request);
    // The broker-side ticket is minted for this exact request; the policy ticket
    // that satisfied the bridge is not reusable as one, because the broker signs
    // over the request fields rather than the approval binding.
    const brokerTicket =
      request.approvalTicket && options.issueTicket
        ? options.issueTicket({
            operation,
            taskId: request.taskId,
            stepId: request.stepId,
            payloadHash,
          })
        : undefined;
    const result = await options.call({
      operation,
      taskId: request.taskId,
      stepId: request.stepId,
      payloadHash,
      ...(target ? { target } : {}),
      args: options.argsFor ? options.argsFor(request) : (request.arguments ?? {}),
      ...(brokerTicket ? { approvalTicket: brokerTicket } : {}),
    });
    if (result.ok) {
      // Images travel beside the truncated detail: a base64 PNG cannot survive a
      // 2000-character summary, so it must not be routed through it.
      const images = extractImages(result.data);
      return {
        status: "ok",
        detail: summarizeResult(result.data),
        ...(images ? { images } : {}),
      };
    }
    if (result.unavailable) return { status: "unavailable", reason: result.reason };
    return { status: "rejected", reason: result.reason };
  };
}
