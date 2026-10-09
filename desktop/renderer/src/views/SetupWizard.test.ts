import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import SetupWizard from "./SetupWizard.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

/** The wizard is registered against the full UI kit in `main.ts`. */
function mountWizard() {
  return mount(SetupWizard, {
    global: { plugins: [createPinia(), ElementPlus] },
  });
}

/**
 * The first-run wizard is the only screen an employee sees before the product
 * works, and it must never send them to a terminal or a JSON file. These cases
 * pin the four steps and the two safety-relevant defaults: remote operation is
 * off until the owner turns it on, and an unreachable bridge reads as
 * "cannot check" rather than "healthy".
 */
describe("SetupWizard", () => {
  const needsSetup = vi.fn();
  const readEnv = vi.fn();
  const readConfig = vi.fn();
  const getRemoteAuthorization = vi.fn();
  const setRemoteAuthorization = vi.fn();
  const getWeixinStatus = vi.fn();
  const healthReport = vi.fn();

  function installBridge(): void {
    (window as unknown as { openclaw: unknown }).openclaw = {
      config: { needsSetup, readEnv, read: readConfig },
      plugin: { weixin: { getStatus: getWeixinStatus } },
      companyClaw: {
        getRemoteAuthorization,
        setRemoteAuthorization,
        health: { report: healthReport },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    setLocale("zh-CN");
    needsSetup.mockResolvedValue(true);
    readEnv.mockResolvedValue({});
    readConfig.mockResolvedValue({});
    getRemoteAuthorization.mockResolvedValue({ state: "disabled" });
    getWeixinStatus.mockResolvedValue({ installed: true, enabled: true, loggedIn: false });
    healthReport.mockResolvedValue({
      overall: "ok",
      items: [{ id: "runtime-manifest", state: "ok", detail: "运行资源完整（已校验 3 项）" }],
    });
    installBridge();
  });

  it("shows the four numbered steps and no CLI instruction", async () => {
    const wrapper = mountWizard();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain("1. 环境自检");
    expect(text).toContain("2. 我的模型");
    expect(text).toContain("3. 绑定微信");
    expect(text).toContain("4. 开启远程操作");
    // An employee must never be told to run a command or edit a file.
    expect(text).not.toMatch(/npm|PowerShell|\.json|命令行/);
  });

  it("reports the local runtime from the main process", async () => {
    const wrapper = mountWizard();
    await flushPromises();
    expect(wrapper.text()).toContain("本地运行环境已就绪");
    expect(wrapper.text()).toContain("运行资源完整（已校验 3 项）");
  });

  it("says the check is unavailable instead of pretending it passed", async () => {
    healthReport.mockRejectedValue(new Error("no bridge"));
    const wrapper = mountWizard();
    await flushPromises();
    expect(wrapper.text()).toContain("当前环境不支持环境自检");
    expect(wrapper.text()).not.toContain("本地运行环境已就绪");
  });

  it("keeps remote operation off until it is turned on", async () => {
    const wrapper = mountWizard();
    await flushPromises();
    expect(wrapper.text()).toContain("默认关闭");

    setRemoteAuthorization.mockResolvedValue({ state: "enabled" });
    const enableButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("开启远程操作"));
    expect(enableButton).toBeDefined();
    // Not bound to WeChat yet, so enabling is not offered.
    expect(enableButton?.attributes("disabled")).toBeDefined();
  });

  it("allows enabling once WeChat is bound and reflects the result", async () => {
    getWeixinStatus.mockResolvedValue({ installed: true, enabled: true, loggedIn: true });
    const wrapper = mountWizard();
    await flushPromises();

    const enableButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("开启远程操作"));
    await enableButton?.trigger("click");
    await flushPromises();

    expect(setRemoteAuthorization).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(wrapper.text()).toContain("远程操作已开启");
  });

  it("keeps the WeChat binding entry point in step 3", async () => {
    const wrapper = mountWizard();
    await flushPromises();
    const bindButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("绑定微信"));
    await bindButton?.trigger("click");
    expect(push).toHaveBeenCalledWith("/settings/channels");
  });
});
