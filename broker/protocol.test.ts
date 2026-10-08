import { describe, expect, it } from "vitest";
import {
  BROKER_PROTOCOL_CONTRACT,
  parseBrokerRequest,
  buildBrokerResponse,
  type BrokerRequest,
} from "./protocol";

const t0 = () => new Date("2026-10-08T00:00:00.000Z");

function request(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
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
    expiresAt: "2026-10-08T00:01:00.000Z",
    payloadHash: "a".repeat(64),
    approvalTicket: null,
    ...overrides,
  };
}

describe("parseBrokerRequest", () => {
  it("accepts a well-formed request", () => {
    const parsed = parseBrokerRequest(request());
    expect(parsed.ok).toBe(true);
  });

  it("rejects a foreign contract", () => {
    const parsed = parseBrokerRequest(request({ contract: "other" as never }));
    expect(parsed).toEqual({ ok: false, reason: "unsupported-contract" });
  });

  it("rejects missing identity fields", () => {
    expect(parseBrokerRequest(request({ ownerSid: "" }))).toEqual({
      ok: false,
      reason: "missing-identity",
    });
    expect(parseBrokerRequest(request({ deviceId: "" }))).toEqual({
      ok: false,
      reason: "missing-identity",
    });
    expect(parseBrokerRequest(request({ taskId: "" }))).toEqual({
      ok: false,
      reason: "missing-identity",
    });
  });

  it("rejects an unknown operation", () => {
    expect(parseBrokerRequest(request({ operation: "rm-rf" as never }))).toEqual({
      ok: false,
      reason: "unsupported-operation",
    });
  });

  it("rejects a malformed or missing payload hash", () => {
    expect(parseBrokerRequest(request({ payloadHash: "nope" }))).toEqual({
      ok: false,
      reason: "malformed-payload-hash",
    });
  });

  it("rejects unparseable timestamps and inverted windows", () => {
    expect(parseBrokerRequest(request({ issuedAt: "not-a-date" }))).toEqual({
      ok: false,
      reason: "malformed-timestamps",
    });
    expect(
      parseBrokerRequest(
        request({ issuedAt: "2026-10-08T00:02:00.000Z", expiresAt: "2026-10-08T00:01:00.000Z" }),
      ),
    ).toEqual({ ok: false, reason: "malformed-timestamps" });
  });

  it("rejects non-object input", () => {
    expect(parseBrokerRequest(null)).toEqual({ ok: false, reason: "not-an-object" });
    expect(parseBrokerRequest("x")).toEqual({ ok: false, reason: "not-an-object" });
  });
});

describe("buildBrokerResponse", () => {
  it("echoes the request id and reports success with data", () => {
    const response = buildBrokerResponse({
      requestId: "req-1",
      outcome: { status: "ok", data: { windows: [] } },
      now: t0,
    });
    expect(response).toMatchObject({
      contract: BROKER_PROTOCOL_CONTRACT,
      requestId: "req-1",
      status: "ok",
    });
    expect(response.completedAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("carries the rejection reason without data", () => {
    const response = buildBrokerResponse({
      requestId: "req-2",
      outcome: { status: "rejected", reason: "app-not-allowed" },
      now: t0,
    });
    expect(response).toMatchObject({ status: "rejected", reason: "app-not-allowed" });
    expect(response.data).toBeUndefined();
  });
});
