import type { BrokerOperation } from "../broker-protocol";
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

/** Actions that change application state; these always need a ticket. */
const MUTATING_OPERATIONS: readonly BrokerOperation[] = [
  "invoke-pattern",
  "set-value",
  "send-keys",
];

export function isMutatingBrokerOperation(operation: BrokerOperation): boolean {
  return MUTATING_OPERATIONS.includes(operation);
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
  if (fromTool === "list-windows") return "list-windows";
  if (fromTool === "describe-element") return "describe-element";
  if (fromTool === "find-elements") return "find-elements";
  if (fromTool === "read-value") return "read-value";
  if (fromTool === "wait-for-window") return "wait-for-window";
  if (fromTool === "set-value") return "set-value";
  if (fromTool === "invoke-pattern") return "invoke-pattern";
  if (fromTool === "send-keys") return "send-keys";
  return null;
}

export interface BrokerTransportOptions {
  call: BrokerTransportCaller;
  /** Hash bound to the ticket; supplied by the caller that built the approval. */
  payloadHashFor: (request: BridgeRequest) => string;
  targetFor: (request: BridgeRequest) => { processName?: string; windowTitle?: string } | undefined;
  argsFor: (request: BridgeRequest) => Record<string, unknown>;
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
    const result = await options.call({
      operation,
      taskId: request.taskId,
      stepId: request.stepId,
      payloadHash: options.payloadHashFor(request),
      ...(target ? { target } : {}),
      args: options.argsFor(request),
      // Passed through unchanged: the broker verifies it again on its side.
      ...(request.approvalTicket ? { approvalTicket: request.approvalTicket } : {}),
    });
    if (result.ok) {
      return { status: "ok", detail: JSON.stringify(result.data).slice(0, 2_000) };
    }
    if (result.unavailable) return { status: "unavailable", reason: result.reason };
    return { status: "rejected", reason: result.reason };
  };
}
