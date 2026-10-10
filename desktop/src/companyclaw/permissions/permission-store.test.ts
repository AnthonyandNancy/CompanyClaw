import { describe, expect, it } from "vitest";
import {
  clearUserGrants,
  createEmptyPermissionPolicy,
  normalizeTrustedApp,
  normalizeTrustedDomain,
  PERMISSION_POLICY_CONTRACT,
} from "./permission-policy";
import { PermissionStore } from "./permission-store";
import { migrateToPermissionPolicy } from "./migrate";

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const backups: string[] = [];
  return {
    files,
    backups,
    io: {
      existsFile: (path: string) => files.has(path),
      readFile: (path: string) => files.get(path) ?? "",
      writeFile: async (path: string, contents: string) => {
        files.set(path, contents);
      },
      backupFile: (path: string, stamp: string) => {
        const target = `${path}.corrupt.${stamp}.bak`;
        backups.push(target);
        files.set(target, files.get(path) ?? "");
        return target;
      },
    },
  };
}

describe("permission policy shape", () => {
  it("starts from BASIC with nothing granted", () => {
    const policy = createEmptyPermissionPolicy();
    expect(policy.contract).toBe(PERMISSION_POLICY_CONTRACT);
    expect(policy.preset).toBe("BASIC");
    expect(policy.trustedApps).toEqual([]);
    expect(policy.remote.enabled).toBe(false);
    expect(policy.vision.local.enabled).toBe(false);
    expect(policy.vision.remote.enabled).toBe(false);
  });

  it("clears every user grant but keeps the schema and bumps the version", () => {
    const policy = createEmptyPermissionPolicy();
    policy.preset = "FULL_DAILY";
    policy.policyVersion = 7;
    policy.trustedApps.push({
      processName: "qq",
      displayName: "QQ",
      source: "user-selected",
      scope: "both",
      publisher: null,
      executablePath: null,
      fileHash: null,
      approvedSid: "S-1",
      approvedAt: "2026-10-10T00:00:00.000Z",
      legacy: false,
    });
    policy.vision.local.enabled = true;
    const cleared = clearUserGrants(policy);
    expect(cleared.preset).toBe("BASIC");
    expect(cleared.policyVersion).toBe(8);
    expect(cleared.trustedApps).toEqual([]);
    expect(cleared.vision.local.enabled).toBe(false);
    // System and enterprise restrictions survive by design.
    expect(cleared.enterpriseRestrictions).toEqual(policy.enterpriseRestrictions);
    expect(cleared.contract).toBe(PERMISSION_POLICY_CONTRACT);
  });
});

describe("trusted app normalization", () => {
  it("rejects anything that is not a single executable name", () => {
    for (const entry of [
      "C:\\Program Files\\QQ\\Bin\\QQ.exe",
      "qq*",
      "q q",
      "*",
      "",
      "qq;rm",
    ]) {
      expect(normalizeTrustedApp({ processName: entry })).toBeNull();
    }
  });

  it("normalizes case and extension and defaults to local scope", () => {
    const app = normalizeTrustedApp({ processName: "QQ.exe", displayName: "QQ" });
    expect(app?.processName).toBe("qq");
    expect(app?.scope).toBe("local");
    expect(app?.legacy).toBe(false);
  });
});

describe("trusted domain normalization", () => {
  it("accepts a host and rejects a url", () => {
    expect(normalizeTrustedDomain("OA.Example.com.")).toBe("oa.example.com");
    expect(normalizeTrustedDomain("https://oa.example.com/path")).toBeNull();
    expect(normalizeTrustedDomain("")).toBeNull();
  });
});

