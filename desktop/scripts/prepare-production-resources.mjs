import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createPackage, listPackage } from "@electron/asar";

/**
 * Unified production resource pipeline for the CompanyClaw installer.
 *
 * The employee artifact must be self-contained: nothing inside this script may
 * turn into an "install Node.js first" instruction for the person running the
 * installer. Everything is assembled on the build machine, hashed, and only
 * then swapped into `desktop/resources/` — an interrupted run leaves the
 * previous build intact.
 *
 * Stages:
 *   1. private Node runtime   (this interpreter's own node.exe)
 *   2. OpenClaw               (locked version from deployer/openclaw_version.py)
 *   3. Windows Node / MXC     (delegated to prepare-windows-node-resources.mjs)
 *   4. CompanyClaw broker     (TypeScript compiled to dist/, plus UIA scripts)
 *   5. runtime-manifest.json  (path + version + sha256 for every component)
 *
 * The staging directory lives inside `desktop/resources/` so it is covered by
 * the existing gitignore entry and always shares a volume with the target,
 * which keeps the final swap a rename rather than a copy.
 */

const desktopDir = path.resolve(import.meta.dirname, "..");
const repositoryDir = path.resolve(desktopDir, "..");
const resourcesDir = path.join(desktopDir, "resources");
const stagingDir = path.join(resourcesDir, `.staging-${process.pid}`);
const openClawStagingDir = path.join(stagingDir, "openclaw");
const openClawArchive = path.join(stagingDir, "openclaw.asar");
const brokerStagingDir = path.join(stagingDir, "companyclaw-broker");

const archArguments = process.argv.slice(2).filter((argument) => argument.startsWith("--arch="));
if (archArguments.length !== 1 || process.argv.length !== 3) {
  throw new Error(
    "Specify exactly one Windows package architecture with --arch=x64 or --arch=arm64",
  );
}
const targetArch = archArguments[0].slice("--arch=".length);
if (targetArch !== "x64" && targetArch !== "arm64") {
  throw new Error(`Unsupported architecture: ${targetArch}`);
}

if (process.platform !== "win32" || path.basename(process.execPath).toLowerCase() !== "node.exe") {
  throw new Error("Production resources must be prepared on Windows with node.exe");
}

