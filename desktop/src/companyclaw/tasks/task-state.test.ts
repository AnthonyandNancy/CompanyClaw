import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isActiveState,
  isTerminalState,
  nextStateForControl,
  TERMINAL_TASK_STATES,
} from "./task-state";

describe("task state machine", () => {
  it("allows the documented forward transitions", () => {
    expect(canTransition("CREATED", "AUTHENTICATED")).toBe(true);
    expect(canTransition("AUTHENTICATED", "PLANNING")).toBe(true);
    expect(canTransition("PLANNING", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "AWAITING_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "VERIFYING")).toBe(true);
    expect(canTransition("VERIFYING", "COMPLETED")).toBe(true);
    expect(canTransition("VERIFYING", "RUNNING")).toBe(true);
  });

  it("requires RESUMING between PAUSED and RUNNING", () => {
    expect(canTransition("RUNNING", "PAUSE_REQUESTED")).toBe(true);
    expect(canTransition("PAUSE_REQUESTED", "PAUSED")).toBe(true);
    expect(canTransition("PAUSED", "RESUMING")).toBe(true);
    expect(canTransition("RESUMING", "RUNNING")).toBe(true);
    // 直连禁止：恢复必须经过 RESUMING 的环境复核
    expect(canTransition("PAUSED", "RUNNING")).toBe(false);
  });

  it("never transitions out of a terminal state", () => {
    for (const terminal of TERMINAL_TASK_STATES) {
      for (const target of ["RUNNING", "PLANNING", "COMPLETED"] as const) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it("treats every active state as cancelable but terminal states as active-free", () => {
    expect(isActiveState("RUNNING")).toBe(true);
    expect(isActiveState("AWAITING_APPROVAL")).toBe(true);
    expect(isActiveState("PAUSED")).toBe(true);
    expect(isTerminalState("CANCELLED")).toBe(true);
    expect(isActiveState("CANCELLED")).toBe(false);
  });

  it("maps user controls onto the state machine", () => {
    expect(nextStateForControl("RUNNING", "pause")).toBe("PAUSE_REQUESTED");
    expect(nextStateForControl("AWAITING_APPROVAL", "pause")).toBe("PAUSE_REQUESTED");
    expect(nextStateForControl("PAUSED", "resume")).toBe("RESUMING");
    // 暂停/恢复不能越过状态机
    expect(nextStateForControl("CREATED", "resume")).toBeNull();
    expect(nextStateForControl("COMPLETED", "cancel")).toBeNull();
    expect(nextStateForControl("RUNNING", "cancel")).toBe("CANCELLED");
    expect(nextStateForControl("AWAITING_APPROVAL", "cancel")).toBe("CANCELLED");
    expect(nextStateForControl("RUNNING", "emergency-stop")).toBe("CANCELLED");
    expect(nextStateForControl("PAUSED", "emergency-stop")).toBe("CANCELLED");
  });

  it("throws with both states named on an illegal transition", () => {
    expect(() => assertTransition("PAUSED", "RUNNING")).toThrow(/PAUSED.*RUNNING/);
  });
});
