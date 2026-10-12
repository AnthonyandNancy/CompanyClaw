import type { ExecutionOrigin } from "../policy/execution-origin";
import { isRemoteOrigin } from "../policy/execution-origin";
import type { VisionAuthorizationRecord } from "../permissions/permission-policy";

/**
 * The gate every screen image must pass before it leaves the machine.
 *
 * Ruling Q2 draws a line that is easy to blur in code: capturing the screen
 * locally and *sending that image to a third-party model* are different acts.
 * The first is part of normal desktop automation; the second hands the
 * employee's screen to a provider they configured for text. So the local
 * capability is on by default, the upload is off by default, and turning on the
 * daily preset never turns the upload on.
 *
 * The authorization is deliberately narrow. It names the provider, the endpoint
 * and the model it was granted for, because "send my screen to DeepSeek" is not
 * consent to send it to whatever endpoint is configured next. Changing any of
 * those three voids it, and so does the employer tightening policy.
 */

export interface VisionContext {
  ownerSid: string;
  deviceId: string;
  origin: ExecutionOrigin;
  /** Provider/endpoint/model currently configured for the model in use. */
  provider: string;
  baseUrl: string;
  model: string;
  /** The window or region the caller intends to capture. */
  requestedScope: string;
  /** True when the selected model reports no vision capability at all. */
  modelSupportsVision: boolean;
  /** Remaining lifetime of the remote authorization, when the origin is remote. */
  remoteAuthorizationExpiresAt: string | null;
  /** True when enterprise policy was tightened after the grant. */
  enterprisePolicyTightened: boolean;
}

export type VisionDecision =
  | { allowed: true; reason: string }
  | { allowed: false; code: VisionDenialCode; reason: string };

export type VisionDenialCode =
  | "vision-not-authorized"
  | "vision-revoked"
  | "vision-expired"
  | "provider-changed"
  | "origin-not-authorized"
  | "capture-scope-not-authorized"
  | "remote-authorization-missing"
  | "remote-authorization-too-short"
  | "enterprise-policy-tightened"
  | "model-without-vision"
  | "sensitive-content-unverified";

/**
 * The scope a grant covers. A grant for one window must not be stretched to the
 * whole desktop, which is exactly what "不默认上传整个桌面" means in practice.
 */
const SCOPE_RANK: Readonly<Record<string, number>> = {
  "target-window": 1,
  "task-scope": 2,
  desktop: 3,
};

export const DEFAULT_VISION_SCOPE = "target-window";

/**
 * Resolves which authorization record applies to this request.
 *
 * Local and remote are separate records on purpose: the employee can allow
 * their own machine to use vision while leaving the WeChat path without it, and
 * the reverse.
 */
export function selectVisionRecord(
  policy: { vision: { local: VisionAuthorizationRecord; remote: VisionAuthorizationRecord } },
  origin: ExecutionOrigin,
): VisionAuthorizationRecord {
  return isRemoteOrigin(origin) ? policy.vision.remote : policy.vision.local;
}

/**
 * The record that applies to a request, with both channel records merged.
 *
 * Product-owner ruling (a-2), 2026-10-10: either switch being enabled is enough.
 * The two records are two ways for the owner to say "yes", not two separate
 * authorities. Picking strictly by origin made the remote record unreachable:
 * every tool call reaches the endpoint through the same shared MCP connection
 * and is therefore always stamped `local-ui`, so a grant the employee made with
 * the remote switch was never read.
 */
export function selectVisionRecordForRequest(
  policy: { vision: { local: VisionAuthorizationRecord; remote: VisionAuthorizationRecord } },
  origin: ExecutionOrigin,
): VisionAuthorizationRecord {
  const byOrigin = selectVisionRecord(policy, origin);
  if (byOrigin.enabled && !byOrigin.revokedAt) return byOrigin;
  const other = isRemoteOrigin(origin) ? policy.vision.local : policy.vision.remote;
  if (other.enabled && !other.revokedAt) return other;
  return byOrigin;
}

