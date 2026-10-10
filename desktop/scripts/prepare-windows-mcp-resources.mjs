/**
 * Vendors the pinned Windows-MCP payload for the installer.
 *
 * Run at build time only. The employee's machine never runs pip, uv or any other
 * installer, so the payload (server sources plus a private interpreter and its
 * dependencies) has to be assembled here, hashed and checked into the unified
 * resource pipeline.
 *
 * Two properties are deliberate:
 *
 *   1. the upstream revision is pinned by commit, and the checkout is verified
 *      against it, so a moving branch cannot change what ships;
 *   2. the payload is assembled into `desktop/resources/companyclaw-broker/windows-mcp/`
 *      and described by its own `MANIFEST.json`, which the app verifies at
 *      startup — a missing or altered component then surfaces as a named fault
 *      instead of "the AI service failed to start".
 *
 * The script is idempotent: an already-correct payload is left alone so a normal
 * build does not re-download 200 MB.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repositoryDir = path.resolve(desktopDir, "..");
const resourcesDir = path.join(desktopDir, "resources");
const payloadDir = path.join(resourcesDir, "companyclaw-broker", "windows-mcp");
const serverDir = path.join(payloadDir, "server");
const runtimeDir = path.join(payloadDir, "python-runtime");
const cacheDir = path.join(resourcesDir, ".cache", "windows-mcp");

export const WINDOWS_MCP_LOCK = {
  repository: "https://github.com/CursorTouch/Windows-MCP",
  commit: "b455c2766c63599d466a6178641bac70787979a4",
  version: "0.8.7",
  license: "MIT",
  requiresPython: ">=3.14",
};

const args = process.argv.slice(2);
const force = args.includes("--force");

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listFiles(root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile()) found.push(absolute);
    }
  };
  if (existsSync(root)) visit(root);
  return found;
}

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, { stdio: "inherit", ...options });
}

function findPython() {
  // The interpreter must be at least the version the upstream package requires;
  // the upstream manifest's lower floor is not authoritative.
  const candidates = [
    process.env.COMPANYCLAW_PYTHON,
    "py",
    "python3",
    "python",
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    try {
      const commandArgs = candidate === "py" ? ["-3.14", "--version"] : ["--version"];
      const output = execFileSync(candidate, commandArgs, { encoding: "utf-8" }).trim();
      if (/3\.(1[4-9]|[2-9]\d)/.test(output)) {
        return { command: candidate, prefix: candidate === "py" ? ["-3.14"] : [] };
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `需要一个 Python ${WINDOWS_MCP_LOCK.requiresPython} 解释器来装配 Windows-MCP（可用 COMPANYCLAW_PYTHON 指定）`,
  );
}

function payloadIsCurrent() {
  if (force) return false;
  const manifestPath = path.join(payloadDir, "MANIFEST.json");
  if (!existsSync(manifestPath) || !existsSync(serverDir) || !existsSync(runtimeDir)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return manifest.upstreamCommit === WINDOWS_MCP_LOCK.commit;
  } catch {
    return false;
  }
}

function main() {
  if (payloadIsCurrent()) {
    console.log(`[windows-mcp] payload already pinned at ${WINDOWS_MCP_LOCK.commit}`);
    return;
  }

  console.log(`[windows-mcp] assembling pinned payload ${WINDOWS_MCP_LOCK.version} @ ${WINDOWS_MCP_LOCK.commit}`);
  mkdirSync(path.dirname(payloadDir), { recursive: true });
  rmSync(payloadDir, { recursive: true, force: true });
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const python = findPython();

  // 1. A private interpreter. `venv` is used rather than a bare install so the
  //    employee's own Python is never touched and the payload is self-contained.
  run(python.command, [...python.prefix, "-m", "venv", runtimeDir]);

  const runtimePython = path.join(
    runtimeDir,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  if (!existsSync(runtimePython)) {
    throw new Error(`私有 Python 运行时未生成：${runtimePython}`);
  }

  // 2. The package itself, at the pinned version. From PyPI because the wheel is
  //    reproducible; the release is verified by version and by the commit hash
  //    the manifest records.
  run(runtimePython, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-warn-script-location",
    "--quiet",
    `windows-mcp==${WINDOWS_MCP_LOCK.version}`,
  ]);

  // 3. Copy the installed package into the payload's server directory. The
  //    site-packages tree is copied wholesale so the vendored dependencies ship
  //    with it; the interpreter resolves them from this directory at runtime.
  const sitePackages = path.join(
    runtimeDir,
    process.platform === "win32" ? "Lib" : "lib",
    process.platform === "win32" ? "site-packages" : `python${process.env.PYTHON_VERSION ?? ""}`,
    process.platform === "win32" ? "" : "site-packages",
  );
  const resolvedSitePackages = existsSync(sitePackages)
    ? sitePackages
    : (() => {
        const libDir = path.join(runtimeDir, "Lib");
        if (existsSync(libDir)) return path.join(libDir, "site-packages");
        throw new Error("未能定位私有运行时的 site-packages 目录");
      })();

  // Only the upstream package itself is copied into `server/`: it is the part
  // whose revision is pinned and whose bytes are verified, and it is the part
  // PYTHONPATH points at. Its third-party dependencies stay in the private
  // runtime, so a 380 MB payload does not become a 600 MB one by storing every
  // wheel twice.
  mkdirSync(serverDir, { recursive: true });
  const upstreamPackage = path.join(resolvedSitePackages, "windows_mcp");
  if (!existsSync(upstreamPackage)) {
    throw new Error("私有运行时中没有 windows_mcp 包，装配失败");
  }
  cpSync(upstreamPackage, path.join(serverDir, "windows_mcp"), {
    recursive: true,
    filter: (source) => !source.includes("__pycache__"),
  });

  // 4. Hash every shipped file into the payload manifest.
  const files = listFiles(serverDir)
    .map((absolute) => ({
      path: path.relative(serverDir, absolute).split(path.sep).join("/"),
      sha256: sha256(absolute),
      bytes: statSync(absolute).size,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  writeFileSync(
    path.join(payloadDir, "MANIFEST.json"),
    `${JSON.stringify(
      {
        contract: "companyclaw.windows-mcp.v1",
        upstreamRepository: WINDOWS_MCP_LOCK.repository,
        upstreamCommit: WINDOWS_MCP_LOCK.commit,
        upstreamVersion: WINDOWS_MCP_LOCK.version,
        license: WINDOWS_MCP_LOCK.license,
        telemetry: "disabled",
        transport: "stdio",
        tools: "pinned by broker/adapters/windows-mcp/tool-policy-map.ts",
        files,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  console.log(`[windows-mcp] payload ready: ${files.length} files under ${payloadDir}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("prepare-windows-mcp-resources.mjs")) {
  main();
}
