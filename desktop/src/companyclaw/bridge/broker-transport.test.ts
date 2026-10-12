import { describe, expect, it, vi } from "vitest";
import type { BridgeRequest } from "./execution-bridge";
import {
  createBrokerTransport,
  isMutatingBrokerOperation,
  mapActionToBrokerOperation,
  type BrokerTransportCall,
  type BrokerTransportCaller,
} from "./broker-transport";
import { MUTATING_OPERATIONS } from "../broker-protocol";
import { MAX_RESULT_CHARS } from "./broker-transport";

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
    // An arbitrary command or an unknown tool has no operation in the closed
    // set; inventing one would hand the agent a wider surface.
    for (const toolName of ["exec", "browser", "arbitrary-command", "mystery"]) {
      expect(
        mapActionToBrokerOperation(request({ action: { kind: "write", toolName } })),
      ).toBeNull();
    }
  });

  it("maps every v2 computer-use operation", () => {
    const pairs: [string, string][] = [
      ["list-installed-apps", "list-installed-apps"],
      ["launch-app", "launch-app"],
      ["focus-window", "focus-window"],
      ["snapshot-ui-tree", "snapshot-ui-tree"],
      ["find-control", "find-control"],
      ["screenshot", "screenshot"],
      ["click", "click"],
      ["move", "move"],
      ["drag-drop", "drag-drop"],
      ["scroll", "scroll"],
      ["wait-for-condition", "wait-for-condition"],
      ["inspect-dialog", "inspect-dialog"],
      ["verify-state", "verify-state"],
      // Text entry, shortcuts and single-control reads are part of the tool
      // surface; leaving them out of the table made them fail with
      // `unsupported-broker-operation` after the model had already been told the
      // capability existed.
      ["type-text", "type-text"],
      ["hotkey", "hotkey"],
      ["read-control", "read-control"],
    ];
    for (const [toolName, operation] of pairs) {
      expect(
        mapActionToBrokerOperation(request({ action: { kind: "write", toolName } })),
      ).toBe(operation);
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

  it("mints a broker ticket for the exact request instead of forwarding the policy ticket", async () => {
    const call = stubCall({ ok: true, data: { value: "ok" } });
    const policyTicket = { contract: "companyclaw.approval-ticket.v1", nonce: "n1" };
    const issued: { operation: string; payloadHash: string }[] = [];
    const transport = createBrokerTransport({
      call,
      payloadHashFor: () => "h",
      targetFor: () => ({ processName: "notepad" }),
      argsFor: () => ({}),
      issueTicket: (input) => {
        issued.push({ operation: input.operation, payloadHash: input.payloadHash });
        return { contract: "companyclaw.broker-ticket.v1", nonce: "broker-n1" };
      },
    });
    const result = await transport(
      request({
        action: { kind: "write", toolName: "set-value" },
        approvalTicket: policyTicket as never,
        binding: {} as never,
      }),
    );
    expect(result.status).toBe("ok");
    // The broker verifies a ticket signed over the request fields, so the policy
    // ticket cannot be reused as one.
    expect(issued).toEqual([{ operation: "set-value", payloadHash: "h" }]);
    expect(call.mock.calls[0][0]).toMatchObject({
      operation: "set-value",
      taskId: "t1",
      stepId: "s1",
      approvalTicket: { contract: "companyclaw.broker-ticket.v1", nonce: "broker-n1" },
    });
  });

  it("sends no ticket for a read-only action", async () => {
    const call = stubCall({ ok: true, data: {} });
    const transport = createBrokerTransport({
      call,
      payloadHashFor: () => "h",
      targetFor: () => ({ processName: "notepad" }),
      argsFor: () => ({}),
      issueTicket: () => ({ contract: "companyclaw.broker-ticket.v1", nonce: "n" }),
    });
    await transport(request({ action: { kind: "read", toolName: "read-value" } }));
    expect(call.mock.calls[0][0]).not.toHaveProperty("approvalTicket");
  });

  it("refuses a mutation when no ticket can be minted", async () => {
    const call = stubCall({ ok: true, data: {} });
    // Without an issuer the broker would reject the call anyway; sending it
    // unauthenticated would only produce a confusing refusal.
    const transport = createBrokerTransport({
      call,
      payloadHashFor: () => "h",
      targetFor: () => ({ processName: "notepad" }),
      argsFor: () => ({}),
    });
    await transport(
      request({
        action: { kind: "write", toolName: "set-value" },
        approvalTicket: { contract: "x", nonce: "n" } as never,
        binding: {} as never,
      }),
    );
    expect(call.mock.calls[0][0]).not.toHaveProperty("approvalTicket");
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

  it("classifies writes and reads exactly as the broker does", () => {
    // The classification drives whether a ticket is required, so a new
    // operation has to be added to the protocol table deliberately; this test
    // reads that table rather than repeating it.
    for (const operation of MUTATING_OPERATIONS) {
      expect(isMutatingBrokerOperation(operation)).toBe(true);
    }
    expect(isMutatingBrokerOperation("read-value")).toBe(false);
    expect(isMutatingBrokerOperation("describe-element")).toBe(false);
    expect(isMutatingBrokerOperation("screenshot")).toBe(false);
    expect(isMutatingBrokerOperation("snapshot-ui-tree")).toBe(false);
  });

  it("treats the pointer and application operations as writes", () => {
    for (const operation of ["click", "move", "drag-drop", "launch-app", "focus-window", "scroll"] as const) {
      expect(isMutatingBrokerOperation(operation)).toBe(true);
    }
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

describe("the tool call's arguments reach the broker", () => {
  function transportWithoutOverride(call: (request: BrokerTransportCall) => Promise<CallResult>) {
    return createBrokerTransport({
      call,
      payloadHashFor: () => "h",
      targetFor: () => undefined,
    });
  }

  it("forwards them when no override is configured", async () => {
    // The production wiring used to pass `argsFor: () => ({})`, a constant that
    // silently discarded every argument. A launch then arrived with no
    // application name and the executor refused it — the tool looked broken while
    // every unit below it passed.
    const call = stubCall({ ok: true, data: {} });
    const transport = transportWithoutOverride(call);
    await transport(request({ action: { kind: "write", toolName: "launch-app" }, arguments: { app: "QQ" } }));
    expect(call.mock.calls[0][0].args).toEqual({ app: "QQ" });
  });

  it("sends an empty object when the call carried no arguments", async () => {
    const call = stubCall({ ok: true, data: {} });
    const transport = transportWithoutOverride(call);
    await transport(request({ action: { kind: "write", toolName: "screenshot" } }));
    expect(call.mock.calls[0][0].args).toEqual({});
  });

  it("keeps an explicit override authoritative", async () => {
    const call = stubCall({ ok: true, data: {} });
    const transport = transportWith(call);
    await transport(
      request({ action: { kind: "write", toolName: "read-value" }, arguments: { ignored: true } }),
    );
    expect(call.mock.calls[0][0].args).toEqual({ selector: { automationId: "edit-1" } });
  });
});

describe("a result reaches the model as valid JSON", () => {
  const apps = Array.from({ length: 185 }, (_, index) => ({
    name: `应用-${index}`,
    appId: `C:\\Program Files\\app-${index}\\app.exe`,
  }));

  it("keeps a realistic application list intact", async () => {
    // The fixed 2 000-character cut used to break this payload mid-string, so the
    // model received a document no parser accepts and could not pick a name to
    // launch — the discovery feature looked broken while every probe passed.
    const call = stubCall({ ok: true, data: { apps } });
    const transport = createBrokerTransport({ call, payloadHashFor: () => "h", targetFor: () => undefined });
    const response = await transport(request({ action: { kind: "read", toolName: "list-installed-apps" } }));
    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    const parsed = JSON.parse(response.detail) as { apps: { name: string }[] };
    expect(parsed.apps).toHaveLength(185);
    expect(parsed.apps[0].name).toBe("应用-0");
  });

  it("shortens an oversized list by whole entries, never mid-document", async () => {
    const huge = Array.from({ length: 40_000 }, (_, index) => ({
      name: `item-${index}`,
      blob: "x".repeat(40),
    }));
    const call = stubCall({ ok: true, data: { windows: huge } });
    const transport = createBrokerTransport({ call, payloadHashFor: () => "h", targetFor: () => undefined });
    const response = await transport(request({ action: { kind: "read", toolName: "list-windows" } }));
    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    // Parseable, non-empty, and shorter than the original.
    const parsed = JSON.parse(response.detail) as { windows: unknown[] };
    expect(Array.isArray(parsed.windows)).toBe(true);
    expect(parsed.windows.length).toBeGreaterThan(0);
    expect(parsed.windows.length).toBeLessThan(huge.length);
  });

  it("reports a shape it cannot shorten instead of cutting the document", async () => {
    const call = stubCall({ ok: true, data: { note: "y".repeat(MAX_RESULT_CHARS + 1_000) } });
    const transport = createBrokerTransport({ call, payloadHashFor: () => "h", targetFor: () => undefined });
    const response = await transport(request({ action: { kind: "read", toolName: "verify-state" } }));
    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    const parsed = JSON.parse(response.detail) as { truncated?: boolean; reason?: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.reason).toBe("result-too-large");
  });
});
