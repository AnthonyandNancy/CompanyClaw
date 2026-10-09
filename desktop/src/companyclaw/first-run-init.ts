import { DEFAULT_PORT } from "../constants";

/**
 * First-run configuration for a machine that never ran the legacy Python
 * installer.
 *
 * The NSIS package is the only supported employee distribution, and it ships
 * no pre-generated `openclaw.json`. Without this step the Gateway starts with
 * an empty auth token and browser automation has no executable configured —
 * both of which used to be written by `deployer/windows_setup.py`.
 *
 * Planning is pure: the caller decides where and how to persist the result.
 */

export const GATEWAY_AUTH_MODE = "token";

export interface FirstRunConfigInput {
  existing: Record<string, unknown> | null;
  createToken: () => string;
  port?: number;
}

export interface FirstRunConfigResult {
  config: Record<string, unknown>;
  changed: string[];
}

export interface BrowserConfigResult {
  config: Record<string, unknown>;
  changed: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function planFirstRunConfig(input: FirstRunConfigInput): FirstRunConfigResult {
  const config: Record<string, unknown> = { ...(input.existing ?? {}) };
  const changed: string[] = [];

  const gateway = isPlainObject(config.gateway) ? { ...config.gateway } : {};
  const auth = isPlainObject(gateway.auth) ? { ...gateway.auth } : {};

  const hasToken = typeof auth.token === "string" && auth.token.trim().length > 0;
  if (!hasToken) {
    auth.token = input.createToken();
    changed.push("gateway.auth.token");
  }
  if (auth.mode !== GATEWAY_AUTH_MODE) {
    auth.mode = GATEWAY_AUTH_MODE;
    changed.push("gateway.auth.mode");
  }
  gateway.auth = auth;

  const port = gateway.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    gateway.port = input.port ?? DEFAULT_PORT;
    changed.push("gateway.port");
  }
  config.gateway = gateway;

  return { config, changed };
}

/**
 * Fills in the browser section only when the user has not configured it.
 *
 * OpenClaw ships browser automation as an optional capability that drives an
 * already-installed Chromium-family browser; Windows 11 always provides Edge,
 * so nothing has to be downloaded. An existing user value is never replaced.
 */
export function planBrowserConfig(
  config: Record<string, unknown>,
  edgePath: string | null,
): BrowserConfigResult {
  const next: Record<string, unknown> = { ...config };
  const changed: string[] = [];
  const browser = isPlainObject(next.browser) ? { ...next.browser } : {};

  if (typeof browser.enabled !== "boolean") {
    browser.enabled = true;
    changed.push("browser.enabled");
  }
  if (
    edgePath &&
    (typeof browser.executablePath !== "string" || browser.executablePath.trim().length === 0)
  ) {
    browser.executablePath = edgePath;
    changed.push("browser.executablePath");
  }
  next.browser = browser;
  return { config: next, changed };
}

/** Candidate Edge locations, mirroring the legacy installer's probe order. */
export function edgeExecutableCandidates(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  if (localAppData) {
    candidates.push(`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  candidates.push(`${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`);
  candidates.push(`${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`);
  return candidates;
}

/** Returns the first Edge that actually exists, or null when there is none. */
export function findEdgeExecutable(
  env: Record<string, string | undefined>,
  exists: (candidate: string) => boolean,
): string | null {
  for (const candidate of edgeExecutableCandidates(env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
