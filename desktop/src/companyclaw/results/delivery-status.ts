export const DELIVERY_STATES = [
  "SEND_REQUESTED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "UNKNOWN",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_TERMINAL_STATES = ["DELIVERED"] as const satisfies readonly DeliveryState[];

const ALLOWED: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  SEND_REQUESTED: ["SENT", "FAILED", "UNKNOWN"],
  SENT: ["DELIVERED", "FAILED", "UNKNOWN", "SEND_REQUESTED"],
  DELIVERED: [],
  FAILED: ["SEND_REQUESTED"],
  UNKNOWN: ["DELIVERED", "FAILED", "SEND_REQUESTED"],
};

export function canAdvanceDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertDeliveryAdvance(from: DeliveryState, to: DeliveryState): void {
  if (!canAdvanceDelivery(from, to)) {
    throw new Error(`Illegal delivery transition: ${from} -> ${to}`);
  }
}

export type SendOutcome =
  | { platform: "accepted" }
  | { platform: "failed"; reason: string }
  | { platform: "indeterminate"; reason: string };

/** Platform acceptance is never delivery: `accepted` can only reach SENT. */
export function advanceDelivery(_from: "SEND_REQUESTED", outcome: SendOutcome): DeliveryState {
  switch (outcome.platform) {
    case "accepted":
      return "SENT";
    case "failed":
      return "FAILED";
    case "indeterminate":
      return "UNKNOWN";
  }
}

/**
 * Only an explicit terminal receipt may promote a send to DELIVERED. Without a
 * reliable receipt the state stays as-is, so `SENT` never silently becomes
 * `DELIVERED`.
 */
export function advanceWithReceipt(
  from: DeliveryState,
  receipt: "terminal-confirmed" | "none",
): DeliveryState {
  if (receipt === "terminal-confirmed" && canAdvanceDelivery(from, "DELIVERED")) {
    return "DELIVERED";
  }
  return from;
}
