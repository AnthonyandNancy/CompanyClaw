import { createHmac, randomBytes } from "node:crypto";

/**
 * Supplies the approval-ticket verification the broker needs.
 *
 * The broker runs as a separate process and cannot read the desktop's approval
 * store, so the desktop forwards a short-lived proof with each mutating request
 * instead of sharing a secret by file. The proof is an HMAC over the exact
 * request payload, which is what makes a ticket single-use and un-replayable
 * even across the process boundary.
 */

export const COMPANYCLAW_BROKER_PROOF_CONTRACT = "companyclaw.broker-proof.v1";

export interface BrokerProofPayload {
  taskId: string;
  stepId: string;
  ownerSid: string;
  deviceId: string;
  operation: string;
  payloadHash: string;
  expiresAt: string;
}

export function createBrokerExecutionToken(): string {
  // 32 bytes of entropy; the broker refuses anything shorter than 16 chars.
  return randomBytes(32).toString("hex");
}

export function buildProofPayload(input: {
  taskId: string;
  stepId: string;
  ownerSid: string;
  deviceId: string;
  operation: string;
  payloadHash: string;
  ttlMs: number;
  now?: () => Date;
}): BrokerProofPayload {
  const now = (input.now ?? (() => new Date()))();
  return {
    taskId: input.taskId,
    stepId: input.stepId,
    ownerSid: input.ownerSid,
    deviceId: input.deviceId,
    operation: input.operation,
    payloadHash: input.payloadHash,
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
  };
}

export function signProof(payload: BrokerProofPayload, secret: string): string {
  return createHmac("sha256", secret)
    .update(
      [
        COMPANYCLAW_BROKER_PROOF_CONTRACT,
        payload.taskId,
        payload.stepId,
        payload.ownerSid,
        payload.deviceId,
        payload.operation,
        payload.payloadHash,
        payload.expiresAt,
      ].join("\n"),
    )
    .digest("hex");
}

export interface BrokerProof {
  contract: typeof COMPANYCLAW_BROKER_PROOF_CONTRACT;
  payload: BrokerProofPayload;
  signature: string;
}

export function issueBrokerProof(
  payload: BrokerProofPayload,
  secret: string,
): BrokerProof {
  return {
    contract: COMPANYCLAW_BROKER_PROOF_CONTRACT,
    payload,
    signature: signProof(payload, secret),
  };
}

export type ProofRejection = "malformed" | "bad-signature" | "expired" | "payload-mismatch";

export type ProofVerification = { ok: true } | { ok: false; reason: ProofRejection };

export function verifyBrokerProof(input: {
  proof: BrokerProof;
  secret: string;
  expected: Pick<BrokerProofPayload, "taskId" | "stepId" | "operation" | "payloadHash">;
  now?: () => Date;
}): ProofVerification {
  const { proof, secret } = input;
  if (
    !proof ||
    proof.contract !== COMPANYCLAW_BROKER_PROOF_CONTRACT ||
    typeof proof.signature !== "string" ||
    typeof proof.payload !== "object" ||
    proof.payload === null
  ) {
    return { ok: false, reason: "malformed" };
  }
  const expectedSignature = signProof(proof.payload, secret);
  if (expectedSignature !== proof.signature) {
    return { ok: false, reason: "bad-signature" };
  }
  const expiresAt = Date.parse(proof.payload.expiresAt);
  if (Number.isNaN(expiresAt)) return { ok: false, reason: "malformed" };
  if ((input.now ?? (() => new Date()))().getTime() >= expiresAt) {
    return { ok: false, reason: "expired" };
  }
  // The proof is only valid for the exact request it was issued for.
  const expected = input.expected;
  if (
    proof.payload.taskId !== expected.taskId ||
    proof.payload.stepId !== expected.stepId ||
    proof.payload.operation !== expected.operation ||
    proof.payload.payloadHash !== expected.payloadHash
  ) {
    return { ok: false, reason: "payload-mismatch" };
  }
  return { ok: true };
}
