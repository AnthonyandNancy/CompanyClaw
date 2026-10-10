import { MUTATING_OPERATIONS as BROKER_MUTATING_OPERATIONS, type BrokerOperation } from "../broker-protocol";
import type { BridgeRequest, BridgeResponse, BridgeTransport } from "./execution-bridge";

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
};

export interface BrokerTransportOptions {
  call: BrokerTransportCaller;
  /** Hash bound to the ticket; supplied by the caller that built the approval. */
  payloadHashFor: (request: BridgeRequest) => string;
  targetFor: (request: BridgeRequest) => { processName?: string; windowTitle?: string } | undefined;
  argsFor: (request: BridgeRequest) => Record<string, unknown>;
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
      args: options.argsFor(request),
      ...(brokerTicket ? { approvalTicket: brokerTicket } : {}),
    });
    if (result.ok) {
      return { status: "ok", detail: JSON.stringify(result.data).slice(0, 2_000) };
    }
    if (result.unavailable) return { status: "unavailable", reason: result.reason };
    return { status: "rejected", reason: result.reason };
  };
}
