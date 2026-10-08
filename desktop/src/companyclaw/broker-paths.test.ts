import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBrokerDir, resolveBrokerScriptDir } from "./broker-paths";

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
