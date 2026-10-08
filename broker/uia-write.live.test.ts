import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFindElements,
  runListWindows,
  runReadValue,
  runSendKeys,
  runSetValue,
} from "./uia";

/**
 * Live write verification against a real Windows application.
 *
 * The test launches its own Notepad window, writes into its edit control, then
 * asserts the change by reading it back — the same read-back rule the broker
 * enforces before it reports success. The process is terminated afterwards, so
 * nothing on the user's desktop is left modified.
 *
 * Skipped off Windows so other hosts stay green.
 */
const isWindows = process.platform === "win32";
const scriptDir = path.join(__dirname, "scripts");

const PROCESS_NAME = "notepad";
const TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Launches Notepad and waits until its window is visible to UIA. */
async function launchNotepad(): Promise<{ child: ChildProcess; pid: number }> {
  // Windows 11 ships a Store Notepad whose process may be `notepad`; the
  // classic binary at system32 is stable on every supported build.
  const child = spawn("C:\\Windows\\System32\\notepad.exe", [], {
    detached: false,
    stdio: "ignore",
  });
  const pid = child.pid ?? -1;
  expect(pid).toBeGreaterThan(0);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const windows = await runListWindows({ scriptDir, timeoutMs: TIMEOUT_MS });
    if (windows.ok) {
      const found = windows.value.some(
        (window) => window.processName.toLowerCase() === PROCESS_NAME,
      );
      if (found) return { child, pid };
    }
    await sleep(500);
  }
  throw new Error("notepad window never appeared");
}

function stopNotepad(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // A already-exited process is fine.
  }
}

describe.skipIf(!isWindows)("live UIA write path", () => {
  it("writes into a real application and confirms the change by read-back", async () => {
    const { child } = await launchNotepad();
    try {
      // Locate the document edit control by its control type rather than by a
      // title that changes with the document name.
      const tree = await runFindElements({
        scriptDir,
        processName: PROCESS_NAME,
        maxDepth: 6,
        maxElements: 400,
        timeoutMs: TIMEOUT_MS,
      });
      expect(tree.ok, `find-elements failed: ${tree.ok ? "" : tree.reason}`).toBe(true);
      if (!tree.ok) return;

      const editable = tree.value.elements.find(
        (element) =>
          element.controlType.includes("Edit") || element.className.includes("Edit"),
      );
      expect(
        editable,
        `no editable control found; saw ${tree.value.elements
          .map((element) => element.controlType)
          .join(", ")}`,
      ).toBeDefined();
      if (!editable) return;

      const selector = editable.automationId
        ? { automationId: editable.automationId }
        : { className: editable.className, controlType: editable.controlType };

      const marker = `CompanyClaw-${Date.now()}`;

      const written = await runSetValue({
        scriptDir,
        processName: PROCESS_NAME,
        selector,
        newValue: marker,
        maxDepth: 6,
        timeoutMs: TIMEOUT_MS,
      });
      expect(written.ok, `set-value failed: ${written.ok ? "" : written.reason}`).toBe(true);
      if (!written.ok) return;

      // The script reports its own read-back; the broker trusts only this.
      expect(written.value.verified).toBe(true);
      expect(written.value.observedValue).toBe(marker);

      // Independently re-read through a separate probe call.
      const reRead = await runReadValue({
        scriptDir,
        processName: PROCESS_NAME,
        selector,
        maxDepth: 6,
        timeoutMs: TIMEOUT_MS,
      });
      expect(reRead.ok, `read-value failed: ${reRead.ok ? "" : reRead.reason}`).toBe(true);
      if (!reRead.ok) return;
      expect(reRead.value.value).toBe(marker);
      expect(reRead.value.valueReadable).toBe(true);
    } finally {
      stopNotepad(child);
    }
  }, 300_000);

  it("reports a structured error when the selector matches nothing", async () => {
    const { child } = await launchNotepad();
    try {
      const result = await runReadValue({
        scriptDir,
        processName: PROCESS_NAME,
        selector: { automationId: "companyclaw-no-such-element" },
        maxDepth: 4,
        timeoutMs: TIMEOUT_MS,
      });
      expect(result).toEqual({ ok: false, reason: "target-element-not-found" });
    } finally {
      stopNotepad(child);
    }
  }, 300_000);
});

describe.skipIf(!isWindows)("live UIA send-keys path", () => {
  it("types into a real control and confirms the text landed", async () => {
    const { child } = await launchNotepad();
    try {
      const tree = await runFindElements({
        scriptDir,
        processName: PROCESS_NAME,
        maxDepth: 6,
        maxElements: 400,
        timeoutMs: TIMEOUT_MS,
      });
      expect(tree.ok).toBe(true);
      if (!tree.ok) return;

      const editable = tree.value.elements.find(
        (element) =>
          element.controlType.includes("Edit") || element.className.includes("Edit"),
      );
      expect(editable, "no editable control found").toBeDefined();
      if (!editable) return;

      const selector = editable.automationId
        ? { automationId: editable.automationId }
        : { className: editable.className, controlType: editable.controlType };

      // Replace mode: the field should end up holding exactly this text.
      const first = `CompanyClaw-A-${Date.now()}`;
      const typedOnce = await runSendKeys({
        scriptDir,
        processName: PROCESS_NAME,
        selector,
        text: first,
        append: false,
        maxDepth: 6,
        timeoutMs: TIMEOUT_MS,
      });
      expect(typedOnce.ok, `send-keys failed: ${typedOnce.ok ? "" : typedOnce.reason}`).toBe(true);
      if (!typedOnce.ok) return;
      expect(typedOnce.value.verified).toBe(true);
      expect(typedOnce.value.observedValue).toBe(first);

      // Append mode: the previous text must still be there.
      const suffix = `-B-${Date.now()}`;
      const appended = await runSendKeys({
        scriptDir,
        processName: PROCESS_NAME,
        selector,
        text: suffix,
        append: true,
        maxDepth: 6,
        timeoutMs: TIMEOUT_MS,
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;
      expect(appended.value.verified).toBe(true);
      expect(appended.value.observedValue).toBe(`${first}${suffix}`);
    } finally {
      stopNotepad(child);
    }
  }, 300_000);
});
