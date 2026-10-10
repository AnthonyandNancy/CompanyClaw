import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { buildGuardianReport, guardianIsReady, type WindowsMcpHealth } from "./guardian";

/**
 * The Windows-MCP health items.
 *
 * Requirement V5 §6.4: a missing or altered component must be named precisely,
 * never dressed up as "服务启动失败", and "not authorized for cloud vision" must
 * not look like a fault — it is the default.
 */

const brokerProcessManager = path.resolve(
  __dirname,
  "../../../broker/adapters/windows-mcp/process-manager.ts",
);

function item(report: ReturnType<typeof buildGuardianReport>, id: string) {
  const found = report.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing guardian item ${id}`);
  return found;
}

const BASE = {
  gatewayStatus: "running",
  gatewayConnected: true,
  manifestChecked: 10,
  manifestProblems: [],
  pluginInstalled: true,
  pluginEnabled: true,
  brokerNodePath: "C:/app/resources/node.exe",
  brokerRunning: true,
  browserExecutable: "C:/edge/msedge.exe",
};

describe("Windows-MCP health", () => {
  it("is a distinct component rather than part of the broker item", () => {
    const report = buildGuardianReport({ ...BASE, windowsMcpHealth: "READY" });
    expect(item(report, "windows-mcp").state).toBe("ok");
    expect(item(report, "broker-runtime").state).toBe("ok");
  });

  it.each([
    ["NOT_PACKAGED", "blocked", "安装组件"],
    ["RUNTIME_MISSING", "failed", "运行组件"],
    ["HASH_MISMATCH", "failed", "校验失败"],
    ["START_FAILED", "failed", "未就绪"],
    ["HANDSHAKE_FAILED", "failed", "启动失败"],
    ["SESSION_LOCKED", "degraded", "解锁"],
  ] as [WindowsMcpHealth, string, string][])(
    "names %s as %s with an actionable hint",
    (health, state, hint) => {
      const report = buildGuardianReport({
        ...BASE,
        windowsMcpHealth: health,
        windowsMcpDetail: null,
      });
      const entry = item(report, "windows-mcp");
      expect(entry.state).toBe(state);
      expect(entry.detail).toContain(hint);
    },
  );

  it("treats an unmeasured payload as missing rather than as unknown", () => {
    const report = buildGuardianReport({ ...BASE });
    expect(item(report, "windows-mcp").state).toBe("blocked");
    expect(item(report, "windows-mcp").detail).toContain("WINDOWS_MCP_NOT_PACKAGED");
  });

  it("blocks readiness while the payload is missing", () => {
    const report = buildGuardianReport({ ...BASE, windowsMcpHealth: "NOT_PACKAGED" });
    expect(guardianIsReady(report)).toBe(false);
  });

  it("agrees with the broker on the health state names", () => {
    const source = readFileSync(brokerProcessManager, "utf-8");
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
});

describe("controlled tool count", () => {
  it("reports a real count and how many capabilities are withheld", () => {
    const report = buildGuardianReport({
      ...BASE,
      windowsMcpHealth: "READY",
      mcpControllableTools: 11,
      mcpBlockedTools: 9,
    });
    const entry = item(report, "mcp-tools");
    expect(entry.state).toBe("ok");
    expect(entry.detail).toContain("11");
    expect(entry.detail).toContain("9");
  });

  it("reports an incompatible tool set when nothing loaded", () => {
    const report = buildGuardianReport({
      ...BASE,
      windowsMcpHealth: "READY",
      mcpControllableTools: 0,
    });
    expect(item(report, "mcp-tools").state).toBe("failed");
    expect(item(report, "mcp-tools").detail).toContain("MCP_TOOLSET_INCOMPATIBLE");
  });

  it("stays unknown before a handshake has happened", () => {
    const report = buildGuardianReport({ ...BASE, mcpControllableTools: null });
    expect(item(report, "mcp-tools").state).toBe("unknown");
  });
});

describe("cloud vision authorization", () => {
  it("is not a fault when it is not authorized", () => {
    const report = buildGuardianReport({ ...BASE, visionAuthorized: false });
    expect(item(report, "vision-authorization").state).toBe("ok");
    expect(item(report, "vision-authorization").detail).toContain("不会上传");
  });

  it("says so when it is authorized", () => {
    const report = buildGuardianReport({ ...BASE, visionAuthorized: true });
    expect(item(report, "vision-authorization").detail).toContain("已授权");
  });

  it("does not let vision change the installation readiness verdict", () => {
    const notAuthorized = buildGuardianReport({
      ...BASE,
      windowsMcpHealth: "READY",
      mcpControllableTools: 11,
      visionAuthorized: false,
    });
    const authorized = buildGuardianReport({
      ...BASE,
      windowsMcpHealth: "READY",
      mcpControllableTools: 11,
      visionAuthorized: true,
    });
    expect(guardianIsReady(notAuthorized)).toBe(guardianIsReady(authorized));
  });
});
