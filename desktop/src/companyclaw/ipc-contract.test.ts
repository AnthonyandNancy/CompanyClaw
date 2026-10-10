import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer can only reach the security core through IPC channel names.
 * If main and preload disagree on a name, the feature silently does nothing —
 * so the contract is pinned here rather than discovered at runtime.
 */
const srcDir = path.resolve(__dirname, "..");

function readSource(file: string): string {
  return readFileSync(path.join(srcDir, file), "utf-8");
}

const REQUIRED_CHANNELS = [
  "companyclaw:get-remote-authorization",
  "companyclaw:set-remote-authorization",
  "companyclaw:tasks:list",
  "companyclaw:tasks:get",
  "companyclaw:tasks:control",
  "companyclaw:approvals:list-pending",
  "companyclaw:approvals:resolve",
  "companyclaw:approvals:notify",
  "companyclaw:artifacts:resolve",
  "companyclaw:artifacts:deliver",
  "companyclaw:identity:get",
  "companyclaw:identity:bind",
  "companyclaw:identity:unbind",
  "companyclaw:health:report",
  "companyclaw:browser:get-policy",
  "companyclaw:browser:set-policy",
  "companyclaw:model:probe-capabilities",
  "companyclaw:broker:get-targets",
  "companyclaw:broker:set-targets",
  "companyclaw:broker:get-status",
  // V5: the permission document, cloud-vision authorization, the safe-defaults
  // reset, the decision audit and the controlled tool surface. Every one of
  // these is a channel the renderer calls by name, so a rename on either side
  // must break a test rather than silently disabling the feature.
  "companyclaw:permission:get-policy",
  "companyclaw:permission:set-preset",
  "companyclaw:permission:list-trusted-apps",
  "companyclaw:permission:trust-app",
  "companyclaw:permission:revoke-trusted-app",
  "companyclaw:permission:list-trusted-sites",
  "companyclaw:permission:trust-current-site",
  "companyclaw:permission:revoke-trusted-site",
  "companyclaw:permission:list-task-grants",
  "companyclaw:permission:revoke-task-grant",
  "companyclaw:vision:get",
  "companyclaw:vision:set",
  "companyclaw:vision:revoke",
  "companyclaw:recovery:preview",
  "companyclaw:recovery:apply",
  "companyclaw:audit:query",
  "companyclaw:tools:list",
] as const;

describe("CompanyClaw IPC contract", () => {
  it("registers every channel the renderer expects", () => {
    const ipcSource = readSource("companyclaw/ipc.ts");
    // `ipcMain.handle(` may wrap onto the next line, so assert on the quoted
    // channel literal rather than on a single-line call shape.
    for (const channel of REQUIRED_CHANNELS) {
      expect(ipcSource).toContain(`"${channel}"`);
    }
    expect((ipcSource.match(/ipcMain\.handle\(/g) ?? []).length).toBe(REQUIRED_CHANNELS.length);
  });

  it("exposes every channel through the preload bridge", () => {
    const preloadSource = readSource("preload.ts");
    for (const channel of REQUIRED_CHANNELS) {
      expect(preloadSource).toContain(`invoke("${channel}"`);
    }
  });

  it("exposes the namespace on window.openclaw as companyClaw", () => {
    expect(readSource("preload.ts")).toMatch(/companyClaw:\s*\{/);
  });

  it("keeps the renderer from choosing its own owner identity", () => {
    const ipcSource = readSource("companyclaw/ipc.ts");
    // Ownership must come from the main process options, never from IPC input.
    expect(ipcSource).toMatch(/ownerSid:\s*options\.ownerSid/);
    expect(ipcSource).not.toMatch(/ownerSid:\s*input\?\.ownerSid/);
  });

  it("wires the core into the main process without gating startup on it", () => {
    const mainSource = readSource("main.ts");
    expect(mainSource).toContain("registerCompanyClawIpcHandlers(");
    // Registration failure must not prevent the app from starting.
    expect(mainSource).toMatch(/\[companyclaw\] Failed to register security-core IPC/);
  });
});
