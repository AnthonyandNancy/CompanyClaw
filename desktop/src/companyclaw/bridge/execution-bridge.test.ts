import { describe, expect, it, vi } from "vitest";
import { ExecutionBridge } from "./execution-bridge";
import { hashBinding, issueApprovalTicket, type ApprovalBinding } from "../policy/approval-ticket";

const secret = "bridge-secret";
const now = () => new Date("2026-10-08T00:00:00.000Z");

const binding: ApprovalBinding = {
  ownerSid: "S-1",
  deviceId: "d",
  taskId: "task-1",
  stepId: "step-1",
  actionType: "business-write",
  targetSystem: "sys",
  recordId: "rec-1",
  field: "owner",
  oldValue: "a",
  newValue: "b",
  canonicalPayloadHash: "",
};
binding.canonicalPayloadHash = hashBinding({ ...binding, canonicalPayloadHash: "" });

function makeBridge(options: {
  send?: ReturnType<typeof vi.fn>;
  authorization?: "disabled" | "enabled";
  consumed?: Set<string>;
}) {
  const send =
    options.send ?? vi.fn(async () => ({ status: "ok" as const, detail: "done" }));
  const bridge = new ExecutionBridge(send as never, {
    policyContext: () => ({ remoteAuthorization: options.authorization ?? "enabled" }),
    secret,
    now,
    consumedNonces: options.consumed ?? new Set<string>(),
  });
  return { bridge, send };
}

describe("ExecutionBridge", () => {
  it("executes an approved write once", async () => {
    const { bridge, send } = makeBridge({});
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    expect(result).toEqual({ outcome: "executed", detail: "done" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses to reach the transport when the ticket is missing for R2", async () => {
    const { bridge, send } = makeBridge({});
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
    });
    expect(result.outcome).toBe("denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a replayed ticket without a second transport call", async () => {
    const consumed = new Set<string>();
    const { bridge, send } = makeBridge({ consumed });
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    consumed.add(ticket.nonce);
    const replay = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    expect(replay).toMatchObject({ outcome: "denied" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a ticket bound to a different change", async () => {
    const { bridge, send } = makeBridge({});
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding: { ...binding, newValue: "c", canonicalPayloadHash: hashBinding({ ...binding, newValue: "c", canonicalPayloadHash: "" }) },
    });
    expect(result).toMatchObject({ outcome: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("never forwards an R3 action", async () => {
    const { bridge, send } = makeBridge({});
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "payment" },
    });
    expect(result.outcome).toBe("denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when remote authorization is off", async () => {
    const { bridge, send } = makeBridge({ authorization: "disabled" });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "local-work" },
    });
    expect(result.outcome).toBe("denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports unavailable instead of succeeding when the transport throws", async () => {
    const bridge = new ExecutionBridge(
      (async () => {
        throw new Error("broker offline");
      }) as never,
      {
        policyContext: () => ({ remoteAuthorization: "enabled" }),
        secret,
        now,
        consumedNonces: new Set<string>(),
      },
    );
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "local-work" },
    });
    expect(result).toEqual({ outcome: "unavailable", reason: "broker offline" });
  });
});
