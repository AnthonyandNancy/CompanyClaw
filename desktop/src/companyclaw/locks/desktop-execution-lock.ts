/**
 * Serialises focus-sensitive desktop automation for one interactive session.
 *
 * Two remote tasks that both type into the foreground window would interleave
 * their keystrokes, so the second one must be refused rather than queued: a
 * queue would eventually run against a desktop the user has since changed.
 * Read-only probes do not take the lock, because they cannot steal focus.
 *
 * The lock has a lease. A holder that never releases — an executor wedged behind
 * an application that never shows its window, for instance — would otherwise
 * refuse every later tool for the life of the process, and the refusal names the
 * lock rather than the fault, so the employee sees "busy" with nothing running.
 * Expiry makes that state self-healing; the in-flight call is still bounded by
 * the transport's own timeout.
 */

/** How long one focus-sensitive call may hold the lock. */
export const DESKTOP_LOCK_LEASE_MS = 180_000;

export type DesktopLockOutcome =
  | { acquired: true; release: () => void }
  | { acquired: false; reason: "desktop-busy" };

export class DesktopExecutionLock {
  private holder: string | null = null;
  private expiresAt = 0;
  private readonly now: () => number;
  private readonly leaseMs: number;

  constructor(options: { now?: () => number; leaseMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? DESKTOP_LOCK_LEASE_MS;
  }

  /** True while a focus-sensitive task is running. */
  isBusy(): boolean {
    this.expireIfStale();
    return this.holder !== null;
  }

  /** The taskId currently holding the lock, for diagnostics. */
  currentHolder(): string | null {
    this.expireIfStale();
    return this.holder;
  }

  /**
   * Takes the lock for one task.
   *
   * Re-entering with the same taskId succeeds so a task can perform several
   * consecutive steps without releasing in between; the lease is renewed, so a
   * long but healthy sequence is not cut off by its own first step.
   */
  acquire(taskId: string): DesktopLockOutcome {
    this.expireIfStale();
    if (this.holder === taskId) {
      this.expiresAt = this.now() + this.leaseMs;
      return { acquired: true, release: () => undefined };
    }
    if (this.holder !== null) {
      return { acquired: false, reason: "desktop-busy" };
    }
    this.holder = taskId;
    this.expiresAt = this.now() + this.leaseMs;
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        if (this.holder === taskId) {
          this.holder = null;
          this.expiresAt = 0;
        }
      },
    };
  }

  /** Releases whatever is held; used when a task is cancelled. */
  forceRelease(taskId: string): void {
    if (this.holder === taskId) {
      this.holder = null;
      this.expiresAt = 0;
    }
  }

  /** Drops a lease that outlived its bound, so the next caller is not refused. */
  private expireIfStale(): void {
    if (this.holder !== null && this.now() >= this.expiresAt) {
      this.holder = null;
      this.expiresAt = 0;
    }
  }
}
