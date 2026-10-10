import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Desktop-side check of the vendored Windows-MCP payload.
 *
 * The broker owns starting the server (`broker/adapters/windows-mcp/process-manager.ts`),
 * but the *health page* has to answer "why can't the computer be controlled?"
 * before the broker has ever been asked to do anything. That means the desktop
 * needs the same layout knowledge, and the two must not disagree — this file
 * mirrors the broker's definition and `windows-mcp-layout.test.ts` reads the
 * broker's own source to pin them together, exactly as the wire protocol is
 * pinned.
 *
 * The fault codes are the product's vocabulary, so they are also mirrored rather
 * than invented per call site.
 */

export const WINDOWS_MCP_PACKAGE_DIR = "windows-mcp";
export const WINDOWS_MCP_ENTRY = path.join("windows_mcp", "__main__.py");
export const WINDOWS_MCP_MANIFEST = "MANIFEST.json";

/** The pinned upstream release this build ships. */
export const WINDOWS_MCP_LOCK = {
  repository: "https://github.com/CursorTouch/Windows-MCP",
  commit: "b455c2766c63599d466a6178641bac70787979a4",
  version: "0.8.7",
  license: "MIT",
  /** `pyproject.toml` is authoritative; the upstream manifest's floor is not. */
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
  serverDir: string;
  pythonPath: string;
  manifestPath: string;
}

export interface WindowsMcpManifest {
  contract?: string;
  upstreamCommit: string;
  upstreamVersion: string;
  license: string;
  files: { path: string; sha256: string }[];
}

export interface LayoutProbeResult {
  ok: boolean;
  health: WindowsMcpHealth;
  /** Chinese, employee-readable, and specific about which part is missing. */
  detail: string;
  entryPoint?: string;
  pythonExecutable?: string;
}

/**
 * Where the payload lives inside the installed resources.
 *
 * Derived from the packaged-resources root so the desktop and the packager
 * cannot pick different locations: one root, one path.
 */
export function resolveWindowsMcpLayout(companyClawResourceDir: string): WindowsMcpLayout {
  const packageRoot = path.join(
    companyClawResourceDir,
    "companyclaw-broker",
    WINDOWS_MCP_PACKAGE_DIR,
  );
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

/** Checks presence, completeness and integrity of the shipped payload. */
export function probeWindowsMcpLayout(layout: WindowsMcpLayout): LayoutProbeResult {
  if (!existsSync(layout.serverDir)) {
    return {
      ok: false,
      health: "NOT_PACKAGED",
      detail: `未随包提供电脑操作组件（期望目录：${layout.serverDir}）`,
    };
  }
  const entryPoint = path.join(layout.serverDir, WINDOWS_MCP_ENTRY);
  if (!existsSync(entryPoint)) {
    return {
      ok: false,
      health: "NOT_PACKAGED",
      detail: `电脑操作组件入口缺失（期望文件：${entryPoint}）`,
    };
  }
  if (!existsSync(layout.pythonPath)) {
    return {
      ok: false,
      health: "RUNTIME_MISSING",
      detail: `私有运行组件缺失（期望文件：${layout.pythonPath}）`,
    };
  }
  if (!existsSync(layout.manifestPath)) {
    return {
      ok: false,
      health: "NOT_PACKAGED",
      detail: `电脑操作组件清单缺失（期望文件：${layout.manifestPath}）`,
    };
  }

  const manifest = parseManifest(readFileSync(layout.manifestPath, "utf-8"));
  if (!manifest) {
    return { ok: false, health: "HASH_MISMATCH", detail: "电脑操作组件清单不可解析" };
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
    const absolute = path.join(layout.serverDir, file.path);
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
    detail: `电脑操作组件已就绪（${manifest.upstreamVersion}，校验 ${manifest.files.length} 项）`,
    entryPoint,
    pythonExecutable: layout.pythonPath,
  };
}

/** The upstream tools this build may call, verified against a real handshake. */
export const WRAPPABLE_UPSTREAM_TOOLS: readonly string[] = [
  "App",
  "DisplayInventory",
  "Snapshot",
  "Screenshot",
  "Click",
  "Type",
  "Scroll",
  "Move",
  "Shortcut",
  "Wait",
  "WaitFor",
] as const;

/** The upstream tools this build refuses, whatever the caller asks for. */
export const DENIED_UPSTREAM_TOOLS: readonly string[] = [
  "PowerShell",
  "FileSystem",
  "Registry",
  "Process",
  "Clipboard",
  "Scrape",
  "Notification",
  "MultiSelect",
  "MultiEdit",
] as const;

/**
 * The tool counts shown on the health page.
 *
 * Counted from this build's own allow-map, so "已加载 N 项受控工具" is a fact
 * about what the product will actually do rather than the upstream's tool count.
 * `windows-mcp-layout.test.ts` reads the broker's map and asserts the two lists
 * still agree.
 */
export function loadedToolSummary(): { controllable: number; blocked: number; total: number } {
  return {
    controllable: WRAPPABLE_UPSTREAM_TOOLS.length,
    blocked: DENIED_UPSTREAM_TOOLS.length,
    total: WRAPPABLE_UPSTREAM_TOOLS.length + DENIED_UPSTREAM_TOOLS.length,
  };
}
