import { createHmac } from "node:crypto";
import type { ApprovalTicketEnvelope, BrokerOperation } from "./broker-protocol";

/**
 * The desktop half of the broker ticket check.
 *
 * The broker verifies every mutating request against its own canonical string
 * (`broker/ticket-verify.ts`). This module produces the matching signature from
 * the *actual* request fields, so the two sides cannot disagree about what was
 * approved. It is mirrored deliberately rather than imported: the broker is a
 * separate compilation with its own root, and `broker-ticket.test.ts` reads the
 * broker's source to pin the two definitions together.
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

export interface TicketSubject {
  taskId: string;
  stepId: string;
  ownerSid: string;
  deviceId: string;
  operation: BrokerOperation;
  payloadHash: string;
}

/**
 * Issues the envelope the broker will accept for this exact request.
 *
 * The validity window is the ticket's own: `ttlMs` is capped by the caller at
 * the policy ticket TTL, so the broker sees the same short-lived credential the
 * policy service granted rather than a longer one invented here.
 */
export function issueBrokerTicket(input: {
  subject: TicketSubject;
  secret: string;
  ttlMs: number;
  now?: () => Date;
  createNonce: () => string;
}): ApprovalTicketEnvelope {
  const now = (input.now ?? (() => new Date()))();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
  const canonical: TicketCanonicalInput = {
    contract: BROKER_TICKET_CONTRACT,
    nonce: input.createNonce(),
    taskId: input.subject.taskId,
    stepId: input.subject.stepId,
    ownerSid: input.subject.ownerSid,
    deviceId: input.subject.deviceId,
    operation: input.subject.operation,
    payloadHash: input.subject.payloadHash,
    issuedAt,
    expiresAt,
  };
  return {
    contract: BROKER_TICKET_CONTRACT,
    nonce: canonical.nonce,
    bindingHash: input.subject.payloadHash,
    issuedAt,
    expiresAt,
    signature: signTicket(canonical, input.secret),
  };
}
