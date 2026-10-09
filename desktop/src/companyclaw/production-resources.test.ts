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
    ]) {
      expect(script).toContain(produced);
    }
    expect(script).toContain("prepare-windows-node-resources.mjs");
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
