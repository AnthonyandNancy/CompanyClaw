import { describe, expect, it } from "vitest";
import { AUDIT_CONTRACT, AuditLog, queryAuditLines, type AuditEntry } from "./audit-log";

/**
 * The audit trail requirement V5 §4.2 (step 9) asks for: the actual allow or
 * deny reason, the policy version, the target and a result reference — and no
 * plaintext screenshot, secret or prompt.
 */

function memorySink() {
  const lines: string[] = [];
  const log = new AuditLog(
    { filePath: "audit.jsonl" },
    {
      append: async (_file, line) => {
        lines.push(line);
      },
      now: () => new Date("2026-10-10T00:00:00Z"),
    },
  );
  return { log, lines };
}

const ENTRY = {
  taskId: "t-1",
  stepId: "s-1",
  origin: "local-ui" as const,
  ownerSid: "S-1",
  deviceId: "device-a",
  tool: "click",
  actionCategory: "write",
  decision: "allow" as const,
  reason: "covered by the task scope",
  policyVersion: 3,
  preset: "FULL_DAILY",
  autoAllowed: true,
  target: "QQ",
};

describe("recording a decision", () => {
  it("writes one JSON line per entry", async () => {
    const { log, lines } = memorySink();
    await log.record(ENTRY);
    await log.record({ ...ENTRY, decision: "deny", reason: "remote mode forbids" });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(JSON.parse(line).contract).toBe(AUDIT_CONTRACT);
    }
  });

  it("keeps the reason, the policy version and the target", async () => {
    const { log, lines } = memorySink();
    await log.record(ENTRY);
    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.reason).toBe("covered by the task scope");
    expect(parsed.policyVersion).toBe(3);
    expect(parsed.target).toBe("QQ");
    expect(parsed.autoAllowed).toBe(true);
  });

  it("has no field that could carry an image or a secret", async () => {
    const { log, lines } = memorySink();
    await log.record(ENTRY);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    for (const forbidden of ["screenshot", "image", "password", "token", "prompt", "payload"]) {
      expect(parsed).not.toHaveProperty(forbidden);
    }
  });

  it("does not fail the action when the log cannot be written", async () => {
    const log = new AuditLog(
      { filePath: "audit.jsonl" },
      {
        append: async () => {
          throw new Error("disk full");
        },
      },
    );
    // The action already happened; turning a logging fault into a failure would
    // misreport what occurred.
    await expect(log.record(ENTRY)).resolves.toBeUndefined();
  });
});

describe("reading the trail", () => {
  it("skips a truncated trailing line", () => {
    const lines = [JSON.stringify({ contract: AUDIT_CONTRACT, ...ENTRY }), '{"contract":"company'];
    expect(queryAuditLines(lines)).toHaveLength(1);
  });

  it("ignores an entry from another contract", () => {
    expect(queryAuditLines([JSON.stringify({ contract: "other", at: "x", taskId: "t-1" })])).toEqual(
      [],
    );
  });

  it("filters by task and decision", () => {
    const lines = [
      JSON.stringify({ contract: AUDIT_CONTRACT, at: "2026-10-10T00:00:00.000Z", ...ENTRY }),
      JSON.stringify({
        contract: AUDIT_CONTRACT,
        at: "2026-10-10T00:01:00.000Z",
        ...ENTRY,
        taskId: "t-2",
        decision: "deny",
      }),
    ];
    expect(queryAuditLines(lines, { taskId: "t-2" })).toHaveLength(1);
    expect(queryAuditLines(lines, { decision: "deny" })).toHaveLength(1);
    expect(queryAuditLines(lines, { decision: "allow" })).toHaveLength(1);
  });

  it("respects the limit", () => {
    const lines = Array.from({ length: 10 }, (_v, index) =>
      JSON.stringify({
        contract: AUDIT_CONTRACT,
        at: `2026-10-10T00:0${index}:00.000Z`,
        ...ENTRY,
      }),
    );
    expect(queryAuditLines(lines, { limit: 3 })).toHaveLength(3);
  });

  it("filters by time window", () => {
    const lines = [
      JSON.stringify({ contract: AUDIT_CONTRACT, at: "2026-10-10T00:00:00.000Z", ...ENTRY }),
      JSON.stringify({ contract: AUDIT_CONTRACT, at: "2026-10-11T00:00:00.000Z", ...ENTRY }),
    ];
    expect(queryAuditLines(lines, { to: "2026-10-10T12:00:00.000Z" })).toHaveLength(1);
    expect(queryAuditLines(lines, { from: "2026-10-10T12:00:00.000Z" })).toHaveLength(1);
  });
});
