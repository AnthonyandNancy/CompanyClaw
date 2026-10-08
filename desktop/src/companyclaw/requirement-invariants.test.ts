/**
 * Requirement-level invariants for the CompanyClaw security core.
 *
 * These assertions are deliberately written from the Requirement V1.1 text and
 * the architecture design, NOT copied from the per-module unit tests, so that a
 * wrong unit test cannot make a wrong implementation look correct.
 */
import { describe, expect, it } from "vitest";
import { ExecutionBridge, type BridgeResponse } from "./bridge/execution-bridge";
import { decideAction } from "./policy/risk-classifier";
import {
  hashBinding,
  issueApprovalTicket,
  verifyApprovalTicket,
  type ApprovalBinding,
} from "./policy/approval-ticket";
import { canTransition, nextStateForControl } from "./tasks/task-state";
import { advanceWithReceipt } from "./results/delivery-status";
import { bindSessionSource } from "./remote/remote-authorization";

const enabled = { remoteAuthorization: "enabled" as const };
const t0 = () => new Date("2026-10-08T00:00:00Z");

function makeBinding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  const base: ApprovalBinding = {
    ownerSid: "S-1",
    deviceId: "d",
    taskId: "t-1",
    stepId: "s-1",
    actionType: "business-write",
    targetSystem: "sys",
    recordId: "r-1",
    field: "owner",
    oldValue: "a",
    newValue: "b",
    canonicalPayloadHash: "",
    ...overrides,
  };
  return { ...base, canonicalPayloadHash: hashBinding({ ...base, canonicalPayloadHash: "" }) };
}

describe("Requirement V1.1 - R3 is forbidden in remote mode", () => {
  const r3Kinds = [
    "delete",
    "payment",
    "publish",
    "system-config",
    "registry",
    "arbitrary-command",
    "unknown-program",
    "bypass-security",
  ] as const;

  it.each(r3Kinds)("denies %s even with remote authorization enabled", (kind) => {
    const decision = decideAction({ kind }, enabled);
    expect(decision.level).toBe("R3");
    expect(decision.decision).toBe("deny");
  });
});

describe("Requirement V1.1 - R0 requires system-level proof", () => {
  it("does not auto-allow a read that has no proof", () => {
    expect(decideAction({ kind: "read", toolName: "browser.snapshot" }, enabled).decision).not.toBe(
      "allow",
    );
  });

  it("allows a proven read only while remote authorization is live", () => {
    const read = { kind: "read" as const, readOnlyProof: "read-only-acl" as const };
    expect(decideAction(read, enabled).decision).toBe("allow");
    for (const state of ["disabled", "expired", "revoked"] as const) {
      expect(decideAction(read, { remoteAuthorization: state }).decision).toBe("deny");
    }
  });
});

describe("Requirement V1.1 - an uncontrollable write must be refused, not approved", () => {
  it("denies a write whose final commit cannot be intercepted", () => {
    const decision = decideAction(
      { kind: "write", writesBusinessData: true, commitInterceptable: false },
      enabled,
    );
    expect(decision.decision).toBe("deny");
  });
});

describe("Requirement V1.1 - pause must be re-checked before resuming", () => {
  it("forbids PAUSED from jumping straight back to RUNNING", () => {
    expect(canTransition("PAUSED", "RUNNING")).toBe(false);
    expect(canTransition("PAUSED", "RESUMING")).toBe(true);
    expect(nextStateForControl("PAUSED", "resume")).toBe("RESUMING");
  });

  it("accepts no control on a terminal task", () => {
    expect(nextStateForControl("COMPLETED", "cancel")).toBeNull();
    expect(nextStateForControl("CANCELLED", "resume")).toBeNull();
  });
});

describe("Requirement V1.1 - approval can never be replayed or widened", () => {
  const binding = makeBinding();
  const ticket = issueApprovalTicket({ binding, secret: "k", ttlMs: 60_000, now: t0 });

  it("accepts the freshly issued ticket", () => {
    expect(
      verifyApprovalTicket({ ticket, binding, secret: "k", now: t0, consumedNonces: new Set() }).ok,
    ).toBe(true);
  });

  it("rejects tampering, expiry and a different change", () => {
    expect(
      verifyApprovalTicket({
        ticket: { ...ticket, bindingHash: "0".repeat(64) },
        binding,
        secret: "k",
        now: t0,
        consumedNonces: new Set(),
      }).ok,
    ).toBe(false);
    expect(
      verifyApprovalTicket({
        ticket,
        binding,
        secret: "k",
        now: () => new Date("2026-10-08T00:05:00Z"),
        consumedNonces: new Set(),
      }).ok,
    ).toBe(false);
    expect(
      verifyApprovalTicket({
        ticket,
        binding: makeBinding({ newValue: "z" }),
        secret: "k",
        now: t0,
        consumedNonces: new Set(),
      }).ok,
    ).toBe(false);
  });

  it("executes an approved write once and denies the replay", async () => {
    const consumed = new Set<string>();
    const bridge = new ExecutionBridge(
      (async (): Promise<BridgeResponse> => ({ status: "ok", detail: "y" })) as never,
      { policyContext: () => enabled, secret: "k", now: t0, consumedNonces: consumed },
    );
    const request = {
      taskId: "t-1",
      stepId: "s-1",
      action: { kind: "write" as const, writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    };
    expect((await bridge.execute(request)).outcome).toBe("executed");
    expect((await bridge.execute(request)).outcome).toBe("denied");
  });
});

describe("Requirement V1.1 - the execution layer is never reached for a denied action", () => {
  it("keeps the transport untouched for R3 and for an unapproved write", async () => {
    let calls = 0;
    const bridge = new ExecutionBridge(
      (async () => {
        calls += 1;
        return { status: "ok" as const, detail: "x" };
      }) as never,
      { policyContext: () => enabled, secret: "k", now: t0, consumedNonces: new Set<string>() },
    );
    await bridge.execute({ taskId: "t-1", stepId: "s-1", action: { kind: "payment" } });
    await bridge.execute({
      taskId: "t-1",
      stepId: "s-1",
      action: { kind: "write", writesBusinessData: true },
    });
    expect(calls).toBe(0);
  });
});

describe("Requirement V1.1 - SENT is not DELIVERED", () => {
  it("never promotes a send without an explicit terminal receipt", () => {
    expect(advanceWithReceipt("SENT", "none")).toBe("SENT");
    expect(advanceWithReceipt("SENT", "terminal-confirmed")).toBe("DELIVERED");
  });
});

describe("Requirement V1.1 - provenance cannot be self-declared", () => {
  it("refuses a source claimed by user text", () => {
    expect(
      bindSessionSource({ channelType: "openclaw-weixin", userId: "wx-1", declaredBy: "user-text" }),
    ).toBeNull();
  });

  it("refuses a local or anonymous source", () => {
    expect(bindSessionSource({ channelType: "local", userId: "wx-1" })).toBeNull();
    expect(bindSessionSource({ channelType: "openclaw-weixin", userId: "" })).toBeNull();
  });
});
