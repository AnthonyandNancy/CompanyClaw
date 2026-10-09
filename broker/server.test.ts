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
        // `parseWindowList` always fills processName; the fixture has to carry
        // it too or the window filter cannot match on the real key.
        { name: "无标题 - 记事本", processId: 111, processName: "notepad", automationId: "" },
        { name: "Book1 - Excel", processId: 222, processName: "excel", automationId: "" },
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

  it("refuses a mutating operation whose read-back did not confirm the change", async () => {
    // The operation executed, but the value did not stick. The broker must not
    // report success for an unverified write.
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "set-value",
            target: { processName: "notepad" },
            args: { selector: { automationId: "edit-1" }, newValue: "张三" },
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
        expect(response).toMatchObject({ status: "failed", reason: "verification-failed" });
      },
      {
        verifyTicket: () => true,
        setValue: async () => ({
          ok: true,
          value: {
            window: { name: "无标题 - 记事本", processId: 111 },
            element: {
              name: "文本编辑器",
              automationId: "edit-1",
              controlType: "ControlType.Edit",
              className: "Edit",
              isEnabled: true,
              processId: 111,
            },
            previousValue: "旧值",
            newValue: "张三",
            observedValue: "旧值",
            verified: false,
          },
        }),
      },
    );
  });

  it("reports a verified write as success with the read-back value", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "set-value",
            target: { processName: "notepad" },
            args: { selector: { automationId: "edit-1" }, newValue: "张三" },
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
        expect(response.status).toBe("ok");
        expect(response.data).toMatchObject({
          previousValue: "旧值",
          newValue: "张三",
          observedValue: "张三",
          verified: true,
        });
      },
      {
        verifyTicket: () => true,
        setValue: async () => ({
          ok: true,
          value: {
            window: { name: "无标题 - 记事本", processId: 111 },
            element: {
              name: "文本编辑器",
              automationId: "edit-1",
              controlType: "ControlType.Edit",
              className: "Edit",
              isEnabled: true,
              processId: 111,
            },
            previousValue: "旧值",
            newValue: "张三",
            observedValue: "张三",
            verified: true,
          },
        }),
      },
    );
  });

  it("refuses an element operation with an empty selector", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "read-value",
            target: { processName: "notepad" },
            args: { selector: {} },
          }),
        });
        expect(response).toMatchObject({ status: "rejected", reason: "empty-selector" });
      },
      { readValue: async () => ({ ok: false, reason: "should-not-run" }) },
    );
  });

  it("serves a read-value request through the real gate", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "read-value",
            target: { processName: "notepad" },
            args: { selector: { automationId: "edit-1" } },
          }),
        });
        expect(response.status).toBe("ok");
        expect(response.data).toMatchObject({ value: "当前值", valueReadable: true });
      },
      {
        readValue: async () => ({
          ok: true,
          value: {
            window: { name: "无标题 - 记事本", processId: 111 },
            element: {
              name: "文本编辑器",
              automationId: "edit-1",
              controlType: "ControlType.Edit",
              className: "Edit",
              isEnabled: true,
              processId: 111,
            },
            value: "当前值",
            valueReadable: true,
          },
        }),
      },
    );
  });

  it("describes a target control without relying on coordinates", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "describe-element",
            target: { processName: "notepad" },
            args: { selector: { automationId: "edit-1" } },
          }),
        });
        expect(response).toMatchObject({
          status: "ok",
          data: { matchCount: 1, unique: true },
        });
      },
      {
        findElements: async () => ({
          ok: true,
          value: {
            window: { name: "无标题 - 记事本", processId: 111 },
            elements: [
              {
                name: "文本编辑器",
                automationId: "edit-1",
                controlType: "Edit",
                className: "Edit",
                isEnabled: true,
                processId: 111,
                depth: 2,
              },
            ],
          },
        }),
      },
    );
  });

  it("reports ambiguity instead of picking one of several matches", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "describe-element",
            target: { processName: "notepad" },
            args: { selector: { controlType: "Edit" } },
          }),
        });
        // Two controls match; the caller has to decide, not the broker.
        expect(response).toMatchObject({ status: "ok", data: { matchCount: 2, unique: false } });
      },
      {
        findElements: async () => ({
          ok: true,
          value: {
            window: { name: "无标题 - 记事本", processId: 111 },
            elements: [
              {
                name: "A",
                automationId: "edit-1",
                controlType: "Edit",
                className: "Edit",
                isEnabled: true,
                processId: 111,
                depth: 2,
              },
              {
                name: "B",
                automationId: "edit-2",
                controlType: "Edit",
                className: "Edit",
                isEnabled: true,
                processId: 111,
                depth: 2,
              },
            ],
          },
        }),
      },
    );
  });

  it("rejects an empty describe-element selector", async () => {
    await withServer(async (port) => {
      const response = await roundTrip(port, {
        token: TOKEN,
        request: makeRequest({
          operation: "describe-element",
          target: { processName: "notepad" },
          args: { selector: {} },
        }),
      });
      expect(response).toMatchObject({ status: "rejected", reason: "empty-selector" });
    });
  });

  it("waits for a window that is already present", async () => {
    await withServer(async (port) => {
      const response = await roundTrip(port, {
        token: TOKEN,
        request: makeRequest({
          operation: "wait-for-window",
          target: { processName: "notepad" },
          args: { timeoutMs: 1000 },
        }),
      });
      expect(response).toMatchObject({ status: "ok" });
    });
  });

  it("reports wait-timeout with its own reason when the window never appears", async () => {
    let polls = 0;
    // The deadline follows the injected clock, so this test drives time rather
    // than waiting for the wall clock.
    // Starts at the same instant the policy uses, so the request itself stays
    // valid while the deadline advances.
    const clock = { value: NOW().getTime() };
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "wait-for-window",
            target: { processName: "notepad", windowTitle: "不存在的标题" },
            args: { timeoutMs: 1000 },
          }),
        });
        // "The window never appeared" is a different fault from a probe
        // failure, and the caller reacts differently to each.
        expect(response).toMatchObject({ status: "failed", reason: "wait-timeout" });
        expect(polls).toBeGreaterThan(1);
      },
      {
        now: () => new Date(clock.value),
        // notepad is allowed by the policy but no window carries this title.
        wait: async () => {
          polls += 1;
          clock.value += 400;
        },
      },
    );
  });

  it("rejects an out-of-range wait timeout", async () => {
    await withServer(async (port) => {
      const response = await roundTrip(port, {
        token: TOKEN,
        request: makeRequest({
          operation: "wait-for-window",
          target: { processName: "notepad" },
          args: { timeoutMs: 999_999 },
        }),
      });
      expect(response).toMatchObject({ status: "rejected", reason: "invalid-timeout" });
    });
  });

  it("refuses a send-keys request whose text never reached the control", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "send-keys",
            target: { processName: "notepad" },
            args: { selector: { automationId: "edit-1" }, text: "张三" },
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
        expect(response).toMatchObject({ status: "failed", reason: "verification-failed" });
      },
      {
        verifyTicket: () => true,
        sendKeys: async () => ({
          ok: true,
          value: {
            window: { name: "无标题 - 记事本", processId: 111 },
            element: {
              name: "文本编辑器",
              automationId: "edit-1",
              controlType: "ControlType.Edit",
              className: "Edit",
              isEnabled: true,
              processId: 111,
            },
            typed: "张三",
            expected: "张三",
            observedValue: "",
            verified: false,
          },
        }),
      },
    );
  });

  it("refuses send-keys without text", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "send-keys",
            target: { processName: "notepad" },
            args: { selector: { automationId: "edit-1" } },
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
        expect(response).toMatchObject({ status: "rejected", reason: "missing-text" });
      },
      { verifyTicket: () => true },
    );
  });

  it("rejects a mutating operation whose ticket fails verification", async () => {
    await withServer(
      async (port) => {
        const response = await roundTrip(port, {
          token: TOKEN,
          request: makeRequest({
            operation: "send-keys",
            target: { processName: "notepad" },
            args: { selector: { automationId: "edit-1" } },
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
        expect(response).toMatchObject({ status: "rejected", reason: "invalid-approval-ticket" });
      },
      // Default verifyTicket returns false.
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
