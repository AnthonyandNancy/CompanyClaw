import { describe, expect, it } from "vitest";
import * as http from "node:http";
import { createMcpEndpointToken, startMcpEndpoint } from "./mcp-endpoint";

/**
 * The loopback endpoint the agent's MCP client calls.
 *
 * Requirement: the tools must reach the model, and the endpoint that carries
 * them must not be reachable from anywhere else, must not answer without the
 * per-launch token, and must expose no general "run this" route. The transport
 * is MCP streamable-HTTP rather than stdio because this machine's AppContainer
 * sandbox rewrites child-process spawns, which made a stdio server die with
 * "Connection closed" and left the agent with no tools.
 */

function post(
  port: number,
  body: unknown,
  options: { token?: string; path?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path ?? "/mcp",
        method: options.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(options.token !== undefined ? { "X-CompanyClaw-Token": options.token } : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

const RPC = (id: number, method: string, params?: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

async function withEndpoint(
  callTool: (call: { name: string; arguments: Record<string, unknown> }) => Promise<{
    ok: boolean;
    text: string;
  }>,
  run: (port: number, token: string) => Promise<void>,
): Promise<void> {
  const token = createMcpEndpointToken();
  const handle = await startMcpEndpoint({ callTool }, { token });
  try {
    await run(handle.port, token);
  } finally {
    await handle.close();
  }
}

describe("endpoint security", () => {
  it("refuses a request without the token", async () => {
    await withEndpoint(async () => ({ ok: true, text: "should not run" }), async (port) => {
      const response = await post(port, RPC(1, "tools/list"));
      expect(response.status).toBe(403);
    });
  });

  it("refuses a request with a wrong token", async () => {
    await withEndpoint(async () => ({ ok: true, text: "should not run" }), async (port, token) => {
      const response = await post(port, RPC(1, "tools/list"), { token: `${token}0` });
      expect(response.status).toBe(403);
    });
  });

  it("rejects a non-POST verb", async () => {
    await withEndpoint(async () => ({ ok: true, text: "should not run" }), async (port, token) => {
      const response = await post(port, {}, { token, method: "GET" });
      expect(response.status).toBe(405);
    });
  });

  it("generates a high-entropy per-launch token", () => {
    const first = createMcpEndpointToken();
    const second = createMcpEndpointToken();
    expect(first).toHaveLength(64);
    expect(first).not.toBe(second);
  });
});

describe("MCP protocol over the endpoint", () => {
  it("answers initialize with the server identity", async () => {
    await withEndpoint(async () => ({ ok: true, text: "unused" }), async (port, token) => {
      const response = await post(port, RPC(1, "initialize", {}), { token });
      expect(response.status).toBe(200);
      const result = JSON.parse(response.body).result;
      expect(result.serverInfo.name).toBe("companyclaw-computer-use");
    });
  });

  it("lists the controlled tools and nothing resembling a shell", async () => {
    await withEndpoint(async () => ({ ok: true, text: "unused" }), async (port, token) => {
      const response = await post(port, RPC(2, "tools/list"), { token });
      const tools = JSON.parse(response.body).result.tools as { name: string }[];
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("launch-app");
      expect(names).toContain("drag-drop");
      expect(names).not.toContain("powershell");
      expect(names).not.toContain("filesystem");
    });
  });

  it("acknowledges a notification with 202 and no body", async () => {
    await withEndpoint(async () => ({ ok: true, text: "unused" }), async (port, token) => {
      const response = await post(
        port,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { token },
      );
      expect(response.status).toBe(202);
    });
  });

  it("routes a tool call through the facade with its arguments", async () => {
    const seen: { name: string; arguments: Record<string, unknown> }[] = [];
    await withEndpoint(
      async (call) => {
        seen.push(call);
        return { ok: true, text: "已点击" };
      },
      async (port, token) => {
        const response = await post(
          port,
          RPC(3, "tools/call", { name: "click", arguments: { x: 5, y: 6 } }),
          { token },
        );
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body).result.content[0].text).toBe("已点击");
      },
    );
    expect(seen).toEqual([{ name: "click", arguments: { x: 5, y: 6 } }]);
  });

  it("returns a refusal as a tool result so the model reads the reason", async () => {
    await withEndpoint(
      async () => ({ ok: false, text: "该操作需要你确认" }),
      async (port, token) => {
        const response = await post(
          port,
          RPC(4, "tools/call", { name: "click", arguments: {} }),
          { token },
        );
        expect(response.status).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.error).toBeUndefined();
        expect(body.result.isError).toBe(true);
      },
    );
  });

  it("rejects a body that is not JSON with the JSON-RPC parse code", async () => {
    await withEndpoint(async () => ({ ok: true, text: "unused" }), async (port, token) => {
      const response = await post(port, "{not json", { token });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe(-32700);
    });
  });

  it("still answers when the handler throws, so the model never waits forever", async () => {
    const diagnostics: string[] = [];
    const token = createMcpEndpointToken();
    const handle = await startMcpEndpoint(
      {
        callTool: async () => {
          throw new Error("broker unavailable");
        },
        onDiagnostic: (message) => diagnostics.push(message),
      },
      { token },
    );
    try {
      const response = await post(
        handle.port,
        RPC(5, "tools/call", { name: "click", arguments: {} }),
        { token },
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).result.isError).toBe(true);
      expect(diagnostics.some((entry) => entry.includes("broker unavailable"))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("treats missing arguments as an empty object", async () => {
    const seen: Record<string, unknown>[] = [];
    await withEndpoint(
      async (call) => {
        seen.push(call.arguments);
        return { ok: true, text: "ok" };
      },
      async (port, token) => {
        await post(port, RPC(6, "tools/call", { name: "list-windows" }), { token });
      },
    );
    expect(seen[0]).toEqual({});
  });
});
