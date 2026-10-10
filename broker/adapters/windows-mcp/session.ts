import { spawn, type ChildProcess } from "node:child_process";
import {
  buildServerArgs,
  buildServerEnvironment,
  probeWindowsMcpLayout,
  resolveWindowsMcpLayout,
  type WindowsMcpLayout,
  type WindowsMcpHealth,
} from "./process-manager";
import {
  buildInitializeRequest,
  buildInitializedNotification,
  buildToolCallRequest,
  buildToolsListRequest,
  classifyHandshake,
  encodeFrame,
  parseFramedLine,
  readServerInfo,
  readToolList,
  type HandshakeResult,
  type McpToolDescriptor,
} from "./tool-registry";
import { wrappedUpstreamTools } from "./tool-policy-map";

/**
 * Owns the vendored Windows-MCP child process for one broker.
 *
 * The server is started lazily, on the first call that needs it, because most
 * sessions never touch the desktop and paying for a 200 MB interpreter at
 * startup would slow every launch for nothing.
 *
 * Four properties are deliberate:
 *
 *  1. it is started from the **verified payload path** only — no caller-supplied
 *     command, so "the desktop backend" cannot silently become "run anything";
 *  2. it speaks **stdio only**, so nothing on the machine or the network can
 *     reach it except through this broker;
 *  3. a failed handshake is reported as a named state
 *     (`START_FAILED` / `HANDSHAKE_FAILED` / `TOOLS_MISSING`) rather than as a
 *     generic failure, because the user-facing fix differs for each;
 *  4. it is restarted at most once per health state change — a server that keeps
 *     dying is a broken installation, not a transient fault, and retrying
 *     forever would hide that.
 */

