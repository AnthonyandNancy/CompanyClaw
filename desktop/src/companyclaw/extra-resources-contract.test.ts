import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `extraResources` decides what actually ships inside the installer, and
 * electron-builder silently skips a `from` that does not exist. That is how the
 * broker ended up missing from the package while `resources/openclaw/` — a
 * directory the pipeline creates and then deletes — stayed listed.
 *
 * Sources therefore have to be classified explicitly:
 *
 *  1. produced by the unified pipeline (`npm run release:win`),
 *  2. produced by a build step that runs before electron-builder
 *     (`build.ps1` publishes the AppContainer launcher into bin/),
 *  3. present in a plain source checkout.
 *
 * Only group 3 can be asserted against the filesystem here.
 */
const desktopDir = path.resolve(__dirname, "../..");

const PRODUCED_BY_PIPELINE = [
  "resources/node.exe",
  "resources/openclaw.asar",
  // Declared as two explicit subdirectories rather than the whole broker
  // directory, so nothing stray can ride along into the installer.
  "resources/companyclaw-broker/dist/",
  "resources/companyclaw-broker/scripts/",
  "resources/windows-node/",
  "resources/runtime-manifest.json",
  // The WeChat plugin is compiled from this repository's sources (the vendored
  // tarball's own dist/ predates the CompanyClaw bridge) and the agent skills
  // are collected from `skills/`; both are staged so the manifest can cover
  // them. Shipping either straight from the source tree would leave the
  // packaged copy outside the startup integrity check.
  "resources/openclaw-weixin/",
  "resources/agent-skills/",
];

const PRODUCED_BY_BUILD = [
  // Emitted by `npm run build` (tsc) before electron-builder runs.
  "dist/github-copilot-auth-worker.js",
  "../appcontainer/bin/Release/net9.0-windows/win-x64/AppContainerLauncher.exe",
];

const PRESENT_IN_SOURCE = [
  "src/openclaw-approval-replay-compat.mjs",
  "../appcontainer/sandbox-preload.js",
  "../appcontainer/sandbox-state.js",
  "../appcontainer/sandbox-permission.js",
  "../appcontainer/sandbox-fs-hooks.js",
  "../appcontainer/sandbox-cp-hooks.js",
  "../appcontainer/sandbox-sensitive.js",
  "../appcontainer/path-extraction.js",
];

function extraResourceSources(): string[] {
  const config = readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf-8");
  return config
    .split("\n")
    .map((line) => line.match(/^\s*-\s*from:\s*(.+?)\s*$/)?.[1])
    .filter((value): value is string => typeof value === "string");
}

describe("installer extraResources contract", () => {
  it("declares every source the unified pipeline produces", () => {
    const sources = extraResourceSources();
    for (const produced of PRODUCED_BY_PIPELINE) {
      expect(sources, `pipeline output not shipped: ${produced}`).toContain(produced);
    }
  });

  it("keeps the sources that exist in a plain source checkout", () => {
    const sources = extraResourceSources();
    for (const required of PRESENT_IN_SOURCE) {
      expect(sources, `source not shipped: ${required}`).toContain(required);
      expect(
        existsSync(path.resolve(desktopDir, required)),
        `declared source is missing from the checkout: ${required}`,
      ).toBe(true);
    }
  });

  it("ships the AppContainer launcher that the build publishes", () => {
    const sources = extraResourceSources();
    for (const built of PRODUCED_BY_BUILD) {
      expect(sources, `build output not shipped: ${built}`).toContain(built);
    }
  });

  it("never points at a directory the pipeline deletes", () => {
    // The unpacked OpenClaw tree is created and then removed while building the
    // archive; bundled-runtime.ts reads openclaw.asar instead.
    expect(extraResourceSources()).not.toContain("resources/openclaw/");
  });

  it("ships the broker so a packaged app can start it", () => {
    const sources = extraResourceSources();
    expect(sources.some((source) => source.startsWith("resources/companyclaw-broker"))).toBe(true);
  });

  it("accounts for every declared source in one of the three groups", () => {
    const known = new Set([...PRODUCED_BY_PIPELINE, ...PRODUCED_BY_BUILD, ...PRESENT_IN_SOURCE]);
    const unknown = extraResourceSources().filter((source) => !known.has(source));
    // An unrecognised source is not automatically wrong, but it has to be added
    // to one of the lists so that its existence story is explicit.
    expect(unknown, `unclassified extraResources sources: ${unknown.join(", ")}`).toEqual([]);
  });
});
