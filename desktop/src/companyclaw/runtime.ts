import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename as pathBasename } from "node:path";
import {
  CompanyClawApprovalStore,
  COMPANYCLAW_APPROVAL_WAIT_MS as COMPANYCLAW_APPROVAL_WAIT_MS_FROM_STORE,
} from "./approvals/approval-store";
import {
  ExecutionBridge,
  type BridgeResult,
  type BridgeTransport,
} from "./bridge/execution-bridge";
import {
  decideAction,
  type ActionDescriptor,
  type PolicyDecision,
} from "./policy/risk-classifier";
import { DesktopExecutionLock } from "./locks/desktop-execution-lock";
import {
  ComputerUseToolFacade,
  describeAction as describeActionForDispatch,
  describeTarget as describeTargetForDispatch,
  type ToolFacadeResult,
} from "./tools/tool-facade";
import { AuditLog, queryAuditLines, type AuditEntry, type AuditQuery } from "./audit/audit-log";
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
import { PermissionStore } from "./permissions/permission-store";
import {
  normalizeTrustedApp,
  normalizeTrustedDomain,
  type PermissionPolicy,
  type TrustedAppRecord,
  type TrustedSiteRecord,
  type GrantScope,
} from "./permissions/permission-policy";
import { migrateToPermissionPolicy } from "./permissions/migrate";
import {
  DEFAULT_VISION_SCOPE,
  evaluateVisionRequest,
  selectVisionRecord,
  visionGrantLifetimeMs,
  type VisionDecision,
} from "./vision/vision-gate";
import {
  presetSuppressesRoutinePrompts,
  type PermissionPreset,
} from "./policy/permission-preset";
import type { ExecutionOrigin } from "./policy/execution-origin";
import { CompanyClawTaskStore, filterTasksForOwner } from "./tasks/task-store";
import type { CompanyClawTaskAdvancePatch, CompanyClawTaskRecord } from "./tasks/task-store";
import {
  isTerminalState,
  nextStateForControl,
  type TaskControl,
  type TaskState,
} from "./tasks/task-state";
import {
  applyReset,
  buildResetPreview,
  type ResetPreview,
} from "./recovery/reset-to-defaults";

/**
 * The execution credential's lifetime: two minutes.
 *
 * Ruling Q5 fixes this ceiling. It is deliberately unrelated to how long the
 * employee may take to answer — see `COMPANYCLAW_APPROVAL_WAIT_MS`.
 */
/**
 * The audit file is JSON Lines, so reading it means splitting on the line feed.
 *
 * Built from a character code rather than written as an escape so an editor that
 * reflows string literals cannot silently corrupt the separator.
 */
const AUDIT_LINE_SEPARATOR = String.fromCharCode(10);

export const COMPANYCLAW_TICKET_TTL_MS = 120_000;

/**
 * How long an approval stays answerable, per ruling Q5: ten minutes.
 *
 * The employee may be away from the desk; the wait window absorbs that without
 * ever lengthening the credential that executes the action.
 */
