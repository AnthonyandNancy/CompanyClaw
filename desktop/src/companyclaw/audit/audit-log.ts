import type { PolicyDecision } from "../policy/risk-classifier";
import type { ExecutionOrigin } from "../policy/execution-origin";

/**
 * The append-only record of what the product decided and why.
 *
 * Requirement V5 §4.2 (step 9) asks for the actual allow/deny reason, the policy
 * version, the window or domain, the task action and a result reference — and
 * forbids plaintext screenshots or secrets in it. This module keeps that
 * promise in the shape of the data: there is no field for an image, a password
 * or a prompt, so a future caller cannot accidentally add one.
 *
 * The file is JSON Lines rather than a JSON document: an audit that has to be
 * rewritten to be appended to is an audit that can lose its tail when the
 * process dies mid-write.
 */

export const AUDIT_CONTRACT = "companyclaw.audit.v1";

export type AuditDecision = PolicyDecision | "invalid-call";

export interface AuditEntry {
  contract: typeof AUDIT_CONTRACT;
  at: string;
  taskId: string;
  stepId: string;
  origin: ExecutionOrigin;
  ownerSid: string;
  deviceId: string;
  tool: string;
  actionCategory: string;
  decision: AuditDecision;
  reason: string;
  policyVersion: number;
  preset: string;
  /** True when the call ran without a prompt because a grant covered it. */
  autoAllowed: boolean;
  target: string;
  approvalId?: string;
  /** Outcome reference, never the payload itself. */
  resultRef?: string;
}

export interface AuditLogDependencies {
  append: (filePath: string, line: string) => Promise<void>;
  now?: () => Date;
}

export interface AuditLogOptions {
  filePath: string;
  /** How many entries `query` returns at most. */
  maxQueryEntries?: number;
}

export class AuditLog {
  constructor(
    private readonly options: AuditLogOptions,
    private readonly deps: AuditLogDependencies,
  ) {}

  async record(entry: Omit<AuditEntry, "contract" | "at">): Promise<void> {
    const complete: AuditEntry = {
      contract: AUDIT_CONTRACT,
      at: (this.deps.now ?? (() => new Date()))().toISOString(),
      ...entry,
    };
    // A failed append must not fail the action it describes: the action already
    // happened, and turning a logging fault into a task failure would be a lie
    // in the other direction.
    try {
      await this.deps.append(this.options.filePath, `${JSON.stringify(complete)}\n`);
    } catch {
      // Intentionally swallowed; see above.
    }
  }
}

export interface AuditQuery {
  taskId?: string;
  decision?: AuditDecision;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * Filters audit lines.
 *
 * Unparseable lines are skipped rather than thrown: a truncated final line is
 * the expected shape of a crash, and the entries before it are still evidence.
 */
export function queryAuditLines(lines: readonly string[], query: AuditQuery = {}): AuditEntry[] {
  const limit = query.limit ?? 200;
  const results: AuditEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as AuditEntry;
    if (entry.contract !== AUDIT_CONTRACT) continue;
    if (query.taskId && entry.taskId !== query.taskId) continue;
    if (query.decision && entry.decision !== query.decision) continue;
    if (query.from && entry.at < query.from) continue;
    if (query.to && entry.at > query.to) continue;
    results.push(entry);
    if (results.length >= limit) break;
  }
  return results;
}
