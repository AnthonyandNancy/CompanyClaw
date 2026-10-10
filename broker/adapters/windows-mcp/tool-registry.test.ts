import { describe, expect, it } from "vitest";
import {
  authorizeToolCall,
  buildInitializedNotification,
  buildInitializeRequest,
  buildToolCallRequest,
  buildToolsListRequest,
  classifyHandshake,
  encodeFrame,
  loadedToolSummary,
  parseFramedLine,
  readServerInfo,
  readToolList,
} from "./tool-registry";
import { PINNED_UPSTREAM_TOOLS } from "./tool-policy-map";

/**
 * What the adapter accepts from, and sends to, the upstream server.
 *
 * The frame shapes and the classification rules are asserted from the MCP
 * protocol and requirement V5 §2.2/§5.3 respectively.
 */

describe("framing", () => {
  it("initializes against the protocol version this build speaks", () => {
    const request = buildInitializeRequest();
    expect(request.method).toBe("initialize");
    expect((request.params as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("follows initialize with the required notification", () => {
    const notification = buildInitializedNotification();
    expect(notification.method).toBe("notifications/initialized");
    // A notification carries no id, so the server must not answer it.
    expect("id" in notification).toBe(false);
  });

  it("names the tool and its arguments in a call", () => {
    const request = buildToolCallRequest(7, "Click", { x: 10, y: 20 });
    expect(request.method).toBe("tools/call");
    expect(request.params).toEqual({ name: "Click", arguments: { x: 10, y: 20 } });
  });

  it("keeps a frame on one line", () => {
    const line = encodeFrame(buildToolsListRequest());
    expect(line).not.toContain("\n");
    expect(parseFramedLine(line)?.method).toBe("tools/list");
  });

  it("returns null for a line that is not a frame", () => {
    expect(parseFramedLine("not json")).toBeNull();
    expect(parseFramedLine("")).toBeNull();
    expect(parseFramedLine("[1,2]")).toBeNull();
  });
});

describe("reading the handshake", () => {
  it("reads the server identity", () => {
    const info = readServerInfo({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "windows-mcp", version: "4.1.0" } },
    });
    expect(info).toEqual({
      protocolVersion: "2025-06-18",
      serverName: "windows-mcp",
      serverVersion: "4.1.0",
    });
  });

  it("skips a tool entry without a usable name", () => {
    const tools = readToolList({ result: { tools: [{ name: "Click" }, { description: "x" }, "nope"] } });
    expect(tools.map((tool) => tool.name)).toEqual(["Click"]);
  });

  it("treats a response without a tool array as empty rather than as success", () => {
    expect(readToolList({ result: {} })).toEqual([]);
    expect(readToolList({ error: { code: -32601 } })).toEqual([]);
  });
});

describe("classifying a handshake", () => {
  const info = { protocolVersion: "2025-06-18", serverName: "windows-mcp", serverVersion: "4.1.0" };

  it("separates the controllable tools from the blocked ones", () => {
    const result = classifyHandshake(
      info,
      PINNED_UPSTREAM_TOOLS.map((name) => ({ name })),
    );
    expect(result.controllable).toContain("Click");
    expect(result.controllable).toContain("App");
    expect(result.blocked).toContain("PowerShell");
    expect(result.blocked).toContain("FileSystem");
    expect(result.controllable).not.toContain("PowerShell");
    expect(result.matchesPinnedRelease).toBe(true);
  });

  it("reports an unclassified tool and refuses to control it", () => {
    const result = classifyHandshake(info, [{ name: "Click" }, { name: "SomethingNew" }]);
    expect(result.unclassified).toEqual(["SomethingNew"]);
    expect(result.controllable).not.toContain("SomethingNew");
    expect(result.matchesPinnedRelease).toBe(false);
  });
});

describe("authorizing one call", () => {
  it("allows a wrapped tool for its own capability", () => {
    expect(authorizeToolCall({ tool: "Click", capability: "click", args: { x: 1, y: 2 } }).allowed).toBe(
      true,
    );
  });

  it("refuses a denied tool even when a capability is named", () => {
    const result = authorizeToolCall({
      tool: "PowerShell",
      capability: "click",
      args: {},
    });
    expect(result.allowed).toBe(false);
  });

  it("refuses a capability the tool was not mapped to", () => {
    const result = authorizeToolCall({ tool: "Click", capability: "typeText", args: {} });
    expect(result.allowed).toBe(false);
  });

  it("refuses an argument that would smuggle in a command", () => {
    for (const key of ["command", "script", "exec", "shell"]) {
      const result = authorizeToolCall({
        tool: "App",
        capability: "launchApp",
        args: { [key]: "calc.exe" },
      });
      expect(result.allowed).toBe(false);
    }
  });
});

describe("loaded tool summary", () => {
  it("counts the controllable and blocked sets against the pinned release", () => {
    const summary = loadedToolSummary();
    expect(summary.total).toBe(PINNED_UPSTREAM_TOOLS.length);
    expect(summary.controllable + summary.blocked).toBe(summary.total);
    expect(summary.controllable).toBe(11);
  });
});
