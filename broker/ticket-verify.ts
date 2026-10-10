import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApprovalTicketEnvelope, BrokerRequest } from "./protocol";

/**
 * The broker's own half of the approval-ticket check.
 *
 * Requirement V5 §5.2 and the V1.1 conflict ruling both demand that the
 * execution side re-verify a ticket rather than trust the caller: the desktop
 * having decided an approval was granted is not evidence that the *request in
 * flight* is the one that was approved.
 *
 * The canonical string below binds the ticket to every field that identifies the
 * call — task, step, owner, device, operation, payload hash — plus its own nonce
 * and validity window. That is what makes a captured ticket useless for a
 * different action: changing any one field changes the signed text.
 *
 * The desktop mirrors this canonicalization in
 * `desktop/src/companyclaw/broker-ticket.ts`; a drift test reads this file and
 * asserts the two agree, the same way the wire protocol is pinned.
 *
 * The key is symmetric, so the broker *could* mint a ticket. It never does:
 * minting happens only in the policy service, and the agent has neither the key
 * nor a path to this process. That is the property the requirement is after — a
 * model cannot manufacture an approval.
 */

export const BROKER_TICKET_CONTRACT = "companyclaw.broker-ticket.v1";

export const TICKET_CANONICAL_FIELDS = [
  "contract",
  "nonce",
  "taskId",
  "stepId",
  "ownerSid",
  "deviceId",
  "operation",
  "payloadHash",
  "issuedAt",
  "expiresAt",
] as const;

export interface TicketCanonicalInput {
  contract: string;
  nonce: string;
  taskId: string;
  stepId: string;
  ownerSid: string;
  deviceId: string;
  operation: string;
  payloadHash: string;
  issuedAt: string;
  expiresAt: string;
}

export function canonicalTicketText(input: TicketCanonicalInput): string {
  return TICKET_CANONICAL_FIELDS.map((field) => `${field}=${input[field]}`).join("\n");
}

export function signTicket(input: TicketCanonicalInput, secret: string): string {
  return createHmac("sha256", secret).update(canonicalTicketText(input)).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type TicketRejection =
  | "missing-ticket"
  | "malformed-ticket"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "request-mismatch";

/**
 * Re-derives the canonical input from the request itself.
 *
 * Note that the identity fields come from the *request*, never from the
 * envelope: an envelope that claimed a different task or a different payload
 * hash would otherwise be its own authority.
 */
export function ticketCanonicalInputFromRequest(
  request: BrokerRequest,
): TicketCanonicalInput | null {
  const envelope = request.approvalTicket;
  if (!envelope) return null;
  return {
    contract: BROKER_TICKET_CONTRACT,
    nonce: envelope.nonce,
    taskId: request.taskId,
    stepId: request.stepId,
    ownerSid: request.ownerSid,
    deviceId: request.deviceId,
    operation: request.operation,
    payloadHash: request.payloadHash,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
  };
}

export function verifyRequestTicket(input: {
  request: BrokerRequest;
  secret: string;
  now?: Date;
}): { ok: true } | { ok: false; reason: TicketRejection } {
  const envelope = input.request.approvalTicket;
  if (!envelope) return { ok: false, reason: "missing-ticket" };
  if (
    typeof envelope.contract !== "string" ||
    envelope.contract !== BROKER_TICKET_CONTRACT ||
    typeof envelope.nonce !== "string" ||
    envelope.nonce.length === 0 ||
    typeof envelope.signature !== "string" ||
    typeof envelope.bindingHash !== "string" ||
    typeof envelope.issuedAt !== "string" ||
    typeof envelope.expiresAt !== "string"
  ) {
    return { ok: false, reason: "malformed-ticket" };
  }

  // The envelope's own binding hash must equal the request's payload hash: the
  // ticket is for this payload or it is not usable at all.
  if (envelope.bindingHash !== input.request.payloadHash) {
    return { ok: false, reason: "request-mismatch" };
  }

  const canonical = ticketCanonicalInputFromRequest(input.request);
  if (!canonical) return { ok: false, reason: "malformed-ticket" };
  const expected = signTicket(canonical, input.secret);
  if (!safeEqual(expected, envelope.signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  const now = (input.now ?? new Date()).getTime();
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return { ok: false, reason: "malformed-ticket" };
  }
  if (now < issuedAt) return { ok: false, reason: "not-yet-valid" };
  if (now >= expiresAt) return { ok: false, reason: "expired" };

  return { ok: true };
}

/**
 * Builds the verifier the policy expects.
 *
 * Returning `false` when no secret is configured is the fail-closed default: a
 * broker started without a key refuses every mutation instead of accepting any.
 */
export function createTicketVerifier(
  secret: string | undefined,
  now?: () => Date,
): (request: BrokerRequest) => boolean {
  if (!secret) return () => false;
  return (request: BrokerRequest) =>
    verifyRequestTicket({ request, secret, ...(now ? { now: now() } : {}) }).ok;
}
