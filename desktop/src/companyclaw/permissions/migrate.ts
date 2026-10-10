import {
  createEmptyPermissionPolicy,
  normalizeTrustedApp,
  type PermissionPolicy,
  type TrustedAppRecord,
} from "./permission-policy";
import { presetAfterMigration } from "../policy/permission-preset";

/**
 * Brings a pre-V5 installation onto the permission document.
 *
 * Ruling Q8 is the whole specification here: the old grants must survive, but
 * they must not grow. Concretely —
 *
 *   * the pre-V5 broker allow list becomes `trustedApps` entries scoped
 *     `local`, marked `legacy`, with no publisher and no hash. They keep working
 *     where they already worked (this machine, the local session) and nowhere
 *     else;
 *   * the preset is *never* inferred as FULL_DAILY, no matter what the old
 *     configuration allowed, because "was allowed before" is not the same as
 *     "the employee chose the daily preset";
 *   * remote authorization, R2/R3 grades and vision authorization all start
 *     from the safe state — a migration cannot mint authority the user never
 *     granted under the new model.
 */

export interface LegacyBrokerTargets {
  allowedProcesses: readonly string[];
  allowedWindowTitles: readonly string[];
}

export interface MigrationInput {
  /** Raw stored policy, when one already exists (schema v2 and up). */
  stored: unknown;
  /** The pre-V5 allow list, when that file exists. */
  legacyTargets: LegacyBrokerTargets | null;
  /** Existing remote authorization, when the caller has one in memory. */
  legacyRemote?: Partial<PermissionPolicy["remote"]> | null;
  now?: Date;
}

export interface MigrationResult {
  policy: PermissionPolicy;
  /** What the migration actually did, for the upgrade prompt and the log. */
  notes: string[];
  /** True when nothing was stored yet and defaults were created. */
  created: boolean;
}

export function migrateToPermissionPolicy(input: MigrationInput): MigrationResult {
  const notes: string[] = [];
  const base = createEmptyPermissionPolicy();
  const timestamp = (input.now ?? new Date()).toISOString();
  const stored = input.stored as Partial<PermissionPolicy> | null | undefined;

  const storedRemote = stored?.remote;
  const policy: PermissionPolicy = {
    ...base,
    preset: presetAfterMigration(stored?.preset),
    policyVersion: typeof stored?.policyVersion === "number" ? stored.policyVersion : base.policyVersion,
    ...(typeof stored?.presetChangedAt === "string" ? { presetChangedAt: stored.presetChangedAt } : {}),
    trustedApps: Array.isArray(stored?.trustedApps) ? [...stored.trustedApps] : [],
    trustedSites: Array.isArray(stored?.trustedSites) ? [...stored.trustedSites] : [],
    workFolders: Array.isArray(stored?.workFolders) ? [...stored.workFolders] : [],
    // A stored remote record is the recorded truth and is carried over as-is;
    // only its expiry is re-evaluated on read. `legacyRemote` below is for the
    // one-time upgrade from the pre-V5 in-memory authorization.
    remote: storedRemote
      ? {
          enabled: storedRemote.enabled === true,
          ownerSid: storedRemote.ownerSid ?? "",
          deviceId: storedRemote.deviceId ?? "",
          channelUserId: storedRemote.channelUserId ?? "",
          grantedAt: storedRemote.grantedAt ?? null,
          expiresAt: storedRemote.expiresAt ?? null,
          revokedAt: storedRemote.revokedAt ?? null,
        }
      : { ...base.remote },
    taskGrants: [],
    vision: {
      local: stored?.vision?.local ?? { ...base.vision.local },
      remote: stored?.vision?.remote ?? { ...base.vision.remote },
    },
    legacyRuleReferences: Array.isArray(stored?.legacyRuleReferences)
      ? [...stored.legacyRuleReferences]
      : [],
    enterpriseRestrictions: stored?.enterpriseRestrictions ?? {
      managed: false,
      stricterRules: [],
    },
  };

  if (stored?.preset && stored.preset !== policy.preset) {
    notes.push(`预设 "${String(stored.preset)}" 无法识别，已回退为基础权限`);
  }

  // A brand-new install: nothing to carry over, so the daily preset is not an
  // option until the employee picks it.
  if (!stored) {
    notes.push("未发现已有权限配置，已按基础权限与空授权初始化");
  }

  if (input.legacyTargets) {
    const converted = input.legacyTargets.allowedProcesses
      .map((entry) => {
        const normalized = normalizeTrustedApp({
          processName: entry,
          source: "user-selected",
          scope: "local",
          legacy: true,
        });
        if (!normalized) return null;
        const withMeta: TrustedAppRecord = {
          ...normalized,
          approvedAt: timestamp,
        };
        return withMeta;
      })
      .filter((entry): entry is TrustedAppRecord => entry !== null);

    const existing = new Set(policy.trustedApps.map((app) => app.processName));
    const added = converted.filter((app) => !existing.has(app.processName));
    if (added.length > 0) {
      policy.trustedApps = [...policy.trustedApps, ...added];
      notes.push(`已保留 ${added.length} 个旧应用授权（仅本机、原范围，未扩大）`);
    }
    if (converted.length < input.legacyTargets.allowedProcesses.length) {
      notes.push("部分旧应用条目无法表达为单一可执行文件，已忽略并在日志中记录");
    }
    if (input.legacyTargets.allowedWindowTitles.length > 0) {
      policy.legacyRuleReferences = [
        ...policy.legacyRuleReferences,
        ...input.legacyTargets.allowedWindowTitles.map((value) => ({
          source: "broker-window-title",
          value,
        })),
      ];
      notes.push("旧窗口标题限制已保留为只读参考，不再作为准入依据");
    }
  }

  if (!storedRemote && input.legacyRemote && input.legacyRemote.enabled === true) {
    // Only an authorization that is still live is carried over, and it stays
    // bound to the identity it was granted to.
    const expiresAt = input.legacyRemote.expiresAt ?? null;
    const stillLive = expiresAt !== null && Date.parse(expiresAt) > (input.now ?? new Date()).getTime();
    if (stillLive && !input.legacyRemote.revokedAt) {
      policy.remote = {
        enabled: true,
        ownerSid: input.legacyRemote.ownerSid ?? "",
        deviceId: input.legacyRemote.deviceId ?? "",
        channelUserId: input.legacyRemote.channelUserId ?? "",
        grantedAt: input.legacyRemote.grantedAt ?? null,
        expiresAt,
        revokedAt: null,
      };
      notes.push("已保留仍然有效的微信远程授权（未延长、未扩大）");
    } else if (input.legacyRemote.revokedAt) {
      notes.push("已撤销的微信远程授权不会被迁移恢复");
    }
  }

  return { policy, notes, created: !stored };
}
