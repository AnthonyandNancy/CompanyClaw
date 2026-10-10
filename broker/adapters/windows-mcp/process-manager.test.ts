import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildServerArgs,
  buildServerEnvironment,
  parseManifest,
  probeWindowsMcpLayout,
  resolveWindowsMcpLayout,
  WINDOWS_MCP_ENTRY,
  WINDOWS_MCP_LOCK,
  type WindowsMcpLayout,
} from "./process-manager";

/**
 * Ruling V5 §6.1/§6.3: the employee's machine runs no installer, and a missing
 * or altered payload must be named precisely instead of surfacing as "the model
 * cannot operate the computer".
 */

function makeLayout(options: { withRuntime?: boolean; withManifest?: boolean; tamper?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wmcp-layout-"));
  const resourcesRoot = path.join(root, "resources");
  const layout = resolveWindowsMcpLayout(resourcesRoot);

  // The payload mirrors an installed package: `server/windows_mcp/...` plus a
  // private interpreter under `python-runtime/Scripts/`.
  mkdirSync(path.join(layout.serverDir, path.dirname(WINDOWS_MCP_ENTRY)), { recursive: true });
  const entry = path.join(layout.serverDir, WINDOWS_MCP_ENTRY);
  writeFileSync(entry, "print('windows-mcp')\n", "utf-8");
  const extra = path.join(layout.serverDir, "windows_mcp", "config.py");
  writeFileSync(extra, "SETTING = 1\n", "utf-8");

  if (options.withRuntime !== false) {
    mkdirSync(path.dirname(layout.pythonPath), { recursive: true });
    writeFileSync(layout.pythonPath, "fake-interpreter", "utf-8");
  }
  if (options.withManifest !== false) {
    const hash = (file: string) =>
      createHash("sha256").update(require("node:fs").readFileSync(file)).digest("hex");
    const files = [
      { path: WINDOWS_MCP_ENTRY.replace(/\\/g, "/"), sha256: hash(entry) },
      { path: "windows_mcp/config.py", sha256: options.tamper ? "0".repeat(64) : hash(extra) },
    ];
    writeFileSync(
      layout.manifestPath,
      JSON.stringify({
        contract: "companyclaw.windows-mcp.v1",
        upstreamCommit: WINDOWS_MCP_LOCK.commit,
        upstreamVersion: WINDOWS_MCP_LOCK.version,
        license: WINDOWS_MCP_LOCK.license,
        files,
      }),
      "utf-8",
    );
  }
  return { layout, root };
}

describe("layout probe", () => {
  it("reports READY for a complete, unaltered payload", () => {
    const { layout } = makeLayout();
    const result = probeWindowsMcpLayout(layout);
    expect(result.health).toBe("READY");
    expect(result.entryPoint).toBe(path.join(layout.serverDir, WINDOWS_MCP_ENTRY));
    expect(result.pythonExecutable).toBe(layout.pythonPath);
  });

  it("names a missing payload instead of pretending the model failed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wmcp-empty-"));
    const result = probeWindowsMcpLayout(resolveWindowsMcpLayout(path.join(root, "resources")));
    expect(result.ok).toBe(false);
    expect(result.health).toBe("NOT_PACKAGED");
    expect(result.detail).toContain("Windows-MCP");
  });

  it("distinguishes a missing private runtime from a missing package", () => {
    const { layout } = makeLayout({ withRuntime: false });
    expect(probeWindowsMcpLayout(layout).health).toBe("RUNTIME_MISSING");
  });

  it("distinguishes a missing manifest from a missing entry point", () => {
    const { layout } = makeLayout({ withManifest: false });
    expect(probeWindowsMcpLayout(layout).health).toBe("NOT_PACKAGED");
    expect(probeWindowsMcpLayout(layout).detail).toContain("清单");
  });

  it("refuses a payload whose hash does not match the manifest", () => {
    const { layout } = makeLayout({ tamper: true });
    const result = probeWindowsMcpLayout(layout);
    expect(result.ok).toBe(false);
    expect(result.health).toBe("HASH_MISMATCH");
  });

  it("refuses a manifest that pins a different upstream commit", () => {
    const { layout } = makeLayout();
    writeFileSync(
      layout.manifestPath,
      JSON.stringify({
        upstreamCommit: "0000000000000000000000000000000000000000",
        upstreamVersion: "0.0.1",
        license: "MIT",
        files: [],
      }),
      "utf-8",
    );
    const result = probeWindowsMcpLayout(layout);
    expect(result.health).toBe("HASH_MISMATCH");
    expect(result.detail).toContain("锁定");
  });

  it("refuses a manifest that escapes its own directory", () => {
    const { layout } = makeLayout();
    writeFileSync(
      layout.manifestPath,
      JSON.stringify({
        upstreamCommit: WINDOWS_MCP_LOCK.commit,
        upstreamVersion: WINDOWS_MCP_LOCK.version,
        license: "MIT",
        files: [{ path: "../../windows/system32/cmd.exe", sha256: "0".repeat(64) }],
      }),
      "utf-8",
    );
    expect(probeWindowsMcpLayout(layout).health).toBe("HASH_MISMATCH");
  });
});

describe("manifest parsing", () => {
  it("rejects a manifest without the pinned commit", () => {
    expect(parseManifest(JSON.stringify({ files: [] }))).toBeNull();
  });

  it("rejects a file entry without a hash", () => {
    expect(parseManifest(JSON.stringify({ upstreamCommit: "x", files: [{ path: "a" }] }))).toBeNull();
  });
});

describe("launch shape", () => {
  it("starts the server over stdio only", () => {
    const args = buildServerArgs({ serverDir: "C:/pkg/server" });
    expect(args).toContain("stdio");
    expect(args.join(" ")).not.toContain("--host");
    expect(args.join(" ")).not.toContain("--port");
  });

  it("turns telemetry off and the watchdog off", () => {
    const env = buildServerEnvironment({ wrappableTools: ["Click"], stateDir: "C:/state" });
    expect(env.ANONYMIZED_TELEMETRY).toBe("false");
    expect(env.WINDOWS_MCP_WATCHDOG).toBe("off");
  });

  it("pins the tool list to the wrapped set", () => {
    const env = buildServerEnvironment({
      wrappableTools: ["App", "Click"],
      stateDir: "C:/state",
    });
    expect(env.WINDOWS_MCP_TOOLS).toBe("App,Click");
  });

  it("keeps the private runtime from reading the user site-packages", () => {
    const env = buildServerEnvironment({ wrappableTools: [], stateDir: "C:/state" });
    expect(env.PYTHONNOUSERSITE).toBe("1");
  });
});
