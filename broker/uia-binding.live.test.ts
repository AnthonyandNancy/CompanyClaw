import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runFindElements, runListWindows } from "./uia";

/**
 * Live verification of the process-name binding and control-tree read against
 * the real Windows UI Automation API.
 *
 * Read-only: it never clicks, types or changes window state. Skipped off
 * Windows so other hosts stay green.
 */
const isWindows = process.platform === "win32";
const scriptDir = path.join(__dirname, "scripts");

describe.skipIf(!isWindows)("live UIA process binding (read-only)", () => {
  it("reports the owning executable for every window", async () => {
    const result = await runListWindows({ scriptDir, timeoutMs: 90_000 });
    expect(result.ok, `probe failed: ${result.ok ? "" : result.reason}`).toBe(true);
    if (!result.ok) return;

    // At least one window must expose a process name; without this the broker
    // could not bind an operation to an allowed application at all.
    const withProcess = result.value.filter((window) => window.processName.length > 0);
    expect(withProcess.length).toBeGreaterThan(0);

    // Names are executable base names, never paths.
    for (const window of withProcess) {
      expect(window.processName).not.toContain("\\");
      expect(window.processName).not.toContain("/");
      expect(window.processName.toLowerCase()).not.toContain(".exe");
    }
  }, 120_000);

  it("reads a real control tree for a window that is actually open", async () => {
    const windows = await runListWindows({ scriptDir, timeoutMs: 90_000 });
    expect(windows.ok).toBe(true);
    if (!windows.ok) return;

    // Pick whichever real application is currently present and exposes a
    // process name, so the check does not depend on one specific app being
    // open on the machine running it.
    const candidate = windows.value.find((window) => window.processName.length > 0);
    expect(candidate, "no window with a process name was found").toBeDefined();
    if (!candidate) return;

    const tree = await runFindElements({
      scriptDir,
      processName: candidate.processName,
      maxDepth: 2,
      maxElements: 20,
      timeoutMs: 90_000,
    });

    expect(tree.ok, `find-elements failed: ${tree.ok ? "" : tree.reason}`).toBe(true);
    if (!tree.ok) return;

    expect(tree.value.window.processId).toBeGreaterThan(0);
    // A real top-level window always exposes at least one child element.
    expect(tree.value.elements.length).toBeGreaterThan(0);
    for (const element of tree.value.elements) {
      expect(element.depth).toBeGreaterThanOrEqual(1);
      expect(typeof element.controlType).toBe("string");
    }
  }, 180_000);

  it("reports a structured error for a process that is not running", async () => {
    const tree = await runFindElements({
      scriptDir,
      processName: "companyclaw-definitely-not-running",
      maxDepth: 1,
      maxElements: 5,
      timeoutMs: 90_000,
    });
    expect(tree).toEqual({ ok: false, reason: "target-window-not-found" });
  }, 120_000);
});
