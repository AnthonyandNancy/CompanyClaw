import { describe, expect, it } from "vitest";
import { CompanyClawRuntime, type RuntimePaths } from "../runtime";

/**
 * Persistence and scope rules for the V5 permission document.
 *
 * Rulings Q6/Q8 make two promises that only a restart can falsify: an
 * authorization the employee granted must still be there tomorrow, and an
 * authorization they revoked must not come back. Both are checked by building a
 * second runtime over the same files.
 */

const NOW = () => new Date("2026-10-10T00:00:00Z");

function memoryIo(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    write: async (filePath: string, contents: string) => {
      files.set(filePath, contents);
    },
    read: (filePath: string) => files.get(filePath) ?? "",
    exists: (filePath: string) => files.has(filePath),
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

function makeRuntime(io: ReturnType<typeof memoryIo>, now = NOW) {
  return new CompanyClawRuntime({
    paths: PATHS,
    ownerSid: "S-1",
    now,
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

describe("permission persistence", () => {
  it("starts from BASIC with nothing granted", () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    const policy = runtime.getPermissionPolicy();
    expect(policy.preset).toBe("BASIC");
    expect(policy.trustedApps).toEqual([]);
    expect(policy.remote.enabled).toBe(false);
  });

  it("keeps a granted remote authorization across a restart", async () => {
    const io = memoryIo();
    const first = makeRuntime(io);
    first.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 7 * 24 * 60,
    });
    // The remote record is written through the permission document.
    await first.flushPermissionWrites();

    const second = makeRuntime(io);
    const restored = second.getRemoteAuthorization();
    expect(restored.state).toBe("enabled");
    expect(restored.expiresAt).not.toBeNull();
  });

  it("does not resurrect a revoked authorization after a restart", async () => {
    const io = memoryIo();
    const first = makeRuntime(io);
    first.setRemoteAuthorization({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMinutes: 60,
    });
    await first.flushPermissionWrites();
    first.setRemoteAuthorization({ enabled: false });
    await first.flushPermissionWrites();

    const second = makeRuntime(io);
    expect(second.getRemoteAuthorization().state).not.toBe("enabled");
  });

  it("requires an explicit acknowledgement before enabling the daily preset", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    await expect(runtime.setPreset({ preset: "FULL_DAILY" })).rejects.toThrow(/确认/);
    await runtime.setPreset({ preset: "FULL_DAILY", acknowledged: true });
    expect(runtime.getPermissionPolicy().preset).toBe("FULL_DAILY");
  });

  it("bumps the policy version on every decision-affecting change", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    const before = runtime.getPermissionPolicy().policyVersion;
    await runtime.setPreset({ preset: "FULL_DAILY", acknowledged: true });
    const afterPreset = runtime.getPermissionPolicy().policyVersion;
    expect(afterPreset).toBeGreaterThan(before);
    await runtime.trustApp({ processName: "notepad" });
    expect(runtime.getPermissionPolicy().policyVersion).toBeGreaterThan(afterPreset);
  });

  it("keeps advanced rules when the preset changes", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    await runtime.trustApp({ processName: "notepad" });
    await runtime.setPreset({ preset: "FULL_DAILY", acknowledged: true });
    await runtime.setPreset({ preset: "BASIC" });
    expect(runtime.getPermissionPolicy().trustedApps.map((app: { processName: string }) => app.processName)).toEqual([
      "notepad",
    ]);
  });
});

describe("application trust scope", () => {
  it("defaults a new grant to the local channel only", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    await runtime.trustApp({ processName: "notepad" });
    expect(runtime.isAppTrusted("notepad", "local")).toBe(true);
    expect(runtime.isAppTrusted("notepad", "remote")).toBe(false);
  });

  it("never lets a migrated legacy entry authorize a remote run", () => {
    const io = memoryIo({
      "C:/state/broker-targets.json": JSON.stringify({
        contract: "companyclaw.broker-targets.v1",
        schemaVersion: 1,
        allowedProcesses: ["notepad"],
        allowedWindowTitles: [],
      }),
    });
    const runtime = makeRuntime(io);
    expect(runtime.isAppTrusted("notepad", "local")).toBe(true);
    expect(runtime.isAppTrusted("notepad", "remote")).toBe(false);
    expect(runtime.getPermissionPolicy().preset).toBe("BASIC");
  });

  it("rejects an entry that is not a single executable name", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    expect(await runtime.trustApp({ processName: "C:\\Windows\\notepad.exe" })).toBeNull();
    expect(runtime.getPermissionPolicy().trustedApps).toEqual([]);
  });

  it("removes a grant on revoke", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    await runtime.trustApp({ processName: "notepad" });
    await runtime.revokeTrustedApp("notepad");
    expect(runtime.isAppTrusted("notepad", "local")).toBe(false);
  });
});

describe("task scope grants", () => {
  it("covers only its own task, owner and device", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "local",
      objective: "整理报表",
    });
    await runtime.grantTaskScope({
      taskId: task.taskId,
      ownerSid: "S-1",
      deviceId: "device-a",
      origin: "local-ui",
      targets: ["excel"],
      ttlMs: 60_000,
    });
    expect(
      runtime.isTaskGranted({
        taskId: task.taskId,
        ownerSid: "S-1",
        deviceId: "device-a",
        target: "EXCEL",
      }),
    ).toBe(true);
    expect(
      runtime.isTaskGranted({
        taskId: task.taskId,
        ownerSid: "S-1",
        deviceId: "device-b",
        target: "excel",
      }),
    ).toBe(false);
    expect(
      runtime.isTaskGranted({
        taskId: "other-task",
        ownerSid: "S-1",
        deviceId: "device-a",
        target: "excel",
      }),
    ).toBe(false);
  });

  it("refuses to grant scope for a task that belongs to someone else", async () => {
    const io = memoryIo();
    const runtime = makeRuntime(io);
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "local",
      objective: "x",
    });
    await expect(
      runtime.grantTaskScope({
        taskId: task.taskId,
        ownerSid: "S-2",
        deviceId: "device-a",
        origin: "local-ui",
        targets: ["excel"],
        ttlMs: 1_000,
      }),
    ).rejects.toThrow(/not owned/);
  });

  it("expires a grant once its window has passed", async () => {
    const io = memoryIo();
    let clock = new Date("2026-10-10T00:00:00Z");
    const runtime = new CompanyClawRuntime({
      paths: PATHS,
      ownerSid: "S-1",
      now: () => clock,
      createId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      writeFile: io.write,
      readFile: io.read,
      existsFile: io.exists,
      ticketSecret: "runtime-secret",
    });
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "local",
      objective: "x",
    });
    await runtime.grantTaskScope({
      taskId: task.taskId,
      ownerSid: "S-1",
      deviceId: "device-a",
      origin: "local-ui",
      targets: ["excel"],
      ttlMs: 60_000,
    });
    clock = new Date("2026-10-10T00:02:00Z");
    expect(
      runtime.isTaskGranted({
        taskId: task.taskId,
        ownerSid: "S-1",
        deviceId: "device-a",
        target: "excel",
      }),
    ).toBe(false);
  });
});