// A failed run must not leave hundreds of megabytes of staging behind for the
// next run (and the next electron-builder invocation) to trip over.
function discardStaging() {
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // Best effort: the next run prunes stale staging directories anyway.
  }
}
process.on("uncaughtException", (error) => {
  discardStaging();
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  discardStaging();
  console.error(error);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.status}`);
  }
}

/**
 * Resolves the npm CLI entry point.
 *
 * Spawning `npm.cmd` directly fails on modern Node (it requires a shell), so the
 * JavaScript entry point is always executed through node.exe instead.
 */
function resolveNpmCli() {
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!existsSync(npmCli)) {
    throw new Error(`npm CLI not found at ${npmCli}; run this on a build machine with npm`);
  }
  return npmCli;
}

function gitHeadSha() {
  const result = spawnSync("git", ["-C", repositoryDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "unknown";
  return result.stdout.trim() || "unknown";
}

// ---------------------------------------------------------------------------
// 1. Version lock — the deployer remains the single source of truth.
// ---------------------------------------------------------------------------
const versionFile = path.join(repositoryDir, "deployer", "openclaw_version.py");
const versionSource = readFileSync(versionFile, "utf8");
const openClawVersion = versionSource.match(/^OPENCLAW_TARGET_VERSION = "([^"]+)"$/m)?.[1];
if (!openClawVersion) {
  throw new Error(`Could not resolve OPENCLAW_TARGET_VERSION from ${versionFile}`);
}

// ---------------------------------------------------------------------------
// 2. Stage every component into a private directory.
// ---------------------------------------------------------------------------
mkdirSync(resourcesDir, { recursive: true });
// Only staging leftovers from interrupted runs are removed; the live resources
// stay untouched until the swap at the end.
for (const entry of readdirSync(resourcesDir)) {
  if (entry.startsWith(".staging-")) {
    rmSync(path.join(resourcesDir, entry), { recursive: true, force: true });
  }
}
mkdirSync(openClawStagingDir, { recursive: true });

// 2a. Private Node runtime. This is the exact interpreter the app will run the
// Gateway and the broker with, so it is copied rather than re-downloaded.
copyFileSync(process.execPath, path.join(stagingDir, "node.exe"));

// 2b. OpenClaw, installed from the locked version. `npm install` is a build
// machine concern only; the installer never runs it.
const npmRegistry = process.env.MSIX_NPM_REGISTRY || "https://registry.npmjs.org";
run(process.execPath, [
  resolveNpmCli(),
  "install",
  "--prefix",
  openClawStagingDir,
  "--omit=dev",
  "--ignore-scripts=false",
  "--no-package-lock",
  "--no-save",
  "--registry",
  npmRegistry,
  `openclaw@${openClawVersion}`,
]);

const openClawEntry = path.join(openClawStagingDir, "node_modules", "openclaw", "openclaw.mjs");
if (!existsSync(openClawEntry)) {
  throw new Error(`OpenClaw ${openClawVersion} staging did not produce ${openClawEntry}`);
}

// 2c. Archive the staged tree. bundled-runtime.ts extracts this archive into
// userData on first launch, which is what keeps native addons out of the
// read-only application directory.
await createPackage(openClawStagingDir, openClawArchive);
const archiveFiles = listPackage(openClawArchive).map((file) => file.replaceAll("\\", "/"));
if (!archiveFiles.includes("/node_modules/openclaw/openclaw.mjs")) {
  throw new Error(`OpenClaw ${openClawVersion} archive is missing openclaw.mjs`);
}
rmSync(openClawStagingDir, { recursive: true, force: true });

// 2d. Windows Node / MXC resources. Delegated so the pinned revisions and MXC
// hashes stay in exactly one place.
run(process.execPath, [
  path.join(desktopDir, "scripts", "prepare-windows-node-resources.mjs"),
  `--arch=${targetArch}`,
]);
cpSync(path.join(resourcesDir, "windows-node"), path.join(stagingDir, "windows-node"), {
  recursive: true,
});

// 2e. CompanyClaw broker: compiled JavaScript plus the PowerShell UIA scripts.
// The broker declares no runtime dependencies, so dist/ and scripts/ are a
// complete deployment.
run(process.execPath, [resolveNpmCli(), "run", "build"], {
  cwd: path.join(repositoryDir, "broker"),
});
const brokerDist = path.join(repositoryDir, "broker", "dist");
const brokerScripts = path.join(repositoryDir, "broker", "scripts");
if (!existsSync(path.join(brokerDist, "main.js"))) {
  throw new Error(`Broker build did not produce ${path.join(brokerDist, "main.js")}`);
}
cpSync(brokerDist, path.join(brokerStagingDir, "dist"), { recursive: true });
cpSync(brokerScripts, path.join(brokerStagingDir, "scripts"), { recursive: true });

// ---------------------------------------------------------------------------
// 3. Record what was assembled, so the app can prove it at startup.
// ---------------------------------------------------------------------------
const brokerScriptNames = readdirSync(path.join(brokerStagingDir, "scripts"))
  .filter((name) => name.endsWith(".ps1"))
  .sort();

const entries = [
  {
    path: "node.exe",
    kind: "node",
    version: process.version.replace(/^v/, ""),
    arch: targetArch,
    sha256: sha256(path.join(stagingDir, "node.exe")),
    license: "MIT",
  },
  {
    path: "openclaw.asar",
    kind: "openclaw",
    version: openClawVersion,
    arch: targetArch,
    sha256: sha256(openClawArchive),
    license: "See the openclaw package LICENSE",
  },
  {
    path: "companyclaw-broker/dist/main.js",
    kind: "broker",
    version: "1.0.0",
    arch: targetArch,
    sha256: sha256(path.join(brokerStagingDir, "dist", "main.js")),
    license: "Proprietary",
  },
];
if (brokerScriptNames.length === 0) {
  throw new Error("Broker staging contains no PowerShell scripts");
}
for (const scriptName of brokerScriptNames) {
  entries.push({
    path: `companyclaw-broker/scripts/${scriptName}`,
    kind: "broker",
    version: "1.0.0",
    arch: targetArch,
    sha256: sha256(path.join(brokerStagingDir, "scripts", scriptName)),
    license: "Proprietary",
  });
}

writeFileSync(
  path.join(stagingDir, "runtime-manifest.json"),
  `${JSON.stringify(
    {
      contract: "companyclaw.runtime-manifest.v1",
      arch: targetArch,
      buildSha: gitHeadSha(),
      entries,
    },
    null,
    2,
  )}\n`,
);

// ---------------------------------------------------------------------------
// 4. Verify the staged manifest against the staged files, then swap atomically.
// ---------------------------------------------------------------------------
const stagedManifest = JSON.parse(
  readFileSync(path.join(stagingDir, "runtime-manifest.json"), "utf8"),
);
for (const entry of stagedManifest.entries) {
  const absolute = path.join(stagingDir, entry.path);
  if (!existsSync(absolute)) throw new Error(`Manifest entry not staged: ${entry.path}`);
  const actual = sha256(absolute);
  if (actual !== entry.sha256) {
    throw new Error(`Manifest hash mismatch for ${entry.path}: ${actual}`);
  }
}

// The previous build stays usable until this point. Each staged top-level item
// replaces its live counterpart through a rename on the same volume.
const superseded = [];
try {
  for (const entry of readdirSync(stagingDir)) {
    if (entry.startsWith(".staging-")) continue;
    const live = path.join(resourcesDir, entry);
    if (existsSync(live)) {
      const parked = path.join(stagingDir, `.superseded-${entry}`);
      renameSync(live, parked);
      superseded.push({ live: parked, original: live });
    }
    renameSync(path.join(stagingDir, entry), live);
  }
} catch (error) {
  for (const { live, original } of superseded.reverse()) {
    rmSync(original, { recursive: true, force: true });
    renameSync(live, original);
  }
  throw error;
}
rmSync(stagingDir, { recursive: true, force: true });

console.log(
  `[companyclaw] Production resources staged: node ${process.version}, ` +
    `OpenClaw ${openClawVersion}, broker dist + ${brokerScriptNames.length} scripts, ` +
    `${entries.length} manifest entries`,
);
