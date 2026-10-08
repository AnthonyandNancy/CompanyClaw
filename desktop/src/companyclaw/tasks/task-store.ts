import { randomUUID } from "node:crypto";
import { assertTransition, isTerminalState, type TaskState } from "./task-state";

export const COMPANYCLAW_TASK_STORE_CONTRACT = "companyclaw.tasks.v1";
export const COMPANYCLAW_TASK_SCHEMA = 1;

export interface CompanyClawTaskRecord {
  schemaVersion: typeof COMPANYCLAW_TASK_SCHEMA;
  taskId: string;
  ownerSid: string;
  deviceId: string;
  channel: string;
  objective: string;
  state: TaskState;
  stepId: string | null;
  executor: string | null;
  target: string | null;
  approvalId: string | null;
  expectedPostcondition: string | null;
  evidenceRefs: string[];
  idempotencyKey: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface CompanyClawTaskCreateInput {
  ownerSid: string;
  deviceId: string;
  channel: string;
  objective: string;
  idempotencyKey?: string | null;
}

export type CompanyClawTaskAdvancePatch = Partial<
  Pick<
    CompanyClawTaskRecord,
    | "stepId"
    | "executor"
    | "target"
    | "approvalId"
    | "expectedPostcondition"
    | "evidenceRefs"
    | "resultSummary"
  >
>;

export interface CompanyClawTaskStoreInspection {
  records: CompanyClawTaskRecord[];
  warning: string | null;
}

interface TaskStoreDependencies {
  now?: () => Date;
  createId?: () => string;
  existsFile?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => Promise<void>;
}

interface TaskStoreFile {
  contract: typeof COMPANYCLAW_TASK_STORE_CONTRACT;
  records: CompanyClawTaskRecord[];
}

export function createTaskIdempotencyKey(
  taskId: string,
  stepId: string,
  payloadHash: string,
): string {
  return `${taskId}:${stepId}:${payloadHash}`;
}

export function filterTasksForOwner(
  records: readonly CompanyClawTaskRecord[],
  ownerSid: string,
): CompanyClawTaskRecord[] {
  return records.filter((record) => record.ownerSid === ownerSid);
}

export class CompanyClawTaskStore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly existsFile: (filePath: string) => boolean;
  private readonly readFile: (filePath: string) => string;
  private readonly writeFile: (filePath: string, contents: string) => Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    dependencies: TaskStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.existsFile = dependencies.existsFile ?? (() => false);
    this.readFile = dependencies.readFile ?? (() => "");
    this.writeFile = dependencies.writeFile ?? (async () => undefined);
  }

  inspect(): CompanyClawTaskStoreInspection {
    let raw: string;
    try {
      if (!this.existsFile(this.filePath)) return { records: [], warning: null };
      raw = this.readFile(this.filePath);
    } catch {
      return { records: [], warning: "Task storage could not be read and authorizes nothing" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { records: [], warning: "Task storage is malformed and authorizes nothing" };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as TaskStoreFile).contract !== COMPANYCLAW_TASK_STORE_CONTRACT ||
      !Array.isArray((parsed as TaskStoreFile).records)
    ) {
      return { records: [], warning: "Legacy or unsupported task storage authorizes nothing" };
    }
    const records = (parsed as TaskStoreFile).records.filter(isCurrentTaskRecord);
    const invalid = (parsed as TaskStoreFile).records.length - records.length;
    return {
      records,
      warning: invalid > 0 ? `${invalid} malformed task record(s) were ignored` : null,
    };
  }

  list(): CompanyClawTaskRecord[] {
    return this.inspect().records;
  }

  get(taskId: string): CompanyClawTaskRecord | null {
    return this.list().find((record) => record.taskId === taskId) ?? null;
  }

  findByIdempotencyKey(key: string): CompanyClawTaskRecord | null {
    return this.list().find((record) => record.idempotencyKey === key) ?? null;
  }

  async create(input: CompanyClawTaskCreateInput): Promise<CompanyClawTaskRecord> {
    const timestamp = this.now().toISOString();
    const record: CompanyClawTaskRecord = {
      schemaVersion: COMPANYCLAW_TASK_SCHEMA,
      taskId: this.createId(),
      ownerSid: input.ownerSid,
      deviceId: input.deviceId,
      channel: input.channel,
      objective: input.objective,
      state: "CREATED",
      stepId: null,
      executor: null,
      target: null,
      approvalId: null,
      expectedPostcondition: null,
      evidenceRefs: [],
      idempotencyKey: input.idempotencyKey ?? null,
      resultSummary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      terminalAt: null,
    };
    await this.enqueueWrite((records) => [...records, record]);
    return record;
  }

  async advance(
    taskId: string,
    to: TaskState,
    patch: CompanyClawTaskAdvancePatch,
  ): Promise<CompanyClawTaskRecord> {
    const current = this.get(taskId);
    if (!current) throw new Error(`Unknown task: ${taskId}`);
    assertTransition(current.state, to);
    const timestamp = this.now().toISOString();
    const next: CompanyClawTaskRecord = {
      ...current,
      ...patch,
      state: to,
      updatedAt: timestamp,
      terminalAt: isTerminalState(to) ? (current.terminalAt ?? timestamp) : null,
    };
    await this.enqueueWrite((records) =>
      records.map((record) => (record.taskId === taskId ? next : record)),
    );
    return next;
  }

  async save(record: CompanyClawTaskRecord): Promise<void> {
    await this.enqueueWrite((records) => [
      ...records.filter((entry) => entry.taskId !== record.taskId),
      record,
    ]);
  }

  private async enqueueWrite(
    update: (current: CompanyClawTaskRecord[]) => CompanyClawTaskRecord[],
  ): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const next: TaskStoreFile = {
        contract: COMPANYCLAW_TASK_STORE_CONTRACT,
        records: update(this.inspect().records),
      };
      await this.writeFile(this.filePath, JSON.stringify(next, null, 2));
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}

function isCurrentTaskRecord(value: unknown): value is CompanyClawTaskRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as CompanyClawTaskRecord;
  return (
    record.schemaVersion === COMPANYCLAW_TASK_SCHEMA &&
    typeof record.taskId === "string" &&
    record.taskId.length > 0 &&
    typeof record.ownerSid === "string" &&
    record.ownerSid.length > 0 &&
    typeof record.state === "string" &&
    Array.isArray(record.evidenceRefs)
  );
}
