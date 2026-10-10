import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { connect, type Socket } from "node:net";
import * as path from "node:path";
import { createBrokerExecutionToken } from "./broker-proof";
import {
  BROKER_PROTOCOL_CONTRACT,
  type ApprovalTicketEnvelope,
  type BrokerOperation,
  type BrokerRequest,
  type BrokerResponse,
} from "./broker-protocol";

/**
 * Desktop-side client for the Windows Execution Broker.
 *
 * The broker is spawned as a child process with the execution token in its
 * environment (never argv, so it never appears in a process list). The client
 * reads the announced port from one stdout line, then speaks the broker
 * protocol over loopback. When the desktop exits, stdin closes and the broker
 * terminates with it.
 */

export interface BrokerClientOptions {
  /** Directory containing the compiled broker (dist/). */
  brokerDir: string;
  scriptDir: string | null;
  /**
   * Node runtime that runs the broker. Must be a real node.exe: in a packaged
   * build `process.execPath` is CompanyClaw.exe, which cannot execute the
   * broker's JavaScript entry point.
   */
  nodePath?: string;
  ownerSid: string;
  deviceId: string;
  /** Shared key the broker uses to verify approval tickets on its own side. */
  ticketSecret?: string;
  /** Packaged-resources root, so the broker can find the Windows-MCP payload. */
  resourcesDir?: string;
  /** Private state directory for the vendored server's cache and config. */
  stateDir?: string;
  allowedProcesses: string[];
  allowedWindowTitles: string[];
  /** Overridable for tests. */
  spawnProcess?: typeof spawn;
  now?: () => Date;
}

/** Mutable view of the options this client was built with. */
type MutableBrokerOptions = BrokerClientOptions;

/**
 * Failure codes a caller can match on.
 *
 * A missing runtime and a missing entry point are different installation
 * faults, and the user-facing text differs, so they are never collapsed into
 * one "broker unavailable".
 */
export const BROKER_RUNTIME_NOT_FOUND = "BROKER_RUNTIME_NOT_FOUND";
export const BROKER_ENTRY_INVALID = "BROKER_ENTRY_INVALID";
/** Returned once the automatic restarts have been used up. */
export const BROKER_RESTART_LIMIT = "broker-restart-limit";

/**
 * How many times a dead broker may be restarted automatically.
 *
 * A broker that keeps dying is a broken installation, not a transient fault;
 * restarting it forever would hide that and leave the user waiting.
 */
export const MAX_BROKER_RESTARTS = 2;

export interface BrokerCallOptions {
  operation: BrokerOperation;
  taskId: string;
  stepId: string;
  payloadHash: string;
  target?: BrokerRequest["target"];
  args?: Record<string, unknown>;
  approvalTicket?: ApprovalTicketEnvelope;
  timeoutMs?: number;
}

export type BrokerCallResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string; unavailable?: boolean };

/**
 * Distinguishes "the broker process is alive" from "UI Automation actually
 * worked in this Windows session": a live process whose last real call failed
 * means the desktop cannot be driven right now, and the UI must say so rather
 * than imply the machine is controllable.
 */
export interface BrokerClientStatus {
  running: boolean;
  nodePath: string | null;
  lastSuccessfulCallAt: string | null;
  lastFailureReason: string | null;
  /** Automatic restarts consumed so far. */
  restarts: number;
}

export class BrokerClient {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private readonly token = createBrokerExecutionToken();
  private readonly now: () => Date;
  private lastSuccessfulCallAt: string | null = null;
  private lastFailureReason: string | null = null;
  private restarts = 0;
  /** Set while stop() is terminating the process on purpose. */
  private stopping = false;
  /** True once a broker process has been seen to exit on its own. */
  private exited = false;

