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

/** An adapter whose only window belongs to `notepad`. */
function makeAdapterWithWindows() {
  const adapter = new WindowsMcpExecutionAdapter({
    callTool: async () => ({ ok: true as const, content: { echoed: true } }),
    resolveWindowTitle: async (processName) =>
      processName.replace(/\.exe$/i, "").toLowerCase() === "notepad"
        ? "无标题 - 记事本"
        : null,
  });
  return adapter;
}

describe("upstream failures stay readable", () => {
  it("turns a thrown upstream error into a refusal with a stable code", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async () => {
        throw new TypeError("expected string or bytes-like object, got 'NoneType'");
      },
    });
    const result = await adapter.execute({ operation: "focus-window", target: { windowTitle: "x" } });
    expect(result).toEqual({ status: "failed", reason: "upstream-call-failed" });
    // The Python text must stay in the log, never in the caller-visible reason.
    expect(warnings).toHaveBeenCalled();
    warnings.mockRestore();
  });
});

describe("focusing a window addressed by process name only", () => {
  it("resolves the window title before asking the server to switch", async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ args: input.args });
        return { ok: true as const, content: {} };
      },
      resolveWindowTitle: async () => "无标题 - 记事本",
    });
    const result = await adapter.execute({
      operation: "focus-window",
      target: { processName: "notepad" },
    });
    expect(result.status).toBe("ok");
    expect(calls[0].args).toMatchObject({ mode: "switch", name: "无标题 - 记事本" });
  });

  it("refuses cleanly when the process owns no window", async () => {
    const adapter = makeAdapterWithWindows();
    const result = await adapter.execute({
      operation: "focus-window",
      target: { processName: "not-running" },
    });
    expect(result).toEqual({ status: "rejected", reason: "window-not-found" });
  });

  it("prefers an explicit window title over a process-name lookup", async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ args: input.args });
        return { ok: true as const, content: {} };
      },
      resolveWindowTitle: async () => "should-not-be-used",
    });
    await adapter.execute({
      operation: "focus-window",
      target: { processName: "notepad", windowTitle: "记事本" },
    });
    expect(calls[0].args).toMatchObject({ mode: "switch", name: "记事本" });
  });
});

