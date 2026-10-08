import { describe, expect, it } from "vitest";
import { parseWindowsSid, resolveOwnerSid } from "./owner-sid";

describe("parseWindowsSid", () => {
  it("accepts a well-formed SID", () => {
    expect(parseWindowsSid("S-1-5-21-38424463-2205608999-488602407-1001")).toBe(
      "S-1-5-21-38424463-2205608999-488602407-1001",
    );
    expect(parseWindowsSid("  S-1-5-18  ")).toBe("S-1-5-18");
  });

  it("rejects output that is not a SID", () => {
    expect(parseWindowsSid("whoami: extra operand")).toBeNull();
    expect(parseWindowsSid("")).toBeNull();
    expect(parseWindowsSid("S-1-5")).toBeNull();
    expect(parseWindowsSid("S-1-5-21-abc")).toBeNull();
  });

  it("rejects a SID embedded among noise lines", () => {
    expect(parseWindowsSid("header\nS-1-5-21-1-2-3-1001\nfooter")).toBeNull();
  });
});

describe("resolveOwnerSid", () => {
  it("uses the injected probe output", () => {
    const sid = resolveOwnerSid({
      runProbe: () => "S-1-5-21-1-2-3-1001\n",
    });
    expect(sid).toBe("S-1-5-21-1-2-3-1001");
  });

  it("falls back to a stable placeholder when the probe fails", () => {
    const sid = resolveOwnerSid({
      runProbe: () => {
        throw new Error("no powershell");
      },
    });
    // A placeholder must be stable (so stored data stays readable) and must not
    // be mistakable for a real SID.
    expect(sid).toBe("LOCAL-USER");
  });

  it("falls back when the probe output is unusable", () => {
    expect(resolveOwnerSid({ runProbe: () => "not a sid" })).toBe("LOCAL-USER");
  });
});
