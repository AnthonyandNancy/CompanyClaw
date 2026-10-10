import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DENIED_UPSTREAM_TOOLS,
  WINDOWS_MCP_ENTRY,
  WINDOWS_MCP_LOCK,
  WRAPPABLE_UPSTREAM_TOOLS,
  loadedToolSummary,
  parseManifest,
  probeWindowsMcpLayout,
  resolveWindowsMcpLayout,
} from "./windows-mcp-layout";

/**
 * The desktop's view of the Windows-MCP payload, and its agreement with the
 * broker's.
 *
 * Requirement V5 §6.1/§6.4: the payload ships inside the installer, and a
 * missing or altered component is named precisely. The allow-map lists are
 * mirrored from the broker and pinned here so the health page cannot claim a
 * different tool surface than the adapter enforces.
 */

const repositoryRoot = path.resolve(__dirname, "../../..");
const brokerMapPath = path.join(
  repositoryRoot,
  "broker",
  "adapters",
  "windows-mcp",
  "tool-policy-map.ts",
);
const brokerProcessManagerPath = path.join(
  repositoryRoot,
  "broker",
  "adapters",
  "windows-mcp",
  "process-manager.ts",
);

function makeLayout(options: { withRuntime?: boolean; withManifest?: boolean; tamper?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "claw-wmcp-"));
  const layout = resolveWindowsMcpLayout(path.join(root, "resources"));
  mkdirSync(path.join(layout.serverDir, path.dirname(WINDOWS_MCP_ENTRY)), { recursive: true });
  const entry = path.join(layout.serverDir, WINDOWS_MCP_ENTRY);
  writeFileSync(entry, "print('ok')\n", "utf-8");
  if (options.withRuntime !== false) {
    mkdirSync(path.dirname(layout.pythonPath), { recursive: true });
    writeFileSync(layout.pythonPath, "interpreter", "utf-8");
  }
  if (options.withManifest !== false) {
    const sha256 = (file: string) =>
      createHash("sha256").update(readFileSync(file)).digest("hex");
    writeFileSync(
      layout.manifestPath,
      JSON.stringify({
        contract: "companyclaw.windows-mcp.v1",
        upstreamCommit: WINDOWS_MCP_LOCK.commit,
        upstreamVersion: WINDOWS_MCP_LOCK.version,
        license: WINDOWS_MCP_LOCK.license,
        files: [
          {
            path: WINDOWS_MCP_ENTRY.replace(/\\/g, "/"),
            sha256: options.tamper ? "0".repeat(64) : sha256(entry),
          },
        ],
      }),
      "utf-8",
    );
  }
  return layout;
}

describe("payload probe", () => {
  it("reports READY with the entry point for a complete payload", () => {
    const layout = makeLayout();
    const result = probeWindowsMcpLayout(layout);
    expect(result.health).toBe("READY");
    expect(result.entryPoint).toBe(path.join(layout.serverDir, WINDOWS_MCP_ENTRY));
  });

  it("distinguishes the three failure kinds a user must act on differently", () => {
    const missing = mkdtempSync(path.join(tmpdir(), "claw-empty-"));
    const none = probeWindowsMcpLayout(resolveWindowsMcpLayout(path.join(missing, "resources")));
    expect(none.health).toBe("NOT_PACKAGED");
    expect(none.detail).toContain("未随包提供");

    const noRuntime = probeWindowsMcpLayout(makeLayout({ withRuntime: false }));
    expect(noRuntime.health).toBe("RUNTIME_MISSING");
    expect(noRuntime.detail).toContain("运行组件");

    const tampered = probeWindowsMcpLayout(makeLayout({ tamper: true }));
    expect(tampered.health).toBe("HASH_MISMATCH");
    expect(tampered.detail).toContain("校验失败");
  });

  it("refuses a manifest pinning a different upstream commit", () => {
    const layout = makeLayout();
    writeFileSync(
      layout.manifestPath,
      JSON.stringify({
        upstreamCommit: "0".repeat(40),
        upstreamVersion: "0.0.0",
        license: "MIT",
        files: [],
      }),
      "utf-8",
    );
    expect(probeWindowsMcpLayout(layout).health).toBe("HASH_MISMATCH");
  });

  it("rejects a manifest entry that escapes the payload directory", () => {
    const layout = makeLayout();
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

  it("rejects a manifest without the pinned commit or with a malformed entry", () => {
    expect(parseManifest(JSON.stringify({ files: [] }))).toBeNull();
    expect(
      parseManifest(JSON.stringify({ upstreamCommit: "x", files: [{ path: "a" }] })),
    ).toBeNull();
  });
});

describe("agreement with the broker", () => {
  it("names the same health states as the broker's process manager", () => {
    const source = readFileSync(brokerProcessManagerPath, "utf-8");
    for (const state of [
      "NOT_PACKAGED",
      "HASH_MISMATCH",
      "RUNTIME_MISSING",
      "START_FAILED",
      "HANDSHAKE_FAILED",
      "TOOLS_MISSING",
      "SESSION_LOCKED",
      "READY",
    ]) {
      expect(source).toContain(`"${state}"`);
    }
  });

  it("agrees with the broker on the pinned commit and version", () => {
    const source = readFileSync(brokerProcessManagerPath, "utf-8");
    expect(source).toContain(WINDOWS_MCP_LOCK.commit);
    expect(source).toContain(`"${WINDOWS_MCP_LOCK.version}"`);
  });

  it("keeps the wrapped and denied lists identical to the broker's map", () => {
    const source = readFileSync(brokerMapPath, "utf-8");
    for (const tool of WRAPPABLE_UPSTREAM_TOOLS) {
      // A wrapped tool appears in the map as a `wrap` entry.
      expect(source).toContain(`tool: "${tool}"`);
    }
    for (const tool of DENIED_UPSTREAM_TOOLS) {
      expect(source).toContain(`tool: "${tool}"`);
    }
  });

  it("counts the same tool surface the map declares", () => {
    const summary = loadedToolSummary();
    expect(summary.controllable).toBe(WRAPPABLE_UPSTREAM_TOOLS.length);
    expect(summary.blocked).toBe(DENIED_UPSTREAM_TOOLS.length);
    expect(summary.total).toBe(20);
  });

  it("never lists a command surface as controllable", () => {
    for (const tool of ["PowerShell", "FileSystem", "Registry", "Process", "Clipboard"]) {
      expect(WRAPPABLE_UPSTREAM_TOOLS).not.toContain(tool);
      expect(DENIED_UPSTREAM_TOOLS).toContain(tool);
    }
  });
});