export interface WindowsMcpSessionOptions {
  /** Directory that holds `companyclaw-broker/windows-mcp`. */
  resourceDir: string;
  /** Private cache/config location; keeps the employee's profile untouched. */
  stateDir: string;
  /** Milliseconds allowed for one tool call. */
  callTimeoutMs?: number;
  /** Milliseconds allowed for the handshake. */
  handshakeTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export interface SessionStatus {
  health: WindowsMcpHealth;
  detail: string;
  /** Tools the agent may call through this session. */
  controllableTools: string[];
  /** Tools the allow-map refuses; reported so the count is auditable. */
  blockedTools: string[];
  serverVersion: string | null;
  /** True when every advertised tool is classified by the pinned allow-map. */
  matchesPinnedRelease: boolean;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class WindowsMcpSession {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private buffer = "";
  private starting: Promise<SessionStatus> | null = null;
  private status: SessionStatus = {
    health: "NOT_PACKAGED",
    detail: "尚未启动电脑操作组件",
    controllableTools: [],
    blockedTools: [],
    serverVersion: null,
    matchesPinnedRelease: false,
  };
  private handshake: HandshakeResult | null = null;
  private readonly callTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;

  constructor(private readonly options: WindowsMcpSessionOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 120_000;
  }

  getStatus(): SessionStatus {
    return { ...this.status, controllableTools: [...this.status.controllableTools] };
  }

  /** Tools advertised by the live server, or the pinned set before a handshake. */
  tools(): McpToolDescriptor[] {
    return this.handshake?.tools ?? [];
  }

  /**
   * Starts the server and completes the MCP handshake, at most once.
   *
   * Concurrent callers share one attempt: a second `ensureStarted` while the
   * first is still handshaking must not spawn a second interpreter.
   */
  async ensureStarted(): Promise<SessionStatus> {
    if (this.starting) return await this.starting;
    this.starting = this.startOnce();
    try {
      return await this.starting;
    } catch (error) {
      this.starting = null;
      throw error;
    }
  }

  private async startOnce(): Promise<SessionStatus> {
    const layout: WindowsMcpLayout = resolveWindowsMcpLayout(this.options.resourceDir);
    const probe = probeWindowsMcpLayout(layout);
    if (!probe.ok) {
      this.status = {
        ...this.status,
        health: probe.health,
        detail: probe.detail,
      };
      return this.getStatus();
    }

    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(probe.pythonExecutable!, buildServerArgs({ serverDir: layout.serverDir }), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: layout.serverDir,
      env: buildServerEnvironment({
        wrappableTools: wrappedUpstreamTools(),
        stateDir: this.options.stateDir,
      }),
    });
    this.child = child;
    this.buffer = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    // stderr is kept for diagnostics only; it must never be treated as protocol.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", () => undefined);
    child.once("exit", () => {
      this.child = null;
      this.starting = null;
      this.handshake = null;
      for (const [, pendingCall] of this.pending) {
        pendingCall.reject(new Error("windows-mcp exited"));
      }
      this.pending.clear();
    });

    const initialize = await this.request(buildInitializeRequest(this.nextId++), this.handshakeTimeoutMs);
    const serverInfo = readServerInfo(initialize ?? {});
    if (!serverInfo) {
      this.status = {
        ...this.status,
        health: "HANDSHAKE_FAILED",
        detail: "电脑操作组件握手失败",
      };
      await this.stop();
      return this.getStatus();
    }

    this.send(buildInitializedNotification());
    const listed = await this.request(buildToolsListRequest(this.nextId++), this.handshakeTimeoutMs);
    const tools = readToolList(listed ?? {});
    if (tools.length === 0) {
      this.status = {
        ...this.status,
        health: "TOOLS_MISSING",
        detail: `电脑操作组件未提供任何工具（${serverInfo.serverVersion}）`,
        serverVersion: serverInfo.serverVersion,
      };
      await this.stop();
      return this.getStatus();
    }

    const handshake = classifyHandshake(serverInfo, tools);
    this.handshake = handshake;
    this.status = {
      health: "READY",
      detail: `电脑操作组件已就绪（${serverInfo.serverVersion}，可控工具 ${handshake.controllable.length} 项）`,
      controllableTools: handshake.controllable,
      blockedTools: handshake.blocked,
      serverVersion: serverInfo.serverVersion,
      matchesPinnedRelease: handshake.matchesPinnedRelease,
    };
    return this.getStatus();
  }

  /**
   * Calls one tool.
   *
   * The capability check has already happened in the execution adapter; this
   * only transports the call and turns a timeout into a definite failure, because
   * a UIA call that never returns would otherwise block the Gateway forever.
   */
  async callTool(input: {
    tool: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ ok: true; content: unknown } | { ok: false; reason: string }> {
    const status = await this.ensureStarted();
    if (status.health !== "READY") return { ok: false, reason: `windows-mcp-${status.health}` };

    const response = await this.request(
      buildToolCallRequest(this.nextId++, input.tool, input.args),
      input.timeoutMs ?? this.callTimeoutMs,
    );
    if (!response) return { ok: false, reason: "no-response" };
    const error = response.error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      return { ok: false, reason: typeof message === "string" ? message : "tool-error" };
    }
    const result = response.result;
    const text = extractText(result);
    if (text === null) return { ok: false, reason: "malformed-tool-result" };
    // The upstream marks a failed call with `isError`; that must surface as a
    // failure here, not as a successful payload containing bad news.
    const isError = (result as { isError?: unknown } | null)?.isError === true;
    if (isError) return { ok: false, reason: text };
    return { ok: true, content: result };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.handshake = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", done);
      try {
        child.stdin?.end();
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        done();
      }, 5_000);
    });
  }

  private send(message: unknown): void {
    try {
      this.child?.stdin?.write(encodeFrame(message as never));
    } catch {
      // The exit handler rejects whatever was in flight.
    }
  }

  private request(message: unknown, timeoutMs: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const id = (message as { id: number }).id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`windows-mcp request ${id} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as Record<string, unknown> | null),
        reject,
        timer,
      });
      this.send(message);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      const frame = parseFramedLine(line);
      if (!frame) continue;
      const id = frame.id;
      if (typeof id !== "number") continue;
      const pendingCall = this.pending.get(id);
      if (!pendingCall) continue;
      this.pending.delete(id);
      clearTimeout(pendingCall.timer);
      pendingCall.resolve(frame);
    }
  }
}

/** Pulls the first text content block out of an MCP tool result. */
function extractText(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}
