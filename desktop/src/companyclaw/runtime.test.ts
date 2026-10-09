import { describe, expect, it } from "vitest";
import { CompanyClawRuntime, type RuntimePaths } from "./runtime";
import type { ApprovalBinding } from "./policy/approval-ticket";

const NOW = () => new Date("2026-10-08T00:00:00Z");

function memoryIo() {
  const files = new Map<string, string>();
  return {
    files,
    write: async (filePath: string, contents: string) => {
      files.set(filePath, contents);
    },
    read: (filePath: string) => files.get(filePath) ?? "",
    exists: (filePath: string) => files.has(filePath),
  };
}

function makeRuntime(paths?: Partial<RuntimePaths>) {
  const io = memoryIo();
  const resolved: RuntimePaths = {
    tasksFile: "C:/state/tasks.json",
    approvalsFile: "C:/state/approvals.json",
    artifactsRoot: "C:/state",
    identityFile: "C:/state/identity-binding.json",
    brokerTargetsFile: "C:/state/broker-targets.json",
    ...paths,
  };
  const runtime = new CompanyClawRuntime({
    paths: resolved,
    ownerSid: "S-1",
    now: NOW,
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    writeFile: io.write,
    readFile: io.read,
    existsFile: io.exists,
    ticketSecret: "runtime-secret",
  });
  return { runtime, io, paths: resolved };
}

function makeBinding(overrides: Partial<ApprovalBinding> = {}): Partial<ApprovalBinding> {
  return {
    ownerSid: "S-1",
    deviceId: "device-a",
    taskId: "task-1",
    stepId: "step-1",
    actionType: "business-write",
    targetSystem: "sys",
    recordId: "rec-1",
    field: "owner",
    oldValue: "a",
    newValue: "b",
    ...overrides,
  };
}

describe("CompanyClawRuntime authorization", () => {
  it("starts with remote operation disabled (fail-safe)", () => {
    const { runtime } = makeRuntime();
    expect(runtime.getRemoteAuthorization()).toMatchObject({ state: "disabled" });
  });

  it("enables remote operation only with an explicit grant and expiry", () => {
    const { runtime } = makeRuntime();
    const granted = runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    expect(granted).toMatchObject({ state: "enabled", ownerSid: "S-1" });
    expect(granted.expiresAt).toBe("2026-10-08T01:00:00.000Z");
  });

  it("uses the bound WeChat identity when the caller omits channelUserId", async () => {
    const { runtime } = makeRuntime();
    await runtime.bindIdentity({
      channelType: "weixin",
      channelUserId: "wx-owner",
      deviceId: "device-a",
    });
    const granted = runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      ttlMinutes: 60,
    });
    expect(granted).toMatchObject({ state: "enabled", channelUserId: "wx-owner" });
  });

  it("revokes immediately", () => {
    const { runtime } = makeRuntime();
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    expect(runtime.setRemoteAuthorization({ enabled: false }).state).toBe("revoked");
    expect(runtime.getRemoteAuthorization().state).toBe("revoked");
  });

  it("rejects a TTL outside the allowed range", () => {
    const { runtime } = makeRuntime();
    expect(() =>
      runtime.setRemoteAuthorization({
        enabled: true,
        ownerSid: "S-1",
        deviceId: "device-a",
        channelUserId: "wx-1",
        ttlMinutes: 0,
      }),
    ).toThrow(/ttlMinutes/);
    expect(() =>
      runtime.setRemoteAuthorization({
        enabled: true,
        ownerSid: "S-1",
        deviceId: "device-a",
        channelUserId: "wx-1",
        ttlMinutes: 60 * 24 * 30,
      }),
    ).toThrow(/ttlMinutes/);
  });
});

