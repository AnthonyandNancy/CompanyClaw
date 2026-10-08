import { decideAction, type ActionDescriptor, type PolicyContext } from "../policy/risk-classifier";
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
 * R0-R3 decision *before* the transport is reached and fails closed on every
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
      // Consume before dispatch so a crash mid-flight cannot be replayed.
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
