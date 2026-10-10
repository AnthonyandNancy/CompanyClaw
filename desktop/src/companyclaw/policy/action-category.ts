/**
 * The action categories the policy decides on.
 *
 * Requirement V5 (rulings Q1, Q-A, Q-B) splits what used to be one coarse
 * "delete" and one coarse "publish" into categories whose *consequence*
 * decides the risk, and it makes the channel part of the decision: a permanent
 * delete is refused from WeChat, while a recoverable recycle-bin delete inside
 * the owner's own work folder may proceed after a local confirmation.
 *
 * Every category here answers one business question, so a later reviewer can
 * check the mapping without reading the engine:
 *
 *   * can this be undone?            -> recycle-bin vs permanent vs batch
 *   * who receives the result?       -> single recipient vs group vs bulk
 *   * does the data leave the org?   -> sensitive exfiltration
 *   * is it a local artifact?        -> task temporary files
 */

export type ActionCategory =
  // Reversible file work. Allowed to ask for a confirmation, never auto-run
  // from a remote channel.
  | "delete-to-recycle-bin"
  | "overwrite-recoverable"
  // The task's own scratch space: auto-cleanable because nothing the user
  // considers "their file" is inside it.
  | "task-temp-cleanup"
  // Irreversible or unbounded destructive work.
  | "delete-permanent"
  | "delete-batch-irreversible"
  | "overwrite-unrecoverable"
  // Outbound communication, split by audience size.
  | "message-single-recipient"
  | "message-group"
  | "message-bulk"
  | "publish-public"
  // Data leaving the organization.
  | "sensitive-exfil"
  | "attachment-to-third-party"
  | "attachment-bulk"
  // Money and privilege.
  | "payment"
  | "system-config"
  | "bypass-security"
  | "arbitrary-command"
  | "unknown-program"
  // The caller could not characterise the consequence. Ruling V5 §7.3 requires
  // stopping instead of guessing, so it is refused on every channel.
  | "high-risk"
  // Ordinary work.
  | "read"
  | "local-work"
  | "write"
  | "unknown";

/** Categories that are refused on every channel, including the local one. */
export const NEVER_ALLOWED_CATEGORIES: readonly ActionCategory[] = [
  "high-risk",
  "payment",
  "system-config",
  "bypass-security",
  "arbitrary-command",
  "unknown-program",
] as const;

/** Categories refused from WeChat but confirmable on the owner's own machine. */
export const LOCAL_CONFIRMABLE_CATEGORIES: readonly ActionCategory[] = [
  "delete-permanent",
  "delete-batch-irreversible",
  "overwrite-unrecoverable",
  "message-group",
  "message-bulk",
  "publish-public",
  "sensitive-exfil",
  "attachment-bulk",
] as const;

/**
 * Categories that never need a confirmation once the task scope covers them.
 *
 * `read` is deliberately absent: a read without system-level proof of having no
 * side effect is an R2 business write as far as this layer is concerned, so it
 * must still be confirmed.
 */
export const ROUTINE_CATEGORIES: readonly ActionCategory[] = [
  "local-work",
  "task-temp-cleanup",
] as const;

/** Categories that ask for a confirmation on any channel. */
export const CONFIRMABLE_CATEGORIES: readonly ActionCategory[] = [
  // A read with no system-level proof of having no side effect is an R2
  // business write as far as this layer is concerned.
  "read",
  "delete-to-recycle-bin",
  "overwrite-recoverable",
  "message-single-recipient",
  "attachment-to-third-party",
  "write",
  "unknown",
] as const;

export function isNeverAllowed(category: ActionCategory): boolean {
  return NEVER_ALLOWED_CATEGORIES.includes(category);
}

export function isRoutine(category: ActionCategory): boolean {
  return ROUTINE_CATEGORIES.includes(category);
}

export function needsLocalConfirmation(category: ActionCategory): boolean {
  return (
    CONFIRMABLE_CATEGORIES.includes(category) || LOCAL_CONFIRMABLE_CATEGORIES.includes(category)
  );
}

/**
 * Categories where the *local* owner may confirm and proceed.
 *
 * `payment` is deliberately absent: ruling Q-A requires the person to finish a
 * payment in the official application themselves, so no confirmation flow in
 * this app can authorize it.
 */
export function isLocallyConfirmable(category: ActionCategory): boolean {
  return (
    CONFIRMABLE_CATEGORIES.includes(category) || LOCAL_CONFIRMABLE_CATEGORIES.includes(category)
  );
}