describe("CompanyClawRuntime tasks", () => {
  it("creates a task and reports it in the owner's list", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "改负责人",
    });
    expect(task.state).toBe("CREATED");
    const list = runtime.listTasks({ ownerSid: "S-1" });
    expect(list).toHaveLength(1);
    expect(runtime.listTasks({ ownerSid: "S-2" })).toHaveLength(0);
  });

  it("advances a task through the state machine and refuses illegal jumps", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    await runtime.advanceTask({ taskId: task.taskId, to: "AUTHENTICATED", ownerSid: "S-1" });
    expect(runtime.getTask(task.taskId, "S-1")?.record.state).toBe("AUTHENTICATED");
    await expect(
      runtime.advanceTask({ taskId: task.taskId, to: "COMPLETED", ownerSid: "S-1" }),
    ).rejects.toThrow(/AUTHENTICATED -> COMPLETED/);
  });

  it("refuses to read another owner's task", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    expect(runtime.getTask(task.taskId, "S-2")).toBeNull();
    await expect(
      runtime.advanceTask({ taskId: task.taskId, to: "AUTHENTICATED", ownerSid: "S-2" }),
    ).rejects.toThrow(/not owned by/i);
  });

  it("maps the four user controls onto the state machine", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    await runtime.advanceTask({ taskId: task.taskId, to: "AUTHENTICATED", ownerSid: "S-1" });
    await runtime.advanceTask({ taskId: task.taskId, to: "PLANNING", ownerSid: "S-1" });
    await runtime.advanceTask({ taskId: task.taskId, to: "RUNNING", ownerSid: "S-1" });

    const paused = await runtime.controlTask({
      taskId: task.taskId,
      ownerSid: "S-1",
      control: "pause",
    });
    expect(paused.record?.state).toBe("PAUSE_REQUESTED");

    const stillPausing = await runtime.controlTask({
      taskId: task.taskId,
      ownerSid: "S-1",
      control: "resume",
    });
    expect(stillPausing).toMatchObject({ accepted: false });

    await runtime.advanceTask({ taskId: task.taskId, to: "PAUSED", ownerSid: "S-1" });
    const resumed = await runtime.controlTask({
      taskId: task.taskId,
      ownerSid: "S-1",
      control: "resume",
    });
    expect(resumed.record?.state).toBe("RESUMING");
  });

  it("stops a task with emergency-stop and records the reason", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    const stopped = await runtime.controlTask({
      taskId: task.taskId,
      ownerSid: "S-1",
      control: "emergency-stop",
      reason: "user pressed stop",
    });
    expect(stopped.record?.state).toBe("CANCELLED");
    expect(stopped.record?.resultSummary).toContain("user pressed stop");
  });

  it("refuses any control on a terminal task", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    await runtime.controlTask({ taskId: task.taskId, ownerSid: "S-1", control: "cancel" });
    const again = await runtime.controlTask({
      taskId: task.taskId,
      ownerSid: "S-1",
      control: "cancel",
    });
    expect(again).toMatchObject({ accepted: false });
  });
});

describe("CompanyClawRuntime approvals", () => {
  it("refuses to request an approval for a denied (R3) action", async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.requestApproval({
        ownerSid: "S-1",
        action: { kind: "payment" },
        binding: makeBinding(),
      }),
    ).rejects.toThrow(/R3|denied/i);
  });

  it("refuses to request an approval while remote operation is off", async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.requestApproval({
        ownerSid: "S-1",
        action: { kind: "write", writesBusinessData: true },
        binding: makeBinding(),
      }),
    ).rejects.toThrow(/authorization/i);
  });

  it("issues a ticket only to the owner, after approval, for the exact change", async () => {
    const { runtime } = makeRuntime();
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    const pending = await runtime.requestApproval({
      ownerSid: "S-1",
      action: { kind: "write", writesBusinessData: true },
      binding: makeBinding(),
    });
    expect(pending.status).toBe("pending");

    await expect(
      runtime.resolveApproval({
        approvalId: pending.approvalId,
        decision: "approved",
        resolvedBy: "S-2",
      }),
    ).rejects.toThrow(/owner-mismatch/);

    const approved = await runtime.resolveApproval({
      approvalId: pending.approvalId,
      decision: "approved",
      resolvedBy: "S-1",
    });
    expect(approved.status).toBe("approved");

    const ticket = runtime.issueTicketForApproval({
      approvalId: pending.approvalId,
      ownerSid: "S-1",
    });
    expect(ticket.bindingHash).toBeTruthy();
    expect(runtime.listPendingApprovals("S-1")).toHaveLength(0);
  });

  it("will not issue a ticket for an approval that was denied", async () => {
    const { runtime } = makeRuntime();
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    const pending = await runtime.requestApproval({
      ownerSid: "S-1",
      action: { kind: "write", writesBusinessData: true },
      binding: makeBinding(),
    });
    await runtime.resolveApproval({
      approvalId: pending.approvalId,
      decision: "denied",
      resolvedBy: "S-1",
    });
    expect(() =>
      runtime.issueTicketForApproval({ approvalId: pending.approvalId, ownerSid: "S-1" }),
    ).toThrow(/not approved/i);
  });
});

