import { execFileSync } from "node:child_process";

/**
 * Resolves the Windows SID of the user who owns this installation.
 *
 * Every approval, task and remote-operation grant is scoped to this value, so
 * one Windows user can never read or authorize another user's work. When the
 * SID cannot be read (non-Windows dev host, restricted shell) a stable
 * placeholder is used instead of a per-run random value, so stored records stay
 * readable across restarts.
 */

export const FALLBACK_OWNER_SID = "LOCAL-USER";

/** Accepts only a complete, well-formed SID on a single line. */
export function parseWindowsSid(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  // S-<revision>-<authority>-<subauthority>…  with at least one subauthority.
  if (!/^S-\d+-\d+(-\d+)+$/.test(trimmed)) return null;
  return trimmed;
}

interface ResolveOwnerSidOptions {
  runProbe?: () => string;
}

export function resolveOwnerSid(options: ResolveOwnerSidOptions = {}): string {
  const runProbe =
    options.runProbe ??
    (() =>
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        { encoding: "utf-8", windowsHide: true, timeout: 10_000 },
      ));
  try {
    return parseWindowsSid(runProbe()) ?? FALLBACK_OWNER_SID;
  } catch {
    return FALLBACK_OWNER_SID;
  }
}
