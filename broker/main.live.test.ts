import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROKER_PROTOCOL_CONTRACT, type BrokerRequest } from "./protocol";

/**
 * Starts the broker as a real child process and drives it over its own socket.
 *
 * This is the check that the process entry point actually works: environment
 * bootstrap, stdout port handshake, the policy gate, real UI Automation, and
 * termination when stdin closes. Skipped off Windows.
 */
const isWindows = process.platform === "win32";
const brokerRoot = __dirname;
const TOKEN = "0123456789abcdef0123456789abcdef";
const OWNER_SID = "S-1-5-21-live-process";

let child: ChildProcess | null = null;

function stopChild(): void {
  if (!child) return;
  try {
    // Closing stdin is the documented shutdown signal; killing is only a
    // fallback for a process that ignores it.
    child.stdin?.end();
    child.kill();
  } catch {
    // Already gone.
  }
  child = null;
}

afterEach(stopChild);

function makeRequest(): BrokerRequest {
  const now = Date.now();
  return {
    contract: BROKER_PROTOCOL_CONTRACT,
    requestId: "proc-req-1",
    taskId: "proc-task-1",
    stepId: "proc-step-1",
    ownerSid: OWNER_SID,
    deviceId: "proc-device",
    operation: "list-windows",
    target: null,
    args: {},
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    payloadHash: "a".repeat(64),
    approvalTicket: null,
  };
}

function roundTrip(port: number, frame: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(120_000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}

describe.skipIf(!isWindows)("broker process bootstrap", () => {
  it("starts, announces its port, honours the policy gate and exits on stdin close", async () => {
    // Spawn through the compiled entry point so the check covers the real path
    // the app uses rather than an in-process import.
    const compiled = path.join(brokerRoot, "dist", "main.js");
    child = spawn(process.execPath, [compiled], {
      cwd: brokerRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        COMPANYCLAW_BROKER_TOKEN: TOKEN,
        COMPANYCLAW_BROKER_OWNER_SID: OWNER_SID,
        COMPANYCLAW_BROKER_DEVICE_ID: "proc-device",
        COMPANYCLAW_BROKER_SCRIPT_DIR: path.join(brokerRoot, "scripts"),
        COMPANYCLAW_BROKER_ALLOWED_PROCESSES: "notepad",
      },
    });

    const port = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("broker never announced a port")), 60_000);
      child!.stdout!.setEncoding("utf8");
      child!.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        clearTimeout(timer);
        const line = buffer.slice(0, index);
        try {
          const parsed = JSON.parse(line) as { port?: number; error?: string };
          if (typeof parsed.port === "number") resolve(parsed.port);
          else reject(new Error(`bootstrap failed: ${parsed.error}`));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child!.on("exit", (code) => reject(new Error(`broker exited early with code ${code}`)));
    });

    expect(port).toBeGreaterThan(0);

    // A wrong token is refused before any UIA work.
    const badToken = await roundTrip(port, { token: "wrong-token", request: makeRequest() });
    expect(badToken).toMatchObject({ status: "rejected", reason: "bad-token" });

    // The correct token reaches real UI Automation.
    const response = await roundTrip(port, { token: TOKEN, request: makeRequest() });
    expect(response.status, `broker responded: ${JSON.stringify(response)}`).toBe("ok");
    const data = response.data as { windows: Array<{ name: string; processId: number }> };
    expect(data.windows.length).toBeGreaterThan(0);

    // Closing stdin must terminate it: a stray listener would be a real risk.
    const exited = new Promise<boolean>((resolve) => {
      child!.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 15_000);
    });
    child.stdin?.end();
    expect(await exited).toBe(true);
  }, 240_000);
});