describe("CompanyClawRuntime approval messaging", () => {
  async function withPending(runtime: ReturnType<typeof makeRuntime>["runtime"]) {
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    return await runtime.requestApproval({
      ownerSid: "S-1",
      action: { kind: "write", writesBusinessData: true },
      binding: makeBinding(),
    });
  }

  it("returns no message when nothing awaits confirmation", () => {
    const { runtime } = makeRuntime();
    expect(runtime.buildApprovalMessage("S-1")).toBe("");
  });

  it("describes the exact change in the confirmation text", async () => {
    const { runtime } = makeRuntime();
    await withPending(runtime);
    const text = runtime.buildApprovalMessage("S-1");
    expect(text).toContain("sys");
    expect(text).toContain("rec-1");
    expect(text).toContain("owner");
    expect(text).toContain("a");
    expect(text).toContain("b");
  });

  it("never shows another owner's pending approvals", async () => {
    const { runtime } = makeRuntime();
    await withPending(runtime);
    expect(runtime.buildApprovalMessage("S-2")).toBe("");
  });

  it("approves this owner's pending request from a reply", async () => {
    const { runtime } = makeRuntime();
    await withPending(runtime);
    const result = await runtime.applyApprovalReply("S-1", "Y");
    expect(result).toEqual({ handled: true, resolved: 1, decision: "approved" });
    expect(runtime.listPendingApprovals("S-1")).toHaveLength(0);
  });

  it("denies from a Chinese reply", async () => {
    const { runtime } = makeRuntime();
    await withPending(runtime);
    const result = await runtime.applyApprovalReply("S-1", "拒绝");
    expect(result).toEqual({ handled: true, resolved: 1, decision: "denied" });
  });

  it("lets ordinary chat through instead of swallowing it", async () => {
    const { runtime } = makeRuntime();
    await withPending(runtime);
    const result = await runtime.applyApprovalReply("S-1", "帮我看看今天的工单");
    expect(result).toEqual({ handled: false, reason: "not-a-reply" });
    // The request must still be pending after a non-reply.
    expect(runtime.listPendingApprovals("S-1")).toHaveLength(1);
  });

  it("refuses a reply from someone who owns no pending request", async () => {
    const { runtime } = makeRuntime();
    await withPending(runtime);
    const result = await runtime.applyApprovalReply("S-2", "Y");
    expect(result).toEqual({ handled: false, reason: "no-pending" });
    expect(runtime.listPendingApprovals("S-1")).toHaveLength(1);
  });

  it("refuses an out-of-range index", async () => {
    const { runtime } = makeRuntime();
    await withPending(runtime);
    const result = await runtime.applyApprovalReply("S-1", "Y5");
    expect(result).toEqual({ handled: false, reason: "index-out-of-range" });
    expect(runtime.listPendingApprovals("S-1")).toHaveLength(1);
  });

  it("reports no-pending when a recognised reply arrives with nothing to confirm", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.applyApprovalReply("S-1", "Y");
    expect(result).toEqual({ handled: false, reason: "no-pending" });
  });
});

