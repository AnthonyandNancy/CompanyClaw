import { describe, expect, it } from "vitest";
import { categoryFor, decideAction } from "./risk-classifier";
import type { PolicyContext } from "./risk-classifier";

/**
 * Ruling-level assertions for the V5 consequence split.
 *
 * These are written from the confirmed Requirement (Q1 / Q-A / Q-B), not from
 * the implementation: a permanent delete is refused from WeChat while the same
 * owner may confirm a recycle-bin delete locally, and a single-recipient chat
 * message must be *usable* rather than blocked by the old coarse "publish" ban.
 */

const local: PolicyContext = { remoteAuthorization: "disabled", origin: "local-ui" };
const remote = (authorization: PolicyContext["remoteAuthorization"] = "enabled"): PolicyContext => ({
  remoteAuthorization: authorization,
  origin: "weixin-private",
});

describe("V5 Q-A - deletion is split by consequence", () => {
  it("asks for confirmation for a recoverable delete on both channels", () => {
    expect(decideAction({ kind: "delete-to-recycle-bin" }, local).decision).toBe(
      "require-approval",
    );
    expect(decideAction({ kind: "delete-to-recycle-bin" }, remote()).decision).toBe(
      "require-approval",
    );
  });

  it("refuses an irreversible delete from WeChat", () => {
    for (const kind of [
      "delete-permanent",
      "delete-batch-irreversible",
      "overwrite-unrecoverable",
    ] as const) {
      const decision = decideAction({ kind }, remote());
      expect(decision.level).toBe("R3");
      expect(decision.decision).toBe("deny");
    }
  });

  it("keeps a remote refusal from disabling the local equivalent", () => {
    // The same category the remote channel refuses is confirmable locally.
    expect(decideAction({ kind: "delete-permanent" }, remote()).decision).toBe("deny");
    expect(decideAction({ kind: "delete-permanent" }, local).decision).toBe("require-approval");
  });

  it("runs the task's own scratch cleanup without prompting", () => {
    expect(decideAction({ kind: "task-temp-cleanup" }, local).decision).toBe("allow");
    expect(decideAction({ kind: "task-temp-cleanup" }, remote()).decision).toBe("allow");
  });

  it("treats a recoverable overwrite as a business write", () => {
    expect(decideAction({ kind: "overwrite-recoverable" }, remote()).decision).toBe(
      "require-approval",
    );
  });
});

describe("V5 Q-B - messaging is graded by audience", () => {
  it("allows a single-recipient message after a confirmation", () => {
    const decision = decideAction({ kind: "message-single-recipient" }, remote());
    expect(decision.decision).toBe("require-approval");
    expect(decision.level).not.toBe("R3");
  });

  it("refuses group and bulk sending from WeChat", () => {
    for (const kind of ["message-group", "message-bulk"] as const) {
      expect(decideAction({ kind }, remote()).decision).toBe("deny");
    }
  });

  it("re-classifies a multi-recipient message as bulk whatever the caller declared", () => {
    const decision = decideAction(
      { kind: "message-single-recipient", recipients: ["a", "b"] },
      remote(),
    );
    expect(decision.decision).toBe("deny");
  });

  it("keeps a group send confirmable on the owner's own machine", () => {
    expect(decideAction({ kind: "message-group" }, local).decision).toBe("require-approval");
  });

  it("refuses sensitive exfiltration and third-party attachment batches from WeChat", () => {
    for (const kind of ["sensitive-exfil", "attachment-bulk"] as const) {
      expect(decideAction({ kind }, remote()).decision).toBe("deny");
    }
    expect(decideAction({ kind: "attachment-to-third-party" }, remote()).decision).toBe(
      "require-approval",
    );
  });
});

describe("V5 Q-A/Q-B - the categories no channel may authorize", () => {
  it("refuses payment, privilege and uncharacterised high risk everywhere", () => {
    for (const kind of [
      "payment",
      "bypass-security",
      "system-config",
      "registry",
      "arbitrary-command",
      "unknown-program",
      "high-risk",
    ] as const) {
      expect(decideAction({ kind }, local).decision).toBe("deny");
      expect(decideAction({ kind }, remote()).decision).toBe("deny");
    }
  });
});

describe("V5 - the local channel is not short-circuited by the remote switch", () => {
  it("still runs a proven read locally while remote access is disabled", () => {
    const read = { kind: "read" as const, readOnlyProof: "read-only-acl" as const };
    expect(decideAction(read, local).decision).toBe("allow");
    for (const state of ["disabled", "expired", "revoked"] as const) {
      expect(decideAction(read, { remoteAuthorization: state, origin: "weixin-private" }).decision).toBe(
        "deny",
      );
    }
  });

  it("keeps an unproven read as a business write on both channels", () => {
    expect(categoryFor("read")).toBe("read");
    expect(decideAction({ kind: "read" }, local).decision).toBe("require-approval");
    expect(decideAction({ kind: "read" }, remote()).decision).toBe("require-approval");
  });

  it("ignores a task grant while the preset is BASIC", () => {
    const context: PolicyContext = { ...remote(), preset: "BASIC", taskGranted: true };
    expect(decideAction({ kind: "message-single-recipient" }, context).decision).toBe(
      "require-approval",
    );
  });

  it("runs a task-covered business write under FULL_DAILY without a prompt", () => {
    const context: PolicyContext = { ...remote(), preset: "FULL_DAILY", taskGranted: true };
    expect(decideAction({ kind: "message-single-recipient" }, context).decision).toBe("allow");
  });

  it("never lets a task grant widen an R3 category", () => {
    const context: PolicyContext = { ...remote(), preset: "FULL_DAILY", taskGranted: true };
    expect(decideAction({ kind: "delete-permanent" }, context).decision).toBe("deny");
    expect(decideAction({ kind: "message-bulk" }, context).decision).toBe("deny");
  });
});
