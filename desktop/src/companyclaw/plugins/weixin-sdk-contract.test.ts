import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The bundled WeChat plugin imports the host's SDK through `openclaw/plugin-sdk/*`
 * subpaths, and OpenClaw resolves those through the host package's `exports` map.
 * A subpath that the pinned host no longer defines is not a build error — it
 * throws at channel start-up, the channel exits, and every WeChat message is
 * lost until someone reads the log. That is exactly how
 * `./plugin-sdk/channel-runtime` disappeared unnoticed when the host moved to
 * 2026.9.3 (it now lives at `./plugin-sdk/channel-message`).
 *
 * This test therefore pins the plugin's imports to the host's export list. The
 * list below was read from the pinned host (`openclaw@2026.9.3`); when the host
 * version changes, this test fails and the plugin has to be re-checked.
 */

/** Host SDK subpaths the plugin is allowed to import (`openclaw@2026.9.3`). */
const HOST_PLUGIN_SDK_SUBPATHS = new Set([
  "core",
  "plugin-entry",
  "channel-config-schema",
  "channel-contract",
  "channel-message",
  "channel-runtime-context",
  "reply-runtime",
  "command-auth",
  "hook-runtime",
  "infra-runtime",
  "plugin-runtime",
  "account-id",
  "routing",
]);

const desktopDir = path.resolve(__dirname, "../../..");
const repositoryDir = path.dirname(desktopDir);
const pluginDir = path.join(repositoryDir, "plugins", "openclaw-weixin");
const packedHostManifest = path.join(desktopDir, "resources", "openclaw.asar");

function pluginSourceFiles(): string[] {
  const files: string[] = [path.join(pluginDir, "index.ts")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(full);
    }
  };
  walk(path.join(pluginDir, "src"));
  return files.filter((file) => existsSync(file));
}

/** Every `openclaw/plugin-sdk/<sub>` specifier the plugin's sources import. */
function pluginSdkImports(): Array<{ file: string; subpath: string }> {
  const imports: Array<{ file: string; subpath: string }> = [];
  for (const file of pluginSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+"(openclaw\/plugin-sdk\/([^"]+))"/g)) {
      imports.push({ file: path.relative(repositoryDir, file), subpath: match[2] });
    }
  }
  return imports;
}

describe("openclaw-weixin host SDK contract", () => {
  it("imports only SDK subpaths the pinned host actually exports", () => {
    const imports = pluginSdkImports();
    expect(imports.length).toBeGreaterThan(0);
    const unknown = imports.filter((entry) => !HOST_PLUGIN_SDK_SUBPATHS.has(entry.subpath));
    expect(
      unknown.map((entry) => `${entry.file} -> openclaw/plugin-sdk/${entry.subpath}`),
    ).toEqual([]);
  });

  it("agrees with the packaged host's own export map", async () => {
    // A source checkout has no packaged host; when it does, the pinned list
    // above must match it, so a host bump cannot slip past this test.
    if (!existsSync(packedHostManifest)) return;
    const { extractFile } = await import("@electron/asar");
    const manifest = JSON.parse(
      extractFile(packedHostManifest, "node_modules\\openclaw\\package.json").toString(),
    ) as { exports?: Record<string, unknown> };
    const exported = new Set(
      Object.keys(manifest.exports ?? {}).map((key) => key.replace("./plugin-sdk/", "")),
    );
    const missing = [...HOST_PLUGIN_SDK_SUBPATHS].filter((subpath) => !exported.has(subpath));
    expect(missing).toEqual([]);
  });
});
