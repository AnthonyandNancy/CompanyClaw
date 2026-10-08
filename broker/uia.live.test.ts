import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runListWindows } from "./uia";

/**
 * Live probe against the real Windows UI Automation API.
 *
 * This is the one verification the broker can perform without a test account or
 * an internal system: it exercises the actual OS API on the real desktop. It is
 * skipped automatically on non-Windows hosts so CI on another OS stays green,
 * and it asserts only what a read-only probe can guarantee — it never clicks,
 * types or changes window state.
 */
const isWindows = process.platform === "win32";
const scriptDir = path.resolve(__dirname, "scripts");

describe.skipIf(!isWindows)("live UIA probe (read-only)", () => {
  it("enumerates real top-level windows through Windows UI Automation", async () => {
    const result = await runListWindows({ scriptDir, timeoutMs: 90_000 });

    expect(result.ok, `probe failed: ${result.ok ? "" : result.reason}`).toBe(true);
    if (!result.ok) return;

    // A logged-in interactive desktop always has at least one window; zero
    // windows would mean the probe silently did nothing.
    expect(result.value.length).toBeGreaterThan(0);

    // Every descriptor must carry a plausible pid; this is what lets the broker
    // bind an operation to a specific process instead of guessing by title.
    for (const window of result.value) {
      expect(Number.isInteger(window.processId)).toBe(true);
      expect(window.processId).toBeGreaterThan(0);
    }
  }, 120_000);

  it("returns window descriptors that can be filtered case-insensitively", async () => {
    const result = await runListWindows({ scriptDir, timeoutMs: 90_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The broker's allow-list compares executable base names case-insensitively;
    // verify the probe gives us stable names to compare against.
    const names = result.value.map((window) => window.name);
    expect(names.every((name) => typeof name === "string")).toBe(true);
  }, 120_000);
});
