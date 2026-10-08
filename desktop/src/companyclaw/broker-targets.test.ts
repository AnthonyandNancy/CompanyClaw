import { describe, expect, it } from "vitest";
import {
  COMPANYCLAW_BROKER_TARGETS_CONTRACT,
  BrokerTargetsStore,
  normalizeProcessEntry,
  type BrokerTargets,
} from "./broker-targets";

const FILE = "C:\\state\\companyclaw\\broker-targets.json";

function store(initial?: unknown) {
  let contents = initial === undefined ? null : JSON.stringify(initial);
  const writes: string[] = [];
  const instance = new BrokerTargetsStore(FILE, {
    existsFile: (target) => target === FILE && contents !== null,
    readFile: () => contents ?? "",
    writeFile: async (_target, next) => {
      writes.push(next);
      contents = next;
    },
  });
  return { instance, writes };
}

const empty: BrokerTargets = { allowedProcesses: [], allowedWindowTitles: [] };

describe("normalizeProcessEntry", () => {
  it("lowercases and strips an .exe suffix", () => {
    expect(normalizeProcessEntry("Notepad.exe")).toBe("notepad");
    expect(normalizeProcessEntry("  EXCEL  ")).toBe("excel");
  });

  it("rejects an entry that carries a path", () => {
    // A path would let the caller aim at a specific binary location, which is
    // not what an application allow list should express.
    expect(normalizeProcessEntry("C:\\Windows\\System32\\cmd.exe")).toBeNull();
    expect(normalizeProcessEntry("..\\evil")).toBeNull();
    expect(normalizeProcessEntry("sub/dir/app")).toBeNull();
  });

  it("rejects an empty or wildcard-only entry", () => {
    expect(normalizeProcessEntry("")).toBeNull();
    expect(normalizeProcessEntry("   ")).toBeNull();
    expect(normalizeProcessEntry("*")).toBeNull();
    expect(normalizeProcessEntry(".exe")).toBeNull();
  });

  it("rejects an entry with characters that cannot appear in a process name", () => {
    expect(normalizeProcessEntry("note pad")).toBeNull();
    expect(normalizeProcessEntry("app;rm")).toBeNull();
    expect(normalizeProcessEntry("app:1")).toBeNull();
  });
});

describe("BrokerTargetsStore", () => {
  it("starts empty so the broker denies everything (fail-safe default)", () => {
    const { instance } = store();
    expect(instance.get()).toEqual(empty);
  });

  it("stores normalized entries and drops unusable ones", async () => {
    const { instance } = store();
    const saved = await instance.save({
      allowedProcesses: ["Notepad.exe", "excel", "C:\\evil\\cmd.exe", ""],
      allowedWindowTitles: ["  工单  ", "", "   "],
    });
    expect(saved.allowedProcesses).toEqual(["notepad", "excel"]);
    expect(saved.allowedWindowTitles).toEqual(["工单"]);
    expect(instance.get()).toEqual(saved);
  });

  it("de-duplicates entries", async () => {
    const { instance } = store();
    const saved = await instance.save({
      allowedProcesses: ["notepad", "NOTEPAD.exe", " notepad "],
      allowedWindowTitles: [],
    });
    expect(saved.allowedProcesses).toEqual(["notepad"]);
  });

  it("treats a malformed or foreign file as empty rather than as permissive", () => {
    const legacy = store({ contract: "other", allowedProcesses: ["cmd"] });
    expect(legacy.instance.get()).toEqual(empty);
    expect(legacy.instance.inspect().warning).toBeTruthy();

    const broken = store("not json");
    expect(broken.instance.get()).toEqual(empty);
    expect(broken.instance.inspect().warning).toBeTruthy();
  });

  it("treats unreadable storage as empty", () => {
    const instance = new BrokerTargetsStore(FILE, {
      existsFile: () => true,
      readFile: () => {
        throw new Error("disk error");
      },
      writeFile: async () => undefined,
    });
    expect(instance.get()).toEqual(empty);
    expect(instance.inspect().warning).toBeTruthy();
  });

  it("writes a versioned envelope", async () => {
    const { instance, writes } = store();
    await instance.save({ allowedProcesses: ["notepad"], allowedWindowTitles: [] });
    const envelope = JSON.parse(writes[0]) as { contract: string; schemaVersion: number };
    expect(envelope.contract).toBe(COMPANYCLAW_BROKER_TARGETS_CONTRACT);
    expect(envelope.schemaVersion).toBe(1);
  });
});
