import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_REPLY_TIMEOUT_MS,
  forwardApprovalReply,
  installDesktopBridgeListener,
  pendingApprovalReplyCount,
  publishSessionSource,
  settleApprovalReply,
  type DesktopChannel,
} from "./desktop-bridge";

/**
 * The plugin forwards approval replies to the desktop but never decides them.
 * Every path that is not an explicit "the desktop handled this" must release
 * the message back to the AI pipeline, and nothing may throw when the desktop
 * is absent — development runs have no parent process.
 */
function channelWith(handlers: {
  send?: (message: unknown) => unknown;
  on?: (event: string, listener: (message: unknown) => void) => unknown;
}): DesktopChannel {
  return { send: handlers.send, on: handlers.on };
}

describe("publishSessionSource", () => {
  it("sends the trusted identity metadata to the desktop", () => {
    const sent: unknown[] = [];
    publishSessionSource(channelWith({ send: (message) => sent.push(message) }), {
      channelType: "weixin",
      userId: "wx-user-1",
      accountId: "acct-1",
      baseUrl: "https://example.invalid",
      contextToken: "ctx",
    });
    expect(sent).toEqual([
      {
        type: "session-source",
        source: {
          channelType: "weixin",
          userId: "wx-user-1",
          accountId: "acct-1",
          baseUrl: "https://example.invalid",
          contextToken: "ctx",
        },
      },
    ]);
  });

  it("carries the channel message id so the desktop can de-duplicate", () => {
    const sent: unknown[] = [];
    publishSessionSource(channelWith({ send: (message) => sent.push(message) }), {
      channelType: "weixin",
      userId: "wx-user-1",
      accountId: "acct-1",
      baseUrl: "https://example.invalid",
      messageId: "msg-77",
    });
    // A redelivered message must be recognisable as the same message.
    expect(sent).toEqual([
      {
        type: "session-source",
        source: {
          channelType: "weixin",
          userId: "wx-user-1",
          accountId: "acct-1",
          baseUrl: "https://example.invalid",
          messageId: "msg-77",
        },
      },
    ]);
  });

  it("does nothing when there is no desktop parent", () => {
    expect(() =>
      publishSessionSource(null, {
        channelType: "weixin",
        userId: "wx-user-1",
        accountId: "acct-1",
        baseUrl: "https://example.invalid",
      }),
    ).not.toThrow();
  });

  it("swallows a failing send so message handling continues", () => {
    const channel = channelWith({
      send: () => {
        throw new Error("channel closed");
      },
    });
    expect(() =>
      publishSessionSource(channel, {
        channelType: "weixin",
        userId: "wx-user-1",
        accountId: "acct-1",
        baseUrl: "https://example.invalid",
      }),
    ).not.toThrow();
  });
});

describe("forwardApprovalReply", () => {
  /** Records the requestId of the outgoing message so responses can be routed. */
  function recordingChannel() {
    let requestId = "";
    const channel = channelWith({
      send: (message) => {
        requestId = (message as { requestId: string }).requestId;
      },
    });
    return { channel, requestId: () => requestId };
  }

  it("resolves true when the desktop reports it handled the reply", async () => {
    const { channel, requestId } = recordingChannel();
    const answer = forwardApprovalReply(channel, "批准", "wx-user-1");
    expect(settleApprovalReply(requestId(), true)).toBe(true);
    await expect(answer).resolves.toBe(true);
  });

  it("resolves false when the desktop does not recognise the text", async () => {
    const { channel, requestId } = recordingChannel();
    const answer = forwardApprovalReply(channel, "今天天气怎么样", "wx-user-1");
    settleApprovalReply(requestId(), false);
    // Normal chat must reach the AI exactly as before.
    await expect(answer).resolves.toBe(false);
  });

  it("resolves false immediately when there is no desktop parent", async () => {
    await expect(forwardApprovalReply(null, "批准", "wx-user-1")).resolves.toBe(false);
    await expect(forwardApprovalReply(channelWith({}), "批准", "wx-user-1")).resolves.toBe(false);
  });

  it("resolves false when the send itself throws", async () => {
    const channel = channelWith({
      send: () => {
        throw new Error("channel closed");
      },
    });
    await expect(forwardApprovalReply(channel, "批准", "wx-user-1")).resolves.toBe(false);
    expect(pendingApprovalReplyCount()).toBe(0);
  });

  it("resolves false after the timeout and leaks no pending entry", async () => {
    vi.useFakeTimers();
    try {
      const channel = channelWith({ send: () => undefined });
      const answer = forwardApprovalReply(channel, "批准", "wx-user-1", 50);
      expect(pendingApprovalReplyCount()).toBe(1);
      vi.advanceTimersByTime(60);
      await expect(answer).resolves.toBe(false);
      expect(pendingApprovalReplyCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timeout long enough not to cut off a slow desktop", () => {
    expect(APPROVAL_REPLY_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("installDesktopBridgeListener", () => {
  function listeningChannel() {
    let listener: ((message: unknown) => void) | null = null;
    let requestId = "";
    const channel = channelWith({
      send: (message) => {
        requestId = (message as { requestId: string }).requestId;
      },
      on: (_event, handler) => {
        listener = handler;
      },
    });
    return {
      channel,
      requestId: () => requestId,
      deliver: (message: unknown) => listener?.(message),
      hasListener: () => listener !== null,
    };
  }

  it("resolves the waiting request from a desktop response", async () => {
    const { channel, requestId, deliver, hasListener } = listeningChannel();
    installDesktopBridgeListener(channel);
    expect(hasListener()).toBe(true);

    const answer = forwardApprovalReply(channel, "批准", "wx-user-1");
    // An unrelated envelope must not settle anything.
    deliver({ type: "something-else", requestId: requestId(), handled: true });
    expect(pendingApprovalReplyCount()).toBe(1);

    deliver({ type: "approval-reply-response", requestId: requestId(), handled: true });
    await expect(answer).resolves.toBe(true);
    expect(pendingApprovalReplyCount()).toBe(0);
  });

  it("leaves the request pending for a response with an unknown id", async () => {
    const { channel } = listeningChannel();
    installDesktopBridgeListener(channel);
    // Nothing is waiting, so an unknown id is simply ignored.
    expect(settleApprovalReply("does-not-exist", true)).toBe(false);
  });

  it("does nothing when the host exposes no channel", () => {
    expect(() => installDesktopBridgeListener(null)).not.toThrow();
  });
});

describe("file send bridge", () => {
  it("dispatches a file-send request to the injected handler", () => {
    const listeners: Array<(message: unknown) => void> = [];
    const channel = channelWith({ on: (_event, listener) => listeners.push(listener) });
    const sendFile = vi.fn();
    installDesktopBridgeListener(channel, { sendFile });
    listeners[0]({ type: "file-send-request", requestId: "r1", request: { filePath: "a", to: "b" } });
    // The plugin performs the send; the bridge itself decides nothing.
    expect(sendFile).toHaveBeenCalledWith(
      expect.objectContaining({ type: "file-send-request", requestId: "r1" }),
      channel,
    );
  });

  it("leaves a request unanswered when no handler is installed", () => {
    const listeners: Array<(message: unknown) => void> = [];
    const channel = channelWith({ on: (_event, listener) => listeners.push(listener) });
    installDesktopBridgeListener(channel);
    // Silence is safe: the desktop falls back to its own timeout and reports an
    // indeterminate outcome rather than a fabricated success.
    expect(() => listeners[0]({ type: "file-send-request", requestId: "r1" })).not.toThrow();
  });
});
