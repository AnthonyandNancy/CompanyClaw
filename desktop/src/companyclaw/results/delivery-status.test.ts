import { describe, expect, it } from "vitest";
import {
  advanceDelivery,
  advanceWithReceipt,
  canAdvanceDelivery,
  DELIVERY_TERMINAL_STATES,
} from "./delivery-status";

describe("delivery status", () => {
  it("treats SENT as platform acceptance, not delivery", () => {
    expect(advanceDelivery("SEND_REQUESTED", { platform: "accepted" })).toBe("SENT");
  });

  it("maps an explicit platform failure to FAILED", () => {
    expect(advanceDelivery("SEND_REQUESTED", { platform: "failed", reason: "403" })).toBe("FAILED");
  });

  it("maps an indeterminate result to UNKNOWN instead of guessing", () => {
    expect(
      advanceDelivery("SEND_REQUESTED", { platform: "indeterminate", reason: "timeout" }),
    ).toBe("UNKNOWN");
  });

  it("requires evidence to reach DELIVERED", () => {
    expect(advanceWithReceipt("SENT", "none")).toBe("SENT");
    expect(advanceWithReceipt("SENT", "terminal-confirmed")).toBe("DELIVERED");
    // An unconfirmed send must never silently upgrade itself.
    expect(advanceWithReceipt("UNKNOWN", "none")).toBe("UNKNOWN");
  });

  it("allows SENT/UNKNOWN/FAILED to be retried and keeps terminal states frozen", () => {
    expect(canAdvanceDelivery("SENT", "SEND_REQUESTED")).toBe(true);
    expect(canAdvanceDelivery("UNKNOWN", "SEND_REQUESTED")).toBe(true);
    expect(canAdvanceDelivery("FAILED", "SEND_REQUESTED")).toBe(true);
    for (const terminal of DELIVERY_TERMINAL_STATES) {
      expect(canAdvanceDelivery(terminal, "SEND_REQUESTED")).toBe(false);
    }
  });
});
