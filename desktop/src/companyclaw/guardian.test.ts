import { describe, expect, it } from "vitest";
import { buildGuardianReport, guardianIsReady, type GuardianProbes } from "./guardian";

/**
 * A single "all good" flag cannot tell a user which part of the installation is
 * broken. These cases pin the distinction between "measured and broken" and
 * "not measured yet", because only the first one is a fault.
 */
const healthy: GuardianProbes = {
  gatewayStatus: "running",
  gatewayConnected: true,
  manifestChecked: 42,
  manifestProblems: [],
  pluginInstalled: true,
  pluginEnabled: true,
  pluginLoggedIn: false,
  brokerNodePath: "C:/app/resources/node.exe",
  brokerRunning: true,
  brokerFailureReason: null,
  browserExecutable: "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  modelCapability: null,
};

function item(report: ReturnType<typeof buildGuardianReport>, id: string) {
  const found = report.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing guardian item ${id}`);
  return found;
}

describe("guardian report", () => {
  it("reports every component separately", () => {
    const report = buildGuardianReport(healthy);
    expect(report.items.map((entry) => entry.id)).toEqual([
      "gateway-process",
      "gateway-auth",
      "runtime-manifest",
      "plugin-installed",
      "broker-runtime",
      "browser-binary",
      "model-reply",
    ]);
  });

  it("is ready when the installed components are healthy", () => {
    const report = buildGuardianReport(healthy);
    expect(guardianIsReady(report)).toBe(true);
    // An unbound WeChat account and an unmeasured model are not faults.
    expect(item(report, "plugin-installed").state).toBe("ok");
    expect(item(report, "model-reply").state).toBe("unknown");
  });

  it("does not treat an unmeasured model as a failure", () => {
    // The probe needs an API key; nobody has one at first launch.
    expect(item(buildGuardianReport({}), "model-reply").state).toBe("unknown");
  });

  it("fails the manifest item only when a real problem was found", () => {
    const good = buildGuardianReport(healthy);
    expect(item(good, "runtime-manifest").state).toBe("ok");
    expect(item(good, "runtime-manifest").detail).toContain("42");

    const bad = buildGuardianReport({
      ...healthy,
      manifestProblems: ["missing: node.exe"],
      manifestChecked: 0,
    });
    expect(item(bad, "runtime-manifest").state).toBe("failed");
    expect(item(bad, "runtime-manifest").detail).toContain("missing: node.exe");
    expect(guardianIsReady(bad)).toBe(false);
  });

  it("distinguishes a missing plugin from an installed but disabled one", () => {
    const missing = buildGuardianReport({ ...healthy, pluginInstalled: false });
    expect(item(missing, "plugin-installed").state).toBe("failed");

    const disabled = buildGuardianReport({ ...healthy, pluginEnabled: false });
    expect(item(disabled, "plugin-installed").state).toBe("degraded");
    expect(item(disabled, "plugin-installed").detail).toContain("未启用");
  });

  it("names the broker's failure reason instead of hiding it", () => {
    const report = buildGuardianReport({
      ...healthy,
      brokerRunning: false,
      brokerFailureReason: "BROKER_RUNTIME_NOT_FOUND: C:/app/resources/node.exe",
    });
    expect(item(report, "broker-runtime").state).toBe("degraded");
    expect(item(report, "broker-runtime").detail).toContain("BROKER_RUNTIME_NOT_FOUND");
  });

  it("reports a tool-incapable model as failed but a chat-only one as usable", () => {
    expect(
      item(buildGuardianReport({ ...healthy, modelCapability: "tool-capable" }), "model-reply")
        .state,
    ).toBe("ok");
    const chatOnly = buildGuardianReport({ ...healthy, modelCapability: "chat-capable" });
    expect(item(chatOnly, "model-reply").state).toBe("ok");
    expect(item(chatOnly, "model-reply").detail).toContain("工具调用未确认");

    const unusable = buildGuardianReport({
      ...healthy,
      modelCapability: "unsupported-or-unverified",
    });
    expect(item(unusable, "model-reply").state).toBe("failed");
  });

  it("summarises the worst state so the wizard can show one headline", () => {
    expect(buildGuardianReport(healthy).overall).toBe("ok");
    expect(buildGuardianReport({ ...healthy, pluginInstalled: false }).overall).toBe("failed");
    expect(buildGuardianReport({ ...healthy, brokerRunning: false }).overall).toBe("degraded");
    // An unknown item alone must not make the report look broken.
    expect(buildGuardianReport({ ...healthy, modelCapability: null }).overall).toBe("ok");
  });

  it("keeps an unmeasured probe unknown rather than guessing", () => {
    const empty = buildGuardianReport({});
    expect(item(empty, "gateway-auth").state).toBe("unknown");
    expect(item(empty, "browser-binary").state).toBe("unknown");
    expect(item(empty, "plugin-installed").state).toBe("unknown");
  });
});
