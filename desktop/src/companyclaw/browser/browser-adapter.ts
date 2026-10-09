import type { ApprovalTicket } from "../policy/approval-ticket";
import type { BrowserActionRisk } from "../policy/browser-policy";

/**
 * Controlled browser adapter: the only path from a remote task to a web action.
 *
 * Every remote web action passes the runtime's own authorization first (domain
 * allow list, capability switches and live remote authorization), then the risk
 * class decides whether a single-use approval ticket is required. The adapter
 * never calls the executor for an action that was not cleared, and a write is
 * only reported as complete when a read-back confirmed it.
 *
 * The executor and the read-back are injected, so this module owns the policy
 * and the sequencing only. See ADR 0004 for why the bundled OpenClaw browser
 * tool cannot be relied on as the interception point.
 */

export interface BrowserRunInput {
  taskId: string;
  stepId: string;
  action: string;
  url: string;
  params?: Record<string, unknown>;
  /** Required for `write` actions; ignored for reads. */
  approvalTicket?: ApprovalTicket;
}

export interface BrowserActionAuthorization {
  authorize: (request: {
    action: string;
    url: string;
  }) => { allowed: true; risk: BrowserActionRisk } | { allowed: false; reason: string };
}

export interface BrowserExecutorInput {
  taskId: string;
  stepId: string;
  action: string;
  url: string;
  params: Record<string, unknown>;
  approvalTicket?: ApprovalTicket;
}

export type BrowserExecutor = (
  input: BrowserExecutorInput,
) => Promise<{ ok: true; detail: string } | { ok: false; reason: string }>;

export type BrowserReadBack = (input: {
  taskId: string;
  stepId: string;
  action: string;
  url: string;
  expected: string;
}) => Promise<{ matched: true } | { matched: false; reason: string }>;

export type BrowserRunResult =
  | { outcome: "verified"; risk: "read" | "write"; detail: string }
  | { outcome: "partial"; reason: string }
  | { outcome: "denied"; reason: string }
  | { outcome: "unavailable"; reason: string };

export interface BrowserAdapterDependencies {
  authorization: BrowserActionAuthorization;
  execute: BrowserExecutor;
  /** Verifies the action landed. Required for every action that writes. */
  readBack: BrowserReadBack;
}

export class BrowserAdapter {
  constructor(private readonly deps: BrowserAdapterDependencies) {}

  /** Decides and, when cleared, runs one browser action. */
  async run(input: BrowserRunInput): Promise<BrowserRunResult> {
    const authorization = this.deps.authorization.authorize({
      action: input.action,
      url: input.url,
    });
    if (!authorization.allowed) {
      return { outcome: "denied", reason: authorization.reason };
    }
    const risk = authorization.risk;
    if (risk === "high-risk") {
      // R3 has no switch: remote mode refuses it regardless of approvals.
      return { outcome: "denied", reason: "high-risk-action" };
    }
    if (risk === "write" && !input.approvalTicket) {
      // Never reach the executor for an unapproved write. The ticket is also
      // re-verified by the execution bridge and the target itself, so this is
      // one gate of several rather than the only one.
      return { outcome: "denied", reason: "approval-required" };
    }

    let executed: { ok: true; detail: string } | { ok: false; reason: string };
    try {
      executed = await this.deps.execute({
        taskId: input.taskId,
        stepId: input.stepId,
        action: input.action,
        url: input.url,
        params: input.params ?? {},
        ...(input.approvalTicket ? { approvalTicket: input.approvalTicket } : {}),
      });
    } catch (error) {
      return {
        outcome: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!executed.ok) return { outcome: "denied", reason: executed.reason };

    const verified = await this.deps.readBack({
      taskId: input.taskId,
      stepId: input.stepId,
      action: input.action,
      url: input.url,
      expected: executed.detail,
    });
    if (!verified.matched) {
      // The action may have landed; we could not prove it. Reporting success
      // here is exactly the claim the requirements forbid.
      return { outcome: "partial", reason: verified.reason };
    }
    return { outcome: "verified", risk, detail: executed.detail };
  }
}
