/**
 * The application allow list the broker enforces.
 *
 * The broker starts with an empty list so every process operation is refused
 * until the user explicitly allows an application. That fail-safe default is the
 * point: a fresh install must not be able to drive arbitrary desktop software.
 *
 * Entries are executable base names, never paths. A path would turn "which
 * application may be automated" into "which file may be executed", which is a
 * different and far broader permission.
 */

export const COMPANYCLAW_BROKER_TARGETS_CONTRACT = "companyclaw.broker-targets.v1";
export const COMPANYCLAW_BROKER_TARGETS_SCHEMA = 1;

export interface BrokerTargets {
  allowedProcesses: string[];
  allowedWindowTitles: string[];
}

export interface BrokerTargetsInspection {
  targets: BrokerTargets;
  warning: string | null;
}

interface TargetsEnvelope {
  contract: typeof COMPANYCLAW_BROKER_TARGETS_CONTRACT;
  schemaVersion: typeof COMPANYCLAW_BROKER_TARGETS_SCHEMA;
  allowedProcesses: string[];
  allowedWindowTitles: string[];
}

interface TargetsStoreDependencies {
  existsFile?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => Promise<void>;
}

const EMPTY: BrokerTargets = { allowedProcesses: [], allowedWindowTitles: [] };

/**
 * Normalizes one process entry to an executable base name, or null when the
 * entry cannot express one.
 */
export function normalizeProcessEntry(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A path separator, wildcard or shell metacharacter means the entry is not a
  // plain process name.
  if (/[\\/*?;:|<>"]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  const withoutExtension = trimmed.replace(/\.exe$/i, "");
  if (!withoutExtension) return null;
  if (withoutExtension === "*") return null;
  return withoutExtension.toLowerCase();
}

export class BrokerTargetsStore {
  private readonly existsFile: (filePath: string) => boolean;
  private readonly readFile: (filePath: string) => string;
  private readonly writeFile: (filePath: string, contents: string) => Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    dependencies: TargetsStoreDependencies = {},
  ) {
    this.existsFile = dependencies.existsFile ?? (() => false);
    this.readFile = dependencies.readFile ?? (() => "");
    this.writeFile = dependencies.writeFile ?? (async () => undefined);
  }

  inspect(): BrokerTargetsInspection {
    let raw: string;
    try {
      if (!this.existsFile(this.filePath)) return { targets: EMPTY, warning: null };
      raw = this.readFile(this.filePath);
    } catch {
      return { targets: EMPTY, warning: "Broker targets could not be read; nothing is allowed" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { targets: EMPTY, warning: "Broker targets are malformed; nothing is allowed" };
    }
    const envelope = parsed as TargetsEnvelope;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      envelope.contract !== COMPANYCLAW_BROKER_TARGETS_CONTRACT ||
      !Array.isArray(envelope.allowedProcesses) ||
      !Array.isArray(envelope.allowedWindowTitles)
    ) {
      return { targets: EMPTY, warning: "Foreign broker targets; nothing is allowed" };
    }
    return {
      targets: {
        allowedProcesses: envelope.allowedProcesses.filter(
          (entry): entry is string => typeof entry === "string" && normalizeProcessEntry(entry) !== null,
        ),
        allowedWindowTitles: envelope.allowedWindowTitles.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
        ),
      },
      warning: null,
    };
  }

  get(): BrokerTargets {
    return this.inspect().targets;
  }

  async save(targets: BrokerTargets): Promise<BrokerTargets> {
    const processes = new Set<string>();
    for (const entry of targets.allowedProcesses) {
      const normalized = normalizeProcessEntry(entry);
      if (normalized) processes.add(normalized);
    }
    const titles = new Set<string>();
    for (const entry of targets.allowedWindowTitles) {
      const trimmed = entry.trim();
      if (trimmed) titles.add(trimmed);
    }
    const saved: BrokerTargets = {
      allowedProcesses: [...processes],
      allowedWindowTitles: [...titles],
    };
    await this.enqueueWrite(saved);
    return saved;
  }

  private async enqueueWrite(targets: BrokerTargets): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const envelope: TargetsEnvelope = {
        contract: COMPANYCLAW_BROKER_TARGETS_CONTRACT,
        schemaVersion: COMPANYCLAW_BROKER_TARGETS_SCHEMA,
        allowedProcesses: targets.allowedProcesses,
        allowedWindowTitles: targets.allowedWindowTitles,
      };
      await this.writeFile(this.filePath, JSON.stringify(envelope, null, 2));
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}
