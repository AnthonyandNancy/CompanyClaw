import { describe, expect, it } from "vitest";
import {
  COMPANYCLAW_IDENTITY_CONTRACT,
  IdentityBindingStore,
  type IdentityBinding,
} from "./identity-binding";

const FILE = "C:\\state\\companyclaw\\identity.json";
const NOW = () => new Date("2026-10-09T00:00:00.000Z");

function binding(overrides: Partial<IdentityBinding> = {}): IdentityBinding {
  return {
    ownerSid: "S-1-5-21-1",
    deviceId: "device-a",
    channelType: "openclaw-weixin",
    channelUserId: "wx-1",
    boundAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

function store(initial?: unknown) {
  let contents = initial === undefined ? null : JSON.stringify(initial);
  const writes: string[] = [];
  const instance = new IdentityBindingStore(FILE, {
    now: NOW,
    existsFile: (target) => target === FILE && contents !== null,
    readFile: () => contents ?? "",
    writeFile: async (_target, next) => {
      writes.push(next);
      contents = next;
    },
  });
  return { instance, writes };
}

describe("IdentityBindingStore", () => {
  it("starts with no binding (a fresh install is not bound to anyone)", () => {
    const { instance } = store();
    expect(instance.get()).toBeNull();
  });

  it("records the channel user, device and Windows SID together", async () => {
    const { instance } = store();
    const saved = await instance.bind(binding());
    expect(saved).toMatchObject({
      ownerSid: "S-1-5-21-1",
      deviceId: "device-a",
      channelUserId: "wx-1",
    });
    expect(instance.get()?.channelUserId).toBe("wx-1");
  });

  it("replaces a previous binding atomically instead of accumulating them", async () => {
    const { instance, writes } = store();
    await instance.bind(binding());
    await instance.bind(binding({ channelUserId: "wx-2" }));
    expect(instance.get()?.channelUserId).toBe("wx-2");
    // A second binding must not leave the old record readable.
    expect(JSON.parse(writes[writes.length - 1]).binding.channelUserId).toBe("wx-2");
  });

  it("clears the binding on unbind", async () => {
    const { instance } = store();
    await instance.bind(binding());
    await instance.unbind();
    expect(instance.get()).toBeNull();
  });

  it("authorizes only the exact channel user that is bound", async () => {
    const { instance } = store();
    await instance.bind(binding());
    expect(instance.isAuthorized("openclaw-weixin", "wx-1")).toBe(true);
    // A different WeChat user must not inherit the binding.
    expect(instance.isAuthorized("openclaw-weixin", "wx-2")).toBe(false);
    // Neither must the same user id arriving over a different channel.
    expect(instance.isAuthorized("other-channel", "wx-1")).toBe(false);
  });

  it("authorizes nobody when unbound", () => {
    const { instance } = store();
    expect(instance.isAuthorized("openclaw-weixin", "wx-1")).toBe(false);
  });

  it("reports the SID and device a bound user maps to", async () => {
    const { instance } = store();
    await instance.bind(binding());
    expect(instance.resolveOwner("openclaw-weixin", "wx-1")).toEqual({
      ownerSid: "S-1-5-21-1",
      deviceId: "device-a",
    });
    expect(instance.resolveOwner("openclaw-weixin", "wx-9")).toBeNull();
  });

  it("refuses to bind without a channel user or owner SID", async () => {
    const { instance } = store();
    await expect(instance.bind(binding({ channelUserId: "" }))).rejects.toThrow(/channelUserId/);
    await expect(instance.bind(binding({ ownerSid: "" }))).rejects.toThrow(/ownerSid/);
    await expect(instance.bind(binding({ channelType: "" }))).rejects.toThrow(/channelType/);
  });

  it("authorizes nothing when the stored file is malformed", () => {
    const { instance } = store({ contract: "other", binding: binding() });
    expect(instance.get()).toBeNull();
    expect(instance.isAuthorized("openclaw-weixin", "wx-1")).toBe(false);
    expect(instance.inspect().warning).toBeTruthy();
  });

  it("treats unreadable storage as unbound rather than as authorized", () => {
    const instance = new IdentityBindingStore(FILE, {
      now: NOW,
      existsFile: () => true,
      readFile: () => {
        throw new Error("disk error");
      },
      writeFile: async () => undefined,
    });
    expect(instance.get()).toBeNull();
    expect(instance.isAuthorized("openclaw-weixin", "wx-1")).toBe(false);
    expect(instance.inspect().warning).toBeTruthy();
  });

  it("writes a versioned envelope with the contract name", async () => {
    const { instance, writes } = store();
    await instance.bind(binding());
    const envelope = JSON.parse(writes[0]) as { contract: string; binding: unknown };
    expect(envelope.contract).toBe(COMPANYCLAW_IDENTITY_CONTRACT);
    expect(envelope.binding).toBeTruthy();
  });
});