describe("permission store", () => {
  it("treats a missing file as the safe state", () => {
    const { io } = memoryIo();
    const store = new PermissionStore("p.json", io);
    const inspection = store.inspect();
    expect(inspection.policy.preset).toBe("BASIC");
    expect(inspection.warning).toBeNull();
  });

  it("falls back to the safe state and preserves a corrupt file", () => {
    const { io, backups } = memoryIo({ "p.json": "{not json" });
    const store = new PermissionStore("p.json", io);
    const inspection = store.inspect();
    expect(inspection.policy.preset).toBe("BASIC");
    expect(inspection.policy.trustedApps).toEqual([]);
    expect(inspection.warning).toContain("损坏");
    expect(backups).toHaveLength(1);
  });

  it("rejects an unsupported contract instead of trusting it", () => {
    const { io } = memoryIo({ "p.json": JSON.stringify({ contract: "other", preset: "FULL_DAILY" }) });
    const store = new PermissionStore("p.json", io);
    expect(store.inspect().policy.preset).toBe("BASIC");
  });

  it("round-trips a saved policy", async () => {
    const { io } = memoryIo();
    const store = new PermissionStore("p.json", io);
    const policy = createEmptyPermissionPolicy();
    policy.preset = "FULL_DAILY";
    policy.policyVersion = 3;
    await store.save(policy);
    expect(store.read().preset).toBe("FULL_DAILY");
    expect(store.read().policyVersion).toBe(3);
  });
});

describe("migration from the pre-V5 allow list", () => {
  it("keeps old apps as local legacy grants and never upgrades the preset", () => {
    const result = migrateToPermissionPolicy({
      stored: null,
      legacyTargets: { allowedProcesses: ["notepad", "QQ"], allowedWindowTitles: ["报表"] },
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(result.policy.preset).toBe("BASIC");
    expect(result.policy.trustedApps.map((app) => app.processName)).toEqual(["notepad", "qq"]);
    for (const app of result.policy.trustedApps) {
      expect(app.scope).toBe("local");
      expect(app.legacy).toBe(true);
    }
    expect(result.policy.legacyRuleReferences).toHaveLength(1);
    expect(result.policy.taskGrants).toEqual([]);
  });

  it("does not invent remote authorization", () => {
    const result = migrateToPermissionPolicy({
      stored: null,
      legacyTargets: null,
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(result.policy.remote.enabled).toBe(false);
  });

  it("keeps a live remote authorization but never resurrects a revoked one", () => {
    const live = migrateToPermissionPolicy({
      stored: null,
      legacyTargets: null,
      legacyRemote: {
        enabled: true,
        ownerSid: "S-1",
        deviceId: "d",
        channelUserId: "u",
        grantedAt: "2026-10-09T00:00:00Z",
        expiresAt: "2026-10-16T00:00:00Z",
        revokedAt: null,
      },
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(live.policy.remote.enabled).toBe(true);

    const revoked = migrateToPermissionPolicy({
      stored: null,
      legacyTargets: null,
      legacyRemote: {
        enabled: true,
        ownerSid: "S-1",
        deviceId: "d",
        channelUserId: "u",
        grantedAt: "2026-10-09T00:00:00Z",
        expiresAt: "2026-10-16T00:00:00Z",
        revokedAt: "2026-10-09T12:00:00Z",
      },
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(revoked.policy.remote.enabled).toBe(false);

    const expired = migrateToPermissionPolicy({
      stored: null,
      legacyTargets: null,
      legacyRemote: {
        enabled: true,
        ownerSid: "S-1",
        deviceId: "d",
        channelUserId: "u",
        grantedAt: "2026-10-01T00:00:00Z",
        expiresAt: "2026-10-02T00:00:00Z",
        revokedAt: null,
      },
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(expired.policy.remote.enabled).toBe(false);
  });

  it("preserves task grants only for the current schema", () => {
    const stored = createEmptyPermissionPolicy();
    stored.taskGrants.push({
      taskId: "t-1",
      ownerSid: "S-1",
      deviceId: "d",
      origin: "local-ui",
      targets: ["excel"],
      createdAt: "2026-10-10T00:00:00Z",
      expiresAt: "2026-10-10T01:00:00Z",
    });
    // The stored document has no preset of its own in this fixture beyond BASIC.
    const result = migrateToPermissionPolicy({ stored, legacyTargets: null });
    expect(result.policy.taskGrants).toEqual([]);
    expect(result.created).toBe(false);
  });
});
