import type { ExecutionOrigin } from "../policy/execution-origin";
import { DEFAULT_PRESET, presetAfterMigration, type PermissionPreset } from "../policy/permission-preset";

/**
 * The single versioned permission document.
 *
 * Requirement V5 §4.6 and ruling Q8 ask for one authoritative record of what
 * the owner has actually granted, with a version that the UI, the Gateway and
 * every executor can compare. Before this file the grants were spread over four
 * store files and two of them (remote authorization, browser policy) did not
 * survive a restart at all, so the UI could show a state the executors no
 * longer honoured.
 *
 * Scope rules that the shape itself encodes:
 *   * a trusted app or site is scoped `local`, `remote` or `both` — a grant made
 *     on this machine must not silently become a remote grant;
 *   * a task grant is bound to one task id, one owner SID and one origin, so it
 *     can never be replayed by another task or another channel;
 *   * vision authorization is separate for local and remote, and carries the
 *     provider it was granted for, because sending screen data to a provider is
 *     not the same consent as operating the desktop.
 */

export const PERMISSION_POLICY_CONTRACT = "companyclaw.permission-policy.v2";
export const PERMISSION_POLICY_SCHEMA = 2;

export type GrantScope = "local" | "remote" | "both";

export interface RemoteAuthorizationRecord {
  enabled: boolean;
  ownerSid: string;
  deviceId: string;
  channelUserId: string;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface TrustedAppRecord {
  /** Normalized executable base name; the only matching key. */
  processName: string;
  displayName: string;
  /** Where the trust came from; a migrated entry is never treated as fresh. */
  source: "installed-catalog" | "user-selected";
  scope: GrantScope;
  publisher: string | null;
  /** Normalized final executable path, when known. */
  executablePath: string | null;
  fileHash: string | null;
  approvedSid: string;
  approvedAt: string;
  /** True for entries carried over from the pre-V5 allow list. */
  legacy: boolean;
}

export interface TrustedSiteRecord {
  domain: string;
  kind: "enterprise-static" | "user-trusted" | "task-ephemeral";
  taskId: string | null;
  expiresAt: string | null;
  addedAt: string;
}

export interface WorkFolderRecord {
  path: string;
  access: "read" | "write";
  scope: GrantScope;
  grantedAt: string;
}

export interface TaskGrantRecord {
  taskId: string;
  ownerSid: string;
  deviceId: string;
  origin: ExecutionOrigin;
  /** Application names, domains and folders covered by this task. */
  targets: string[];
  createdAt: string;
  expiresAt: string;
}

export interface VisionAuthorizationRecord {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  /** Which windows may be captured, e.g. "target-window" or "task-scope". */
  captureScope: string;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface PermissionPolicy {
  contract: typeof PERMISSION_POLICY_CONTRACT;
  schemaVersion: typeof PERMISSION_POLICY_SCHEMA;
  preset: PermissionPreset;
  /** Bumped on every change that affects a decision. */
  policyVersion: number;
  presetChangedAt: string | null;
  remote: RemoteAuthorizationRecord;
  trustedApps: TrustedAppRecord[];
  trustedSites: TrustedSiteRecord[];
  workFolders: WorkFolderRecord[];
  taskGrants: TaskGrantRecord[];
  vision: { local: VisionAuthorizationRecord; remote: VisionAuthorizationRecord };
  /** References to pre-V5 rules kept for review; never widened on migration. */
  legacyRuleReferences: { source: string; value: string }[];
  enterpriseRestrictions: { managed: boolean; stricterRules: string[] };
}

export const OPTIONAL_VISION_OFF: VisionAuthorizationRecord = {
  enabled: false,
  provider: "",
  baseUrl: "",
  model: "",
  captureScope: "target-window",
  grantedAt: null,
  expiresAt: null,
  revokedAt: null,
};

export const EMPTY_REMOTE_AUTHORIZATION: RemoteAuthorizationRecord = {
  enabled: false,
  ownerSid: "",
  deviceId: "",
  channelUserId: "",
  grantedAt: null,
  expiresAt: null,
  revokedAt: null,
};

/** The safe state: nothing granted, nothing authorized. */
export function createEmptyPermissionPolicy(): PermissionPolicy {
  return {
    contract: PERMISSION_POLICY_CONTRACT,
    schemaVersion: PERMISSION_POLICY_SCHEMA,
    preset: DEFAULT_PRESET,
    policyVersion: 1,
    presetChangedAt: null,
    remote: { ...EMPTY_REMOTE_AUTHORIZATION },
    trustedApps: [],
    trustedSites: [],
    workFolders: [],
    taskGrants: [],
    vision: { local: { ...OPTIONAL_VISION_OFF }, remote: { ...OPTIONAL_VISION_OFF } },
    legacyRuleReferences: [],
    enterpriseRestrictions: { managed: false, stricterRules: [] },
  };
}

export function isPermissionPolicy(value: unknown): value is PermissionPolicy {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PermissionPolicy>;
  return (
    candidate.contract === PERMISSION_POLICY_CONTRACT &&
    candidate.schemaVersion === PERMISSION_POLICY_SCHEMA &&
    typeof candidate.policyVersion === "number" &&
    Array.isArray(candidate.trustedApps) &&
    Array.isArray(candidate.trustedSites) &&
    Array.isArray(candidate.taskGrants) &&
    Array.isArray(candidate.workFolders) &&
    typeof candidate.vision === "object" &&
    candidate.vision !== null
  );
}

/** Every user-granted authority removed; system restrictions untouched. */
export function clearUserGrants(policy: PermissionPolicy): PermissionPolicy {
  return {
    ...policy,
    preset: DEFAULT_PRESET,
    presetChangedAt: null,
    policyVersion: policy.policyVersion + 1,
    remote: { ...EMPTY_REMOTE_AUTHORIZATION },
    trustedApps: [],
    trustedSites: [],
    workFolders: [],
    taskGrants: [],
    vision: { local: { ...OPTIONAL_VISION_OFF }, remote: { ...OPTIONAL_VISION_OFF } },
  };
}

export interface TrustedAppInput {
  processName: string;
  displayName?: string;
  source?: TrustedAppRecord["source"];
  scope?: GrantScope;
  publisher?: string | null;
  executablePath?: string | null;
  fileHash?: string | null;
  legacy?: boolean;
}

/**
 * Normalizes one application entry, or null when it cannot express a single
 * executable.
 *
 * The rejection rules are the pre-V5 broker rules kept verbatim: a path, a
 * wildcard or a shell metacharacter would turn "which application may be
 * automated" into "which file may be executed", and a blank entry must never
 * become a wildcard.
 */
export function normalizeTrustedApp(input: TrustedAppInput): TrustedAppRecord | null {
  const raw = typeof input.processName === "string" ? input.processName.trim() : "";
  if (!raw) return null;
  if (/[\\/*?;:|<>"]/.test(raw)) return null;
  if (/\s/.test(raw)) return null;
  const withoutExtension = raw.replace(/\.exe$/i, "");
  if (!withoutExtension || withoutExtension === "*") return null;
  return {
    processName: withoutExtension.toLowerCase(),
    displayName: input.displayName?.trim() || withoutExtension,
    source: input.source ?? "user-selected",
    scope: input.scope ?? "local",
    publisher: input.publisher ?? null,
    executablePath: input.executablePath ?? null,
    fileHash: input.fileHash ?? null,
    approvedSid: "",
    approvedAt: "",
    legacy: input.legacy === true,
  };
}

/** Normalizes a domain the same way the browser policy does. */
export function normalizeTrustedDomain(raw: string): string | null {
  const trimmed = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!trimmed) return null;
  if (/[\s/:]/.test(trimmed) && !/^\[[0-9a-f:]+\]$/.test(trimmed)) return null;
  return trimmed;
}

export function presetOrDefault(value: unknown): PermissionPreset {
  return presetAfterMigration(value);
}
