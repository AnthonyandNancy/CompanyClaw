import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Requirement V1.1 (conflict 2) requires that everyday use must not depend on
 * administrator rights: the installer installs per-user, into a location the
 * current user can write, and does not silently elevate.
 *
 * These checks pin the installer configuration that decides this. They read the
 * real config rather than restating it, so a later change cannot quietly switch
 * the install scope back to per-machine.
 */
const repositoryRoot = path.resolve(__dirname, "../../..");

function readBuilderConfig(): string {
  return readFileSync(path.join(repositoryRoot, "desktop", "electron-builder.yml"), "utf-8");
}

describe("installer scope", () => {
  it("installs per-user, not per-machine", () => {
    const config = readBuilderConfig();
    // electron-builder defaults to per-machine for a non-oneClick NSIS build,
    // which triggers UAC. The requirement is explicit about avoiding that.
    expect(config).toMatch(/^\s*perMachine:\s*false\s*$/m);
  });

  it("keeps a visible install wizard instead of a silent install", () => {
    const config = readBuilderConfig();
    expect(config).toMatch(/^\s*oneClick:\s*false\s*$/m);
  });

  it("runs without an elevated install mode", () => {
    const config = readBuilderConfig();
    // `allowElevation: true` would let the installer request admin rights and
    // install machine-wide; the requirement forbids silent elevation.
    expect(config).toMatch(/^\s*allowElevation:\s*false\s*$/m);
  });

  it("names the shortcut after the product rather than the upstream tool", () => {
    const config = readBuilderConfig();
    const match = config.match(/^\s*shortcutName:\s*(.+)$/m);
    expect(match?.[1]?.trim()).toBe("CompanyClaw");
  });
});

describe("installer does not modify host security configuration", () => {
  it("adds no Defender exclusion through the builder config", () => {
    const config = readBuilderConfig();
    expect(config.toLowerCase()).not.toContain("defender");
    expect(config).not.toContain("Add-MpPreference");
  });

  it("declares no elevation-required custom NSIS script", () => {
    const config = readBuilderConfig();
    // A custom include could perform privileged system changes; if one is ever
    // added it must be reviewed explicitly rather than appearing unnoticed.
    expect(config).not.toMatch(/^\s*include:\s/m);
  });
});
