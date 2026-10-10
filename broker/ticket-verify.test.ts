import { describe, expect, it } from "vitest";
import { BrokerPolicy, type BrokerPolicyConfig } from "./policy";
import { createTicketVerifier } from "./ticket-verify";
import { BROKER_TICKET_CONTRACT, signTicket } from "./ticket-verify";
import type { ApprovalTicketEnvelope, BrokerRequest } from "./protocol";

/**
 * The broker-side ticket gate.
 *
 * Requirement V5 §5.2: the execution side must re-check the ticket itself, and a
 * mutation without a valid one must be refused rather than performed. The
 * negative cases below are the ones that matter — a valid-looking ticket for a
 * *different* request is the interesting attack.
 */

const SECRET = "broker-ticket-secret";
const NOW = new Date("2026-10-10T00:00:00Z");

function makeRequest(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
  return {
    contract: BROKER_TICKET_CONTRACT_FOR_REQUEST,
    requestId: "r-1",
    taskId: "t-1",
    stepId: "s-1",
    ownerSid: "S-1",
    deviceId: "device-a",
    operation: "set-value",
    target: { processName: "notepad" },
    args: { value: "x" },
    issuedAt: "2026-10-09T23:59:00.000Z",
    expiresAt: "2026-10-10T00:10:00.000Z",
    payloadHash: "a".repeat(64),
    approvalTicket: null,
    ...overrides,
  };
}

// The broker request carries the wire contract, which is a different string from
// the ticket contract; named here so the two cannot be confused.
const BROKER_TICKET_CONTRACT_FOR_REQUEST = "companyclaw.broker.v1" as const;

function issueTicketFor(request: BrokerRequest, overrides: Partial<ApprovalTicketEnvelope> = {}) {
  const issuedAt = "2026-10-10T00:00:00.000Z";
  const expiresAt = "2026-10-10T00:02:00.000Z";
  const base = {
    contract: BROKER_TICKET_CONTRACT,
    nonce: "n-1",
    taskId: request.taskId,
    stepId: request.stepId,
    ownerSid: request.ownerSid,
    deviceId: request.deviceId,
    operation: request.operation,
    payloadHash: request.payloadHash,
    issuedAt,
    expiresAt,
  };
  return {
    contract: BROKER_TICKET_CONTRACT,
    nonce: "n-1",
    bindingHash: request.payloadHash,
    issuedAt,
    expiresAt,
    signature: signTicket(base, SECRET),
    ...overrides,
  };
}

const CONFIG: BrokerPolicyConfig = {
  ownerSid: "S-1",
  deviceId: "device-a",
  allowedProcesses: ["notepad"],
  allowedWindowTitles: [],
  requireApprovalForMutations: true,
};

function policy() {
  return new BrokerPolicy(CONFIG, {
    now: () => NOW,
    verifyTicket: createTicketVerifier(SECRET, () => NOW),
  });
}

describe("mutations require a ticket the broker verified itself", () => {
  it("refuses a mutation with no ticket", () => {
    const decision = policy().authorize(makeRequest());
    expect(decision).toEqual({ allowed: false, reason: "approval-required" });
  });

  it("accepts a ticket issued for exactly this request", () => {
    const request = makeRequest();
    const decision = policy().authorize({
      ...request,
      approvalTicket: issueTicketFor(request),
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("refuses a ticket whose signature was made with another key", () => {
    const request = makeRequest();
    const forged = issueTicketFor(request);
    const decision = policy().authorize({
      ...request,
      approvalTicket: { ...forged, signature: signTicket({
        contract: BROKER_TICKET_CONTRACT,
        nonce: forged.nonce,
        taskId: request.taskId,
        stepId: request.stepId,
        ownerSid: request.ownerSid,
        deviceId: request.deviceId,
        operation: request.operation,
        payloadHash: request.payloadHash,
        issuedAt: forged.issuedAt,
        expiresAt: forged.expiresAt,
      }, "another-secret") },
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid-approval-ticket" });
  });

  it("refuses a ticket replayed against a different payload", () => {
    const request = makeRequest();
    const ticket = issueTicketFor(request);
    const decision = policy().authorize({
      ...request,
      payloadHash: "b".repeat(64),
      approvalTicket: ticket,
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid-approval-ticket" });
  });

  it("refuses a ticket replayed against a different operation", () => {
    const request = makeRequest();
    const ticket = issueTicketFor(request);
    const decision = policy().authorize({
      ...request,
      operation: "send-keys",
      approvalTicket: ticket,
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid-approval-ticket" });
  });

  it("refuses a ticket replayed against a different task", () => {
    const request = makeRequest();
    const ticket = issueTicketFor(request);
    const decision = policy().authorize({
      ...request,
      taskId: "t-2",
      approvalTicket: ticket,
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid-approval-ticket" });
  });

  it("refuses an expired ticket", () => {
    const request = makeRequest();
    const decision = policy().authorize({
      ...request,
      approvalTicket: issueTicketFor(request, { expiresAt: "2026-10-09T23:59:30.000Z" }),
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid-approval-ticket" });
  });

  it("refuses every mutating operation in the v2 set without a ticket", () => {
    const operations = [
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
    ] as const;
    for (const operation of operations) {
      const decision = policy().authorize(makeRequest({ operation }));
      expect(decision).toEqual({ allowed: false, reason: "approval-required" });
    }
  });

  it("still serves a read-only operation without a ticket", () => {
    const decision = policy().authorize(
      makeRequest({ operation: "snapshot-ui-tree", target: { processName: "notepad" } }),
    );
    expect(decision).toEqual({ allowed: true });
  });
});

describe("a broker without a key refuses everything mutating", () => {
  it("rejects a ticket it cannot verify", () => {
    const request = makeRequest();
    const bare = new BrokerPolicy(CONFIG, {
      now: () => NOW,
      verifyTicket: createTicketVerifier(undefined),
    });
    expect(
      bare.authorize({ ...request, approvalTicket: issueTicketFor(request) }),
    ).toEqual({ allowed: false, reason: "invalid-approval-ticket" });
  });
});
