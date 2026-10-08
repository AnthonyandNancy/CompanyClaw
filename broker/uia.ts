import { execFile } from "node:child_process";
import * as path from "node:path";

/**
 * Read-only Windows UI Automation probes.
 *
 * Every probe runs an ExecutionPolicy-Bypass PowerShell script from
 * `broker/scripts/`. Nothing here injects input or mutates application state,
 * so these are the only operations the broker offers without a ticket.
 */

export interface WindowDescriptor {
  name: string;
  processId: number;
  automationId: string;
}

export type UiaProbeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

interface RunPowerShellOptions {
  scriptDir: string;
  scriptName: string;
  timeoutMs?: number;
  runner?: typeof execFile;
}

/** Options callers actually supply; the script name is chosen per probe. */
export type ProbeOptions = Omit<RunPowerShellOptions, "scriptName">;

/** Parses the `{ windows: [...] }` payload the scripts emit. */
export function parseWindowList(raw: string): UiaProbeResult<WindowDescriptor[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid-payload" };
  }
  const windows = (parsed as { windows?: unknown }).windows;
  if (!Array.isArray(windows)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const descriptors: WindowDescriptor[] = [];
  for (const entry of windows) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    descriptors.push({
      name: record.name,
      processId: typeof record.processId === "number" ? record.processId : -1,
      automationId: typeof record.automationId === "string" ? record.automationId : "",
    });
  }
  return { ok: true, value: descriptors };
}

export function runListWindows(
  options: ProbeOptions,
): Promise<UiaProbeResult<WindowDescriptor[]>> {
  return runScript({ ...options, scriptName: "list-windows.ps1" }).then((result) =>
    result.ok ? parseWindowList(result.value) : result,
  );
}

function runScript(
  options: RunPowerShellOptions,
): Promise<UiaProbeResult<string>> {
  const runner = options.runner ?? execFile;
  const scriptPath = path.join(options.scriptDir, options.scriptName);
  return new Promise((resolve) => {
    runner(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      // Force UTF-8 so window titles survive the pipe on a non-English system.
      { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: `probe-failed: ${String(error.message)}` });
          return;
        }
        resolve({ ok: true, value: String(stdout ?? "") });
      },
    );
  });
}
