import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useCompanyClawStore } from "./companyclaw";

interface FakeRecord {
  taskId: string;
  state: string;
  objective: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  resultSummary: string | null;
}

function record(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    taskId: "task-1",
    state: "RUNNING",
    objective: "改负责人",
    channel: "openclaw-weixin",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:01:00.000Z",
    terminalAt: null,
    resultSummary: null,
    ...overrides,
  };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getRemoteAuthorization: vi.fn(async () => ({
      state: "disabled",
      ownerSid: "S-1",
      deviceId: "d",
      channelUserId: "",
      grantedAt: null,
      expiresAt: null,
    })),
    setRemoteAuthorization: vi.fn(async () => ({
      state: "enabled",
      ownerSid: "S-1",
      deviceId: "d",
      channelUserId: "wx-1",
      grantedAt: "2026-10-08T00:00:00.000Z",
      expiresAt: "2026-10-08T01:00:00.000Z",
    })),
    tasks: {
      list: vi.fn(async () => [] as FakeRecord[]),
      get: vi.fn(async () => null),
      control: vi.fn(async () => ({ accepted: true, record: record({ state: "CANCELLED" }) })),
    },
    approvals: {
      listPending: vi.fn(async () => []),
      resolve: vi.fn(async () => ({})),
    },
    broker: {
      getTargets: vi.fn(async () => ({ allowedProcesses: [], allowedWindowTitles: [] })),
      setTargets: vi.fn(async (input: { allowedProcesses?: string[] }) => ({
        allowedProcesses: input.allowedProcesses ?? [],
        allowedWindowTitles: [],
      })),
    },
    identity: {
      get: vi.fn(async () => null),
      bind: vi.fn(async () => ({})),
      unbind: vi.fn(async () => undefined),
    },
    model: {
      probeCapabilities: vi.fn(async () => ({
        capabilities: { toolCalls: "supported" },
        summary: "tool calls supported",
      })),
    },
    browser: {
      getPolicy: vi.fn(async () => ({
        allowedDomains: [],
        allowDownloads: false,
        allowUploads: false,
      })),
      setPolicy: vi.fn(
        async (input: {
          allowedDomains?: string[];
          allowDownloads?: boolean;
          allowUploads?: boolean;
        }) => ({
          allowedDomains: input.allowedDomains ?? [],
          allowDownloads: input.allowDownloads === true,
          allowUploads: input.allowUploads === true,
        }),
      ),
    },
    ...overrides,
  };
  (window as unknown as { openclaw: { companyClaw: unknown } }).openclaw = {
    ...((window as unknown as { openclaw?: object }).openclaw ?? {}),
    companyClaw: api,
  };
  return api;
}

