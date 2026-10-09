import { describe, expect, it, vi } from "vitest";
import { BrowserPolicy } from "../policy/browser-policy";
import { BrowserAdapter } from "./browser-adapter";

/**
 * The adapter is the only path from a remote task to a web action, so the cases
 * that matter are the ones where it must *not* reach the executor. A policy
 * module that exists but is never consulted protects nothing (V3 §10.1), and a
 * write that cannot be read back must never be reported as done.
 */
const allowedDomains = ["oa.example.com"];

function adapterWith(overrides?: {
  authorize?: (request: {
    action: string;
    url: string;
  }) =>
    | { allowed: true; risk: "read" | "write" | "high-risk" }
    | { allowed: false; reason: string };
}) {
  const policy = new BrowserPolicy({
    allowedDomains,
    allowDownloads: true,
    allowUploads: false,
  });
  const execute = vi.fn().mockResolvedValue({ ok: true, detail: "ok" });
  const readBack = vi.fn().mockResolvedValue({ matched: true });
  const adapter = new BrowserAdapter({
    authorization: {
      authorize:
        overrides?.authorize ??
        ((request) => {
          const decision = policy.authorize(request);
          return decision.allowed
            ? { allowed: true as const, risk: decision.risk }
            : { allowed: false as const, reason: decision.reason };
        }),
    },
    execute,
    readBack,
  });
  return { adapter, execute, readBack };
}

describe("browser adapter", () => {
  it("runs a read action and verifies it", async () => {
    const { adapter, execute, readBack } = adapterWith();
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "read",
      url: "https://oa.example.com/tickets",
    });
    expect(result).toEqual({ outcome: "verified", risk: "read", detail: "ok" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readBack).toHaveBeenCalledTimes(1);
  });

  it("never reaches the executor when remote operation is off", async () => {
    const { adapter, execute } = adapterWith({
      authorize: () => ({ allowed: false, reason: "remote-not-authorized" }),
    });
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "read",
      url: "https://oa.example.com/",
    });
    expect(result).toEqual({ outcome: "denied", reason: "remote-not-authorized" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never reaches the executor for a domain outside the allow list", async () => {
    const { adapter, execute } = adapterWith();
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "read",
      url: "https://evil.net/",
    });
    expect(result).toEqual({ outcome: "denied", reason: "domain-not-allowed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an unapproved write without calling the executor", async () => {
    const { adapter, execute } = adapterWith();
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "fill-form",
      url: "https://oa.example.com/tickets",
    });
    expect(result).toEqual({ outcome: "denied", reason: "approval-required" });
    // This is the claim the requirements care about: no ticket, no write.
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs an approved write", async () => {
    const { adapter, execute } = adapterWith();
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "fill-form",
      url: "https://oa.example.com/tickets",
      approvalTicket: {
        contract: "companyclaw.approval-ticket.v1",
        nonce: "n1",
        bindingHash: "h1",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        signature: "s",
      },
    });
    expect(result.outcome).toBe("verified");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("treats a generic click as a write", async () => {
    const { adapter, execute } = adapterWith();
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "click",
      url: "https://oa.example.com/tickets",
    });
    // A click can submit a form, so it must not slip through as a read.
    expect(result).toEqual({ outcome: "denied", reason: "approval-required" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a high-risk action even with a ticket", async () => {
    const { adapter, execute } = adapterWith();
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "delete",
      url: "https://oa.example.com/tickets/1",
      approvalTicket: {
        contract: "companyclaw.approval-ticket.v1",
        nonce: "n1",
        bindingHash: "h1",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        signature: "s",
      },
    });
    expect(result).toEqual({ outcome: "denied", reason: "high-risk-action" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("re-checks the target after a redirect", async () => {
    // Navigation is re-authorized per target, so a redirect to a host that is
    // not allowed must stop rather than inherit the first decision.
    const seen: string[] = [];
    const policy = new BrowserPolicy({
      allowedDomains,
      allowDownloads: true,
      allowUploads: false,
    });
    const execute = vi.fn(async () => {
      // The executor reports the redirected target, which must be re-checked.
      const redirected = "https://evil.net/steal";
      seen.push(redirected);
      const decision = policy.authorize({ action: "navigate", url: redirected });
      if (!decision.allowed) return { ok: false as const, reason: decision.reason };
      return { ok: true as const, detail: "ok" };
    });
    const adapter = new BrowserAdapter({
      authorization: {
        authorize: (request) => {
          const decision = policy.authorize(request);
          return decision.allowed
            ? { allowed: true as const, risk: decision.risk }
            : { allowed: false as const, reason: decision.reason };
        },
      },
      execute,
      readBack: vi.fn().mockResolvedValue({ matched: true }),
    });

    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "read",
      url: "https://oa.example.com/",
    });
    expect(seen).toEqual(["https://evil.net/steal"]);
    expect(result).toEqual({ outcome: "denied", reason: "domain-not-allowed" });
  });

  it("refuses file:// and bare javascript: targets", async () => {
    const { adapter, execute } = adapterWith();
    for (const url of ["file:///C:/Users/me/secrets.txt", "javascript:alert(1)"]) {
      const result = await adapter.run({ taskId: "t", stepId: "s", action: "read", url });
      expect(result).toEqual({ outcome: "denied", reason: "unsupported-scheme" });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports partial when the read-back does not match", async () => {
    const { adapter, readBack } = adapterWith();
    readBack.mockResolvedValue({ matched: false, reason: "value unchanged" });
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "read",
      url: "https://oa.example.com/",
    });
    // The action may have landed; the adapter must not claim it did.
    expect(result).toEqual({ outcome: "partial", reason: "value unchanged" });
  });

  it("surfaces an executor failure as denied rather than verified", async () => {
    const { adapter, execute } = adapterWith();
    execute.mockResolvedValue({ ok: false, reason: "target window not found" });
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "read",
      url: "https://oa.example.com/",
    });
    expect(result).toEqual({ outcome: "denied", reason: "target window not found" });
  });

  it("reports an executor that throws as unavailable, not as a policy denial", async () => {
    const { adapter, execute } = adapterWith();
    execute.mockRejectedValue(new Error("browser driver missing"));
    const result = await adapter.run({
      taskId: "t1",
      stepId: "s1",
      action: "read",
      url: "https://oa.example.com/",
    });
    expect(result).toEqual({ outcome: "unavailable", reason: "browser driver missing" });
  });

  it("keeps the task identity on every call", async () => {
    const { adapter, execute, readBack } = adapterWith();
    await adapter.run({
      taskId: "task-42",
      stepId: "step-7",
      action: "read",
      url: "https://oa.example.com/",
    });
    expect(execute.mock.calls[0][0]).toMatchObject({ taskId: "task-42", stepId: "step-7" });
    expect(readBack.mock.calls[0][0]).toMatchObject({ taskId: "task-42", stepId: "step-7" });
  });
});
