import { describe, expect, it } from "vitest";
import {
  buildTrustedRemoteContext,
  RemoteMessageDeduplicator,
  TRUSTED_CONTEXT_CONTRACT,
} from "./trusted-context";

/**
 * The requirements refuse a global "last message was remote" flag as a security
 * basis. These cases pin what replaces it: identity resolved from the local
 * binding, an attestation minted at the trusted boundary, and no context at all
 * when the sender is not the paired identity.
 */
const owner = { ownerSid: "S-1-5-21-1", deviceId: "device-a" };

function build(overrides: Partial<Parameters<typeof buildTrustedRemoteContext>[0]> = {}) {
  return buildTrustedRemoteContext({
    channelAccountId: "account-1",
    senderId: "wx-user-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    receivedAt: 1_700_000_000_000,
    owner,
    mintAttestation: () => "attested",
    ...overrides,
  });
}

describe("trusted remote context", () => {
  it("carries the locally resolved identity", () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context).toEqual({
      contract: TRUSTED_CONTEXT_CONTRACT,
      channel: "weixin",
      channelAccountId: "account-1",
      senderId: "wx-user-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      deviceId: "device-a",
      ownerSid: "S-1-5-21-1",
      receivedAt: 1_700_000_000_000,
      originAttestation: "attested",
    });
  });

  it("produces no context for a sender with no local binding", () => {
    // An unbound account cannot start anything by sending text.
    expect(build({ owner: null })).toEqual({ ok: false, reason: "unbound-sender" });
  });

  it("requires a channel message id, because it is the de-duplication basis", () => {
    expect(build({ messageId: "" })).toEqual({ ok: false, reason: "missing-message-id" });
    expect(build({ messageId: "   " })).toEqual({ ok: false, reason: "missing-message-id" });
  });

  it("requires a sender id", () => {
    expect(build({ senderId: "" })).toEqual({ ok: false, reason: "missing-sender" });
  });

  it("does not take identity from anything the sender controls", () => {
    // There is no input that lets the message choose its own owner: the only
    // source of ownerSid/deviceId is the `owner` argument.
    const result = build({ senderId: '{"ownerSid":"S-1-5-21-999"}' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.ownerSid).toBe("S-1-5-21-1");
    expect(result.context.senderId).toBe('{"ownerSid":"S-1-5-21-999"}');
  });

  it("mints a distinct attestation per message by default", () => {
    const first = buildTrustedRemoteContext({
      channelAccountId: "a",
      senderId: "s",
      conversationId: "c",
      messageId: "m1",
      receivedAt: 1,
      owner,
    });
    const second = buildTrustedRemoteContext({
      channelAccountId: "a",
      senderId: "s",
      conversationId: "c",
      messageId: "m2",
      receivedAt: 2,
      owner,
    });
    if (!first.ok || !second.ok) throw new Error("expected contexts");
    // Locally minted, not derived from the message id.
    expect(first.context.originAttestation).not.toBe(second.context.originAttestation);
    expect(first.context.originAttestation).not.toContain("m1");
  });
});

describe("remote message de-duplication", () => {
  it("accepts a message once and refuses its redelivery", () => {
    const dedup = new RemoteMessageDeduplicator();
    expect(dedup.accept("msg-1")).toBe(true);
    // A reconnect can redeliver; the second copy must not create a second task.
    expect(dedup.accept("msg-1")).toBe(false);
    expect(dedup.accept("msg-2")).toBe(true);
  });

  it("stays bounded instead of growing for the life of the install", () => {
    const dedup = new RemoteMessageDeduplicator(3);
    for (const id of ["a", "b", "c", "d"]) dedup.accept(id);
    expect(dedup.size()).toBe(3);
    // Once evicted, an old id is treated as new; the window is what matters,
    // not remembering every id forever.
    expect(dedup.accept("a")).toBe(true);
  });
});