describe("CompanyClawRuntime artifacts", () => {
  it("refuses an artifact directory for an unknown task", () => {
    const { runtime } = makeRuntime();
    expect(runtime.resolveArtifactDir({ taskId: "nope", ownerSid: "S-1" })).toEqual({
      ok: false,
      reason: "unknown-task",
    });
  });

  it("refuses an artifact directory for another owner", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    expect(runtime.resolveArtifactDir({ taskId: task.taskId, ownerSid: "S-2" })).toEqual({
      ok: false,
      reason: "owner-mismatch",
    });
  });

  it("places a task's artifacts under its own jobs directory", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    const resolved = runtime.resolveArtifactDir({ taskId: task.taskId, ownerSid: "S-1" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.dir.split("\\").join("/")).toContain(`/jobs/${task.taskId}/artifacts`);
  });

  it("accepts a file inside the task directory and rejects one outside", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    const resolved = runtime.resolveArtifactDir({ taskId: task.taskId, ownerSid: "S-1" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const inside = `${resolved.dir}/报告.xlsx`;
    expect(
      runtime.acceptArtifact({ taskId: task.taskId, ownerSid: "S-1", filePath: inside }),
    ).toEqual({ ok: true, fileName: "报告.xlsx" });
    expect(
      runtime.acceptArtifact({
        taskId: task.taskId,
        ownerSid: "S-1",
        filePath: "C:/Windows/System32/evil.xlsx",
      }),
    ).toEqual({ ok: false, reason: "outside-task-directory" });
  });

  it("refuses a traversal attempt escaping the task directory", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "o",
    });
    const resolved = runtime.resolveArtifactDir({ taskId: task.taskId, ownerSid: "S-1" });
    if (!resolved.ok) throw new Error("expected a resolved dir");
    const escaped = `${resolved.dir}/../../../Windows/evil.xlsx`;
    expect(
      runtime.acceptArtifact({ taskId: task.taskId, ownerSid: "S-1", filePath: escaped }),
    ).toEqual({ ok: false, reason: "outside-task-directory" });
  });
});

describe("CompanyClawRuntime identity binding", () => {
  it("starts unbound and authorizes no remote caller", () => {
    const { runtime } = makeRuntime();
    expect(runtime.getIdentityBinding()).toBeNull();
    expect(
      runtime.isRemoteCallerAuthorized({ channelType: "openclaw-weixin", channelUserId: "wx-1" }),
    ).toBe(false);
  });

  it("binds the channel user to this device and SID", async () => {
    const { runtime } = makeRuntime();
    const bound = await runtime.bindIdentity({
      channelType: "openclaw-weixin",
      channelUserId: "wx-1",
      deviceId: "device-a",
    });
    expect(bound).toMatchObject({ ownerSid: "S-1", deviceId: "device-a", channelUserId: "wx-1" });
  });

  it("still refuses tools while remote operation is off, even when bound", async () => {
    const { runtime } = makeRuntime();
    await runtime.bindIdentity({
      channelType: "openclaw-weixin",
      channelUserId: "wx-1",
      deviceId: "device-a",
    });
    // Being bound identifies the user; it is not permission to act.
    expect(
      runtime.isRemoteCallerAuthorized({ channelType: "openclaw-weixin", channelUserId: "wx-1" }),
    ).toBe(false);
  });

  it("authorizes the bound caller once remote operation is enabled", async () => {
    const { runtime } = makeRuntime();
    await runtime.bindIdentity({
      channelType: "openclaw-weixin",
      channelUserId: "wx-1",
      deviceId: "device-a",
    });
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    expect(
      runtime.isRemoteCallerAuthorized({ channelType: "openclaw-weixin", channelUserId: "wx-1" }),
    ).toBe(true);
    // A different WeChat user is still refused.
    expect(
      runtime.isRemoteCallerAuthorized({ channelType: "openclaw-weixin", channelUserId: "wx-2" }),
    ).toBe(false);
  });

  it("ends authority immediately on unbind", async () => {
    const { runtime } = makeRuntime();
    await runtime.bindIdentity({
      channelType: "openclaw-weixin",
      channelUserId: "wx-1",
      deviceId: "device-a",
    });
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    await runtime.unbindIdentity();
    expect(runtime.getIdentityBinding()).toBeNull();
    expect(
      runtime.isRemoteCallerAuthorized({ channelType: "openclaw-weixin", channelUserId: "wx-1" }),
    ).toBe(false);
  });

  it("refuses to bind without a device id", async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.bindIdentity({ channelType: "openclaw-weixin", channelUserId: "wx-1", deviceId: "" }),
    ).rejects.toThrow(/deviceId/);
  });
});

