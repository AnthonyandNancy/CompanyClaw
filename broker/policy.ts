import { isMutatingOperation, type BrokerRequest } from "./protocol";

/**
 * Server-side enforcement for the Windows Execution Broker.
 *
 * Requirement V1.1 (conflict 3): the broker must implement its own permission
 * checks, target-application restrictions and user-session isolation. The agent
 * side is not trusted, and a Click/Type-style operation is never treated as safe
 * just because of its name — mutations need a verified single-use ticket.
 */

export interface BrokerPolicyConfig {
  /** SID of the Windows user this broker instance serves. */
  ownerSid: string;
  /** Device identity bound to this broker instance. */
  deviceId: string;
  /** Executable base names (without .exe) the broker may touch. */
  allowedProcesses: readonly string[];
  /** Optional extra restriction on window titles (substring, case-insensitive). */
  allowedWindowTitles: readonly string[];
  /** Mutating operations always require a verified ticket. */
  requireApprovalForMutations: boolean;
}

export type BrokerDenialReason =
  | "owner-mismatch"
  | "device-mismatch"
  | "expired"
  | "not-yet-valid"
  | "target-required"
  | "process-not-allowed"
  | "window-title-not-allowed"
  | "approval-required"
  | "invalid-approval-ticket";

export type BrokerAuthorization =
  | { allowed: true }
  | { allowed: false; reason: BrokerDenialReason };

interface BrokerPolicyDependencies {
  now?: () => Date;
  /** Verifies the single-use ticket against the exact request payload. */
  verifyTicket?: (request: BrokerRequest) => boolean;
}

/** Operations that address a specific window and therefore need a target. */
const TARGET_REQUIRED = new Set([
  "describe-element",
  "find-elements",
  "read-value",
  "invoke-pattern",
  "set-value",
  "send-keys",
  "wait-for-window",
]);

export class BrokerPolicy {
  private readonly now: () => Date;
  private readonly verifyTicket: (request: BrokerRequest) => boolean;

  constructor(
    private readonly config: BrokerPolicyConfig,
    dependencies: BrokerPolicyDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.verifyTicket = dependencies.verifyTicket ?? (() => false);
  }

  authorize(request: BrokerRequest): BrokerAuthorization {
    // 1. Identity: a request from another user or device is never served, even
    //    if every other field looks correct.
    if (request.ownerSid !== this.config.ownerSid) {
      return { allowed: false, reason: "owner-mismatch" };
    }
    if (request.deviceId !== this.config.deviceId) {
      return { allowed: false, reason: "device-mismatch" };
    }

    // 2. Freshness.
    const now = this.now().getTime();
    const issuedAt = Date.parse(request.issuedAt);
    const expiresAt = Date.parse(request.expiresAt);
    if (now < issuedAt) return { allowed: false, reason: "not-yet-valid" };
    if (now >= expiresAt) return { allowed: false, reason: "expired" };

    // 3. Target application.
    if (TARGET_REQUIRED.has(request.operation) && !request.target?.processName) {
      return { allowed: false, reason: "target-required" };
    }
    if (request.target?.processName) {
      if (!this.isProcessAllowed(request.target.processName)) {
        return { allowed: false, reason: "process-not-allowed" };
      }
    }
    if (request.target?.windowTitle && this.config.allowedWindowTitles.length > 0) {
      const title = request.target.windowTitle.toLowerCase();
      const ok = this.config.allowedWindowTitles.some((allowed) =>
        title.includes(allowed.toLowerCase()),
      );
      if (!ok) return { allowed: false, reason: "window-title-not-allowed" };
    }

    // 4. Mutation gate. A generic Click/Type reaches the same gate as an
    //    explicit write, because a tool name can never prove safety.
    if (isMutatingOperation(request.operation)) {
      if (this.config.requireApprovalForMutations) {
        if (!request.approvalTicket) {
          return { allowed: false, reason: "approval-required" };
        }
        if (!this.verifyTicket(request)) {
          return { allowed: false, reason: "invalid-approval-ticket" };
        }
      }
    }

    return { allowed: true };
  }

  private isProcessAllowed(processName: string): boolean {
    const normalized = processName.replace(/\.exe$/i, "").toLowerCase();
    return this.config.allowedProcesses.some(
      (allowed) => allowed.replace(/\.exe$/i, "").toLowerCase() === normalized,
    );
  }
}
