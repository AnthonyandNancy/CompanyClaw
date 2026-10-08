import { describe, expect, it } from "vitest";
import { classifyAction, decideAction } from "./risk-classifier";

const authorized = { remoteAuthorization: "enabled" as const };

describe("classifyAction", () => {
  it("only classifies R0 when read-only is proven by a system-level signal", () => {
    const unproven = classifyAction({ kind: "read", toolName: "browser.snapshot" });
    expect(unproven.level).not.toBe("R0");
    expect(unproven.reasons.join(" ")).toMatch(/no system-level read-only proof/i);

    const proven = classifyAction({
      kind: "read",
      toolName: "browser.snapshot",
      readOnlyProof: "read-only-account",
    });
    expect(proven.level).toBe("R0");
  });

  it("never treats an unknown tool name as safe", () => {
    for (const toolName of ["Click", "Type", "Shortcut", "mystery.tool"]) {
      expect(classifyAction({ kind: "unknown", toolName }).level).toBe("R2");
    }
  });

  it("maps local non-writing work to R1", () => {
    expect(classifyAction({ kind: "local-work", toolName: "excel-xlsx" }).level).toBe("R1");
  });

  it("maps business writes to R2 and high-risk classes to R3", () => {
    expect(
      classifyAction({ kind: "write", toolName: "browser.click", writesBusinessData: true }).level,
    ).toBe("R2");
    expect(classifyAction({ kind: "high-risk", toolName: "exec" }).level).toBe("R3");
  });

  it("classifies R3 by class, not by tool name", () => {
    expect(classifyAction({ kind: "delete" }).level).toBe("R3");
    expect(classifyAction({ kind: "payment" }).level).toBe("R3");
    expect(classifyAction({ kind: "publish" }).level).toBe("R3");
    expect(classifyAction({ kind: "system-config" }).level).toBe("R3");
    expect(classifyAction({ kind: "registry" }).level).toBe("R3");
    expect(classifyAction({ kind: "arbitrary-command" }).level).toBe("R3");
    expect(classifyAction({ kind: "unknown-program" }).level).toBe("R3");
    expect(classifyAction({ kind: "bypass-security" }).level).toBe("R3");
  });
});

describe("decideAction", () => {
  it("allows R0 and R1 only when remote authorization is enabled", () => {
    const read = { kind: "read" as const, readOnlyProof: "read-only-acl" as const };
    expect(decideAction(read, authorized).decision).toBe("allow");
    expect(decideAction({ kind: "local-work" }, authorized).decision).toBe("allow");
    for (const state of ["disabled", "expired", "revoked"] as const) {
      expect(decideAction(read, { remoteAuthorization: state }).decision).toBe("deny");
    }
  });

  it("requires approval for R2 regardless of authorization", () => {
    expect(decideAction({ kind: "write" }, authorized).decision).toBe("require-approval");
  });

  it("always denies R3, with no override path", () => {
    for (const kind of ["delete", "payment", "publish", "system-config"] as const) {
      expect(decideAction({ kind }, authorized).decision).toBe("deny");
    }
  });

  it("denies a write whose final commit cannot be intercepted", () => {
    const result = decideAction(
      { kind: "write", writesBusinessData: true, commitInterceptable: false },
      authorized,
    );
    expect(result.decision).toBe("deny");
    expect(result.reasons.join(" ")).toMatch(/cannot be intercepted/i);
  });
});
