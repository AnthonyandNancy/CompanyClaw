import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  buildInitializeResult,
  buildToolsListResult,
  describeTools,
  encodeBridgeFrame,
  handleBridgeMessage,
  parseBridgeFrame,
  toolInputSchema,
  RPC_METHOD_NOT_FOUND,
} from "./mcp-bridge";
import { AGENT_TOOLS } from "../tools/computer-use-tools";

/**
 * The MCP surface the agent sees.
 *
 * Two things are being pinned here, both from the requirement rather than from
 * the code: the tool list must be the *controlled* surface (no shell, no file
 * system, no registry), and no tool may expose an approval field, because a model
 * that can fill one in can approve its own request.
 */

describe("tool discovery", () => {
  it("advertises exactly the controlled tool surface", () => {
    const names = describeTools().map((tool) => tool.name);
    expect(names).toEqual(AGENT_TOOLS.map((tool) => tool.name));
    expect(names).toContain("launch-app");
    expect(names).toContain("drag-drop");
  });

  it("never advertises a shell, file system or registry capability", () => {
    const names = describeTools().map((tool) => tool.name);
    for (const forbidden of [
      "powershell",
      "exec",
      "shell",
      "run",
      "filesystem",
      "read-file",
      "write-file",
      "registry",
      "clipboard",
      "process",
      "scrape",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("exposes no approval field on any tool", () => {
    for (const tool of describeTools()) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const forbidden of ["approvalTicket", "approved", "approvalId", "origin", "ownerSid"]) {
        expect(Object.keys(properties)).not.toContain(forbidden);
      }
    }
  });

  it("requires the arguments the executor refuses to guess", () => {
    const byName = new Map(describeTools().map((tool) => [tool.name, tool]));
    const required = (name: string) =>
      (byName.get(name)!.inputSchema as { required: string[] }).required;

    // A click without coordinates and a drag without both ends are exactly the
    // guesses the policy layer would have to refuse afterwards.
    expect(required("click")).toEqual(["x", "y"]);
    expect(required("drag-drop")).toEqual(["from", "to", "sourceWindow", "targetWindow"]);
    expect(required("launch-app")).toEqual(["app"]);
    expect(required("find-control")).toEqual(["label"]);
  });

  it("describes a launch as name-only and a click as coordinate-bound", () => {
    const launch = describeTools().find((tool) => tool.name === "launch-app")!;
    expect(launch.description).toContain("不接受路径");
    const click = describeTools().find((tool) => tool.name === "click")!;
    expect(click.description).toContain("界面读取");
  });

  it("tells the model to read first and how a write reaches a named window", () => {
    const byName = new Map(describeTools().map((tool) => [tool.name, tool]));

    // The model never sees `initialize.instructions` — OpenClaw only forwards
    // each tool's own description — so the ordering contract has to live here.
    expect(byName.get("snapshot-ui-tree")!.description).toContain("第一步");
    expect(byName.get("click")!.description).toContain("重读");
    expect(byName.get("click")!.description).toContain("前台");
    expect(byName.get("type-text")!.description).toContain("前台");
    expect(byName.get("wait-for-condition")!.description).toContain("代替反复读取");
  });

  it("says that pressEnter submits, which is how a message is actually sent", () => {
    const typeText = describeTools().find((tool) => tool.name === "type-text")!;
    expect(typeText.description).toContain("提交");
    const properties = (typeText.inputSchema as {
      properties: Record<string, { description?: string }>;
    }).properties;
    expect(properties.pressEnter.description).toContain("回车提交");
  });

  it("keeps every description under the client's per-tool limit", () => {
    // OpenClaw truncates tool descriptions at 1024 characters
    // (`NODE_MCP_DESCRIPTION_MAX_CHARS`), and a truncated contract is a
    // half-read one.
    for (const tool of describeTools()) {
      expect(tool.description.length).toBeLessThan(300);
    }
  });

  it("describes the window field on every tool that can address one", () => {
    const byName = new Map(describeTools().map((tool) => [tool.name, tool]));
    for (const name of ["snapshot-ui-tree", "click", "type-text", "scroll", "verify-state"]) {
      const properties = (byName.get(name)!.inputSchema as {
        properties: Record<string, { description?: string }>;
      }).properties;
      expect(properties.windowTitle.description).toBeTruthy();
    }
  });

  it("separates the tools that focus a window from the ones that only read it", () => {
    const byName = new Map(describeTools().map((tool) => [tool.name, tool]));
    const described = (name: string) =>
      (byName.get(name)!.inputSchema as {
        properties: Record<string, { description?: string }>;
      }).properties.windowTitle.description!;
    // Saying "will be focused" about WaitFor or inspect-dialog would be false:
    // they pass the title upstream as `window_name` and never switch windows.
    expect(described("click")).toContain("切到前台");
    expect(described("wait-for-condition")).toContain("不会切换前台");
    expect(described("inspect-dialog")).toContain("不会切换前台");
  });

  it("keeps the stdio tool list in step with the http one", async () => {
    // Two hand-maintained lists reach the model on two different transports; a
    // contract written into only one of them would be invisible on that path.
    const source = await readFile(path.join(__dirname, "mcp-bridge-server.ts"), "utf-8");
    for (const tool of describeTools()) {
      expect(source).toContain(`"${tool.name}"`);
    }
    // Markers rather than whole sentences: the two files lay their strings out
    // differently (concatenated lines vs. one literal), and it is the contract
    // words that must survive, not the line wrapping.
    for (const marker of [
      "任何桌面操作的第一步",
      "不会点到别的窗口",
      "回车提交",
      "代替反复读取",
      "先把此窗口切到前台再执行",
      "不会切换前台",
    ]) {
      expect(source).toContain(marker);
    }
  });

  it("gives an unknown tool a restrictive schema rather than a permissive one", () => {
    const schema = toolInputSchema({
      name: "mystery",
      description: "",
      capability: "verifyState",
      mutating: true,
    });
    expect((schema as { properties: Record<string, unknown> }).properties).toEqual({});
    expect((schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("announces itself as the CompanyClaw computer-use server", () => {
    const result = buildInitializeResult();
    expect((result.serverInfo as { name: string }).name).toBe("companyclaw-computer-use");
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("returns the tools under the key MCP expects", () => {
    expect(Object.keys(buildToolsListResult())).toEqual(["tools"]);
  });
});

describe("frame handling", () => {
  it("answers initialize with the server identity", async () => {
    const response = await handleBridgeMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { callTool: async () => ({ ok: true, text: "unused" }) },
    );
    expect(response?.id).toBe(1);
    expect(response?.result).toBeDefined();
  });

  it("does not answer a notification", async () => {
    const response = await handleBridgeMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { callTool: async () => ({ ok: true, text: "unused" }) },
    );
    expect(response).toBeNull();
  });

  it("refuses an unknown method with the standard code", async () => {
    const response = await handleBridgeMessage(
      { jsonrpc: "2.0", id: 9, method: "resources/read" },
      { callTool: async () => ({ ok: true, text: "unused" }) },
    );
    expect(response?.error?.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  it("routes a tool call through the facade", async () => {
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const response = await handleBridgeMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } },
      {
        callTool: async (call) => {
          calls.push(call);
          return { ok: true, text: "已点击" };
        },
      },
    );
    expect(calls).toEqual([{ name: "click", arguments: { x: 1, y: 2 } }]);
    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0].text).toBe("已点击");
  });

  it("reports a refusal as a tool result, not as a protocol error", async () => {
    // The model has to see the reason and adapt; an MCP-level error would only
    // look like a transport fault.
    const diagnostics: string[] = [];
    const response = await handleBridgeMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } },
      {
        callTool: async () => ({ ok: false, text: "该操作需要你确认", reason: "approval-required" }),
        onDiagnostic: (message) => diagnostics.push(message),
      },
    );
    expect(response?.error).toBeUndefined();
    expect((response?.result as { isError: boolean }).isError).toBe(true);
    expect(diagnostics.some((entry) => entry.includes("approval-required"))).toBe(true);
  });

  it("rejects a call without a tool name", async () => {
    const response = await handleBridgeMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {} },
      { callTool: async () => ({ ok: true, text: "unused" }) },
    );
    expect(response?.error?.code).toBe(-32602);
  });

  it("treats missing arguments as an empty object rather than failing", async () => {
    const seen: Record<string, unknown>[] = [];
    await handleBridgeMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list-windows" } },
      {
        callTool: async (call) => {
          seen.push(call.arguments);
          return { ok: true, text: "ok" };
        },
      },
    );
    expect(seen[0]).toEqual({});
  });
});

describe("framing", () => {
  it("keeps a frame on one line", () => {
    const encoded = encodeBridgeFrame({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.trimEnd()).not.toContain("\n");
  });

  it("round-trips through the parser", () => {
    const encoded = encodeBridgeFrame({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(parseBridgeFrame(encoded)).toMatchObject({ id: 7, method: "ping" });
  });

  it("reports a malformed frame instead of dropping it", () => {
    expect(parseBridgeFrame("{not json")).toMatchObject({ parseError: expect.any(String) });
    expect(parseBridgeFrame("[1,2]")).toMatchObject({ parseError: expect.any(String) });
    expect(parseBridgeFrame("")).toBeNull();
  });
});
