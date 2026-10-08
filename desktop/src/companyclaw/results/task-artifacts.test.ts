import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  buildTaskArtifactDir,
  isPathInsideTaskDir,
  sanitizeArtifactFileName,
  taskDirName,
} from "./task-artifacts";

const ROOT = path.join("C:", "state", "companyclaw");

describe("taskDirName", () => {
  it("accepts a plain task id", () => {
    expect(taskDirName("task-1")).toBe("task-1");
  });

  it("rejects anything that could escape the jobs directory", () => {
    // A task id arrives from stored records; a crafted one must not be able to
    // address a directory outside its own sandbox.
    for (const bad of ["..", "../evil", "a/b", "a\\b", ".", "", "  ", "task:1", "task\u0000"]) {
      expect(taskDirName(bad)).toBeNull();
    }
  });

  it("rejects an id that is too long for a filesystem name", () => {
    expect(taskDirName("a".repeat(200))).toBeNull();
  });
});

describe("buildTaskArtifactDir", () => {
  it("places artifacts under jobs/<taskId>/artifacts", () => {
    expect(buildTaskArtifactDir(ROOT, "task-1")).toBe(
      path.join(ROOT, "jobs", "task-1", "artifacts"),
    );
  });

  it("returns null for an unusable task id instead of guessing a path", () => {
    expect(buildTaskArtifactDir(ROOT, "../evil")).toBeNull();
  });
});

describe("isPathInsideTaskDir", () => {
  const taskDir = path.join(ROOT, "jobs", "task-1", "artifacts");

  it("accepts a direct child", () => {
    expect(isPathInsideTaskDir(taskDir, path.join(taskDir, "report.xlsx"))).toBe(true);
  });

  it("accepts a nested child", () => {
    expect(isPathInsideTaskDir(taskDir, path.join(taskDir, "sub", "report.xlsx"))).toBe(true);
  });

  it("rejects the directory itself and a sibling", () => {
    expect(isPathInsideTaskDir(taskDir, taskDir)).toBe(false);
    expect(
      isPathInsideTaskDir(taskDir, path.join(ROOT, "jobs", "task-2", "artifacts", "a.xlsx")),
    ).toBe(false);
  });

  it("rejects a traversal out of the task directory", () => {
    expect(isPathInsideTaskDir(taskDir, path.join(taskDir, "..", "..", "other.xlsx"))).toBe(false);
  });

  it("rejects a sibling whose name merely starts with the task dir name", () => {
    // Paths must be compared with a separator, or "artifacts-evil" would pass.
    expect(isPathInsideTaskDir(taskDir, `${taskDir}-evil${path.sep}a.xlsx`)).toBe(false);
  });
});

describe("sanitizeArtifactFileName", () => {
  it("keeps an ordinary file name", () => {
    expect(sanitizeArtifactFileName("费用清单.xlsx")).toBe("费用清单.xlsx");
  });

  it("strips any directory component", () => {
    expect(sanitizeArtifactFileName("..\\..\\windows\\system32\\evil.dll")).toBe("evil.dll");
    expect(sanitizeArtifactFileName("/etc/passwd")).toBe("passwd");
  });

  it("removes characters that are invalid or dangerous on Windows", () => {
    expect(sanitizeArtifactFileName('a<b>c:d"e|f?g*h.xlsx')).toBe("abcdefgh.xlsx");
  });

  it("rejects an empty result and reserved device names", () => {
    expect(sanitizeArtifactFileName("")).toBeNull();
    expect(sanitizeArtifactFileName("...")).toBeNull();
    expect(sanitizeArtifactFileName("CON")).toBeNull();
    expect(sanitizeArtifactFileName("lpt1.txt")).toBeNull();
  });

  it("keeps a leading dot file rather than treating it as traversal", () => {
    expect(sanitizeArtifactFileName(".env")).toBe(".env");
  });
});
