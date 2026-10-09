import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename as pathBasename } from "node:path";
import { CompanyClawApprovalStore } from "./approvals/approval-store";
import {
  ExecutionBridge,
  type BridgeResult,
  type BridgeTransport,
} from "./bridge/execution-bridge";
import { decideAction, type ActionDescriptor } from "./policy/risk-classifier";
import {
  hashBinding,
  issueApprovalTicket,
  type ApprovalBinding,
  type ApprovalTicket,
} from "./policy/approval-ticket";
import {
  applyApprovalReply,
  formatApprovalBatch,
  parseApprovalReply,
} from "./remote/approval-message";
import {
  buildTaskArtifactDir,
  isPathInsideTaskDir,
  sanitizeArtifactFileName,
} from "./results/task-artifacts";
import { IdentityBindingStore, type IdentityBinding } from "./remote/identity-binding";
import { BrowserPolicy, type BrowserAuthorization } from "./policy/browser-policy";
import { BrokerTargetsStore, type BrokerTargets } from "./broker-targets";
import { RemoteAuthorization } from "./remote/remote-authorization";
import { CompanyClawTaskStore, filterTasksForOwner } from "./tasks/task-store";
import type { CompanyClawTaskAdvancePatch, CompanyClawTaskRecord } from "./tasks/task-store";
import { nextStateForControl, type TaskControl, type TaskState } from "./tasks/task-state";

export const COMPANYCLAW_TICKET_TTL_MS = 120_000;
export const COMPANYCLAW_APPROVAL_TTL_MS = 300_000;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 60 * 24 * 7;

export interface RuntimePaths {
  tasksFile: string;
  approvalsFile: string;
  /** Root for per-task artifact directories (jobs/<taskId>/artifacts). */
  artifactsRoot: string;
  /** File holding the WeChat identity -> device -> SID binding. */
  identityFile: string;
  /** File holding the broker's application allow list. */
  brokerTargetsFile: string;
}

export interface RuntimeDependencies {
  paths: RuntimePaths;
  /** Windows user SID this installation serves. */
  ownerSid: string;
  now?: () => Date;
  createId?: () => string;
  readFile: (filePath: string) => string;
  existsFile: (filePath: string) => boolean;
  writeFile: (filePath: string, contents: string) => Promise<void>;
  ticketSecret: string;
}

export interface RemoteAuthorizationView {
  state: ReturnType<RemoteAuthorization["state"]>;
  ownerSid: string;
  deviceId: string;
  channelUserId: string;
  grantedAt: string | null;
  expiresAt: string | null;
}

export interface SetRemoteAuthorizationInput {
  enabled: boolean;
  ownerSid?: string;
  deviceId?: string;
  channelUserId?: string;
  ttlMinutes?: number;
}

export interface CreateTaskInput {
  ownerSid: string;
  deviceId: string;
  channel: string;
  objective: string;
  idempotencyKey?: string | null;
}

export interface AdvanceTaskInput {
  taskId: string;
  to: TaskState;
  ownerSid: string;
  patch?: CompanyClawTaskAdvancePatch;
}

export interface ControlTaskInput {
  taskId: string;
  ownerSid: string;
  control: TaskControl;
  reason?: string;
}

export interface ControlTaskResult {
  accepted: boolean;
  record: CompanyClawTaskRecord | null;
  reason?: string;
}

export interface RequestApprovalInput {
  ownerSid: string;
  action: ActionDescriptor;
  binding: Partial<ApprovalBinding>;
}

export interface ResolveApprovalInput {
  approvalId: string;
  decision: "approved" | "denied";
  resolvedBy: string;
}

export interface IssueTicketInput {
  approvalId: string;
  ownerSid: string;
}

/**
 * Runtime facade for the CompanyClaw security core.
 *
 * `main.ts` only wires IPC to these methods; every authorization decision lives
 * behind this boundary so there is exactly one place that can widen access.
 * The facade never touches the host's security configuration and never reaches
 * an executor without a policy decision.
 */
