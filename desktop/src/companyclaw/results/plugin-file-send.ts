/**
 * Desktop half of the artifact-send protocol.
 *
 * The upload itself lives in the WeChat plugin package (and the desktop cannot
 * import it: separate build, ESM, host SDK). Only the tiny wire format belongs
 * here, so this module stays testable and the plugin keeps its own dependency
 * graph. A timeout is reported as indeterminate: the plugin may have uploaded
 * the file before the answer was lost, and telling the caller "failed" would
 * invite a second copy of a report reaching the owner.
 */

export interface PluginFileSendRequest {
  filePath: string;
  to: string;
  text?: string;
}

export type PluginFileSendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; reason: string; indeterminate?: boolean };

/** Minimal surface this module needs, so tests can supply a stand-in. */
export interface FileSendChannel {
  /** Node's child-process signature is compatible with this. */
  send?: (...args: never[]) => unknown;
  on?: (event: string, listener: (message: unknown) => void) => unknown;
}

/** How long the desktop waits for the plugin before giving up. */
export const PLUGIN_FILE_SEND_TIMEOUT_MS = 120_000;

export function requestPluginFileSend(
  channel: FileSendChannel | null,
  request: PluginFileSendRequest,
  timeoutMs: number = PLUGIN_FILE_SEND_TIMEOUT_MS,
  onResponse?: (listener: (message: unknown) => void) => void,
): Promise<PluginFileSendOutcome> {
  if (!channel?.send) {
    return Promise.resolve({ ok: false, reason: "no-plugin-channel" });
  }
  const requestId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<PluginFileSendOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: PluginFileSendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: "file-send-timeout", indeterminate: true }),
      timeoutMs,
    );
    timer.unref?.();
    const listener = (message: unknown) => {
      const envelope = message as {
        type?: string;
        requestId?: string;
        ok?: boolean;
        messageId?: string;
        reason?: string;
        indeterminate?: boolean;
      };
      if (envelope?.type !== "file-send-response") return;
      if (envelope.requestId !== requestId) return;
      finish(
        envelope.ok === true
          ? { ok: true, messageId: envelope.messageId ?? "" }
          : {
              ok: false,
              reason: envelope.reason ?? "file-send-failed",
              ...(envelope.indeterminate ? { indeterminate: true } : {}),
            },
      );
    };
    if (onResponse) onResponse(listener);
    else channel.on?.("message", listener);
    try {
      // The channel is checked above; the cast keeps Node's overloaded
      // signature out of this module's public shape.
      (channel.send as (message: unknown) => unknown)({
        type: "file-send-request",
        requestId,
        request: { ...request },
      });
    } catch (error) {
      finish({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  });
}
