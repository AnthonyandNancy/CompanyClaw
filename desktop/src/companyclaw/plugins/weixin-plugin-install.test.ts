import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureWeixinPluginInstalled,
  planWeixinPluginEnable,
  WEIXIN_PLUGIN_ID,
  WEIXIN_PLUGIN_PAYLOAD_CONTRACT,
  WEIXIN_PLUGIN_PAYLOAD_FILE,
  weixinPluginInstalled,
  weixinPluginPayloadFingerprint,
} from "./weixin-plugin-install";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companyclaw-plugin-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * Copies a staged payload into the state directory the way a successful
 * `plugins install` leaves it, fingerprint record included.
 */
function installPayloadCopy(pluginDir: string, stateDir: string): void {
  const installedDir = path.join(stateDir, "extensions", WEIXIN_PLUGIN_ID);
  fs.mkdirSync(installedDir, { recursive: true });
  fs.cpSync(pluginDir, installedDir, { recursive: true });
  const fingerprint = weixinPluginPayloadFingerprint(pluginDir);
  fs.writeFileSync(
    path.join(installedDir, WEIXIN_PLUGIN_PAYLOAD_FILE),
    `${JSON.stringify({ contract: WEIXIN_PLUGIN_PAYLOAD_CONTRACT, fingerprint }, null, 2)}\n`,
    "utf8",
  );
}

