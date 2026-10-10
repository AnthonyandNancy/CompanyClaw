import {
  isLocallyConfirmable,
  isNeverAllowed,
  isRoutine,
  type ActionCategory,
} from "./action-category";
import { isRemoteOrigin, resolveOrigin, type ExecutionOrigin } from "./execution-origin";
import { presetSuppressesRoutinePrompts, type PermissionPreset } from "./permission-preset";

export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type PolicyDecision = "allow" | "require-approval" | "deny";
export type RemoteAuthorizationState = "disabled" | "enabled" | "expired" | "revoked";

export type ReadOnlyProof =
  | "read-only-account"
  | "read-only-acl"
  | "verified-no-side-effect-action-set";

/**
 * Action kinds.
 *
 * The first group is the V1 vocabulary and is kept verbatim so existing callers
 * and tests keep their meaning. The second group expresses the V5 consequence
 * split (rulings Q-A / Q-B): the coarse `delete` no longer stands for both
 * "move to recycle bin" and "erase forever", and `publish` no longer stands for
 * both "send one chat message" and "broadcast to a group".
 */
export type ActionKind =
  // ── V1 vocabulary (unchanged meaning) ──
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
  | "bypass-security"
  // ── V5 consequence split ──
  | "delete-to-recycle-bin"
  | "delete-permanent"
  | "delete-batch-irreversible"
  | "overwrite-recoverable"
  | "overwrite-unrecoverable"
  | "task-temp-cleanup"
  | "message-single-recipient"
  | "message-group"
  | "message-bulk"
  | "publish-public"
  | "sensitive-exfil"
  | "attachment-to-third-party"
  | "attachment-bulk"
  | "high-risk";

const KIND_TO_CATEGORY: Readonly<Record<ActionKind, ActionCategory>> = {
  read: "read",
  "local-work": "local-work",
  write: "write",
  unknown: "unknown",
  // `high-risk` means "the caller could not characterise the consequence".
  // V5 §7.3 requires stopping rather than guessing, so it stays R3.
  "high-risk": "high-risk",
  // `delete` predates the split and meant "destructive": the conservative
  // reading is the irreversible one, so it keeps the strict decision.
  delete: "delete-permanent",
  payment: "payment",
  publish: "publish-public",
  "system-config": "system-config",
  registry: "system-config",
  "arbitrary-command": "arbitrary-command",
  "unknown-program": "unknown-program",
  "bypass-security": "bypass-security",
  "delete-to-recycle-bin": "delete-to-recycle-bin",
  "delete-permanent": "delete-permanent",
  "delete-batch-irreversible": "delete-batch-irreversible",
  "overwrite-recoverable": "overwrite-recoverable",
  "overwrite-unrecoverable": "overwrite-unrecoverable",
  "task-temp-cleanup": "task-temp-cleanup",
  "message-single-recipient": "message-single-recipient",
  "message-group": "message-group",
  "message-bulk": "message-bulk",
  "publish-public": "publish-public",
  "sensitive-exfil": "sensitive-exfil",
  "attachment-to-third-party": "attachment-to-third-party",
  "attachment-bulk": "attachment-bulk",
};

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
  /**
   * Recipients of an outbound message, when the caller knows them. Used only to
   * corroborate the declared kind: a "single recipient" action that names more
   * than one recipient is a broadcast and is re-classified as one.
   */
  recipients?: readonly string[];
}

export interface PolicyContext {
  remoteAuthorization: RemoteAuthorizationState;
  /** Where the request entered the system. Defaults to the remote channel. */
  origin?: ExecutionOrigin;
  /** The employee's chosen preset; it only changes routine-prompt behaviour. */
  preset?: PermissionPreset;
  /** True when an unexpired task-scope grant covers this exact target. */
  taskGranted?: boolean;
}

export interface Classification {
  level: RiskLevel;
  reasons: string[];
}

