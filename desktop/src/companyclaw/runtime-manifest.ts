import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Integrity contract for the resources that ship inside the installer.
 *
 * The unified resource pipeline writes this manifest at build time and the app
 * reads it back at startup: if a shipped component is missing or was altered,
 * the app must say so in plain Chinese instead of failing later inside the
 * Gateway or the broker.
 */
export const RUNTIME_MANIFEST_CONTRACT = "companyclaw.runtime-manifest.v1";
export const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

export type RuntimeResourceKind =
  | "node"
  | "openclaw"
  | "broker"
  | "windows-node"
  | "appcontainer"
  | "plugin"
  | "skill"
  // V5: the vendored Windows-MCP payload, its private interpreter and any
  // architecture-matched native DLLs it needs. Each is hashed like every other
  // resource, so a missing or altered component is a build failure rather than
  // a runtime surprise.
  | "mcp"
  | "python-runtime"
  | "native";

export interface RuntimeManifestEntry {
  /** POSIX-style path relative to the resources root. */
  path: string;
  kind: RuntimeResourceKind;
  version: string;
  arch: "x64" | "arm64";
  sha256: string;
  license: string;
}

export interface RuntimeManifest {
  contract: typeof RUNTIME_MANIFEST_CONTRACT;
  arch: "x64" | "arm64";
  buildSha: string;
  entries: RuntimeManifestEntry[];
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export type RuntimeManifestVerification =
  | { ok: true; checked: number }
  | { ok: false; problems: string[] };

/**
 * Verifies every manifest entry against the files actually on disk.
 *
 * A missing file, a changed hash, a duplicate or a path that escapes the
 * resources root are all failures: a partially installed runtime must never be
 * treated as usable.
 */
export function verifyRuntimeManifest(
  manifest: unknown,
  resourcesRoot: string,
): RuntimeManifestVerification {
  const problems: string[] = [];
  if (typeof manifest !== "object" || manifest === null) {
    return { ok: false, problems: ["manifest-invalid"] };
  }
  const candidate = manifest as Partial<RuntimeManifest>;
  if (candidate.contract !== RUNTIME_MANIFEST_CONTRACT) {
    problems.push(`contract-mismatch: ${String(candidate.contract)}`);
  }
  const entries = Array.isArray(candidate.entries) ? candidate.entries : [];
  if (entries.length === 0) problems.push("entries-empty");

  const seen = new Set<string>();
  for (const entry of entries) {
    const relativePath = entry?.path;
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      problems.push("entry-path-invalid");
      continue;
    }
    if (relativePath.includes("..") || path.isAbsolute(relativePath)) {
      problems.push(`entry-path-escapes-root: ${relativePath}`);
      continue;
    }
    if (seen.has(relativePath)) {
      problems.push(`entry-duplicated: ${relativePath}`);
      continue;
    }
    seen.add(relativePath);
    const absolutePath = path.join(resourcesRoot, relativePath);
    if (!existsSync(absolutePath)) {
      problems.push(`missing: ${relativePath}`);
      continue;
    }
    let actual: string;
    try {
      actual = sha256File(absolutePath);
    } catch (error) {
      problems.push(
        `unreadable: ${relativePath} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (actual !== entry.sha256) problems.push(`hash-mismatch: ${relativePath}`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, checked: entries.length };
}
