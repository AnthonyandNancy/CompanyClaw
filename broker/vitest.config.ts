import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["**/*.test.ts"],
    environment: "node",
    globals: true,
    exclude: ["node_modules/**", "dist/**"],
    // The live probes drive the real Windows UI Automation API through
    // PowerShell. Running several files at once makes them contend for the
    // desktop and produces flaky failures that have nothing to do with the
    // code, so the suite runs file-serially.
    fileParallelism: false,
  },
});
