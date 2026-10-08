import { describe, expect, it } from "vitest";
import { BrokerPolicy, type BrokerPolicyConfig } from "./policy";
import { BROKER_PROTOCOL_CONTRACT, type BrokerRequest } from "./protocol";

const NOW = () => new Date("2026-10-08T00:00:00.000Z");

function makeConfig(overrides: Partial<BrokerPolicyConfig> = {}): BrokerPolicyConfig {
  return {
    ownerSid: "S-1-5-21-1",
    deviceId: "device-a",
    allowedProcesses: ["notepad", "excel"],
    allowedWindowTitles: [],
    requireApprovalForMutations: true,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
  return {
    contract: BROKER_PROTOCOL_CONTRACT,
    requestId: "req-1",
    taskId: "task-1",
    stepId: "step-1",
    ownerSid: "S-1-5-21-1",
    deviceId: "device-a",
    operation: "list-windows",
    target: null,
    args: {},
    issuedAt: "2026-10-08T00:00:00.000Z",
    expiresAt: "2026-10-08T00:05:00.000Z",
    payloadHash: "a".repeat(64),
    approvalTicket: null,
    ...overrides,
  };
}

describe("BrokerPolicy identity enforcement", () => {
  it("rejects a request from another Windows user", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(policy.authorize(makeRequest({ ownerSid: "S-1-5-21-999" }))).toEqual({
      allowed: false,
      reason: "owner-mismatch",
    });
  });

  it("rejects a request bound to another device", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(policy.authorize(makeRequest({ deviceId: "other-device" }))).toEqual({
      allowed: false,
      reason: "device-mismatch",
    });
  });

  it("rejects an expired request", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(
      policy.authorize(
        makeRequest({
          issuedAt: "2026-10-07T23:00:00.000Z",
          expiresAt: "2026-10-07T23:01:00.000Z",
        }),
      ),
    ).toEqual({ allowed: false, reason: "expired" });
  });

  it("rejects a request that is not yet valid", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(
      policy.authorize(
        makeRequest({
          issuedAt: "2026-10-08T01:00:00.000Z",
          expiresAt: "2026-10-08T01:05:00.000Z",
        }),
      ),
    ).toEqual({ allowed: false, reason: "not-yet-valid" });
  });
});

describe("BrokerPolicy target restrictions", () => {
  it("allows a read-only operation against an allow-listed process", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(policy.authorize(makeRequest({ target: { processName: "notepad" } }))).toEqual({
      allowed: true,
    });
  });

  it("rejects any process outside the allow list", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(policy.authorize(makeRequest({ target: { processName: "powershell" } }))).toEqual({
      allowed: false,
      reason: "process-not-allowed",
    });
  });

  it("treats a process name case-insensitively but not loosely", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(policy.authorize(makeRequest({ target: { processName: "Notepad" } }))).toEqual({
      allowed: true,
    });
    expect(policy.authorize(makeRequest({ target: { processName: "notepad2" } }))).toEqual({
      allowed: false,
      reason: "process-not-allowed",
    });
  });

  it("rejects a request with no target when the operation needs one", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    expect(policy.authorize(makeRequest({ operation: "find-elements", target: null }))).toEqual({
      allowed: false,
      reason: "target-required",
    });
  });

  it("denies everything when the allow list is empty", () => {
    const policy = new BrokerPolicy(makeConfig({ allowedProcesses: [] }), { now: NOW });
    expect(policy.authorize(makeRequest({ target: { processName: "notepad" } }))).toEqual({
      allowed: false,
      reason: "process-not-allowed",
    });
  });
});

describe("BrokerPolicy mutation gate", () => {
  it("requires an approval ticket for a mutating operation", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW });
    const result = policy.authorize(
      makeRequest({ operation: "set-value", target: { processName: "excel" } }),
    );
    expect(result).toEqual({ allowed: false, reason: "approval-required" });
  });

  it("allows a mutating operation when a ticket is present and verified", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW, verifyTicket: () => true });
    const result = policy.authorize(
      makeRequest({
        operation: "set-value",
        target: { processName: "excel" },
        approvalTicket: {
          contract: "companyclaw.approval-ticket.v1",
          nonce: "n-1",
          bindingHash: "b".repeat(64),
          issuedAt: "2026-10-08T00:00:00.000Z",
          expiresAt: "2026-10-08T00:01:00.000Z",
          signature: "sig",
        },
      }),
    );
    expect(result).toEqual({ allowed: true });
  });

  it("rejects a mutating operation whose ticket fails verification", () => {
    const policy = new BrokerPolicy(makeConfig(), { now: NOW, verifyTicket: () => false });
    const result = policy.authorize(
      makeRequest({
        operation: "send-keys",
        target: { processName: "excel" },
        approvalTicket: {
          contract: "companyclaw.approval-ticket.v1",
          nonce: "n-1",
          bindingHash: "b".repeat(64),
          issuedAt: "2026-10-08T00:00:00.000Z",
          expiresAt: "2026-10-08T00:01:00.000Z",
          signature: "sig",
        },
      }),
    );
    expect(result).toEqual({ allowed: false, reason: "invalid-approval-ticket" });
  });

  it("never allows a mutation when the policy forbids mutations outright", () => {
    const policy = new BrokerPolicy(
      makeConfig({ requireApprovalForMutations: true, allowedProcesses: [] }),
      { now: NOW, verifyTicket: () => true },
    );
    expect(
      policy.authorize(
        makeRequest({
          operation: "set-value",
          target: { processName: "excel" },
          approvalTicket: {
            contract: "companyclaw.approval-ticket.v1",
            nonce: "n-1",
            bindingHash: "b".repeat(64),
            issuedAt: "2026-10-08T00:00:00.000Z",
            expiresAt: "2026-10-08T00:01:00.000Z",
            signature: "sig",
          },
        }),
      ),
    ).toEqual({ allowed: false, reason: "process-not-allowed" });
  });
});
