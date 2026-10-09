import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Installs the bundled WeChat plugin into the OpenClaw state directory.
 *
 * The installer package ships the plugin as a payload resource, but OpenClaw
 * only loads plugins from `<stateDir>/extensions/`. Without this step a packaged
 * build reports `installed: false` forever and the employee cannot scan the QR
 * code at all — the legacy Python installer did this, the Electron package
 * never did.
 *
 * Development runs use the same path with the repository's compiled staging
 * directory (`desktop/resources/openclaw-weixin`), so the dev and packaged
 * layouts stay identical; the state directory is this application's own
 * (`<userData>/openclaw-state`), not a separately installed OpenClaw's.
 *
 * The plugin is registered through OpenClaw's own `plugins install` so the
 * host records `plugins.installs` in its own format. Nothing is downloaded
 * here: the payload already carries the compiled plugin and its dependencies.
 */

export const WEIXIN_PLUGIN_ID = "openclaw-weixin";
/** Directory name inside `<resources>` that carries the staged plugin. */
export const WEIXIN_PLUGIN_RESOURCE_DIR = "openclaw-weixin";
const INSTALL_TIMEOUT_MS = 120_000;

export type WeixinPluginInstallOutcome =
  | { ok: true; state: "installed" | "already-present" | "skipped"; detail?: string }
  | { ok: false; reason: string; detail?: string };

export interface WeixinPluginInstallInput {
  /** Directory holding the plugin to install (packaged payload or dev staging). */
  pluginSourceDir: string;
  nodePath: string | null;
  openClawEntry: string | null;
  stateDir: string;
  /** Injected so tests can drive the CLI without spawning a process. */
  runCli?: (args: string[]) => { status: number | null; output: string };
}

/**
 * Adds the plugin to `plugins.entries` and `plugins.allow`.
 *
 * Shared with the existing `plugin:weixin:set-enabled` handler so the enable
 * rules exist once: an enable has to reach both keys or the Gateway loads the
 * plugin asynchronously (or not at all).
 */
export function planWeixinPluginEnable(
  config: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  const plugins =
    typeof next.plugins === "object" && next.plugins !== null && !Array.isArray(next.plugins)
      ? { ...(next.plugins as Record<string, unknown>) }
      : {};
  const entries =
    typeof plugins.entries === "object" &&
    plugins.entries !== null &&
    !Array.isArray(plugins.entries)
      ? { ...(plugins.entries as Record<string, unknown>) }
      : {};
  const current =
    typeof entries[WEIXIN_PLUGIN_ID] === "object" &&
    entries[WEIXIN_PLUGIN_ID] !== null &&
    !Array.isArray(entries[WEIXIN_PLUGIN_ID])
      ? { ...(entries[WEIXIN_PLUGIN_ID] as Record<string, unknown>) }
      : {};
  current.enabled = enabled;
  entries[WEIXIN_PLUGIN_ID] = current;
  plugins.entries = entries;

  const allow = Array.isArray(plugins.allow) ? [...(plugins.allow as unknown[])] : [];
  if (enabled && !allow.includes(WEIXIN_PLUGIN_ID)) allow.push(WEIXIN_PLUGIN_ID);
  plugins.allow = allow;

  next.plugins = plugins;
  return next;
}

/** True when the host already has this plugin's directory on disk. */
export function weixinPluginInstalled(stateDir: string): boolean {
  return fs.existsSync(path.join(stateDir, "extensions", WEIXIN_PLUGIN_ID, "package.json"));
}

/**
 * Reconciles the packaged plugin with the OpenClaw state directory.
 *
 * Failures are reported, never swallowed: a plugin that cannot be installed is
 * the difference between "the employee scans a QR code" and "nothing works".
 */
export function ensureWeixinPluginInstalled(
  input: WeixinPluginInstallInput,
): WeixinPluginInstallOutcome {
  const pluginDir = input.pluginSourceDir;
  if (!fs.existsSync(path.join(pluginDir, "package.json"))) {
    return {
      ok: false,
      reason: "PLUGIN_RESOURCE_MISSING",
      detail: pluginDir,
    };
  }
  if (weixinPluginInstalled(input.stateDir)) {
    return { ok: true, state: "already-present" };
  }
  if (!input.nodePath || !input.openClawEntry) {
    return { ok: false, reason: "PLUGIN_INSTALL_UNAVAILABLE", detail: "missing OpenClaw entry" };
  }

  const run =
    input.runCli ??
    ((args: string[]) => {
      const result = spawnSync(input.nodePath as string, [input.openClawEntry as string, ...args], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: INSTALL_TIMEOUT_MS,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: input.stateDir,
          NODE_COMPILE_CACHE: path.join(input.stateDir, "compile-cache"),
        },
      });
      return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
      };
    });

  // The host asks for capability consent on first install. This payload is the
  // application's own bundled plugin (covered by the installer's runtime
  // manifest), so the install acknowledges those capabilities explicitly.
  const result = run(["plugins", "install", "--force", "--accept-capabilities", pluginDir]);
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "PLUGIN_INSTALL_FAILED",
      detail: result.output.slice(0, 400) || `exit ${result.status}`,
    };
  }
  return { ok: true, state: "installed" };
}
