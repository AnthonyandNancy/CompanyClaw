import { describe, expect, it } from "vitest";
import {
  COMPANYCLAW_TASK_STORE_CONTRACT,
  CompanyClawTaskStore,
  createTaskIdempotencyKey,
  filterTasksForOwner,
} from "./task-store";

const filePath = "C:\\State\\companyclaw\\tasks.json";

/** A single shared JSON document, so two stores can observe each other's writes. */
function sharedFile() {
  let contents: string | null = null;
  const writes: string[] = [];
  return {
    writes,
    deps: {
      existsFile: (target: string) => target === filePath && contents !== null,
      readFile: () => contents ?? "",
      writeFile: async (_target: string, next: string) => {
        writes.push(next);
        contents = next;
      },
    },
  };
}

function store(shared: ReturnType<typeof sharedFile>, initial: unknown = null, id = "task-1") {
  if (initial !== null) {
    void shared.deps.writeFile(filePath, JSON.stringify(initial));
  }
  return new CompanyClawTaskStore(filePath, {
    now: () => new Date("2026-10-08T00:00:00.000Z"),
    createId: () => id,
    ...shared.deps,
  });
}

describe("CompanyClawTaskStore", () => {
  it("creates a task in CREATED with an owner binding", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    const record = await instance.create({
      ownerSid: "S-1-5-21-1",
      deviceId: "device-a",
      channel: "openclaw-weixin",
      objective: "把 ABC 公司工单负责人改成张三",
    });
    expect(record).toMatchObject({
      taskId: "task-1",
      state: "CREATED",
      ownerSid: "S-1-5-21-1",
      channel: "openclaw-weixin",
    });
    expect(instance.get("task-1")?.taskId).toBe("task-1");
  });

  it("advances only through legal transitions", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    await instance.create({
      ownerSid: "S-1",
      deviceId: "d",
      channel: "openclaw-weixin",
      objective: "x",
    });
    await instance.advance("task-1", "AUTHENTICATED", {});
    expect(instance.get("task-1")?.state).toBe("AUTHENTICATED");
    await expect(instance.advance("task-1", "COMPLETED", {})).rejects.toThrow(
      /AUTHENTICATED -> COMPLETED/,
    );
  });

  it("stamps terminalAt only on terminal states", async () => {
    const shared = sharedFile();
    const instance = store(shared);
    await instance.create({ ownerSid: "S", deviceId: "d", channel: "c", objective: "o" });
    expect(instance.get("task-1")?.terminalAt).toBeNull();
    await instance.advance("task-1", "CANCELLED", {});
    expect(instance.get("task-1")?.terminalAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("returns nothing and warns for malformed or legacy storage (authorizes nothing)", () => {
    const legacy = store(sharedFile(), { records: [], contract: "old" });
    expect(legacy.list()).toEqual([]);
    expect(legacy.inspect().warning).toBeTruthy();

    const shared = sharedFile();
    void shared.deps.writeFile(filePath, "not json");
    const malformed = new CompanyClawTaskStore(filePath, {
      now: () => new Date("2026-10-08T00:00:00.000Z"),
      ...shared.deps,
    });
    expect(malformed.list()).toEqual([]);
    expect(malformed.inspect().warning).toBeTruthy();
  });

  it("persists a versioned envelope and keeps owner isolation", async () => {
    const shared = sharedFile();
    const first = store(shared);
    await first.create({ ownerSid: "S-1", deviceId: "d", channel: "c", objective: "o" });
    expect(JSON.parse(shared.writes[0]).contract).toBe(COMPANYCLAW_TASK_STORE_CONTRACT);

    const second = store(shared, null, "task-2");
    await second.create({ ownerSid: "S-2", deviceId: "d", channel: "c", objective: "o" });

    expect(filterTasksForOwner(second.list(), "S-1").map((r) => r.taskId)).toEqual(["task-1"]);
    expect(filterTasksForOwner(second.list(), "S-2").map((r) => r.taskId)).toEqual(["task-2"]);
  });

  it("derives a stable idempotency key and finds an existing task by it", async () => {
    const key = createTaskIdempotencyKey("task-1", "step-2", "abc123");
    expect(key).toBe("task-1:step-2:abc123");
    const instance = store(sharedFile());
    await instance.create({
      ownerSid: "S",
      deviceId: "d",
      channel: "c",
      objective: "o",
      idempotencyKey: key,
    });
    expect(instance.findByIdempotencyKey(key)?.taskId).toBe("task-1");
    expect(instance.findByIdempotencyKey("missing")).toBeNull();
  });
});
