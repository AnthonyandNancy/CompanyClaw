/**
 * The three permission presets the employee can choose.
 *
 * A preset is a *configuration intent*, not a grant: it decides which default
 * decision the policy engine starts from, while the concrete authorities
 * (trusted apps, trusted sites, work folders, task grants, remote authorization
 * and vision authorization) live in the permission policy store.
 *
 * Requirement V5 §4.1 and conflict ruling Q3 forbid translating FULL_DAILY into
 * `sandbox=false`, `policy.allowAll=true`, `shell.*=allow` or "R2/R3 are
 * auto-approved"; the presets below are the only meaning the presets carry.
 */

export const PERMISSION_PRESETS = ["BASIC", "FULL_DAILY", "CUSTOM"] as const;

export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

/** New installations and pre-existing installations without a preset. */
export const DEFAULT_PRESET: PermissionPreset = "BASIC";

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === "string" && (PERMISSION_PRESETS as readonly string[]).includes(value);
}

/**
 * The preset the user sees selected on a fresh install. BASIC is deliberately
 * the only default: nothing in this feature may widen access without an
 * explicit click from the owner.
 */
export function presetAfterMigration(stored: unknown): PermissionPreset {
  return isPermissionPreset(stored) ? stored : DEFAULT_PRESET;
}

/**
 * Human-readable scope lines shown next to each preset.
 *
 * Kept beside the enum so the UI copy and the semantics cannot drift apart: the
 * employee is told exactly what BASIC, FULL_DAILY and CUSTOM mean.
 */
export const PRESET_DESCRIPTIONS: Readonly<
  Record<PermissionPreset, { title: string; detail: string; confirmations: string }>
> = {
  BASIC: {
    title: "基础权限",
    detail: "在已授权范围内查询、查看、受控浏览器阅读与只读任务",
    confirmations: "对新应用操作、文件修改、业务写入仍会请求你确认",
  },
  FULL_DAILY: {
    title: "全面日常操作",
    detail: "允许正常打开已安装应用与网站、切换窗口、查找控件、普通导航与输入、整理授权任务内的文件",
    confirmations: "重大业务提交、对外发消息、敏感文件外发、删除、付款与提权仍需要你确认",
  },
  CUSTOM: {
    title: "高级自定义",
    detail: "逐项管理应用、网站、文件目录与特殊业务权限，保留原有沙箱与隔离控制",
    confirmations: "超出自定义范围或属于业务高风险时仍会请求你确认",
  },
};

/**
 * True when the preset is the one that suppresses repeated prompts inside an
 * already-authorized task. BASIC never suppresses anything.
 */
export function presetSuppressesRoutinePrompts(preset: PermissionPreset): boolean {
  return preset === "FULL_DAILY";
}
