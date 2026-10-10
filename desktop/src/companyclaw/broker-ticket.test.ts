import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  BROKER_TICKET_CONTRACT,
  TICKET_CANONICAL_FIELDS,
  canonicalTicketText,
  issueBrokerTicket,
  signTicket,
} from "./broker-ticket";
import type { BrokerRequest } from "./broker-protocol";

/**
 * The desktop and the broker must agree, byte for byte, on what a ticket signs.
 *
 * A drift here would not fail loudly: it would look like "the broker refuses my
 * writes", which is exactly the kind of unexplained failure the requirements
 * forbid. The test therefore reads the broker's own source the same way the wire
 * protocol test does.
 */

const repositoryRoot = path.resolve(__dirname, "../../..");
const brokerTicketPath = path.join(repositoryRoot, "broker", "ticket-verify.ts");

function readBrokerTicket(): string {
  return readFileSync(brokerTicketPath, "utf-8");
}

describe("ticket mirror", () => {
  it("agrees with the broker on the contract string", () => {
    const source = readBrokerTicket();
    const match = source.match(/BROKER_TICKET_CONTRACT\s*=\s*"([^"]+)"/);
    expect(match?.[1]).toBe(BROKER_TICKET_CONTRACT);
  });

  it("agrees with the broker on the canonical field list", () => {
    const source = readBrokerTicket();
    for (const field of TICKET_CANONICAL_FIELDS) {
      expect(source).toContain(`"${field}"`);
    }
  });

  it("builds the canonical text the same way", () => {
    const source = readBrokerTicket();
    // Both sides join `field=value` lines with a newline, in the same order.
    expect(source).toContain("${field}=${input[field]}");
  });
});

describe("issuing a broker ticket", () => {
  const subject = {
    taskId: "t-1",
    stepId: "s-1",
    ownerSid: "S-1",
    deviceId: "device-a",
    operation: "set-value" as const,
    payloadHash: "a".repeat(64),
  };

  it("binds the request fields into the signature", () => {
    const ticket = issueBrokerTicket({
      subject,
      secret: "k",
      ttlMs: 120_000,
      now: () => new Date("2026-10-10T00:00:00Z"),
      createNonce: () => "n-1",
    });
    expect(ticket.contract).toBe(BROKER_TICKET_CONTRACT);
    expect(ticket.bindingHash).toBe(subject.payloadHash);
    expect(ticket.expiresAt).toBe("2026-10-10T00:02:00.000Z");

    const expectedSignature = createHmac("sha256", "k")
      .update(
        canonicalTicketText({
          contract: BROKER_TICKET_CONTRACT,
          nonce: "n-1",
          taskId: "t-1",
          stepId: "s-1",
          ownerSid: "S-1",
          deviceId: "device-a",
          operation: "set-value",
          payloadHash: "a".repeat(64),
          issuedAt: "2026-10-10T00:00:00.000Z",
          expiresAt: "2026-10-10T00:02:00.000Z",
        }),
      )
      .digest("hex");
    expect(ticket.signature).toBe(expectedSignature);
  });

  it("produces a different signature for a different payload", () => {
    const base = issueBrokerTicket({
      subject,
      secret: "k",
      ttlMs: 60_000,
      now: () => new Date("2026-10-10T00:00:00Z"),
      createNonce: () => "n-1",
    });
    const other = issueBrokerTicket({
      subject: { ...subject, payloadHash: "b".repeat(64) },
      secret: "k",
      ttlMs: 60_000,
      now: () => new Date("2026-10-10T00:00:00Z"),
      createNonce: () => "n-1",
    });
    expect(other.signature).not.toBe(base.signature);
  });

  it("produces a different signature for a different operation", () => {
    const click = issueBrokerTicket({
      subject: { ...subject, operation: "click" },
      secret: "k",
      ttlMs: 60_000,
      now: () => new Date("2026-10-10T00:00:00Z"),
      createNonce: () => "n-1",
    });
    const drag = issueBrokerTicket({
      subject: { ...subject, operation: "drag-drop" },
      secret: "k",
      ttlMs: 60_000,
      now: () => new Date("2026-10-10T00:00:00Z"),
      createNonce: () => "n-1",
    });
    expect(click.signature).not.toBe(drag.signature);
  });

  it("signs with the secret, so a wrong key produces a different value", () => {
    const canonical = {
      contract: BROKER_TICKET_CONTRACT,
      nonce: "n",
      taskId: "t",
      stepId: "s",
      ownerSid: "S",
      deviceId: "d",
      operation: "set-value",
      payloadHash: "c".repeat(64),
      issuedAt: "2026-10-10T00:00:00.000Z",
      expiresAt: "2026-10-10T00:01:00.000Z",
    };
    expect(signTicket(canonical, "k1")).not.toBe(signTicket(canonical, "k2"));
  });
});

describe("the ticket carries no authority of its own", () => {
  it("uses the request identity rather than anything the envelope claims", () => {
    // The broker re-derives every identity field from the request, so a ticket
    // cannot assert a different task, owner or payload than the one in flight.
    const request: Pick<BrokerRequest, "taskId" | "stepId" | "ownerSid" | "deviceId"> = {
      taskId: "t-1",
      stepId: "s-1",
      ownerSid: "S-1",
      deviceId: "device-a",
    };
    const ticket = issueBrokerTicket({
      subject: { ...request, operation: "click", payloadHash: "d".repeat(64) },
      secret: "k",
      ttlMs: 1_000,
      createNonce: () => "n",
    });
    expect(ticket.bindingHash).toBe("d".repeat(64));
  });
});
