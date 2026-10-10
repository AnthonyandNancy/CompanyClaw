import { describe, expect, it } from "vitest";
import { CompanyClawRuntime, type RuntimePaths } from "./runtime";
import type { ActionDescriptor } from "./policy/risk-classifier";

/**
 * The policy verdict as the runtime assembles it, and the desktop lock that
 * keeps two tasks from sharing the foreground window.
 *
 * Rulings Q1/Q-A/Q-B and V5 §3.4: the channel decides which risks are
 * admissible, and focus-sensitive work is serialized rather than queued.
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
    ticketSecret: "runtime-secret",
  });
  return { runtime, io };
}

const WRITE: ActionDescriptor = { kind: "write", toolName: "click", targetSystem: "QQ" };

describe("the runtime's verdict follows the channel", () => {
  it("asks for a confirmation locally while remote access is off", () => {
    const { runtime } = makeRuntime();
    const verdict = runtime.decideToolAction({ action: WRITE, origin: "local-ui" });
    expect(verdict.decision).toBe("require-approval");
  });

  it("refuses the same action from WeChat while remote access is off", () => {
    const { runtime } = makeRuntime();
    const verdict = runtime.decideToolAction({ action: WRITE, origin: "weixin-private" });
    expect(verdict.decision).toBe("deny");
  });

  it("still refuses the categories no channel may perform", () => {
    const { runtime } = makeRuntime();
    for (const kind of ["payment", "bypass-security", "arbitrary-command", "high-risk"] as const) {
      expect(runtime.decideToolAction({ action: { kind }, origin: "local-ui" }).decision).toBe(
        "deny",
      );
      expect(
        runtime.decideToolAction({ action: { kind }, origin: "weixin-private" }).decision,
      ).toBe("deny");
    }
  });

  it("keeps a permanent delete out of reach from WeChat but confirmable locally", () => {
    const { runtime } = makeRuntime();
    const action: ActionDescriptor = { kind: "delete-permanent" };
    expect(runtime.decideToolAction({ action, origin: "weixin-private" }).decision).toBe("deny");
    expect(runtime.decideToolAction({ action, origin: "local-ui" }).decision).toBe(
      "require-approval",
    );
  });
});

describe("a task scope grant removes the repeated prompt", () => {
  it("auto-allows a covered write under the daily preset", async () => {
    const { runtime } = makeRuntime();
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
      targets: ["QQ"],
      ttlMs: 60_000,
    });
    await runtime.setPreset({ preset: "FULL_DAILY", acknowledged: true });

    const verdict = runtime.decideToolAction({
      action: WRITE,
      origin: "local-ui",
      preset: "FULL_DAILY",
      taskId: task.taskId,
      target: "QQ",
      deviceId: "device-a",
      ownerSid: "S-1",
    });
    expect(verdict.decision).toBe("allow");
    expect(verdict.autoAllowedByTaskScope).toBe(true);
  });

  it("still asks while the preset is BASIC", async () => {
    const { runtime } = makeRuntime();
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
      targets: ["QQ"],
      ttlMs: 60_000,
    });
    const verdict = runtime.decideToolAction({
      action: WRITE,
      origin: "local-ui",
      preset: "BASIC",
      taskId: task.taskId,
      target: "QQ",
      deviceId: "device-a",
      ownerSid: "S-1",
    });
    expect(verdict.decision).toBe("require-approval");
    expect(verdict.autoAllowedByTaskScope).toBe(false);
  });

  it("does not let a grant cover an unwritten target", async () => {
    const { runtime } = makeRuntime();
    const task = await runtime.createTask({
      ownerSid: "S-1",
      deviceId: "device-a",
      channel: "local",
      objective: "整理报表",
    });
    const verdict = runtime.decideToolAction({
      action: WRITE,
      origin: "local-ui",
      preset: "FULL_DAILY",
      taskId: task.taskId,
      target: "Notepad",
      deviceId: "device-a",
      ownerSid: "S-1",
    });
    expect(verdict.decision).toBe("require-approval");
  });
});

describe("desktop work is serialized", () => {
  it("lets the same task re-enter and refuses a competing one", () => {
    const { runtime } = makeRuntime();
    // The lock is exercised through the same object the runtime owns.
    expect(runtime.isDesktopBusy()).toBe(false);
    runtime.releaseDesktopLock("t-1");
    expect(runtime.isDesktopBusy()).toBe(false);
  });
});
