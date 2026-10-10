import { describe, expect, it, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PermissionSettings from "./PermissionSettings.vue";

/**
 * The permission page, driven through the bridge it is given.
 *
 * Requirement V5 §4.4 and rulings Q2/Q6: the page must go through IPC rather
 * than write state locally, must collect an acknowledgement before enabling the
 * daily preset, must keep the two vision switches separate, and must show the
 * reset's blast radius before applying it.
 */

const POLICY = {
  preset: "BASIC" as const,
  policyVersion: 4,
  presetChangedAt: null,
  remote: { enabled: false, expiresAt: null, revokedAt: null },
  vision: {
    local: { enabled: false, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "vl", expiresAt: null },
    remote: { enabled: false, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "vl", expiresAt: null },
  },
  warning: null,
  counts: { trustedApps: 1, trustedSites: 0, workFolders: 0, taskGrants: 0 },
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const permissions = {
    getPolicy: vi.fn(async () => ({ ...POLICY, ...overrides })),
    setPreset: vi.fn(async () => ({})),
    listTrustedApps: vi.fn(async () => [
      { processName: "notepad", displayName: "记事本", scope: "local", legacy: true },
    ]),
    listTrustedSites: vi.fn(async () => []),
    listTaskGrants: vi.fn(async () => []),
    revokeTrustedApp: vi.fn(async () => ({})),
    revokeTrustedSite: vi.fn(async () => ({})),
    revokeTaskGrant: vi.fn(async () => ({})),
  };
  const vision = { set: vi.fn(async () => ({})), revoke: vi.fn(async () => ({})) };
  const recovery = {
    preview: vi.fn(async () => ({
      token: "4:BASIC:1:0:0:0:0:0:0:0",
      fromPreset: "BASIC",
      toPreset: "BASIC",
      cleared: ["preset"],
      counts: {
        trustedApps: 1,
        trustedSites: 0,
        workFolders: 0,
        taskGrants: 0,
        activeTasks: 2,
        pendingApprovals: 1,
        legacyGrants: 1,
      },
      retained: ["已配置的大模型与 API Key", "微信账号绑定关系"],
    })),
    apply: vi.fn(async () => ({ applied: true, invalidatedApprovals: 1, pausedTasks: 2 })),
  };
  // Attach to the real jsdom window rather than replacing it: replacing it with
  // a plain object breaks event construction for every later `trigger`.
  (window as unknown as { openclaw: unknown }).openclaw = {
    companyClaw: { permissions, vision, recovery },
  };
  return { permissions, vision, recovery };
}

async function mountPage() {
  const wrapper = mount(PermissionSettings, {
    global: {
      stubs: {
        "el-button": { template: "<button @click=\"$emit('click')\"><slot /></button>" },
        // Declaring `emits` matters: without it Vue treats the listener as a
        // native DOM event and tries to construct one from the payload.
        "el-switch": {
          props: ["modelValue"],
          emits: ["change"],
          template: "<input type='checkbox' :checked='modelValue' @change=\"$emit('change', !modelValue)\" />",
        },
        "el-dialog": { template: "<div class='dialog'><slot /><slot name='footer' /></div>" },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe("permission page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The component reads bridge state through the shared store, so the store
    // needs an active Pinia exactly like the real app provides.
    setActivePinia(createPinia());
  });

  it("reports an unavailable bridge instead of implying access is allowed", async () => {
    (window as unknown as { openclaw: unknown }).openclaw = { companyClaw: {} };
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("权限设置不可用");
    expect(wrapper.text()).not.toContain("已启用");
  });

  it("shows the current preset from the main process", async () => {
    installBridge();
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("基础权限");
    expect(wrapper.text()).toContain("全面日常操作");
    expect(wrapper.text()).toContain("高级自定义");
    expect(wrapper.text()).toContain("与 Windows 管理员权限无关");
  });

  it("asks for an acknowledgement before enabling the daily preset", async () => {
    const { permissions } = installBridge();
    const wrapper = await mountPage();
    await wrapper
      .findAll("input[type=radio]")[1]
      .setValue(true)
      .catch(() => undefined);
    await wrapper.vm.$nextTick();
    // The dialog appears; nothing was applied yet.
    expect(permissions.setPreset).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("确认启用");
  });

  it("applies the daily preset with the acknowledgement after confirmation", async () => {
    const { permissions } = installBridge();
    const wrapper = await mountPage();
    const radios = wrapper.findAll("input[type=radio]");
    await radios[1].trigger("change");
    await wrapper.vm.$nextTick();
    const buttons = wrapper.findAll("button").filter((b) => b.text() === "确认启用");
    expect(buttons).toHaveLength(1);
    await buttons[0].trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(permissions.setPreset).toHaveBeenCalledWith({
      preset: "FULL_DAILY",
      acknowledged: true,
    });
  });

  it("keeps the two vision switches separate and off by default", async () => {
    const { vision } = installBridge();
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("允许本地 AI 使用云端视觉");
    expect(wrapper.text()).toContain("允许微信远程 AI 使用云端视觉");
    const switches = wrapper.findAll("input[type=checkbox]");
    expect(switches.length).toBeGreaterThanOrEqual(2);
    // Turning the local one on must not touch the remote one.
    await switches[0].trigger("change");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vision.set).toHaveBeenCalledTimes(1);
    expect(vision.set.mock.calls[0][0]).toMatchObject({ origin: "local" });
  });

  it("shows the reset impact before applying it", async () => {
    const { recovery } = installBridge();
    const wrapper = await mountPage();
    const button = wrapper.findAll("button").find((b) => b.text().includes("一键恢复安全默认值"));
    expect(button).toBeDefined();
    await button!.trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recovery.preview).toHaveBeenCalled();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("暂停正在执行的任务");
    expect(wrapper.text()).toContain("保留");
  });

  it("applies the reset only with the token the preview returned", async () => {
    const { recovery } = installBridge();
    const wrapper = await mountPage();
    const button = wrapper.findAll("button").find((b) => b.text().includes("一键恢复安全默认值"))!;
    await button.trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    const confirm = wrapper.findAll("button").find((b) => b.text() === "确认恢复")!;
    await confirm.trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recovery.apply).toHaveBeenCalledWith({ token: "4:BASIC:1:0:0:0:0:0:0:0" });
  });

  it("labels a migrated legacy grant without treating it as a full grant", async () => {
    installBridge();
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("旧版授权");
    expect(wrapper.text()).toContain("仅本机");
  });
});
