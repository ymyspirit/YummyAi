import process from "node:process";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(process.platform === "win32" ? [] : ["src/**/*.windows.test.ts"])],
    passWithNoTests: false,
    cache: false,
  },
});
