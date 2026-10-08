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
      reasons: ["no system-level read-only proof; an unproven read must not be treated as R0"],
    };
  }

  if (action.kind === "local-work") {
    return { level: "R1", reasons: ["local non-writing work inside the authorized scope"] };
  }

  // write / unknown: an explicitly declared business write is R2, and every
  // other case also falls back to R2 because a tool name alone can never prove
  // safety.
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
      reasons: [
        ...classification.reasons,
        `remote authorization is ${context.remoteAuthorization}`,
      ],
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
