import { describe, expect, it } from "vitest";
import {
  applyApprovalReply,
  formatApprovalBatch,
  formatApprovalCard,
  looksLikeApprovalReply,
  parseApprovalReply,
  truncateValue,
} from "./approval-message";

const card = {
  approvalId: "approval-1",
  targetSystem: "物业工程中心/工单",
  recordId: "WO-2026-0001",
  field: "负责人",
  oldValue: "李四",
  newValue: "张三",
  expiresAt: "2026-10-08T00:05:00.000Z",
};

describe("formatApprovalCard", () => {
  it("shows the system, record, field and the exact change", () => {
    const text = formatApprovalCard(card);
    expect(text).toContain("物业工程中心/工单");
    expect(text).toContain("WO-2026-0001");
    expect(text).toContain("负责人");
    expect(text).toContain("李四");
    expect(text).toContain("张三");
    expect(text).toContain("Y");
    expect(text).toContain("N");
  });

  it("numbers the card when several approvals are outstanding", () => {
    const text = formatApprovalCard({ ...card, index: 2 });
    expect(text).toContain("[2]");
    expect(text).toContain("Y2");
    expect(text).toContain("N2");
  });

  it("shows an explicit marker for an empty value instead of a blank line", () => {
    const text = formatApprovalCard({ ...card, oldValue: null });
    expect(text).toContain("（空）");
  });

  it("includes the risk level when supplied", () => {
    expect(formatApprovalCard({ ...card, riskLevel: "R2" })).toContain("R2");
  });
});

describe("truncateValue", () => {
  it("keeps short values intact", () => {
    expect(truncateValue("张三")).toBe("张三");
  });

  it("truncates a long value instead of dumping it into the chat", () => {
    const long = "x".repeat(500);
    const result = truncateValue(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("formatApprovalBatch", () => {
  it("returns an empty string when nothing is pending", () => {
    expect(formatApprovalBatch([])).toBe("");
  });

  it("numbers a single card as [1]", () => {
    expect(formatApprovalBatch([card])).toContain("[1]");
  });

  it("lists every card and documents the batch reply forms", () => {
    const text = formatApprovalBatch([card, { ...card, approvalId: "approval-2" }]);
    expect(text).toContain("[1]");
    expect(text).toContain("[2]");
    expect(text).toContain("全部批准");
    expect(text).toContain("全部拒绝");
  });
});

describe("parseApprovalReply", () => {
  it("parses the simple Latin forms", () => {
    expect(parseApprovalReply("Y")).toEqual({ decision: "approved", index: null });
    expect(parseApprovalReply("y")).toEqual({ decision: "approved", index: null });
    expect(parseApprovalReply("N")).toEqual({ decision: "denied", index: null });
    expect(parseApprovalReply(" no ")).toEqual({ decision: "denied", index: null });
  });

  it("parses an indexed Latin form", () => {
    expect(parseApprovalReply("Y1")).toEqual({ decision: "approved", index: 1 });
    expect(parseApprovalReply("n12")).toEqual({ decision: "denied", index: 12 });
  });

  it("parses the Chinese forms", () => {
    expect(parseApprovalReply("批准")).toEqual({ decision: "approved", index: null });
    expect(parseApprovalReply("同意")).toEqual({ decision: "approved", index: null });
    expect(parseApprovalReply("拒绝")).toEqual({ decision: "denied", index: null });
    expect(parseApprovalReply("驳回")).toEqual({ decision: "denied", index: null });
    expect(parseApprovalReply("全部批准")).toEqual({ decision: "approved", index: null });
    expect(parseApprovalReply("批准第2项")).toEqual({ decision: "approved", index: 2 });
    expect(parseApprovalReply("拒绝3")).toEqual({ decision: "denied", index: 3 });
  });

  it("returns null for ordinary chat so it is not swallowed as a decision", () => {
    expect(parseApprovalReply("你好")).toBeNull();
    expect(parseApprovalReply("好的，帮我改一下")).toBeNull();
    expect(parseApprovalReply("yes please change it")).toBeNull();
    expect(parseApprovalReply("")).toBeNull();
  });

  it("rejects an index of zero", () => {
    expect(parseApprovalReply("Y0")).toBeNull();
    expect(parseApprovalReply("批准第0项")).toBeNull();
  });
});

describe("applyApprovalReply", () => {
  const pending = [
    { approvalId: "approval-1", ownerSid: "S-1" },
    { approvalId: "approval-2", ownerSid: "S-1" },
  ];

  it("applies an unindexed reply to everything pending", () => {
    expect(applyApprovalReply({ decision: "approved", index: null }, pending)).toEqual({
      ok: true,
      targets: [
        { approvalId: "approval-1", decision: "approved" },
        { approvalId: "approval-2", decision: "approved" },
      ],
    });
  });

  it("applies an indexed reply to exactly one approval", () => {
    expect(applyApprovalReply({ decision: "denied", index: 2 }, pending)).toEqual({
      ok: true,
      targets: [{ approvalId: "approval-2", decision: "denied" }],
    });
  });

  it("refuses an out-of-range index rather than approving something arbitrary", () => {
    expect(applyApprovalReply({ decision: "approved", index: 9 }, pending)).toEqual({
      ok: false,
      reason: "index-out-of-range",
    });
  });

  it("refuses when nothing is pending", () => {
    expect(applyApprovalReply({ decision: "approved", index: null }, [])).toEqual({
      ok: false,
      reason: "no-pending",
    });
  });
});

describe("looksLikeApprovalReply", () => {
  it("recognises replies and ignores normal messages", () => {
    expect(looksLikeApprovalReply("Y1")).toBe(true);
    expect(looksLikeApprovalReply("批准")).toBe(true);
    expect(looksLikeApprovalReply("今天天气不错")).toBe(false);
  });
});
