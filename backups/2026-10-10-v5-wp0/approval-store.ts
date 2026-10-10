import { randomUUID } from "node:crypto";
import { hashBinding, type ApprovalBinding } from "../policy/approval-ticket";

export const COMPANYCLAW_APPROVALS_CONTRACT = "companyclaw.approvals.v1";
export const COMPANYCLAW_APPROVAL_SCHEMA = 1;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface CompanyClawApprovalRecord {
  schemaVersion: typeof COMPANYCLAW_APPROVAL_SCHEMA;
  approvalId: string;
  status: ApprovalStatus;
  ownerSid: string;
  taskId: string;
  stepId: string;
  actionType: string;
  targetSystem: string;
  recordId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  bindingHash: string;
  requestedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export type ApprovalRejectionReason =
  | "unknown-approval"
  | "already-consumed"
  | "owner-mismatch"
  | "expired";

export class ApprovalRejectionError extends Error {
  constructor(
    readonly reason: ApprovalRejectionReason,
    approvalId: string,
  ) {
    super(`Approval ${approvalId} rejected: ${reason}`);
    this.name = "ApprovalRejectionError";
  }
}

interface ApprovalStoreDependencies {
  now?: () => Date;
  createId?: () => string;
  ttlMs?: number;
  secret?: string;
  existsFile?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => Promise<void>;
}

interface ApprovalStoreFile {
  contract: typeof COMPANYCLAW_APPROVALS_CONTRACT;
  records: CompanyClawApprovalRecord[];
}

export interface ApprovalStoreInspection {
  records: CompanyClawApprovalRecord[];
  warning: string | null;
}

export class CompanyClawApprovalStore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly ttlMs: number;
  private readonly existsFile: (filePath: string) => boolean;
  private readonly readFile: (filePath: string) => string;
  private readonly writeFile: (filePath: string, contents: string) => Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    dependencies: ApprovalStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.ttlMs = dependencies.ttlMs ?? 120_000;
    this.existsFile = dependencies.existsFile ?? (() => false);
    this.readFile = dependencies.readFile ?? (() => "");
    this.writeFile = dependencies.writeFile ?? (async () => undefined);
  }

  /** Records exactly as persisted, without the read-time expiry projection. */
  private rawRecords(): { records: CompanyClawApprovalRecord[]; warning: string | null } {
    let raw: string;
    try {
      if (!this.existsFile(this.filePath)) return { records: [], warning: null };
      raw = this.readFile(this.filePath);
    } catch {
      return { records: [], warning: "Approval storage could not be read" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { records: [], warning: "Approval storage is malformed and authorizes nothing" };
    }
    const file = parsed as ApprovalStoreFile;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      file.contract !== COMPANYCLAW_APPROVALS_CONTRACT
    ) {
      return { records: [], warning: "Legacy approval storage authorizes nothing" };
    }
    if (!Array.isArray(file.records)) {
      return { records: [], warning: "Approval storage has no records array" };
    }
    return { records: file.records.filter(isCurrentApprovalRecord), warning: null };
  }

  inspect(): ApprovalStoreInspection {
    const { records, warning } = this.rawRecords();
    // Overdue approvals are reported as expired on read, so an approval that
    // outlived its TTL can never be observed as still authorizing — even when
    // the sweep has not run yet.
    const now = this.now().getTime();
    return {
      warning,
      records: records.map((record) =>
        record.status === "pending" && Date.parse(record.expiresAt) <= now
          ? { ...record, status: "expired" as const }
          : record,
      ),
    };
  }

  get(approvalId: string): CompanyClawApprovalRecord | null {
    return this.inspect().records.find((r) => r.approvalId === approvalId) ?? null;
  }

  listPending(): CompanyClawApprovalRecord[] {
    return this.inspect().records.filter((r) => r.status === "pending");
  }

  isConsumed(approvalId: string): boolean {
    const record = this.get(approvalId);
    return record !== null && record.status !== "pending";
  }

  async request(binding: ApprovalBinding): Promise<CompanyClawApprovalRecord> {
    const now = this.now();
    const record: CompanyClawApprovalRecord = {
      schemaVersion: COMPANYCLAW_APPROVAL_SCHEMA,
      approvalId: this.createId(),
      status: "pending",
      ownerSid: binding.ownerSid,
      taskId: binding.taskId,
      stepId: binding.stepId,
      actionType: binding.actionType,
      targetSystem: binding.targetSystem,
      recordId: binding.recordId,
      field: binding.field,
      oldValue: binding.oldValue,
      newValue: binding.newValue,
      bindingHash: hashBinding(binding),
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };
    await this.enqueueWrite((records) => [...records, record]);
    return record;
  }

  async resolve(
    approvalId: string,
    decision: "approved" | "denied",
    resolvedBy: string,
  ): Promise<CompanyClawApprovalRecord> {
    const record = this.get(approvalId);
    if (!record) throw new ApprovalRejectionError("unknown-approval", approvalId);
    if (record.status !== "pending") {
      // An approval that ran out of time reports `expired`; one that was already
      // decided reports `already-consumed`. Neither can be resolved again.
      throw new ApprovalRejectionError(
        record.status === "expired" ? "expired" : "already-consumed",
        approvalId,
      );
    }
    if (record.ownerSid !== resolvedBy) {
      throw new ApprovalRejectionError("owner-mismatch", approvalId);
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw new ApprovalRejectionError("expired", approvalId);
    }
    const next: CompanyClawApprovalRecord = {
      ...record,
      status: decision,
      resolvedAt: this.now().toISOString(),
      resolvedBy,
    };
    await this.enqueueWrite((records) =>
      records.map((entry) => (entry.approvalId === approvalId ? next : entry)),
    );
    return next;
  }

  /** Marks overdue pending approvals as expired. Returns the number changed. */
  expireOverdue(): number {
    const now = this.now().getTime();
    // Count from the persisted records so a sweep reports what it actually
    // changes, not what the read-time projection already hides.
    const overdue = this.rawRecords().records.filter(
      (r) => r.status === "pending" && Date.parse(r.expiresAt) <= now,
    );
    if (overdue.length === 0) return 0;
    const expiredIds = new Set(overdue.map((r) => r.approvalId));
    void this.enqueueWrite((current) =>
      current.map((entry) =>
        expiredIds.has(entry.approvalId) && entry.status === "pending"
          ? { ...entry, status: "expired" as const, resolvedAt: this.now().toISOString() }
          : entry,
      ),
    );
    return overdue.length;
  }

  private async enqueueWrite(
    update: (current: CompanyClawApprovalRecord[]) => CompanyClawApprovalRecord[],
  ): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const next: ApprovalStoreFile = {
        contract: COMPANYCLAW_APPROVALS_CONTRACT,
        records: update(this.inspect().records),
      };
      await this.writeFile(this.filePath, JSON.stringify(next, null, 2));
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}

function isCurrentApprovalRecord(value: unknown): value is CompanyClawApprovalRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as CompanyClawApprovalRecord;
  return (
    record.schemaVersion === COMPANYCLAW_APPROVAL_SCHEMA &&
    typeof record.approvalId === "string" &&
    record.approvalId.length > 0 &&
    typeof record.ownerSid === "string" &&
    record.ownerSid.length > 0 &&
    typeof record.bindingHash === "string" &&
    ["pending", "approved", "denied", "expired"].includes(record.status)
  );
}
