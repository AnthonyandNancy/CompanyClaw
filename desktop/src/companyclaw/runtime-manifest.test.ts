import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RUNTIME_MANIFEST_CONTRACT,
  sha256File,
  verifyRuntimeManifest,
} from "./runtime-manifest";

/**
 * The manifest is the only thing that tells the app whether the resources
 * shipped inside the installer are intact. These cases pin the failure modes
 * that must never be reported as "usable": a missing component, an altered
 * component, and a manifest that tries to escape the resources root.
 */
describe("verifyRuntimeManifest", () => {
  let root: string;

  function write(relativePath: string, contents: string): void {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf-8");
  }

  function entry(relativePath: string) {
    return {
      path: relativePath,
      kind: "broker" as const,
      version: "1.0.0",
      arch: "x64" as const,
      sha256: sha256File(path.join(root, relativePath)),
      license: "MIT",
    };
  }

  function manifest(entries: unknown[]) {
    return {
      contract: RUNTIME_MANIFEST_CONTRACT,
      arch: "x64",
      buildSha: "f1ab74e7",
      entries,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "companyclaw-manifest-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a manifest whose files all match", () => {
    write("node.exe", "node-binary");
    write("openclaw.asar", "archive");
    const result = verifyRuntimeManifest(
      manifest([entry("node.exe"), entry("openclaw.asar")]),
      root,
    );
    expect(result).toEqual({ ok: true, checked: 2 });
  });

  it("rejects a file whose contents changed", () => {
    write("node.exe", "node-binary");
    const recorded = entry("node.exe");
    write("node.exe", "tampered");
    const result = verifyRuntimeManifest(manifest([recorded]), root);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain("hash-mismatch: node.exe");
  });

  it("rejects a file that is missing", () => {
    write("node.exe", "node-binary");
    const recorded = entry("node.exe");
    rmSync(path.join(root, "node.exe"));
    const result = verifyRuntimeManifest(manifest([recorded]), root);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain("missing: node.exe");
  });

  it("rejects an empty entry list rather than reporting success", () => {
    const result = verifyRuntimeManifest(manifest([]), root);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain("entries-empty");
  });

  it("rejects a manifest written by a different contract version", () => {
    const result = verifyRuntimeManifest(
      { contract: "companyclaw.runtime-manifest.v0", arch: "x64", buildSha: "x", entries: [] },
      root,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain(
      "contract-mismatch: companyclaw.runtime-manifest.v0",
    );
  });

  it("refuses a path that escapes the resources root", () => {
    const result = verifyRuntimeManifest(
      manifest([
        {
          path: "../outside.txt",
          kind: "node",
          version: "1",
          arch: "x64",
          sha256: "0".repeat(64),
          license: "MIT",
        },
        {
          path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
          kind: "node",
          version: "1",
          arch: "x64",
          sha256: "0".repeat(64),
          license: "MIT",
        },
      ]),
      root,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain(
      "entry-path-escapes-root: ../outside.txt",
    );
  });

  it("refuses a duplicated entry", () => {
    write("node.exe", "node-binary");
    const recorded = entry("node.exe");
    const result = verifyRuntimeManifest(manifest([recorded, { ...recorded }]), root);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain("entry-duplicated: node.exe");
  });

  it("refuses a manifest that is not an object", () => {
    expect(verifyRuntimeManifest(null, root)).toEqual({
      ok: false,
      problems: ["manifest-invalid"],
    });
    expect(verifyRuntimeManifest("nope", root)).toEqual({
      ok: false,
      problems: ["manifest-invalid"],
    });
  });
});

describe("sha256File", () => {
  it("hashes file contents the way the build pipeline records them", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "companyclaw-sha-"));
    try {
      const file = path.join(root, "sample.bin");
      writeFileSync(file, "abc", "utf-8");
      // Known vector: sha256("abc").
      expect(sha256File(file)).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
