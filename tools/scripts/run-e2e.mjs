import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");

const filters = process.argv.slice(2).filter((value) => value !== "--");
const joined = filters.join(" ");
const configs = joined.includes("capture")
  ? ["apps/extension/playwright.config.ts"]
  : joined.includes("p0-flow") || joined.includes("tenant-isolation")
    ? ["apps/web/playwright.config.ts"]
    : ["apps/web/playwright.config.ts", "apps/extension/playwright.config.ts"];

for (const config of configs) {
  const result = spawnSync(process.execPath, [playwrightCli, "test", "-c", config, ...filters], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
