import type { RemoteAuthorization } from "../remote/remote-authorization";
import type { CompanyClawTaskRecord, CompanyClawTaskStore } from "./task-store";
import { isTerminalState, type TaskState } from "./task-state";

/**
 * Drives a task through the state machine, one step at a time.
 *
 * The requirements are explicit about three things this loop must do:
 *
 * 1. A write counts as done only after a read-back confirms it. A step whose
 *    verification fails must not be reported as completed - that is why
 *    PARTIAL exists as a distinct outcome from FAILED.
 * 2. A cancel or emergency stop takes effect between steps. The loop re-reads
 *    the task state before each step rather than trusting a snapshot.
 * 3. Nothing runs while remote authorization is off, and nothing runs for a
 *    caller who does not own the task.
 *
 * The orchestrator does not decide *whether* an action is allowed: the execution
 * bridge and the broker do that. It only sequences steps and records the truth.
 */

export interface TaskStep {
  stepId: string;
  executor: string;
  /** What the caller expects to observe after the step, for the read-back. */
  expect: string;
  target?: string;
}

export type StepResult = { ok: true; detail: string } | { ok: false; reason: string };

export interface OrchestratorDeps {
  tasks: CompanyClawTaskStore;
  authorization: () => ReturnType<RemoteAuthorization["state"]>;
  /** Performs the step. Must not report success without doing the work. */
  executeStep: (input: {
    taskId: string;
    stepId: string;
    executor: string;
    expect: string;
    target?: string;
  }) => Promise<StepResult>;
  /** Reads the target back and compares it with `expect`. */
  verifyStep: (input: {
    taskId: string;
    stepId: string;
    executor: string;
    expect: string;
    target?: string;
  }) => Promise<StepResult>;
}

export interface RunTaskInput {
  taskId: string;
  ownerSid: string;
  steps: TaskStep[];
}

export type RunTaskResult =
  | { ok: true; state: TaskState; completedSteps: number }
  | { ok: false; state?: TaskState; reason: string; completedSteps?: number };

const ACTIVE_STATES: readonly TaskState[] = [
  "CREATED",
  "AUTHENTICATED",
  "PLANNING",
  "RUNNING",
  "PAUSED",
  "RESUMING",
];

export class TaskOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** Alias kept for readability at call sites. */
  async run(input: RunTaskInput): Promise<RunTaskResult> {
    if (this.deps.authorization() !== "enabled") {
      return { ok: false, reason: "remote-not-authorized" };
    }

    const task = this.deps.tasks.get(input.taskId);
    if (!task || task.ownerSid !== input.ownerSid) {
      return { ok: false, reason: "unknown-task" };
    }
    if (isTerminalState(task.state)) {
      return { ok: false, reason: "terminal-task", state: task.state };
    }

    await this.advanceTo(input.taskId, "AUTHENTICATED");
    await this.advanceTo(input.taskId, "PLANNING");
    await this.advanceTo(input.taskId, "RUNNING");

    let completedSteps = 0;
    for (const step of input.steps) {
      // Re-read before each step: a cancel between steps must be honoured, and
      // the snapshot taken at the top of the loop is not authoritative.
      const current = this.deps.tasks.get(input.taskId);
      if (!current) return { ok: false, reason: "unknown-task", completedSteps };
      if (isTerminalState(current.state)) {
        return { ok: false, reason: "task-cancelled", state: current.state, completedSteps };
      }

      const executed = await this.deps.executeStep({
        taskId: input.taskId,
        stepId: step.stepId,
        executor: step.executor,
        expect: step.expect,
        ...(step.target !== undefined ? { target: step.target } : {}),
      });
      if (!executed.ok) {
        await this.finish(input.taskId, "FAILED", executed.reason);
        return { ok: false, reason: executed.reason, state: "FAILED", completedSteps };
      }

      await this.noteStep(input.taskId, step, "VERIFYING");
      const verified = await this.deps.verifyStep({
        taskId: input.taskId,
        stepId: step.stepId,
        executor: step.executor,
        expect: step.expect,
        ...(step.target !== undefined ? { target: step.target } : {}),
      });
      if (!verified.ok) {
        // The write may have landed; we could not prove it. Report PARTIAL so
        // the caller knows to check rather than assuming either outcome.
        await this.finish(input.taskId, "PARTIAL", verified.reason);
        return { ok: false, reason: verified.reason, state: "PARTIAL", completedSteps };
      }

      completedSteps += 1;
      await this.advanceTo(input.taskId, "RUNNING", step.stepId);
    }

    await this.advanceTo(input.taskId, "VERIFYING");
    const finalRecord = await this.finish(input.taskId, "COMPLETED", "read-back matched");
    return { ok: true, state: finalRecord.state, completedSteps };
  }

  private async advanceTo(
    taskId: string,
    to: TaskState,
    stepId?: string,
  ): Promise<void> {
    const current = this.deps.tasks.get(taskId);
    if (!current || current.state === to) return;
    if (!this.canReach(current.state, to)) return;
    await this.deps.tasks.advance(taskId, to, stepId ? { stepId } : {});
  }

  private canReach(from: TaskState, to: TaskState): boolean {
    if (from === to) return true;
    if (isTerminalState(from)) return false;
    return (
      ACTIVE_STATES.includes(from) &&
      (ACTIVE_STATES.includes(to) || to === "VERIFYING" || to === "COMPLETED")
    );
  }

  private async noteStep(taskId: string, step: TaskStep, state: TaskState): Promise<void> {
    const current = this.deps.tasks.get(taskId);
    if (!current || isTerminalState(current.state)) return;
    // Returning to VERIFYING after a verified step is a no-op: the state is
    // already there, and re-asserting it would be an illegal self-transition.
    if (current.state === state) return;
    if (current.state === "RUNNING" && state === "VERIFYING") {
      await this.deps.tasks.advance(taskId, "VERIFYING", {
        stepId: step.stepId,
        executor: step.executor,
      });
      return;
    }
    if (current.state === "VERIFYING" && state === "RUNNING") {
      await this.deps.tasks.advance(taskId, "RUNNING", { stepId: step.stepId });
      return;
    }
    await this.deps.tasks.advance(taskId, state, { stepId: step.stepId });
  }

  private async finish(
    taskId: string,
    to: "COMPLETED" | "PARTIAL" | "FAILED",
    summary: string,
  ): Promise<CompanyClawTaskRecord> {
    // VERIFYING can reach COMPLETED / PARTIAL / FAILED; RUNNING cannot reach the
    // terminal states directly in every case, so move through VERIFYING first.
    let current = this.deps.tasks.get(taskId);
    if (!current) throw new Error(`Unknown task: ${taskId}`);
    if (isTerminalState(current.state)) return current;
    if (current.state !== "VERIFYING") {
      await this.deps.tasks.advance(taskId, "VERIFYING", {});
      current = this.deps.tasks.get(taskId);
      if (!current) throw new Error(`Unknown task: ${taskId}`);
      if (isTerminalState(current.state)) return current;
    }
    return await this.deps.tasks.advance(taskId, to, { resultSummary: summary });
  }
}
