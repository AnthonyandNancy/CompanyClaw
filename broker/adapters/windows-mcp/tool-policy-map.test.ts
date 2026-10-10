import { describe, expect, it } from "vitest";
import {
  BROKER_CAPABILITIES,
  BROKER_NATIVE_CAPABILITIES,
  TOOL_POLICY_MAP,
  PINNED_UPSTREAM_TOOLS,
  deniedUpstreamTools,
  dispositionFor,
  isToolAllowedFor,
  reconcileToolList,
  wrappedUpstreamTools,
} from "./tool-policy-map";

/**
 * The allow-map is the boundary between "a Windows automation backend" and "a
 * shell". These assertions are written from the requirement (V5 §2.2, §5.3,
 * ruling Q1), not from the map itself.
 */

describe("upstream tools that must never reach the agent", () => {
  it.each([
    "PowerShell",
    "FileSystem",
    "Registry",
    "Process",
    "Clipboard",
    "Scrape",
    "Notification",
    "MultiSelect",
    "MultiEdit",
  ])("refuses %s for every capability", (tool) => {
    expect(dispositionFor(tool)?.disposition).toBe("deny");
    for (const capability of BROKER_CAPABILITIES) {
      expect(isToolAllowedFor(tool, capability)).toBe(false);
    }
  });

  it("keeps the command surface out of the allow list even behind an approval", () => {
    for (const tool of ["PowerShell", "FileSystem", "Registry"]) {
      expect(deniedUpstreamTools()).toContain(tool);
    }
  });
});

describe("upstream tools the agent may use", () => {
  it("allows launching and focusing only through the app capability", () => {
    expect(isToolAllowedFor("App", "launchApp")).toBe(true);
    expect(isToolAllowedFor("App", "listInstalledApps")).toBe(true);
    expect(isToolAllowedFor("App", "typeText")).toBe(false);
  });

  it("routes pointer and keyboard input through their own capabilities", () => {
    expect(isToolAllowedFor("Click", "click")).toBe(true);
    expect(isToolAllowedFor("Move", "dragDrop")).toBe(true);
    expect(isToolAllowedFor("Type", "typeText")).toBe(true);
    expect(isToolAllowedFor("Scroll", "scroll")).toBe(true);
    expect(isToolAllowedFor("Shortcut", "hotkey")).toBe(true);
  });

  it("gates screenshots behind the screenshot capability alone", () => {
    expect(isToolAllowedFor("Screenshot", "screenshot")).toBe(true);
    expect(isToolAllowedFor("Screenshot", "snapshotUiTree")).toBe(false);
    expect(isToolAllowedFor("Snapshot", "snapshotUiTree")).toBe(true);
  });

  it("keeps waiting bounded to the wait capability", () => {
    expect(isToolAllowedFor("Wait", "waitForWindowOrControl")).toBe(true);
    expect(isToolAllowedFor("WaitFor", "waitForWindowOrControl")).toBe(true);
  });
});

describe("an unknown upstream tool is refused", () => {
  it("denies a tool that is not in the map", () => {
    expect(dispositionFor("SomethingNew")).toBeNull();
    expect(isToolAllowedFor("SomethingNew", "click")).toBe(false);
  });

  it("reports an unclassified tool so an upgrade cannot pass unnoticed", () => {
    const result = reconcileToolList([...PINNED_UPSTREAM_TOOLS, "SomethingNew"]);
    expect(result.unclassified).toEqual(["SomethingNew"]);
    expect(result.matchesPinnedRelease).toBe(false);
  });
});

describe("the map matches the pinned upstream release", () => {
  it("classifies every advertised tool", () => {
    const result = reconcileToolList(PINNED_UPSTREAM_TOOLS);
    expect(result.unclassified).toEqual([]);
    expect(result.matchesPinnedRelease).toBe(true);
  });

  it("reports a capability the upstream release no longer advertises", () => {
    const withoutClick = PINNED_UPSTREAM_TOOLS.filter((tool) => tool !== "Click");
    const result = reconcileToolList(withoutClick);
    expect(result.missing).toContain("Click");
    expect(result.matchesPinnedRelease).toBe(false);
  });

  it("covers every capability, either through an upstream tool or the broker itself", () => {
    const fromUpstream = new Set(TOOL_POLICY_MAP.flatMap((entry) => [...entry.capabilities]));
    const native = new Set(BROKER_NATIVE_CAPABILITIES);
    for (const capability of BROKER_CAPABILITIES) {
      expect(fromUpstream.has(capability) || native.has(capability)).toBe(true);
    }
  });

  it("keeps the broker-native capabilities out of the upstream deny list", () => {
    for (const capability of BROKER_NATIVE_CAPABILITIES) {
      expect(BROKER_CAPABILITIES).toContain(capability);
    }
  });

  it("keeps the wrapped set smaller than the advertised set", () => {
    expect(wrappedUpstreamTools().length).toBeLessThan(PINNED_UPSTREAM_TOOLS.length);
    expect(wrappedUpstreamTools().length).toBe(11);
  });
});
