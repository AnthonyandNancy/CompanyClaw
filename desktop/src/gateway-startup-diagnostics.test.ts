import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The loading screen shows only the last gateway log line, so every startup
 * failure has to carry its stage on that same line. This pins the contract that
 * used to be a single "node.exe not found" hint pointing at .openclaw-node.
 */
const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");

describe("gateway startup diagnostics", () => {
  it("reports failures with a stage tag on one line", () => {
    expect(source).toContain("function reportGatewayFailure(");
    expect(source).toContain("`[error][stage=${stage}] ${reason}`");
  });

  it("never sends an employee to the legacy .openclaw-node layout", () => {
    expect(source).not.toContain("手动检查 .openclaw-node 目录");
    expect(source).not.toContain("请确认 openclaw 已正确安装到 .openclaw-node");
  });

  it("covers every startup stage the requirement names", () => {
    for (const stage of [
      "resolve-runtime",
      "extract-runtime",
      "verify-manifest",
      "spawn",
      "auth",
      "health",
    ]) {
      // A stage is either passed to reportGatewayFailure("…") or written as a
      // `[stage=…]` log tag; both make the stage visible on the last log line.
      expect(
        source.includes(`"${stage}"`) || source.includes(`[stage=${stage}]`),
      ).toBe(true);
    }
  });
});
