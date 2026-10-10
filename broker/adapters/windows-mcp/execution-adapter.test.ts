import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_SHORTCUTS,
  WindowsMcpExecutionAdapter,
  isAllowedShortcut,
} from "./execution-adapter";

/**
 * The mapping from a broker operation to a real upstream tool call.
 *
 * Written from the requirement's W-capabilities (V5 §3.1) and its negative rules
 * (§5.3): launching must not become an arbitrary command, pointer input must not
 * be guessed, and a shortcut must come from an enumerated set.
 */

function makeAdapter(respond: (input: { tool: string; args: Record<string, unknown> }) => unknown) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const adapter = new WindowsMcpExecutionAdapter({
    callTool: async (input) => {
      calls.push({ tool: input.tool, args: input.args });
      const value = respond(input);
      return value === undefined ? { ok: true as const, content: { echoed: input.tool } } : (value as never);
    },
  });
  return { adapter, calls };
}

describe("application discovery and launch", () => {
  it("launches an installed application by name", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({ operation: "launch-app", args: { app: "QQ" } });
    expect(result.status).toBe("ok");
    expect(calls[0].tool).toBe("App");
    expect(calls[0].args).toMatchObject({ mode: "launch", app: "QQ" });
  });

  it("refuses to launch by path, so launch cannot become exec", async () => {
    const { adapter } = makeAdapter(() => undefined);
    for (const app of ["C:\\Windows\\System32\\cmd.exe", "./run.sh", "..\\..\\evil.exe"]) {
      const result = await adapter.execute({ operation: "launch-app", args: { app } });
      expect(result.status).toBe("rejected");
    }
  });

  it("refuses a launch without an application name", async () => {
    const { adapter } = makeAdapter(() => undefined);
    expect((await adapter.execute({ operation: "launch-app", args: {} })).status).toBe("rejected");
  });

  it("lists installed applications without arguments", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "list-installed-apps" });
    expect(calls[0].args).toEqual({});
  });
});

describe("window and element reads", () => {
  it("focuses a window that the caller addressed", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({
      operation: "focus-window",
      target: { processName: "qq", windowTitle: "QQ" },
    });
    expect(calls[0].args).toMatchObject({ mode: "switch", name: "QQ" });
  });

  it("refuses to focus nothing", async () => {
    const { adapter } = makeAdapter(() => undefined);
    expect((await adapter.execute({ operation: "focus-window" })).status).toBe("rejected");
  });

  it("takes an accessibility snapshot without asking for an image", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "snapshot-ui-tree", target: { windowTitle: "记事本" } });
    expect(calls[0].tool).toBe("Snapshot");
    expect(calls[0].args.use_vision).toBe(false);
  });

  it("requires a label before looking up a control", async () => {
    const { adapter } = makeAdapter(() => undefined);
    expect((await adapter.execute({ operation: "find-control", args: {} })).status).toBe("rejected");
    const ok = await adapter.execute({ operation: "find-control", args: { label: "发送" } });
    expect(ok.status).toBe("ok");
  });
});

describe("screenshot", () => {
  it("uses the screenshot tool", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "screenshot" });
    expect(calls[0].tool).toBe("Screenshot");
  });
});