export const COMPANYCLAW_APPROVAL_WAIT_MS = COMPANYCLAW_APPROVAL_WAIT_MS_FROM_STORE;
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
  /** File holding the single versioned permission document. */
  permissionsFile: string;
  /** Append-only audit log (JSON Lines). */
  auditFile: string;
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
  /** Preserves an unusable permission file; returns where it was kept. */
  backupFile?: (filePath: string, stamp: string) => string;
  /** Appends one line to the audit log; absent means auditing is disabled. */
  appendAudit?: (filePath: string, line: string) => Promise<void>;
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
  /**
   * The channel the request came from.
   *
   * Required in practice: without it the verdict is computed for the remote
   * channel, which would deny a request the local user is allowed to confirm.
   */
  origin?: ExecutionOrigin;
  /** Where the employee will answer, recorded for the audit. */
  resolutionChannel?: "local" | "weixin";
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
  private permissionPolicy: PermissionPolicy;
  /** Serializes focus-sensitive desktop work for one interactive session. */
  private readonly desktopLock = new DesktopExecutionLock();
  /** Append-only record of every decision this runtime made. */
  private readonly audit: AuditLog;
  private browserPolicy: BrowserPolicy;
  private browserConfig = {
    allowedDomains: [] as string[],
    allowDownloads: false,
    allowUploads: false,
  };
  private readonly brokerTargets: BrokerTargetsStore;
  /** The single authority record: preset, grants, remote and vision state. */
  private readonly permissions: PermissionStore;
  /** Set when the stored permission file was unusable; surfaced in health. */
  private permissionWarning: string | null = null;
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
      ttlMs: COMPANYCLAW_APPROVAL_WAIT_MS,
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
    this.audit = new AuditLog(
      { filePath: deps.paths.auditFile },
      { append: deps.appendAudit ?? (async () => undefined), now: this.now },
    );
    this.permissions = new PermissionStore(deps.paths.permissionsFile, {
      now: this.now,
      existsFile: deps.existsFile,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      backupFile: deps.backupFile,
    });
    // Ruling Q8: the pre-V5 allow list survives as *local* legacy grants and the
    // preset is never inferred, so an upgrade cannot widen what an employee had.
    const inspection = this.permissions.inspect();
    this.permissionWarning = inspection.warning;
    const legacyTargets = this.brokerTargets.get();
    const migration = migrateToPermissionPolicy({
      stored: inspection.warning ? null : inspection.policy,
      legacyTargets,
      legacyRemote: this.authorization.snapshot(),
      now: this.now(),
    });
    this.permissionPolicy = migration.policy;
    // The document is the authority; the in-memory object is a projection of it
    // so the rest of the runtime keeps its existing shape.
    if (migration.policy.remote.enabled) {
      this.authorization.setEnabled({
        ownerSid: migration.policy.remote.ownerSid,
        deviceId: migration.policy.remote.deviceId,
        channelUserId: migration.policy.remote.channelUserId,
        ttlMs: Math.max(
          0,
          Date.parse(migration.policy.remote.expiresAt ?? "") - this.now().getTime(),
        ),
      });
    }
    if (
      migration.notes.length > 0 ||
      inspection.warning ||
      migration.policy.trustedApps.length !== inspection.policy.trustedApps.length
    ) {
      // Persist the migrated document once so the next start is a plain read.
      void this.permissions.save(migration.policy);
    }
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

  // ── Permission policy (the single authority record) ──────────────────

  /** The stored policy, for IPC and health. Never mutated in place. */
  getPermissionPolicy(): PermissionPolicy {
    return {
      ...this.permissionPolicy,
      trustedApps: [...this.permissionPolicy.trustedApps],
      trustedSites: [...this.permissionPolicy.trustedSites],
      workFolders: [...this.permissionPolicy.workFolders],
      taskGrants: [...this.permissionPolicy.taskGrants],
      vision: {
        local: { ...this.permissionPolicy.vision.local },
        remote: { ...this.permissionPolicy.vision.remote },
      },
    };
  }

  getPermissionWarning(): string | null {
    return this.permissionWarning;
  }

  /** Resolves once the permission document on disk matches memory. */
  async flushPermissionWrites(): Promise<void> {
    await this.permissions.whenIdle();
  }

  /**
   * The preset the employee chose. Changing it never touches existing grants:
   * ruling Q8 and §4.4 both require the advanced rules to survive a switch.
   */
  async setPreset(input: {
    preset: PermissionPreset;
    acknowledged?: boolean;
  }): Promise<PermissionPolicy> {
    if (input.preset === "FULL_DAILY" && input.acknowledged !== true) {
      throw new Error("启用「全面日常操作」前需要确认授权范围");
    }
    if (this.permissionPolicy.preset === input.preset) return this.getPermissionPolicy();
    this.permissionPolicy = {
      ...this.permissionPolicy,
      preset: input.preset,
      presetChangedAt: this.now().toISOString(),
      policyVersion: this.permissionPolicy.policyVersion + 1,
    };
    await this.permissions.save(this.permissionPolicy);
    return this.getPermissionPolicy();
  }

  private async savePolicy(next: PermissionPolicy): Promise<PermissionPolicy> {
    this.permissionPolicy = next;
    await this.permissions.save(next);
    return this.getPermissionPolicy();
  }

  /** Adds or replaces one trusted application. Scope defaults to local only. */
  async trustApp(input: {
    processName: string;
    displayName?: string;
    scope?: GrantScope;
    publisher?: string | null;
    executablePath?: string | null;
    fileHash?: string | null;
  }): Promise<TrustedAppRecord | null> {
    const normalized = normalizeTrustedApp({ ...input, source: "user-selected" });
    if (!normalized) return null;
    const record: TrustedAppRecord = {
      ...normalized,
      approvedSid: this.deps.ownerSid,
      approvedAt: this.now().toISOString(),
    };
    const others = this.permissionPolicy.trustedApps.filter(
      (app) => app.processName !== record.processName,
    );
    await this.savePolicy({
      ...this.permissionPolicy,
      policyVersion: this.permissionPolicy.policyVersion + 1,
      trustedApps: [...others, record],
    });
    return record;
  }

  async revokeTrustedApp(processName: string): Promise<PermissionPolicy> {
    const normalized = normalizeTrustedApp({ processName });
    if (!normalized) return this.getPermissionPolicy();
    return await this.savePolicy({
      ...this.permissionPolicy,
      policyVersion: this.permissionPolicy.policyVersion + 1,
      trustedApps: this.permissionPolicy.trustedApps.filter(
        (app) => app.processName !== normalized.processName,
      ),
    });
  }

  /** True when this application may be used from the given channel. */
  isAppTrusted(processName: string, scope: "local" | "remote"): boolean {
    const normalized = normalizeTrustedApp({ processName });
    if (!normalized) return false;
    const app = this.permissionPolicy.trustedApps.find(
      (entry) => entry.processName === normalized.processName,
    );
    if (!app) return false;
    // A migrated legacy entry is local-only until the employee re-confirms it.
    if (app.legacy && scope === "remote") return false;
    return app.scope === "both" || app.scope === scope;
  }

  async trustSite(input: {
    domain: string;
    kind?: TrustedSiteRecord["kind"];
    taskId?: string | null;
    expiresAt?: string | null;
  }): Promise<TrustedSiteRecord | null> {
    const domain = normalizeTrustedDomain(input.domain);
    if (!domain) return null;
    const record: TrustedSiteRecord = {
      domain,
      kind: input.kind ?? "user-trusted",
      taskId: input.taskId ?? null,
      expiresAt: input.expiresAt ?? null,
      addedAt: this.now().toISOString(),
    };
    await this.savePolicy({
      ...this.permissionPolicy,
      policyVersion: this.permissionPolicy.policyVersion + 1,
      trustedSites: [
        ...this.permissionPolicy.trustedSites.filter((site) => site.domain !== domain),
        record,
      ],
    });
    return record;
  }

  async revokeTrustedSite(domain: string): Promise<PermissionPolicy> {
    const normalized = normalizeTrustedDomain(domain);
    if (!normalized) return this.getPermissionPolicy();
    return await this.savePolicy({
      ...this.permissionPolicy,
      policyVersion: this.permissionPolicy.policyVersion + 1,
      trustedSites: this.permissionPolicy.trustedSites.filter(
        (site) => site.domain !== normalized,
      ),
    });
  }

  /** Domains the employee trust that are still valid right now. */
  listEffectiveTrustedSites(): TrustedSiteRecord[] {
    const now = this.now().getTime();
    return this.permissionPolicy.trustedSites.filter(
      (site) => site.expiresAt === null || Date.parse(site.expiresAt) > now,
    );
  }

  // ── Task scope grants ───────────────────────────────────────────────

  /**
   * Records the short-lived scope of one task.
   *
   * Ruling Q-B asks for "one confirmation for a clearly bounded set of sends in
   * the same task"; this is that bound. It is always tied to the task, owner,
   * device and origin, so it cannot be reused by a later task or another
   * channel.
   */
  async grantTaskScope(input: {
    taskId: string;
    ownerSid: string;
    deviceId: string;
    origin: ExecutionOrigin;
    targets: readonly string[];
    ttlMs: number;
  }): Promise<PermissionPolicy> {
    const task = this.tasks.get(input.taskId);
    if (!task || task.ownerSid !== input.ownerSid) {
      throw new Error(`Task ${input.taskId} is not owned by ${input.ownerSid}`);
    }
    const record = {
      taskId: input.taskId,
      ownerSid: input.ownerSid,
      deviceId: input.deviceId,
      origin: input.origin,
      targets: [...input.targets],
      createdAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
    };
    return await this.savePolicy({
      ...this.permissionPolicy,
      taskGrants: [
        ...this.permissionPolicy.taskGrants.filter((grant) => grant.taskId !== input.taskId),
        record,
      ],
    });
  }

  /** True when a live grant for this task covers the given target. */
  isTaskGranted(input: {
    taskId: string;
    ownerSid: string;
    deviceId: string;
    target: string;
  }): boolean {
    const now = this.now().getTime();
    const normalizedTarget = input.target.trim().toLowerCase();
    return this.permissionPolicy.taskGrants.some(
      (grant) =>
        grant.taskId === input.taskId &&
        grant.ownerSid === input.ownerSid &&
        grant.deviceId === input.deviceId &&
        Date.parse(grant.expiresAt) > now &&
        grant.targets.some((target) => target.trim().toLowerCase() === normalizedTarget),
    );
  }

  listTaskGrants(ownerSid: string) {
    const now = this.now().getTime();
    return this.permissionPolicy.taskGrants.filter(
      (grant) => grant.ownerSid === ownerSid && Date.parse(grant.expiresAt) > now,
    );
  }

  async revokeTaskGrant(taskId: string): Promise<PermissionPolicy> {
    return await this.savePolicy({
      ...this.permissionPolicy,
      taskGrants: this.permissionPolicy.taskGrants.filter((grant) => grant.taskId !== taskId),
    });
  }

  // ── Tool decisions (the one place a tool call is judged) ─────────────

  /**
   * The policy verdict for one agent tool call.
   *
   * Everything the newer rules depend on is assembled here rather than in the
   * facade: the channel, the preset, whether a task-scope grant covers the
   * target, and the live remote-authorization state. Keeping it in one method is
   * what makes "who may do what" reviewable in a single place.
   */
  decideToolAction(input: {
    action: ActionDescriptor;
    origin: ExecutionOrigin;
    preset?: PermissionPreset;
    taskId?: string;
    target?: string;
    deviceId?: string;
    ownerSid?: string;
  }): {
    decision: PolicyDecision;
    reason: string;
    autoAllowedByTaskScope: boolean;
    level: string;
  } {
    const preset = input.preset ?? this.permissionPolicy.preset;
    const ownerSid = input.ownerSid ?? this.deps.ownerSid;
    const deviceId = input.deviceId ?? this.permissionPolicy.remote.deviceId;
    const taskGranted =
      input.taskId !== undefined &&
      input.target !== undefined &&
      input.target.length > 0 &&
      this.isTaskGranted({
        taskId: input.taskId,
        ownerSid,
        deviceId,
        target: input.target,
      });

    const decision = decideAction(input.action, {
      remoteAuthorization: this.authorization.state(),
      origin: input.origin,
      preset,
      taskGranted,
    });

    const autoAllowedByTaskScope =
      decision.decision === "allow" &&
      taskGranted &&
      presetSuppressesRoutinePrompts(preset);

    return {
      decision: decision.decision,
      reason: decision.reasons.join("; "),
      autoAllowedByTaskScope,
      level: decision.level,
    };
  }

  /**
   * Runs a planned step through the bridge, holding the desktop lock.
   *
   * Requirement V2/V5 both require focus-sensitive work to be serialized: two
   * tasks typing into the foreground window would interleave, and the second one
   * may be typing into a window the first one just changed. The lock therefore
   * *refuses* a competing task rather than queueing it — a queued task would run
   * against a desktop the user has since moved on from.
   */
  async executeStepWithLock(input: {
    taskId: string;
    transport: BridgeTransport;
    request: {
      stepId: string;
      action: ActionDescriptor;
      origin?: ExecutionOrigin;
      approvalTicket?: ApprovalTicket;
      binding?: ApprovalBinding;
    };
  }): Promise<BridgeResult> {
    const lock = this.desktopLock.acquire(input.taskId);
    if (!lock.acquired) {
      return { outcome: "unavailable", reason: "desktop-busy" };
    }
    try {
      return await this.execute(input.transport, {
        taskId: input.taskId,
        stepId: input.request.stepId,
        action: input.request.action,
        ...(input.request.origin ? { origin: input.request.origin } : {}),
        ...(input.request.approvalTicket ? { approvalTicket: input.request.approvalTicket } : {}),
        ...(input.request.binding ? { binding: input.request.binding } : {}),
      });
    } finally {
      lock.release();
    }
  }

  // ── Agent tool entry point ───────────────────────────────────────────

  /**
   * Handles one agent tool call end to end.
   *
   * This is the production seam the Gateway uses: it validates the call's shape,
   * takes a policy verdict for the *channel the message arrived through*, raises
   * an approval when the verdict asks for one, and dispatches through the
   * execution bridge so a mutating action carries a ticket the broker re-checks
   * on its own side.
   *
   * Nothing here trusts the caller: the origin and the task identity come from
   * `context`, which the trusted boundary mints, and `validateToolCall` refuses a
   * call whose arguments try to supply either.
   */
  async handleAgentToolCall(input: {
    call: { tool: string; arguments: Record<string, unknown> };
    context: {
      origin: ExecutionOrigin;
      taskId: string;
      stepId: string;
      ownerSid: string;
      deviceId: string;
    };
    transport: BridgeTransport;
    approvalId?: string;
  }): Promise<ToolFacadeResult> {
    const facade = new ComputerUseToolFacade({
      decide: (policyInput) =>
        this.decideToolAction({
          action: policyInput.action,
          origin: policyInput.origin,
          preset: policyInput.preset,
          taskId: policyInput.taskId,
          target: policyInput.target,
          deviceId: input.context.deviceId,
          ownerSid: input.context.ownerSid,
        }),
      requestApproval: async (request) => {
        try {
          // An auto-allowed action still needs a binding so a ticket can be
          // issued for it; the approval record is what the broker's re-check
          // ultimately derives from.
          const raised = await this.requestApproval({
            ownerSid: input.context.ownerSid,
            action: request.action,
            binding: request.binding,
            origin: input.context.origin,
            resolutionChannel: request.resolutionChannel,
          });
          return { approvalId: raised.approvalId, binding: raised.binding };
        } catch {
          return null;
        }
      },
      issueTicket: (issueInput) => this.issueCredentialsForApproval(issueInput),
      dispatch: async (dispatchInput) => {
        const action = {
          ...describeActionForDispatch(dispatchInput.tool),
          targetSystem: describeTargetForDispatch(dispatchInput.arguments),
        };

        // A mutating call that the policy allowed outright still has to satisfy
        // the bridge, which is a second, independent gate. The grant the facade
        // passed is turned into the credential for exactly this action here,
        // rather than by weakening the bridge.
        let ticket = dispatchInput.approvalTicket;
        let binding = dispatchInput.binding;
        if (dispatchInput.executionGrant && dispatchInput.tool.mutating) {
          const issued = this.issueExecutionCredential({
            action,
            origin: input.context.origin,
            taskId: dispatchInput.taskId,
            stepId: dispatchInput.stepId,
            ownerSid: input.context.ownerSid,
            deviceId: input.context.deviceId,
          });
          ticket = issued.ticket;
          binding = issued.binding;
        }

        const result = await this.executeStepWithLock({
          taskId: dispatchInput.taskId,
          transport: input.transport,
          request: {
            stepId: dispatchInput.stepId,
            action,
            origin: input.context.origin,
            ...(ticket ? { approvalTicket: ticket } : {}),
            ...(binding ? { binding } : {}),
          },
        });
        return result;
      },
      recordAudit: (entry) => {
        void this.audit.record({
          taskId: entry.taskId,
          stepId: entry.stepId,
          origin: entry.origin,
          ownerSid: input.context.ownerSid,
          deviceId: input.context.deviceId,
          tool: entry.tool,
          actionCategory: entry.tool,
          decision: entry.decision,
          reason: entry.reason,
          policyVersion: this.permissionPolicy.policyVersion,
          preset: this.permissionPolicy.preset,
          autoAllowed: entry.autoAllowed,
          target: input.call.arguments ? describeTargetForDispatch(input.call.arguments) : "",
          ...(entry.approvalId ? { approvalId: entry.approvalId } : {}),
        });
      },
      now: this.now,
    });

    return await facade.handle({
      call: input.call,
      context: input.context,
      preset: this.permissionPolicy.preset,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    });
  }

  /**
   * Issues the credential for an action the policy allowed without a prompt.
   *
   * This is not an approval: nothing is recorded as "asked and answered",
   * because nothing was asked. It exists only so the execution bridge — which
   * checks every mutating call independently — has the binding and ticket that
   * describe this exact request. The broker then re-checks its own ticket built
   * from the same fields.
   */
  issueExecutionCredential(input: {
    action: ActionDescriptor;
    origin: ExecutionOrigin;
    taskId: string;
    stepId: string;
    ownerSid: string;
    deviceId: string;
  }): { ticket: ApprovalTicket; binding: ApprovalBinding } {
    const binding = this.completeBinding(
      {
        deviceId: input.deviceId,
        taskId: input.taskId,
        stepId: input.stepId,
        actionType: input.action.toolName ?? String(input.action.kind),
        targetSystem: input.action.targetSystem ?? "",
      },
      input.ownerSid,
    );
    return {
      ticket: issueApprovalTicket({
        binding,
        secret: this.ticketSecret,
        ttlMs: COMPANYCLAW_TICKET_TTL_MS,
        now: this.now,
        createNonce: this.createId,
      }),
      binding,
    };
  }

  /**
   * Issues the ticket *and* the binding it was signed for.
   *
   * The bridge verifies one against the other, so a caller that received only
   * the ticket would be unable to complete a resumed action.
   */
  issueCredentialsForApproval(input: { approvalId: string; ownerSid: string }): {
    ticket: ApprovalTicket;
    binding: ApprovalBinding;
  } {
    const record = this.approvals.get(input.approvalId);
    if (!record) throw new Error(`Unknown approval: ${input.approvalId}`);
    if (record.ownerSid !== input.ownerSid) {
      throw new Error(`Approval ${input.approvalId} is not owned by ${input.ownerSid}`);
    }
    return {
      ticket: this.issueTicketForApproval(input),
      binding: this.bindingFromApproval(record),
    };
  }

  /** Recent audit entries, for the diagnostics view. */
  listAuditEntries(query: AuditQuery = {}): Promise<AuditEntry[]> {
    return this.readAudit(query);
  }

  private async readAudit(query: AuditQuery): Promise<AuditEntry[]> {
    const lines = await this.readAuditLines();
    return queryAuditLines(lines, query);
  }

  /** Reads the whole audit file; absent means nothing has been recorded yet. */
  private async readAuditLines(): Promise<string[]> {
    const file = this.deps.paths.auditFile;
    if (!this.deps.existsFile(file)) return [];
    try {
      return this.deps.readFile(file).split(AUDIT_LINE_SEPARATOR);
    } catch {
      return [];
    }
  }

  /** Records one decision. Never throws: the action already happened. */
  async recordAuditEntry(entry: Parameters<AuditLog["record"]>[0]): Promise<void> {
    await this.audit.record(entry);
  }

  /** True while a focus-sensitive task holds the desktop lock. */
  isDesktopBusy(): boolean {
    return this.desktopLock.isBusy();
  }

  /** Releases the lock for a task that is being cancelled. */
  releaseDesktopLock(taskId: string): void {
    this.desktopLock.forceRelease(taskId);
  }

  // ── Restore safe defaults ────────────────────────────────────────────

  /**
   * Describes what "restore safe defaults" would do, without doing it.
   *
   * Ruling Q-D requires the employee to see the blast radius — including how
   * many tasks will be paused and how many pending approvals will be voided —
   * before anything changes.
   */
  previewSafeDefaultsReset(): ResetPreview {
    return buildResetPreview({
      policy: this.permissionPolicy,
      tasks: this.tasks.list().map((record) => ({ taskId: record.taskId, state: record.state })),
      pendingApprovals: this.approvals.listPending().length,
    });
  }

  /**
   * Clears every authority the employee granted and pauses active work.
   *
   * Order matters and is deliberate: the document is persisted first, so a
   * crash halfway through leaves the machine *less* authorized rather than more.
   * The pending approvals are then voided and the active tasks paused; nothing
   * here closes a running application, deletes history or removes artifacts.
   */
  async restoreSafeDefaults(input: { token: string }): Promise<
    | {
        applied: true;
        preview: ResetPreview;
        invalidatedApprovals: number;
        pausedTasks: number;
      }
    | { applied: false; reason: "stale-preview" | "invalid-token" }
  > {
    const pendingApprovals = this.approvals.listPending().length;
    const outcome = applyReset({
      policy: this.permissionPolicy,
      pendingApprovals,
      token: input.token,
    });
    if (!outcome.applied) return outcome;

    // 1. Persist the cleared policy before anything observable happens.
    await this.savePolicy(outcome.policy);

    // 2. Void every unconsumed approval. Consumed records are untouched: the
    //    audit trail of what was actually approved must survive.
    const invalidated = this.approvals.expireAllPending();

    // 3. Pause active tasks, local and remote alike, through the same state
    //    machine the UI uses so every transition stays legal.
    let paused = 0;
    for (const record of this.tasks.list()) {
      if (isTerminalState(record.state)) continue;
      const next = nextStateForControl(record.state, "pause");
      if (next === null) continue;
      try {
        await this.tasks.advance(record.taskId, next, {
          resultSummary: "已恢复安全默认值：任务已暂停，等待重新授权后继续",
        });
        paused += 1;
      } catch {
        // A concurrent transition is not a failure of the reset; the remaining
        // tasks still get paused.
      }
    }

    return { applied: true, preview: outcome.preview, invalidatedApprovals: invalidated, pausedTasks: paused };
  }

  // ── Cloud vision authorization (independent of the preset) ───────────

  /**
   * Grants cloud-vision use for one origin.
   *
   * Ruling Q-C: the grant names the provider, endpoint and model, so changing
   * any of them voids it; remote vision additionally cannot outlive the remote
   * operation authorization. Enabling the daily preset never calls this.
   */
  async authorizeVision(input: {
    origin: "local" | "remote";
    provider: string;
    baseUrl: string;
    model: string;
    captureScope?: string;
    ttlMs?: number;
  }): Promise<PermissionPolicy> {
    const provider = input.provider.trim();
    const baseUrl = input.baseUrl.trim();
    const model = input.model.trim();
    if (!provider || !baseUrl || !model) {
      throw new Error("provider、baseUrl 与 model 必填，否则无法说明数据将发送给谁");
    }
    const executionOrigin: ExecutionOrigin = input.origin === "remote" ? "weixin-private" : "local-ui";
    const lifetime = visionGrantLifetimeMs({
      requestedMs: input.ttlMs ?? 0,
      origin: executionOrigin,
      remoteAuthorizationExpiresAt: this.permissionPolicy.remote.enabled
        ? this.permissionPolicy.remote.expiresAt
        : null,
      now: this.now(),
    });
    if (lifetime <= 0) {
      throw new Error("微信远程操作授权未开启或已过期，无法授权远程视觉识别");
    }
    const grantedAt = this.now();
    const record = {
      enabled: true,
      provider,
      baseUrl,
      model,
      captureScope: input.captureScope ?? DEFAULT_VISION_SCOPE,
      grantedAt: grantedAt.toISOString(),
      expiresAt: new Date(grantedAt.getTime() + lifetime).toISOString(),
      revokedAt: null,
    };
    return await this.savePolicy({
      ...this.permissionPolicy,
      policyVersion: this.permissionPolicy.policyVersion + 1,
      vision: { ...this.permissionPolicy.vision, [input.origin]: record },
    });
  }

  async revokeVision(origin: "local" | "remote"): Promise<PermissionPolicy> {
    const current = this.permissionPolicy.vision[origin];
    return await this.savePolicy({
      ...this.permissionPolicy,
      policyVersion: this.permissionPolicy.policyVersion + 1,
      vision: {
        ...this.permissionPolicy.vision,
        [origin]: { ...current, enabled: false, revokedAt: this.now().toISOString() },
      },
    });
  }

  /** Decides whether one screen image may be sent to the configured model. */
  evaluateVision(input: {
    origin: ExecutionOrigin;
    provider: string;
    baseUrl: string;
    model: string;
    captureScope: string;
    modelSupportsVision: boolean;
  }): VisionDecision {
    const record = selectVisionRecord(this.permissionPolicy, input.origin);
    return evaluateVisionRequest(
      record,
      {
        ownerSid: this.deps.ownerSid,
        deviceId: this.permissionPolicy.remote.deviceId,
        origin: input.origin,
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        requestedScope: input.captureScope,
        modelSupportsVision: input.modelSupportsVision,
        remoteAuthorizationExpiresAt: this.permissionPolicy.remote.enabled
          ? this.permissionPolicy.remote.expiresAt
          : null,
        enterprisePolicyTightened: false,
      },
      this.now(),
    );
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
      const record = this.authorization.snapshot();
      void this.savePolicy({
        ...this.permissionPolicy,
        policyVersion: this.permissionPolicy.policyVersion + 1,
        remote: {
          enabled: false,
          ownerSid: record.ownerSid,
          deviceId: record.deviceId,
          channelUserId: record.channelUserId,
          grantedAt: record.grantedAt,
          expiresAt: record.expiresAt,
          revokedAt: record.revokedAt,
        },
      });
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
    const granted = this.authorization.snapshot();
    void this.savePolicy({
      ...this.permissionPolicy,
      policyVersion: this.permissionPolicy.policyVersion + 1,
      remote: {
        enabled: granted.enabled,
        ownerSid: granted.ownerSid,
        deviceId: granted.deviceId,
        channelUserId: granted.channelUserId,
        grantedAt: granted.grantedAt,
        expiresAt: granted.expiresAt,
        revokedAt: granted.revokedAt,
      },
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
    const origin = input.origin ?? "weixin-private";
    const decision = decideAction(input.action, {
      remoteAuthorization: this.authorization.state(),
      origin,
      preset: this.permissionPolicy.preset,
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
    const record = await this.approvals.request(binding, {
      resolutionChannel:
        input.resolutionChannel ?? (input.origin === "local-ui" ? "local" : "weixin"),
      actionCategory: String(input.action.kind),
    });
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
      origin?: ExecutionOrigin;
      approvalTicket?: ApprovalTicket;
      binding?: ApprovalBinding;
    },
  ): Promise<BridgeResult> {
    const origin = request.origin ?? "local-ui";
    const task = this.tasks.get(request.taskId);
    const target = request.action.targetSystem ?? "";
    const taskGranted =
      task !== null &&
      target !== "" &&
      this.isTaskGranted({
        taskId: request.taskId,
        ownerSid: task.ownerSid,
        deviceId: task.deviceId,
        target,
      });
    const bridge = new ExecutionBridge(transport, {
      policyContext: () => ({
        remoteAuthorization: this.authorization.state(),
        origin,
        preset: this.permissionPolicy.preset,
        taskGranted,
      }),
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