export class CompanyClawRuntime {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly tasks: CompanyClawTaskStore;
  private readonly approvals: CompanyClawApprovalStore;
  private readonly authorization: RemoteAuthorization;
  private readonly ticketSecret: string;
  private readonly consumedNonces = new Set<string>();
  private readonly identity: IdentityBindingStore;
  private browserPolicy: BrowserPolicy;
  private browserConfig = {
    allowedDomains: [] as string[],
    allowDownloads: false,
    allowUploads: false,
  };
  private readonly brokerTargets: BrokerTargetsStore;
  /** Applies a new allow list to the running broker, when one is present. */
  private applyBrokerTargets: ((targets: BrokerTargets) => Promise<void>) | null = null;

  constructor(private readonly deps: RuntimeDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? randomUUID;
    this.ticketSecret = deps.ticketSecret;
    const io = {
      now: this.now,
      existsFile: deps.existsFile,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
    };
    this.tasks = new CompanyClawTaskStore(deps.paths.tasksFile, { ...io, createId: this.createId });
    this.approvals = new CompanyClawApprovalStore(deps.paths.approvalsFile, {
      ...io,
      createId: this.createId,
      ttlMs: COMPANYCLAW_APPROVAL_TTL_MS,
      secret: this.ticketSecret,
    });
    this.authorization = new RemoteAuthorization({ now: this.now });
    this.identity = new IdentityBindingStore(deps.paths.identityFile, io);
    // Deny everything until the user configures an allow list: the browser path
    // must not reach the intranet by default.
    this.browserPolicy = new BrowserPolicy({
      allowedDomains: [],
      allowDownloads: false,
      allowUploads: false,
    });
    this.brokerTargets = new BrokerTargetsStore(deps.paths.brokerTargetsFile, io);
  }

  /** Wires the broker client so allow-list changes reach the running process. */
  setBrokerTargetsApplier(apply: ((targets: BrokerTargets) => Promise<void>) | null): void {
    this.applyBrokerTargets = apply;
  }

  // ── Broker application allow list ───────────────────────────────────

  /**
   * The applications the broker may automate. Starts empty, which means the
   * broker refuses every process operation until the user allows one.
   */
  getBrokerTargets(): BrokerTargets {
    return this.brokerTargets.get();
  }

  async setBrokerTargets(targets: BrokerTargets): Promise<BrokerTargets> {
    const saved = await this.brokerTargets.save(targets);
    if (this.applyBrokerTargets) await this.applyBrokerTargets(saved);
    return saved;
  }

  // ── Browser ──────────────────────────────────────────────────────────

  /** Replaces the browser allow list and capability switches. */
  configureBrowser(config: {
    allowedDomains: readonly string[];
    allowDownloads: boolean;
    allowUploads: boolean;
  }): void {
    this.browserConfig = {
      allowedDomains: [...config.allowedDomains],
      allowDownloads: config.allowDownloads === true,
      allowUploads: config.allowUploads === true,
    };
    this.browserPolicy = new BrowserPolicy(this.browserConfig);
  }

  describeBrowserPolicy(): {
    allowedDomains: string[];
    allowDownloads: boolean;
    allowUploads: boolean;
  } {
    return { ...this.browserConfig, allowedDomains: [...this.browserConfig.allowedDomains] };
  }

  /**
   * Authorizes one browser action.
   *
   * Two independent gates must both pass, and they fail for different reasons,
   * so the outcome keeps them distinct:
   *   * the browser policy (allowed domain + capability switches), and
   *   * live remote authorization.
   * A `write` or `high-risk` result means the caller must still obtain an
   * approval before executing; this method only decides whether the action is
   * admissible at all.
   */
  authorizeBrowserAction(input: {
    action: string;
    url: string;
  }): { allowed: true; risk: "read" | "write" | "high-risk" } | { allowed: false; reason: string } {
    if (this.authorization.state() !== "enabled") {
      return { allowed: false, reason: "remote-not-authorized" };
    }
    const authorization: BrowserAuthorization = this.browserPolicy.authorize(input);
    if (!authorization.allowed) return { allowed: false, reason: authorization.reason };
    return { allowed: true, risk: authorization.risk };
  }

