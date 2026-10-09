import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
/**
 * Records which payload version is installed, so a fixed plugin can replace a
 * broken copy that is already on disk.
 */
export const WEIXIN_PLUGIN_PAYLOAD_FILE = ".companyclaw-payload.json";
export const WEIXIN_PLUGIN_PAYLOAD_CONTRACT = "companyclaw.weixin-payload.v1";
const INSTALL_TIMEOUT_MS = 120_000;

export type WeixinPluginInstallOutcome =
  | {
      ok: true;
      state: "installed" | "refreshed" | "already-present" | "skipped";
      detail?: string;
    }
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
 * Fingerprint of the code the installer would put on disk.
 *
 * Covers `package.json` plus every file under `dist/`, which is the code the
 * host actually loads. `node_modules` is excluded on purpose: the payload's
 * dependencies never change per fix, and hashing them would make dev and
 * packaged layouts differ for no reason. A missing or unreadable payload
 * returns null, which the caller treats as "cannot prove it is current".
 */
export function weixinPluginPayloadFingerprint(pluginDir: string): string | null {
  try {
    const files: string[] = ["package.json"];
    const distDir = path.join(pluginDir, "dist");
    if (!fs.existsSync(path.join(pluginDir, "package.json"))) return null;
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const relative = prefix ? `${prefix}/${entry}` : entry;
        if (fs.statSync(full).isDirectory()) {
          walk(full, relative);
          continue;
        }
        files.push(`dist/${relative}`);
      }
    };
    if (fs.existsSync(distDir)) walk(distDir, "");
    const hash = createHash("sha256");
    for (const relative of files.sort()) {
      hash.update(relative);
      hash.update("\0");
      hash.update(fs.readFileSync(path.join(pluginDir, relative)));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** Reads the payload fingerprint recorded for an installed copy. */
function readInstalledPayloadFingerprint(stateDir: string): string | null {
  try {
    const filePath = path.join(
      stateDir,
      "extensions",
      WEIXIN_PLUGIN_ID,
      WEIXIN_PLUGIN_PAYLOAD_FILE,
    );
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (parsed?.contract !== WEIXIN_PLUGIN_PAYLOAD_CONTRACT) return null;
    return typeof parsed.fingerprint === "string" && parsed.fingerprint ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}

function writeInstalledPayloadFingerprint(stateDir: string, fingerprint: string): void {
  const filePath = path.join(stateDir, "extensions", WEIXIN_PLUGIN_ID, WEIXIN_PLUGIN_PAYLOAD_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ contract: WEIXIN_PLUGIN_PAYLOAD_CONTRACT, fingerprint }, null, 2)}\n`,
    "utf-8",
  );
}

/**
 * Reconciles the packaged plugin with the OpenClaw state directory.
 *
 * An already-installed copy is only left alone when its recorded payload
 * fingerprint matches the payload being shipped. That check is the difference
 * between "a fixed plugin never reaches the employee machine" and a working
 * WeChat channel: a copy installed from an older build looks installed either
 * way, and the host keeps loading code this build has already replaced.
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
  const payloadFingerprint = weixinPluginPayloadFingerprint(pluginDir);
  const installed = weixinPluginInstalled(input.stateDir);
  const installedFingerprint = installed ? readInstalledPayloadFingerprint(input.stateDir) : null;
  if (installed && payloadFingerprint && installedFingerprint === payloadFingerprint) {
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
  // Recorded only after a successful install: an unrecorded payload is treated
  // as stale next launch, which repairs a half-finished copy instead of
  // trusting it.
  if (payloadFingerprint) {
    try {
      writeInstalledPayloadFingerprint(input.stateDir, payloadFingerprint);
    } catch (error) {
      console.warn("[companyclaw] Cannot record the WeChat plugin payload fingerprint:", error);
    }
  }
  return { ok: true, state: installed ? "refreshed" : "installed" };
}