export function categoryFor(kind: ActionKind, action?: ActionDescriptor): ActionCategory {
  const declared = KIND_TO_CATEGORY[kind];
  // A message that names several recipients is a broadcast no matter what the
  // caller declared; the audience, not the label, decides.
  if (
    (declared === "message-single-recipient" || declared === "attachment-to-third-party") &&
    action?.recipients &&
    action.recipients.length > 1
  ) {
    return declared === "message-single-recipient" ? "message-bulk" : "attachment-bulk";
  }
  return declared;
}

function levelForCategory(category: ActionCategory): RiskLevel {
  if (category === "local-work" || category === "task-temp-cleanup") return "R1";
  if (isNeverAllowed(category)) return "R3";
  if (
    category === "delete-permanent" ||
    category === "delete-batch-irreversible" ||
    category === "overwrite-unrecoverable" ||
    category === "message-group" ||
    category === "message-bulk" ||
    category === "publish-public" ||
    category === "sensitive-exfil" ||
    category === "attachment-bulk"
  ) {
    return "R3";
  }
  // write / unknown / recycle-bin delete / recoverable overwrite / single
  // recipient message: a business write that needs a confirmation.
  return "R2";
}

export function classifyAction(action: ActionDescriptor): Classification {
  const category = categoryFor(action.kind, action);

  if (action.kind === "read") {
    if (action.readOnlyProof) {
      return { level: "R0", reasons: [`read-only proven by ${action.readOnlyProof}`] };
    }
    return {
      level: "R2",
      reasons: ["no system-level read-only proof; an unproven read must not be treated as R0"],
    };
  }

  const level = levelForCategory(category);
  const reasons = [`${action.kind} maps to ${category}, which is ${level}`];
  if (level === "R3" && isNeverAllowed(category)) {
    reasons.push(`${category} is refused on every channel`);
  }
  return { level, reasons };
}

/**
 * Decides one action.
 *
 * The order encodes the ruling Q3 precedence chain where it is observable at
 * this layer: an unbypassable rule first, then the channel's own authorization
 * state, then the task scope, and only then the confirmation prompt.
 *
 * The remote channel keeps its historical behaviour exactly: any action whose
 * risk is R3 is refused, and nothing at all runs without a live remote
 * authorization. The local channel is *not* short-circuited by the remote
 * switch — ruling Q-A states plainly that a remote prohibition must not disable
 * local file management — but it still refuses the categories that no channel
 * may perform.
 */
export function decideAction(
  action: ActionDescriptor,
  context: PolicyContext,
): Classification & { decision: PolicyDecision } {
  const classification = classifyAction(action);
  const category = categoryFor(action.kind, action);
  const origin = resolveOrigin(context.origin);
  const remote = isRemoteOrigin(origin);

  if (classification.level === "R3" && isNeverAllowed(category)) {
    return {
      ...classification,
      decision: "deny",
      reasons: [...classification.reasons, `${category} has no override on any channel`],
    };
  }

  if (remote && classification.level === "R3") {
    return {
      ...classification,
      decision: "deny",
      reasons: [...classification.reasons, `remote mode forbids ${category}`],
    };
  }

  if (remote && context.remoteAuthorization !== "enabled") {
    return {
      ...classification,
      decision: "deny",
      reasons: [
        ...classification.reasons,
        `remote authorization is ${context.remoteAuthorization}`,
      ],
    };
  }

  // A covered target inside an authorized task runs without a second prompt
  // only when the employee enabled the daily preset; BASIC still asks.
  if (
    context.taskGranted &&
    classification.level === "R2" &&
    presetSuppressesRoutinePrompts(context.preset ?? "BASIC")
  ) {
    return {
      ...classification,
      decision: "allow",
      reasons: [...classification.reasons, "covered by the task scope under FULL_DAILY"],
    };
  }

  if (classification.level === "R0" || classification.level === "R1" || isRoutine(category)) {
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

  if (!isLocallyConfirmable(category)) {
    return {
      ...classification,
      decision: "deny",
      reasons: [...classification.reasons, `${category} cannot be authorized here`],
    };
  }

  return { ...classification, decision: "require-approval" };
}
