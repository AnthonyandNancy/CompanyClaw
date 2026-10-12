import { describe, expect, it } from "vitest";
import { parseBootstrap, toPolicyConfig } from "./main";

const BASE_ENV = {
  COMPANYCLAW_BROKER_TOKEN: "0123456789abcdef0123456789abcdef",
  COMPANYCLAW_BROKER_OWNER_SID: "S-1-5-21-1",
  COMPANYCLAW_BROKER_DEVICE_ID: "device-a",
  COMPANYCLAW_BROKER_SCRIPT_DIR: "C:/broker/scripts",
} as NodeJS.ProcessEnv;

describe("parseBootstrap", () => {
  it("accepts a complete environment", () => {
    const parsed = parseBootstrap({ ...BASE_ENV });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      ownerSid: "S-1-5-21-1",
      deviceId: "device-a",
      scriptDir: "C:/broker/scripts",
      allowedProcesses: [],
      allowedWindowTitles: [],
    });
  });

  it("refuses a short token", () => {
    // A guessable token would let any local process drive UI Automation.
    expect(parseBootstrap({ ...BASE_ENV, COMPANYCLAW_BROKER_TOKEN: "short" })).toEqual({
      ok: false,
      reason: "missing-or-weak-token",
    });
  });

  it("refuses missing identity fields", () => {
    expect(parseBootstrap({ ...BASE_ENV, COMPANYCLAW_BROKER_OWNER_SID: "" })).toEqual({
      ok: false,
      reason: "missing-owner-sid",
    });
    expect(parseBootstrap({ ...BASE_ENV, COMPANYCLAW_BROKER_DEVICE_ID: "" })).toEqual({
      ok: false,
      reason: "missing-device-id",
    });
    expect(parseBootstrap({ ...BASE_ENV, COMPANYCLAW_BROKER_SCRIPT_DIR: "" })).toEqual({
      ok: false,
      reason: "missing-script-dir",
    });
  });

  it("parses comma-separated allow lists and ignores blank entries", () => {
    const parsed = parseBootstrap({
      ...BASE_ENV,
      COMPANYCLAW_BROKER_ALLOWED_PROCESSES: " notepad , excel ,, ",
      COMPANYCLAW_BROKER_ALLOWED_WINDOW_TITLES: "工单",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.allowedProcesses).toEqual(["notepad", "excel"]);
    expect(parsed.value.allowedWindowTitles).toEqual(["工单"]);
  });

  it("treats the unrestricted flag as opt-in on an exact true", () => {
    const on = parseBootstrap({ ...BASE_ENV, COMPANYCLAW_BROKER_UNRESTRICTED: "true" });
    expect(on.ok && on.value.unrestricted).toBe(true);

    // A desktop build that does not send the flag must still start a working
    // broker, and anything that is not exactly "true" stays restricted.
    for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
      const parsed = parseBootstrap({ ...BASE_ENV, COMPANYCLAW_BROKER_UNRESTRICTED: value });
      expect(parsed.ok, String(value)).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.unrestricted, String(value)).toBe(false);
    }
  });
});

describe("toPolicyConfig", () => {
  it("always requires approval for mutations", () => {
    const config = toPolicyConfig({
      token: "0123456789abcdef0123456789abcdef",
      ownerSid: "S-1",
      deviceId: "d",
      allowedProcesses: ["notepad"],
      allowedWindowTitles: [],
      unrestricted: false,
      scriptDir: "C:/broker/scripts",
    });
    expect(config.requireApprovalForMutations).toBe(true);
    expect(config.allowedProcesses).toEqual(["notepad"]);
  });

  it("carries the unrestricted flag into the policy", () => {
    const config = toPolicyConfig({
      token: "0123456789abcdef0123456789abcdef",
      ownerSid: "S-1",
      deviceId: "d",
      allowedProcesses: [],
      allowedWindowTitles: [],
      unrestricted: true,
      scriptDir: "C:/broker/scripts",
    });
    expect(config.unrestricted).toBe(true);
  });
});
