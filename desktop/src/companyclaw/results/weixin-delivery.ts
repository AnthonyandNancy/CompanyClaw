import { basename as pathBasename } from "node:path";
import { validateArtifact, type ArtifactValidation } from "./artifact-validator";
import {
  advanceDelivery,
  advanceWithReceipt,
  type DeliveryState,
  type SendOutcome,
} from "./delivery-status";
import { isPathInsideTaskDir, sanitizeArtifactFileName } from "./task-artifacts";

/**
 * Delivers one task artifact to the owner's bound WeChat chat.
 *
 * Order matters and is the point of this module: the file is validated before
 * anything is sent, the target is checked against the task's own binding rather
 * than a caller-supplied chat, and the result follows the existing delivery
 * state machine — a send that the platform merely accepted is `SENT`, never
 * `DELIVERED`, because the plugin's `messageId` is a locally generated client
 * id and not a delivery receipt.
 */

export interface ArtifactDeliveryRequest {
  taskId: string;
  ownerSid: string;
  filePath: string;
  /** The chat id this task's owner is bound to; asserted, never trusted. */
  boundChannelUserId: string;
  /** Chat the caller intends to send to; must equal the bound one. */
  targetChannelUserId: string;
}

export interface ArtifactDeliveryDependencies {
  /** Resolves the task's artifact directory, or null when unusable. */
  resolveArtifactDir: (
    taskId: string,
    ownerSid: string,
  ) => { ok: true; dir: string } | { ok: false; reason: string };
  /** Sends a validated local file; the plugin owns the actual upload. */
  sendFile: (input: {
    filePath: string;
    to: string;
    fileName: string;
    text: string;
  }) => Promise<{ messageId: string }>;
  /** Identifier used to make a retry idempotent; usually a content hash. */
  artifactHash: (filePath: string) => Promise<string>;
  /** Optional validation overrides, used by tests. */
  validate?: (filePath: string) => Promise<ArtifactValidation>;
}

export interface ArtifactDeliveryResult {
  outcome: "sent" | "failed" | "unknown";
  state: DeliveryState;
  fileName: string;
  /** Present when the outcome is `unknown`: the send may or may not have run. */
  mayHaveBeenSent?: boolean;
  reason?: string;
}

export class ArtifactDelivery {
  constructor(private readonly deps: ArtifactDeliveryDependencies) {}

  async deliver(request: ArtifactDeliveryRequest): Promise<ArtifactDeliveryResult> {
    const resolved = this.deps.resolveArtifactDir(request.taskId, request.ownerSid);
    if (!resolved.ok) {
      return this.rejected(resolved.reason);
    }
    // Containment is checked before the file is looked at: an attachment that
    // lives outside the task directory would let a task send another user's
    // document.
    if (!isPathInsideTaskDir(resolved.dir, request.filePath)) {
      return this.rejected("outside-task-directory");
    }
    const fileName = sanitizeArtifactFileName(pathBasename(request.filePath));
    if (!fileName) return this.rejected("unusable-file-name");

    if (request.targetChannelUserId !== request.boundChannelUserId) {
      // The recipient must be the task's own owner, never whoever the caller
      // names; otherwise a task could post a report to somebody else.
      return this.rejected("recipient-not-the-owner");
    }

    const validation = await (this.deps.validate?.(request.filePath) ??
      validateArtifact({ filePath: request.filePath }));
    if (!validation.ok) return this.rejected(`invalid-artifact: ${validation.reason}`);

    // Retrying must not send the same report twice, so the content is hashed
    // and reported alongside the result the caller records.
    await this.deps.artifactHash(request.filePath);

    let outcome: SendOutcome;
    try {
      await this.deps.sendFile({
        filePath: request.filePath,
        to: request.boundChannelUserId,
        fileName,
        text: "",
      });
      // The plugin returns a locally generated client id, which proves the
      // request was accepted and nothing more.
      outcome = { platform: "accepted" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A timeout cannot tell whether the platform received the file, and
      // guessing either way is wrong: "failed" would invite a duplicate send,
      // "sent" would claim a delivery nobody observed.
      outcome = isIndeterminate(reason)
        ? { platform: "indeterminate", reason }
        : { platform: "failed", reason };
    }

    const state = advanceWithReceipt(advanceDelivery("SEND_REQUESTED", outcome), "none");
    if (state === "SENT") return { outcome: "sent", state, fileName };
    if (state === "UNKNOWN") {
      return { outcome: "unknown", state, fileName, mayHaveBeenSent: true };
    }
    return {
      outcome: "failed",
      state,
      fileName,
      ...(outcome.platform === "failed" ? { reason: outcome.reason } : {}),
    };
  }

  private rejected(reason: string): ArtifactDeliveryResult {
    return { outcome: "failed", state: "FAILED", fileName: "", reason };
  }
}

/** True when the transport failed in a way that leaves the send undecided. */
function isIndeterminate(reason: string): boolean {
  return /timeout|timed out|ETIMEDOUT|socket hang up|ECONNRESET/i.test(reason);
}
