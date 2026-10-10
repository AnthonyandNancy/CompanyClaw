import { describe, expect, it } from "vitest";
import {
  ApprovalRejectionError,
  COMPANYCLAW_APPROVAL_WAIT_MS,
  CompanyClawApprovalStore,
} from "./approval-store";
import { COMPANYCLAW_TICKET_TTL_MS } from "../runtime";
import { hashBinding, type ApprovalBinding } from "../policy/approval-ticket";

/**
 * Ruling Q5: the answer window and the execution credential are different
 * things, and neither may borrow the other's length.
 */

function memoryIo() {
  const files = new Map<string, string>();
  return {
    files,
    write: async (path: string, contents: string) => {
      files.set(path, contents);
    },
    read: (path: string) => files.get(path) ?? "",
    exists: (path: string) => files.has(path),
  };
}

const BINDING: ApprovalBinding = {
  ownerSid: "S-1",
  deviceId: "device-a",
  taskId: "t-1",
  stepId: "s-1",
  actionType: "message-single-recipient",
  targetSystem: "qq",
  recordId: "chat-1",
  field: "message",
  oldValue: null,
  newValue: "内容摘要",
  canonicalPayloadHash: "",
};

function makeStore(ttlMs?: number) {
  const io = memoryIo();
  let clock = new Date("2026-10-10T00:00:00Z");
  const store = new CompanyClawApprovalStore("approvals.json", {
    now: () => clock,
    createId: (() => {
      let n = 0;
      return () => `a-${++n}`;
    })(),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    existsFile: io.exists,
    readFile: io.read,
    writeFile: io.write,
  });
  return { store, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

describe("approval wait window", () => {
  it("defaults to the ten-minute WeChat window", () => {
    expect(COMPANYCLAW_APPROVAL_WAIT_MS).toBe(600_000);
  });

  it("stays answerable after five minutes and expires after the window", async () => {
    const { store, advance } = makeStore();
    const record = await store.request({
      ...BINDING,
      canonicalPayloadHash: hashBinding({ ...BINDING, canonicalPayloadHash: "" }),
    });
    expect(record.resolutionChannel).toBe("weixin");
    expect(record.actionCategory).toBe("message-single-recipient");

    advance(300_000);
    expect(store.get(record.approvalId)?.status).toBe("pending");

    advance(300_001);
    expect(store.get(record.approvalId)?.status).toBe("expired");
  });

  it("refuses to resolve an approval whose wait window has passed", async () => {
    const { store, advance } = makeStore();
    const record = await store.request({
      ...BINDING,
      canonicalPayloadHash: hashBinding({ ...BINDING, canonicalPayloadHash: "" }),
    });
    advance(COMPANYCLAW_APPROVAL_WAIT_MS + 1);
    await expect(store.resolve(record.approvalId, "approved", "S-1")).rejects.toBeInstanceOf(
      ApprovalRejectionError,
    );
  });

  it("records a local dialog as its own resolution channel", async () => {
    const { store } = makeStore();
    const record = await store.request(
      { ...BINDING, canonicalPayloadHash: hashBinding({ ...BINDING, canonicalPayloadHash: "" }) },
      { resolutionChannel: "local", actionCategory: "delete-to-recycle-bin" },
    );
    expect(record.resolutionChannel).toBe("local");
    expect(record.actionCategory).toBe("delete-to-recycle-bin");
  });
});

describe("execution credential ceiling", () => {
  it("keeps the ticket lifetime at or below two minutes", () => {
    expect(COMPANYCLAW_TICKET_TTL_MS).toBeLessThanOrEqual(120_000);
  });

  it("is far shorter than the answer window, so a slow reply never widens it", () => {
    expect(COMPANYCLAW_TICKET_TTL_MS).toBeLessThan(COMPANYCLAW_APPROVAL_WAIT_MS);
  });

  it("reads a pre-V5 record without dropping it", () => {
    const io = memoryIo();
    io.files.set(
      "approvals.json",
      JSON.stringify({
        contract: "companyclaw.approvals.v1",
        records: [
          {
            schemaVersion: 1,
            approvalId: "legacy-1",
            status: "pending",
            ownerSid: "S-1",
            taskId: "t-1",
            stepId: "s-1",
            actionType: "business-write",
            targetSystem: "erp",
            recordId: "r-1",
            field: "status",
            oldValue: "draft",
            newValue: "submitted",
            bindingHash: "a".repeat(64),
            requestedAt: "2026-10-10T00:00:00.000Z",
            expiresAt: "2026-10-10T00:05:00.000Z",
            resolvedAt: null,
            resolvedBy: null,
          },
        ],
      }),
    );
    const store = new CompanyClawApprovalStore("approvals.json", {
      now: () => new Date("2026-10-10T00:01:00Z"),
      existsFile: io.exists,
      readFile: io.read,
      writeFile: io.write,
    });
    const record = store.get("legacy-1");
    expect(record?.status).toBe("pending");
    expect(record?.resolutionChannel).toBe("weixin");
  });
});
