import * as http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  buildInitializeResult,
  buildToolsListResult,
  handleBridgeMessage,
  type BridgeToolResult,
  type JsonRpcMessage,
} from "./mcp-bridge";

/**
 * The loopback endpoint the MCP bridge calls back into.
 *
 * The bridge runs as a child of the Gateway, outside this process, so the only
 * way for a tool call to reach the permission engine, the task store and the
 * execution bridge is a socket back to the main process. Three rules follow from
 * that, and they mirror the broker's own transport decisions:
 *
 *   * **loopback only** — bound to 127.0.0.1, so nothing on the network can
 *     reach it;
 *   * **token on every request** — the token is generated per launch and handed
 *     to the bridge through its environment, never through argv where a process
 *     list would expose it;
 *   * **only tool calls** — there is no general "run this" route, because a
 *     general route would be the arbitrary-execution surface this whole design
 *     exists to avoid.
 */

export interface McpEndpointDependencies {
  /** Runs one tool call; the same facade the local UI uses. */
  callTool: (call: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ ok: boolean; text: string }>;
  /** Optional diagnostic sink for refusals and transport faults. */
  onDiagnostic?: (message: string) => void;
}

export interface McpEndpointHandle {
  /** Port the bridge should connect to. */
  port: number;
  /** Per-launch secret; handed to the bridge via its environment. */
  token: string;
  close: () => Promise<void>;
}

export function createMcpEndpointToken(): string {
  return randomBytes(32).toString("hex");
}

/** Maximum accepted body, so a malformed or hostile frame cannot exhaust memory. */
export const MAX_BODY_BYTES = 256 * 1024;

export async function startMcpEndpoint(
  deps: McpEndpointDependencies,
  options: { token: string; port?: number } = { token: createMcpEndpointToken() },
): Promise<McpEndpointHandle> {
  const server = http.createServer((request, response) => {
    const respond = (status: number, body: unknown, contentType = "application/json"): void => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      response.writeHead(status, {
        "Content-Type": `${contentType}; charset=utf-8`,
        "Content-Length": Buffer.byteLength(payload),
      });
      response.end(payload);
    };

    if (request.headers["x-companyclaw-token"] !== options.token) {
      // Deliberately terse: a probe should not learn whether the route exists.
      respond(403, { error: "forbidden" });
      return;
    }

    // The MCP streamable-HTTP transport: POST a JSON-RPC message to the endpoint
    // and read one JSON response. Notifications get 202 with no body.
    if (request.method === "GET" || request.method === "DELETE") {
      respond(405, { error: "method not allowed" });
      return;
    }
    if (request.method !== "POST") {
      respond(405, { error: "method not allowed" });
      return;
    }

    let body = "";
    let aborted = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (aborted) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        aborted = true;
        respond(413, { error: "request too large" });
        request.destroy();
      }
    });
    request.on("end", () => {
      if (aborted) return;
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          respond(400, {
            jsonrpc: "2.0",
            error: { code: -32700, message: "invalid JSON body" },
          });
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const responses: JsonRpcMessage[] = [];
        for (const message of messages) {
          if (typeof message !== "object" || message === null) continue;
          const reply = await handleBridgeMessage(message as JsonRpcMessage, {
            callTool: async (call): Promise<BridgeToolResult> => {
              try {
                const result = await deps.callTool(call);
                return { ok: result.ok, text: result.text, reason: result.ok ? "ok" : "refused" };
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                deps.onDiagnostic?.(`tool ${call.name} failed: ${reason}`);
                return { ok: false, text: `执行失败：${reason}`, reason };
              }
            },
            onDiagnostic: deps.onDiagnostic,
          });
          if (reply) responses.push(reply);
        }
        if (responses.length === 0) {
          // A notification: acknowledged, nothing to return.
          respond(202, "{}");
          return;
        }
        respond(200, Array.isArray(parsed) ? responses : responses[0]);
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1, not 0.0.0.0: the endpoint must not be reachable off-machine.
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    token: options.token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
