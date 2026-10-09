import { describe, expect, it } from "vitest";
import {
  edgeExecutableCandidates,
  findEdgeExecutable,
  GATEWAY_AUTH_MODE,
  planBrowserConfig,
  planFirstRunConfig,
} from "./first-run-init";

/**
 * The NSIS package ships no pre-generated openclaw.json. Without this step the
 * Gateway would start with an empty auth token, and browser automation would
 * have no executable configured — both of which the legacy Python installer
 * used to write.
 *
 * The invariant that matters most: a value the user already set is never
 * replaced.
 */
const createToken = () => "a".repeat(64);

describe("planFirstRunConfig", () => {
  it("fills in the gateway token, mode and port on a fresh install", () => {
    const result = planFirstRunConfig({ existing: null, createToken });
    expect(result.config).toMatchObject({
      gateway: {
        auth: { mode: GATEWAY_AUTH_MODE, token: "a".repeat(64) },
        port: 18789,
      },
    });
    expect(result.changed).toEqual(
      expect.arrayContaining(["gateway.auth.token", "gateway.auth.mode", "gateway.port"]),
    );
  });

  it("keeps an existing token and reports nothing changed", () => {
    const existing = {
      gateway: { auth: { mode: "token", token: "keep-me" }, port: 19000 },
    };
    const result = planFirstRunConfig({ existing, createToken });
    expect(result.config.gateway).toMatchObject({
      auth: { mode: "token", token: "keep-me" },
      port: 19000,
    });
    expect(result.changed).toEqual([]);
  });

  it("keeps an existing port while still issuing a token", () => {
    const result = planFirstRunConfig({
      existing: { gateway: { port: 20000 } },
      createToken,
    });
    expect(result.config.gateway).toMatchObject({ port: 20000 });
    expect(result.changed).toContain("gateway.auth.token");
    expect(result.changed).not.toContain("gateway.port");
  });

  it("replaces a non-object auth section instead of throwing", () => {
    const result = planFirstRunConfig({
      existing: { gateway: { auth: "yes" } },
      createToken,
    });
    expect(result.config.gateway).toMatchObject({
      auth: { mode: GATEWAY_AUTH_MODE, token: "a".repeat(64) },
    });
  });

  it("treats a blank token as missing", () => {
    const result = planFirstRunConfig({
      existing: { gateway: { auth: { token: "   " } } },
      createToken,
    });
    expect(result.config.gateway).toMatchObject({ auth: { token: "a".repeat(64) } });
    expect(result.changed).toContain("gateway.auth.token");
  });

  it("does not mutate the configuration it was given", () => {
    const existing = { gateway: { port: 20000 }, unrelated: { keep: true } };
    const snapshot = JSON.stringify(existing);
    planFirstRunConfig({ existing, createToken });
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it("preserves unrelated configuration keys", () => {
    const result = planFirstRunConfig({
      existing: { unrelated: { keep: true }, models: { providers: {} } },
      createToken,
    });
    expect(result.config).toMatchObject({
      unrelated: { keep: true },
      models: { providers: {} },
    });
  });

  it("honours an explicit port override", () => {
    const result = planFirstRunConfig({ existing: null, createToken, port: 31000 });
    expect(result.config.gateway).toMatchObject({ port: 31000 });
  });
});

describe("planBrowserConfig", () => {
  const edge = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";

  it("enables the browser and records the detected executable", () => {
    const result = planBrowserConfig({}, edge);
    expect(result.config.browser).toEqual({ enabled: true, executablePath: edge });
    expect(result.changed).toEqual(["browser.enabled", "browser.executablePath"]);
  });

  it("never replaces an executable the user chose", () => {
    const result = planBrowserConfig(
      { browser: { executablePath: "D:\\Custom\\browser.exe" } },
      edge,
    );
    expect(result.config.browser).toMatchObject({ executablePath: "D:\\Custom\\browser.exe" });
    expect(result.changed).not.toContain("browser.executablePath");
  });

  it("keeps a browser the user disabled", () => {
    const result = planBrowserConfig({ browser: { enabled: false } }, edge);
    expect(result.config.browser).toMatchObject({ enabled: false });
    expect(result.changed).not.toContain("browser.enabled");
  });

  it("omits the executable when no browser was detected", () => {
    const result = planBrowserConfig({}, null);
    expect(result.config.browser).toEqual({ enabled: true });
    expect(result.changed).toEqual(["browser.enabled"]);
  });

  it("does not mutate the input configuration", () => {
    const config = { browser: { enabled: true } };
    const snapshot = JSON.stringify(config);
    planBrowserConfig(config, edge);
    expect(JSON.stringify(config)).toBe(snapshot);
  });
});

describe("edgeExecutableCandidates", () => {
  it("checks the per-user location first, then the machine-wide ones", () => {
    const candidates = edgeExecutableCandidates({
      LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    expect(candidates).toEqual([
      "C:\\Users\\someone\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  });

  it("falls back to the standard machine-wide paths without environment hints", () => {
    const candidates = edgeExecutableCandidates({});
    expect(candidates).toEqual([
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  });
});

describe("findEdgeExecutable", () => {
  it("returns the first candidate that exists", () => {
    const candidates = findEdgeExecutable({}, (candidate) => candidate.includes("x86"));
    expect(candidates).toBe("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  });

  it("returns null when Edge is absent, rather than inventing a path", () => {
    expect(findEdgeExecutable({}, () => false)).toBeNull();
  });
});
