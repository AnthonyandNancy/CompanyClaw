import { defineStore } from "pinia";
import { computed, ref } from "vue";

/**
 * CompanyClaw security-core state.
 *
 * Every value here comes from the main process over the `companyclaw:*` IPC
 * channels. The store never invents state, never derives an authorization
 * decision locally, and never treats a missing bridge as "allowed" — when the
 * bridge is unavailable the feature reports itself as unavailable.
 */

export type RemoteAuthorizationState = "disabled" | "enabled" | "expired" | "revoked";

export interface RemoteAuthorizationView {
  state: RemoteAuthorizationState;
  ownerSid: string;
  deviceId: string;
  channelUserId: string;
  grantedAt: string | null;
  expiresAt: string | null;
}

export interface TaskSummary {
  taskId: string;
  state: string;
  objective: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  resultSummary: string | null;
}

export interface PendingApproval {
  approvalId: string;
  status: string;
  targetSystem: string;
  recordId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  requestedAt: string;
  expiresAt: string;
}

export type TaskControl = "pause" | "resume" | "cancel" | "emergency-stop";

export interface ControlResult {
  accepted: boolean;
  reason?: string;
}

export interface BrokerTargets {
  allowedProcesses: string[];
  allowedWindowTitles: string[];
}

export interface BrowserPolicyView {
  allowedDomains: string[];
  allowDownloads: boolean;
  allowUploads: boolean;
}

export interface IdentityBindingView {
  ownerSid: string;
  deviceId: string;
  channelType: string;
  channelUserId: string;
  boundAt: string;
}

export interface CapabilityProbeInput {
  baseUrl: string;
  model: string;
  apiFormat: "openai-chat" | "openai-responses" | "anthropic";
  apiKey: string;
}

export interface CapabilityProbeView {
  capabilities: Record<string, unknown>;
  summary: string;
}

interface CompanyClawBridge {
  getRemoteAuthorization: () => Promise<RemoteAuthorizationView>;
  setRemoteAuthorization: (input: {
    enabled: boolean;
    ttlMinutes?: number;
    channelUserId?: string;
  }) => Promise<RemoteAuthorizationView>;
  tasks: {
    list: (input?: { state?: string }) => Promise<TaskSummary[]>;
    get: (input: { taskId: string }) => Promise<{ record: unknown } | null>;
    control: (input: {
      taskId: string;
      control: TaskControl;
      reason?: string;
    }) => Promise<{ accepted: boolean; record: unknown; reason?: string }>;
  };
  approvals: {
    listPending: () => Promise<PendingApproval[]>;
    resolve: (input: { approvalId: string; decision: "approved" | "denied" }) => Promise<unknown>;
  };
  broker: {
    getTargets: () => Promise<BrokerTargets>;
    setTargets: (input: {
      allowedProcesses?: string[];
      allowedWindowTitles?: string[];
    }) => Promise<BrokerTargets>;
  };
  identity: {
    get: () => Promise<IdentityBindingView | null>;
    bind: (input: { channelType: string; channelUserId: string }) => Promise<unknown>;
    unbind: () => Promise<void>;
  };
  model: {
    probeCapabilities: (input: CapabilityProbeInput) => Promise<CapabilityProbeView>;
  };
  browser: {
    getPolicy: () => Promise<BrowserPolicyView>;
    setPolicy: (input: {
      allowedDomains?: string[];
      allowDownloads?: boolean;
      allowUploads?: boolean;
    }) => Promise<BrowserPolicyView>;
  };
}

function bridge(): CompanyClawBridge | null {
  const api = (window as unknown as { openclaw?: { companyClaw?: CompanyClawBridge } }).openclaw;
  return api?.companyClaw ?? null;
}

/** States that mean the task is still running and can be controlled. */
const ACTIVE_STATES = new Set([
  "CREATED",
  "AUTHENTICATED",
  "PLANNING",
  "RUNNING",
  "AWAITING_APPROVAL",
  "PAUSE_REQUESTED",
  "PAUSED",
  "RESUMING",
  "VERIFYING",
]);

