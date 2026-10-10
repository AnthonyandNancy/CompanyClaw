import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  MCP_SERVER_NAME,
  applyMcpServerConfig,
  buildMcpServerEntry,
  removeMcpServerConfig,
} from "./mcp-bridge";

/**
 * Registering the MCP server with OpenClaw.
 *
 * The bug this file exists to prevent: the tools were implemented but never
 * registered, so the model correctly answered that it had no way to operate the
 * machine. The assertions below are written from the pinned OpenClaw release's
 * own reading of `mcp.servers` (`dist/mcp-connection-resolver-*.mjs`).
 */

const repositoryRoot = path.resolve(__dirname, "../../../..");
const openClawDist = path.resolve(
  process.env.HOME ?? process.env.USERPROFILE ?? "",
  ".openclaw-node/node_modules/openclaw/dist",
);

describe("server entry", () => {
  const entry = buildMcpServerEntry({ port: 41234, token: "secret-token" });

  it("declares an HTTP transport on loopback, which the pinned release accepts", () => {
    // `streamable-http` requires a non-empty `url`, and `transport` (not `type`)
    // is OpenClaw's own field name.
    expect(entry.transport).toBe("streamable-http");
    expect(typeof entry.url).toBe("string");
    expect(entry).not.toHaveProperty("type");
    expect(entry).not.toHaveProperty("command");
  });

  it("never leaves the loopback interface", () => {
    // Bound to 127.0.0.1 with the port the main process actually listens on; a
    // 0.0.0.0 or LAN address would expose the executor to the network.
    expect(entry.url).toBe("http://127.0.0.1:41234/mcp");
  });

  it("carries the secret in a header, not in the URL", () => {
    // A token in the URL ends up in logs and error messages.
    expect(String(entry.url)).not.toContain("secret-token");
    const headers = entry.headers as Record<string, string>;
    expect(headers["X-CompanyClaw-Token"]).toBe("secret-token");
  });

  it("spawns no child process", () => {
    // This is why the transport is HTTP: the AppContainer sandbox rewrites child
    // spawns, and a stdio server died with "Connection closed", leaving the agent
    // with no tools at all.
    expect(entry).not.toHaveProperty("command");
    expect(entry).not.toHaveProperty("args");
    expect(entry).not.toHaveProperty("env");
  });
});

describe("applying the config", () => {
  const entry = { transport: "stdio", command: "node.exe", args: ["bridge.js"] };

  it("adds only the mcp.servers key and leaves everything else untouched", () => {
    const existing = {
      models: { providers: { p: { apiKey: "k" } } },
      gateway: { port: 18790 },
      agents: { defaults: { model: { primary: "m" } } },
    };
    const result = applyMcpServerConfig(existing, entry);
    expect(result.changed).toBe(true);
    const mcp = result.config.mcp as { servers: Record<string, unknown> };
    expect(mcp.servers[MCP_SERVER_NAME]).toEqual(entry);
    // Everything else is byte-identical.
    expect(result.config.models).toEqual(existing.models);
    expect(result.config.gateway).toEqual(existing.gateway);
    expect(result.config.agents).toEqual(existing.agents);
  });

  it("keeps other MCP servers the employee configured", () => {
    const existing = { mcp: { servers: { "other-server": { transport: "stdio", command: "x" } } } };
    const result = applyMcpServerConfig(existing, entry);
    const servers = (result.config.mcp as { servers: Record<string, unknown> }).servers;
    expect(servers["other-server"]).toBeDefined();
    expect(servers[MCP_SERVER_NAME]).toEqual(entry);
  });

  it("is idempotent, so a normal start does not rewrite the file", () => {
    const first = applyMcpServerConfig({}, entry);
    const second = applyMcpServerConfig(first.config, entry);
    expect(second.changed).toBe(false);
  });

  it("replaces a stale entry rather than leaving it to point at a dead port", () => {
    // The port and token change every launch; a stale entry would make the agent
    // connect to nothing and report an unexplained failure.
    const stale = applyMcpServerConfig({}, {
      transport: "stdio",
      command: "node.exe",
      args: ["bridge.js"],
      env: { COMPANYCLAW_MCP_PORT: "1", COMPANYCLAW_MCP_TOKEN: "old" },
    });
    const fresh = applyMcpServerConfig(stale.config, entry);
    expect(fresh.changed).toBe(true);
    const servers = (fresh.config.mcp as { servers: Record<string, unknown> }).servers;
    expect(servers[MCP_SERVER_NAME]).toEqual(entry);
  });

  it("tolerates a malformed mcp section instead of throwing", () => {
    const result = applyMcpServerConfig({ mcp: "not-an-object" }, entry);
    expect(result.changed).toBe(true);
    const servers = (result.config.mcp as { servers: Record<string, unknown> }).servers;
    expect(servers[MCP_SERVER_NAME]).toEqual(entry);
  });

  it("removes only our entry on uninstall", () => {
    const withBoth = applyMcpServerConfig(
      { mcp: { servers: { "other-server": { transport: "stdio", command: "x" } } } },
      entry,
    ).config;
    const removed = removeMcpServerConfig(withBoth);
    expect(removed.changed).toBe(true);
    const servers = (removed.config.mcp as { servers: Record<string, unknown> }).servers;
    expect(servers["other-server"]).toBeDefined();
    expect(servers[MCP_SERVER_NAME]).toBeUndefined();
  });

  it("reports no change when there is nothing to remove", () => {
    expect(removeMcpServerConfig({}).changed).toBe(false);
  });
});

describe("agreement with the pinned OpenClaw release", () => {
  it("uses the key that release actually reads", () => {
    // If OpenClaw ever renames the user-config key, registering a server would
    // silently stop working; this reads its own resolver to catch that.
    const resolver = readFileSync(
      path.join(openClawDist, "mcp-connection-resolver-DReJ0lpo.mjs"),
      "utf-8",
    );
    expect(resolver).toContain("normalizeConfiguredMcpServers(params.cfg?.mcp?.servers)");
  });

  it("uses the transport names that release maps to a CLI backend", () => {
    const normalize = readFileSync(
      path.join(openClawDist, "mcp-config-normalize-BQ2njeHO.mjs"),
      "utf-8",
    );
    expect(normalize).toContain('stdio: "stdio"');
  });

  it("keeps the registration helper inside this repository", () => {
    // Guards against the path silently pointing outside the checkout.
    expect(repositoryRoot).toContain("CompanyClaw");
  });
});