describe("CompanyClawRuntime browser policy", () => {
  it("denies every domain until one is configured", () => {
    const { runtime } = makeRuntime();
    expect(runtime.describeBrowserPolicy()).toEqual({
      allowedDomains: [],
      allowDownloads: false,
      allowUploads: false,
    });
    // Nothing is reachable before a domain is configured.
    expect(
      runtime.authorizeBrowserAction({ action: "navigate", url: "https://oa.example.com/" }),
    ).toEqual({ allowed: false, reason: "remote-not-authorized" });
  });

  it("requires live remote authorization before any browser action", () => {
    const { runtime } = makeRuntime();
    runtime.configureBrowser({
      allowedDomains: ["oa.example.com"],
      allowDownloads: false,
      allowUploads: false,
    });
    expect(
      runtime.authorizeBrowserAction({ action: "navigate", url: "https://oa.example.com/" }),
    ).toEqual({ allowed: false, reason: "remote-not-authorized" });
  });

  it("allows a read on an approved domain once remote operation is live", () => {
    const { runtime } = makeRuntime();
    runtime.configureBrowser({
      allowedDomains: ["oa.example.com"],
      allowDownloads: false,
      allowUploads: false,
    });
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    expect(
      runtime.authorizeBrowserAction({ action: "navigate", url: "https://oa.example.com/tickets" }),
    ).toEqual({ allowed: true, risk: "read" });
  });

  it("reports a form submission as a write so an approval is required", () => {
    const { runtime } = makeRuntime();
    runtime.configureBrowser({
      allowedDomains: ["oa.example.com"],
      allowDownloads: false,
      allowUploads: false,
    });
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    expect(
      runtime.authorizeBrowserAction({
        action: "fill-form",
        url: "https://oa.example.com/tickets",
      }),
    ).toEqual({ allowed: true, risk: "write" });
  });

  it("refuses a write on a domain outside the allow list", () => {
    const { runtime } = makeRuntime();
    runtime.configureBrowser({
      allowedDomains: ["oa.example.com"],
      allowDownloads: false,
      allowUploads: false,
    });
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    expect(
      runtime.authorizeBrowserAction({ action: "navigate", url: "https://evil.net/" }),
    ).toEqual({ allowed: false, reason: "domain-not-allowed" });
  });

  it("keeps downloads off until explicitly enabled", () => {
    const { runtime } = makeRuntime();
    runtime.configureBrowser({
      allowedDomains: ["oa.example.com"],
      allowDownloads: false,
      allowUploads: false,
    });
    runtime.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    expect(
      runtime.authorizeBrowserAction({
        action: "download",
        url: "https://oa.example.com/report.xlsx",
      }),
    ).toEqual({ allowed: false, reason: "downloads-disabled" });
  });
});

