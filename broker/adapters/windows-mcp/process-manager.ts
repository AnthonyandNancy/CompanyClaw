import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Launches and supervises the pinned Windows-MCP server.
 *
 * Three constraints from the requirement shape this module:
 *
 *   1. the server is started from a **fixed, hash-verified path** — the adapter
 *      never accepts a caller-supplied `command`/`args`, because that would turn
 *      "integrated desktop backend" into "run anything";
 *   2. the employee's machine runs **no** `uvx`/`pip`/network fetch, so the
 *      runtime is the private Python shipped inside the installer;
 *   3. a missing or altered payload is reported as a specific fault
 *      (`NOT_PACKAGED`, `HASH_MISMATCH`) rather than being mistaken for the
 *      model failing to operate the desktop.
 */

export const WINDOWS_MCP_PACKAGE_DIR = "windows-mcp";
export const WINDOWS_MCP_ENTRY = path.join("windows_mcp", "__main__.py");
export const WINDOWS_MCP_MANIFEST = "MANIFEST.json";

export const WINDOWS_MCP_LOCK = {
  repository: "https://github.com/CursorTouch/Windows-MCP",
  commit: "b455c2766c63599d466a6178641bac70787979a4",
  version: "0.8.7",
  license: "MIT",
  /** `pyproject.toml` is authoritative; the manifest's floor is not. */
  requiresPython: ">=3.14",
} as const;

export type WindowsMcpHealth =
  | "NOT_PACKAGED"
  | "HASH_MISMATCH"
  | "RUNTIME_MISSING"
  | "START_FAILED"
  | "HANDSHAKE_FAILED"
  | "TOOLS_MISSING"
  | "SESSION_LOCKED"
  | "READY";

export interface WindowsMcpLayout {
  /** Directory holding the pip-installed server package. */
  serverDir: string;
  /** Private interpreter shipped with the app. */
  pythonPath: string;
  /** Optional manifest of expected file hashes. */
  manifestPath: string;
}

export interface WindowsMcpManifest {
  contract?: string;
  upstreamCommit: string;
  upstreamVersion: string;
  license: string;
  /** POSIX-style paths relative to `serverDir`. */
  files: { path: string; sha256: string }[];
}

export interface LayoutProbeResult {
  ok: boolean;
  health: WindowsMcpHealth;
  detail: string;
  /** Absolute path to the entry module, when the layout is usable. */
  entryPoint?: string;
  /** Absolute path to the private interpreter, when present. */
  pythonExecutable?: string;
}

export function resolveWindowsMcpLayout(resourcesRoot: string): WindowsMcpLayout {
  const brokerResources = path.join(resourcesRoot, "companyclaw-broker");
  const packageRoot = path.join(brokerResources, WINDOWS_MCP_PACKAGE_DIR);
  return {
    serverDir: path.join(packageRoot, "server"),
    pythonPath: path.join(packageRoot, "python-runtime", "Scripts", "python.exe"),
    manifestPath: path.join(packageRoot, WINDOWS_MCP_MANIFEST),
  };
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function parseManifest(raw: string): WindowsMcpManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<WindowsMcpManifest>;
  if (typeof candidate.upstreamCommit !== "string") return null;
  if (!Array.isArray(candidate.files)) return null;
  for (const file of candidate.files) {
    if (typeof file?.path !== "string" || typeof file?.sha256 !== "string") return null;
  }
  return candidate as WindowsMcpManifest;
}

/**
 * Checks that the payload is present, complete and unaltered.
 *
 * Every failure maps to a named health state so the UI can say *which* component
 * is missing instead of showing "AI 服务启动失败".
 */
export function probeWindowsMcpLayout(layout: WindowsMcpLayout): LayoutProbeResult {
  if (!existsSync(layout.serverDir)) {
    return {
      ok: false,
      health: "NOT_PACKAGED",
      detail: `未随包提供 Windows-MCP 组件（期望目录：${layout.serverDir}）`,
    };
  }
  const serverDir = layout.serverDir;
  const entryPoint = path.join(serverDir, WINDOWS_MCP_ENTRY);
  if (!existsSync(entryPoint)) {
    return {
      ok: false,
      health: "NOT_PACKAGED",
      detail: `Windows-MCP 入口缺失（期望文件：${entryPoint}）`,
    };
  }
  const pythonExecutable = layout.pythonPath;
  if (!existsSync(pythonExecutable)) {
    return {
      ok: false,
      health: "RUNTIME_MISSING",
      detail: `私有 Python 运行时缺失（期望文件：${pythonExecutable}）`,
    };
  }

  if (!existsSync(layout.manifestPath)) {
    return {
      ok: false,
      health: "NOT_PACKAGED",
      detail: `Windows-MCP 组件清单缺失（期望文件：${layout.manifestPath}）`,
    };
  }

  const manifest = parseManifest(readFileSync(layout.manifestPath, "utf-8"));
  if (!manifest) {
    return {
      ok: false,
      health: "HASH_MISMATCH",
      detail: "Windows-MCP 组件清单不可解析",
    };
  }
  if (manifest.upstreamCommit !== WINDOWS_MCP_LOCK.commit) {
    return {
      ok: false,
      health: "HASH_MISMATCH",
      detail: `组件版本与锁定不一致（包内 ${manifest.upstreamCommit}，期望 ${WINDOWS_MCP_LOCK.commit}）`,
    };
  }

  for (const file of manifest.files) {
    if (file.path.includes("..") || path.isAbsolute(file.path)) {
      return { ok: false, health: "HASH_MISMATCH", detail: `清单包含越界路径：${file.path}` };
    }
    const absolute = path.join(serverDir, file.path);
    if (!existsSync(absolute)) {
      return { ok: false, health: "HASH_MISMATCH", detail: `组件文件缺失：${file.path}` };
    }
    let actual: string;
    try {
      actual = sha256File(absolute);
    } catch {
      return { ok: false, health: "HASH_MISMATCH", detail: `组件文件无法读取：${file.path}` };
    }
    if (actual !== file.sha256) {
      return { ok: false, health: "HASH_MISMATCH", detail: `组件文件校验失败：${file.path}` };
    }
  }

  return {
    ok: true,
    health: "READY",
    detail: `Windows-MCP ${manifest.upstreamVersion} 已就绪（校验 ${manifest.files.length} 项）`,
    entryPoint,
    pythonExecutable,
  };
}

/**
 * The environment the server is started with.
 *
 * Telemetry is off, the watchdog stays off (the upstream README states it can
 * crash the server on unstable UIA environments), and the tool list is pinned to
 * exactly the wrappable set so the server itself refuses to serve the rest even
 * if a request somehow reached it directly.
 */
export function buildServerEnvironment(input: {
  wrappableTools: readonly string[];
  base?: NodeJS.ProcessEnv;
  /** Private cache/config locations so the employee's profile is untouched. */
  stateDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(input.base ?? process.env),
    ANONYMIZED_TELEMETRY: "false",
    WINDOWS_MCP_WATCHDOG: "off",
    WINDOWS_MCP_PROFILE_SNAPSHOT: "false",
    WINDOWS_MCP_TOOLS: input.wrappableTools.join(","),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: input.stateDir,
  };
  return env;
}

/**
 * Builds the fixed argv for the server.
 *
 * `stdio` is the only transport used: the server listens on no port, so nothing
 * on the machine — or the network — can reach it without going through the
 * adapter.
 */
export function buildServerArgs(input: { serverDir: string }): string[] {
  return ["-m", "windows_mcp", "serve", "--transport", "stdio"];
}
