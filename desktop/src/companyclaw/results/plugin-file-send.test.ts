import { describe, expect, it, vi } from "vitest";
import { requestPluginFileSend, type FileSendChannel } from "./plugin-file-send";

/**
 * The desktop asks the plugin to upload a report it produced. What matters is
 * how an unanswered request is reported: the plugin may already have uploaded
 * the file, so a timeout must not come back as a plain failure.
 */
function channelWith(handlers: {
  send?: (message: unknown) => unknown;
  on?: (event: string, listener: (message: unknown) => void) => unknown;
}): FileSendChannel {
  return { send: handlers.send, on: handlers.on };
}

describe("plugin file send protocol", () => {
  it("reports acceptance with the plugin's message id", async () => {
    const sent: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const channel = channelWith({
      send: (message) => {
        sent.push(message);
        const envelope = message as { requestId: string };
        queueMicrotask(() =>
          listener?.({
            type: "file-send-response",
            requestId: envelope.requestId,
            ok: true,
            messageId: "client-9",
          }),
        );
      },
      on: (_event, handler) => {
        listener = handler;
      },
    });
    const outcome = await requestPluginFileSend(channel, {
      filePath: "C:/jobs/t1/artifacts/报表.xlsx",
      to: "wx-owner",
    });
    expect(outcome).toEqual({ ok: true, messageId: "client-9" });
    expect(sent[0]).toMatchObject({
      type: "file-send-request",
      request: { filePath: "C:/jobs/t1/artifacts/报表.xlsx", to: "wx-owner" },
    });
  });

  it("reports a timeout as indeterminate rather than failed", async () => {
    const channel = channelWith({ send: () => undefined, on: () => undefined });
    const outcome = await requestPluginFileSend(
      channel,
      { filePath: "C:/jobs/t1/artifacts/a.pdf", to: "wx-owner" },
      20,
    );
    // Telling the caller "failed" would invite a second copy reaching the owner.
    expect(outcome).toMatchObject({ ok: false, reason: "file-send-timeout", indeterminate: true });
  });

  it("propagates a plugin-side refusal", async () => {
    let listener: ((message: unknown) => void) | null = null;
    const channel = channelWith({
      send: (message) => {
        const envelope = message as { requestId: string };
        queueMicrotask(() =>
          listener?.({
            type: "file-send-response",
            requestId: envelope.requestId,
            ok: false,
            reason: "no-sending-account",
          }),
        );
      },
      on: (_event, handler) => {
        listener = handler;
      },
    });
    const outcome = await requestPluginFileSend(channel, { filePath: "a", to: "b" });
    expect(outcome).toEqual({ ok: false, reason: "no-sending-account" });
  });

  it("ignores a response for a different request", async () => {
    const listeners: Array<(message: unknown) => void> = [];
    const channel = channelWith({
      send: () => undefined,
      on: (_event, handler) => {
        listeners.push(handler);
      },
    });
    const pending = requestPluginFileSend(channel, { filePath: "a", to: "b" }, 30);
    listeners[0]({
      type: "file-send-response",
      requestId: "someone-else",
      ok: true,
      messageId: "x",
    });
    // Another request's answer must not settle this one.
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "file-send-timeout" });
  });

  it("degrades without a gateway child process instead of throwing", async () => {
    await expect(requestPluginFileSend(null, { filePath: "a", to: "b" })).resolves.toEqual({
      ok: false,
      reason: "no-plugin-channel",
    });
  });

  it("reports a channel that throws while sending", async () => {
    const channel = channelWith({
      send: () => {
        throw new Error("channel closed");
      },
      on: () => undefined,
    });
    const outcome = await requestPluginFileSend(channel, { filePath: "a", to: "b" });
    expect(outcome).toEqual({ ok: false, reason: "channel closed" });
  });
});
