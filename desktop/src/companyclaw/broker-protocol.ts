/**
 * Broker wire protocol — desktop-side mirror.
 *
 * The authoritative definition lives in `broker/protocol.ts`. It is mirrored
 * here rather than imported because the broker is a separate build with its own
 * rootDir, and pulling its sources into the desktop compilation would move the
 * desktop's source root. `broker-protocol.test.ts` pins the contract string and
 * the operation set against the broker's own copy so the two cannot drift.
 */

export const BROKER_PROTOCOL_CONTRACT = "companyclaw.broker.v1" as const;
export const BROKER_PROTOCOL_CONTRACT_V2 = "companyclaw.broker.v2" as const;

export type BrokerContract =
  | typeof BROKER_PROTOCOL_CONTRACT
  | typeof BROKER_PROTOCOL_CONTRACT_V2;

export const SUPPORTED_BROKER_CONTRACTS: readonly BrokerContract[] = [
  BROKER_PROTOCOL_CONTRACT,
  BROKER_PROTOCOL_CONTRACT_V2,
] as const;

export const V2_OPERATIONS = [
  "list-installed-apps",
  "launch-app",
  "focus-window",
  "snapshot-ui-tree",
  "find-control",
  "screenshot",
  "click",
  "move",
  "drag-drop",
  "scroll",
  "wait-for-condition",
  "inspect-dialog",
  "verify-state",
  "capture-execution-error",
  // Text entry, shortcuts and single-control reads. Mirrors the broker's own
  // list; the two are pinned together by the wire-protocol test.
  "type-text",
  "hotkey",
  "read-control",
  "capabilities",
] as const;

export type V2Operation = (typeof V2_OPERATIONS)[number];

export type BrokerOperation =
  | "list-windows"
  | "describe-element"
  | "find-elements"
  | "read-value"
  | "invoke-pattern"
  | "set-value"
  | "send-keys"
  | "wait-for-window"
  | V2Operation;

/** Operations that can change application state and therefore need a ticket. */
export const MUTATING_OPERATIONS: readonly BrokerOperation[] = [
  "invoke-pattern",
  "set-value",
  "send-keys",
  "launch-app",
  "focus-window",
  "click",
  "move",
  "drag-drop",
  "scroll",
  "inspect-dialog",
  // Text entry and shortcuts change application state like pointer input does.
  // `read-control` stays out: it reads a value and cannot write one.
  "type-text",
  "hotkey",
] as const;

export const READ_ONLY_OPERATIONS: readonly BrokerOperation[] = [
  "list-windows",
  "describe-element",
  "find-elements",
  "read-value",
  "wait-for-window",
  "list-installed-apps",
  "snapshot-ui-tree",
  "find-control",
  "screenshot",
  "wait-for-condition",
  "verify-state",
  "capture-execution-error",
  "read-control",
  "capabilities",
] as const;

export interface ApprovalTicketEnvelope {
  contract: string;
  nonce: string;
  bindingHash: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface BrokerRequest {
  contract: BrokerContract;
  requestId: string;
  taskId: string;
  stepId: string;
  ownerSid: string;
  deviceId: string;
  operation: BrokerOperation;
  target: { processName?: string; windowTitle?: string; automationId?: string } | null;
  args: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
  payloadHash: string;
  approvalTicket: ApprovalTicketEnvelope | null;
}

export type BrokerResponse =
  | { contract: BrokerContract; requestId: string; status: "ok"; data: unknown; completedAt: string }
  | {
      contract: BrokerContract;
      requestId: string;
      status: "rejected" | "failed";
      reason: string;
      completedAt: string;
    };