describe("pointer and keyboard input", () => {
  it("clicks at a verified coordinate", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({ operation: "click", args: { x: 10, y: 20 } });
    expect(result.status).toBe("ok");
    expect(calls[0].args).toMatchObject({ loc: [10, 20], clicks: 1 });
  });

  it("refuses a click without coordinates instead of guessing", async () => {
    const { adapter } = makeAdapter(() => undefined);
    expect((await adapter.execute({ operation: "click", args: {} })).status).toBe("rejected");
    expect(
      (await adapter.execute({ operation: "click", args: { x: -5, y: 10 } })).status,
    ).toBe("rejected");
    expect(
      (await adapter.execute({ operation: "click", args: { x: 1, y: Number.NaN } })).status,
    ).toBe("rejected");
  });

  it("supports a double click and a hover explicitly", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "click", args: { x: 1, y: 2, clicks: 2 } });
    await adapter.execute({ operation: "click", args: { x: 1, y: 2, clicks: 0 } });
    expect(calls[0].args.clicks).toBe(2);
    expect(calls[1].args.clicks).toBe(0);
  });

  it("types text only when there is text", async () => {
    const { adapter } = makeAdapter(() => undefined);
    expect((await adapter.execute({ operation: "typeText", args: { text: "" } })).status).toBe(
      "rejected",
    );
  });

  it("allows only enumerated shortcuts", async () => {
    expect(isAllowedShortcut("Ctrl+A")).toBe(true);
    expect(isAllowedShortcut("win+r")).toBe(false);
    expect(ALLOWED_SHORTCUTS).toContain("ctrl+s");
    const { adapter } = makeAdapter(() => undefined);
    expect(
      (await adapter.execute({ operation: "hotkey", args: { keys: "win+r" } })).status,
    ).toBe("rejected");
  });

  it("bounds a scroll", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "scroll", args: { wheelTimes: 999, direction: "up" } });
    expect(calls[0].args).toMatchObject({ wheel_times: 10, direction: "up" });
  });
});

describe("drag and drop (W13)", () => {
  it("performs a drag when both endpoints and both windows are known", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({
      operation: "drag-drop",
      args: { from: [10, 10], to: [200, 200], sourceWindow: "资源管理器", targetWindow: "记事本" },
    });
    expect(result.status).toBe("ok");
    expect(calls[0].tool).toBe("Move");
    expect(calls[0].args).toMatchObject({ loc: [200, 200], drag: true, from: [10, 10] });
  });

  it("refuses a drag without both endpoints", async () => {
    const { adapter } = makeAdapter(() => undefined);
    const result = await adapter.execute({
      operation: "drag-drop",
      args: { to: [200, 200], sourceWindow: "a", targetWindow: "b" },
    });
    expect(result.status).toBe("rejected");
  });

  it("refuses a drag whose source or target window is unknown", async () => {
    const { adapter } = makeAdapter(() => undefined);
    const result = await adapter.execute({
      operation: "drag-drop",
      args: { from: [1, 1], to: [2, 2] },
    });
    expect(result.status).toBe("rejected");
  });
});

describe("waiting and inspection", () => {
  it("waits with a bounded timeout", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({
      operation: "wait-for-condition",
      args: { text: "完成", timeoutSeconds: 30 },
    });
    expect(result.status).toBe("ok");
    expect(calls[0].args.timeout).toBe(30);
  });

  it("refuses an unbounded or invalid wait", async () => {
    const { adapter } = makeAdapter(() => undefined);
    for (const timeoutSeconds of [0, -1, 999, Number.NaN, "soon"]) {
      const result = await adapter.execute({
        operation: "wait-for-condition",
        args: { text: "x", timeoutSeconds },
      });
      expect(result.status).toBe("rejected");
    }
  });
});

describe("failures are reported, never invented", () => {
  it("refuses an operation with no upstream expression", async () => {
    const { adapter } = makeAdapter(() => undefined);
    const result = await adapter.execute({ operation: "registry-edit" });
    expect(result.status).toBe("rejected");
  });

  it("passes an upstream failure through as a failure", async () => {
    const { adapter } = makeAdapter(() => ({ ok: false, reason: "uia-unavailable" }));
    const result = await adapter.execute({ operation: "snapshot-ui-tree" });
    expect(result).toEqual({ status: "failed", reason: "uia-unavailable" });
  });

  it("does not call upstream when the capability is not permitted", async () => {
    const callTool = vi.fn();
    const adapter = new WindowsMcpExecutionAdapter({ callTool });
    const result = await adapter.execute({ operation: "read-value" });
    expect(result.status).toBe("rejected");
    expect(callTool).not.toHaveBeenCalled();
  });
});
