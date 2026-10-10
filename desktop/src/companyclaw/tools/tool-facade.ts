import type { ApprovalBinding, ApprovalTicket } from "../policy/approval-ticket";
import type { ActionDescriptor, PolicyDecision } from "../policy/risk-classifier";
import type { ExecutionOrigin } from "../policy/execution-origin";
import type { PermissionPreset } from "../policy/permission-preset";
import {
  validateToolCall,
  type AgentToolCall,
  type AgentToolDefinition,
  type ToolCallContext,
  type ToolCallRejection,
} from "./computer-use-tools";

/**
 * The single entry point from an agent tool call to the execution layer.
 *
 * Requirement V5 §5.6 and §7.1 describe one chain — tool call, task, policy,
 * broker — and this is where it is assembled. The facade owns no decisions of
 * its own: it validates the call's *shape*, asks the policy for a verdict, and
 * dispatches. That division matters, because it means there is exactly one place
 * that can turn a tool name into an action, and exactly one place that can say
 * "yes".
 *
 * The interesting behaviour is what happens on each verdict:
 *
 *   * `allow`              → dispatch immediately, and record that it ran
 *                            without a prompt (the audit needs to show *why*
 *                            nothing was asked);
 *   * `require-approval`   → raise an approval and stop. Nothing is dispatched
 *                            until a ticket for this exact action comes back;
 *   * `deny`               → refuse, with the policy's own reason.
 */

/** What the policy layer needs to answer one call. */
export interface FacadePolicyInput {
  action: ActionDescriptor;
  origin: ExecutionOrigin;
  preset: PermissionPreset;
  taskId: string;
  target: string;
}

export interface FacadePolicyVerdict {
  decision: PolicyDecision;
  reason: string;
  /** Set when the decision came from a task-scope grant under FULL_DAILY. */
  autoAllowedByTaskScope?: boolean;
}

export interface FacadeApprovalRequest {
  action: ActionDescriptor;
  binding: Partial<ApprovalBinding>;
  resolutionChannel: "local" | "weixin";
  actionCategory: string;
}

export interface FacadeDispatch {
  tool: AgentToolDefinition;
  arguments: Record<string, unknown>;
  taskId: string;
  stepId: string;
  /**
   * The credential for this exact call, when the policy allowed it outright.
   *
   * Mints nothing and authorizes nothing on its own: it is the execution side's
   * proof that *this* request was cleared, which the transport converts into the
   * broker's own ticket.
   */
  executionGrant?: FacadeExecutionGrant;
  /** Present only when the call is resuming a granted approval. */
  approvalTicket?: ApprovalTicket;
  binding?: ApprovalBinding;
}

export interface FacadeExecutionGrant {
  action: ActionDescriptor;
  origin: ExecutionOrigin;
  target: string;
}

export type FacadeDispatchResult =
  | { outcome: "executed"; detail: string }
  | { outcome: "denied"; reason: string }
  | { outcome: "unavailable"; reason: string };

export interface ToolFacadeDependencies {
  /** The single policy verdict for one call. */
  decide: (input: FacadePolicyInput) => FacadePolicyVerdict;
  /** Raises an approval and returns its id, or null when it cannot be raised. */
  requestApproval: (
    input: FacadeApprovalRequest,
  ) => Promise<{ approvalId: string; binding: ApprovalBinding } | null>;
  /**
   * Issues the execution credential after an approval was granted.
   *
   * Both halves are returned together: the bridge verifies the ticket against
   * the binding it was signed for, so handing back only the ticket would make
   * every resumed call fail its own check.
   */
  issueTicket: (input: { approvalId: string; ownerSid: string }) => {
    ticket: ApprovalTicket;
    binding: ApprovalBinding;
  };
  /** Runs the action through the bridge; the facade never bypasses it. */
  dispatch: (input: FacadeDispatch) => Promise<FacadeDispatchResult>;
  /** Tamper-evident record of what was allowed, refused or deferred. */
  recordAudit: (entry: {
    taskId: string;
    stepId: string;
    tool: string;
    origin: ExecutionOrigin;
    decision: PolicyDecision | "invalid-call";
    reason: string;
    autoAllowed: boolean;
    approvalId?: string;
  }) => void;
  now?: () => Date;
}

export type ToolFacadeResult =
  | { status: "executed"; detail: string; taskId: string; stepId: string }
  | { status: "approval-required"; approvalId: string; reason: string }
  | { status: "denied"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "rejected"; reason: ToolCallRejection };

