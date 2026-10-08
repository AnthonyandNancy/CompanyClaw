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
});

describe("toPolicyConfig", () => {
  it("always requires approval for mutations", () => {
    const config = toPolicyConfig({
      token: "0123456789abcdef0123456789abcdef",
      ownerSid: "S-1",
      deviceId: "d",
      allowedProcesses: ["notepad"],
      allowedWindowTitles: [],
      scriptDir: "C:/broker/scripts",
    });
    expect(config.requireApprovalForMutations).toBe(true);
    expect(config.allowedProcesses).toEqual(["notepad"]);
  });
});
