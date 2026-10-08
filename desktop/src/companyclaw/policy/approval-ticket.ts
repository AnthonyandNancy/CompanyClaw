import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const COMPANYCLAW_APPROVAL_TICKET_CONTRACT = "companyclaw.approval-ticket.v1";

export interface ApprovalBinding {
  ownerSid: string;
  deviceId: string;
  taskId: string;
  stepId: string;
  actionType: string;
  targetSystem: string;
  recordId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  canonicalPayloadHash: string;
}

export interface ApprovalTicket {
  contract: typeof COMPANYCLAW_APPROVAL_TICKET_CONTRACT;
  nonce: string;
  bindingHash: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export type TicketRejection =
  | "malformed"
  | "binding-mismatch"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "already-consumed";

const BINDING_FIELDS: readonly (keyof ApprovalBinding)[] = [
  "ownerSid",
  "deviceId",
  "taskId",
  "stepId",
  "actionType",
  "targetSystem",
  "recordId",
  "field",
  "oldValue",
  "newValue",
  "canonicalPayloadHash",
];

export function canonicalizeBinding(binding: ApprovalBinding): string {
  return BINDING_FIELDS.map((field) => {
    const value = binding[field];
    const normalized = value === null ? "\u0000null" : String(value);
    return `${field}=${normalized.length}:${normalized}`;
  }).join("\n");
}

export function hashBinding(binding: ApprovalBinding): string {
  return createHmac("sha256", "companyclaw.binding")
    .update(canonicalizeBinding(binding))
    .digest("hex");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function signaturePayload(ticket: Omit<ApprovalTicket, "signature">): string {
  return [
    ticket.contract,
    ticket.nonce,
    ticket.bindingHash,
    ticket.issuedAt,
    ticket.expiresAt,
  ].join("\n");
}

export interface IssueApprovalTicketInput {
  binding: ApprovalBinding;
  secret: string;
  ttlMs: number;
  now?: () => Date;
  createNonce?: () => string;
}

export function issueApprovalTicket(input: IssueApprovalTicketInput): ApprovalTicket {
  const now = (input.now ?? (() => new Date()))();
  const unsigned: Omit<ApprovalTicket, "signature"> = {
    contract: COMPANYCLAW_APPROVAL_TICKET_CONTRACT,
    nonce: (input.createNonce ?? randomUUID)(),
    bindingHash: hashBinding(input.binding),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
  };
  return { ...unsigned, signature: sign(input.secret, signaturePayload(unsigned)) };
}

export interface VerifyApprovalTicketInput {
  ticket: ApprovalTicket;
  binding: ApprovalBinding;
  secret: string;
  now?: () => Date;
  consumedNonces: Set<string>;
}

export type TicketVerification = { ok: true } | { ok: false; reason: TicketRejection };

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyApprovalTicket(input: VerifyApprovalTicketInput): TicketVerification {
  const { ticket, binding, secret } = input;
  if (
    !ticket ||
    ticket.contract !== COMPANYCLAW_APPROVAL_TICKET_CONTRACT ||
    typeof ticket.nonce !== "string" ||
    ticket.nonce.length === 0 ||
    typeof ticket.bindingHash !== "string" ||
    typeof ticket.issuedAt !== "string" ||
    typeof ticket.expiresAt !== "string" ||
    typeof ticket.signature !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const unsigned: Omit<ApprovalTicket, "signature"> = {
    contract: ticket.contract,
    nonce: ticket.nonce,
    bindingHash: ticket.bindingHash,
    issuedAt: ticket.issuedAt,
    expiresAt: ticket.expiresAt,
  };
  if (!safeEqual(sign(secret, signaturePayload(unsigned)), ticket.signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  if (!safeEqual(hashBinding(binding), ticket.bindingHash)) {
    return { ok: false, reason: "binding-mismatch" };
  }

  const now = (input.now ?? (() => new Date()))().getTime();
  const issuedAt = Date.parse(ticket.issuedAt);
  const expiresAt = Date.parse(ticket.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }
  if (now < issuedAt) return { ok: false, reason: "not-yet-valid" };
  if (now >= expiresAt) return { ok: false, reason: "expired" };
  if (input.consumedNonces.has(ticket.nonce)) {
    return { ok: false, reason: "already-consumed" };
  }
  return { ok: true };
}
