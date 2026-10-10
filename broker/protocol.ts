/**
 * CompanyClaw Windows Execution Broker — wire protocol.
 *
 * The broker is a *narrowing* proxy: it accepts only the operations listed
 * here, re-checks identity on every request, and never exposes a general
 * command surface. Requirement V1.1 (conflict 3) forbids handing an
 * unrestricted Windows-MCP tool set to the agent, and forbids treating a
 * generic Click/Type tool as safe merely because of its name.
 */

export const BROKER_PROTOCOL_CONTRACT = "companyclaw.broker.v1" as const;

/**
 * Second-generation contract, negotiated by capability rather than replaced.
 *
 * Requirement V5 §5.2 is explicit that `v1` must stay readable: a desktop build
 * that still speaks v1 has to keep working, so the new operations are added
 * alongside the old ones and a request declares which contract it uses. The
 * broker accepts both and reports the set it can serve.
 */
export const BROKER_PROTOCOL_CONTRACT_V2 = "companyclaw.broker.v2" as const;

export type BrokerContract =
  | typeof BROKER_PROTOCOL_CONTRACT
  | typeof BROKER_PROTOCOL_CONTRACT_V2;

export const SUPPORTED_BROKER_CONTRACTS: readonly BrokerContract[] = [
  BROKER_PROTOCOL_CONTRACT,
  BROKER_PROTOCOL_CONTRACT_V2,
] as const;

/** Operations introduced by v2, mapped to the requirement's W-numbers. */
export const V2_OPERATIONS = [
  // W01/W02 — application discovery and launch.
  "list-installed-apps",
  "launch-app",
  // W04 — focus, with the identity checks that keep it on the right window.
  "focus-window",
  // W05/W06 — accessibility tree and leased element references.
  "snapshot-ui-tree",
  "find-control",
  // W14 — capture limited to the authorized window.
  "screenshot",
  // W11–W13 — pointer input, including the mandatory drag.
  "click",
  "move",
  "drag-drop",
  // W12 — scroll inside a container.
  "scroll",
  // W15/W16 — bounded waiting and dialog inspection.
  "wait-for-condition",
  "inspect-dialog",
  // W17/W18 — read-back verification and structured failure.
  "verify-state",
  "capture-execution-error",
  // Capability negotiation, so a desktop can adapt instead of failing late.
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
  // v2 mutations. Pointer input and application launch change state exactly as
  // much as a set-value does, so they take the same gate rather than a new one.
  "launch-app",
  "focus-window",
  "click",
  "move",
  "drag-drop",
  "scroll",
  "inspect-dialog",
] as const;

export const READ_ONLY_OPERATIONS: readonly BrokerOperation[] = [
  "list-windows",
  "describe-element",
  "find-elements",
  "read-value",
  "wait-for-window",
  // v2 reads.
  "list-installed-apps",
  "snapshot-ui-tree",
  "find-control",
  "screenshot",
  "wait-for-condition",
  "verify-state",
  "capture-execution-error",
  "capabilities",
] as const;

const ALL_OPERATIONS: readonly BrokerOperation[] = [
  ...READ_ONLY_OPERATIONS,
  ...MUTATING_OPERATIONS,
];

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
  /** Target application/window selector, never an arbitrary path or command. */
  target: { processName?: string; windowTitle?: string; automationId?: string } | null;
  args: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
  payloadHash: string;
  approvalTicket: ApprovalTicketEnvelope | null;
}

export type BrokerParseRejection =
  | "not-an-object"
  | "unsupported-contract"
  | "missing-identity"
  | "unsupported-operation"
  | "malformed-payload-hash"
  | "malformed-timestamps";

export type BrokerParseResult =
  | { ok: true; request: BrokerRequest }
  | { ok: false; reason: BrokerParseRejection };

export function parseBrokerRequest(raw: unknown): BrokerParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not-an-object" };
  }
  const candidate = raw as Partial<BrokerRequest>;
  // Both contracts are accepted; the operation list is what actually decides
  // whether a call can be served.
  if (
    typeof candidate.contract !== "string" ||
    !SUPPORTED_BROKER_CONTRACTS.includes(candidate.contract as BrokerContract)
  ) {
    return { ok: false, reason: "unsupported-contract" };
  }
  for (const field of ["requestId", "taskId", "stepId", "ownerSid", "deviceId"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field]!.trim() === "") {
      return { ok: false, reason: "missing-identity" };
    }
  }
  if (
    typeof candidate.operation !== "string" ||
    !ALL_OPERATIONS.includes(candidate.operation as BrokerOperation)
  ) {
    return { ok: false, reason: "unsupported-operation" };
  }
  if (
    typeof candidate.payloadHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(candidate.payloadHash)
  ) {
    return { ok: false, reason: "malformed-payload-hash" };
  }
  const issuedAt = Date.parse(String(candidate.issuedAt));
  const expiresAt = Date.parse(String(candidate.expiresAt));
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt) || expiresAt <= issuedAt) {
    return { ok: false, reason: "malformed-timestamps" };
  }
  return { ok: true, request: candidate as BrokerRequest };
}

export type BrokerOutcome =
  | { status: "ok"; data: unknown }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

export interface BrokerResponse {
  contract: BrokerContract;
  requestId: string;
  status: BrokerOutcome["status"];
  data?: unknown;
  reason?: string;
  completedAt: string;
}

export interface BuildBrokerResponseInput {
  requestId: string;
  outcome: BrokerOutcome;
  now?: () => Date;
}

export function buildBrokerResponse(input: BuildBrokerResponseInput): BrokerResponse {
  const completedAt = (input.now ?? (() => new Date()))().toISOString();
  if (input.outcome.status === "ok") {
    return {
      contract: BROKER_PROTOCOL_CONTRACT,
      requestId: input.requestId,
      status: "ok",
      data: input.outcome.data,
      completedAt,
    };
  }
  return {
    contract: BROKER_PROTOCOL_CONTRACT,
    requestId: input.requestId,
    status: input.outcome.status,
    reason: input.outcome.reason,
    completedAt,
  };
}

export function isMutatingOperation(operation: BrokerOperation): boolean {
  return MUTATING_OPERATIONS.includes(operation);
}
