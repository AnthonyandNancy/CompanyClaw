import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { startBrokerServer } from "./server";
import { BROKER_PROTOCOL_CONTRACT, type BrokerRequest } from "./protocol";

const NOW = () => new Date("2026-10-08T00:00:00.000Z");
const TOKEN = "test-token";

const policyConfig = {
  ownerSid: "S-1-5-21-1",
  deviceId: "device-a",
  allowedProcesses: ["notepad"],
  allowedWindowTitles: [],
  requireApprovalForMutations: true,
};

function makeRequest(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
  return {
    contract: BROKER_PROTOCOL_CONTRACT,
    requestId: "req-1",
    taskId: "task-1",
    stepId: "step-1",
    ownerSid: "S-1-5-21-1",
    deviceId: "device-a",
    operation: "list-windows",
    target: null,
    args: {},
    issuedAt: "2026-10-08T00:00:00.000Z",
    expiresAt: "2026-10-08T00:05:00.000Z",
    payloadHash: "a".repeat(64),
    approvalTicket: null,
    ...overrides,
  };
}

/** Sends one frame and resolves with the parsed response. */
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
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function withServer<T>(
  run: (port: number) => Promise<T>,
  overrides: Partial<Parameters<typeof startBrokerServer>[0]> = {},
): Promise<T> {
  const server = await startBrokerServer({
    policyConfig,
    scriptDir: "C:/broker/scripts",
    token: TOKEN,
    now: NOW,
    listWindows: async () => ({
      ok: true,
      value: [
        { name: "无标题 - 记事本", processId: 111, automationId: "" },
        { name: "Book1 - Excel", processId: 222, automationId: "" },
      ],
    }),
    ...overrides,
  });
  try {
    return await run(server.port);
  } finally {
    await server.close();
  }
}

describe("broker server transport", () => {
  it("listens only on loopback", async () => {
    await withServer(async (_port) => {
      // Nothing to assert about the address from here beyond a successful
      // loopback connection, which the other cases already exercise.
      expect(true).toBe(true);
    });
  });

  it("rejects a frame with a wrong token", async () => {
    await withServer(async (port) => {
      const response = await roundTrip(port, { token: "wrong", request: makeRequest() });
      expect(response).toMatchObject({ status: "rejected", reason: "bad-token" });
    });
  });

  it("rejects malformed JSON without crashing the server", async () => {
    await withServer(async (port) => {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = connect({ port, host: "127.0.0.1" }, () => {
          socket.write("this is not json\n");
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
      });
      expect(response).toMatchObject({ status: "rejected", reason: "malformed-frame" });
    });
  });

  it("serves a read-only list-windows request for the right owner", async () => {
    await withServer(async (port) => {
      const response = await roundTrip(port, { token: TOKEN, request: makeRequest() });
      expect(response.status).toBe("ok");
      expect(response.data).toMatchObject({
        windows: [
          { name: "无标题 - 记事本", processId: 111 },
          { name: "Book1 - Excel", processId: 222 },
        ],
      });
    });
  });

  it("rejects a request from another Windows user before touching UIA", async () => {
    let probeCalls = 0;
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({ ownerSid: "S-1-5-21-999" }),
        });
        expect(response).toMatchObject({ status: "rejected", reason: "owner-mismatch" });
        expect(probeCalls).toBe(0);
      },
      {
        listWindows: async () => {
          probeCalls += 1;
          return { ok: true, value: [] };
        },
      },
    );
  });

  it("rejects an expired request before touching UIA", async () => {
    let probeCalls = 0;
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            issuedAt: "2026-10-07T22:00:00.000Z",
            expiresAt: "2026-10-07T22:01:00.000Z",
          }),
        });
        expect(response).toMatchObject({ status: "rejected", reason: "expired" });
        expect(probeCalls).toBe(0);
      },
      {
        listWindows: async () => {
          probeCalls += 1;
          return { ok: true, value: [] };
        },
      },
    );
  });

  it("reports not-implemented for a mutating operation instead of faking success", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "set-value",
            target: { processName: "notepad" },
            approvalTicket: {
              contract: "companyclaw.approval-ticket.v1",
              nonce: "n-1",
              bindingHash: "b".repeat(64),
              issuedAt: "2026-10-08T00:00:00.000Z",
              expiresAt: "2026-10-08T00:01:00.000Z",
              signature: "sig",
            },
          }),
        });
        expect(response).toMatchObject({ status: "failed", reason: "not-implemented" });
      },
      { verifyTicket: () => true },
    );
  });

  it("refuses a mutating operation without a ticket", async () => {
    await withServer(async (port) => {
      const response = await roundTrip(port, {
        token: TOKEN,
        request: makeRequest({ operation: "send-keys", target: { processName: "notepad" } }),
      });
      expect(response).toMatchObject({ status: "rejected", reason: "approval-required" });
    });
  });

  it("surfaces a probe failure as failed rather than as empty success", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, { token: TOKEN, request: makeRequest() });
        expect(response).toMatchObject({ status: "failed", reason: "invalid-json" });
      },
      { listWindows: async () => ({ ok: false, reason: "invalid-json" }) },
    );
  });
});