  // ── Identity binding ─────────────────────────────────────────────────

  /** The currently bound WeChat identity, or null when unbound. */
  getIdentityBinding(): IdentityBinding | null {
    return this.identity.get();
  }

  /**
   * Binds a WeChat identity to this device and Windows user.
   *
   * Binding establishes *who* may talk to this machine; it does not by itself
   * grant tool access — that stays behind remote authorization.
   */
  async bindIdentity(input: {
    channelType: string;
    channelUserId: string;
    deviceId: string;
  }): Promise<IdentityBinding> {
    if (!input.deviceId) throw new Error("deviceId is required");
    return await this.identity.bind({
      ownerSid: this.deps.ownerSid,
      deviceId: input.deviceId,
      channelType: input.channelType,
      channelUserId: input.channelUserId,
      boundAt: this.now().toISOString(),
    });
  }

  async unbindIdentity(): Promise<void> {
    await this.identity.unbind();
  }

  /**
   * Resolves the local owner for a channel sender, or null when unbound.
   *
   * Read-only and used to build the trusted context for an inbound message; it
   * grants nothing by itself — tool access stays behind remote authorization.
   */
  resolveRemoteOwner(input: {
    channelType: string;
    channelUserId: string;
  }): { ownerSid: string; deviceId: string } | null {
    return this.identity.resolveOwner(input.channelType, input.channelUserId);
  }

  /**
   * True only when the sender is the bound identity AND remote operation is
   * currently authorized. Both must hold: being bound is not permission to act.
   */
  isRemoteCallerAuthorized(input: { channelType: string; channelUserId: string }): boolean {
    if (!this.identity.isAuthorized(input.channelType, input.channelUserId)) return false;
    return this.authorization.state() === "enabled";
  }

  // ── Remote authorization ─────────────────────────────────────────────

  getRemoteAuthorization(): RemoteAuthorizationView {
    const record = this.authorization.snapshot();
    return {
      state: this.authorization.state(),
      ownerSid: record.ownerSid,
      deviceId: record.deviceId,
      channelUserId: record.channelUserId,
      grantedAt: record.grantedAt,
      expiresAt: record.expiresAt,
    };
  }

  setRemoteAuthorization(input: SetRemoteAuthorizationInput): RemoteAuthorizationView {
    if (!input.enabled) {
      this.authorization.revoke();
      return this.getRemoteAuthorization();
    }
    const ttlMinutes = input.ttlMinutes;
    if (
      typeof ttlMinutes !== "number" ||
      !Number.isFinite(ttlMinutes) ||
      ttlMinutes < MIN_TTL_MINUTES ||
      ttlMinutes > MAX_TTL_MINUTES
    ) {
      throw new Error(`ttlMinutes must be between ${MIN_TTL_MINUTES} and ${MAX_TTL_MINUTES}`);
    }
    // The renderer may not know the paired channel user: the grant is bound to
    // whoever this machine has actually paired. Fail closed when neither exists.
    const channelUserId = input.channelUserId || this.identity.get()?.channelUserId || "";
    if (!input.ownerSid || !input.deviceId || !channelUserId) {
      throw new Error(
        "ownerSid, deviceId and channelUserId are required to enable remote operation",
      );
    }
    this.authorization.setEnabled({
      ownerSid: input.ownerSid,
      deviceId: input.deviceId,
      channelUserId,
      ttlMs: ttlMinutes * 60_000,
    });
    return this.getRemoteAuthorization();
  }

  // ── Tasks ────────────────────────────────────────────────────────────

