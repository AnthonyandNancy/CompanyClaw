import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The employee artifact is produced by `npm run release:win`, so that command
 * has to assemble every runtime component itself. Historically `dist` only ran
 * the Windows Node preparation and relied on `desktop/resources/` happening to
 * exist on the build machine — which it never does in a clean checkout.
 */
const desktopDir = path.resolve(__dirname, "../..");

function read(relative: string): string {
  return readFileSync(path.join(desktopDir, relative), "utf-8");
}

describe("unified production resource pipeline", () => {
  const script = read("scripts/prepare-production-resources.mjs");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("is the entry point used by the official release command", () => {
    expect(pkg.scripts["prepare-production-resources"]).toContain(
      "scripts/prepare-production-resources.mjs",
    );
    expect(pkg.scripts.dist).toBe("npm run release:win");
    expect(pkg.scripts["release:win"]).toContain("prepare-production-resources");
    expect(pkg.scripts["release:win"]).toContain("electron-builder --win");
  });

  it("stages every runtime component the installer must carry", () => {
    for (const produced of [
      "node.exe",
      "openclaw.asar",
      "companyclaw-broker",
      "runtime-manifest.json",
      // The employee machine has no npm, so the patched plugin, its runtime
      // dependencies and every catalog skill are assembled here.
      "openclaw-weixin",
      "agent-skills",
    ]) {
      expect(script).toContain(produced);
    }
    expect(script).toContain("prepare-windows-node-resources.mjs");
  });

  it("refuses to ship a plugin or skill that is incomplete", () => {
    // These checks are what make a half-assembled payload fail the build
    // instead of reaching an employee.
    for (const required of [
      "openclaw.plugin.json",
      "dist/index.js",
      "dist/src/messaging/desktop-bridge.js",
      "SKILL.md",
    ]) {
      expect(script).toContain(required);
    }
    // The plugin's dist/ imports zod and qrcode-terminal at runtime; a payload
    // without them still builds, and only fails on the employee machine, where
    // no npm exists to install them.
    expect(script).toContain("WeChat plugin staging is missing dependency");
  });

  it("compiles the plugin from this repository instead of trusting the tarball", () => {
    // The vendored tarball ships its own dist/, built from Tencent's sources and
    // therefore without desktop-bridge.ts. Publishing it would silently drop
    // the approval channel, so the pipeline recompiles it and stays offline.
    expect(script).toContain("typescript");
    expect(script).toContain("--omit=peer");
    expect(script).toContain("--legacy-peer-deps");
    expect(script).toContain("vendor");
    // Without `--offline`, npm silently falls back to the registry when a
    // vendored tarball is missing or out of range (a renamed zod tarball pulled
    // zod 4.6.5 instead of the vendored 4.4.3), so the same product version
    // could ship different dependency code from different build machines.
    expect(script).toContain("--offline");
    // `--offline` only blocks the network, not npm's local cache: a renamed
    // vendored tarball still installed a cached zod 4.6.5. The vendored
    // tarballs are therefore checked up front, which is deterministic.
    expect(script).toContain("No vendored tarball for plugin dependency");
  });

  it("keeps the staged skills aligned with the product catalog", () => {
    // The offered skill list must not be duplicated into the build script: a
    // skill added to the catalog has to reach the installer automatically.
    expect(script).toContain("agent-catalog.ts");
    expect(script).toContain("SHARED_SKILL_IDS");
    expect(script).toContain("AGENT_OWNED_SKILL_IDS");
  });

  it("never deletes the live resources directory outright", () => {
    // Interrupting the pipeline must not leave a half-empty resources folder:
    // the previous build stays usable until the new one is fully staged.
    expect(script).not.toMatch(/rmSync\(\s*resourcesDir/);
    expect(script).toContain("staging");
  });

  it("keeps the version true source in the deployer", () => {
    expect(script).toContain("openclaw_version.py");
    expect(script).toContain("OPENCLAW_TARGET_VERSION");
  });
});
