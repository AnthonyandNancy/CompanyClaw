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

/** Selector for one target element, mirrored into CC_SEL_* env vars. */
export interface ElementSelector {
  automationId?: string;
  name?: string;
  controlType?: string;
  className?: string;
  index?: number;
}

export interface ElementSummary {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  isEnabled: boolean;
  processId: number;
}

export interface WindowIdentity {
  name: string;
  processId: number;
}

function selectorToEnv(selector: ElementSelector): Record<string, string> {
  const env: Record<string, string> = {};
  if (selector.automationId) env.CC_SEL_AUTOMATION_ID = selector.automationId;
  if (selector.name) env.CC_SEL_NAME = selector.name;
  if (selector.controlType) env.CC_SEL_CONTROL_TYPE = selector.controlType;
  if (selector.className) env.CC_SEL_CLASS_NAME = selector.className;
  if (selector.index !== undefined) env.CC_SEL_INDEX = String(selector.index);
  return env;
}

export interface ReadValueOptions extends ProbeOptions {
  processName: string;
  windowTitle?: string;
  selector: ElementSelector;
  maxDepth?: number;
  maxVisited?: number;
}

export interface ReadValueResult {
  window: WindowIdentity;
  element: ElementSummary;
  /** Null when the element exposes no ValuePattern. */
  value: string | null;
  valueReadable: boolean;
}

export async function runReadValue(
  options: ReadValueOptions,
): Promise<UiaProbeResult<ReadValueResult>> {
  const raw = await runScript({
    ...options,
    scriptName: "read-value.ps1",
    env: { ...options.env, ...buildTargetEnv(options), ...selectorToEnv(options.selector) },
  });
  if (!raw.ok) return raw;
  return parseReadValue(raw.value);
}

export interface SetValueOptions extends ProbeOptions {
  processName: string;
  windowTitle?: string;
  selector: ElementSelector;
  newValue: string;
  maxDepth?: number;
  maxVisited?: number;
}

export interface SetValueResult {
  window: WindowIdentity;
  element: ElementSummary;
  previousValue: string | null;
  newValue: string;
  observedValue: string | null;
  /** Read-back comparison: the caller reports success only when this is true. */
  verified: boolean;
}

export async function runSetValue(
  options: SetValueOptions,
): Promise<UiaProbeResult<SetValueResult>> {
  const raw = await runScript({
    ...options,
    scriptName: "set-value.ps1",
    env: {
      ...options.env,
      ...buildTargetEnv(options),
      ...selectorToEnv(options.selector),
      CC_NEW_VALUE: options.newValue,
    },
  });
  if (!raw.ok) return raw;
  return parseSetValue(raw.value);
}

export interface InvokePatternOptions extends ProbeOptions {
  processName: string;
  windowTitle?: string;
  selector: ElementSelector;
  pattern?: "Invoke" | "SelectionItem";
  maxDepth?: number;
  maxVisited?: number;
}

export interface InvokePatternResult {
  window: WindowIdentity;
  element: ElementSummary;
  pattern: string;
  invoked: boolean;
}

export async function runInvokePattern(
  options: InvokePatternOptions,
): Promise<UiaProbeResult<InvokePatternResult>> {
  const raw = await runScript({
    ...options,
    scriptName: "invoke-pattern.ps1",
    env: {
      ...options.env,
      ...buildTargetEnv(options),
      ...selectorToEnv(options.selector),
      ...(options.pattern ? { CC_PATTERN: options.pattern } : {}),
    },
  });
  if (!raw.ok) return raw;
  return parseInvokePattern(raw.value);
}

function buildTargetEnv(options: {
  processName: string;
  windowTitle?: string;
  maxDepth?: number;
  maxVisited?: number;
}): Record<string, string> {
  const env: Record<string, string> = { CC_TARGET_PROCESS: options.processName };
  if (options.windowTitle) env.CC_TARGET_TITLE = options.windowTitle;
  if (options.maxDepth !== undefined) env.CC_MAX_DEPTH = String(options.maxDepth);
  if (options.maxVisited !== undefined) env.CC_MAX_VISITED = String(options.maxVisited);
  return env;
}