describe("CompanyClawRuntime broker targets", () => {
  it("starts with an empty allow list so the broker denies everything", () => {
    const { runtime } = makeRuntime();
    expect(runtime.getBrokerTargets()).toEqual({
      allowedProcesses: [],
      allowedWindowTitles: [],
    });
  });

  it("stores a normalized allow list", async () => {
    const { runtime } = makeRuntime();
    const saved = await runtime.setBrokerTargets({
      allowedProcesses: ["Notepad.exe", "excel"],
      allowedWindowTitles: ["工单"],
    });
    expect(saved.allowedProcesses).toEqual(["notepad", "excel"]);
    expect(saved.allowedWindowTitles).toEqual(["工单"]);
  });

  it("pushes a change to the broker applier so it takes effect", async () => {
    const { runtime } = makeRuntime();
    const applied: unknown[] = [];
    runtime.setBrokerTargetsApplier(async (targets) => {
      applied.push(targets);
    });
    await runtime.setBrokerTargets({
      allowedProcesses: ["notepad"],
      allowedWindowTitles: [],
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({ allowedProcesses: ["notepad"], allowedWindowTitles: [] });
  });

  it("still stores the list when no broker is running", async () => {
    const { runtime } = makeRuntime();
    await runtime.setBrokerTargets({ allowedProcesses: ["notepad"], allowedWindowTitles: [] });
    expect(runtime.getBrokerTargets().allowedProcesses).toEqual(["notepad"]);
  });
});

describe("remote messages create tasks from trusted identity", () => {
  async function boundRuntime() {
    const { runtime } = makeRuntime();
    await runtime.bindIdentity({
      channelType: "weixin",
      channelUserId: "wx-user-1",
      deviceId: "device-a",
    });
    return runtime;
  }

  it("creates a task whose owner comes from the local binding", async () => {
    const runtime = await boundRuntime();
    const result = await runtime.createTaskFromRemote({
      channelType: "weixin",
      channelUserId: "wx-user-1",
      messageId: "msg-1",
      objective: "查询工单",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The identity is the bound one, not anything the message carried.
    expect(result.task.ownerSid).toBe("S-1");
    expect(result.task.deviceId).toBe("device-a");
    expect(result.resumed).toBe(false);
  });

  it("resumes the same task when the channel redelivers the message", async () => {
    const runtime = await boundRuntime();
    const first = await runtime.createTaskFromRemote({
      channelType: "weixin",
      channelUserId: "wx-user-1",
      messageId: "msg-1",
      objective: "查询工单",
    });
    const second = await runtime.createTaskFromRemote({
      channelType: "weixin",
      channelUserId: "wx-user-1",
      messageId: "msg-1",
      objective: "查询工单",
    });
    if (!first.ok || !second.ok) throw new Error("expected tasks");
    expect(second.resumed).toBe(true);
    expect(second.task.taskId).toBe(first.task.taskId);
    expect(runtime.listTasks({ ownerSid: "S-1" })).toHaveLength(1);
  });

  it("refuses a sender that is not the paired identity", async () => {
    const runtime = await boundRuntime();
    const result = await runtime.createTaskFromRemote({
      channelType: "weixin",
      channelUserId: "wx-someone-else",
      messageId: "msg-2",
      objective: "查询工单",
    });
    expect(result).toEqual({ ok: false, reason: "unbound-sender" });
    expect(runtime.listTasks({ ownerSid: "S-1" })).toHaveLength(0);
  });

  it("refuses a message with no channel id, since de-duplication needs one", async () => {
    const runtime = await boundRuntime();
    const result = await runtime.createTaskFromRemote({
      channelType: "weixin",
      channelUserId: "wx-user-1",
      messageId: "  ",
      objective: "查询工单",
    });
    expect(result).toEqual({ ok: false, reason: "missing-message-id" });
  });

  it("does not let one sender's message id collide with another's", async () => {
    const runtime = await boundRuntime();
    await runtime.createTaskFromRemote({
      channelType: "weixin",
      channelUserId: "wx-user-1",
      messageId: "shared-id",
      objective: "a",
    });
    // A different sender using the same id must not resume the first task.
    const other = await runtime.createTaskFromRemote({
      channelType: "weixin",
      channelUserId: "wx-user-2",
      messageId: "shared-id",
      objective: "b",
    });
    expect(other).toEqual({ ok: false, reason: "unbound-sender" });
  });

  it("reports the bound owner to the trusted-context builder", async () => {
    const runtime = await boundRuntime();
    expect(
      runtime.resolveRemoteOwner({ channelType: "weixin", channelUserId: "wx-user-1" }),
    ).toEqual({ ownerSid: "S-1", deviceId: "device-a" });
    expect(
      runtime.resolveRemoteOwner({ channelType: "weixin", channelUserId: "nobody" }),
    ).toBeNull();
  });
});