describe("application discovery and launch", () => {
  it("launches an installed application by name", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({ operation: "launch-app", args: { app: "QQ" } });
    expect(result.status).toBe("ok");
    expect(calls[0].tool).toBe("App");
    expect(calls[0].args).toMatchObject({ mode: "launch", name: "QQ" });
    // The upstream tool has no `app` parameter; sending one leaves `name` unset
    // and the server answers with a TypeError instead of a readable refusal.
    expect(calls[0].args).not.toHaveProperty("app");
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

  it("refuses to serve discovery through the upstream App tool", async () => {
    // Discovery is a broker-native capability; reaching this adapter for it means
    // the caller took the wrong path, and a fabricated payload would hide that.
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({ operation: "list-installed-apps" });
    expect(result).toEqual({ status: "rejected", reason: "unsupported-operation" });
    expect(calls).toHaveLength(0);
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

  it("brings the addressed window forward before snapshotting it", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "snapshot-ui-tree", target: { windowTitle: "记事本" } });
    // `Snapshot` reads the active window and rejects a `window_name` field —
    // the pinned release documents only `display` and `region` for scoping it.
    expect(calls[0].tool).toBe("App");
    expect(calls[0].args).toMatchObject({ mode: "switch", name: "记事本" });
    expect(calls[1].tool).toBe("Snapshot");
    expect(calls[1].args).toEqual({ use_vision: false });
    expect(calls[1].args).not.toHaveProperty("window_name");
  });

  it("resolves a process name before reading that window", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ tool: input.tool, args: input.args });
        return { ok: true as const, content: {} };
      },
      resolveWindowTitle: async () => "无标题 - 记事本",
    });
    const result = await adapter.execute({
      operation: "snapshot-ui-tree",
      target: { processName: "notepad" },
    });
    expect(result.status).toBe("ok");
    expect(calls[0].args).toMatchObject({ mode: "switch", name: "无标题 - 记事本" });
    expect(calls[1].tool).toBe("Snapshot");
  });

  it("refuses a window-scoped read whose window cannot be resolved", async () => {
    const adapter = makeAdapterWithWindows();
    const result = await adapter.execute({
      operation: "snapshot-ui-tree",
      target: { processName: "not-running" },
    });
    // Reading whoever is in front instead would be a silent wrong-window read.
    expect(result).toEqual({ status: "rejected", reason: "window-not-found" });
  });

  it("reads the active window when the call names no window", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({ operation: "snapshot-ui-tree" });
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("Snapshot");
    expect(calls[0].args).not.toHaveProperty("window_name");
  });

  it("does not read when the window cannot be brought forward", async () => {
    const calls: { tool: string }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ tool: input.tool });
        return input.tool === "App"
          ? { ok: false as const, reason: "Failed to bring 记事本 to the foreground within 1 second." }
          : { ok: true as const, content: {} };
      },
    });
    const result = await adapter.execute({
      operation: "snapshot-ui-tree",
      target: { windowTitle: "记事本" },
    });
    expect(result).toEqual({ status: "rejected", reason: "window-focus-failed" });
    expect(calls.map((call) => call.tool)).toEqual(["App"]);
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
    expect((await adapter.execute({ operation: "type-text", args: { text: "" } })).status).toBe(
      "rejected",
    );
  });

  it("types into a coordinate and refuses when the caller gives none", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const ok = await adapter.execute({
      operation: "type-text",
      args: { text: "大家晚上好", x: 100, y: 200 },
    });
    expect(ok.status).toBe("ok");
    expect(calls[0].tool).toBe("Type");
    expect(calls[0].args).toMatchObject({ text: "大家晚上好", loc: [100, 200] });
    // The upstream tool clicks the location before typing, so a request without
    // one raises inside Python. Refusing here keeps it a readable reason.
    const missing = await adapter.execute({ operation: "type-text", args: { text: "hi" } });
    expect(missing).toEqual({ status: "rejected", reason: "coordinate-required" });
  });

  it("sends an enumerated shortcut and refuses one outside the list", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const ok = await adapter.execute({ operation: "hotkey", args: { keys: "ctrl+c" } });
    expect(ok.status).toBe("ok");
    expect(calls[0].tool).toBe("Shortcut");
    expect(calls[0].args).toEqual({ shortcut: "ctrl+c" });
    const refused = await adapter.execute({ operation: "hotkey", args: { keys: "win+r" } });
    expect(refused.status).toBe("rejected");
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

  it("brings a named window forward before clicking, typing or scrolling", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);

    const clicked = await adapter.execute({
      operation: "click",
      target: { windowTitle: "QQ" },
      args: { x: 10, y: 20 },
    });
    expect(clicked.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Click"]);
    expect(calls[0].args).toEqual({ mode: "switch", name: "QQ" });

    calls.length = 0;
    const typed = await adapter.execute({
      operation: "type-text",
      target: { windowTitle: "QQ" },
      args: { text: "大家晚上好", x: 100, y: 200, pressEnter: true },
    });
    expect(typed.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Type"]);
    expect(calls[1].args).toMatchObject({ text: "大家晚上好", press_enter: true });

    calls.length = 0;
    const scrolled = await adapter.execute({
      operation: "scroll",
      target: { windowTitle: "QQ" },
      args: { direction: "down" },
    });
    expect(scrolled.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Scroll"]);
  });

  it("resolves a process name to a title before a write, the way a read does", async () => {
    // `makeAdapter` above has no window resolver, so the process-name path needs
    // its own call log: the title has to come from `resolveWindowTitle`, exactly
    // as `focus-window` and the reads already do it.
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ tool: input.tool, args: input.args });
        return { ok: true as const, content: {} };
      },
      resolveWindowTitle: async (processName) =>
        processName.toLowerCase() === "notepad" ? "无标题 - 记事本" : null,
    });
    const ok = await adapter.execute({
      operation: "type-text",
      target: { processName: "notepad" },
      args: { text: "hi", x: 1, y: 2 },
    });
    expect(ok.status).toBe("ok");
    expect(calls.map((call) => call.tool)).toEqual(["App", "Type"]);
    expect(calls[0].args).toEqual({ mode: "switch", name: "无标题 - 记事本" });

    // A process with no window is a refusal, never a write against whatever is
    // in front.
    calls.length = 0;
    const missing = await adapter.execute({
      operation: "click",
      target: { processName: "not-running" },
      args: { x: 1, y: 2 },
    });
    expect(missing).toEqual({ status: "rejected", reason: "window-not-found" });
    expect(calls).toHaveLength(0);
  });

  it("leaves a targetless write as a single call, exactly as before", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    await adapter.execute({ operation: "click", args: { x: 10, y: 20 } });
    await adapter.execute({ operation: "type-text", args: { text: "hi", x: 1, y: 2 } });
    await adapter.execute({ operation: "scroll", args: {} });
    // No window was named, so there is nothing to switch to. Adding one would
    // change today's behaviour for every plain coordinate call.
    expect(calls.map((call) => call.tool)).toEqual(["Click", "Type", "Scroll"]);
  });

  it("validates arguments before touching the window", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const noCoordinate = await adapter.execute({
      operation: "click",
      target: { windowTitle: "QQ" },
      args: {},
    });
    expect(noCoordinate).toEqual({ status: "rejected", reason: "coordinate-required" });
    const noText = await adapter.execute({
      operation: "type-text",
      target: { windowTitle: "QQ" },
      args: { text: "" },
    });
    expect(noText).toEqual({ status: "rejected", reason: "text-required" });
    // A refusal must not have moved the user's foreground window first.
    expect(calls).toHaveLength(0);
  });

  it("does not act when the named window cannot be brought forward", async () => {
    const calls: { tool: string }[] = [];
    const adapter = new WindowsMcpExecutionAdapter({
      callTool: async (input) => {
        calls.push({ tool: input.tool });
        return input.tool === "App"
          ? { ok: false as const, reason: "Failed to bring 记事本 to the foreground within 1 second." }
          : { ok: true as const, content: {} };
      },
    });
    const result = await adapter.execute({
      operation: "type-text",
      target: { windowTitle: "记事本" },
      args: { text: "hi", x: 1, y: 2 },
    });
    // Typing into whichever window happens to be in front is the failure the
    // caller must never be shown as success.
    expect(result).toEqual({ status: "rejected", reason: "window-focus-failed" });
    expect(calls.map((call) => call.tool)).toEqual(["App"]);
  });

  it("keeps a shortcut pointed at whatever holds focus", async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({
      operation: "hotkey",
      target: { windowTitle: "QQ" },
      args: { keys: "ctrl+f" },
    });
    expect(result.status).toBe("ok");
    // alt+tab through a focus-changing prelude would defeat itself, so no
    // shortcut may be preceded by a window switch.
    expect(calls.map((call) => call.tool)).toEqual(["Shortcut"]);
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

  it("still scopes a wait with window_name, which the wait tool does accept", async () => {
    // `WaitFor` is the one tool whose signature carries `window_name`; the fix
    // for the reads must not be applied to it.
    const { adapter, calls } = makeAdapter(() => undefined);
    const result = await adapter.execute({
      operation: "wait-for-condition",
      target: { windowTitle: "记事本" },
      args: { text: "完成", timeoutSeconds: 5 },
    });
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("WaitFor");
    expect(calls[0].args).toMatchObject({ window_name: "记事本" });
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
