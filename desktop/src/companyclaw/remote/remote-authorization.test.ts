import { describe, expect, it } from "vitest";
import { bindSessionSource, RemoteAuthorization } from "./remote-authorization";

describe("RemoteAuthorization", () => {
  it("is disabled by default (fail-safe)", () => {
    const auth = new RemoteAuthorization({ now: () => new Date("2026-10-08T00:00:00Z") });
    expect(auth.state()).toBe("disabled");
  });

  it("becomes enabled after an explicit local grant, then expires", () => {
    let current = new Date("2026-10-08T00:00:00Z");
    const auth = new RemoteAuthorization({ now: () => current });
    auth.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx-1", ttlMs: 60_000 });
    expect(auth.state()).toBe("enabled");

    current = new Date("2026-10-08T00:01:00Z");
    expect(auth.state()).toBe("expired");
  });

  it("stays revoked even before the recorded expiry", () => {
    const auth = new RemoteAuthorization({ now: () => new Date("2026-10-08T00:00:00Z") });
    auth.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx-1", ttlMs: 600_000 });
    auth.revoke();
    expect(auth.state()).toBe("revoked");
  });

  it("records the device and channel user it was granted for", () => {
    const auth = new RemoteAuthorization({ now: () => new Date("2026-10-08T00:00:00Z") });
    auth.setEnabled({
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
      ttlMs: 1_000,
    });
    expect(auth.snapshot()).toMatchObject({
      enabled: true,
      ownerSid: "S-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
    });
  });
});

describe("bindSessionSource", () => {
  it("accepts trusted channel metadata", () => {
    expect(
      bindSessionSource({
        channelType: "openclaw-weixin",
        userId: "wx-1",
        messageId: "m-1",
        deviceId: "d",
      }),
    ).toEqual({
      channelType: "openclaw-weixin",
      userId: "wx-1",
      messageId: "m-1",
      deviceId: "d",
    });
  });

  it("refuses a source that claims an identity without channel metadata", () => {
    expect(bindSessionSource({ channelType: "", userId: "wx-1" })).toBeNull();
    expect(bindSessionSource({ channelType: "local", userId: "" })).toBeNull();
    expect(bindSessionSource(null)).toBeNull();
  });

  it("refuses any attempt to declare the source from user text", () => {
    // A prompt claiming to be WeChat is still not WeChat.
    expect(
      bindSessionSource({
        channelType: "openclaw-weixin",
        userId: "wx-1",
        declaredBy: "user-text",
      }),
    ).toBeNull();
  });
});
