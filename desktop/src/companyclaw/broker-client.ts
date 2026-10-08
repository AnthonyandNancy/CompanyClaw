import { spawn, type ChildProcess } from "node:child_process";
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
  ownerSid: string;
  deviceId: string;
  allowedProcesses: string[];
  allowedWindowTitles: string[];
  /** Overridable for tests. */
  spawnProcess?: typeof spawn;
  now?: () => Date;
}

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

export class BrokerClient {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private readonly token = createBrokerExecutionToken();
  private readonly now: () => Date;

  constructor(private readonly options: BrokerClientOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** True once the broker announced a port and is reachable. */
  isRunning(): boolean {
    return this.port > 0 && this.child !== null;
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
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const entry = path.join(this.options.brokerDir, "dist", "main.js");
    const child = spawnProcess(process.execPath, [entry], {
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
      },
    });
    this.child = child;

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

  /** Stops the broker and waits for it to release its socket. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = 0;
    this.starting = null;
    if (!child) return;
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
  }

  async call(options: BrokerCallOptions): Promise<BrokerCallResult> {
    if (!this.isRunning()) {
      try {
        await this.start();
      } catch (error) {
        return {
          ok: false,
          unavailable: true,
          reason: error instanceof Error ? error.message : String(error),
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
      return {
        ok: false,
        unavailable: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (response.status === "ok") return { ok: true, data: response.data };
    return { ok: false, reason: response.reason ?? response.status };
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
