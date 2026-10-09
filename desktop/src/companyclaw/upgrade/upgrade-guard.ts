import { COMPANYCLAW_APPROVAL_SCHEMA } from "../approvals/approval-store";
import { COMPANYCLAW_BROKER_TARGETS_SCHEMA } from "../broker-targets";
import { COMPANYCLAW_IDENTITY_SCHEMA } from "../remote/identity-binding";
import { COMPANYCLAW_TASK_SCHEMA } from "../tasks/task-store";
import { RUNTIME_MANIFEST_CONTRACT } from "../runtime-manifest";

/**
 * Decides whether an installed copy may be replaced by an incoming one.
 *
 * Two things must survive an upgrade untouched — the owner's credentials and
 * binding, and the task/approval history — so the check refuses to start when
 * the incoming build cannot read what is already on disk. A blocked upgrade
 * leaves the previous installation intact: reporting the problem is better than
 * silently resetting an API key or a WeChat binding.
 *
 * The schemas are imported from the stores that own them rather than listed
 * here, so this guard cannot drift from the formats it is checking.
 */

export const COMPANYCLAW_DATA_SCHEMAS = {
  tasks: COMPANYCLAW_TASK_SCHEMA,
  approvals: COMPANYCLAW_APPROVAL_SCHEMA,
  identity: COMPANYCLAW_IDENTITY_SCHEMA,
  brokerTargets: COMPANYCLAW_BROKER_TARGETS_SCHEMA,
} as const;

export type CompanyClawDataKey = keyof typeof COMPANYCLAW_DATA_SCHEMAS;

export interface UpgradePlanInput {
  /** Version of the installation currently on disk (null when none). */
  installedVersion: string | null;
  /** Version of the build being installed. */
  incomingVersion: string;
  /** Manifest carried by the incoming build, when it has one. */
  manifest: { contract?: unknown; entries?: unknown } | null;
  /**
   * Schema versions found on disk. A missing key means that file is absent,
   * which is normal on a fresh machine and never blocks anything.
   */
  onDiskSchemas: Partial<Record<CompanyClawDataKey, number>>;
}

export type UpgradePlan =
  | { allowed: true; reason: "fresh-install" | "same-version" | "upgrade" | "downgrade-refused" }
  | { allowed: false; reason: string };

/**
 * Compares two dotted versions.
 *
 * Returns a negative number when `a` is older, zero when equal and a positive
 * number when `a` is newer. Unparseable parts are treated as 0 so a build with
 * a suffix (for example `1.0.0-beta.1`) still compares sensibly.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split("-")[0]
      .split(".")
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

export function planUpgrade(input: UpgradePlanInput): UpgradePlan {
  // A manifest that is not the contract this build understands would leave the
  // resource check meaningless, so the upgrade refuses rather than warning
  // later when a component turns out to be missing.
  if (input.manifest !== null) {
    if (input.manifest.contract !== RUNTIME_MANIFEST_CONTRACT) {
      return {
        allowed: false,
        reason: `manifest-contract-mismatch: ${String(input.manifest.contract)}`,
      };
    }
    if (!Array.isArray(input.manifest.entries) || input.manifest.entries.length === 0) {
      return { allowed: false, reason: "manifest-empty" };
    }
  }

  // A file written by a newer build may use a format this version cannot read.
  // Overwriting it would lose the owner's data, so the upgrade stops first.
  for (const key of Object.keys(COMPANYCLAW_DATA_SCHEMAS) as CompanyClawDataKey[]) {
    const onDisk = input.onDiskSchemas[key];
    if (onDisk === undefined) continue;
    const expected = COMPANYCLAW_DATA_SCHEMAS[key];
    if (onDisk > expected) {
      return { allowed: false, reason: `data-schema-newer: ${key} (${onDisk} > ${expected})` };
    }
  }

  if (input.installedVersion === null) return { allowed: true, reason: "fresh-install" };
  const comparison = compareVersions(input.incomingVersion, input.installedVersion);
  if (comparison === 0) return { allowed: true, reason: "same-version" };
  if (comparison > 0) return { allowed: true, reason: "upgrade" };
  return { allowed: true, reason: "downgrade-refused" };
}

/**
 * Paths an upgrade must never clear.
 *
 * Listed so a test can prove the installer does not touch them: losing an API
 * key, a WeChat binding or the approval log turns an upgrade into a silent
 * reset, which the requirements forbid.
 */
export const UPGRADE_PRESERVED_FILES: readonly string[] = [
  "companyclaw/tasks.json",
  "companyclaw/approvals.json",
  "companyclaw/identity-binding.json",
  "companyclaw/broker-targets.json",
  "companyclaw/companyclaw-ticket-secret",
];