describe("useCompanyClawStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("reports the feature as unavailable when the bridge is missing", async () => {
    (window as unknown as { openclaw?: object }).openclaw = {};
    const store = useCompanyClawStore();
    await store.refresh();
    expect(store.available).toBe(false);
    expect(store.tasks).toEqual([]);
  });

  it("loads remote authorization, tasks and pending approvals", async () => {
    installApi({
      tasks: {
        list: vi.fn(async () => [record()]),
        get: vi.fn(async () => null),
        control: vi.fn(),
      },
      approvals: {
        listPending: vi.fn(async () => [
          {
            approvalId: "approval-1",
            status: "pending",
            targetSystem: "工单系统",
            recordId: "WO-1",
            field: "owner",
            oldValue: "李四",
            newValue: "张三",
            requestedAt: "2026-10-08T00:00:00.000Z",
            expiresAt: "2026-10-08T00:05:00.000Z",
          },
        ]),
        resolve: vi.fn(),
      },
    });
    const store = useCompanyClawStore();
    await store.refresh();

    expect(store.available).toBe(true);
    expect(store.authorization?.state).toBe("disabled");
    expect(store.tasks).toHaveLength(1);
    expect(store.pendingApprovals).toHaveLength(1);
    expect(store.error).toBe("");
  });

  it("surfaces an IPC failure without clearing existing data silently", async () => {
    installApi({
      tasks: {
        list: vi.fn(async () => {
          throw new Error("gateway offline");
        }),
        get: vi.fn(),
        control: vi.fn(),
      },
    });
    const store = useCompanyClawStore();
    await store.refresh();
    expect(store.error).toContain("gateway offline");
    expect(store.loading).toBe(false);
  });

  it("grants and revokes remote operation through the bridge", async () => {
    const api = installApi();
    const store = useCompanyClawStore();
    await store.enableRemoteOperation({ ttlMinutes: 60, channelUserId: "wx-1" });
    expect(api.setRemoteAuthorization).toHaveBeenCalledWith({
      enabled: true,
      ttlMinutes: 60,
      channelUserId: "wx-1",
    });
    expect(store.authorization?.state).toBe("enabled");

    await store.revokeRemoteOperation();
    expect(api.setRemoteAuthorization).toHaveBeenLastCalledWith({ enabled: false });
  });

  it("sends a task control and refreshes the list", async () => {
    const list = vi.fn(async () => [record()]);
    const api = installApi({
      tasks: { list, get: vi.fn(), control: vi.fn(async () => ({ accepted: true, record: record() })) },
    });
    const store = useCompanyClawStore();
    await store.controlTask("task-1", "pause");
    expect(api.tasks.control).toHaveBeenCalledWith({ taskId: "task-1", control: "pause" });
    expect(list).toHaveBeenCalled();
  });

  it("reports a rejected control without throwing", async () => {
    installApi({
      tasks: {
        list: vi.fn(async () => []),
        get: vi.fn(),
        control: vi.fn(async () => ({ accepted: false, record: null, reason: "not legal from COMPLETED" })),
      },
    });
    const store = useCompanyClawStore();
    const result = await store.controlTask("task-1", "cancel");
    expect(result.accepted).toBe(false);
    expect(store.error).toContain("not legal from COMPLETED");
  });

  it("resolves an approval and clears it from the pending list", async () => {
    const listPending = vi.fn(async () => []);
    const api = installApi({
      approvals: { listPending, resolve: vi.fn(async () => ({})) },
    });
    const store = useCompanyClawStore();
    await store.resolveApproval("approval-1", "approved");
    expect(api.approvals.resolve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      decision: "approved",
    });
    expect(store.pendingApprovals).toEqual([]);
  });

  it("starts with an empty broker allow list", async () => {
    installApi();
    const store = useCompanyClawStore();
    await store.refresh();
    expect(store.brokerTargets.allowedProcesses).toEqual([]);
  });

  it("reports no identity binding on a fresh install", async () => {
    installApi();
    const store = useCompanyClawStore();
    await store.refresh();
    expect(store.identityBinding).toBeNull();
  });

  it("clears the binding after an unbind", async () => {
    const api = installApi({
      identity: {
        get: vi.fn(async () => ({
          ownerSid: "S-1",
          deviceId: "d",
          channelType: "openclaw-weixin",
          channelUserId: "wx-1",
          boundAt: "2026-10-09T00:00:00.000Z",
        })),
        bind: vi.fn(),
        unbind: vi.fn(async () => undefined),
      },
    });
    const store = useCompanyClawStore();
    await store.refresh();
    expect(store.identityBinding?.channelUserId).toBe("wx-1");
    await store.unbindIdentity();
    expect(store.identityBinding).toBeNull();
    expect(api.identity.unbind).toHaveBeenCalled();
  });

  it("starts with no browser domains allowed", async () => {
    installApi();
    const store = useCompanyClawStore();
    await store.refresh();
    expect(store.browserPolicy.allowedDomains).toEqual([]);
    expect(store.browserPolicy.allowDownloads).toBe(false);
  });

  it("saves a browser policy through the bridge", async () => {
    installApi();
    const store = useCompanyClawStore();
    await store.setBrowserPolicy({
      allowedDomains: ["oa.example.com"],
      allowDownloads: true,
      allowUploads: false,
    });
    expect(store.browserPolicy.allowedDomains).toEqual(["oa.example.com"]);
    expect(store.browserPolicy.allowDownloads).toBe(true);
  });

  it("saves an allow list through the bridge", async () => {
    installApi();
    const store = useCompanyClawStore();
    await store.setBrokerTargets({ allowedProcesses: ["notepad"], allowedWindowTitles: [] });
    expect(store.brokerTargets.allowedProcesses).toEqual(["notepad"]);
  });

  it("keeps the enabled state visible when the grant has an expiry", async () => {
    installApi();
    const store = useCompanyClawStore();
    await store.enableRemoteOperation({ ttlMinutes: 30 });
    expect(store.authorization?.expiresAt).toBe("2026-10-08T01:00:00.000Z");
  });
});