export const useCompanyClawStore = defineStore("companyclaw", () => {
  const available = ref(true);
  const loading = ref(false);
  const error = ref("");
  const authorization = ref<RemoteAuthorizationView | null>(null);
  const tasks = ref<TaskSummary[]>([]);
  const pendingApprovals = ref<PendingApproval[]>([]);
  const brokerTargets = ref<BrokerTargets>({ allowedProcesses: [], allowedWindowTitles: [] });
  const browserPolicy = ref<BrowserPolicyView>({
    allowedDomains: [],
    allowDownloads: false,
    allowUploads: false,
  });
  const identityBinding = ref<IdentityBindingView | null>(null);

  const remoteEnabled = computed(() => authorization.value?.state === "enabled");
  const activeTasks = computed(() => tasks.value.filter((task) => ACTIVE_STATES.has(task.state)));

  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function refresh(): Promise<void> {
    const api = bridge();
    if (!api) {
      available.value = false;
      authorization.value = null;
      tasks.value = [];
      pendingApprovals.value = [];
      brokerTargets.value = { allowedProcesses: [], allowedWindowTitles: [] };
      browserPolicy.value = { allowedDomains: [], allowDownloads: false, allowUploads: false };
      identityBinding.value = null;
      return;
    }
    available.value = true;
    loading.value = true;
    error.value = "";
    try {
      const [auth, list, pending, targets, browser, identity] = await Promise.all([
        api.getRemoteAuthorization(),
        api.tasks.list(),
        api.approvals.listPending(),
        api.broker.getTargets(),
        api.browser.getPolicy(),
        api.identity.get(),
      ]);
      authorization.value = auth;
      tasks.value = list;
      pendingApprovals.value = pending;
      brokerTargets.value = targets;
      browserPolicy.value = browser;
      identityBinding.value = identity;
    } catch (err) {
      // Keep whatever was already loaded: a transient failure must not make the
      // UI pretend there are no tasks or no pending approvals.
      error.value = messageOf(err);
    } finally {
      loading.value = false;
    }
  }

  async function enableRemoteOperation(input: {
    ttlMinutes: number;
    channelUserId?: string;
  }): Promise<void> {
    const api = bridge();
    if (!api) return;
    loading.value = true;
    error.value = "";
    try {
      authorization.value = await api.setRemoteAuthorization({
        enabled: true,
        ttlMinutes: input.ttlMinutes,
        ...(input.channelUserId ? { channelUserId: input.channelUserId } : {}),
      });
    } catch (err) {
      error.value = messageOf(err);
    } finally {
      loading.value = false;
    }
  }

  async function revokeRemoteOperation(): Promise<void> {
    const api = bridge();
    if (!api) return;
    loading.value = true;
    error.value = "";
    try {
      authorization.value = await api.setRemoteAuthorization({ enabled: false });
    } catch (err) {
      error.value = messageOf(err);
    } finally {
      loading.value = false;
    }
  }

  async function controlTask(taskId: string, control: TaskControl): Promise<ControlResult> {
    const api = bridge();
    if (!api) return { accepted: false, reason: "unavailable" };
    error.value = "";
    try {
      const result = await api.tasks.control({ taskId, control });
      if (!result.accepted) {
        // A refused control is a normal outcome (the state machine said no).
        // Refresh first, then record the reason: refresh() clears `error`, so
        // setting it beforehand would erase the very reason we want to show.
        await refresh();
        error.value = result.reason ?? "control rejected";
        return { accepted: false, ...(result.reason ? { reason: result.reason } : {}) };
      }
      await refresh();
      return { accepted: true };
    } catch (err) {
      error.value = messageOf(err);
      return { accepted: false, reason: messageOf(err) };
    }
  }

  async function resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    const api = bridge();
    if (!api) return;
    error.value = "";
    try {
      await api.approvals.resolve({ approvalId, decision });
      pendingApprovals.value = pendingApprovals.value.filter(
        (approval) => approval.approvalId !== approvalId,
      );
    } catch (err) {
      error.value = messageOf(err);
    }
  }

  async function setBrokerTargets(input: BrokerTargets): Promise<void> {
    const api = bridge();
    if (!api) return;
    error.value = "";
    try {
      brokerTargets.value = await api.broker.setTargets(input);
    } catch (err) {
      error.value = messageOf(err);
    }
  }

  async function setBrowserPolicy(input: BrowserPolicyView): Promise<void> {
    const api = bridge();
    if (!api) return;
    error.value = "";
    try {
      browserPolicy.value = await api.browser.setPolicy(input);
    } catch (err) {
      error.value = messageOf(err);
    }
  }

  async function unbindIdentity(): Promise<void> {
    const api = bridge();
    if (!api) return;
    error.value = "";
    try {
      await api.identity.unbind();
      identityBinding.value = null;
    } catch (err) {
      error.value = messageOf(err);
    }
  }

  /**
   * Measures what the configured model can actually do.
   *
   * Returns null when the bridge is unavailable; a transport or HTTP failure
   * comes back as `unknown` capabilities from the main process rather than a
   * fabricated verdict, so the caller can show that it was not verified.
   */
  async function probeModelCapabilities(
    input: CapabilityProbeInput,
  ): Promise<CapabilityProbeView | null> {
    const api = bridge();
    if (!api?.model?.probeCapabilities) return null;
    error.value = "";
    try {
      return await api.model.probeCapabilities(input);
    } catch (err) {
      error.value = messageOf(err);
      return null;
    }
  }

  return {
    available,
    loading,
    error,
    authorization,
    tasks,
    pendingApprovals,
    brokerTargets,
    browserPolicy,
    identityBinding,
    setBrokerTargets,
    setBrowserPolicy,
    unbindIdentity,
    probeModelCapabilities,
    remoteEnabled,
    activeTasks,
    refresh,
    enableRemoteOperation,
    revokeRemoteOperation,
    controlTask,
    resolveApproval,
  };
});
