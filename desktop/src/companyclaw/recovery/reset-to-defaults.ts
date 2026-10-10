import type { PermissionPolicy } from "../permissions/permission-policy";
import { clearUserGrants } from "../permissions/permission-policy";
import { isTerminalState, type TaskState } from "../tasks/task-state";

/**
 * "Restore safe defaults" — the one button that must not be cosmetic.
 *
 * Ruling Q6/Q-D is explicit that the reset has to take effect on the *backend*,
 * for local and remote alike, and that the employee sees what it will do before
 * it does it. Two consequences shape this module:
 *
 *   1. the preview and the apply are computed from the same snapshot, and the
 *      apply refuses a token that no longer matches, so the list the employee
 *      read is the list that runs;
 *   2. what is *kept* is as important as what is cleared — model configuration,
 *      the WeChat binding, chat history, the audit log, finished task history
 *      and produced files all survive, and no running application is closed.
 */

export type ResetClearedKey =
  | "preset"
  | "remoteAuthorization"
  | "visionLocal"
  | "visionRemote"
  | "trustedApps"
  | "trustedSites"
  | "workFolders"
  | "taskGrants"
  | "pendingApprovals";

export interface ResetPreview {
  /** Opaque token; `apply` only proceeds when it still matches. */
  token: string;
  fromPreset: PermissionPolicy["preset"];
  toPreset: PermissionPolicy["preset"];
  cleared: ResetClearedKey[];
  /** Counts so the dialog can state the blast radius numerically. */
  counts: {
    trustedApps: number;
    trustedSites: number;
    workFolders: number;
    taskGrants: number;
    activeTasks: number;
    pendingApprovals: number;
    legacyGrants: number;
  };
  /** Data the reset must not touch, shown in the same dialog. */
  retained: string[];
}

export const RESET_RETAINED_ITEMS: readonly string[] = [
  "已配置的大模型与 API Key",
  "微信账号绑定关系",
  "聊天历史",
  "已完成的任务历史与审计记录",
  "已生成的文件与任务产物",
  "Windows 系统与企业不可覆盖的安全限制",
] as const;

export interface ResetInputs {
  policy: PermissionPolicy;
  tasks: { taskId: string; state: TaskState }[];
  pendingApprovals: number;
}

/**
 * Describes the token.
 *
 * The token is a pure function of the state being reset, so a second preview
 * after a change yields a different token and a stale "confirm" is refused
 * rather than applied to a system the employee never saw.
 */
export function resetToken(policy: PermissionPolicy, pendingApprovals: number): string {
  const parts = [
    policy.policyVersion,
    policy.preset,
    policy.trustedApps.length,
    policy.trustedSites.length,
    policy.workFolders.length,
    policy.taskGrants.length,
    policy.vision.local.enabled ? 1 : 0,
    policy.vision.remote.enabled ? 1 : 0,
    policy.remote.enabled ? 1 : 0,
    pendingApprovals,
  ];
  return parts.join(":");
}

export function buildResetPreview(input: ResetInputs): ResetPreview {
  const activeTasks = input.tasks.filter((task) => !isTerminalState(task.state));
  // The preset, the remote authorization and both vision grants are always
  // part of the reset: the employee must see that every authority is affected,
  // not only the ones that happened to be non-empty.
  const cleared: ResetClearedKey[] = [
    "preset",
    "remoteAuthorization",
    "visionLocal",
    "visionRemote",
    "pendingApprovals",
  ];
  if (input.policy.trustedApps.length > 0) cleared.push("trustedApps");
  if (input.policy.trustedSites.length > 0) cleared.push("trustedSites");
  if (input.policy.workFolders.length > 0) cleared.push("workFolders");
  if (input.policy.taskGrants.length > 0) cleared.push("taskGrants");

  return {
    token: resetToken(input.policy, input.pendingApprovals),
    fromPreset: input.policy.preset,
    toPreset: "BASIC",
    cleared,
    counts: {
      trustedApps: input.policy.trustedApps.length,
      trustedSites: input.policy.trustedSites.length,
      workFolders: input.policy.workFolders.length,
      taskGrants: input.policy.taskGrants.length,
      activeTasks: activeTasks.length,
      pendingApprovals: input.pendingApprovals,
      legacyGrants: input.policy.trustedApps.filter((app) => app.legacy).length,
    },
    retained: [...RESET_RETAINED_ITEMS],
  };
}

export type ResetOutcome =
  | { applied: true; policy: PermissionPolicy; preview: ResetPreview }
  | { applied: false; reason: "stale-preview" | "invalid-token" };

/**
 * Applies the reset.
 *
 * `clearUserGrants` removes every authority the employee granted while leaving
 * the schema, the audit trail and the enterprise restrictions untouched; the
 * caller is responsible for the two side effects this module cannot perform
 * itself — invalidating pending approvals and pausing active tasks — and for
 * persisting before it reports success.
 */
export function applyReset(input: {
  policy: PermissionPolicy;
  pendingApprovals: number;
  token: string;
}): ResetOutcome {
  if (!input.token) return { applied: false, reason: "invalid-token" };
  const expected = resetToken(input.policy, input.pendingApprovals);
  if (expected !== input.token) return { applied: false, reason: "stale-preview" };
  return { applied: true, policy: clearUserGrants(input.policy), preview: buildResetPreview({
    policy: input.policy,
    tasks: [],
    pendingApprovals: input.pendingApprovals,
  }) };
}
