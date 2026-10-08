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
  /** Executable base name without .exe, as reported by the OS. */
  processName: string;
  automationId: string;
}

export interface ElementDescriptor {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  isEnabled: boolean;
  processId: number;
  depth: number;
}

export type UiaProbeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

interface RunPowerShellOptions {
  scriptDir: string;
  scriptName: string;
  timeoutMs?: number;
  runner?: typeof execFile;
  env?: Record<string, string>;
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
      processName: typeof record.processName === "string" ? record.processName : "",
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

export interface FindElementsResult {
  window: { name: string; processId: number };
  elements: ElementDescriptor[];
}

export interface FindElementsOptions extends ProbeOptions {
  processName: string;
  windowTitle?: string;
  maxDepth?: number;
  maxElements?: number;
}

/** Reads the control tree of one target window. Read-only; no input injection. */
export async function runFindElements(
  options: FindElementsOptions,
): Promise<UiaProbeResult<FindElementsResult>> {
  const env = {
    ...options.env,
    CC_TARGET_PROCESS: options.processName,
    ...(options.windowTitle ? { CC_TARGET_TITLE: options.windowTitle } : {}),
    ...(options.maxDepth !== undefined ? { CC_MAX_DEPTH: String(options.maxDepth) } : {}),
    ...(options.maxElements !== undefined ? { CC_MAX_ELEMENTS: String(options.maxElements) } : {}),
  };
  const raw = await runScript({ ...options, scriptName: "find-elements.ps1", env });
  if (!raw.ok) return raw;
  return parseFindElements(raw.value);
}

export function parseFindElements(raw: string): UiaProbeResult<FindElementsResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid-payload" };
  }
  const record = parsed as Record<string, unknown>;
  // The script reports a structured error rather than throwing, so a missing
  // window is distinguishable from an empty control tree.
  if (typeof record.error === "string") {
    return { ok: false, reason: record.error };
  }
  const windowRaw = record.window;
  if (typeof windowRaw !== "object" || windowRaw === null) {
    return { ok: false, reason: "invalid-payload" };
  }
  const windowRecord = windowRaw as Record<string, unknown>;
  if (typeof windowRecord.name !== "string") {
    return { ok: false, reason: "invalid-payload" };
  }
  const elementsRaw = record.elements;
  if (!Array.isArray(elementsRaw)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const elements: ElementDescriptor[] = [];
  for (const entry of elementsRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const element = entry as Record<string, unknown>;
    elements.push({
      name: typeof element.name === "string" ? element.name : "",
      automationId: typeof element.automationId === "string" ? element.automationId : "",
      controlType: typeof element.controlType === "string" ? element.controlType : "",
      className: typeof element.className === "string" ? element.className : "",
      isEnabled: element.isEnabled === true,
      processId: typeof element.processId === "number" ? element.processId : -1,
      depth: typeof element.depth === "number" ? element.depth : 0,
    });
  }
  return {
    ok: true,
    value: {
      window: {
        name: windowRecord.name,
        processId: typeof windowRecord.processId === "number" ? windowRecord.processId : -1,
      },
      elements,
    },
  };
}

function runScript(options: RunPowerShellOptions): Promise<UiaProbeResult<string>> {
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
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 60_000,
        windowsHide: true,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      },
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
