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
    expect(config).toContain("from: ../skills/rednote-publisher/");
    expect(config).toContain("to: agent-skills/rednote-publisher/");
  });

  it("keeps resolving bundled resources from their upstream paths", () => {
    const config = readBuilderConfig();
    // Path contracts relied on by desktop/src/bundled-runtime.ts and
    // tool-sandbox provisioning must not change during branding.
    expect(config).toContain("to: openclaw/");
    expect(config).toContain("to: openclaw.asar");
    expect(config).toContain("to: AppContainerLauncher.exe");
    expect(config).toContain("to: sandbox-preload.js");
  });
});
