import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROKER_PROTOCOL_CONTRACT,
  BROKER_PROTOCOL_CONTRACT_V2,
  MUTATING_OPERATIONS,
  READ_ONLY_OPERATIONS,
  SUPPORTED_BROKER_CONTRACTS,
  V2_OPERATIONS,
  type BrokerOperation,
} from "./broker-protocol";

/**
 * The broker protocol is intentionally mirrored on both sides of the process
 * boundary. These checks read the broker's own source so a change there cannot
 * silently diverge from what the desktop sends — a drift would surface as an
 * unexplained "unsupported-operation" at runtime.
 */
const repositoryRoot = path.resolve(__dirname, "../../..");
const brokerProtocolPath = path.join(repositoryRoot, "broker", "protocol.ts");
const brokerMainPath = path.join(repositoryRoot, "broker", "main.ts");

function readBrokerProtocol(): string {
  return readFileSync(brokerProtocolPath, "utf-8");
}

describe("broker protocol mirror", () => {
  it("agrees with the broker on the contract string", () => {
    const source = readBrokerProtocol();
    const match = source.match(/BROKER_PROTOCOL_CONTRACT\s*=\s*"([^"]+)"/);
    expect(match?.[1]).toBe(BROKER_PROTOCOL_CONTRACT);
  });

  it("covers exactly the operations the broker's parser accepts", () => {
    const source = readBrokerProtocol();
    // Both lists must appear verbatim in the broker's own definition body.
    for (const operation of READ_ONLY_OPERATIONS) {
      expect(source).toContain(`"${operation}"`);
    }
    for (const operation of MUTATING_OPERATIONS) {
      expect(source).toContain(`"${operation}"`);
    }
    const all: BrokerOperation[] = [...READ_ONLY_OPERATIONS, ...MUTATING_OPERATIONS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("treats every mutating operation as ticket-gated on the broker side", () => {
    const source = readBrokerProtocol();
    // The broker derives the mutation gate from its own list, and the desktop
    // mirrors that list; every mutating name must therefore appear in the
    // broker's own definition too, so a write cannot slip through ungated.
    expect(source).toMatch(/isMutatingOperation/);
    for (const operation of MUTATING_OPERATIONS) {
      expect(source).toContain(`"${operation}"`);
    }
  });

  it("declares the v2 contract alongside v1 instead of replacing it", () => {
    const source = readBrokerProtocol();
    expect(source).toContain(BROKER_PROTOCOL_CONTRACT_V2);
    expect(source).toContain(BROKER_PROTOCOL_CONTRACT);
    expect(SUPPORTED_BROKER_CONTRACTS).toEqual([
      BROKER_PROTOCOL_CONTRACT,
      BROKER_PROTOCOL_CONTRACT_V2,
    ]);
  });

  it("keeps every v2 operation defined on both sides", () => {
    const source = readBrokerProtocol();
    for (const operation of V2_OPERATIONS) {
      expect(source).toContain(`"${operation}"`);
    }
  });

  it("agrees with the broker on the bootstrap environment variable names", () => {
    const source = readFileSync(brokerMainPath, "utf-8");
    for (const name of [
      "COMPANYCLAW_BROKER_TOKEN",
      "COMPANYCLAW_BROKER_OWNER_SID",
      "COMPANYCLAW_BROKER_DEVICE_ID",
      "COMPANYCLAW_BROKER_SCRIPT_DIR",
      "COMPANYCLAW_BROKER_ALLOWED_PROCESSES",
      "COMPANYCLAW_BROKER_ALLOWED_WINDOW_TITLES",
    ]) {
      expect(source).toContain(name);
    }
  });
});