export class ComputerUseToolFacade {
  constructor(private readonly deps: ToolFacadeDependencies) {}

  /**
   * Handles one call from the agent.
   *
   * `approvalId` is optional and only meaningful on a second attempt: the caller
   * passes back the id it received so the facade can attach the ticket. A model
   * cannot supply it — `validateToolCall` refuses a call whose arguments carry
   * one.
   */
  async handle(input: {
    call: AgentToolCall;
    context: ToolCallContext | null;
    preset: PermissionPreset;
    approvalId?: string;
  }): Promise<ToolFacadeResult> {
    const validation = validateToolCall(input.call, input.context);
    if (!validation.ok) {
      this.deps.recordAudit({
        taskId: input.context?.taskId ?? "",
        stepId: input.context?.stepId ?? "",
        tool: input.call.tool,
        origin: input.context?.origin ?? "weixin-private",
        decision: "invalid-call",
        reason: validation.reason,
        autoAllowed: false,
      });
      return { status: "rejected", reason: validation.reason };
    }

    const context = input.context;
    if (!context) return { status: "rejected", reason: "missing-task-context" };
    const definition = validation.definition;

    const action = describeAction(definition);
    const target = describeTarget(input.call.arguments);
    const verdict = this.deps.decide({
      action,
      origin: context.origin,
      preset: input.preset,
      taskId: context.taskId,
      target,
    });

    if (verdict.decision === "deny") {
      this.deps.recordAudit({
        taskId: context.taskId,
        stepId: context.stepId,
        tool: definition.name,
        origin: context.origin,
        decision: "deny",
        reason: verdict.reason,
        autoAllowed: false,
      });
      return { status: "denied", reason: verdict.reason };
    }

    if (verdict.decision === "require-approval") {
      // A second attempt that carries an approval id is resuming a granted
      // request; anything else needs a fresh one.
      if (input.approvalId) {
        return await this.dispatchApproved(input.approvalId, definition, input.call, context);
      }
      const raised = await this.deps.requestApproval({
        action,
        binding: {
          deviceId: context.deviceId,
          taskId: context.taskId,
          stepId: context.stepId,
          targetSystem: target,
          actionType: definition.capability,
        },
        resolutionChannel: context.origin === "local-ui" ? "local" : "weixin",
        actionCategory: String(action.kind),
      });
      if (!raised) {
        return { status: "denied", reason: "approval-could-not-be-raised" };
      }
      this.deps.recordAudit({
        taskId: context.taskId,
        stepId: context.stepId,
        tool: definition.name,
        origin: context.origin,
        decision: "require-approval",
        reason: verdict.reason,
        autoAllowed: false,
        approvalId: raised.approvalId,
      });
      return {
        status: "approval-required",
        approvalId: raised.approvalId,
        reason: verdict.reason,
      };
    }

    // Allowed outright.
    //
    // No approval is raised here: a record the employee is asked to answer would
    // be exactly the repeated prompt this feature exists to remove. A mutating
    // call instead carries an execution grant describing the exact action, which
    // the transport turns into the broker's own single-call credential.
    const grant: FacadeExecutionGrant | undefined = definition.mutating
      ? { action, origin: context.origin, target }
      : undefined;

    this.deps.recordAudit({
      taskId: context.taskId,
      stepId: context.stepId,
      tool: definition.name,
      origin: context.origin,
      decision: "allow",
      reason: verdict.reason,
      autoAllowed: verdict.autoAllowedByTaskScope === true,
    });

    return await this.dispatchOnce(definition, input.call, context, grant, undefined, undefined);
  }

