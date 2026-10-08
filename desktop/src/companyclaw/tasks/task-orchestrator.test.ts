import { describe, expect, it, vi } from "vitest";
import { TaskOrchestrator, type OrchestratorDeps } from "./task-orchestrator";
import { CompanyClawTaskStore } from "./task-store";
import { RemoteAuthorization } from "../remote/remote-authorization";

function memoryIo() {
  const files = new Map<string, string>();
  return {
    files,
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    existsFile: (filePath: string) => files.has(filePath),
    readFile: (filePath: string) => files.get(filePath) ?? "",
    writeFile: async (filePath: string, contents: string) => {
      files.set(filePath, contents);
    },
  };
}

function makeOrchestrator(overrides: Partial<OrchestratorDeps> = {}) {
  const io = memoryIo();
  const tasks = new CompanyClawTaskStore("C:/state/tasks.json", {
    now: io.now,
    createId: (() => {
      let n = 0;
      return () => `task-${++n}`;
    })(),
    existsFile: io.existsFile,
    readFile: io.readFile,
    writeFile: io.writeFile,
  });
  const authorization = new RemoteAuthorization({ now: io.now });
  const deps: OrchestratorDeps = {
    tasks,
    authorization: () => authorization.state(),
    executeStep: vi.fn(async () => ({ ok: true as const, detail: "done" })),
    verifyStep: vi.fn(async () => ({ ok: true as const, detail: "matched" })),
    ...overrides,
  };
  return { orchestrator: new TaskOrchestrator(deps), tasks, authorization, deps, io };
}

describe("TaskOrchestrator", () => {
  it("refuses to run a task while remote operation is off", async () => {
    const { orchestrator, tasks } = makeOrchestrator();
    const task = await tasks.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "o",
    });
    const result = await orchestrator.run({
      taskId: task.taskId,
      ownerSid: "S-1",
      steps: [{ stepId: "step-1", executor: "windows-broker", expect: "matched" }],
    });
    expect(result).toEqual({ ok: false, reason: "remote-not-authorized" });
    expect(tasks.get(task.taskId)?.state).toBe("CREATED");
  });

  it("refuses a task that does not belong to the caller", async () => {
    const { orchestrator, tasks, authorization } = makeOrchestrator();
    authorization.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx", ttlMs: 60_000 });
    const task = await tasks.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "o",
    });
    const result = await orchestrator.run({
      taskId: task.taskId,
      ownerSid: "S-2",
      steps: [{ stepId: "step-1", executor: "windows-broker", expect: "matched" }],
    });
    expect(result).toEqual({ ok: false, reason: "unknown-task" });
  });

  it("walks a successful task through to COMPLETED after a verified read-back", async () => {
    const { orchestrator, tasks, authorization, deps } = makeOrchestrator();
    authorization.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx", ttlMs: 60_000 });
    const task = await tasks.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "o",
    });

    const result = await orchestrator.run({
      taskId: task.taskId,
      ownerSid: "S-1",
      steps: [
        { stepId: "step-1", executor: "windows-broker", expect: "matched" },
        { stepId: "step-2", executor: "windows-broker", expect: "matched" },
      ],
    });

    expect(result).toMatchObject({ ok: true, state: "COMPLETED" });
    expect(deps.executeStep).toHaveBeenCalledTimes(2);
    expect(deps.verifyStep).toHaveBeenCalledTimes(2);
    const record = tasks.get(task.taskId);
    expect(record?.state).toBe("COMPLETED");
    expect(record?.terminalAt).toBeTruthy();
  });

  it("stops at the failing step and marks the task FAILED", async () => {
    const executeStep = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, detail: "first" })
      .mockResolvedValueOnce({ ok: false, reason: "element-not-found" });
    const { orchestrator, tasks, authorization } = makeOrchestrator({ executeStep });
    authorization.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx", ttlMs: 60_000 });
    const task = await tasks.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "o",
    });

    const result = await orchestrator.run({
      taskId: task.taskId,
      ownerSid: "S-1",
      steps: [
        { stepId: "step-1", executor: "b", expect: "x" },
        { stepId: "step-2", executor: "b", expect: "x" },
        { stepId: "step-3", executor: "b", expect: "x" },
      ],
    });

    expect(result).toMatchObject({ ok: false, state: "FAILED" });
    // The third step must never run once the second failed.
    expect(executeStep).toHaveBeenCalledTimes(2);
    expect(tasks.get(task.taskId)?.state).toBe("FAILED");
  });

  it("reports PARTIAL when a step executed but its read-back did not match", async () => {
    const verifyStep = vi.fn().mockResolvedValue({ ok: false, reason: "value-mismatch" });
    const { orchestrator, tasks, authorization } = makeOrchestrator({ verifyStep });
    authorization.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx", ttlMs: 60_000 });
    const task = await tasks.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "o",
    });

    const result = await orchestrator.run({
      taskId: task.taskId,
      ownerSid: "S-1",
      steps: [{ stepId: "step-1", executor: "b", expect: "x" }],
    });

    // The write may have landed; we could not prove it. That is PARTIAL, not
    // COMPLETED and not FAILED.
    expect(result).toMatchObject({ ok: false, state: "PARTIAL" });
    expect(tasks.get(task.taskId)?.state).toBe("PARTIAL");
  });

  it("stops before the next step when the task is cancelled mid-run", async () => {
    const tasksRef: { tasks?: CompanyClawTaskStore } = {};
    const executeStep = vi.fn(async () => {
      // Cancel between steps, as a user pressing emergency stop would.
      const task = tasksRef.tasks!.get("task-1");
      if (task && task.state === "RUNNING" && executeStep.mock.calls.length === 1) {
        await tasksRef.tasks!.advance("task-1", "CANCELLED", { resultSummary: "user stop" });
      }
      return { ok: true as const, detail: "step" };
    });
    const { orchestrator, tasks, authorization } = makeOrchestrator({ executeStep });
    tasksRef.tasks = tasks;
    authorization.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx", ttlMs: 60_000 });
    await tasks.create({ ownerSid: "S-1", deviceId: "d", channel: "c", objective: "o" });

    const result = await orchestrator.run({
      taskId: "task-1",
      ownerSid: "S-1",
      steps: [
        { stepId: "step-1", executor: "b", expect: "x" },
        { stepId: "step-2", executor: "b", expect: "x" },
      ],
    });

    expect(result).toMatchObject({ ok: false, state: "CANCELLED" });
    expect(executeStep).toHaveBeenCalledTimes(1);
  });

  it("refuses to start a task that is already in a terminal state", async () => {
    const { orchestrator, tasks, authorization } = makeOrchestrator();
    authorization.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx", ttlMs: 60_000 });
    const task = await tasks.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "c",
      objective: "o",
    });
    await tasks.advance(task.taskId, "CANCELLED", {});

    const result = await orchestrator.run({
      taskId: task.taskId,
      ownerSid: "S-1",
      steps: [{ stepId: "step-1", executor: "b", expect: "x" }],
    });
    expect(result).toEqual({ ok: false, reason: "terminal-task", state: "CANCELLED" });
  });
});
