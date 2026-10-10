import {
  createEmptyPermissionPolicy,
  isPermissionPolicy,
  type PermissionPolicy,
} from "./permission-policy";

/**
 * Reads and writes the permission document.
 *
 * The file is the only authority record, so two rules matter more than the
 * plumbing:
 *
 *   1. an unreadable or malformed file authorizes *nothing* (the safe state),
 *      and the original bytes are preserved beside it instead of being
 *      overwritten — a user whose policy file was corrupted must be able to
 *      inspect what was there;
 *   2. writes are serialized and atomic (temp file + rename), because the
 *      policy is read on every decision while the UI can change it at the same
 *      time.
 */

export interface PermissionStoreDependencies {
  now?: () => Date;
  existsFile: (filePath: string) => boolean;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, contents: string) => Promise<void>;
  /** Preserves the unusable original; returns the path it was kept at. */
  backupFile?: (filePath: string, stamp: string) => string;
}

export interface PermissionStoreInspection {
  policy: PermissionPolicy;
  /** Non-null when the stored file was unusable and defaults were applied. */
  warning: string | null;
  /** Path of the preserved original, when one was kept. */
  backupPath: string | null;
}

export class PermissionStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(
    readonly filePath: string,
    private readonly deps: PermissionStoreDependencies,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Reads the policy, falling back to the safe state.
   *
   * A missing file is not an error: it is a fresh install, and the safe state
   * is exactly what a fresh install should have.
   */
  inspect(): PermissionStoreInspection {
    let raw: string;
    try {
      if (!this.deps.existsFile(this.filePath)) {
        return { policy: createEmptyPermissionPolicy(), warning: null, backupPath: null };
      }
      raw = this.deps.readFile(this.filePath);
    } catch {
      return {
        policy: createEmptyPermissionPolicy(),
        warning: "权限配置无法读取，已按安全默认值处理（未授予任何权限）",
        backupPath: null,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        policy: createEmptyPermissionPolicy(),
        warning: "权限配置已损坏，已按安全默认值处理（未授予任何权限）",
        backupPath: this.preserve(raw),
      };
    }

    if (!isPermissionPolicy(parsed)) {
      return {
        policy: createEmptyPermissionPolicy(),
        warning: "权限配置版本不受支持，已按安全默认值处理（未授予任何权限）",
        backupPath: this.preserve(raw),
      };
    }

    return { policy: parsed, warning: null, backupPath: null };
  }

  read(): PermissionPolicy {
    return this.inspect().policy;
  }

  /**
   * Replaces the whole document.
   *
   * Callers pass a policy they obtained from `read()`, so the store never
   * merges partial updates: a permission change is one document change.
   */
  async save(policy: PermissionPolicy): Promise<PermissionPolicy> {
    await this.enqueue(async () => {
      await this.deps.writeFile(this.filePath, JSON.stringify(policy, null, 2));
    });
    return policy;
  }

  /**
   * Resolves once every queued write has landed.
   *
   * Needed wherever a caller must be able to say "this grant is durably
   * recorded" — an upgrade, a UI that reports success, and the reset flow.
   */
  async whenIdle(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(work);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private preserve(_raw: string): string | null {
    if (!this.deps.backupFile) return null;
    try {
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      return this.deps.backupFile(this.filePath, stamp);
    } catch {
      return null;
    }
  }

  /** Serialization helper used by tests and by the backup hook. */
  serialize(policy: PermissionPolicy): string {
    return JSON.stringify(policy, null, 2);
  }
}
