import * as path from "node:path";

/**
 * Locates the Windows Execution Broker.
 *
 * In a packaged build the broker ships as an extra resource next to the app; in
 * a source checkout it sits beside the `desktop/` directory. Resolving both
 * here keeps the path logic in one place and out of `main.ts`.
 */

export interface BrokerPathInput {
  isPackaged: boolean;
  resourcesPath: string;
  /** Electron's app path: `<repo>/desktop` in development. */
  appPath: string;
}

export const BROKER_RESOURCE_DIR_NAME = "companyclaw-broker";

export function resolveBrokerDir(input: BrokerPathInput): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, BROKER_RESOURCE_DIR_NAME);
  }
  // appPath is <repo>/desktop in development, so the broker is its sibling.
  return path.join(path.resolve(input.appPath, ".."), "broker");
}

export function resolveBrokerScriptDir(brokerDir: string): string {
  return path.join(brokerDir, "scripts");
}

/** Where the broker's compiled entry point sits, relative to its directory. */
export const BROKER_ENTRY_RELATIVE_PATH = path.join("dist", "main.js");

export interface BrokerRuntimePathInput extends BrokerPathInput {
  /** Already-resolved private Node runtime, when the caller has one. */
  nodePath?: string | null;
  /** Explicit override, used by development runs and tests. */
  nodePathOverride?: string | null;
}

export interface BrokerRuntimePaths {
  /** Interpreter that must run the broker entry point. */
  nodePath: string | null;
  /** Directory holding the broker's dist/ and scripts/. */
  brokerDir: string;
  /** Absolute path to the compiled broker entry point. */
  entryPath: string;
}

/**
 * Resolves everything needed to launch the broker at once.
 *
 * In a packaged build the interpreter is always the private runtime that ships
 * inside the installer (`<resources>/node.exe`): a system Node is not the
 * runtime this product validated, and the broker entry point cannot be run by
 * `CompanyClaw.exe`. Keeping the three paths together is what stops a caller
 * from pairing a runtime from one build with an entry point from another.
 */
export function resolveBrokerRuntimePaths(input: BrokerRuntimePathInput): BrokerRuntimePaths {
  const brokerDir = resolveBrokerDir(input);
  const override = input.nodePathOverride;
  const nodePath =
    typeof override === "string" && override.length > 0
      ? override
      : input.isPackaged
        ? path.join(input.resourcesPath, "node.exe")
        : (input.nodePath ?? null);
  return {
    nodePath,
    brokerDir,
    entryPath: path.join(brokerDir, BROKER_ENTRY_RELATIVE_PATH),
  };
}
