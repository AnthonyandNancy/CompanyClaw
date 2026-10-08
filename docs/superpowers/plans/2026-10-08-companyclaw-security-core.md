# CompanyClaw 安全内核（Security Core）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MicroClaw 中落地 CompanyClaw 的**安全内核**——任务状态机、R0–R3 策略裁决、一次性审批票据、审批生命周期、执行桥、结果桥——使"微信远程操作本人电脑"具备执行层强制的授权、拦截与审计能力。

**Architecture:** 全部新增能力位于独立目录 `desktop/src/companyclaw/`，**不修改 `main.ts` 既有逻辑**，不触碰 AppContainer / MXC / 微信插件。每个模块沿用仓库既有惯用法：`contract` 字符串 + `schemaVersion` 版本化、依赖注入以便单测（参照 `WindowsNodeMxcDurableApprovalStore`）、原子写（0600 + 临时文件 + rename）、失效即"什么都不授权"（fail-closed）。

**Tech Stack:** TypeScript（CommonJS、strict）、Node `crypto`（HMAC-SHA256 / randomUUID）、Vitest（node 环境，测试与源码同目录 `*.test.ts`）。

## Global Constraints

- 上游基线 commit：`6f080a07f43bd65b8b27ec6f859438fc038bb912`；本计划分支 `feat/companyclaw-foundation`。
- 上游锁定 OpenClaw `2026.9.3`；Node 引擎范围 `>=24.16.0 <25 || >=26.1.0`。
- **禁止**修改：`appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`desktop/src/main.ts` 既有逻辑、`plugins/openclaw-weixin/**` 核心源码、`skills/**`。
- **禁止**把 `Windows-MCP` 或任何 MCP 工具全集直接暴露；**禁止**以工具名称判定安全等级。
- R3（删除重要数据、付款转账、对外发布、修改系统安全配置、注册表、任意 PowerShell/CMD、执行未知程序、绕过企业策略）在远程模式下**一律拒绝**，且不得提供回归开关。
- 无法证明无副作用的操作**不得**归类为 R0。
- 所有新增持久化数据：`ownerSid` 隔离、不存明文口令/令牌/整页敏感内容、仅存引用与哈希。
- 新增配置默认值一律 fail-safe（默认关闭）。
- 每个模块必须可独立单测；**测试先写并看到失败**（TDD），再写实现。
- 每个 Task 结束提交一次 commit，提交信息用 `feat(companyclaw): ...`。
- 命令：`cd desktop && npx vitest run <path>`；全量 `npx vitest run`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `desktop/src/companyclaw/tasks/task-state.ts` | 任务状态定义、合法转换、终态判定 |
| `desktop/src/companyclaw/tasks/task-store.ts` | 任务持久化（版本化、原子写、SID 隔离、幂等键） |
| `desktop/src/companyclaw/policy/risk-classifier.ts` | 动作 → R0–R3 分级，含"不可证明则不得 R0" |
| `desktop/src/companyclaw/policy/approval-ticket.ts` | 一次性 HMAC 票据签发与校验 |
| `desktop/src/companyclaw/approvals/approval-store.ts` | 审批记录生命周期（待审/批准/拒绝/过期、防重放） |
| `desktop/src/companyclaw/bridge/execution-bridge.ts` | 执行桥：仅放行已裁决动作，失败关闭 |
| `desktop/src/companyclaw/results/artifact-validator.ts` | 产物校验：存在性/大小/魔数/ZIP 结构 |
| `desktop/src/companyclaw/results/delivery-status.ts` | 送达状态机：`SEND_REQUESTED→SENT→DELIVERED`(+`FAILED`/`UNKNOWN`) |
| `desktop/src/companyclaw/remote/remote-authorization.ts` | 远程操作授权开关、有效期、撤销、会话来源绑定 |

所有模块均为纯逻辑（无 Electron / 无 Electron Store 依赖），以便在 `environment: "node"` 下直接单测。

---

## Task 1: 任务状态机

**Files:**
- Create: `desktop/src/companyclaw/tasks/task-state.ts`
- Test: `desktop/src/companyclaw/tasks/task-state.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `TASK_STATES` / `type TaskState`
  - `TERMINAL_TASK_STATES` / `isTerminalState(s): boolean`
  - `ACTIVE_TASK_STATES` / `isActiveState(s): boolean`
  - `canTransition(from: TaskState, to: TaskState): boolean`
  - `assertTransition(from: TaskState, to: TaskState): void`（非法时 throw）
  - `nextStateForControl(state: TaskState, control: TaskControl): TaskState | null`
  - `type TaskControl = "pause" | "resume" | "cancel" | "emergency-stop"`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/tasks/task-state.test.ts
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isActiveState,
  isTerminalState,
  nextStateForControl,
  TERMINAL_TASK_STATES,
} from "./task-state";

describe("task state machine", () => {
  it("allows the documented forward transitions", () => {
    expect(canTransition("CREATED", "AUTHENTICATED")).toBe(true);
    expect(canTransition("AUTHENTICATED", "PLANNING")).toBe(true);
    expect(canTransition("PLANNING", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "AWAITING_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "VERIFYING")).toBe(true);
    expect(canTransition("VERIFYING", "COMPLETED")).toBe(true);
    expect(canTransition("VERIFYING", "RUNNING")).toBe(true);
  });

  it("requires RESUMING between PAUSED and RUNNING", () => {
    expect(canTransition("RUNNING", "PAUSE_REQUESTED")).toBe(true);
    expect(canTransition("PAUSE_REQUESTED", "PAUSED")).toBe(true);
    expect(canTransition("PAUSED", "RESUMING")).toBe(true);
    expect(canTransition("RESUMING", "RUNNING")).toBe(true);
    // 直连禁止：恢复必须经过 RESUMING 的环境复核
    expect(canTransition("PAUSED", "RUNNING")).toBe(false);
  });

  it("never transitions out of a terminal state", () => {
    for (const terminal of TERMINAL_TASK_STATES) {
      for (const target of ["RUNNING", "PLANNING", "COMPLETED"] as const) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it("treats every active state as cancelable but terminal states as active-free", () => {
    expect(isActiveState("RUNNING")).toBe(true);
    expect(isActiveState("AWAITING_APPROVAL")).toBe(true);
    expect(isActiveState("PAUSED")).toBe(true);
    expect(isTerminalState("CANCELLED")).toBe(true);
    expect(isActiveState("CANCELLED")).toBe(false);
  });

  it("maps user controls onto the state machine", () => {
    expect(nextStateForControl("RUNNING", "pause")).toBe("PAUSE_REQUESTED");
    expect(nextStateForControl("AWAITING_APPROVAL", "pause")).toBe("PAUSE_REQUESTED");
    expect(nextStateForControl("PAUSED", "resume")).toBe("RESUMING");
    // 暂停/恢复不能越过状态机
    expect(nextStateForControl("CREATED", "resume")).toBeNull();
    expect(nextStateForControl("COMPLETED", "cancel")).toBeNull();
    expect(nextStateForControl("RUNNING", "cancel")).toBe("CANCELLED");
    expect(nextStateForControl("AWAITING_APPROVAL", "cancel")).toBe("CANCELLED");
    expect(nextStateForControl("RUNNING", "emergency-stop")).toBe("CANCELLED");
    expect(nextStateForControl("PAUSED", "emergency-stop")).toBe("CANCELLED");
  });

  it("throws with both states named on an illegal transition", () => {
    expect(() => assertTransition("PAUSED", "RUNNING")).toThrow(/PAUSED.*RUNNING/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/tasks/task-state.test.ts`
Expected: FAIL — `Failed to resolve import "./task-state"`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/tasks/task-state.ts
export const TASK_STATES = [
  "CREATED",
  "AUTHENTICATED",
  "PLANNING",
  "RUNNING",
  "AWAITING_APPROVAL",
  "PAUSE_REQUESTED",
  "PAUSED",
  "RESUMING",
  "VERIFYING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const satisfies readonly TaskState[];

export type TaskControl = "pause" | "resume" | "cancel" | "emergency-stop";

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  CREATED: ["AUTHENTICATED", "CANCELLED", "FAILED", "EXPIRED"],
  AUTHENTICATED: ["PLANNING", "CANCELLED", "FAILED", "EXPIRED"],
  PLANNING: ["RUNNING", "AWAITING_APPROVAL", "CANCELLED", "FAILED", "EXPIRED"],
  RUNNING: [
    "AWAITING_APPROVAL",
    "PAUSE_REQUESTED",
    "VERIFYING",
    "CANCELLED",
    "FAILED",
    "EXPIRED",
  ],
  AWAITING_APPROVAL: [
    "RUNNING",
    "PAUSE_REQUESTED",
    "CANCELLED",
    "FAILED",
    "EXPIRED",
  ],
  PAUSE_REQUESTED: ["PAUSED", "CANCELLED", "FAILED", "EXPIRED"],
  PAUSED: ["RESUMING", "CANCELLED", "FAILED", "EXPIRED"],
  // 恢复后可能直接进入验证（暂停发生在写入之后）或回到等待授权。
  RESUMING: ["RUNNING", "AWAITING_APPROVAL", "CANCELLED", "FAILED", "EXPIRED"],
  VERIFYING: ["COMPLETED", "PARTIAL", "RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  PARTIAL: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isActiveState(state: TaskState): boolean {
  return !isTerminalState(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}

const CONTROL_MAP: Readonly<
  Record<TaskControl, readonly TaskState[]>
> = {
  pause: ["RUNNING", "AWAITING_APPROVAL", "PLANNING"],
  resume: ["PAUSED"],
  cancel: [
    "CREATED",
    "AUTHENTICATED",
    "PLANNING",
    "RUNNING",
    "AWAITING_APPROVAL",
    "PAUSE_REQUESTED",
    "PAUSED",
    "RESUMING",
    "VERIFYING",
  ],
  "emergency-stop": [
    "CREATED",
    "AUTHENTICATED",
    "PLANNING",
    "RUNNING",
    "AWAITING_APPROVAL",
    "PAUSE_REQUESTED",
    "PAUSED",
    "RESUMING",
    "VERIFYING",
  ],
};

/** Returns the next state, or null when the control is illegal for this state. */
export function nextStateForControl(state: TaskState, control: TaskControl): TaskState | null {
  if (!CONTROL_MAP[control].includes(state)) return null;
  switch (control) {
    case "pause":
      return "PAUSE_REQUESTED";
    case "resume":
      return "RESUMING";
    case "cancel":
      return "CANCELLED";
    case "emergency-stop":
      return "CANCELLED";
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/tasks/task-state.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/tasks/task-state.ts desktop/src/companyclaw/tasks/task-state.test.ts
git commit -m "feat(companyclaw): add task state machine with pause/resume gate"
```

---

## Task 2: 任务持久化

**Files:**
- Create: `desktop/src/companyclaw/tasks/task-store.ts`
- Test: `desktop/src/companyclaw/tasks/task-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TaskState`、`isTerminalState`
- Produces:
  - `COMPANYCLAW_TASK_STORE_CONTRACT = "companyclaw.tasks.v1"`
  - `COMPANYCLAW_TASK_SCHEMA = 1`
  - `interface CompanyClawTaskRecord`（`taskId, ownerSid, deviceId, channel, objective, state, stepId, executor, target, approvalId, expectedPostcondition, evidenceRefs, idempotencyKey, createdAt, updatedAt, terminalAt, resultSummary`）
  - `class CompanyClawTaskStore`（`list()` / `get(taskId)` / `save(record)` / `create(input)` / `advance(taskId, to, patch)` / `findByIdempotencyKey(key)`）
  - `createTaskIdempotencyKey(taskId, stepId, payloadHash): string`
  - `filterTasksForOwner(records, ownerSid)`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/tasks/task-store.test.ts
import { describe, expect, it } from "vitest";
import {
  COMPANYCLAW_TASK_STORE_CONTRACT,
  CompanyClawTaskStore,
  createTaskIdempotencyKey,
  filterTasksForOwner,
} from "./task-store";

const filePath = "C:\\State\\companyclaw\\tasks.json";

function store(initial: unknown = null) {
  let contents = initial === null ? null : JSON.stringify(initial);
  const writes: string[] = [];
  const instance = new CompanyClawTaskStore(filePath, {
    now: () => new Date("2026-10-08T00:00:00.000Z"),
    createId: () => "task-1",
    existsFile: (target) => target === filePath && contents !== null,
    readFile: () => contents ?? "",
    writeFile: async (_target, next) => {
      writes.push(next);
      contents = next;
    },
  });
  return { instance, writes };
}

describe("CompanyClawTaskStore", () => {
  it("creates a task in CREATED with an owner binding", () => {
    const { instance } = store();
    const record = instance.create({
      ownerSid: "S-1-5-21-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "把 ABC 公司工单负责人改成张三",
    });
    expect(record).toMatchObject({
      taskId: "task-1",
      state: "CREATED",
      ownerSid: "S-1-5-21-1",
      channel: "openclaw-weixin",
    });
    expect(instance.get("task-1")).not.toBeNull();
  });

  it("advances only through legal transitions", () => {
    const { instance } = store();
    instance.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "x",
    });
    instance.advance("task-1", "AUTHENTICATED", {});
    expect(instance.get("task-1")?.state).toBe("AUTHENTICATED");
    expect(() => instance.advance("task-1", "COMPLETED", {})).toThrow(
      /AUTHENTICATED -> COMPLETED/,
    );
  });

  it("stamps terminalAt only on terminal states", () => {
    const { instance } = store();
    instance.create({ ownerSid: "S", deviceId: "d", channel: "c", objective: "o" });
    expect(instance.get("task-1")?.terminalAt).toBeNull();
    instance.advance("task-1", "CANCELLED", {});
    expect(instance.get("task-1")?.terminalAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("returns null and warns for malformed or legacy storage (authorizes nothing)", () => {
    const legacy = store({ records: [], contract: "old" });
    expect(legacy.instance.list()).toEqual([]);
    expect(legacy.instance.inspect().warning).toBeTruthy();
    const malformed = store("not json");
    expect(malformed.instance.list()).toEqual([]);
  });

  it("persists a versioned envelope and keeps owner isolation", () => {
    const { instance, writes } = store();
    instance.create({ ownerSid: "S-1", deviceId: "d", channel: "c", objective: "o" });
    expect(JSON.parse(writes[0]).contract).toBe(COMPANYCLAW_TASK_STORE_CONTRACT);
    const other = new CompanyClawTaskStore(filePath, {
      now: () => new Date("2026-10-08T00:00:00.000Z"),
      createId: () => "task-2",
      existsFile: (t) => t === filePath,
      readFile: () => writes[0],
      writeFile: async () => undefined,
    });
    other.create({ ownerSid: "S-2", deviceId: "d", channel: "c", objective: "o" });
    expect(filterTasksForOwner(other.list(), "S-1").map((r) => r.taskId)).toEqual(["task-1"]);
    expect(filterTasksForOwner(other.list(), "S-2").map((r) => r.taskId)).toEqual(["task-2"]);
  });

  it("derives a stable idempotency key and finds an existing task by it", () => {
    const key = createTaskIdempotencyKey("task-1", "step-2", "abc123");
    expect(key).toBe("task-1:step-2:abc123");
    const { instance } = store();
    instance.create({
      ownerSid: "S",
      deviceId: "d",
      channel: "c",
      objective: "o",
      idempotencyKey: key,
    });
    expect(instance.findByIdempotencyKey(key)?.taskId).toBe("task-1");
    expect(instance.findByIdempotencyKey("missing")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/tasks/task-store.test.ts`
Expected: FAIL — cannot resolve `./task-store`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/tasks/task-store.ts
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

  create(input: CompanyClawTaskCreateInput): CompanyClawTaskRecord {
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
    this.enqueueWrite((records) => [...records, record]);
    return record;
  }

  advance(
    taskId: string,
    to: TaskState,
    patch: Partial<
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
    >,
  ): CompanyClawTaskRecord {
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
    this.enqueueWrite((records) =>
      records.map((record) => (record.taskId === taskId ? next : record)),
    );
    return next;
  }

  save(record: CompanyClawTaskRecord): void {
    this.enqueueWrite((records) => {
      const without = records.filter((entry) => entry.taskId !== record.taskId);
      return [...without, record];
    });
  }

  private enqueueWrite(
    update: (current: CompanyClawTaskRecord[]) => CompanyClawTaskRecord[],
  ): void {
    const write = this.writeQueue.then(async () => {
      const next: TaskStoreFile = {
        contract: COMPANYCLAW_TASK_STORE_CONTRACT,
        records: update(this.inspect().records),
      };
      await this.writeFile(this.filePath, JSON.stringify(next, null, 2));
    });
    this.writeQueue = write.catch(() => undefined);
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
```

> 注：`enqueueWrite` 是同步排队、异步落盘；测试用 `await instance.writeQueue` 不可见，因此测试断言写入内容时依赖 `store()` 注入的同步 `writeFile` 在 microtask 内完成。若断言时序不稳，在测试中改为 `await vi.waitFor(() => expect(writes.length).toBe(1))`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/tasks/task-store.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/tasks/
git commit -m "feat(companyclaw): persist tasks with owner isolation and idempotency keys"
```

---

## Task 3: R0–R3 风险分级

**Files:**
- Create: `desktop/src/companyclaw/policy/risk-classifier.ts`
- Test: `desktop/src/companyclaw/policy/risk-classifier.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type RiskLevel = "R0" | "R1" | "R2" | "R3"`
  - `type PolicyDecision = "allow" | "require-approval" | "deny"`
  - `interface ActionDescriptor`（`kind, toolName?, targetSystem?, recordId?, fields?, readOnlyProof?, writesBusinessData?, isHighRiskClass?`）
  - `classifyAction(action): { level: RiskLevel; reasons: string[] }`
  - `decideAction(action, context): { decision: PolicyDecision; level; reasons }`
  - `type RemoteAuthorizationState = "disabled" | "enabled" | "expired" | "revoked"`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/policy/risk-classifier.test.ts
import { describe, expect, it } from "vitest";
import { classifyAction, decideAction } from "./risk-classifier";

const authorized = { remoteAuthorization: "enabled" as const };

describe("classifyAction", () => {
  it("only classifies R0 when read-only is proven by a system-level signal", () => {
    const unproven = classifyAction({ kind: "read", toolName: "browser.snapshot" });
    expect(unproven.level).not.toBe("R0");
    expect(unproven.reasons.join(" ")).toMatch(/no system-level read-only proof/i);

    const proven = classifyAction({
      kind: "read",
      toolName: "browser.snapshot",
      readOnlyProof: "read-only-account",
    });
    expect(proven.level).toBe("R0");
  });

  it("never treats an unknown tool name as safe", () => {
    for (const toolName of ["Click", "Type", "Shortcut", "mystery.tool"]) {
      expect(classifyAction({ kind: "unknown", toolName }).level).toBe("R2");
    }
  });

  it("maps local non-writing work to R1", () => {
    expect(classifyAction({ kind: "local-work", toolName: "excel-xlsx" }).level).toBe("R1");
  });

  it("maps business writes to R2 and high-risk classes to R3", () => {
    expect(
      classifyAction({ kind: "write", toolName: "browser.click", writesBusinessData: true }).level,
    ).toBe("R2");
    expect(classifyAction({ kind: "high-risk", toolName: "exec" }).level).toBe("R3");
  });

  it("classifies R3 by class, not by tool name", () => {
    expect(classifyAction({ kind: "delete" }).level).toBe("R3");
    expect(classifyAction({ kind: "payment" }).level).toBe("R3");
    expect(classifyAction({ kind: "publish" }).level).toBe("R3");
    expect(classifyAction({ kind: "system-config" }).level).toBe("R3");
    expect(classifyAction({ kind: "registry" }).level).toBe("R3");
    expect(classifyAction({ kind: "arbitrary-command" }).level).toBe("R3");
    expect(classifyAction({ kind: "unknown-program" }).level).toBe("R3");
    expect(classifyAction({ kind: "bypass-security" }).level).toBe("R3");
  });
});

describe("decideAction", () => {
  it("allows R0 and R1 only when remote authorization is enabled", () => {
    const read = { kind: "read" as const, readOnlyProof: "read-only-acl" as const };
    expect(decideAction(read, authorized).decision).toBe("allow");
    expect(decideAction({ kind: "local-work" }, authorized).decision).toBe("allow");
    for (const state of ["disabled", "expired", "revoked"] as const) {
      expect(decideAction(read, { remoteAuthorization: state }).decision).toBe("deny");
    }
  });

  it("requires approval for R2 regardless of authorization", () => {
    expect(decideAction({ kind: "write" }, authorized).decision).toBe("require-approval");
  });

  it("always denies R3, with no override path", () => {
    for (const kind of ["delete", "payment", "publish", "system-config"] as const) {
      expect(decideAction({ kind }, authorized).decision).toBe("deny");
    }
  });

  it("denies a write whose final commit cannot be intercepted", () => {
    const result = decideAction(
      { kind: "write", writesBusinessData: true, commitInterceptable: false },
      authorized,
    );
    expect(result.decision).toBe("deny");
    expect(result.reasons.join(" ")).toMatch(/cannot be intercepted/i);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/policy/risk-classifier.test.ts`
Expected: FAIL — cannot resolve `./risk-classifier`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/policy/risk-classifier.ts
export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type PolicyDecision = "allow" | "require-approval" | "deny";
export type RemoteAuthorizationState = "disabled" | "enabled" | "expired" | "revoked";

export type ReadOnlyProof =
  | "read-only-account"
  | "read-only-acl"
  | "verified-no-side-effect-action-set";

export type ActionKind =
  | "read"
  | "local-work"
  | "write"
  | "unknown"
  | "high-risk"
  | "delete"
  | "payment"
  | "publish"
  | "system-config"
  | "registry"
  | "arbitrary-command"
  | "unknown-program"
  | "bypass-security";

export interface ActionDescriptor {
  kind: ActionKind;
  toolName?: string;
  targetSystem?: string;
  recordId?: string;
  fields?: { field: string; oldValue: string | null; newValue: string | null }[];
  /** System-level evidence that the action cannot produce a business side effect. */
  readOnlyProof?: ReadOnlyProof;
  writesBusinessData?: boolean;
  /** Whether the executor can reliably intercept the final commit. */
  commitInterceptable?: boolean;
}

export interface PolicyContext {
  remoteAuthorization: RemoteAuthorizationState;
}

export interface Classification {
  level: RiskLevel;
  reasons: string[];
}

const R3_KINDS: readonly ActionKind[] = [
  "delete",
  "payment",
  "publish",
  "system-config",
  "registry",
  "arbitrary-command",
  "unknown-program",
  "bypass-security",
  "high-risk",
];

export function classifyAction(action: ActionDescriptor): Classification {
  if (R3_KINDS.includes(action.kind)) {
    return {
      level: "R3",
      reasons: [
        `${action.kind} is an R3 class action: remote mode forbids it by policy, regardless of tool name`,
      ],
    };
  }

  if (action.kind === "read") {
    if (action.readOnlyProof) {
      return { level: "R0", reasons: [`read-only proven by ${action.readOnlyProof}`] };
    }
    return {
      level: "R2",
      reasons: [
        "no system-level read-only proof; an unproven read must not be treated as R0",
      ],
    };
  }

  if (action.kind === "local-work") {
    return { level: "R1", reasons: ["local non-writing work inside the authorized scope"] };
  }

  // write / unknown: only an explicitly declared business write is R2; everything
  // else (including an unrecognized tool name) also falls back to R2, because a
  // tool name alone can never prove safety.
  return {
    level: "R2",
    reasons: [
      action.writesBusinessData
        ? "declared business write"
        : `unsupported or unknown action kind "${action.kind}" is treated as a business write`,
    ],
  };
}

export function decideAction(
  action: ActionDescriptor,
  context: PolicyContext,
): Classification & { decision: PolicyDecision } {
  const classification = classifyAction(action);

  if (classification.level === "R3") {
    return { ...classification, decision: "deny" };
  }

  if (context.remoteAuthorization !== "enabled") {
    return {
      ...classification,
      decision: "deny",
      reasons: [...classification.reasons, `remote authorization is ${context.remoteAuthorization}`],
    };
  }

  if (classification.level === "R0" || classification.level === "R1") {
    return { ...classification, decision: "allow" };
  }

  if (action.commitInterceptable === false) {
    return {
      ...classification,
      decision: "deny",
      reasons: [
        ...classification.reasons,
        "the final write cannot be intercepted by the execution layer",
      ],
    };
  }

  return { ...classification, decision: "require-approval" };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/policy/risk-classifier.test.ts`
Expected: PASS — 9 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/policy/
git commit -m "feat(companyclaw): classify remote actions into R0-R3 with fail-closed defaults"
```

---

## Task 4: 一次性审批票据

**Files:**
- Create: `desktop/src/companyclaw/policy/approval-ticket.ts`
- Test: `desktop/src/companyclaw/policy/approval-ticket.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `COMPANYCLAW_APPROVAL_TICKET_CONTRACT = "companyclaw.approval-ticket.v1"`
  - `interface ApprovalBinding`（`ownerSid, deviceId, taskId, stepId, actionType, targetSystem, recordId, field, oldValue, newValue, canonicalPayloadHash`）
  - `canonicalizeBinding(binding): string` 与 `hashBinding(binding): string`（sha256 hex）
  - `issueApprovalTicket({ binding, secret, ttlMs, now, createNonce }): ApprovalTicket`
  - `verifyApprovalTicket({ ticket, binding, secret, now, consumedNonces }): { ok: true } | { ok: false; reason: TicketRejection }`
  - `type TicketRejection = "malformed" | "binding-mismatch" | "bad-signature" | "expired" | "already-consumed" | "not-yet-valid"`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/policy/approval-ticket.test.ts
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
  canonicalPayloadHash: hashBinding(
    {
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
    },
  ),
};

const now = () => new Date("2026-10-08T00:00:00.000Z");

describe("approval tickets", () => {
  it("canonicalizes deterministically regardless of key order", () => {
    const a = canonicalizeBinding(binding);
    const b = canonicalizeBinding({ ...binding, newValue: "张三" });
    expect(a).toBe(b);
    expect(a).toContain("task-1");
  });

  it("accepts a freshly issued ticket exactly once", () => {
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const consumed = new Set<string>();
    expect(verifyApprovalTicket({ ticket, binding, secret, now, consumedNonces: consumed })).toEqual(
      { ok: true },
    );
  });

  it("rejects a ticket for a different binding", () => {
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const other = { ...binding, newValue: "王五" };
    const result = verifyApprovalTicket({
      ticket,
      binding: other,
      secret,
      now,
      consumedNonces: new Set(),
    });
    expect(result).toEqual({ ok: false, reason: "binding-mismatch" });
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
    const later = () => new Date("2026-10-08T00:01:00.000Z");
    expect(
      verifyApprovalTicket({
        ticket: issued,
        binding,
        secret,
        now: later,
        consumedNonces: new Set(),
      }),
    ).toEqual({ ok: false, reason: "expired" });
    const future = () => new Date("2026-10-07T23:59:00.000Z");
    expect(
      verifyApprovalTicket({
        ticket: issued,
        binding,
        secret,
        now: future,
        consumedNonces: new Set(),
      }),
    ).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  it("rejects a replayed ticket whose nonce was consumed", () => {
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const consumed = new Set<string>([ticket.nonce]);
    expect(verifyApprovalTicket({ ticket, binding, secret, now, consumedNonces: consumed })).toEqual(
      { ok: false, reason: "already-consumed" },
    );
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/policy/approval-ticket.test.ts`
Expected: FAIL — cannot resolve `./approval-ticket`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/policy/approval-ticket.ts
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const COMPANYCLAW_APPROVAL_TICKET_CONTRACT = "companyclaw.approval-ticket.v1";

export interface ApprovalBinding {
  ownerSid: string;
  deviceId: string;
  taskId: string;
  stepId: string;
  actionType: string;
  targetSystem: string;
  recordId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  canonicalPayloadHash: string;
}

export interface ApprovalTicket {
  contract: typeof COMPANYCLAW_APPROVAL_TICKET_CONTRACT;
  nonce: string;
  bindingHash: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export type TicketRejection =
  | "malformed"
  | "binding-mismatch"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "already-consumed";

const BINDING_FIELDS: readonly (keyof ApprovalBinding)[] = [
  "ownerSid",
  "deviceId",
  "taskId",
  "stepId",
  "actionType",
  "targetSystem",
  "recordId",
  "field",
  "oldValue",
  "newValue",
  "canonicalPayloadHash",
];

export function canonicalizeBinding(binding: ApprovalBinding): string {
  return BINDING_FIELDS.map((field) => {
    const value = binding[field];
    const normalized = value === null ? "\u0000null" : String(value);
    return `${field}=${normalized.length}:${normalized}`;
  }).join("\n");
}

export function hashBinding(binding: ApprovalBinding): string {
  return createHmac("sha256", "companyclaw.binding").update(canonicalizeBinding(binding)).digest("hex");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function signaturePayload(ticket: Omit<ApprovalTicket, "signature">): string {
  return [ticket.contract, ticket.nonce, ticket.bindingHash, ticket.issuedAt, ticket.expiresAt].join(
    "\n",
  );
}

export interface IssueApprovalTicketInput {
  binding: ApprovalBinding;
  secret: string;
  ttlMs: number;
  now?: () => Date;
  createNonce?: () => string;
}

export function issueApprovalTicket(input: IssueApprovalTicketInput): ApprovalTicket {
  const now = (input.now ?? (() => new Date()))();
  const unsigned: Omit<ApprovalTicket, "signature"> = {
    contract: COMPANYCLAW_APPROVAL_TICKET_CONTRACT,
    nonce: (input.createNonce ?? randomUUID)(),
    bindingHash: hashBinding(input.binding),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
  };
  return { ...unsigned, signature: sign(input.secret, signaturePayload(unsigned)) };
}

export interface VerifyApprovalTicketInput {
  ticket: ApprovalTicket;
  binding: ApprovalBinding;
  secret: string;
  now?: () => Date;
  consumedNonces: Set<string>;
}

export type TicketVerification = { ok: true } | { ok: false; reason: TicketRejection };

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyApprovalTicket(input: VerifyApprovalTicketInput): TicketVerification {
  const { ticket, binding, secret } = input;
  if (
    !ticket ||
    ticket.contract !== COMPANYCLAW_APPROVAL_TICKET_CONTRACT ||
    typeof ticket.nonce !== "string" ||
    ticket.nonce.length === 0 ||
    typeof ticket.bindingHash !== "string" ||
    typeof ticket.issuedAt !== "string" ||
    typeof ticket.expiresAt !== "string" ||
    typeof ticket.signature !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const unsigned: Omit<ApprovalTicket, "signature"> = {
    contract: ticket.contract,
    nonce: ticket.nonce,
    bindingHash: ticket.bindingHash,
    issuedAt: ticket.issuedAt,
    expiresAt: ticket.expiresAt,
  };
  if (!safeEqual(sign(secret, signaturePayload(unsigned)), ticket.signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  if (!safeEqual(hashBinding(binding), ticket.bindingHash)) {
    return { ok: false, reason: "binding-mismatch" };
  }

  const now = (input.now ?? (() => new Date()))().getTime();
  const issuedAt = Date.parse(ticket.issuedAt);
  const expiresAt = Date.parse(ticket.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }
  if (now < issuedAt) return { ok: false, reason: "not-yet-valid" };
  if (now >= expiresAt) return { ok: false, reason: "expired" };
  if (input.consumedNonces.has(ticket.nonce)) {
    return { ok: false, reason: "already-consumed" };
  }
  return { ok: true };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/policy/approval-ticket.test.ts`
Expected: PASS — 7 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/policy/
git commit -m "feat(companyclaw): issue and verify single-use bound approval tickets"
```

---

## Task 5: 审批生命周期

**Files:**
- Create: `desktop/src/companyclaw/approvals/approval-store.ts`
- Test: `desktop/src/companyclaw/approvals/approval-store.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `ApprovalBinding`、`hashBinding`
- Produces:
  - `COMPANYCLAW_APPROVALS_CONTRACT = "companyclaw.approvals.v1"`
  - `type ApprovalStatus = "pending" | "approved" | "denied" | "expired"`
  - `interface CompanyClawApprovalRecord`
  - `class CompanyClawApprovalStore`（`request()` / `resolve()` / `expireOverdue()` / `get()` / `listPending()` / `isConsumed()`）
  - `class ApprovalRejectionError extends Error`（`reason`）

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/approvals/approval-store.test.ts
import { describe, expect, it } from "vitest";
import {
  ApprovalRejectionError,
  CompanyClawApprovalStore,
} from "./approval-store";
import { hashBinding, type ApprovalBinding } from "../policy/approval-ticket";

const filePath = "C:\\State\\companyclaw\\approvals.json";
const binding: ApprovalBinding = {
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
  canonicalPayloadHash: hashBinding({
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
  }),
};

function store(initial: unknown = null, nowIso = "2026-10-08T00:00:00.000Z") {
  let contents = initial === null ? null : JSON.stringify(initial);
  const writes: string[] = [];
  const instance = new CompanyClawApprovalStore(filePath, {
    now: () => new Date(nowIso),
    createId: () => "approval-1",
    ttlMs: 120_000,
    secret: "unit-secret",
    existsFile: (t) => t === filePath && contents !== null,
    readFile: () => contents ?? "",
    writeFile: async (_t, next) => {
      writes.push(next);
      contents = next;
    },
  });
  return { instance, writes };
}

describe("CompanyClawApprovalStore", () => {
  it("creates a pending approval bound to the exact change", () => {
    const { instance } = store();
    const record = instance.request(binding);
    expect(record).toMatchObject({ approvalId: "approval-1", status: "pending" });
    expect(record.bindingHash).toBe(hashBinding(binding));
    expect(instance.listPending()).toHaveLength(1);
  });

  it("approves once and rejects a second resolve (no replay)", () => {
    const { instance } = store();
    instance.request(binding);
    const approved = instance.resolve("approval-1", "approved", "S-1");
    expect(approved.status).toBe("approved");
    expect(instance.isConsumed("approval-1")).toBe(true);
    expect(() => instance.resolve("approval-1", "approved", "S-1")).toThrow(ApprovalRejectionError);
    expect(() => instance.resolve("approval-1", "approved", "S-1")).toThrow(/already-consumed/);
  });

  it("refuses a decision from a different owner", () => {
    const { instance } = store();
    instance.request(binding);
    expect(() => instance.resolve("approval-1", "approved", "S-999")).toThrow(/owner-mismatch/);
  });

  it("denies execution after a denial", () => {
    const { instance } = store();
    instance.request(binding);
    instance.resolve("approval-1", "denied", "S-1");
    expect(instance.isConsumed("approval-1")).toBe(true);
    expect(instance.get("approval-1")?.status).toBe("denied");
  });

  it("expires overdue approvals and treats them as non-authorizing", () => {
    const { instance } = store(null, "2026-10-08T00:00:00.000Z");
    instance.request(binding);
    const later = new CompanyClawApprovalStore(filePath, {
      now: () => new Date("2026-10-08T01:00:00.000Z"),
      createId: () => "x",
      ttlMs: 120_000,
      secret: "unit-secret",
      existsFile: () => true,
      readFile: () => JSON.stringify(instance.inspectFile()),
      writeFile: async () => undefined,
    });
    const expired = later.expireOverdue();
    expect(expired).toBe(1);
    expect(later.get("approval-1")?.status).toBe("expired");
    expect(() => later.resolve("approval-1", "approved", "S-1")).toThrow(/expired/);
  });

  it("authorizes nothing when storage is malformed", () => {
    const { instance } = store("}{ not json");
    expect(instance.listPending()).toEqual([]);
    expect(instance.inspect().warning).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/approvals/approval-store.test.ts`
Expected: FAIL — cannot resolve `./approval-store`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/approvals/approval-store.ts
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
  | "expired"
  | "cancelled";

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

export class CompanyClawApprovalStore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly ttlMs: number;
  readonly secret: string;
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
    this.secret = dependencies.secret ?? "";
    this.existsFile = dependencies.existsFile ?? (() => false);
    this.readFile = dependencies.readFile ?? (() => "");
    this.writeFile = dependencies.writeFile ?? (async () => undefined);
  }

  inspect(): { records: CompanyClawApprovalRecord[]; warning: string | null } {
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
    if (typeof parsed !== "object" || parsed === null || file.contract !== COMPANYCLAW_APPROVALS_CONTRACT) {
      return { records: [], warning: "Legacy approval storage authorizes nothing" };
    }
    if (!Array.isArray(file.records)) {
      return { records: [], warning: "Approval storage has no records array" };
    }
    return { records: file.records.filter(isCurrentApprovalRecord), warning: null };
  }

  /** Raw envelope for tests and migration helpers. */
  inspectFile(): ApprovalStoreFile {
    return { contract: COMPANYCLAW_APPROVALS_CONTRACT, records: this.inspect().records };
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

  request(binding: ApprovalBinding): CompanyClawApprovalRecord {
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
    this.enqueueWrite((records) => [...records, record]);
    return record;
  }

  resolve(
    approvalId: string,
    decision: "approved" | "denied",
    resolvedBy: string,
  ): CompanyClawApprovalRecord {
    const record = this.get(approvalId);
    if (!record) throw new ApprovalRejectionError("unknown-approval", approvalId);
    if (record.status !== "pending") {
      throw new ApprovalRejectionError("already-consumed", approvalId);
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
    this.enqueueWrite((records) =>
      records.map((entry) => (entry.approvalId === approvalId ? next : entry)),
    );
    return next;
  }

  /** Marks overdue pending approvals as expired. Returns the number changed. */
  expireOverdue(): number {
    const now = this.now().getTime();
    const records = this.inspect().records;
    const overdue = records.filter(
      (r) => r.status === "pending" && Date.parse(r.expiresAt) <= now,
    );
    if (overdue.length === 0) return 0;
    const expiredIds = new Set(overdue.map((r) => r.approvalId));
    this.enqueueWrite((current) =>
      current.map((entry) =>
        expiredIds.has(entry.approvalId) && entry.status === "pending"
          ? { ...entry, status: "expired" as const, resolvedAt: this.now().toISOString() }
          : entry,
      ),
    );
    return overdue.length;
  }

  private enqueueWrite(
    update: (current: CompanyClawApprovalRecord[]) => CompanyClawApprovalRecord[],
  ): void {
    const write = this.writeQueue.then(async () => {
      const next: ApprovalStoreFile = {
        contract: COMPANYCLAW_APPROVALS_CONTRACT,
        records: update(this.inspect().records),
      };
      await this.writeFile(this.filePath, JSON.stringify(next, null, 2));
    });
    this.writeQueue = write.catch(() => undefined);
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/approvals/approval-store.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/approvals/
git commit -m "feat(companyclaw): track approval lifecycle with single-use resolution"
```

---

## Task 6: 执行桥（失败关闭）

**Files:**
- Create: `desktop/src/companyclaw/bridge/execution-bridge.ts`
- Test: `desktop/src/companyclaw/bridge/execution-bridge.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `decideAction` / `PolicyContext` / `ActionDescriptor`；Task 4 的 `verifyApprovalTicket`
- Produces:
  - `interface ExecutionBridgeTransport { send(request: BridgeRequest): Promise<BridgeResponse> }`
  - `interface BridgeRequest`（`taskId, stepId, action, approvalTicket?, binding?`）
  - `type BridgeResponse = { status: "ok"; detail: string } | { status: "rejected"; reason: string } | { status: "unavailable"; reason: string }`
  - `class ExecutionBridge`（`constructor(transport, options: { policyContext: () => PolicyContext; secret: string; now?: () => Date; consumedNonces: Set<string> })`，方法 `execute(request): Promise<BridgeResult>`）
  - `type BridgeResult = { outcome: "executed"; detail: string } | { outcome: "denied"; reason: string } | { outcome: "unavailable"; reason: string }`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/bridge/execution-bridge.test.ts
import { describe, expect, it, vi } from "vitest";
import { ExecutionBridge } from "./execution-bridge";
import {
  hashBinding,
  issueApprovalTicket,
  type ApprovalBinding,
} from "../policy/approval-ticket";

const secret = "bridge-secret";
const now = () => new Date("2026-10-08T00:00:00.000Z");
const binding: ApprovalBinding = {
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
  canonicalPayloadHash: hashBinding({
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
  }),
};

function bridge(options: {
  transport?: { send: (r: unknown) => Promise<never> };
  authorization?: "disabled" | "enabled";
  consumed?: Set<string>;
}) {
  const send =
    options.transport?.send ?? vi.fn(async () => ({ status: "ok" as const, detail: "done" }));
  const bridge = new ExecutionBridge(send as never, {
    policyContext: () => ({ remoteAuthorization: options.authorization ?? "enabled" }),
    secret,
    now,
    consumedNonces: options.consumed ?? new Set<string>(),
  });
  return { bridge, send };
}

describe("ExecutionBridge", () => {
  it("executes an approved write once", async () => {
    const { bridge, send } = bridge({});
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    expect(result).toEqual({ outcome: "executed", detail: "done" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses to reach the transport when the ticket is missing for R2", async () => {
    const { bridge, send } = bridge({});
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
    });
    expect(result.outcome).toBe("denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a replayed ticket without a second transport call", async () => {
    const consumed = new Set<string>();
    const { bridge, send } = bridge({ consumed });
    const ticket = issueApprovalTicket({ binding, secret, ttlMs: 60_000, now });
    await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    consumed.add(ticket.nonce);
    const replay = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    expect(replay).toMatchObject({ outcome: "denied" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never forwards an R3 action", async () => {
    const { bridge, send } = bridge({});
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "payment" },
    });
    expect(result.outcome).toBe("denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when remote authorization is off", async () => {
    const { bridge, send } = bridge({ authorization: "disabled" });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "local-work" },
    });
    expect(result.outcome).toBe("denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports unavailable instead of succeeding when the transport throws", async () => {
    const failing = {
      send: vi.fn(async () => {
        throw new Error("broker offline");
      }),
    };
    const bridge = new ExecutionBridge(failing as never, {
      policyContext: () => ({ remoteAuthorization: "enabled" }),
      secret,
      now,
      consumedNonces: new Set<string>(),
    });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "local-work" },
    });
    expect(result).toEqual({ outcome: "unavailable", reason: "broker offline" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/bridge/execution-bridge.test.ts`
Expected: FAIL — cannot resolve `./execution-bridge`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/bridge/execution-bridge.ts
import {
  decideAction,
  type ActionDescriptor,
  type PolicyContext,
} from "../policy/risk-classifier";
import {
  verifyApprovalTicket,
  type ApprovalBinding,
  type ApprovalTicket,
} from "../policy/approval-ticket";

export interface BridgeRequest {
  taskId: string;
  stepId: string;
  action: ActionDescriptor;
  approvalTicket?: ApprovalTicket;
  binding?: ApprovalBinding;
}

export type BridgeResponse =
  | { status: "ok"; detail: string }
  | { status: "rejected"; reason: string }
  | { status: "unavailable"; reason: string };

export type BridgeTransport = (request: BridgeRequest) => Promise<BridgeResponse>;

export type BridgeResult =
  | { outcome: "executed"; detail: string }
  | { outcome: "denied"; reason: string }
  | { outcome: "unavailable"; reason: string };

interface ExecutionBridgeOptions {
  policyContext: () => PolicyContext;
  secret: string;
  now?: () => Date;
  consumedNonces: Set<string>;
}

/**
 * The only path from a planned action to the execution layer. It applies the
 * R0-R3 decision *before* the transport is reached, and fails closed on every
 * uncertainty (missing ticket, replay, unusable transport).
 */
export class ExecutionBridge {
  private readonly now: () => Date;

  constructor(
    private readonly transport: BridgeTransport,
    private readonly options: ExecutionBridgeOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(request: BridgeRequest): Promise<BridgeResult> {
    const decision = decideAction(request.action, this.options.policyContext());
    if (decision.decision === "deny") {
      return { outcome: "denied", reason: decision.reasons.join("; ") };
    }

    if (decision.decision === "require-approval") {
      if (!request.approvalTicket || !request.binding) {
        return { outcome: "denied", reason: "approval ticket and binding are required" };
      }
      const verification = verifyApprovalTicket({
        ticket: request.approvalTicket,
        binding: request.binding,
        secret: this.options.secret,
        now: this.now,
        consumedNonces: this.options.consumedNonces,
      });
      if (!verification.ok) {
        return { outcome: "denied", reason: `approval ${verification.reason}` };
      }
      // Consume before dispatch so a crash cannot be replayed.
      this.options.consumedNonces.add(request.approvalTicket.nonce);
    }

    try {
      const response = await this.transport(request);
      if (response.status === "ok") return { outcome: "executed", detail: response.detail };
      if (response.status === "unavailable") {
        return { outcome: "unavailable", reason: response.reason };
      }
      return { outcome: "denied", reason: response.reason };
    } catch (error) {
      return {
        outcome: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/bridge/execution-bridge.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/bridge/
git commit -m "feat(companyclaw): gate every action through a fail-closed execution bridge"
```

---

## Task 7: 产物校验

**Files:**
- Create: `desktop/src/companyclaw/results/artifact-validator.ts`
- Test: `desktop/src/companyclaw/results/artifact-validator.test.ts`

**Interfaces:**
- Consumes: 无（仅 `node:fs/promises`）
- Produces:
  - `interface ArtifactValidationInput { filePath: string; allowedExtensions?: readonly string[]; maxBytes?: number }`
  - `type ArtifactRejectionReason = "not-found" | "not-a-file" | "empty" | "too-large" | "extension-not-allowed" | "mime-mismatch" | "not-a-zip-container" | "unreadable"`
  - `type ArtifactValidation = { ok: true; size: number; detectedMime: string } | { ok: false; reason: ArtifactRejectionReason }`
  - `validateArtifact(input): Promise<ArtifactValidation>`
  - `detectMime(read: (length: number) => Promise<Buffer>): Promise<string>`（魔数探测）
  - `DEFAULT_ALLOWED_EXTENSIONS`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/results/artifact-validator.test.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectMime, validateArtifact } from "./artifact-validator";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "companyclaw-artifacts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function xlsxBytes(): Buffer {
  // Minimal ZIP local file header signature + filler.
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]).fill(0, 4);
}

describe("detectMime", () => {
  it("detects real containers by magic number instead of extension", async () => {
    await expect(detectMime(async () => Buffer.from("%PDF-1.7", "utf8"))).resolves.toBe(
      "application/pdf",
    );
    await expect(detectMime(async () => xlsxBytes())).resolves.toBe(
      "application/zip-container",
    );
    await expect(detectMime(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]))).resolves.toBe(
      "image/png",
    );
    await expect(detectMime(async () => Buffer.from("plain text", "utf8"))).resolves.toBe(
      "application/octet-stream",
    );
  });
});

describe("validateArtifact", () => {
  it("accepts a well-formed xlsx by container checks, not extension", async () => {
    const filePath = path.join(dir, "report.xlsx");
    await writeFile(filePath, xlsxBytes());
    const result = await validateArtifact({ filePath });
    expect(result).toMatchObject({ ok: true, detectedMime: "application/zip-container" });
  });

  it("rejects a file whose extension claims xlsx but whose bytes are text", async () => {
    const filePath = path.join(dir, "fake.xlsx");
    await writeFile(filePath, "this is not a workbook");
    const result = await validateArtifact({ filePath });
    expect(result).toEqual({ ok: false, reason: "mime-mismatch" });
  });

  it("rejects missing, empty, oversized and disallowed files", async () => {
    expect(await validateArtifact({ filePath: path.join(dir, "nope.pdf") })).toEqual({
      ok: false,
      reason: "not-found",
    });

    const empty = path.join(dir, "empty.pdf");
    await writeFile(empty, "");
    expect(await validateArtifact({ filePath: empty })).toEqual({ ok: false, reason: "empty" });

    const big = path.join(dir, "big.pdf");
    await writeFile(big, Buffer.alloc(32));
    expect(await validateArtifact({ filePath: big, maxBytes: 8 })).toEqual({
      ok: false,
      reason: "too-large",
    });

    const exe = path.join(dir, "tool.exe");
    await writeFile(exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    expect(await validateArtifact({ filePath: exe })).toEqual({
      ok: false,
      reason: "extension-not-allowed",
    });
  });

  it("rejects a directory", async () => {
    expect(await validateArtifact({ filePath: dir })).toEqual({ ok: false, reason: "not-a-file" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/results/artifact-validator.test.ts`
Expected: FAIL — cannot resolve `./artifact-validator`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/results/artifact-validator.ts
import { open, stat } from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_ALLOWED_EXTENSIONS = [
  ".xlsx",
  ".xls",
  ".csv",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".pdf",
  ".txt",
  ".md",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
] as const;

export type ArtifactRejectionReason =
  | "not-found"
  | "not-a-file"
  | "empty"
  | "too-large"
  | "extension-not-allowed"
  | "mime-mismatch"
  | "not-a-zip-container"
  | "unreadable";

export type ArtifactValidation =
  | { ok: true; size: number; detectedMime: string }
  | { ok: false; reason: ArtifactRejectionReason };

const ZIP_EXTENSIONS = new Set([".xlsx", ".docx", ".pptx"]);

/** Magic-number detection. Reads bytes, never trusts the extension. */
export async function detectMime(read: (length: number) => Promise<Buffer>): Promise<string> {
  const head = await read(8);
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
    return "application/pdf";
  }
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return "application/zip-container";
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (head.length >= 3 && head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "GIF8") {
    return "image/gif";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "RIFF") {
    return "application/riff";
  }
  if (head.length >= 2 && head.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))) {
    return "application/x-msdownload";
  }
  return "application/octet-stream";
}

export interface ArtifactValidationInput {
  filePath: string;
  allowedExtensions?: readonly string[];
  maxBytes?: number;
}

export async function validateArtifact(
  input: ArtifactValidationInput,
): Promise<ArtifactValidation> {
  const allowed = input.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  const extension = path.extname(input.filePath).toLowerCase();
  if (!allowed.includes(extension)) {
    return { ok: false, reason: "extension-not-allowed" };
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(input.filePath);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (!info.isFile()) return { ok: false, reason: "not-a-file" };
  if (info.size === 0) return { ok: false, reason: "empty" };
  if (input.maxBytes !== undefined && info.size > input.maxBytes) {
    return { ok: false, reason: "too-large" };
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(input.filePath, "r");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const detectedMime = await detectMime(async (length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    });

    if (ZIP_EXTENSIONS.has(extension) && detectedMime !== "application/zip-container") {
      // An .xlsx/.docx/.pptx that is not a ZIP container cannot be a workbook
      // or document, regardless of the extension.
      return { ok: false, reason: detectedMime === "application/octet-stream" ? "mime-mismatch" : "not-a-zip-container" };
    }
    if (extension === ".pdf" && detectedMime !== "application/pdf") {
      return { ok: false, reason: "mime-mismatch" };
    }
    if (
      [".png", ".jpg", ".jpeg", ".gif"].includes(extension) &&
      !detectedMime.startsWith("image/")
    ) {
      return { ok: false, reason: "mime-mismatch" };
    }
    return { ok: true, size: info.size, detectedMime };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/results/artifact-validator.test.ts`
Expected: PASS — 5 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/results/
git commit -m "feat(companyclaw): validate artifacts by magic number and container structure"
```

---

## Task 8: 送达状态机

**Files:**
- Create: `desktop/src/companyclaw/results/delivery-status.ts`
- Test: `desktop/src/companyclaw/results/delivery-status.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DELIVERY_STATES = ["SEND_REQUESTED","SENT","DELIVERED","FAILED","UNKNOWN"]`
  - `type DeliveryState`
  - `DELIVERY_TERMINAL_STATES`
  - `canAdvanceDelivery(from, to): boolean`
  - `assertDeliveryAdvance(from, to): void`
  - `type SendOutcome = { platform: "accepted" } | { platform: "failed"; reason: string } | { platform: "indeterminate"; reason: string }`
  - `advanceDelivery(from: "SEND_REQUESTED", outcome: SendOutcome): DeliveryState`
  - `advanceWithReceipt(from: DeliveryState, receipt: "terminal-confirmed" | "none"): DeliveryState`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/results/delivery-status.test.ts
import { describe, expect, it } from "vitest";
import {
  advanceDelivery,
  advanceWithReceipt,
  canAdvanceDelivery,
  DELIVERY_TERMINAL_STATES,
} from "./delivery-status";

describe("delivery status", () => {
  it("treats SENT as platform acceptance, not delivery", () => {
    expect(advanceDelivery("SEND_REQUESTED", { platform: "accepted" })).toBe("SENT");
  });

  it("maps an explicit platform failure to FAILED", () => {
    expect(advanceDelivery("SEND_REQUESTED", { platform: "failed", reason: "403" })).toBe("FAILED");
  });

  it("maps an indeterminate result to UNKNOWN instead of guessing", () => {
    expect(advanceDelivery("SEND_REQUESTED", { platform: "indeterminate", reason: "timeout" })).toBe(
      "UNKNOWN",
    );
  });

  it("requires evidence to reach DELIVERED", () => {
    expect(advanceWithReceipt("SENT", "none")).toBe("SENT");
    expect(advanceWithReceipt("SENT", "terminal-confirmed")).toBe("DELIVERED");
    // An unconfirmed send must never silently upgrade itself.
    expect(advanceWithReceipt("UNKNOWN", "none")).toBe("UNKNOWN");
  });

  it("allows SENT/UNKNOWN/FAILED to be retried and keeps terminal states frozen", () => {
    expect(canAdvanceDelivery("SENT", "SEND_REQUESTED")).toBe(true);
    expect(canAdvanceDelivery("UNKNOWN", "SEND_REQUESTED")).toBe(true);
    expect(canAdvanceDelivery("FAILED", "SEND_REQUESTED")).toBe(true);
    for (const terminal of DELIVERY_TERMINAL_STATES) {
      expect(canAdvanceDelivery(terminal, "SEND_REQUESTED")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/results/delivery-status.test.ts`
Expected: FAIL — cannot resolve `./delivery-status`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/results/delivery-status.ts
export const DELIVERY_STATES = [
  "SEND_REQUESTED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "UNKNOWN",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_TERMINAL_STATES = ["DELIVERED"] as const satisfies readonly DeliveryState[];

const ALLOWED: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  SEND_REQUESTED: ["SENT", "FAILED", "UNKNOWN"],
  SENT: ["DELIVERED", "FAILED", "UNKNOWN", "SEND_REQUESTED"],
  DELIVERED: [],
  FAILED: ["SEND_REQUESTED"],
  UNKNOWN: ["DELIVERED", "FAILED", "SEND_REQUESTED"],
};

export function canAdvanceDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertDeliveryAdvance(from: DeliveryState, to: DeliveryState): void {
  if (!canAdvanceDelivery(from, to)) {
    throw new Error(`Illegal delivery transition: ${from} -> ${to}`);
  }
}

export type SendOutcome =
  | { platform: "accepted" }
  | { platform: "failed"; reason: string }
  | { platform: "indeterminate"; reason: string };

/** Platform acceptance is never delivery: `accepted` can only reach SENT. */
export function advanceDelivery(_from: "SEND_REQUESTED", outcome: SendOutcome): DeliveryState {
  switch (outcome.platform) {
    case "accepted":
      return "SENT";
    case "failed":
      return "FAILED";
    case "indeterminate":
      return "UNKNOWN";
  }
}

/**
 * Only an explicit terminal receipt may promote a send to DELIVERED. Without a
 * reliable receipt the state stays as-is, so `SENT` never silently becomes
 * `DELIVERED`.
 */
export function advanceWithReceipt(
  from: DeliveryState,
  receipt: "terminal-confirmed" | "none",
): DeliveryState {
  if (receipt === "terminal-confirmed" && canAdvanceDelivery(from, "DELIVERED")) {
    return "DELIVERED";
  }
  return from;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/results/delivery-status.test.ts`
Expected: PASS — 5 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/results/
git commit -m "feat(companyclaw): separate platform acceptance from proven delivery"
```

---

## Task 9: 远程操作授权

**Files:**
- Create: `desktop/src/companyclaw/remote/remote-authorization.ts`
- Test: `desktop/src/companyclaw/remote/remote-authorization.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `RemoteAuthorizationState`
- Produces:
  - `COMPANYCLAW_REMOTE_AUTH_CONTRACT = "companyclaw.remote-authorization.v1"`
  - `interface RemoteAuthorizationRecord`（`enabled, ownerSid, deviceId, channelUserId, grantedAt, expiresAt, revokedAt`）
  - `class RemoteAuthorization`（`constructor(deps)`；`setEnabled({ownerSid, deviceId, channelUserId, ttlMs})` / `revoke()` / `state(now?)` / `snapshot()`）
  - `bindSessionSource(source): SessionSource | null`（可信元数据，**不接受用户文本**）

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/companyclaw/remote/remote-authorization.test.ts
import { describe, expect, it } from "vitest";
import { bindSessionSource, RemoteAuthorization } from "./remote-authorization";

describe("RemoteAuthorization", () => {
  it("is disabled by default (fail-safe)", () => {
    const auth = new RemoteAuthorization({ now: () => new Date("2026-10-08T00:00:00Z") });
    expect(auth.state()).toBe("disabled");
  });

  it("becomes enabled after an explicit local grant, then expires", () => {
    let current = new Date("2026-10-08T00:00:00Z");
    const auth = new RemoteAuthorization({ now: () => current });
    auth.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx-1", ttlMs: 60_000 });
    expect(auth.state()).toBe("enabled");

    current = new Date("2026-10-08T00:01:00Z");
    expect(auth.state()).toBe("expired");
  });

  it("stays revoked even before the recorded expiry", () => {
    const auth = new RemoteAuthorization({ now: () => new Date("2026-10-08T00:00:00Z") });
    auth.setEnabled({ ownerSid: "S-1", deviceId: "d", channelUserId: "wx-1", ttlMs: 600_000 });
    auth.revoke();
    expect(auth.state()).toBe("revoked");
  });
});

describe("bindSessionSource", () => {
  it("accepts trusted channel metadata", () => {
    expect(
      bindSessionSource({
        channelType: "openclaw-weixin",
        userId: "wx-1",
        messageId: "m-1",
        deviceId: "d",
      }),
    ).toEqual({
      channelType: "openclaw-weixin",
      userId: "wx-1",
      messageId: "m-1",
      deviceId: "d",
    });
  });

  it("refuses a source that claims an identity without channel metadata", () => {
    expect(bindSessionSource({ channelType: "", userId: "wx-1" })).toBeNull();
    expect(bindSessionSource({ channelType: "local", userId: "" })).toBeNull();
  });

  it("refuses any attempt to declare the source from user text", () => {
    // A prompt claiming to be WeChat is still not WeChat.
    expect(
      bindSessionSource({ channelType: "local", userId: "wx-1", declaredBy: "user-text" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/companyclaw/remote/remote-authorization.test.ts`
Expected: FAIL — cannot resolve `./remote-authorization`

- [ ] **Step 3: 实现**

```ts
// desktop/src/companyclaw/remote/remote-authorization.ts
import type { RemoteAuthorizationState } from "../policy/risk-classifier";

export const COMPANYCLAW_REMOTE_AUTH_CONTRACT = "companyclaw.remote-authorization.v1";

export interface RemoteAuthorizationRecord {
  contract: typeof COMPANYCLAW_REMOTE_AUTH_CONTRACT;
  enabled: boolean;
  ownerSid: string;
  deviceId: string;
  channelUserId: string;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface SessionSource {
  channelType: string;
  userId: string;
  messageId?: string;
  deviceId?: string;
}

export interface SetEnabledInput {
  ownerSid: string;
  deviceId: string;
  channelUserId: string;
  ttlMs: number;
}

interface RemoteAuthorizationDependencies {
  now?: () => Date;
  write?: (record: RemoteAuthorizationRecord) => Promise<void>;
}

export class RemoteAuthorization {
  private readonly now: () => Date;
  private readonly write: (record: RemoteAuthorizationRecord) => Promise<void>;
  private record: RemoteAuthorizationRecord;

  constructor(dependencies: RemoteAuthorizationDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.write = dependencies.write ?? (async () => undefined);
    this.record = {
      contract: COMPANYCLAW_REMOTE_AUTH_CONTRACT,
      enabled: false,
      ownerSid: "",
      deviceId: "",
      channelUserId: "",
      grantedAt: null,
      expiresAt: null,
      revokedAt: null,
    };
  }

  snapshot(): RemoteAuthorizationRecord {
    return { ...this.record };
  }

  state(at: Date = this.now()): RemoteAuthorizationState {
    if (this.record.revokedAt) return "revoked";
    if (!this.record.enabled || !this.record.expiresAt) return "disabled";
    if (Date.parse(this.record.expiresAt) <= at.getTime()) return "expired";
    return "enabled";
  }

  setEnabled(input: SetEnabledInput): RemoteAuthorizationRecord {
    const now = this.now();
    this.record = {
      ...this.record,
      enabled: true,
      ownerSid: input.ownerSid,
      deviceId: input.deviceId,
      channelUserId: input.channelUserId,
      grantedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      revokedAt: null,
    };
    void this.write(this.record);
    return this.snapshot();
  }

  revoke(): RemoteAuthorizationRecord {
    this.record = {
      ...this.record,
      enabled: false,
      revokedAt: this.now().toISOString(),
    };
    void this.write(this.record);
    return this.snapshot();
  }
}

/**
 * Session provenance must come from trusted channel metadata. A source is only
 * accepted when the transport itself supplied both a channel type and a user
 * id; user-authored text can never declare its own provenance.
 */
export function bindSessionSource(
  raw: {
    channelType?: string;
    userId?: string;
    messageId?: string;
    deviceId?: string;
    declaredBy?: string;
  } | null,
): SessionSource | null {
  if (!raw) return null;
  if (raw.declaredBy === "user-text") return null;
  const channelType = (raw.channelType ?? "").trim();
  const userId = (raw.userId ?? "").trim();
  if (!channelType || channelType === "local") return null;
  if (!userId) return null;
  return {
    channelType,
    userId,
    ...(raw.messageId ? { messageId: raw.messageId } : {}),
    ...(raw.deviceId ? { deviceId: raw.deviceId } : {}),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && npx vitest run src/companyclaw/remote/remote-authorization.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: 提交**

```bash
git add desktop/src/companyclaw/remote/
git commit -m "feat(companyclaw): add fail-safe remote authorization and trusted session provenance"
```

---

## Task 10: 组合验证与文档

**Files:**
- Create: `desktop/src/companyclaw/companyclaw-core.test.ts`
- Create: `docs/companyclaw/IMPLEMENTATION_STATUS.md`
- Create: `docs/companyclaw/ADR/0001-security-core-modules.md`

**Interfaces:**
- Consumes: 上述全部模块
- Produces: 端到端（逻辑层）证据

- [ ] **Step 1: 写组合测试（应直接通过，验证模块协同）**

```ts
// desktop/src/companyclaw/companyclaw-core.test.ts
import { describe, expect, it, vi } from "vitest";
import { CompanyClawTaskStore } from "./tasks/task-store";
import { CompanyClawApprovalStore } from "./approvals/approval-store";
import { ExecutionBridge } from "./bridge/execution-bridge";
import { RemoteAuthorization } from "./remote/remote-authorization";
import { issueApprovalTicket, hashBinding } from "./policy/approval-ticket";

const FILE = "C:\\State\\companyclaw\\combined.json";

function memoryFile() {
  let contents: string | null = null;
  return {
    existsFile: () => contents !== null,
    readFile: () => contents ?? "",
    writeFile: async (_t: string, next: string) => {
      contents = next;
    },
  };
}

describe("CompanyClaw security core", () => {
  it("walks one R2 business write from task creation to executed write", async () => {
    const io = memoryFile();
    const now = () => new Date("2026-10-08T00:00:00Z");
    const tasks = new CompanyClawTaskStore(FILE, { ...io, now, createId: () => "task-1" });
    const approvals = new CompanyClawApprovalStore(FILE, {
      ...io,
      now,
      ttlMs: 120_000,
      secret: "s3cret",
      createId: () => "approval-1",
    });
    const authorization = new RemoteAuthorization({ now });

    // 1. Remote operation is off until the local user grants it.
    expect(authorization.state()).toBe("disabled");

    // 2. A trusted WeChat message creates and authenticates the task.
    const task = tasks.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "把工单 WO-2026-0001 负责人改成张三",
    });
    tasks.advance(task.taskId, "AUTHENTICATED", {});

    // 3. The agent plans and reaches the write gate.
    tasks.advance(task.taskId, "PLANNING", {});
    tasks.advance(task.taskId, "RUNNING", {});
    authorization.setEnabled({
      ownerSid: "S-1",
      deviceId: "d",
      channelUserId: "wx-1",
      ttlMs: 3_600_000,
    });

    const binding = {
      ownerSid: "S-1",
      deviceId: "d",
      taskId: task.taskId,
      stepId: "step-1",
      actionType: "business-write",
      targetSystem: "工单系统",
      recordId: "WO-2026-0001",
      field: "owner",
      oldValue: "李四",
      newValue: "张三",
      canonicalPayloadHash: hashBinding({
        ownerSid: "S-1",
        deviceId: "d",
        taskId: task.taskId,
        stepId: "step-1",
        actionType: "business-write",
        targetSystem: "工单系统",
        recordId: "WO-2026-0001",
        field: "owner",
        oldValue: "李四",
        newValue: "张三",
        canonicalPayloadHash: "",
      }),
    };
    const approval = approvals.request(binding);
    tasks.advance(task.taskId, "AWAITING_APPROVAL", { approvalId: approval.approvalId });

    // 4. The owner approves on WeChat; the ticket is issued for the exact change.
    approvals.resolve(approval.approvalId, "approved", "S-1");
    const ticket = issueApprovalTicket({ binding, secret: "s3cret", ttlMs: 60_000, now });

    // 5. The bridge executes exactly once.
    const transport = vi.fn(async () => ({ status: "ok" as const, detail: "saved" }));
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: authorization.state() }),
      secret: "s3cret",
      now,
      consumedNonces: new Set<string>(),
    });
    const write = await bridge.execute({
      taskId: task.taskId,
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
      approvalTicket: ticket,
      binding,
    });
    expect(write).toEqual({ outcome: "executed", detail: "saved" });

    // 6. The task only completes after a verified read-back.
    tasks.advance(task.taskId, "VERIFYING", { executor: "broker" });
    const finished = tasks.advance(task.taskId, "COMPLETED", {
      resultSummary: "read-back matched 张三",
    });
    expect(finished.state).toBe("COMPLETED");
    expect(finished.terminalAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("refuses the same write when the owner never approves", async () => {
    const now = () => new Date("2026-10-08T00:00:00Z");
    const authorization = new RemoteAuthorization({ now });
    authorization.setEnabled({
      ownerSid: "S-1",
      deviceId: "d",
      channelUserId: "wx-1",
      ttlMs: 3_600_000,
    });
    const transport = vi.fn(async () => ({ status: "ok" as const, detail: "saved" }));
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: authorization.state() }),
      secret: "s3cret",
      now,
      consumedNonces: new Set(),
    });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "write", writesBusinessData: true },
    });
    expect(result.outcome).toBe("denied");
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps R3 blocked even with authorization enabled", async () => {
    const authorization = new RemoteAuthorization({
      now: () => new Date("2026-10-08T00:00:00Z"),
    });
    authorization.setEnabled({
      ownerSid: "S-1",
      deviceId: "d",
      channelUserId: "wx-1",
      ttlMs: 3_600_000,
    });
    const transport = vi.fn(async () => ({ status: "ok" as const, detail: "unexpected" }));
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: authorization.state() }),
      secret: "s3cret",
      consumedNonces: new Set(),
    });
    const result = await bridge.execute({
      taskId: "task-1",
      stepId: "step-1",
      action: { kind: "arbitrary-command", toolName: "exec" },
    });
    expect(result.outcome).toBe("denied");
    expect(transport).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行组合测试**

Run: `cd desktop && npx vitest run src/companyclaw/companyclaw-core.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 3: 写状态文档**

Create `docs/companyclaw/IMPLEMENTATION_STATUS.md`：

```markdown
# CompanyClaw Implementation Status

上游基线：`6f080a07f43bd65b8b27ec6f859438fc038bb912`（MicroClaw, 2026-09-11）
分支：`feat/companyclaw-foundation`

## 阶段状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0-A 基线 | PASS | 子测试基线：`npx vitest run`（desktop 44 文件 / 1143 通过）；修复上游遗留断言见 `f497085` |
| P0-B V4 Windows-MCP 评估 | NOT-STARTED | — |
| P0-B V2 Broker 通信选型 | NOT-STARTED | — |
| P0-C V1 最小真实链路 | BLOCKED | 需目标机 + 微信测试账号 |
| 安全内核（Task 1–10） | IN_PROGRESS | 见下表 |

## 安全内核模块

| 模块 | 状态 | 测试 |
|---|---|---|
| tasks/task-state | 见测试结果 | `src/companyclaw/tasks/task-state.test.ts` |
| tasks/task-store | 见测试结果 | `src/companyclaw/tasks/task-store.test.ts` |
| policy/risk-classifier | 见测试结果 | `src/companyclaw/policy/risk-classifier.test.ts` |
| policy/approval-ticket | 见测试结果 | `src/companyclaw/policy/approval-ticket.test.ts` |
| approvals/approval-store | 见测试结果 | `src/companyclaw/approvals/approval-store.test.ts` |
| bridge/execution-bridge | 见测试结果 | `src/companyclaw/bridge/execution-bridge.test.ts` |
| results/artifact-validator | 见测试结果 | `src/companyclaw/results/artifact-validator.test.ts` |
| results/delivery-status | 见测试结果 | `src/companyclaw/results/delivery-status.test.ts` |
| remote/remote-authorization | 见测试结果 | `src/companyclaw/remote/remote-authorization.test.ts` |

## 未验证（UNVERIFIED）

- 微信 → Gateway → Broker → UIA 整链路（无目标机 / 微信测试账号）
- Broker 与 AppContainer 的 IPC 可达性
- Windows-MCP 可复用性
- 微信文件真实送达
- 普通用户无管理员安装
- 锁屏/UAC/DPI 下的 UIA 行为
```

- [ ] **Step 4: 写 ADR**

Create `docs/companyclaw/ADR/0001-security-core-modules.md`：记录"安全内核作为独立纯逻辑模块、不修改 main.ts 既有逻辑、fail-closed 默认值"的决策及理由（引用《CompanyClaw 源码调查结论与实施架构方案 V1.0》§4）。

- [ ] **Step 5: 全量回归 + lint**

Run:
```bash
cd desktop && npx vitest run
cd desktop && npx tsc --noEmit
cd desktop && npx eslint src/companyclaw
```
Expected: 全部通过（0 failures / 0 errors）

- [ ] **Step 6: 提交**

```bash
git add desktop/src/companyclaw/companyclaw-core.test.ts docs/companyclaw/
git commit -m "test(companyclaw): verify the security core end to end and record status"
```

---

## Self-Review

| 需求 / 设计项 | 对应 Task |
|---|---|
| F6 任务状态机（含 PAUSE_REQUESTED/PAUSED/RESUMING，禁 PAUSED→RUNNING 直连） | Task 1, 2 |
| F6 暂停/恢复/取消/急停四态控制 | Task 1 |
| F7 R0–R3 分级，不靠提示词、不靠工具名 | Task 3 |
| F7 R2 七项条件中的"执行层能可靠拦截"（不可拦截则拒绝） | Task 3 |
| F7 一次性审批票据（绑定任务/系统/记录/字段/原值/新值；短时、单次、防重放） | Task 4 |
| F7 审批生命周期（拒绝/超时/已消费即禁执行、签署人校验） | Task 5 |
| F7 守卫在到达执行器之前生效；失败关闭 | Task 6 |
| F8 产物校验（魔数、ZIP 结构，不能只看扩展名） | Task 7 |
| F8 `SEND_REQUESTED→SENT→DELIVERED`(+FAILED/UNKNOWN)，SENT≠DELIVERED | Task 8 |
| F3/F7 远程授权显式开启、有效期、撤销；信任来源来自通道元数据 | Task 9 |
| 数据约束（版本化、SID 隔离、fail-safe 默认） | Task 2, 5, 9 |
| 组合验证与状态记录 | Task 10 |

**未覆盖（已明确排除，留待后续计划）**：Broker 进程本体（UIA 执行器）、微信插件审批文本通道、`main.ts` 装配与 IPC、任务中心 UI、安装器 Per-User 化、`jobs/<taskId>/artifacts` 目录落盘。这些依赖 Task 1–10 的接口，本计划先交付其被依赖的安全内核。