  listTasks(filter: { ownerSid: string; state?: TaskState }): CompanyClawTaskRecord[] {
    const owned = filterTasksForOwner(this.tasks.list(), filter.ownerSid);
    return filter.state ? owned.filter((record) => record.state === filter.state) : owned;
  }

  getTask(taskId: string, ownerSid: string): { record: CompanyClawTaskRecord } | null {
    const record = this.tasks.get(taskId);
    if (!record || record.ownerSid !== ownerSid) return null;
    return { record };
  }

  async createTask(input: CreateTaskInput): Promise<CompanyClawTaskRecord> {
    return await this.tasks.create({
      ownerSid: input.ownerSid,
      deviceId: input.deviceId,
      channel: input.channel,
      objective: input.objective,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  }

  /**
   * Creates (or resumes) the task for one trusted inbound message.
   *
   * The identity is resolved from the local binding rather than from anything
   * the message carried, and the message id doubles as the idempotency key so a
   * channel redelivery resumes the existing task instead of starting a second
   * one. A sender that is not the paired identity produces no task at all.
   */
  async createTaskFromRemote(input: {
    channelType: string;
    channelUserId: string;
    messageId: string;
    objective: string;
  }): Promise<
    | { ok: true; task: CompanyClawTaskRecord; resumed: boolean }
    | { ok: false; reason: "unbound-sender" | "missing-message-id" }
  > {
    const messageId = input.messageId.trim();
    if (!messageId) return { ok: false, reason: "missing-message-id" };
    const owner = this.identity.resolveOwner(input.channelType, input.channelUserId);
    if (!owner) return { ok: false, reason: "unbound-sender" };

    // Scoped by the bound account *and* the message id: a redelivery of the same
    // message resumes its task, while the same id from another sender does not.
    const idempotencyKey = `weixin:${input.channelUserId}:${messageId}`;
    const existing = this.tasks.findByIdempotencyKey(idempotencyKey);
    if (existing) return { ok: true, task: existing, resumed: true };

    const task = await this.tasks.create({
      ownerSid: owner.ownerSid,
      deviceId: owner.deviceId,
      channel: "weixin",
      objective: input.objective,
      idempotencyKey,
    });
    return { ok: true, task, resumed: false };
  }

  async advanceTask(input: AdvanceTaskInput): Promise<CompanyClawTaskRecord> {
    this.assertOwner(input.taskId, input.ownerSid);
    return await this.tasks.advance(input.taskId, input.to, input.patch ?? {});
  }

  async controlTask(input: ControlTaskInput): Promise<ControlTaskResult> {
    const record = this.tasks.get(input.taskId);
    if (!record || record.ownerSid !== input.ownerSid) {
      throw new Error(`Task ${input.taskId} is not owned by ${input.ownerSid}`);
    }
    const next = nextStateForControl(record.state, input.control);
    if (next === null) {
      return {
        accepted: false,
        record,
        reason: `control "${input.control}" is not legal from ${record.state}`,
      };
    }
    const advanced = await this.tasks.advance(input.taskId, next, {
      resultSummary: input.reason ?? record.resultSummary,
    });
    return { accepted: true, record: advanced };
  }

  // ── Approvals ────────────────────────────────────────────────────────

  async requestApproval(
    input: RequestApprovalInput,
  ): Promise<{ approvalId: string; status: string; binding: ApprovalBinding }> {
    const decision = decideAction(input.action, {
      remoteAuthorization: this.authorization.state(),
    });
    if (decision.decision === "deny") {
      throw new Error(
        `Action denied by policy (${decision.level}): ${decision.reasons.join("; ")}`,
      );
    }
    if (decision.decision !== "require-approval") {
      throw new Error(
        `Action does not require approval (${decision.level}); execute it directly through the bridge`,
      );
    }
    const binding = this.completeBinding(input.binding, input.ownerSid);
    const record = await this.approvals.request(binding);
    return { approvalId: record.approvalId, status: record.status, binding };
  }

  listPendingApprovals(ownerSid: string) {
    return this.approvals.listPending().filter((record) => record.ownerSid === ownerSid);
  }

  async resolveApproval(input: ResolveApprovalInput) {
    return await this.approvals.resolve(input.approvalId, input.decision, input.resolvedBy);
  }

  /**
   * Builds the confirmation text for the owner's pending approvals.
   *
   * Returns an empty string when nothing awaits confirmation, so the caller
   * sends no card at all rather than an empty one.
   */
  buildApprovalMessage(ownerSid: string): string {
    const pending = this.listPendingApprovals(ownerSid);
    if (pending.length === 0) return "";
    return formatApprovalBatch(
      pending.map((record) => ({
        approvalId: record.approvalId,
        targetSystem: record.targetSystem,
        recordId: record.recordId,
        field: record.field,
        oldValue: record.oldValue,
        newValue: record.newValue,
        expiresAt: record.expiresAt,
        riskLevel: "R2",
      })),
    );
  }

  /**
   * Applies a WeChat reply to this owner's pending approvals.
   *
   * The reply is only ever mapped onto approvals belonging to `ownerSid`, so a
   * message from one user can never decide another user's request. An
   * unrecognised message is reported as `not-a-reply` so the caller lets it
   * continue to the AI instead of swallowing it.
   */
  async applyApprovalReply(
    ownerSid: string,
    rawReply: string,
  ): Promise<
    | { handled: true; resolved: number; decision: "approved" | "denied" }
    | { handled: false; reason: "not-a-reply" | "no-pending" | "index-out-of-range" }
  > {
    const reply = parseApprovalReply(rawReply);
    if (!reply) return { handled: false, reason: "not-a-reply" };

    const pending = this.listPendingApprovals(ownerSid).map((record) => ({
      approvalId: record.approvalId,
      ownerSid: record.ownerSid,
    }));
    const applied = applyApprovalReply(reply, pending);
    if (!applied.ok) return { handled: false, reason: applied.reason };

    let resolved = 0;
    for (const target of applied.targets) {
      try {
        await this.approvals.resolve(target.approvalId, target.decision, ownerSid);
        resolved += 1;
      } catch {
        // A concurrent decision (already resolved or expired) is not a failure
        // of this reply; the remaining targets still apply.
      }
    }
    return { handled: true, resolved, decision: reply.decision };
  }

  /**
   * Issues a single-use ticket for an approval that was actually granted, bound
   * to the exact same change the approval described.
   */
  issueTicketForApproval(input: IssueTicketInput): ApprovalTicket {
    const record = this.approvals.get(input.approvalId);
    if (!record) throw new Error(`Unknown approval: ${input.approvalId}`);
    if (record.ownerSid !== input.ownerSid) {
      throw new Error(`Approval ${input.approvalId} is not owned by ${input.ownerSid}`);
    }
    if (record.status !== "approved") {
      throw new Error(`Approval ${input.approvalId} is not approved (status=${record.status})`);
    }
    const binding = this.bindingFromApproval(record);
    return issueApprovalTicket({
      binding,
      secret: this.ticketSecret,
      ttlMs: COMPANYCLAW_TICKET_TTL_MS,
      now: this.now,
      createNonce: this.createId,
    });
  }

  // ── Execution ────────────────────────────────────────────────────────

  /**
   * Runs an action through the fail-closed bridge. R0/R1 actions proceed;
   * R2 must carry a valid ticket or the bridge denies before any transport call.
   */
  async execute(
    transport: BridgeTransport,
    request: {
      taskId: string;
      stepId: string;
      action: ActionDescriptor;
      approvalTicket?: ApprovalTicket;
      binding?: ApprovalBinding;
    },
  ): Promise<BridgeResult> {
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({ remoteAuthorization: this.authorization.state() }),
      secret: this.ticketSecret,
      now: this.now,
      consumedNonces: this.consumedNonces,
    });
    return await bridge.execute(request);
  }

