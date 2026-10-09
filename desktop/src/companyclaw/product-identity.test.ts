import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CompanyClaw must ship as its own product identity, not as MicroClaw.
 * Requirement V1.1 (P1 企业版壳) requires an independent application name,
 * package id and user-data directory.
 *
 * These assertions deliberately pin the *product* identity only. Paths inside
 * the app (state dir ~/.openclaw, AppContainer profile MicroClaw, resources
 * layout) stay untouched so upstream compatibility is preserved.
 */
// This file lives in desktop/src/companyclaw/, so the repository root is
// three levels up (companyclaw -> src -> desktop -> repo).
const repositoryRoot = path.resolve(__dirname, "../../..");

function readBuilderConfig(): string {
  return readFileSync(path.join(repositoryRoot, "desktop", "electron-builder.yml"), "utf-8");
}

describe("CompanyClaw product identity", () => {
  it("uses a CompanyClaw app id instead of the upstream MicroClaw id", () => {
    const config = readBuilderConfig();
    expect(config).toMatch(/^appId:\s*com\.companyclaw\.desktop$/m);
    expect(config).not.toContain("ai.openclaw.microclaw");
  });

  it("uses a CompanyClaw product name", () => {
    const config = readBuilderConfig();
    expect(config).toMatch(/^productName:\s*CompanyClaw$/m);
    expect(config).not.toMatch(/^productName:\s*MicroClawDesktop$/m);
  });

  it("keeps the Creative Muse skill staging contract intact", () => {
    const config = readBuilderConfig();
    // The skill now arrives through the unified pipeline, which stages every
    // catalog skill (rednote-publisher included) before electron-builder runs.
    expect(config).toContain("from: resources/agent-skills/");
    expect(config).toContain("to: agent-skills/");
    expect(config).not.toContain("from: ../skills/");
  });

  it("keeps resolving bundled resources from their upstream paths", () => {
    const config = readBuilderConfig();
    // bundled-runtime.ts reads openclaw.asar from process.resourcesPath; the
    // unpacked resources/openclaw/ directory is built and then removed by the
    // resource pipeline, so shipping it would declare a source that can never
    // be found.
    expect(config).toContain("to: openclaw.asar");
    expect(config).not.toContain("from: resources/openclaw/");
    // broker-paths.ts resolves resources/companyclaw-broker in a packaged build.
    expect(config).toContain("to: companyclaw-broker/dist/");
    expect(config).toContain("to: companyclaw-broker/scripts/");
    expect(config).toContain("to: AppContainerLauncher.exe");
    expect(config).toContain("to: sandbox-preload.js");
  });
});