export function evaluateVisionRequest(
  record: VisionAuthorizationRecord,
  context: VisionContext,
  now: Date,
  options: {
    /**
     * Ruling ③: under 完全权限 the remote-operation switch does not gate the
     * upload. The switch still governs the narrower presets.
     */
    allowWithoutRemoteAuthorization?: boolean;
  } = {},
): VisionDecision {
  if (context.enterprisePolicyTightened) {
    return {
      allowed: false,
      code: "enterprise-policy-tightened",
      reason: "企业安全策略已收紧，需要重新授权后才能上传屏幕内容",
    };
  }

  if (!context.modelSupportsVision) {
    // Not a security refusal: an honest capability statement. The caller is
    // expected to fall back to UIA/DOM rather than calling a vision endpoint
    // that cannot work.
    return {
      allowed: false,
      code: "model-without-vision",
      reason: "当前模型不支持视觉，已改用界面元素定位方式",
    };
  }

  if (record.revokedAt) {
    return {
      allowed: false,
      code: "vision-revoked",
      reason: "云端视觉识别授权已被撤销，不再上传屏幕内容",
    };
  }

  if (!record.enabled) {
    return {
      allowed: false,
      code: "vision-not-authorized",
      reason: "尚未授权把屏幕内容发送给模型服务商",
    };
  }

  if (record.expiresAt === null || Date.parse(record.expiresAt) <= now.getTime()) {
    return {
      allowed: false,
      code: "vision-expired",
      reason: "云端视觉识别授权已到期，需要重新授权",
    };
  }

  if (
    record.provider !== context.provider ||
    record.baseUrl !== context.baseUrl ||
    record.model !== context.model
  ) {
    return {
      allowed: false,
      code: "provider-changed",
      reason: "模型服务商或模型已变更，原视觉授权失效，需要重新授权",
    };
  }

  const grantedRank = SCOPE_RANK[record.captureScope] ?? 0;
  const requestedRank = SCOPE_RANK[context.requestedScope] ?? Number.POSITIVE_INFINITY;
  if (grantedRank === 0 || requestedRank > grantedRank) {
    return {
      allowed: false,
      code: "capture-scope-not-authorized",
      reason: "本次采集范围超出已授权范围，需要重新授权",
    };
  }

  if (isRemoteOrigin(context.origin) && !options.allowWithoutRemoteAuthorization) {
    if (context.remoteAuthorizationExpiresAt === null) {
      return {
        allowed: false,
        code: "remote-authorization-missing",
        reason: "微信远程操作授权未开启，远程视觉识别不可用",
      };
    }
    if (Date.parse(context.remoteAuthorizationExpiresAt) <= now.getTime()) {
      return {
        allowed: false,
        code: "remote-authorization-missing",
        reason: "微信远程操作授权已过期，远程视觉识别不可用",
      };
    }
  }

  return { allowed: true, reason: "云端视觉识别已授权" };
}

/**
 * The lifetime a fresh grant may have.
 *
 * Default seven days per ruling Q-C. A remote grant additionally cannot outlive
 * the remote operation authorization it rides on: the screenshot permission is
 * the narrower one, so it must not survive the broader one.
 */
export function visionGrantLifetimeMs(input: {
  requestedMs: number;
  origin: ExecutionOrigin;
  remoteAuthorizationExpiresAt: string | null;
  now: Date;
}): number {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1_000;
  const requested = Number.isFinite(input.requestedMs) && input.requestedMs > 0
    ? Math.min(input.requestedMs, SEVEN_DAYS)
    : SEVEN_DAYS;

  if (!isRemoteOrigin(input.origin) || input.remoteAuthorizationExpiresAt === null) {
    return requested;
  }
  const remoteRemaining = Date.parse(input.remoteAuthorizationExpiresAt) - input.now.getTime();
  if (!Number.isFinite(remoteRemaining) || remoteRemaining <= 0) return 0;
  return Math.min(requested, remoteRemaining);
}

/**
 * Which parts of the screen must never be captured by default.
 *
 * These are not "the model will not look at them" promises; they are the
 * exclusion list the capture path checks before it produces an image.
 */
export const VISION_CAPTURE_EXCLUSIONS: readonly string[] = [
  "password-fields",
  "credential-managers",
  "other-user-sessions",
  "unrelated-applications",
] as const;
