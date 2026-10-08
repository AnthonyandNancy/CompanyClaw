import { describe, expect, it } from "vitest";
import { ApprovalRejectionError, CompanyClawApprovalStore } from "./approval-store";
import { hashBinding, type ApprovalBinding } from "../policy/approval-ticket";

const filePath = "C:\\State\\companyclaw\\approvals.json";

function makeBinding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  const base: ApprovalBinding = {
    ownerSid: "S-1",
    deviceId: "d",
    taskId: "task-1",
    stepId: "step-1",
    actionType: "business-write",
    targetSystem: "sys",
    recordId: "rec-1",
    field: "owner",
    oldValue: "a",
    newValue: "b",
    canonicalPayloadHash: "",
  };
  const merged = { ...base, ...overrides };
  return { ...merged, canonicalPayloadHash: hashBinding(merged) };
}

const binding = makeBinding();

/** A single shared JSON document so two stores observe each other's writes. */
function sharedFile() {
  let contents: string | null = null;
  return {
    deps: {
      existsFile: (target: string) => target === filePath && contents !== null,
      readFile: () => contents ?? "",
      writeFile: async (_target: string, next: string) => {
        contents = next;
      },
    },
    seed: (value: unknown) => {
      contents = JSON.stringify(value);
    },
    raw: () => contents,
  };
}

function store(shared: ReturnType<typeof sharedFile>, nowIso = "2026-10-08T00:00:00.000Z") {
  return new CompanyClawApprovalStore(filePath, {
    now: () => new Date(nowIso),
    createId: () => "approval-1",
    ttlMs: 120_000,
    secret: "unit-secret",
    ...shared.deps,
  });
}

describe("CompanyClawApprovalStore", () => {
  it("creates a pending approval bound to the exact change", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    const record = await instance.request(binding);
    expect(record).toMatchObject({ approvalId: "approval-1", status: "pending" });
    expect(record.bindingHash).toBe(hashBinding(binding));
    expect(instance.listPending()).toHaveLength(1);
  });

  it("approves once and rejects a second resolve (no replay)", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    await instance.request(binding);
    const approved = await instance.resolve("approval-1", "approved", "S-1");
    expect(approved.status).toBe("approved");
    expect(instance.isConsumed("approval-1")).toBe(true);
    await expect(instance.resolve("approval-1", "approved", "S-1")).rejects.toThrow(
      ApprovalRejectionError,
    );
    await expect(instance.resolve("approval-1", "approved", "S-1")).rejects.toThrow(
      /already-consumed/,
    );
  });

  it("refuses a decision from a different owner", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    await instance.request(binding);
    await expect(instance.resolve("approval-1", "approved", "S-999")).rejects.toThrow(
      /owner-mismatch/,
    );
  });

  it("denies execution after a denial", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    await instance.request(binding);
    await instance.resolve("approval-1", "denied", "S-1");
    expect(instance.isConsumed("approval-1")).toBe(true);
    expect(instance.get("approval-1")?.status).toBe("denied");
    await expect(instance.resolve("approval-1", "approved", "S-1")).rejects.toThrow(
      /already-consumed/,
    );
  });

  it("expires overdue approvals and treats them as non-authorizing", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    await instance.request(binding);

    const later = store(shared, "2026-10-08T01:00:00.000Z");
    expect(later.get("approval-1")?.status).toBe("expired");
    await expect(later.resolve("approval-1", "approved", "S-1")).rejects.toThrow(/expired/);
  });

  it("reports an urgent sweep count for overdue approvals", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    await instance.request(binding);
    const later = store(shared, "2026-10-08T01:00:00.000Z");
    // expireOverdue counts records that were still pending on disk.
    expect(shared.raw()).toContain("\"pending\"");
    expect(later.expireOverdue()).toBe(1);
  });

  it("authorizes nothing when storage is malformed", () => {
    const shared = sharedFile();
    shared.seed("}{ not json");
    const instance = store(shared);
    expect(instance.listPending()).toEqual([]);
    expect(instance.inspect().warning).toBeTruthy();

    const legacy = sharedFile();
    legacy.seed({ contract: "companyclaw.approvals.old", records: [] });
    const legacyStore = store(legacy);
    expect(legacyStore.listPending()).toEqual([]);
    expect(legacyStore.inspect().warning).toBeTruthy();
  });
});