  // ── Artifacts ────────────────────────────────────────────────────────

  /**
   * Resolves the artifact directory for a task, creating the shape only when
   * asked. Returns null for an unknown task or an unusable id, so a caller can
   * never be handed a path outside the task's own sandbox.
   */
  resolveArtifactDir(input: {
    taskId: string;
    ownerSid: string;
    create?: boolean;
  }): { ok: true; dir: string } | { ok: false; reason: string } {
    const record = this.tasks.get(input.taskId);
    if (!record) return { ok: false, reason: "unknown-task" };
    if (record.ownerSid !== input.ownerSid) return { ok: false, reason: "owner-mismatch" };
    const dir = buildTaskArtifactDir(this.deps.paths.artifactsRoot, input.taskId);
    if (!dir) return { ok: false, reason: "unusable-task-id" };
    if (input.create) {
      try {
        // mode 0o700 keeps other Windows users out of the task's files.
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (error) {
        return {
          ok: false,
          reason: `mkdir-failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return { ok: true, dir };
  }

  /**
   * Validates that a produced file may be accepted for a task: it must live
   * inside that task's own artifact directory and carry a usable leaf name.
   */
  acceptArtifact(input: {
    taskId: string;
    ownerSid: string;
    filePath: string;
  }): { ok: true; fileName: string } | { ok: false; reason: string } {
    const resolved = this.resolveArtifactDir({
      taskId: input.taskId,
      ownerSid: input.ownerSid,
    });
    if (!resolved.ok) return resolved;
    if (!isPathInsideTaskDir(resolved.dir, input.filePath)) {
      return { ok: false, reason: "outside-task-directory" };
    }
    const fileName = sanitizeArtifactFileName(pathBasename(input.filePath));
    if (!fileName) return { ok: false, reason: "unusable-file-name" };
    return { ok: true, fileName };
  }

  // ── internals ────────────────────────────────────────────────────────

  private assertOwner(taskId: string, ownerSid: string): void {
    const record = this.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task: ${taskId}`);
    if (record.ownerSid !== ownerSid) {
      throw new Error(`Task ${taskId} is not owned by ${ownerSid}`);
    }
  }

  private completeBinding(partial: Partial<ApprovalBinding>, ownerSid: string): ApprovalBinding {
    const merged: ApprovalBinding = {
      ownerSid,
      deviceId: partial.deviceId ?? "",
      taskId: partial.taskId ?? "",
      stepId: partial.stepId ?? "",
      actionType: partial.actionType ?? "business-write",
      targetSystem: partial.targetSystem ?? "",
      recordId: partial.recordId ?? "",
      field: partial.field ?? "",
      oldValue: partial.oldValue ?? null,
      newValue: partial.newValue ?? null,
      canonicalPayloadHash: "",
    };
    if (!merged.deviceId || !merged.taskId || !merged.stepId || !merged.targetSystem) {
      throw new Error("deviceId, taskId, stepId and targetSystem are required for an approval");
    }
    // Recompute the payload hash from the normalized binding when the caller did
    // not supply one, so the ticket always binds the exact change.
    merged.canonicalPayloadHash =
      partial.canonicalPayloadHash || hashBinding({ ...merged, canonicalPayloadHash: "" });
    return merged;
  }

  private bindingFromApproval(record: {
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
  }): ApprovalBinding {
    const deviceId = this.authorization.snapshot().deviceId;
    return {
      ownerSid: record.ownerSid,
      deviceId,
      taskId: record.taskId,
      stepId: record.stepId,
      actionType: record.actionType,
      targetSystem: record.targetSystem,
      recordId: record.recordId,
      field: record.field,
      oldValue: record.oldValue,
      newValue: record.newValue,
      canonicalPayloadHash: record.bindingHash,
    };
  }
}
