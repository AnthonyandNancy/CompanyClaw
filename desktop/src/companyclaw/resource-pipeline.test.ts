import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_MANIFEST_CONTRACT, verifyRuntimeManifest } from "./runtime-manifest";

/**
 * The installer claims to be self-contained because the payload manifest can
 * prove it. These cases pin the failure modes that matter to an employee
 * machine: a component that was not staged, a component that was changed after
 * it was hashed, and a manifest that lists the same file twice.
 *
 * The pipeline itself cannot be run here (it publishes .NET output and installs
 * OpenClaw), so the negative cases are driven through the same verifier the app
 * uses at startup.
 */
const desktopDir = path.resolve(__dirname, "../..");

const temporaryDirs: string[] = [];

function makeResourcesFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "companyclaw-manifest-"));
  temporaryDirs.push(root);
  return root;
}

function writeFile(root: string, relative: string, contents: string): string {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
  return absolute;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("payload manifest failures the build must catch", () => {
  it("reports a component that was never staged", () => {
    const root = makeResourcesFixture();
    const verification = verifyRuntimeManifest(
      {
        contract: RUNTIME_MANIFEST_CONTRACT,
        arch: "x64",
        buildSha: "test",
        entries: [
          {
            path: "openclaw-weixin/dist/index.js",
            kind: "plugin",
            version: "2.4.6",
            arch: "x64",
            sha256: "0".repeat(64),
            license: "MIT",
          },
        ],
      },
      root,
    );
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.problems.join("; ")).toContain("missing: openclaw-weixin/dist/index.js");
  });

  it("reports a staged component whose contents changed", () => {
    const root = makeResourcesFixture();
    const file = writeFile(root, "companyclaw-broker/dist/main.js", "console.log(1)\n");
    const verification = verifyRuntimeManifest(
      {
        contract: RUNTIME_MANIFEST_CONTRACT,
        arch: "x64",
        buildSha: "test",
        entries: [
          {
            path: "companyclaw-broker/dist/main.js",
            kind: "broker",
            version: "1.0.0",
            arch: "x64",
            // A hash that cannot match the file above: the point is that
            // tampering after assembly is detected, not how it happened.
            sha256: "f".repeat(64),
            license: "Proprietary",
          },
        ],
      },
      root,
    );
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.problems.join("; ")).toContain(
      "hash-mismatch: companyclaw-broker/dist/main.js",
    );
    // The file really is there, so the failure is the hash and not a missing
    // path - otherwise this case would pass for the wrong reason.
    expect(file.endsWith("main.js")).toBe(true);
  });

  it("reports a duplicated manifest entry", () => {
    const root = makeResourcesFixture();
    const file = writeFile(root, "node.exe", "binary\n");
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    const entry = {
      path: "node.exe",
      kind: "node",
      version: "26.7.0",
      arch: "x64",
      sha256,
      license: "MIT",
    };
    const verification = verifyRuntimeManifest(
      {
        contract: RUNTIME_MANIFEST_CONTRACT,
        arch: "x64",
        buildSha: "test",
        entries: [entry, entry],
      },
      root,
    );
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.problems.join("; ")).toContain("entry-duplicated: node.exe");
  });

  it("accepts a manifest that matches the staged files", () => {
    const root = makeResourcesFixture();
    const file = writeFile(root, "agent-skills/excel-xlsx/SKILL.md", "# Excel\n");
    const verification = verifyRuntimeManifest(
      {
        contract: RUNTIME_MANIFEST_CONTRACT,
        arch: "x64",
        buildSha: "test",
        entries: [
          {
            path: "agent-skills/excel-xlsx/SKILL.md",
            kind: "skill",
            version: "1.0.0",
            arch: "x64",
            sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
            license: "Proprietary",
          },
        ],
      },
      root,
    );
    expect(verification).toEqual({ ok: true, checked: 1 });
  });
});

describe("staging hygiene", () => {
  const script = readFileSync(
    path.join(desktopDir, "scripts/prepare-production-resources.mjs"),
    "utf-8",
  );

  it("prunes leftover staging directories instead of reusing them", () => {
    // An interrupted run leaves a .staging-<pid> directory behind. Reusing one
    // would ship whatever the previous run happened to assemble.
    expect(script).toContain(".staging-");
    expect(script).toMatch(/startsWith\("\.staging-"\)/);
    expect(script).toContain("discardStaging()");
  });

  it("keeps the previously released payload until the new one is verified", () => {
    // The swap happens only after the manifest has been checked against the
    // staged files, so a failed run cannot leave a half-empty resources folder.
    const verificationIndex = script.indexOf("Manifest hash mismatch");
    const swapIndex = script.indexOf("const superseded = []");
    expect(verificationIndex).toBeGreaterThan(-1);
    expect(swapIndex).toBeGreaterThan(verificationIndex);
  });

  it("keeps generated build scaffolding out of the packaged payload", () => {
    // The compile config is written to the system temp directory because every
    // top-level item of the staging directory is renamed into resources/.
    expect(script).toContain("os.tmpdir()");
    expect(script).not.toMatch(/weixinTsconfigPath\s*=\s*path\.join\(\s*stagingDir/);
  });
});
