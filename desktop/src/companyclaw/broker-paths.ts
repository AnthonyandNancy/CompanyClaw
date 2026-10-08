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
