/**
 * WeChat approval messages: formatting outbound cards and parsing inbound
 * replies.
 *
 * Pure functions only. The desktop composes/consumes these; the WeChat plugin
 * merely forwards text. All decision-making stays in the policy layer, so a
 * crafted message can never approve anything by itself.
 */

export interface ApprovalCardInput {
  approvalId: string;
  targetSystem: string;
  recordId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** 1-based position shown to the user when several approvals are pending. */
  index?: number;
  expiresAt: string;
  riskLevel?: string;
}

export interface ApprovalReply {
  decision: "approved" | "denied";
  /** 1-based index the user addressed, or null for "all". */
  index: number | null;
}

const MAX_VALUE_CHARS = 120;

/**
 * Truncates a value for display. Long values are cut rather than dumped into a
 * chat message: the card is a confirmation aid, not a data export.
 */
export function truncateValue(value: string | null): string {
  if (value === null) return "（空）";
  if (value.length <= MAX_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_VALUE_CHARS)}…`;
}

export function formatApprovalCard(input: ApprovalCardInput): string {
  const prefix = input.index !== undefined ? `[${input.index}] ` : "";
  const lines = [
    `${prefix}⚠️ 需要你确认的修改`,
    `系统：${input.targetSystem || "—"}`,
    `记录：${input.recordId || "—"}`,
    `字段：${input.field || "—"}`,
    `原值：${truncateValue(input.oldValue)}`,
    `新值：${truncateValue(input.newValue)}`,
  ];
  if (input.riskLevel) lines.push(`风险等级：${input.riskLevel}`);
  lines.push(`有效期至：${input.expiresAt}`);
  lines.push("");
  lines.push(input.index !== undefined ? `回复 Y${input.index} 批准 / N${input.index} 拒绝` : "回复 Y 批准 / N 拒绝");
  return lines.join("\n");
}

export function formatApprovalBatch(cards: ApprovalCardInput[]): string {
  if (cards.length === 0) return "";
  if (cards.length === 1) {
    return formatApprovalCard({ ...cards[0], index: 1 });
  }
  const header = `📋 有 ${cards.length} 项修改等待确认：`;
  const body = cards
    .map((card, position) => formatApprovalCard({ ...card, index: position + 1 }))
    .join("\n\n");
  return `${header}\n\n${body}\n\n回复：\n  Y  全部批准\n  N  全部拒绝\n  Y1 只批准第 1 项\n  N2 只拒绝第 2 项`;
}

/**
 * Parses a reply. Only explicit forms are accepted; anything else returns null
 * so the message continues to the AI as ordinary chat instead of being
 * swallowed as an approval decision.
 */
export function parseApprovalReply(raw: string): ApprovalReply | null {
  const text = raw.trim();
  if (!text) return null;

  // Latin forms: Y / y / yes, N / n / no, with an optional 1-based index.
  const latin = /^(y|yes|n|no)(\d+)?$/i.exec(text);
  if (latin) {
    const decision = latin[1].toLowerCase().startsWith("y") ? "approved" : "denied";
    const index = latin[2] ? Number.parseInt(latin[2], 10) : null;
    if (index !== null && index < 1) return null;
    return { decision, index };
  }

  // Chinese forms: 批准 / 同意 / 拒绝 / 驳回, with an optional index and
  // optional 全部 prefix.
  const chinese = /^(全部)?(批准|同意|拒绝|驳回)(第)?(\d+)?(项)?$/.exec(text);
  if (chinese) {
    const all = chinese[1] === "全部";
    const decision = chinese[2] === "批准" || chinese[2] === "同意" ? "approved" : "denied";
    const index = all ? null : chinese[4] ? Number.parseInt(chinese[4], 10) : null;
    if (index !== null && index < 1) return null;
    return { decision, index };
  }

  return null;
}

export interface PendingApprovalRef {
  approvalId: string;
  ownerSid: string;
}

export interface ResolveTarget {
  approvalId: string;
  decision: "approved" | "denied";
}

export type ApplyReplyResult =
  | { ok: true; targets: ResolveTarget[] }
  | { ok: false; reason: "no-pending" | "index-out-of-range" };

/**
 * Maps a parsed reply onto the actual pending approvals.
 *
 * `pending` is already scoped to the replying user by the caller, so a reply
 * can only ever act on that user's own requests.
 */
export function applyApprovalReply(
  reply: ApprovalReply,
  pending: readonly PendingApprovalRef[],
): ApplyReplyResult {
  if (pending.length === 0) return { ok: false, reason: "no-pending" };

  if (reply.index === null) {
    return {
      ok: true,
      targets: pending.map((entry) => ({ approvalId: entry.approvalId, decision: reply.decision })),
    };
  }

  const target = pending[reply.index - 1];
  if (!target) return { ok: false, reason: "index-out-of-range" };
  return { ok: true, targets: [{ approvalId: target.approvalId, decision: reply.decision }] };
}

/** True when the text looks like it could be an approval reply. */
export function looksLikeApprovalReply(raw: string): boolean {
  return parseApprovalReply(raw) !== null;
}
