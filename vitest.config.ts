import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.tmp/**", "**/.worktrees/**"],
    // SQLite-heavy suites can saturate Windows CI disks when every core spawns a worker.
    maxWorkers: process.env.CI && process.platform === "win32" ? 1 : undefined,
  },
});
