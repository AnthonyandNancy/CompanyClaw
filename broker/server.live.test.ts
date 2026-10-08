import { connect, type Socket } from "node:net";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { startBrokerServer } from "./server";
import { BROKER_PROTOCOL_CONTRACT, type BrokerRequest } from "./protocol";

/**
 * End-to-end live check of the broker path on a real Windows desktop:
 *
 *   test client -> loopback IPC -> BrokerPolicy -> real UI Automation API
 *
 * This is the first *whole-chain* evidence for the broker. It is still a
 * read-only path — no window is clicked or modified — and it is skipped on
 * non-Windows hosts so CI elsewhere stays green.
 */
const isWindows = process.platform === "win32";
const scriptDir = path.join(__dirname, "scripts");
const TOKEN = "live-token";

function makeRequest(): BrokerRequest {
  const now = Date.now();
  return {
    contract: BROKER_PROTOCOL_CONTRACT,
    requestId: "live-req-1",
    taskId: "live-task-1",
    stepId: "live-step-1",
    ownerSid: "S-1-5-21-live",
    deviceId: "live-device",
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

describe.skipIf(!isWindows)("broker live end-to-end (read-only)", () => {
  it("serves real windows from the real desktop through the whole chain", async () => {
    let realBackendUsed = false;
    const server = await startBrokerServer({
      policyConfig: {
        ownerSid: "S-1-5-21-live",
        deviceId: "live-device",
        allowedProcesses: ["notepad", "explorer"],
        allowedWindowTitles: [],
        requireApprovalForMutations: true,
      },
      scriptDir,
      token: TOKEN,
      // No listWindows override: the real PowerShell + UIA probe runs.
      listWindows: async (options) => {
        realBackendUsed = true;
        const mod = await import("./uia");
        return mod.runListWindows({ scriptDir: options.scriptDir, timeoutMs: 90_000 });
      },
    });

    try {
      const response = await roundTrip(server.port, { token: TOKEN, request: makeRequest() });

      expect(realBackendUsed).toBe(true);
      expect(response.status, `broker responded: ${JSON.stringify(response)}`).toBe("ok");

      const data = response.data as { windows: Array<{ name: string; processId: number }> };
      expect(Array.isArray(data.windows)).toBe(true);
      expect(data.windows.length).toBeGreaterThan(0);
      for (const window of data.windows) {
        expect(window.processId).toBeGreaterThan(0);
      }
    } finally {
      await server.close();
    }
  }, 180_000);

  it("refuses the same live request when the owner does not match", async () => {
    const server = await startBrokerServer({
      policyConfig: {
        ownerSid: "S-1-5-21-live",
        deviceId: "live-device",
        allowedProcesses: ["notepad"],
        allowedWindowTitles: [],
        requireApprovalForMutations: true,
      },
      scriptDir,
      token: TOKEN,
    });
    try {
      const response = await roundTrip(server.port, {
        token: TOKEN,
        request: { ...makeRequest(), ownerSid: "S-1-5-21-other" },
      });
      expect(response).toMatchObject({ status: "rejected", reason: "owner-mismatch" });
    } finally {
      await server.close();
    }
  }, 60_000);
});
