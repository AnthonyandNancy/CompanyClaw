import { describe, expect, it } from "vitest";
import { CompanyClawRuntime, type RuntimePaths } from "./runtime";
import type { BridgeTransport } from "./bridge/execution-bridge";

/**
 * The whole chain, end to end, inside the runtime.
 *
 * Requirement V5 §5.6 describes exactly this sequence — a natural-language task
 * becomes a tool call, the policy decides for the channel it arrived through, a
 * mutation carries a ticket, and the executor is only reached after all of that.
 * These tests walk that path rather than any single module, because the failure
 * this work exists to prevent is a chain that is complete on paper and broken in
 * the middle.
 */

function memoryIo(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    write: async (path: string, contents: string) => {
      files.set(path, contents);
    },
    read: (path: string) => files.get(path) ?? "",
    exists: (path: string) => files.has(path),
    appendAudit: async (_path: string, line: string) => {
      files.set("audit", (files.get("audit") ?? "") + line);
    },
  };
}

const PATHS: RuntimePaths = {
  tasksFile: "C:/state/tasks.json",
  approvalsFile: "C:/state/approvals.json",
  artifactsRoot: "C:/state",
  identityFile: "C:/state/identity-binding.json",
  brokerTargetsFile: "C:/state/broker-targets.json",
  permissionsFile: "C:/state/permissions.json",
  auditFile: "C:/state/audit.jsonl",
};

function makeRuntime(io = memoryIo()) {
  const runtime = new CompanyClawRuntime({
    paths: PATHS,
    ownerSid: "S-1",
    now: () => new Date("2026-10-10T00:00:00Z"),
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    writeFile: io.write,
    readFile: io.read,
    existsFile: io.exists,
    appendAudit: io.appendAudit,
    ticketSecret: "runtime-secret",
  });
  return { runtime, io };
}

function recordingTransport() {
  const calls: Parameters<BridgeTransport>[0][] = [];
  const transport: BridgeTransport = async (request) => {
    calls.push(request);
    return { status: "ok", detail: "done" };
  };
  return { transport, calls };
}

async function startTask(runtime: CompanyClawRuntime) {
  const task = await runtime.createTask({
    ownerSid: "S-1",
    deviceId: "device-a",
    channel: "local",
    objective: "打开记事本并写入内容",
  });
  await runtime.advanceTask({ taskId: task.taskId, to: "AUTHENTICATED", ownerSid: "S-1" });
  await runtime.advanceTask({ taskId: task.taskId, to: "PLANNING", ownerSid: "S-1" });
  await runtime.advanceTask({ taskId: task.taskId, to: "RUNNING", ownerSid: "S-1" });
  return task;
}

const LOCAL_CONTEXT = {
  origin: "local-ui" as const,
  taskId: "",
  stepId: "step-1",
  ownerSid: "S-1",
  deviceId: "device-a",
};

describe("a read reaches the executor without a prompt", () => {
  it("executes a window read on the local channel", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    const { transport, calls } = recordingTransport();

    const result = await runtime.handleAgentToolCall({
      call: { tool: "list-windows", arguments: {} },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
    });

    expect(result.status).toBe("executed");
    expect(calls).toHaveLength(1);
    expect(calls[0].approvalTicket).toBeUndefined();
  });

  it("records why nothing was asked", async () => {
    const { runtime, io } = makeRuntime();
    const task = await startTask(runtime);
    const { transport } = recordingTransport();
    await runtime.handleAgentToolCall({
      call: { tool: "list-windows", arguments: {} },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
    });
    const audit = io.files.get("audit") ?? "";
    expect(audit).toContain('"decision":"allow"');
    expect(audit).toContain(`"taskId":"${task.taskId}"`);
  });
});