  constructor(private readonly options: MutableBrokerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** True once the broker announced a port and is reachable. */
  isRunning(): boolean {
    return this.port > 0 && this.child !== null;
  }

  /** Liveness plus the outcome of the most recent real call. */
  getStatus(): BrokerClientStatus {
    return {
      running: this.isRunning(),
      nodePath: this.options.nodePath ?? null,
      lastSuccessfulCallAt: this.lastSuccessfulCallAt,
      lastFailureReason: this.lastFailureReason,
      restarts: this.restarts,
    };
  }

  getToken(): string {
    return this.token;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } catch (error) {
      this.starting = null;
      // Record why the broker could not start: the status is the only place a
      // user or a log can learn that a component is missing from the install.
      this.lastFailureReason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const entry = path.join(this.options.brokerDir, "dist", "main.js");
    // The broker always runs on the bundled private Node runtime; falling back
    // to process.execPath only keeps source checkouts and unit tests working.
    const command = this.options.nodePath ?? process.execPath;
    // Check both files before spawning. Without this the only symptom is a
    // timeout or an opaque exit code, which tells neither the user nor the log
    // which component is missing from the installation.
    if (command !== process.execPath && !fs.existsSync(command)) {
      throw new Error(`${BROKER_RUNTIME_NOT_FOUND}: ${command}`);
    }
    if (!fs.existsSync(entry)) {
      throw new Error(`${BROKER_ENTRY_INVALID}: ${entry}`);
    }
    const child = spawnProcess(command, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        COMPANYCLAW_BROKER_TOKEN: this.token,
        COMPANYCLAW_BROKER_OWNER_SID: this.options.ownerSid,
        COMPANYCLAW_BROKER_DEVICE_ID: this.options.deviceId,
        COMPANYCLAW_BROKER_SCRIPT_DIR: this.options.scriptDir ?? "",
        COMPANYCLAW_BROKER_ALLOWED_PROCESSES: this.options.allowedProcesses.join(","),
        COMPANYCLAW_BROKER_ALLOWED_WINDOW_TITLES: this.options.allowedWindowTitles.join(","),
        // Environment, not argv: the key must not appear in a process list.
        COMPANYCLAW_BROKER_TICKET_SECRET: this.options.ticketSecret ?? "",
        COMPANYCLAW_BROKER_RESOURCES_DIR: this.options.resourcesDir ?? "",
        COMPANYCLAW_BROKER_STATE_DIR: this.options.stateDir ?? "",
      },
    });
    this.child = child;
    // Watch the process for as long as it lives, not only until it announces a
    // port: a broker that dies later must stop looking "alive", otherwise every
    // later call is sent to a socket nobody is listening on.
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.port = 0;
      this.exited = true;
      if (this.stopping) return;
      this.lastFailureReason = `broker exited (code=${code ?? "null"})`;
    });

    const port = await this.awaitPort(child);
    this.port = port;
  }

  private awaitPort(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("broker startup timed out")), 60_000);
      const cleanup = () => clearTimeout(timer);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        cleanup();
        const line = buffer.slice(0, index);
        try {
          const parsed = JSON.parse(line) as { port?: number; error?: string };
          if (typeof parsed.port === "number" && parsed.port > 0) resolve(parsed.port);
          else reject(new Error(`broker bootstrap failed: ${parsed.error ?? "no port"}`));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("exit", (code) => {
        cleanup();
        reject(new Error(`broker exited during startup with code ${code}`));
      });
    });
  }

  /**
   * Replaces the application allow list. The allow list is delivered through the
   * broker's environment, so the running process cannot pick up a change: it is
   * stopped and started again, and the next call uses the new list.
   */
  async updateTargets(targets: {
    allowedProcesses: string[];
    allowedWindowTitles: string[];
  }): Promise<void> {
    const wasRunning = this.isRunning();
    this.options.allowedProcesses = [...targets.allowedProcesses];
    this.options.allowedWindowTitles = [...targets.allowedWindowTitles];
    if (!wasRunning) return;
    // stop() restores the restart budget: replacing the process for a new
    // allow list is deliberate, so editing the list a few times must not lock
    // the user out of the broker.
    await this.stop();
  }

  /** Stops the broker and waits for it to release its socket. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = 0;
    this.starting = null;
    this.stopping = true;
    if (!child) {
      this.stopping = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", done);
      try {
        // Closing stdin is the broker's documented shutdown signal.
        child.stdin?.end();
      } catch {
        // Ignore: fall through to the kill below.
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
    this.stopping = false;
    // A broker stopped on purpose was not a failure, so the restart budget is
    // restored for the next legitimate start.
    this.exited = false;
    this.restarts = 0;
  }

  async call(options: BrokerCallOptions): Promise<BrokerCallResult> {
    if (!this.isRunning()) {
      // The broker exists to be reached; an installation whose runtime or entry
      // point is missing is a fault the user has to see, not something to retry
      // forever. Restarts are counted so a crash loop cannot hide behind them.
      if (this.exited && this.restarts >= MAX_BROKER_RESTARTS) {
        const reason = `${BROKER_RESTART_LIMIT}: broker stopped ${this.restarts} times`;
        this.lastFailureReason = reason;
        return { ok: false, unavailable: true, reason };
      }
      if (this.exited) this.restarts += 1;
      try {
        await this.start();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.lastFailureReason = reason;
        return {
          ok: false,
          unavailable: true,
          reason,
        };
      }
    }

    const issuedAt = this.now();
    const request: BrokerRequest = {
      contract: BROKER_PROTOCOL_CONTRACT,
      requestId: `${options.taskId}-${options.stepId}-${issuedAt.getTime()}`,
      taskId: options.taskId,
      stepId: options.stepId,
      ownerSid: this.options.ownerSid,
      deviceId: this.options.deviceId,
      operation: options.operation,
      target: options.target ?? null,
      args: options.args ?? {},
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
      payloadHash: options.payloadHash,
      approvalTicket: options.approvalTicket ?? null,
    };

    let response: BrokerResponse;
    try {
      response = (await this.send(request, options.timeoutMs ?? 120_000)) as BrokerResponse;
    } catch (error) {
      // A transport failure must not look like a policy decision.
      const reason = error instanceof Error ? error.message : String(error);
      this.lastFailureReason = reason;
      return {
        ok: false,
        unavailable: true,
        reason,
      };
    }

    if (response.status === "ok") {
      this.lastSuccessfulCallAt = this.now().toISOString();
      this.lastFailureReason = null;
      return { ok: true, data: response.data };
    }
    const reason = response.reason ?? response.status;
    this.lastFailureReason = reason;
    return { ok: false, reason };
  }

  private send(request: BrokerRequest, timeoutMs: number): Promise<unknown> {
    const token = this.token;
    const port = this.port;
    return new Promise((resolve, reject) => {
      const socket: Socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.write(`${JSON.stringify({ token, request })}\n`);
      });
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        socket.end();
        try {
          resolve(JSON.parse(buffer.slice(0, index)));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", reject);
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new Error("broker call timed out"));
      });
    });
  }
}
