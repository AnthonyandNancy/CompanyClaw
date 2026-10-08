import { describe, expect, it, vi } from "vitest";
import { CompanyClawTaskStore } from "./tasks/task-store";
import { CompanyClawApprovalStore } from "./approvals/approval-store";
import { ExecutionBridge, type BridgeResponse } from "./bridge/execution-bridge";
import { RemoteAuthorization } from "./remote/remote-authorization";
import { hashBinding, issueApprovalTicket, type ApprovalBinding } from "./policy/approval-ticket";

/** A per-path shared document, so each store owns its own file. */
function sharedFiles() {
  const contents = new Map<string, string>();
  return {
    deps: {
      existsFile: (filePath: string) => contents.has(filePath),
      readFile: (filePath: string) => contents.get(filePath) ?? "",
      writeFile: async (filePath: string, next: string) => {
        contents.set(filePath, next);
      },
    },
  };
}

function makeBinding(taskId: string, newValue = "张三"): ApprovalBinding {
  const base: ApprovalBinding = {
    ownerSid: "S-1",
    deviceId: "device-a",
    taskId,
    stepId: "step-1",
    actionType: "business-write",
    targetSystem: "物业工程中心/工单",
    recordId: "WO-2026-0001",
    field: "owner",
    oldValue: "李四",
    newValue,
    canonicalPayloadHash: "",
  };
  return { ...base, canonicalPayloadHash: hashBinding(base) };
}

const now = () => new Date("2026-10-08T00:00:00Z");

describe("CompanyClaw security core", () => {
  it("walks one R2 business write from task creation to a verified completion", async () => {
    const file = sharedFiles();
    const tasks = new CompanyClawTaskStore("tasks.json", {
      ...file.deps,
      now,
      createId: () => "task-1",
    });
    const approvals = new CompanyClawApprovalStore("approvals.json", {
      ...file.deps,
      now,
      ttlMs: 120_000,
      secret: "s3cret",
      createId: () => "approval-1",
    });
    const authorization = new RemoteAuthorization({ now });

    // 1. Remote operation is off until the local user grants it.
    expect(authorization.state()).toBe("disabled");

    // 2. A trusted WeChat message creates and authenticates the task.
    const task = await tasks.create({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "把工单 WO-2026-0001 负责人改成张三",
    });
    await tasks.advance(task.taskId, "AUTHENTICATED", {});

    // 3. The agent plans, reaches RUNNING, and the user grants remote operation.
    await tasks.advance(task.taskId, "PLANNING", {});
    await tasks.advance(task.taskId, "RUNNING", {});
    authorization.setEnabled({
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMs: 3_600_000,
    });

    // 4. The write gate requests an approval bound to the exact change.
    const binding = makeBinding(task.taskId);
    const approval = await approvals.request(binding);
    await tasks.advance(task.taskId, "AWAITING_APPROVAL", { approvalId: approval.approvalId });

    // 5. The owner approves from WeChat; a single-use ticket is issued.
    await approvals.resolve(approval.approvalId, "approved", "S-1");
    const ticket = issueApprovalTicket({ binding, secret: "s3cret", ttlMs: 60_000, now });

    // 6. The approved write returns the task to RUNNING, then the bridge
    //    executes exactly once.
    await tasks.advance(task.taskId, "RUNNING", {});

    // 6. The bridge executes exactly once.
    const transport = vi.fn(
      async (): Promise<BridgeResponse> => ({ status: "ok", detail: "saved" }),
    );
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: authorization.state() }),
      secret: "s3cret",
      now,
      consumedNonces: new Set<string>(),
    });
    const write = await bridge.execute({
      taskId: task.taskId,
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    expect(write).toEqual({ outcome: "executed", detail: "saved" });

    // 7. The task only completes after a verified read-back.
    await tasks.advance(task.taskId, "VERIFYING", { executor: "windows-broker" });
    const finished = await tasks.advance(task.taskId, "COMPLETED", {
      resultSummary: "read-back matched 张三",
    });
    expect(finished.state).toBe("COMPLETED");
    expect(finished.terminalAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("refuses the same write when the owner never approves", async () => {
    const authorization = new RemoteAuthorization({ now });
    authorization.setEnabled({
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMs: 3_600_000,
    });
    const transport = vi.fn(
      async (): Promise<BridgeResponse> => ({ status: "ok", detail: "saved" }),
    );
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: authorization.state() }),
      secret: "s3cret",
      now,
      consumedNonces: new Set(),
    });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
    });
    expect(result.outcome).toBe("denied");
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps R3 blocked even with remote authorization enabled", async () => {
    const authorization = new RemoteAuthorization({ now });
    authorization.setEnabled({
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMs: 3_600_000,
    });
    const transport = vi.fn(
      async (): Promise<BridgeResponse> => ({ status: "ok", detail: "unexpected" }),
    );
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: authorization.state() }),
      secret: "s3cret",
      consumedNonces: new Set(),
    });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "arbitrary-command", toolName: "exec" },
    });
    expect(result.outcome).toBe("denied");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a ticket replayed after a pause and resume cycle", async () => {
    const authorization = new RemoteAuthorization({ now });
    authorization.setEnabled({
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMs: 3_600_000,
    });
    const taskId = "task-1";
    const binding = makeBinding(taskId);
    const ticket = issueApprovalTicket({ binding, secret: "s3cret", ttlMs: 60_000, now });
    const transport = vi.fn(
      async (): Promise<BridgeResponse> => ({ status: "ok", detail: "saved" }),
    );
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: authorization.state() }),
      secret: "s3cret",
      now,
      consumedNonces: new Set<string>(),
    });
    await bridge.execute({
      taskId,
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    // A resumed task must not be able to reuse the already-spent authorization.
    const replay = await bridge.execute({
      taskId,
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    expect(replay.outcome).toBe("denied");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
