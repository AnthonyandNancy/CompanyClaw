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
  contract: typeof BROKER_PROTOCOL_CONTRACT;
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
  if (candidate.contract !== BROKER_PROTOCOL_CONTRACT) {
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
  contract: typeof BROKER_PROTOCOL_CONTRACT;
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
