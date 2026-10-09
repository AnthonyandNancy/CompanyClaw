import { describe, expect, it, vi } from "vitest";
import type { BridgeRequest } from "./execution-bridge";
import {
  createBrokerTransport,
  isMutatingBrokerOperation,
  mapActionToBrokerOperation,
  type BrokerTransportCall,
  type BrokerTransportCaller,
} from "./broker-transport";

type CallResult = Awaited<ReturnType<BrokerTransportCaller>>;

/** A stubbed broker call, typed so the transport's contract is really checked. */
function stubCall(result: CallResult) {
  return vi.fn<(call: BrokerTransportCall) => Promise<CallResult>>().mockResolvedValue(result);
}

/**
 * The transport is the only place where a decided action becomes a broker
 * request. What matters is that it cannot widen the broker's surface: an action
 * outside the closed operation set is refused rather than approximated, and the
 * ticket is handed through so the broker can re-verify it.
 */
function request(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return {
    taskId: "t1",
    stepId: "s1",
    action: {
      kind: "read",
      toolName: "read-value",
      readOnlyProof: "verified-no-side-effect-action-set",
    },
    ...overrides,
  };
}

function transportWith(call: (request: BrokerTransportCall) => Promise<CallResult>) {
  return createBrokerTransport({
    call,
    payloadHashFor: () => "payload-hash",
    targetFor: () => ({ processName: "notepad" }),
    argsFor: () => ({ selector: { automationId: "edit-1" } }),
  });
}

describe("broker transport", () => {
  it("maps every broker operation the bridge can carry", () => {
    for (const operation of [
      "list-windows",
      "describe-element",
      "find-elements",
      "read-value",
      "set-value",
      "invoke-pattern",
      "send-keys",
      "wait-for-window",
    ] as const) {
      expect(
        mapActionToBrokerOperation(request({ action: { kind: "read", toolName: operation } })),
      ).toBe(operation);
    }
  });

  it("refuses an action the broker cannot express", () => {
    // A generic click or an arbitrary command has no UIA equivalent in the
    // closed set; inventing one would hand the agent a wider surface.
    for (const toolName of ["click", "exec", "browser", "arbitrary-command"]) {
      expect(
        mapActionToBrokerOperation(request({ action: { kind: "write", toolName } })),
      ).toBeNull();
    }
  });

  it("rejects an unmappable action without calling the broker", async () => {
    const call = stubCall({ ok: true, data: {} });
    const result = await transportWith(call)(
      request({ action: { kind: "write", toolName: "exec" } }),
    );
    expect(result).toEqual({ status: "rejected", reason: "unsupported-broker-operation" });
    expect(call).not.toHaveBeenCalled();
  });

  it("passes the ticket through so the broker can verify it again", async () => {
    const call = stubCall({ ok: true, data: { value: "ok" } });
    const ticket = { contract: "companyclaw.approval-ticket.v1", nonce: "n1" };
    const result = await transportWith(call)(
      request({
        action: { kind: "write", toolName: "set-value" },
        approvalTicket: ticket as never,
        binding: {} as never,
      }),
    );
    expect(result.status).toBe("ok");
    expect(call.mock.calls[0][0]).toMatchObject({
      operation: "set-value",
      taskId: "t1",
      stepId: "s1",
      approvalTicket: ticket,
    });
  });

  it("keeps the task and step identity on every call", async () => {
    const call = stubCall({ ok: true, data: {} });
    await transportWith(call)(request({ taskId: "task-9", stepId: "step-3" }));
    expect(call.mock.calls[0][0]).toMatchObject({ taskId: "task-9", stepId: "step-3" });
  });

  it("distinguishes an unavailable broker from a refusal", async () => {
    const unavailable = stubCall({
      ok: false,
      reason: "BROKER_RUNTIME_NOT_FOUND: C:/app/resources/node.exe",
      unavailable: true,
    });
    expect((await transportWith(unavailable)(request())).status).toBe("unavailable");

    const refused = stubCall({ ok: false, reason: "process-not-allowed" });
    expect((await transportWith(refused)(request())).status).toBe("rejected");
  });

  it("names the three operations that mutate state", () => {
    // Everything else is a read; the classification drives whether a ticket is
    // required, so a new operation must be added here deliberately.
    expect(
      (["invoke-pattern", "set-value", "send-keys"] as const).every(isMutatingBrokerOperation),
    ).toBe(true);
    expect(isMutatingBrokerOperation("read-value")).toBe(false);
    expect(isMutatingBrokerOperation("describe-element")).toBe(false);
  });

  it("never sends a target the caller did not provide", async () => {
    const call = stubCall({ ok: true, data: {} });
    const transport = createBrokerTransport({
      call,
      payloadHashFor: () => "h",
      targetFor: () => undefined,
      argsFor: () => ({}),
    });
    await transport(request());
    // A missing target must stay missing: an empty object would look like an
    // address rather than "no target".
    expect(call.mock.calls[0][0]).not.toHaveProperty("target");
  });
});
