import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveBrokerDir,
  resolveBrokerRuntimePaths,
  resolveBrokerScriptDir,
  resolveCompanyClawResourceDir,
} from "./broker-paths";

const p = (...segments: string[]) => path.join(...segments);

/**
 * The broker lives outside the desktop package, so its location differs between
 * a source checkout and a packaged build. Both are resolved here so a wrong
 * path fails fast with a clear message instead of a mysterious startup hang.
 */
describe("resolveBrokerDir", () => {
  it("prefers the packaged resource directory when the app is packaged", () => {
    expect(
      resolveBrokerDir({ isPackaged: true, resourcesPath: "C:/app/resources", appPath: "C:/app" }),
    ).toBe(p("C:/app/resources", "companyclaw-broker"));
  });

  it("walks up from the desktop directory in a source checkout", () => {
    expect(
      resolveBrokerDir({ isPackaged: false, resourcesPath: "", appPath: "C:/repo/desktop" }),
    ).toBe(p("C:/repo", "broker"));
  });

  it("returns a stable path for a nested source layout", () => {
    const resolved = resolveBrokerDir({
      isPackaged: false,
      resourcesPath: "",
      appPath: "D:/work/CompanyClaw/desktop",
    });
    expect(resolved).toBe(p("D:/work/CompanyClaw", "broker"));
  });
});

describe("resolveBrokerScriptDir", () => {
  it("points at the scripts folder inside the broker directory", () => {
    expect(resolveBrokerScriptDir("C:/repo/broker")).toBe(p("C:/repo/broker", "scripts"));
  });
});

describe("resolveBrokerRuntimePaths", () => {
  it("pairs the packaged private runtime with the packaged broker", () => {
    // The interpreter that ships inside the installer is the only one this
    // product validated; the machine's PATH is never used for the broker.
    expect(
      resolveBrokerRuntimePaths({
        isPackaged: true,
        resourcesPath: "C:/app/resources",
        appPath: "C:/app",
        nodePath: "C:/Program Files/nodejs/node.exe",
      }),
    ).toEqual({
      nodePath: p("C:/app/resources", "node.exe"),
      brokerDir: p("C:/app/resources", "companyclaw-broker"),
      entryPath: p("C:/app/resources", "companyclaw-broker", "dist", "main.js"),
    });
  });

  it("uses the supplied runtime in a source checkout", () => {
    expect(
      resolveBrokerRuntimePaths({
        isPackaged: false,
        resourcesPath: "",
        appPath: "C:/repo/desktop",
        nodePath: "C:/node/node.exe",
      }),
    ).toEqual({
      nodePath: "C:/node/node.exe",
      brokerDir: p("C:/repo", "broker"),
      entryPath: p("C:/repo", "broker", "dist", "main.js"),
    });
  });

  it("honours an explicit override so development runs can point elsewhere", () => {
    expect(
      resolveBrokerRuntimePaths({
        isPackaged: true,
        resourcesPath: "C:/app/resources",
        appPath: "C:/app",
        nodePathOverride: "C:/custom/node.exe",
      }).nodePath,
    ).toBe("C:/custom/node.exe");
  });

  it("returns no runtime when a source checkout has none to offer", () => {
    // Null means "fall back to process.execPath", which is what keeps unit
    // tests and un-packaged development runs working.
    expect(
      resolveBrokerRuntimePaths({
        isPackaged: false,
        resourcesPath: "",
        appPath: "C:/repo/desktop",
      }).nodePath,
    ).toBeNull();
  });

  it("keeps the runtime and entry point on paths the installer really uses", () => {
    const resolved = resolveBrokerRuntimePaths({
      isPackaged: true,
      resourcesPath: p("C:", "程序 文件", "CompanyClaw", "resources"),
      appPath: "C:/app",
    });
    // Chinese characters and spaces must survive resolution untouched: these
    // are the paths a default Chinese Windows installation produces.
    expect(resolved.nodePath).toBe(p("C:", "程序 文件", "CompanyClaw", "resources", "node.exe"));
    expect(resolved.entryPath.endsWith(p("companyclaw-broker", "dist", "main.js"))).toBe(true);
  });
});

describe("Windows-MCP payload location", () => {
  it("points at the resources root the packager writes, in a packaged build", () => {
    const resolved = resolveCompanyClawResourceDir({
      isPackaged: true,
      resourcesPath: p("C:/app/resources"),
      appPath: p("C:/app/resources/app.asar"),
    });
    expect(resolved).toBe(p("C:/app/resources"));
  });

  it("points at desktop/resources in a source checkout", () => {
    // The payload is assembled there by prepare-windows-mcp-resources.mjs; a
    // path derived from anywhere else would report a fault the packager never
    // causes.
    const resolved = resolveCompanyClawResourceDir({
      isPackaged: false,
      resourcesPath: p("C:/unused"),
      appPath: p("C:/repo/desktop"),
    });
    expect(resolved).toBe(p("C:/repo/desktop", "resources"));
  });

  it("keeps the payload next to the broker's own resources", () => {
    const input = {
      isPackaged: false,
      resourcesPath: p("C:/unused"),
      appPath: p("C:/repo/desktop"),
    };
    const root = resolveCompanyClawResourceDir(input);
    // The probe appends `companyclaw-broker/windows-mcp/<server|python-runtime>`;
    // every one of those must sit under the same root the broker ships from.
    expect(root).toBe(p("C:/repo/desktop", "resources"));
  });
});
