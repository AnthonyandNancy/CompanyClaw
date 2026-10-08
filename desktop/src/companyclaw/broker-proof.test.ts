import { describe, expect, it } from "vitest";
import {
  COMPANYCLAW_BROKER_PROOF_CONTRACT,
  buildProofPayload,
  createBrokerExecutionToken,
  issueBrokerProof,
  signProof,
  verifyBrokerProof,
} from "./broker-proof";

const SECRET = "desktop-secret";
const now = () => new Date("2026-10-08T00:00:00.000Z");

function payload(ttlMs = 60_000) {
  return buildProofPayload({
    taskId: "task-1",
    stepId: "step-1",
    ownerSid: "S-1",
    deviceId: "device-a",
    operation: "set-value",
    payloadHash: "a".repeat(64),
    ttlMs,
    now,
  });
}

const expected = {
  taskId: "task-1",
  stepId: "step-1",
  operation: "set-value",
  payloadHash: "a".repeat(64),
};

describe("createBrokerExecutionToken", () => {
  it("produces a token long enough for the broker to accept", () => {
    const token = createBrokerExecutionToken();
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(token).toMatch(/^[a-f0-9]+$/);
  });

  it("never repeats", () => {
    expect(createBrokerExecutionToken()).not.toBe(createBrokerExecutionToken());
  });
});

describe("broker proof", () => {
  it("accepts a freshly issued proof for the exact request", () => {
    const proof = issueBrokerProof(payload(), SECRET);
    expect(proof.contract).toBe(COMPANYCLAW_BROKER_PROOF_CONTRACT);
    expect(verifyBrokerProof({ proof, secret: SECRET, expected, now })).toEqual({ ok: true });
  });

  it("rejects a foreign secret and a tampered payload", () => {
    const proof = issueBrokerProof(payload(), SECRET);
    expect(verifyBrokerProof({ proof, secret: "other", expected, now })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const tampered = {
      ...proof,
      payload: { ...proof.payload, payloadHash: "b".repeat(64) },
    };
    expect(verifyBrokerProof({ proof: tampered, secret: SECRET, expected, now })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects an expired proof", () => {
    const proof = issueBrokerProof(payload(1_000), SECRET);
    expect(
      verifyBrokerProof({
        proof,
        secret: SECRET,
        expected,
        now: () => new Date("2026-10-08T00:01:00.000Z"),
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a proof issued for a different request", () => {
    const proof = issueBrokerProof(payload(), SECRET);
    expect(
      verifyBrokerProof({
        proof,
        secret: SECRET,
        expected: { ...expected, stepId: "step-2" },
        now,
      }),
    ).toEqual({ ok: false, reason: "payload-mismatch" });
    expect(
      verifyBrokerProof({
        proof,
        secret: SECRET,
        expected: { ...expected, operation: "send-keys" },
        now,
      }),
    ).toEqual({ ok: false, reason: "payload-mismatch" });
  });

  it("rejects malformed input", () => {
    expect(
      verifyBrokerProof({
        proof: { contract: "other" } as never,
        secret: SECRET,
        expected,
        now,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("binds the signature to every significant field", () => {
    const base = payload();
    const signature = signProof(base, SECRET);
    for (const field of ["taskId", "stepId", "ownerSid", "deviceId", "operation", "payloadHash"] as const) {
      const mutated = { ...base, [field]: `${base[field]}-x` };
      expect(signProof(mutated, SECRET)).not.toBe(signature);
    }
    expect(signProof({ ...base, expiresAt: "2026-10-08T01:00:00.000Z" }, SECRET)).not.toBe(signature);
  });
});
