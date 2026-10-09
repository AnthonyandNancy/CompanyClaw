import { describe, expect, it } from "vitest";
import { RUNTIME_MANIFEST_CONTRACT } from "../runtime-manifest";
import {
  COMPANYCLAW_DATA_SCHEMAS,
  compareVersions,
  planUpgrade,
  UPGRADE_PRESERVED_FILES,
} from "./upgrade-guard";

/**
 * An upgrade must not reset the owner's credentials or history, and a build
 * that cannot read the data already on disk must refuse to replace it rather
 * than start fresh on top of it.
 */
function plan(overrides: Partial<Parameters<typeof planUpgrade>[0]> = {}) {
  return planUpgrade({
    installedVersion: "1.0.0",
    incomingVersion: "1.1.0",
    manifest: { contract: RUNTIME_MANIFEST_CONTRACT, entries: [{ path: "node.exe" }] },
    onDiskSchemas: { tasks: COMPANYCLAW_DATA_SCHEMAS.tasks },
    ...overrides,
  });
}

describe("version comparison", () => {
  it("orders dotted versions numerically, not lexically", () => {
    // "1.10.0" > "1.9.0" is the case a string comparison gets wrong.
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("treats a missing or unparseable part as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
    expect(compareVersions("x.y.z", "0.0.0")).toBe(0);
  });
});

describe("upgrade planning", () => {
  it("allows a fresh install", () => {
    expect(plan({ installedVersion: null })).toEqual({ allowed: true, reason: "fresh-install" });
  });

  it("allows a newer version", () => {
    expect(plan()).toEqual({ allowed: true, reason: "upgrade" });
  });

  it("allows reinstalling the same version", () => {
    expect(plan({ incomingVersion: "1.0.0" })).toEqual({
      allowed: true,
      reason: "same-version",
    });
  });

  it("refuses data written by a newer build instead of overwriting it", () => {
    const result = plan({
      onDiskSchemas: { tasks: COMPANYCLAW_DATA_SCHEMAS.tasks + 1 },
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Losing the task history or a credential is worse than refusing.
    expect(result.reason).toContain("data-schema-newer: tasks");
  });

  it("ignores data files that are simply absent", () => {
    expect(plan({ onDiskSchemas: {} })).toEqual({ allowed: true, reason: "upgrade" });
  });

  it("refuses a manifest it cannot understand", () => {
    const result = plan({
      manifest: { contract: "companyclaw.runtime-manifest.v99", entries: [] },
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toContain("manifest-contract-mismatch");
  });

  it("refuses an empty manifest, which would make the resource check vacuous", () => {
    const result = plan({ manifest: { contract: RUNTIME_MANIFEST_CONTRACT, entries: [] } });
    expect(result).toEqual({ allowed: false, reason: "manifest-empty" });
  });

  it("does not inspect a manifest when the build ships none", () => {
    expect(plan({ manifest: null })).toEqual({ allowed: true, reason: "upgrade" });
  });

  it("keeps the owner's credentials and history out of the upgrade's reach", () => {
    // Named so a test can prove the installer never clears them.
    expect(UPGRADE_PRESERVED_FILES).toContain("companyclaw/identity-binding.json");
    expect(UPGRADE_PRESERVED_FILES).toContain("companyclaw/approvals.json");
    expect(UPGRADE_PRESERVED_FILES).toContain("companyclaw/companyclaw-ticket-secret");
  });

  it("checks every store's schema, not just the task store", () => {
    for (const key of Object.keys(COMPANYCLAW_DATA_SCHEMAS) as Array<
      keyof typeof COMPANYCLAW_DATA_SCHEMAS
    >) {
      const result = plan({ onDiskSchemas: { [key]: COMPANYCLAW_DATA_SCHEMAS[key] + 1 } });
      expect(result.allowed, `${key} must be guarded`).toBe(false);
    }
  });
});