  private async dispatchApproved(
    approvalId: string,
    definition: AgentToolDefinition,
    call: AgentToolCall,
    context: ToolCallContext,
  ): Promise<ToolFacadeResult> {
    let issued: { ticket: ApprovalTicket; binding: ApprovalBinding };
    try {
      issued = this.deps.issueTicket({ approvalId, ownerSid: context.ownerSid });
    } catch (error) {
      // An approval that was denied, expired or already consumed cannot produce
      // a ticket; that is a refusal, not a retryable fault.
      return {
        status: "denied",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    this.deps.recordAudit({
      taskId: context.taskId,
      stepId: context.stepId,
      tool: definition.name,
      origin: context.origin,
      decision: "allow",
      reason: "已获批准的敏感操作",
      autoAllowed: false,
      approvalId,
    });
    return await this.dispatchOnce(definition, call, context, undefined, issued.ticket, issued.binding);
  }

  private async dispatchOnce(
    definition: AgentToolDefinition,
    call: AgentToolCall,
    context: ToolCallContext,
    grant: FacadeExecutionGrant | undefined,
    ticket: ApprovalTicket | undefined,
    binding: ApprovalBinding | undefined,
  ): Promise<ToolFacadeResult> {
    const dispatched = await this.deps.dispatch({
      tool: definition,
      arguments: call.arguments,
      taskId: context.taskId,
      stepId: context.stepId,
      ...(grant ? { executionGrant: grant } : {}),
      ...(ticket ? { approvalTicket: ticket } : {}),
      ...(binding ? { binding } : {}),
    });
    switch (dispatched.outcome) {
      case "executed":
        return {
          status: "executed",
          detail: dispatched.detail,
          taskId: context.taskId,
          stepId: context.stepId,
        };
      case "denied":
        return { status: "denied", reason: dispatched.reason };
      case "unavailable":
        return { status: "unavailable", reason: dispatched.reason };
    }
  }
}

/**
 * Describes the action a tool call represents.
 *
 * The mapping is intentionally conservative: anything whose consequence the
 * product cannot characterise becomes `high-risk`, which is refused on every
 * channel rather than guessed at (V5 §7.3).
 */
export function describeAction(definition: AgentToolDefinition): ActionDescriptor {
  const base: ActionDescriptor = {
    kind: "read",
    toolName: definition.name,
    // The broker's closed operation set makes these genuinely side-effect free:
    // reading a window list, an element tree, a control value or a verification
    // snapshot performs no invocation, no value write and no key input, which is
    // what `verified-no-side-effect-action-set` asserts. Without the proof the
    // second gate (the execution bridge) would still treat an unproven read as a
    // business write and refuse it — correctly, since a bare tool name proves
    // nothing.
    readOnlyProof: "verified-no-side-effect-action-set",
  };
  switch (definition.name) {
    case "list-installed-apps":
    case "list-windows":
    case "snapshot-ui-tree":
    case "find-control":
    case "read-control":
    case "verify-state":
    case "wait-for-condition":
    case "inspect-dialog":
      return base;
    case "screenshot":
      // Reading the screen is not a business write, but it is also not a
      // no-side-effect read: it is gated by the vision authorization, which the
      // policy layer checks separately.
      return base;
    case "launch-app":
    case "focus-window":
      return { kind: "write", toolName: definition.name, writesBusinessData: false };
    case "click":
    case "type-text":
    case "hotkey":
    case "scroll":
    case "drag-drop": {
      // A pointer or keyboard action on an unknown target is the case the
      // requirement says must not be guessed at. When the caller can name the
      // window and the action is a plain navigation step it stays a write; a
      // drag of a file is treated as an outbound attachment because that is what
      // it most often is.
      if (definition.name === "drag-drop") {
        return { kind: "attachment-to-third-party", toolName: definition.name };
      }
      return { kind: "write", toolName: definition.name, writesBusinessData: true };
    }
    default:
      return { kind: "high-risk", toolName: definition.name };
  }
}

/**
 * The target a call addresses, used for the task-scope check and the audit.
 *
 * A pointer action without a named window still has to be describable, because
 * the approval the employee reads must say what will be clicked. A coordinate is
 * therefore rendered as its own target rather than left blank — a blank target
 * would make the request unraisable, which is the opposite of asking.
 */
export function describeTarget(args: Record<string, unknown>): string {
  for (const key of ["app", "windowTitle", "window", "targetWindow", "label"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const point = readPoint(args);
  if (point) return `屏幕坐标 (${point[0]}, ${point[1]})`;
  const text = args.text;
  if (typeof text === "string" && text.trim()) return `文本输入：${text.trim().slice(0, 40)}`;
  return "";
}

function readPoint(args: Record<string, unknown>): [number, number] | null {
  const candidate = args.loc ?? args;
  if (Array.isArray(candidate)) {
    const [x, y] = candidate;
    if (typeof x === "number" && typeof y === "number") return [Math.round(x), Math.round(y)];
    return null;
  }
  const x = args.x;
  const y = args.y;
  if (typeof x === "number" && typeof y === "number") return [Math.round(x), Math.round(y)];
  return null;
}
