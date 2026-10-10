import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISION_SCOPE,
  evaluateVisionRequest,
  selectVisionRecord,
  visionGrantLifetimeMs,
} from "./vision-gate";
import type { VisionAuthorizationRecord } from "../permissions/permission-policy";

/**
 * Ruling Q2 / Q-C: capturing the screen locally is normal automation, sending
 * the image to a third-party model is a separate consent that names the
 * provider, and the daily preset never grants it.
 */

const NOW = new Date("2026-10-10T12:00:00Z");
const REMOTE_EXPIRES = "2026-10-17T12:00:00Z";

function record(overrides: Partial<VisionAuthorizationRecord> = {}): VisionAuthorizationRecord {
  return {
    enabled: true,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-vl",
    captureScope: DEFAULT_VISION_SCOPE,
    grantedAt: "2026-10-10T00:00:00Z",
    expiresAt: "2026-10-17T00:00:00Z",
    revokedAt: null,
    ...overrides,
  };
}

function context(overrides: Partial<Parameters<typeof evaluateVisionRequest>[1]> = {}) {
  return {
    ownerSid: "S-1",
    deviceId: "device-a",
    origin: "local-ui" as const,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-vl",
    requestedScope: DEFAULT_VISION_SCOPE,
    modelSupportsVision: true,
    remoteAuthorizationExpiresAt: REMOTE_EXPIRES,
    enterprisePolicyTightened: false,
    ...overrides,
  };
}

describe("vision gate defaults", () => {
  it("refuses to upload while nothing was authorized", () => {
    const decision = evaluateVisionRequest(
      record({ enabled: false, provider: "", baseUrl: "", model: "" }),
      context(),
      NOW,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("vision-not-authorized");
  });

  it("refuses after the employee revokes it, even inside the original window", () => {
    const decision = evaluateVisionRequest(
      record({ revokedAt: "2026-10-10T11:00:00Z" }),
      context(),
      NOW,
    );
    expect(decision.allowed === false && decision.code).toBe("vision-revoked");
  });

  it("refuses once it expires", () => {
    const decision = evaluateVisionRequest(
      record({ expiresAt: "2026-10-10T11:00:00Z" }),
      context(),
      NOW,
    );
    expect(decision.allowed === false && decision.code).toBe("vision-expired");
  });

  it("falls back honestly when the chosen model has no vision", () => {
    const decision = evaluateVisionRequest(record(), context({ modelSupportsVision: false }), NOW);
    expect(decision.allowed === false && decision.code).toBe("model-without-vision");
  });
});

describe("vision gate is bound to the provider it was granted for", () => {
  it("allows the same provider, endpoint and model", () => {
    expect(evaluateVisionRequest(record(), context(), NOW).allowed).toBe(true);
  });

  it.each([
    ["provider", { provider: "other" }],
    ["baseUrl", { baseUrl: "https://api.other.example" }],
    ["model", { model: "another-model" }],
  ])("voids the grant when the %s changes", (_label, change) => {
    const decision = evaluateVisionRequest(record(), context(change), NOW);
    expect(decision.allowed === false && decision.code).toBe("provider-changed");
  });

  it("refuses a capture scope wider than the one granted", () => {
    const decision = evaluateVisionRequest(record(), context({ requestedScope: "desktop" }), NOW);
    expect(decision.allowed === false && decision.code).toBe("capture-scope-not-authorized");
  });

  it("refuses when enterprise policy was tightened after the grant", () => {
    const decision = evaluateVisionRequest(
      record(),
      context({ enterprisePolicyTightened: true }),
      NOW,
    );
    expect(decision.allowed === false && decision.code).toBe("enterprise-policy-tightened");
  });
});

describe("vision gate keeps the two channels apart", () => {
  it("selects the record that belongs to the origin", () => {
    const policy = {
      vision: { local: record({ model: "local-model" }), remote: record({ model: "remote-model" }) },
    };
    expect(selectVisionRecord(policy, "local-ui").model).toBe("local-model");
    expect(selectVisionRecord(policy, "weixin-private").model).toBe("remote-model");
    expect(selectVisionRecord(policy, "subagent").model).toBe("remote-model");
  });

  it("stops a remote upload when the remote operation authorization is gone", () => {
    const decision = evaluateVisionRequest(
      record(),
      context({ origin: "weixin-private", remoteAuthorizationExpiresAt: null }),
      NOW,
    );
    expect(decision.allowed === false && decision.code).toBe("remote-authorization-missing");
  });

  it("keeps a local upload working while remote operation is switched off", () => {
    const decision = evaluateVisionRequest(
      record(),
      context({ origin: "local-ui", remoteAuthorizationExpiresAt: null }),
      NOW,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("vision grant lifetime", () => {
  it("defaults to seven days for a local grant", () => {
    const lifetime = visionGrantLifetimeMs({
      requestedMs: 0,
      origin: "local-ui",
      remoteAuthorizationExpiresAt: REMOTE_EXPIRES,
      now: NOW,
    });
    expect(lifetime).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("never lets a remote grant outlive the remote operation authorization", () => {
    const lifetime = visionGrantLifetimeMs({
      requestedMs: 7 * 24 * 60 * 60 * 1_000,
      origin: "weixin-private",
      // Only two days of remote authorization remain.
      remoteAuthorizationExpiresAt: "2026-10-12T12:00:00Z",
      now: NOW,
    });
    expect(lifetime).toBe(2 * 24 * 60 * 60 * 1_000);
  });

  it("allows a shorter request but not a longer one than seven days", () => {
    const shorter = visionGrantLifetimeMs({
      requestedMs: 60_000,
      origin: "local-ui",
      remoteAuthorizationExpiresAt: null,
      now: NOW,
    });
    expect(shorter).toBe(60_000);
    const capped = visionGrantLifetimeMs({
      requestedMs: 30 * 24 * 60 * 60 * 1_000,
      origin: "local-ui",
      remoteAuthorizationExpiresAt: null,
      now: NOW,
    });
    expect(capped).toBe(7 * 24 * 60 * 60 * 1_000);
  });
});