describe("a sensitive action stops at the approval", () => {
  it("raises an approval and does not reach the executor", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    const { transport, calls } = recordingTransport();

    const result = await runtime.handleAgentToolCall({
      call: { tool: "click", arguments: { x: 120, y: 240 } },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
    });

    expect(result.status).toBe("approval-required");
    expect(calls).toHaveLength(0);
    expect(runtime.listPendingApprovals("S-1")).toHaveLength(1);
  });

  it("runs the same call once the approval is granted, with a ticket", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    const { transport, calls } = recordingTransport();

    const raised = await runtime.handleAgentToolCall({
      call: { tool: "click", arguments: { x: 120, y: 240 } },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
    });
    expect(raised.status).toBe("approval-required");
    if (raised.status !== "approval-required") return;
    await runtime.resolveApproval({
      approvalId: raised.approvalId,
      decision: "approved",
      resolvedBy: "S-1",
    });

    const resumed = await runtime.handleAgentToolCall({
      call: { tool: "click", arguments: { x: 120, y: 240 } },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
      approvalId: raised.approvalId,
    });

    expect(resumed.status).toBe("executed");
    expect(calls).toHaveLength(1);
    expect(calls[0].approvalTicket).not.toBeNull();
  });

  it("refuses to run after a rejection", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    const { transport, calls } = recordingTransport();
    const raised = await runtime.handleAgentToolCall({
      call: { tool: "click", arguments: { x: 1, y: 1 } },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
    });
    if (raised.status !== "approval-required") throw new Error("expected an approval");
    await runtime.resolveApproval({
      approvalId: raised.approvalId,
      decision: "denied",
      resolvedBy: "S-1",
    });
    const resumed = await runtime.handleAgentToolCall({
      call: { tool: "click", arguments: { x: 1, y: 1 } },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
      approvalId: raised.approvalId,
    });
    expect(resumed.status).toBe("denied");
    expect(calls).toHaveLength(0);
  });
});

describe("the channel decides", () => {
  it("refuses the same click from WeChat while remote access is off", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    const { transport, calls } = recordingTransport();
    const result = await runtime.handleAgentToolCall({
      call: { tool: "click", arguments: { x: 1, y: 1 } },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId, origin: "weixin-private" },
      transport,
    });
    expect(result.status).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  it("still refuses a high-risk action locally", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    const { transport, calls } = recordingTransport();
    // A drag of a file is an outbound transfer; on the local channel it needs an
    // approval, and a denied category would stop it outright.
    const result = await runtime.handleAgentToolCall({
      call: {
        tool: "drag-drop",
        arguments: { from: [1, 1], to: [2, 2], sourceWindow: "a", targetWindow: "b" },
      },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
    });
    expect(["approval-required", "denied"]).toContain(result.status);
    expect(calls).toHaveLength(0);
  });
});

describe("task scope removes the repeated prompt", () => {
  it("runs covered operations without raising approvals under the daily preset", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    await runtime.setPreset({ preset: "FULL_DAILY", acknowledged: true });
    await runtime.grantTaskScope({
      taskId: task.taskId,
      ownerSid: "S-1",
      deviceId: "device-a",
      origin: "local-ui",
      targets: ["notepad"],
      ttlMs: 600_000,
    });
    const { transport, calls } = recordingTransport();

    // Twenty routine steps on a covered target: the requirement's own measure of
    // "no repeated prompts".
    for (let index = 0; index < 20; index += 1) {
      const result = await runtime.handleAgentToolCall({
        call: { tool: "click", arguments: { x: 10 + index, y: 20, windowTitle: "notepad" } },
        context: { ...LOCAL_CONTEXT, taskId: task.taskId },
        transport,
      });
      expect(result.status).toBe("executed");
    }
    expect(calls).toHaveLength(20);
    expect(runtime.listPendingApprovals("S-1")).toHaveLength(0);
  });

  it("does not let a grant cover an unnamed target", async () => {
    const { runtime } = makeRuntime();
    const task = await startTask(runtime);
    await runtime.setPreset({ preset: "FULL_DAILY", acknowledged: true });
    await runtime.grantTaskScope({
      taskId: task.taskId,
      ownerSid: "S-1",
      deviceId: "device-a",
      origin: "local-ui",
      targets: ["notepad"],
      ttlMs: 600_000,
    });
    const { transport, calls } = recordingTransport();
    const result = await runtime.handleAgentToolCall({
      call: { tool: "click", arguments: { x: 1, y: 1, windowTitle: "别的窗口" } },
      context: { ...LOCAL_CONTEXT, taskId: task.taskId },
      transport,
    });
    expect(result.status).toBe("approval-required");
    expect(calls).toHaveLength(0);
  });
});
