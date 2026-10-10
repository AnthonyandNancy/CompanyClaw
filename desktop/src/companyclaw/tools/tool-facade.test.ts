import { describe, expect, it, vi } from "vitest";
import { ComputerUseToolFacade, describeAction, describeTarget } from "./tool-facade";
import { AGENT_TOOLS, validateToolCall, type AgentToolDefinition } from "./computer-use-tools";
import type { ApprovalBinding, ApprovalTicket } from "../policy/approval-ticket";
import type { ActionDescriptor } from "../policy/risk-classifier";

/**
 * The boundary between the agent and the execution layer.
 *
 * Rulings V5 §5.2/§5.6/§7.1/§7.3: the model may not name its own identity, may
 * not present an approval, must run inside a task, and every dispatch must pass
 * a verdict and (when it mutates) a ticket.
 */

const BINDING: ApprovalBinding = {
  ownerSid: "S-1",
  deviceId: "device-a",
  taskId: "t-1",
  stepId: "s-1",
  actionType: "launchApp",
  targetSystem: "QQ",
  recordId: "",
  field: "",
  oldValue: null,
  newValue: null,
  canonicalPayloadHash: "h",
};

const TICKET: ApprovalTicket = {
  contract: "companyclaw.approval-ticket.v1",
  nonce: "n-1",
  bindingHash: "h",
  issuedAt: "2026-10-10T00:00:00.000Z",
  expiresAt: "2026-10-10T00:02:00.000Z",
  signature: "s",
};

const CONTEXT = {
  origin: "local-ui" as const,
  taskId: "t-1",
  stepId: "s-1",
  ownerSid: "S-1",
  deviceId: "device-a",
};

function makeFacade(overrides: {
  decision?: { decision: "allow" | "require-approval" | "deny"; reason: string; autoAllowedByTaskScope?: boolean };
  dispatchOutcome?: unknown;
} = {}) {
  const audits: Record<string, unknown>[] = [];
  const dispatches: unknown[] = [];
  const facade = new ComputerUseToolFacade({
    decide: () => overrides.decision ?? { decision: "allow", reason: "ok" },
    requestApproval: async () => ({ approvalId: "a-1", binding: BINDING }),
    issueTicket: () => ({ ticket: TICKET, binding: BINDING }),
    dispatch: vi.fn(async (input) => {
      dispatches.push(input);
      return (overrides.dispatchOutcome as never) ?? { outcome: "executed", detail: "done" };
    }) as never,
    recordAudit: (entry) => audits.push(entry as never),
  });
  return { facade, audits, dispatches };
}

describe("tool call validation", () => {
  it("rejects a tool that does not exist", () => {
    expect(validateToolCall({ tool: "shell", arguments: {} }, CONTEXT)).toEqual({
      ok: false,
      reason: "unknown-tool",
    });
  });

  it("rejects a call that names its own origin, owner or device", () => {
    for (const key of ["origin", "ownerSid", "deviceId", "taskId"]) {
      const result = validateToolCall(
        { tool: "click", arguments: { x: 1, y: 2, [key]: "local-ui" } },
        CONTEXT,
      );
      expect(result).toEqual({ ok: false, reason: "model-supplied-identity" });
    }
  });

  it("rejects a call that presents its own approval", () => {
    for (const key of ["approvalTicket", "approved", "approvalId"]) {
      const result = validateToolCall(
        { tool: "click", arguments: { x: 1, y: 2, [key]: "yes" } },
        CONTEXT,
      );
      expect(result).toEqual({ ok: false, reason: "model-supplied-approval" });
    }
  });

  it("rejects a call with no task context", () => {
    expect(validateToolCall({ tool: "click", arguments: { x: 1, y: 2 } }, null)).toEqual({
      ok: false,
      reason: "missing-task-context",
    });
    expect(
      validateToolCall(
        { tool: "click", arguments: { x: 1, y: 2 } },
        { ...CONTEXT, stepId: "" },
      ),
    ).toEqual({ ok: false, reason: "missing-task-context" });
  });

  it("accepts a well-formed call", () => {
    const result = validateToolCall({ tool: "click", arguments: { x: 1, y: 2 } }, CONTEXT);
    expect(result.ok).toBe(true);
  });

  it("never exposes approval-related fields in the tool surface", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.capability).toBeTypeOf("string");
      expect(tool.name).not.toContain("approval");
    }
    expect(AGENT_TOOLS.map((tool: AgentToolDefinition) => tool.name)).toContain("drag-drop");
  });
});

