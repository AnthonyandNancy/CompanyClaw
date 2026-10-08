/**
 * Browser execution policy.
 *
 * Requirement V1.1 F4 requires that remote browser work goes through a path
 * bound to the task's identity and permissions, and that no write channel is
 * left outside the policy. In particular:
 *
 * * an intranet target must be explicitly allowed per domain — the private
 *   network is never opened wholesale, and a bare IP is not a bypass;
 * * a generic click must never be treated as read-only, because it can submit a
 *   form;
 * * downloads and uploads are separate capabilities that are off unless enabled.
 */

export type BrowserActionRisk = "read" | "write" | "high-risk";

export type BrowserActionName =
  | "navigate"
  | "read"
  | "search"
  | "snapshot"
  | "screenshot"
  | "click"
  | "click-submit"
  | "fill-form"
  | "edit-field"
  | "upload"
  | "download"
  | "delete"
  | "publish"
  | "pay";

const READ_ACTIONS = new Set<string>([
  "navigate",
  "read",
  "search",
  "snapshot",
  "screenshot",
]);

const WRITE_ACTIONS = new Set<string>(["click-submit", "fill-form", "edit-field"]);

const HIGH_RISK_ACTIONS = new Set<string>(["delete", "publish", "pay"]);

/**
 * Classifies a browser action. Anything not recognised as read-only is treated
 * as a write, so a new or mistyped action name cannot slip through as harmless.
 */
export function classifyBrowserAction(action: string): BrowserActionRisk {
  if (HIGH_RISK_ACTIONS.has(action)) return "high-risk";
  if (READ_ACTIONS.has(action)) return "read";
  if (WRITE_ACTIONS.has(action)) return "write";
  // click / upload / download / anything unknown: a mutation candidate.
  return "write";
}

/** Lowercases the host and strips a trailing dot. Returns null when unusable. */
export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return null;
  // A scheme or path means the caller passed a URL where a host belongs.
  if (/[\s/:]/.test(trimmed) && !/^\[[0-9a-f:]+\]$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * True when `host` equals an allowed domain or is a subdomain of one.
 *
 * The comparison uses a dot boundary, so "evil-oa.example.com" is not a
 * subdomain of "oa.example.com" and "oa.example.com.evil.net" does not match.
 */
export function isDomainAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const normalized = normalizeDomain(host);
  if (!normalized) return false;
  for (const entry of allowedDomains) {
    const allowed = normalizeDomain(entry);
    if (!allowed) continue;
    if (normalized === allowed) return true;
    if (normalized.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

export interface BrowserPolicyConfig {
  allowedDomains: readonly string[];
  allowDownloads: boolean;
  allowUploads: boolean;
}

export interface BrowserActionRequest {
  action: string;
  url: string;
}

export type BrowserDenialReason =
  | "invalid-url"
  | "unsupported-scheme"
  | "domain-not-allowed"
  | "downloads-disabled"
  | "uploads-disabled";

export type BrowserAuthorization =
  | { allowed: true; risk: BrowserActionRisk }
  | { allowed: false; reason: BrowserDenialReason };

export class BrowserPolicy {
  constructor(private readonly config: BrowserPolicyConfig) {}

  authorize(request: BrowserActionRequest): BrowserAuthorization {
    // Only real web schemes. file:// would reach the local disk and
    // javascript: would run in the page context.
    if (!/^https?:\/\//i.test(request.url)) {
      return { allowed: false, reason: "unsupported-scheme" };
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return { allowed: false, reason: "invalid-url" };
    }
    if (!parsed.hostname) return { allowed: false, reason: "invalid-url" };

    // The domain allow list is the only thing that makes an intranet host
    // reachable; an unlisted host is refused regardless of the action.
    if (!isDomainAllowed(parsed.hostname, this.config.allowedDomains)) {
      return { allowed: false, reason: "domain-not-allowed" };
    }

    if (request.action === "download" && !this.config.allowDownloads) {
      return { allowed: false, reason: "downloads-disabled" };
    }
    if (request.action === "upload" && !this.config.allowUploads) {
      return { allowed: false, reason: "uploads-disabled" };
    }

    return { allowed: true, risk: classifyBrowserAction(request.action) };
  }
}
