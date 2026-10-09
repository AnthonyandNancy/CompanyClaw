/**
 * Serialises focus-sensitive desktop automation for one interactive session.
 *
 * Two remote tasks that both type into the foreground window would interleave
 * their keystrokes, so the second one must be refused rather than queued: a
 * queue would eventually run against a desktop the user has since changed.
 * Read-only probes do not take the lock, because they cannot steal focus.
 */

export type DesktopLockOutcome =
  | { acquired: true; release: () => void }
  | { acquired: false; reason: "desktop-busy" };

export class DesktopExecutionLock {
  private holder: string | null = null;

  /** True while a focus-sensitive task is running. */
  isBusy(): boolean {
    return this.holder !== null;
  }

  /** The taskId currently holding the lock, for diagnostics. */
  currentHolder(): string | null {
    return this.holder;
  }

  /**
   * Takes the lock for one task.
   *
   * Re-entering with the same taskId succeeds so a task can perform several
   * consecutive steps without releasing in between.
   */
  acquire(taskId: string): DesktopLockOutcome {
    if (this.holder === taskId) {
      return { acquired: true, release: () => undefined };
    }
    if (this.holder !== null) {
      return { acquired: false, reason: "desktop-busy" };
    }
    this.holder = taskId;
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        if (this.holder === taskId) this.holder = null;
      },
    };
  }

  /** Releases whatever is held; used when a task is cancelled. */
  forceRelease(taskId: string): void {
    if (this.holder === taskId) this.holder = null;
  }
}
