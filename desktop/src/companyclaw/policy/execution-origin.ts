/**
 * Where one execution request came from.
 *
 * Requirement V5 splits permission decisions by channel: a recycle-bin delete
 * the owner confirms on their own machine is not the same request as the same
 * delete arriving through WeChat. The origin is therefore part of the policy
 * input rather than a detail the executor decides later.
 *
 * The value must be minted at a trusted boundary (the local UI entry point, or
 * the WeChat bridge's own metadata). It is never read from model output or from
 * message text — see `trusted-context.ts` for the remote side.
 */

export const EXECUTION_ORIGINS = [
  "local-ui",
  "weixin-private",
  "automation",
  "subagent",
  "cron",
] as const;

export type ExecutionOrigin = (typeof EXECUTION_ORIGINS)[number];

/**
 * The legacy default.
 *
 * Before origins existed, the only caller of the policy was the remote path, so
 * a context without an origin must keep behaving exactly as it did: remote
 * semantics, including the "R3 is refused" rule.
 */
export const LEGACY_ORIGIN: ExecutionOrigin = "weixin-private";

export function resolveOrigin(origin: ExecutionOrigin | undefined): ExecutionOrigin {
  return origin ?? LEGACY_ORIGIN;
}

/** True for every origin that is not the person sitting at this machine. */
export function isRemoteOrigin(origin: ExecutionOrigin): boolean {
  return origin !== "local-ui";
}

/**
 * A derived origin can only ever be equal or narrower than its parent.
 *
 * A sub-agent or a scheduled run must not be able to promote itself into the
 * local user's authority, so the derived origin is chosen from a fixed table:
 * a local task may spawn a local sub-task, but a remote task's children stay
 * remote.
 */
export function deriveChildOrigin(parent: ExecutionOrigin, kind: "subagent" | "cron"): ExecutionOrigin {
  if (kind === "subagent") return parent;
  return parent === "local-ui" ? "cron" : parent;
}