describe("action classification for tool calls", () => {
  function definitionFor(name: string) {
    const found = AGENT_TOOLS.find((tool) => tool.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  }

  it("treats reads as reads", () => {
    for (const name of ["list-windows", "snapshot-ui-tree", "read-control", "verify-state"]) {
      expect(describeAction(definitionFor(name)).kind).toBe("read");
    }
  });

  it("treats application switching and pointer input as writes", () => {
    for (const name of ["launch-app", "focus-window", "click", "type-text", "scroll"]) {
      expect(describeAction(definitionFor(name)).kind).toBe("write");
    }
  });

  it("treats a drag as an outbound transfer", () => {
    const action = describeAction(definitionFor("drag-drop"));
    expect(action.kind).toBe("attachment-to-third-party");
  });

  it("treats an uncharacterised tool as high risk rather than guessing", () => {
    const action: ActionDescriptor = describeAction({
      name: "mystery",
      description: "",
      capability: "verifyState",
      mutating: true,
    });
    expect(action.kind).toBe("high-risk");
  });

  it("reads the target the call addresses", () => {
    expect(describeTarget({ app: "QQ" })).toBe("QQ");
    expect(describeTarget({ windowTitle: "记事本" })).toBe("记事本");
    // A pointer action without a window still has to be describable: the
    // approval the employee reads must say what will be clicked.
    expect(describeTarget({ x: 1, y: 2 })).toContain("1, 2");
    expect(describeTarget({})).toBe("");
  });
});

describe("dispatching a call", () => {
  it("executes an allowed read without a ticket", async () => {
    const { facade, dispatches, audits } = makeFacade();
    const result = await facade.handle({
      call: { tool: "read-control", arguments: { label: "状态" } },
      context: CONTEXT,
      preset: "BASIC",
    });
    expect(result.status).toBe("executed");
    expect(dispatches[0]).not.toHaveProperty("approvalTicket");
    expect(audits[0]).toMatchObject({ decision: "allow", autoAllowed: false });
  });

  it("carries an execution grant for an allowed mutation instead of raising an approval", async () => {
    const { facade, dispatches, audits } = makeFacade();
    await facade.handle({
      call: { tool: "click", arguments: { x: 1, y: 2 } },
      context: CONTEXT,
      preset: "FULL_DAILY",
    });
    // Nothing was asked of the employee: an approval record here would be the
    // repeated prompt the daily preset exists to remove.
    expect(dispatches[0]).toMatchObject({
      executionGrant: { origin: "local-ui" },
    });
    expect(dispatches[0]).not.toHaveProperty("approvalTicket");
    expect(audits[0]).toMatchObject({ decision: "allow", autoAllowed: false });
  });

  it("raises an approval and dispatches nothing when the policy asks", async () => {
    const { facade, dispatches, audits } = makeFacade({
      decision: { decision: "require-approval", reason: "敏感操作" },
    });
    const result = await facade.handle({
      call: { tool: "click", arguments: { x: 1, y: 2 } },
      context: CONTEXT,
      preset: "BASIC",
    });
    expect(result).toEqual({
      status: "approval-required",
      approvalId: "a-1",
      reason: "敏感操作",
    });
    expect(dispatches).toHaveLength(0);
    expect(audits[0]).toMatchObject({ decision: "require-approval", approvalId: "a-1" });
  });

  it("marks an auto-allowed call in the audit", async () => {
    const { facade, audits } = makeFacade({
      decision: { decision: "allow", reason: "任务范围已覆盖", autoAllowedByTaskScope: true },
    });
    await facade.handle({
      call: { tool: "click", arguments: { x: 1, y: 2 } },
      context: CONTEXT,
      preset: "FULL_DAILY",
    });
    expect(audits[0]).toMatchObject({ decision: "allow", autoAllowed: true });
  });

  it("refuses a denied call and dispatches nothing", async () => {
    const { facade, dispatches } = makeFacade({
      decision: { decision: "deny", reason: "远程模式禁止该动作" },
    });
    const result = await facade.handle({
      call: { tool: "drag-drop", arguments: { from: [1, 1], to: [2, 2] } },
      context: { ...CONTEXT, origin: "weixin-private" },
      preset: "FULL_DAILY",
    });
    expect(result).toEqual({ status: "denied", reason: "远程模式禁止该动作" });
    expect(dispatches).toHaveLength(0);
  });

  it("does not run a resumed action when the approval cannot produce a ticket", async () => {
    const dispatches: unknown[] = [];
    const facade = new ComputerUseToolFacade({
      decide: () => ({ decision: "require-approval", reason: "敏感操作" }),
      requestApproval: async () => ({ approvalId: "a-1", binding: BINDING }),
      issueTicket: () => {
        throw new Error("approval is not approved");
      },
      dispatch: vi.fn(async (input) => {
        dispatches.push(input);
        return { outcome: "executed", detail: "done" };
      }) as never,
      recordAudit: () => undefined,
    });
    const result = await facade.handle({
      call: { tool: "click", arguments: { x: 1, y: 2 } },
      context: CONTEXT,
      preset: "BASIC",
      approvalId: "a-1",
    });
    expect(result).toMatchObject({ status: "denied" });
    expect(dispatches).toHaveLength(0);
  });

  it("does not carry an execution grant for a read", async () => {
    const { facade, dispatches } = makeFacade();
    await facade.handle({
      call: { tool: "read-control", arguments: {} },
      context: CONTEXT,
      preset: "BASIC",
    });
    expect(dispatches[0]).not.toHaveProperty("executionGrant");
  });

  it("resumes a granted approval only through the id it was given", async () => {
    const { facade, dispatches } = makeFacade({
      decision: { decision: "require-approval", reason: "敏感操作" },
    });
    const result = await facade.handle({
      call: { tool: "click", arguments: { x: 1, y: 2 } },
      context: CONTEXT,
      preset: "BASIC",
      approvalId: "a-1",
    });
    expect(result.status).toBe("executed");
    expect(dispatches[0]).toMatchObject({ approvalTicket: TICKET });
  });

  it("records an invalid call in the audit", async () => {
    const { facade, audits } = makeFacade();
    const result = await facade.handle({
      call: { tool: "click", arguments: { x: 1, y: 2, origin: "local-ui" } },
      context: CONTEXT,
      preset: "BASIC",
    });
    expect(result).toEqual({ status: "rejected", reason: "model-supplied-identity" });
    expect(audits[0]).toMatchObject({ decision: "invalid-call" });
  });

  it("passes an unavailable broker through as unavailable", async () => {
    const { facade } = makeFacade({
      dispatchOutcome: { outcome: "unavailable", reason: "BROKER_RUNTIME_NOT_FOUND" },
    });
    const result = await facade.handle({
      call: { tool: "read-control", arguments: {} },
      context: CONTEXT,
      preset: "BASIC",
    });
    expect(result).toEqual({ status: "unavailable", reason: "BROKER_RUNTIME_NOT_FOUND" });
  });
});

describe("the tool surface stays narrow", () => {
  it("exposes the W-capabilities and nothing that resembles a shell", () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(names).toContain("list-installed-apps");
    expect(names).toContain("drag-drop");
    for (const forbidden of ["exec", "shell", "powershell", "run", "registry", "clipboard"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