/** Shared parsing for the three element-addressing scripts. */
function parseElementOperation<T>(
  raw: string,
  build: (record: Record<string, unknown>, window: WindowIdentity, element: ElementSummary) => T,
): UiaProbeResult<T> {
  const base = parseWindowAndElement(raw);
  if (!base.ok) return base;
  return { ok: true, value: build(base.record, base.window, base.element) };
}

function parseWindowAndElement(
  raw: string,
):
  | { ok: true; record: Record<string, unknown>; window: WindowIdentity; element: ElementSummary }
  | { ok: false; reason: string } {
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
  if (typeof record.error === "string") {
    return { ok: false, reason: record.error };
  }
  const window = record.window;
  const element = record.element;
  if (
    typeof window !== "object" ||
    window === null ||
    typeof element !== "object" ||
    element === null
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  const windowRecord = window as Record<string, unknown>;
  const elementRecord = element as Record<string, unknown>;
  if (typeof windowRecord.name !== "string" || typeof elementRecord.controlType !== "string") {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    record,
    window: {
      name: windowRecord.name,
      processId: typeof windowRecord.processId === "number" ? windowRecord.processId : -1,
    },
    element: {
      name: typeof elementRecord.name === "string" ? elementRecord.name : "",
      automationId:
        typeof elementRecord.automationId === "string" ? elementRecord.automationId : "",
      controlType: elementRecord.controlType,
      className: typeof elementRecord.className === "string" ? elementRecord.className : "",
      isEnabled: elementRecord.isEnabled === true,
      processId: typeof elementRecord.processId === "number" ? elementRecord.processId : -1,
    },
  };
}

export function parseReadValue(raw: string): UiaProbeResult<ReadValueResult> {
  return parseElementOperation(raw, (record, window, element) => ({
    window,
    element,
    value: typeof record.value === "string" ? record.value : null,
    valueReadable: record.valueReadable === true,
  }));
}

export function parseSetValue(raw: string): UiaProbeResult<SetValueResult> {
  return parseElementOperation(raw, (record, window, element) => ({
    window,
    element,
    previousValue: typeof record.previousValue === "string" ? record.previousValue : null,
    newValue: typeof record.newValue === "string" ? record.newValue : "",
    observedValue: typeof record.observedValue === "string" ? record.observedValue : null,
    // Absent `verified` must never be read as success.
    verified: record.verified === true,
  }));
}

export interface SendKeysOptions extends ProbeOptions {
  processName: string;
  windowTitle?: string;
  selector: ElementSelector;
  text: string;
  /** Append to the existing value instead of replacing it. */
  append?: boolean;
  maxDepth?: number;
  maxVisited?: number;
}

export interface SendKeysResult {
  window: WindowIdentity;
  element: ElementSummary;
  typed: string;
  expected: string;
  observedValue: string | null;
  verified: boolean;
}

export async function runSendKeys(
  options: SendKeysOptions,
): Promise<UiaProbeResult<SendKeysResult>> {
  const raw = await runScript({
    ...options,
    scriptName: "send-keys.ps1",
    env: {
      ...options.env,
      ...buildTargetEnv(options),
      ...selectorToEnv(options.selector),
      CC_TEXT: options.text,
      CC_APPEND: options.append ? "1" : "0",
    },
  });
  if (!raw.ok) return raw;
  return parseSendKeys(raw.value);
}

export function parseSendKeys(raw: string): UiaProbeResult<SendKeysResult> {
  return parseElementOperation(raw, (record, window, element) => ({
    window,
    element,
    typed: typeof record.typed === "string" ? record.typed : "",
    expected: typeof record.expected === "string" ? record.expected : "",
    observedValue: typeof record.observedValue === "string" ? record.observedValue : null,
    verified: record.verified === true,
  }));
}

export function parseInvokePattern(raw: string): UiaProbeResult<InvokePatternResult> {
  return parseElementOperation(raw, (record, window, element) => ({
    window,
    element,
    pattern: typeof record.pattern === "string" ? record.pattern : "",
    invoked: record.invoked === true,
  }));
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
