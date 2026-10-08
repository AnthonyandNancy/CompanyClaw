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

export type BrokerOperation =
  | "list-windows"
  | "describe-element"
  | "find-elements"
  | "read-value"
  | "invoke-pattern"
  | "set-value"
  | "send-keys"
  | "wait-for-window";

/** Operations that can change application state and therefore need a ticket. */
export const MUTATING_OPERATIONS: readonly BrokerOperation[] = [
  "invoke-pattern",
  "set-value",
  "send-keys",
] as const;

export const READ_ONLY_OPERATIONS: readonly BrokerOperation[] = [
  "list-windows",
  "describe-element",
  "find-elements",
  "read-value",
  "wait-for-window",
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
  contract: typeof BROKER_PROTOCOL_CONTRACT;
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
  | { contract: typeof BROKER_PROTOCOL_CONTRACT; requestId: string; status: "ok"; data: unknown; completedAt: string }
  | {
      contract: typeof BROKER_PROTOCOL_CONTRACT;
      requestId: string;
      status: "rejected" | "failed";
      reason: string;
      completedAt: string;
    };
