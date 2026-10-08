import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectMime, validateArtifact } from "./artifact-validator";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "companyclaw-artifacts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Minimal ZIP local file header signature followed by filler bytes. */
function zipBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
}

describe("detectMime", () => {
  it("detects real containers by magic number instead of extension", async () => {
    await expect(detectMime(async () => Buffer.from("%PDF-1.7", "utf8"))).resolves.toBe(
      "application/pdf",
    );
    await expect(detectMime(async () => zipBytes())).resolves.toBe("application/zip-container");
    await expect(
      detectMime(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).resolves.toBe("image/png");
    await expect(detectMime(async () => Buffer.from("plain text", "utf8"))).resolves.toBe(
      "application/octet-stream",
    );
  });
});

describe("validateArtifact", () => {
  it("accepts a well-formed xlsx by container checks, not extension", async () => {
    const filePath = path.join(dir, "report.xlsx");
    await writeFile(filePath, zipBytes());
    const result = await validateArtifact({ filePath });
    expect(result).toMatchObject({ ok: true, detectedMime: "application/zip-container" });
  });

  it("rejects a file whose extension claims xlsx but whose bytes are text", async () => {
    const filePath = path.join(dir, "fake.xlsx");
    await writeFile(filePath, "this is not a workbook");
    expect(await validateArtifact({ filePath })).toEqual({ ok: false, reason: "mime-mismatch" });
  });

  it("rejects missing, empty, oversized and disallowed files", async () => {
    expect(await validateArtifact({ filePath: path.join(dir, "nope.pdf") })).toEqual({
      ok: false,
      reason: "not-found",
    });

    const empty = path.join(dir, "empty.pdf");
    await writeFile(empty, "");
    expect(await validateArtifact({ filePath: empty })).toEqual({ ok: false, reason: "empty" });

    const big = path.join(dir, "big.pdf");
    await writeFile(big, Buffer.alloc(32));
    expect(await validateArtifact({ filePath: big, maxBytes: 8 })).toEqual({
      ok: false,
      reason: "too-large",
    });

    const exe = path.join(dir, "tool.exe");
    await writeFile(exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    expect(await validateArtifact({ filePath: exe })).toEqual({
      ok: false,
      reason: "extension-not-allowed",
    });
  });

  it("rejects a directory", async () => {
    expect(await validateArtifact({ filePath: dir })).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("rejects a pdf whose bytes are not a pdf", async () => {
    const filePath = path.join(dir, "fake.pdf");
    await writeFile(filePath, "plain");
    expect(await validateArtifact({ filePath })).toEqual({ ok: false, reason: "mime-mismatch" });
  });
});
