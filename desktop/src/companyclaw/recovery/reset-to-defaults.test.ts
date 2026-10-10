import { describe, expect, it } from "vitest";
import { CompanyClawRuntime, type RuntimePaths } from "../runtime";
import { buildResetPreview, resetToken, RESET_RETAINED_ITEMS } from "./reset-to-defaults";
import { createEmptyPermissionPolicy } from "../permissions/permission-policy";

/**
 * Ruling Q6 / Q-D: the reset must reach the backend, cover local and remote,
 * pause running work, void unconsumed approvals, keep the employee's data, and
 * never come back after a restart.
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

function makeRuntime(io: ReturnType<typeof memoryIo>) {
  return new CompanyClawRuntime({
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
    ticketSecret: "runtime-secret",
  });
}

describe("reset preview", () => {
  it("names every authority that will be cleared and what is kept", () => {
    const preview = buildResetPreview({
      policy: createEmptyPermissionPolicy(),
      tasks: [],
      pendingApprovals: 0,
    });
    expect(preview.toPreset).toBe("BASIC");
    for (const key of [
      "preset",
      "remoteAuthorization",
      "visionLocal",
      "visionRemote",
      "pendingApprovals",
    ] as const) {
      expect(preview.cleared).toContain(key);
    }
    expect(preview.retained).toEqual([...RESET_RETAINED_ITEMS]);
  });

  it("counts the running tasks that will be paused", () => {
    const preview = buildResetPreview({
      policy: createEmptyPermissionPolicy(),
      tasks: [
        { taskId: "t-1", state: "RUNNING" },
        { taskId: "t-2", state: "PAUSED" },
        { taskId: "t-3", state: "COMPLETED" },
      ],
      pendingApprovals: 2,
    });
    expect(preview.counts.activeTasks).toBe(2);
    expect(preview.counts.pendingApprovals).toBe(2);
  });

  it("changes the token when anything the employee saw changes", () => {
    const policy = createEmptyPermissionPolicy();
    const before = resetToken(policy, 0);
    const bumped = { ...policy, policyVersion: policy.policyVersion + 1 };
    expect(resetToken(bumped, 0)).not.toBe(before);
    expect(resetToken(policy, 1)).not.toBe(before);
  });
});

describe("applying the reset", () => {
  it("clears every grant, voids approvals and pauses active work", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    await runtime.trustApp({ processName: "notepad", scope: "both" });
    await runtime.trustSite({ domain: "oa.example.com" });
    await runtime.setPreset({ preset: "FULL_DAILY", acknowledged: true });
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    await runtime.flushPermissionWrites();
    await runtime.authorizeVision({
      origin: "local",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-vl",
    });

    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "local",
      objective: "整理报表",
    });
    await runtime.advanceTask({ taskId: task.taskId, to: "AUTHENTICATED", ownerSid: "S-1" });
    await runtime.advanceTask({ taskId: task.taskId, to: "PLANNING", ownerSid: "S-1" });
    await runtime.advanceTask({ taskId: task.taskId, to: "RUNNING", ownerSid: "S-1" });
    await runtime.grantTaskScope({
      taskId: task.taskId,
      ownerSid: "S-1",
      deviceId: "device-a",
      origin: "local-ui",
      targets: ["excel"],
      ttlMs: 60_000,
    });
    await runtime.requestApproval({
      ownerSid: "S-1",
      action: { kind: "message-single-recipient" },
      binding: { deviceId: "device-a", taskId: task.taskId, stepId: "s-1", targetSystem: "qq" },
    });

    const preview = runtime.previewSafeDefaultsReset();
    expect(preview.counts.pendingApprovals).toBe(1);
    expect(preview.counts.activeTasks).toBe(1);

    const result = await runtime.restoreSafeDefaults({ token: preview.token });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.invalidatedApprovals).toBe(1);
    expect(result.pausedTasks).toBe(1);

    const policy = runtime.getPermissionPolicy();
    expect(policy.preset).toBe("BASIC");
    expect(policy.trustedApps).toEqual([]);
    expect(policy.trustedSites).toEqual([]);
    expect(policy.taskGrants).toEqual([]);
    expect(policy.vision.local.enabled).toBe(false);
    expect(policy.vision.remote.enabled).toBe(false);
    expect(policy.remote.enabled).toBe(false);
    expect(runtime.listPendingApprovals("S-1")).toEqual([]);
    expect(runtime.getTask(task.taskId, "S-1")?.record.state).toBe("PAUSE_REQUESTED");
  });

  it("keeps the data the employee must not lose", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "local",
      objective: "已完成的任务",
    });
    await runtime.advanceTask({ taskId: task.taskId, to: "AUTHENTICATED", ownerSid: "S-1" });
    await runtime.advanceTask({ taskId: task.taskId, to: "PLANNING", ownerSid: "S-1" });
    await runtime.advanceTask({ taskId: task.taskId, to: "RUNNING", ownerSid: "S-1" });
    await runtime.advanceTask({ taskId: task.taskId, to: "VERIFYING", ownerSid: "S-1" });
    await runtime.advanceTask({
      taskId: task.taskId,
      to: "COMPLETED",
      ownerSid: "S-1",
      patch: { resultSummary: "完成" },
    });
    await runtime.bindIdentity({
      channelType: "weixin",
      channelUserId: "wx-1",
      deviceId: "device-a",
    });

    const result = await runtime.restoreSafeDefaults({
      token: runtime.previewSafeDefaultsReset().token,
    });
    expect(result.applied).toBe(true);
    // Task history and the WeChat binding survive.
    expect(runtime.getTask(task.taskId, "S-1")?.record.state).toBe("COMPLETED");
    expect(runtime.getIdentityBinding()?.channelUserId).toBe("wx-1");
  });

  it("does not resurrect any grant after a restart", async () => {
    const io = memoryIo();
    const first = makeRuntime(io);
    await first.trustApp({ processName: "notepad", scope: "both" });
    await first.setPreset({ preset: "FULL_DAILY", acknowledged: true });
    first.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    await first.flushPermissionWrites();
    await first.restoreSafeDefaults({ token: first.previewSafeDefaultsReset().token });
    await first.flushPermissionWrites();

    const second = makeRuntime(io);
    const policy = second.getPermissionPolicy();
    expect(policy.preset).toBe("BASIC");
    expect(policy.trustedApps).toEqual([]);
    expect(policy.remote.enabled).toBe(false);
    expect(second.getRemoteAuthorization().state).not.toBe("enabled");
  });

  it("refuses a confirmation for a state the employee no longer sees", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    const stale = runtime.previewSafeDefaultsReset().token;
    // Something changed between preview and confirm.
    await runtime.trustApp({ processName: "notepad" });
    const result = await runtime.restoreSafeDefaults({ token: stale });
    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("stale-preview");
    // The grant is untouched, because nothing was applied.
    expect(runtime.isAppTrusted("notepad", "local")).toBe(true);
  });

  it("refuses an empty token", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    const result = await runtime.restoreSafeDefaults({ token: "" });
    expect(result.applied).toBe(false);
  });
});
