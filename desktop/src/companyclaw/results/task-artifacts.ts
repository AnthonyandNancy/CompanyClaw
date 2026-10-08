import * as path from "node:path";

/**
 * Per-task artifact locations.
 *
 * Requirement V1.1 F8 requires each task to have its own directory and only
 * approved files to enter it. Two properties matter for safety:
 *
 * 1. A task id comes from stored data, so it must never be able to address a
 *    directory outside its own sandbox.
 * 2. A produced file name comes from an executing application, so it must never
 *    be able to escape the task directory or collide with a device name.
 */

const MAX_TASK_ID_LENGTH = 128;
const MAX_FILE_NAME_LENGTH = 255;

/** Characters Windows forbids in a file name, plus the wildcard pair. */
const FORBIDDEN_NAME_CHARACTERS = /[<>:"|?*]/g;

/** Path separators and the drive colon, which must never appear in a task id. */
const FORBIDDEN_TASK_ID_CHARACTERS = /[\\/:*?"<>|]/;

/**
 * True when the text contains a C0 control character. Checked by code point so
 * the source carries no literal control range (which lint forbids, and which is
 * easy to misread as a typo).
 */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x1f) return true;
  }
  return false;
}

/** Windows reserved device names, which cannot be used as file names. */
const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * Validates a task id for use as a directory name. Returns null rather than a
 * sanitized value: silently rewriting an id could make two tasks share a
 * directory.
 */
export function taskDirName(taskId: string): string | null {
  if (typeof taskId !== "string") return null;
  const trimmed = taskId.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_TASK_ID_LENGTH) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (FORBIDDEN_TASK_ID_CHARACTERS.test(trimmed)) return null;
  if (hasControlCharacter(trimmed)) return null;
  return trimmed;
}

export function buildTaskArtifactDir(rootDir: string, taskId: string): string | null {
  const dirName = taskDirName(taskId);
  if (!dirName) return null;
  return path.join(rootDir, "jobs", dirName, "artifacts");
}

/** True only for a path strictly inside `taskDir`. */
export function isPathInsideTaskDir(taskDir: string, candidate: string): boolean {
  const resolvedDir = path.resolve(taskDir);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedDir) return false;
  // Compare with a trailing separator so a sibling named "artifacts-evil"
  // cannot pass as being inside "artifacts".
  return resolvedCandidate.startsWith(resolvedDir + path.sep);
}

/**
 * Reduces a produced file name to a safe leaf name. Returns null when nothing
 * usable remains, so the caller must choose a name instead of writing to an
 * unexpected location.
 */
export function sanitizeArtifactFileName(rawName: string): string | null {
  if (typeof rawName !== "string" || rawName.length === 0) return null;
  // Drop any directory component the producer embedded.
  const leaf = rawName.split(/[\\/]/).pop() ?? "";
  const withoutForbidden = leaf.replace(FORBIDDEN_NAME_CHARACTERS, "");
  const cleaned = Array.from(withoutForbidden)
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x1f)
    .join("")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_FILE_NAME_LENGTH) return null;
  // "..." and similar are not usable names.
  if (/^\.+$/.test(cleaned)) return null;
  // Reserved device names are matched on the stem, so "lpt1.txt" is rejected.
  const stem = cleaned.split(".")[0].toLowerCase();
  if (RESERVED_NAMES.has(stem)) return null;
  return cleaned;
}
