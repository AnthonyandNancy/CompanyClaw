import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { probeWindowsMcpLayout, resolveWindowsMcpLayout } from "./windows-mcp-layout";

/**
 * Real-payload check: the assembled vendored payload must verify.
 *
 * Skipped when the payload has not been assembled (a plain source checkout), so
 * the suite stays green for anyone who has not run the packaging step. When the
 * payload *is* present, a failure here means the installer would ship a broken
 * component — which is precisely the fault the requirement says must never be
 * hidden behind "模型无法操作电脑".
 */
const payloadDir = path.resolve(__dirname, "../../resources/companyclaw-broker/windows-mcp");
const assembled = existsSync(path.join(payloadDir, "MANIFEST.json"));

describe.skipIf(!assembled)("assembled Windows-MCP payload", () => {
  it("passes the same integrity check the app performs at startup", () => {
    const result = probeWindowsMcpLayout(
      resolveWindowsMcpLayout(path.resolve(__dirname, "../../resources")),
    );
    expect(result.detail).not.toContain("HASH_MISMATCH");
    expect(result.ok).toBe(true);
    expect(result.health).toBe("READY");
  });

  it("exposes the entry point the broker will start", () => {
    const result = probeWindowsMcpLayout(
      resolveWindowsMcpLayout(path.resolve(__dirname, "../../resources")),
    );
    expect(result.entryPoint).toContain("windows_mcp");
    expect(result.pythonExecutable).toContain("python-runtime");
  });
});
