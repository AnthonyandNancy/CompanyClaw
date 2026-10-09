/**
 * Minimal bridge from the WeChat plugin to the CompanyClaw desktop app.
 *
 * The plugin never decides an approval: it forwards the raw text to the desktop
 * and waits for the verdict. When there is no desktop parent (development runs,
 * other hosts) or the desktop does not answer in time, the message is released
 * to the AI pipeline unchanged — an approval simply stays pending, which is
 * safe, while swallowing normal chat would not be.
 *
 * The module depends on nothing but the Node process object so it stays
 * testable and adds no coupling between the plugin and desktop packages.
 */

/** How long the AI pipeline waits for the desktop before being given the text. */
export const APPROVAL_REPLY_TIMEOUT_MS = 1500;

export interface SessionSource {
  channelType: string;
  userId: string;
  accountId: string;
  baseUrl: string;
  token?: string;
  contextToken?: string;
  /**
   * Channel-supplied message id. The desktop uses it to de-duplicate a
   * redelivered message, so it must come from the channel and never from the
   * message text.
   */
  messageId?: string;
}

interface PendingRequest {
  resolve: (handled: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal surface of `process` this module needs, so tests can stand in. */
export interface DesktopChannel {
  send?: (message: unknown) => unknown;
  on?: (event: string, listener: (message: unknown) => void) => unknown;
}

const pending = new Map<string, PendingRequest>();
let nextRequestId = 0;

function createRequestId(): string {
  nextRequestId += 1;
  return `${Date.now()}-${nextRequestId}`;
}

/**
 * Publishes the trusted identity metadata of the inbound message.
 *
 * The desktop caches this to know which WeChat account is talking to it. A
 * failure here must never affect message handling, so it is swallowed.
 */
export function publishSessionSource(channel: DesktopChannel | null, source: SessionSource): void {
  try {
    channel?.send?.({ type: "session-source", source });
  } catch {
    // The desktop is optional; losing provenance only means no approval can be
    // granted, never that one is granted wrongly.
  }
}

/**
 * Resolves a pending request from a desktop response.
 *
 * Exported so the response path can be exercised without a real process
 * channel; returns false when nothing was waiting for that id.
 */
export function settleApprovalReply(requestId: string, handled: boolean): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(handled);
  return true;
}

/** Installs the desktop response listener. Safe to call when there is none. */
export function installDesktopBridgeListener(channel: DesktopChannel | null): void {
  channel?.on?.("message", (message: unknown) => {
    const envelope = message as { type?: string; requestId?: string; handled?: boolean };
    if (envelope?.type !== "approval-reply-response") return;
    settleApprovalReply(envelope.requestId ?? "", envelope.handled === true);
  });
}

/**
 * Asks the desktop whether this text is an approval reply.
 *
 * Returns false — meaning "let the AI handle it" — whenever the desktop is
 * absent, unreachable, or silent past the timeout.
 */
export function forwardApprovalReply(
  channel: DesktopChannel | null,
  text: string,
  channelUserId: string,
  timeoutMs: number = APPROVAL_REPLY_TIMEOUT_MS,
): Promise<boolean> {
  if (!channel?.send) return Promise.resolve(false);

  const requestId = createRequestId();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(false);
    }, timeoutMs);
    // A pending timer must not keep the host process alive on its own.
    timer.unref?.();
    pending.set(requestId, { resolve, timer });
    try {
      channel.send({ type: "approval-reply-request", requestId, text, channelUserId });
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(false);
    }
  });
}

/** Number of in-flight requests; used by tests to prove cleanup happens. */
export function pendingApprovalReplyCount(): number {
  return pending.size;
}
