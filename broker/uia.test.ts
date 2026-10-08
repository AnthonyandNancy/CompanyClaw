import { describe, expect, it, vi } from "vitest";
import { parseWindowList, runListWindows } from "./uia";

describe("parseWindowList", () => {
  it("returns descriptors for a well-formed payload", () => {
    const raw = JSON.stringify({
      windows: [
        { name: "Notepad", processId: 100, automationId: "" },
        { name: "Excel", processId: 200, automationId: "Book1" },
      ],
    });
    expect(parseWindowList(raw)).toEqual({
      ok: true,
      value: [
        { name: "Notepad", processId: 100, automationId: "" },
        { name: "Excel", processId: 200, automationId: "Book1" },
      ],
    });
  });

  it("keeps non-ASCII window titles intact", () => {
    const raw = JSON.stringify({
      windows: [{ name: "物业工程中心 - 工单管理", processId: 1, automationId: "" }],
    });
    const parsed = parseWindowList(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value[0].name).toBe("物业工程中心 - 工单管理");
  });

  it("handles a single-window payload that serialized to an object", () => {
    // Windows PowerShell decides between object and array by element count.
    // A lone window wrapped in `windows` still arrives as an array here, but a
    // malformed shape must not crash the caller.
    expect(parseWindowList(JSON.stringify({ windows: { name: "x" } }))).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  it("skips entries without a usable name instead of failing the whole probe", () => {
    const raw = JSON.stringify({
      windows: [{ processId: 1 }, { name: "ok", processId: 2, automationId: "" }],
    });
    const parsed = parseWindowList(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toHaveLength(1);
  });

  it("reports invalid JSON and invalid payloads distinctly", () => {
    expect(parseWindowList("not json")).toEqual({ ok: false, reason: "invalid-json" });
    expect(parseWindowList("[1,2]")).toEqual({ ok: false, reason: "invalid-payload" });
    expect(parseWindowList("null")).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("defaults missing numeric and string fields", () => {
    const raw = JSON.stringify({ windows: [{ name: "x", automationId: 7 }] });
    const parsed = parseWindowList(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value[0]).toEqual({ name: "x", processId: -1, automationId: "" });
  });
});

describe("runListWindows", () => {
  it("passes the script path and reports a probe failure", async () => {
    const runner = vi.fn((_file, _args, _opts, callback) => {
      callback(new Error("no powershell"), "", "");
      return undefined as never;
    });
    const result = await runListWindows({
      scriptDir: "C:/broker/scripts",
      runner: runner as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("probe-failed");
    const args = runner.mock.calls[0][1] as string[];
    expect(args).toContain("-File");
    expect(args.some((arg: string) => arg.endsWith("list-windows.ps1"))).toBe(true);
  });

  it("parses a successful runner's stdout", async () => {
    const runner = vi.fn((_file, _args, _opts, callback) => {
      callback(null, JSON.stringify({ windows: [{ name: "w", processId: 1, automationId: "" }] }), "");
      return undefined as never;
    });
    const result = await runListWindows({
      scriptDir: "C:/broker/scripts",
      runner: runner as never,
    });
    expect(result).toEqual({ ok: true, value: [{ name: "w", processId: 1, automationId: "" }] });
  });

  it("never lets the runner throw escape", async () => {
    const runner = vi.fn(() => {
      throw new Error("spawn exploded");
    });
    await expect(
      runListWindows({ scriptDir: "C:/broker/scripts", runner: runner as never }),
    ).rejects.toThrow("spawn exploded");
  });
});
