import { describe, expect, it } from "vitest";
import {
  canonicalizeBinding,
  hashBinding,
  issueApprovalTicket,
  verifyApprovalTicket,
  type ApprovalBinding,
} from "./approval-ticket";

const secret = "unit-test-secret";
const binding: ApprovalBinding = {
  ownerSid: "S-1-5-21-1",
  deviceId: "device-a",
  taskId: "task-1",
  stepId: "step-2",
  actionType: "business-write",
  targetSystem: "物业工程中心/工单",
  recordId: "WO-2026-0001",
  field: "owner",
  oldValue: "李四",
  newValue: "张三",
  canonicalPayloadHash: hashBinding({
    ownerSid: "S-1-5-21-1",
    deviceId: "device-a",
    taskId: "task-1",
    stepId: "step-2",
    actionType: "business-write",
    targetSystem: "物业工程中心/工单",
    recordId: "WO-2026-0001",
    field: "owner",
    oldValue: "李四",
    newValue: "张三",
    canonicalPayloadHash: "",
  }),
};

const now = () => new Date("2026-10-08T00:00:00.000Z");

describe("approval tickets", () => {
  it("canonicalizes deterministically regardless of key order", () => {
    const a = canonicalizeBinding(binding);
    const b = canonicalizeBinding({ ...binding });
    expect(a).toBe(b);
    expect(a).toContain("task-1");
  });

  it("accepts a freshly issued ticket exactly once", () => {
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const consumed = new Set<string>();
    expect(
      verifyApprovalTicket({ ticket, binding, secret, now, consumedNonces: consumed }),
    ).toEqual({ ok: true });
  });

  it("rejects a ticket for a different binding", () => {
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const other = { ...binding, newValue: "王五" };
    expect(
      verifyApprovalTicket({
        ticket,
        binding: other,
        secret,
        now,
        consumedNonces: new Set(),
      }),
    ).toEqual({ ok: false, reason: "binding-mismatch" });
  });

  it("rejects a tampered ticket and a foreign secret", () => {
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const tampered = { ...ticket, bindingHash: "0".repeat(64) };
    expect(
      verifyApprovalTicket({ ticket: tampered, binding, secret, now, consumedNonces: new Set() }),
    ).toEqual({ ok: false, reason: "bad-signature" });
    expect(
      verifyApprovalTicket({ ticket, binding, secret: "other", now, consumedNonces: new Set() }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects expired and not-yet-valid tickets", () => {
    const issued = issueApprovalTicket({ binding, secret, ttlMs: 1_000, now });
    expect(
      verifyApprovalTicket({
        ticket: issued,
        binding,
        secret,
        now: () => new Date("2026-10-08T00:01:00.000Z"),
        consumedNonces: new Set(),
      }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      verifyApprovalTicket({
        ticket: issued,
        binding,
        secret,
        now: () => new Date("2026-10-07T23:59:00.000Z"),
        consumedNonces: new Set(),
      }),
    ).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  it("rejects a replayed ticket whose nonce was consumed", () => {
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const consumed = new Set<string>([ticket.nonce]);
    expect(
      verifyApprovalTicket({ ticket, binding, secret, now, consumedNonces: consumed }),
    ).toEqual({ ok: false, reason: "already-consumed" });
  });

  it("rejects malformed tickets", () => {
    expect(
      verifyApprovalTicket({
        ticket: { nonce: "n" } as never,
        binding,
        secret,
        now,
        consumedNonces: new Set(),
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
