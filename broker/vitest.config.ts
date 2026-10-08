import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["**/*.test.ts"],
    environment: "node",
    globals: true,
    exclude: ["node_modules/**", "dist/**"],
  },
});
