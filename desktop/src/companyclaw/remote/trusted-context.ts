import { randomUUID } from "node:crypto";

/**
 * The trusted identity of one inbound remote message.
 *
 * The requirements are explicit that a global "the last message came from
 * WeChat" flag cannot be a basis for anything: it says nothing about *who* sent
 * the current message, and a later local message would inherit it. Every field
 * here is therefore derived from local, trusted state —
 *
 *  * `senderId`/`channelAccountId` come from the channel's own metadata, never
 *    from message text;
 *  * `ownerSid`/`deviceId` come from the local WeChat↔device↔SID binding;
 *  * `messageId` is supplied by the channel and is the de-duplication basis;
 *  * `originAttestation` is minted here, at the trusted boundary, and is not
 *    parseable from anything the sender typed.
 *
 * A message whose sender is not the paired identity produces no context at all,
 * so downstream code has nothing to act on.
 */

export const TRUSTED_CONTEXT_CONTRACT = "companyclaw.trusted-remote-context.v1";

export interface TrustedRemoteContextInput {
  channelAccountId: string;
  /** Real sender id as verified by the channel, never taken from message text. */
  senderId: string;
  conversationId: string;
  messageId: string;
  receivedAt: number;
  /** Resolved from local pairing data; null when this sender is not the owner. */
  owner: { ownerSid: string; deviceId: string } | null;
  /** Mints the attestation; injectable so tests do not need randomness. */
  mintAttestation?: () => string;
}

export interface TrustedRemoteContext {
  contract: typeof TRUSTED_CONTEXT_CONTRACT;
  channel: "weixin";
  channelAccountId: string;
  senderId: string;
  conversationId: string;
  messageId: string;
  deviceId: string;
  ownerSid: string;
  receivedAt: number;
  originAttestation: string;
}

export type TrustedContextResult =
  | { ok: true; context: TrustedRemoteContext }
  | { ok: false; reason: TrustedContextRejection };

export type TrustedContextRejection = "unbound-sender" | "missing-sender" | "missing-message-id";

/**
 * Builds the context for one inbound message.
 *
 * Fails closed: a sender without a local binding, or a message without an id,
 * yields no context rather than a context with empty identity fields.
 */
export function buildTrustedRemoteContext(input: TrustedRemoteContextInput): TrustedContextResult {
  const senderId = input.senderId.trim();
  if (!senderId) return { ok: false, reason: "missing-sender" };
  const messageId = input.messageId.trim();
  if (!messageId) return { ok: false, reason: "missing-message-id" };
  if (!input.owner) return { ok: false, reason: "unbound-sender" };

  return {
    ok: true,
    context: {
      contract: TRUSTED_CONTEXT_CONTRACT,
      channel: "weixin",
      channelAccountId: input.channelAccountId,
      senderId,
      conversationId: input.conversationId,
      messageId,
      deviceId: input.owner.deviceId,
      ownerSid: input.owner.ownerSid,
      receivedAt: input.receivedAt,
      originAttestation: (input.mintAttestation ?? (() => cryptoRandomAttestation()))(),
    },
  };
}

function cryptoRandomAttestation(): string {
  // Minted locally, not derived from anything the sender typed: it marks the
  // message as having entered through the trusted boundary. Not a credential,
  // but still generated with a CSPRNG so it cannot be predicted or reused.
  return `mc-${randomUUID()}`;
}

/**
 * Tracks processed message ids so a redelivered message cannot create a second
 * task.
 *
 * Bounded: the channel can redeliver for a while after a reconnect, but keeping
 * every id forever would grow without limit for a long-running install.
 */
export class RemoteMessageDeduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 500) {}

  /** True the first time this id is seen; false for a redelivery. */
  accept(messageId: string): boolean {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    this.order.push(messageId);
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}
