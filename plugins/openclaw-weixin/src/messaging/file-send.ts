import path from "node:path";
import { loadWeixinAccount, listIndexedWeixinAccountIds, CDN_BASE_URL } from "../auth/accounts.js";
import { getContextToken } from "./inbound.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { logger } from "../util/logger.js";
import type { DesktopChannel } from "./desktop-bridge.js";

/**
 * Serves the desktop's file-send requests.
 *
 * The desktop produces an artifact but cannot upload it: the CDN upload lives
 * in this package, and copying it into the main process would mean two
 * implementations of vendor logic drifting apart. The plugin therefore performs
 * the send and answers with exactly what it observed — nothing here decides
 * whether a file *should* be sent, that decision already happened upstream.
 */

interface FileSendRequestEnvelope {
  type: "file-send-request";
  requestId?: string;
  request?: { filePath?: string; to?: string; text?: string };
}

/** Resolves the logged-in account to send from. */
function resolveSendingAccount(): { accountId: string; baseUrl: string; token: string } | null {
  for (const accountId of listIndexedWeixinAccountIds()) {
    const data = loadWeixinAccount(accountId);
    if (!data?.token) continue;
    return {
      accountId,
      baseUrl: data.baseUrl?.trim() || "https://ilinkai.weixin.qq.com",
      token: data.token,
    };
  }
  return null;
}

/**
 * Answers one request. Never throws: the desktop is waiting on an answer, and a
 * thrown error would leave it until the timeout with no idea what happened.
 */
export async function handleFileSendRequest(
  envelope: FileSendRequestEnvelope,
  channel: DesktopChannel | null,
): Promise<void> {
  const requestId = typeof envelope.requestId === "string" ? envelope.requestId : "";
  const filePath = envelope.request?.filePath;
  const to = envelope.request?.to;
  const reply = (payload: Record<string, unknown>) => {
    try {
      channel?.send?.({ type: "file-send-response", requestId, ...payload });
    } catch {
      // Nothing else can be done; the desktop falls back to its own timeout.
    }
  };

  if (!filePath || !to) {
    reply({ ok: false, reason: "invalid-request" });
    return;
  }

  const account = resolveSendingAccount();
  if (!account) {
    reply({ ok: false, reason: "no-sending-account" });
    return;
  }

  try {
    const result = await sendWeixinMediaFile({
      filePath,
      to,
      text: envelope.request?.text ?? "",
      opts: {
        baseUrl: account.baseUrl,
        token: account.token,
        contextToken: getContextToken(account.accountId, to),
      },
      cdnBaseUrl: CDN_BASE_URL,
    });
    logger.info(`[companyclaw] artifact sent to=${to} name=${path.basename(filePath)}`);
    // `messageId` here is a locally generated client id: it proves the request
    // was issued, not that the owner received the file.
    reply({ ok: true, messageId: result.messageId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const indeterminate = /timeout|timed out|socket hang up|ECONNRESET/i.test(reason);
    logger.warn(`[companyclaw] artifact send failed to=${to}: ${reason}`);
    reply({ ok: false, reason, ...(indeterminate ? { indeterminate: true } : {}) });
  }
}
