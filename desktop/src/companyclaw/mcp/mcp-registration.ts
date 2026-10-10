import * as fs from "node:fs";
import {
  MCP_SERVER_NAME,
  applyMcpServerConfig,
  buildMcpServerEntry,
  removeMcpServerConfig,
} from "./mcp-bridge";

/**
 * Registers (or removes) the CompanyClaw MCP server in `openclaw.json`.
 *
 * This is the step that was missing and that made the model correctly report it
 * had no GUI tools: the adapter, the tool map and the policy facade existed, but
 * nothing told OpenClaw to launch them.
 *
 * `mcp.servers` is the key the pinned OpenClaw release reads for user-configured
 * servers (`dist/mcp-connection-resolver-*.mjs`), and a `stdio` entry needs
 * `command` plus optional `args`/`env`. Only that one key is touched: the rest of
 * the file belongs to the employee and to the other installers, and a silent
 * rewrite of unrelated settings is the mistake this project has already paid for.
 *
 * Registration is idempotent and self-healing on two counts:
 *
 *   * the entry is compared before writing, so a normal start does not touch the
 *     file at all;
 *   * the loopback port and token change every launch, so a stale entry from a
 *     previous run is *replaced* rather than left to point at a dead endpoint.
 */

export interface McpRegistrationInput {
  configPath: string;
  /** Loopback port the main process listens on. */
  port: number;
  /** Per-launch secret; never written to a log and never put in the URL. */
  token: string;
}

export type McpRegistrationOutcome =
  | { status: "registered"; changed: boolean; serverName: string }
  | { status: "config-unavailable"; reason: string }
  | { status: "config-invalid"; reason: string };

export function registerCompanyClawMcpServer(
  input: McpRegistrationInput,
): McpRegistrationOutcome {
  let raw: string;
  try {
    raw = fs.readFileSync(input.configPath, "utf-8");
  } catch (error) {
    // No config yet means the first-run step has not run; registering here would
    // create a file that later overwrites the real one.
    return {
      status: "config-unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "config-invalid", reason: "配置根节点不是对象" };
    }
    config = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      status: "config-invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const entry = buildMcpServerEntry({ port: input.port, token: input.token });
  const applied = applyMcpServerConfig(config, entry);
  if (applied.changed) {
    writeAtomically(input.configPath, applied.config);
  }
  return { status: "registered", changed: applied.changed, serverName: MCP_SERVER_NAME };
}

export function unregisterCompanyClawMcpServer(configPath: string): { changed: boolean } {
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { changed: false };
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return { changed: false };
  }
  const removed = removeMcpServerConfig(config);
  if (removed.changed) writeAtomically(configPath, removed.config);
  return { changed: removed.changed };
}

/**
 * Atomic write, matching how the rest of the config is persisted.
 *
 * A partially written `openclaw.json` would leave the Gateway unable to start,
 * which is a far worse outcome than a failed registration.
 */
function writeAtomically(configPath: string, config: Record<string, unknown>): void {
  const temporary = `${configPath}.companyclaw-mcp-${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), "utf-8");
  try {
    fs.renameSync(temporary, configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}


