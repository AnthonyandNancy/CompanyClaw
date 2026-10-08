export const TASK_STATES = [
  "CREATED",
  "AUTHENTICATED",
  "PLANNING",
  "RUNNING",
  "AWAITING_APPROVAL",
  "PAUSE_REQUESTED",
  "PAUSED",
  "RESUMING",
  "VERIFYING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const satisfies readonly TaskState[];

export type TaskControl = "pause" | "resume" | "cancel" | "emergency-stop";

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  CREATED: ["AUTHENTICATED", "CANCELLED", "FAILED", "EXPIRED"],
  AUTHENTICATED: ["PLANNING", "CANCELLED", "FAILED", "EXPIRED"],
  PLANNING: ["RUNNING", "AWAITING_APPROVAL", "CANCELLED", "FAILED", "EXPIRED"],
  RUNNING: [
    "AWAITING_APPROVAL",
    "PAUSE_REQUESTED",
    "VERIFYING",
    "CANCELLED",
    "FAILED",
    "EXPIRED",
  ],
  AWAITING_APPROVAL: ["RUNNING", "PAUSE_REQUESTED", "CANCELLED", "FAILED", "EXPIRED"],
  PAUSE_REQUESTED: ["PAUSED", "CANCELLED", "FAILED", "EXPIRED"],
  PAUSED: ["RESUMING", "CANCELLED", "FAILED", "EXPIRED"],
  // 恢复后可能直接进入验证（暂停发生在写入之后）或回到等待授权。
  RESUMING: ["RUNNING", "AWAITING_APPROVAL", "CANCELLED", "FAILED", "EXPIRED"],
  VERIFYING: ["COMPLETED", "PARTIAL", "RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  PARTIAL: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isActiveState(state: TaskState): boolean {
  return !isTerminalState(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}

const ACTIVE_BEFORE_TERMINAL: readonly TaskState[] = [
  "CREATED",
  "AUTHENTICATED",
  "PLANNING",
  "RUNNING",
  "AWAITING_APPROVAL",
  "PAUSE_REQUESTED",
  "PAUSED",
  "RESUMING",
  "VERIFYING",
];

const CONTROL_MAP: Readonly<Record<TaskControl, readonly TaskState[]>> = {
  pause: ["RUNNING", "AWAITING_APPROVAL", "PLANNING"],
  resume: ["PAUSED"],
  cancel: ACTIVE_BEFORE_TERMINAL,
  "emergency-stop": ACTIVE_BEFORE_TERMINAL,
};

/** Returns the next state, or null when the control is illegal for this state. */
export function nextStateForControl(state: TaskState, control: TaskControl): TaskState | null {
  if (!CONTROL_MAP[control].includes(state)) return null;
  switch (control) {
    case "pause":
      return "PAUSE_REQUESTED";
    case "resume":
      return "RESUMING";
    case "cancel":
      return "CANCELLED";
    case "emergency-stop":
      return "CANCELLED";
  }
}