/** Lays out the resources directory as the installer ships it. */
function stagedResources(root: string): string {
  const resourcesPath = path.join(root, "resources");
  const pluginDir = path.join(resourcesPath, "openclaw-weixin");
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), '{"version":"2.4.6"}\n', "utf8");
  fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "// plugin\n", "utf8");
  return resourcesPath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ensureWeixinPluginInstalled", () => {
  it("reports a missing payload instead of installing nothing", () => {
    const root = temporaryRoot();
    const runCli = vi.fn();
    const outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: path.join(root, "resources", "openclaw-weixin"),
      nodePath: "C:/node/node.exe",
      openClawEntry: "C:/node/openclaw.mjs",
      stateDir: root,
      runCli,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("PLUGIN_RESOURCE_MISSING");
    expect(runCli).not.toHaveBeenCalled();
  });

  it("installs the staged plugin through OpenClaw", () => {
    const root = temporaryRoot();
    const resourcesPath = stagedResources(root);
    const stateDir = path.join(root, "state");
    const calls: string[][] = [];
    const outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: path.join(resourcesPath, "openclaw-weixin"),
      nodePath: "C:/node/node.exe",
      openClawEntry: "C:/node/openclaw.mjs",
      stateDir,
      runCli: (args) => {
        calls.push(args);
        return { status: 0, output: "installed" };
      },
    });
    expect(outcome).toEqual({ ok: true, state: "installed" });
    // The host is asked to install the staged directory itself; nothing is
    // fetched from a registry on an employee machine. Capability consent is
    // acknowledged because the payload is this application's own plugin.
    expect(calls).toEqual([
      [
        "plugins",
        "install",
        "--force",
        "--accept-capabilities",
        path.join(resourcesPath, "openclaw-weixin"),
      ],
    ]);
  });

  it("skips a copy that is already installed from this exact payload", () => {
    const root = temporaryRoot();
    const resourcesPath = stagedResources(root);
    const stateDir = path.join(root, "state");
    const pluginDir = path.join(resourcesPath, "openclaw-weixin");
    installPayloadCopy(pluginDir, stateDir);
    const runCli = vi.fn();
    const outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: pluginDir,
      nodePath: "C:/node/node.exe",
      openClawEntry: "C:/node/openclaw.mjs",
      stateDir,
      runCli,
    });
    expect(outcome).toEqual({ ok: true, state: "already-present" });
    // Reinstalling on every launch would be slow and could disturb a bound
    // account, so an unchanged payload is left alone.
    expect(runCli).not.toHaveBeenCalled();
    expect(weixinPluginInstalled(stateDir)).toBe(true);
  });

  it("replaces an installed copy whose payload is older than the shipped one", () => {
    const root = temporaryRoot();
    const resourcesPath = stagedResources(root);
    const stateDir = path.join(root, "state");
    const pluginDir = path.join(resourcesPath, "openclaw-weixin");
    installPayloadCopy(pluginDir, stateDir);
    // The shipped payload changes: a fixed dist file is what a rebuilt plugin
    // looks like on disk.
    fs.writeFileSync(
      path.join(pluginDir, "dist", "index.js"),
      '// plugin, fixed for openclaw 2026.9.3\n',
      "utf8",
    );
    const calls: string[][] = [];
    const outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: pluginDir,
      nodePath: "C:/node/node.exe",
      openClawEntry: "C:/node/openclaw.mjs",
      stateDir,
      runCli: (args) => {
        calls.push(args);
        return { status: 0, output: "installed" };
      },
    });
    expect(outcome).toEqual({ ok: true, state: "refreshed" });
    expect(calls).toEqual([
      ["plugins", "install", "--force", "--accept-capabilities", pluginDir],
    ]);
    // The new fingerprint is recorded, so the next launch does not reinstall.
    const second = ensureWeixinPluginInstalled({
      pluginSourceDir: pluginDir,
      nodePath: "C:/node/node.exe",
      openClawEntry: "C:/node/openclaw.mjs",
      stateDir,
      runCli: () => {
        throw new Error("must not reinstall an unchanged payload");
      },
    });
    expect(second).toEqual({ ok: true, state: "already-present" });
  });

  it("repairs an installed copy that carries no payload record", () => {
    // This is the shape left behind by builds that predate the fingerprint: the
    // directory exists, so it used to be trusted forever.
    const root = temporaryRoot();
    const resourcesPath = stagedResources(root);
    const stateDir = path.join(root, "state");
    fs.mkdirSync(path.join(stateDir, "extensions", WEIXIN_PLUGIN_ID), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "extensions", WEIXIN_PLUGIN_ID, "package.json"),
      "{}\n",
      "utf8",
    );
    const runCli = vi.fn(() => ({ status: 0 as number | null, output: "installed" }));
    const outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: path.join(resourcesPath, "openclaw-weixin"),
      nodePath: "C:/node/node.exe",
      openClawEntry: "C:/node/openclaw.mjs",
      stateDir,
      runCli,
    });
    expect(outcome).toEqual({ ok: true, state: "refreshed" });
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it("reports a failing installation with its output", () => {
    const root = temporaryRoot();
    const resourcesPath = stagedResources(root);
    const outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: path.join(resourcesPath, "openclaw-weixin"),
      nodePath: "C:/node/node.exe",
      openClawEntry: "C:/node/openclaw.mjs",
      stateDir: path.join(root, "state"),
      runCli: () => ({ status: 1, output: "cannot resolve peer dependency openclaw" }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("PLUGIN_INSTALL_FAILED");
    expect(outcome.detail).toContain("peer dependency");
  });

  it("reports an unusable runtime rather than trying to install", () => {
    const root = temporaryRoot();
    const resourcesPath = stagedResources(root);
    const runCli = vi.fn();
    const outcome = ensureWeixinPluginInstalled({
      pluginSourceDir: path.join(resourcesPath, "openclaw-weixin"),
      nodePath: null,
      openClawEntry: null,
      stateDir: path.join(root, "state"),
      runCli,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("PLUGIN_INSTALL_UNAVAILABLE");
    expect(runCli).not.toHaveBeenCalled();
  });
});

describe("planWeixinPluginEnable", () => {
  it("enables the plugin and allows it to load synchronously", () => {
    const planned = planWeixinPluginEnable({}, true);
    const plugins = planned.plugins as {
      entries: Record<string, { enabled: boolean }>;
      allow: string[];
    };
    expect(plugins.entries[WEIXIN_PLUGIN_ID].enabled).toBe(true);
    expect(plugins.allow).toContain(WEIXIN_PLUGIN_ID);
  });

  it("disables the plugin without leaving it on the allow list twice", () => {
    const first = planWeixinPluginEnable({}, true);
    const allowed = (first.plugins as { allow: string[] }).allow;
    const second = planWeixinPluginEnable(first, true);
    expect((second.plugins as { allow: string[] }).allow).toEqual(allowed);

    const disabled = planWeixinPluginEnable(second, false);
    const plugins = disabled.plugins as {
      entries: Record<string, { enabled: boolean }>;
      allow: string[];
    };
    expect(plugins.entries[WEIXIN_PLUGIN_ID].enabled).toBe(false);
    // Turning it off must not disturb an allow list the user configured.
    expect(plugins.allow).toEqual(allowed);
  });

  it("preserves unrelated plugin configuration", () => {
    const existing = {
      plugins: {
        entries: { "other-plugin": { enabled: true } },
        allow: ["other-plugin"],
      },
      gateway: { port: 18789 },
    };
    const planned = planWeixinPluginEnable(existing, true);
    expect((planned as { gateway: { port: number } }).gateway.port).toBe(18789);
    const plugins = planned.plugins as { allow: string[]; entries: Record<string, unknown> };
    expect(plugins.allow).toEqual(["other-plugin", WEIXIN_PLUGIN_ID]);
    expect(plugins.entries["other-plugin"]).toEqual({ enabled: true });
  });

  it("repairs a malformed plugins section instead of throwing", () => {
    const planned = planWeixinPluginEnable({ plugins: "not-an-object" }, true);
    const plugins = planned.plugins as { entries: Record<string, { enabled: boolean }> };
    expect(plugins.entries[WEIXIN_PLUGIN_ID].enabled).toBe(true);
  });
});
