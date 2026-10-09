import { describe, expect, it } from "vitest";
import { DesktopExecutionLock } from "./desktop-execution-lock";

/**
 * Two remote tasks typing into the same foreground window would interleave
 * their keystrokes, so one desktop may only be driven by one task at a time.
 * Refusing the second task is the point: queueing it would eventually run
 * against a desktop the user has since changed.
 */
describe("desktop execution lock", () => {
  it("lets one task hold the desktop", () => {
    const lock = new DesktopExecutionLock();
    const first = lock.acquire("task-a");
    expect(first.acquired).toBe(true);
    expect(lock.isBusy()).toBe(true);
    expect(lock.currentHolder()).toBe("task-a");
  });

  it("refuses a second task while one is running", () => {
    const lock = new DesktopExecutionLock();
    lock.acquire("task-a");
    const second = lock.acquire("task-b");
    expect(second).toEqual({ acquired: false, reason: "desktop-busy" });
    // The holder must not change because a request was refused.
    expect(lock.currentHolder()).toBe("task-a");
  });

  it("frees the desktop when the holder releases", () => {
    const lock = new DesktopExecutionLock();
    const held = lock.acquire("task-a");
    if (!held.acquired) throw new Error("expected the lock");
    held.release();
    expect(lock.isBusy()).toBe(false);
    expect(lock.acquire("task-b").acquired).toBe(true);
  });

  it("lets the same task continue through several steps", () => {
    const lock = new DesktopExecutionLock();
    lock.acquire("task-a");
    // A task that performs several focus-sensitive steps must not have to
    // release the desktop between them.
    expect(lock.acquire("task-a").acquired).toBe(true);
    expect(lock.currentHolder()).toBe("task-a");
  });

  it("ignores a release that comes from a task that no longer holds it", () => {
    const lock = new DesktopExecutionLock();
    const held = lock.acquire("task-a");
    if (!held.acquired) throw new Error("expected the lock");
    lock.forceRelease("task-a");
    lock.acquire("task-b");
    // The stale release must not free the new holder's desktop.
    held.release();
    expect(lock.currentHolder()).toBe("task-b");
  });

  it("frees a cancelled task's desktop", () => {
    const lock = new DesktopExecutionLock();
    lock.acquire("task-a");
    lock.forceRelease("task-a");
    expect(lock.isBusy()).toBe(false);
  });

  it("does not free another task's desktop when cancelling", () => {
    const lock = new DesktopExecutionLock();
    lock.acquire("task-a");
    lock.forceRelease("task-b");
    expect(lock.currentHolder()).toBe("task-a");
  });
});
