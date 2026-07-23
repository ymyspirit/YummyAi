import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");

const filters = process.argv.slice(2).filter((value) => value !== "--");
const joined = filters.join(" ");
const configs = joined.includes("capture")
  ? ["apps/extension/playwright.config.ts"]
  : joined.includes("p0-flow") || joined.includes("tenant-isolation") || joined.includes("inventory")
    ? ["apps/web/playwright.config.ts"]
    : ["apps/web/playwright.config.ts", "apps/extension/playwright.config.ts"];

for (const config of configs) {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, "test", "-c", config, ...filters], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (status.signal) {
    process.stderr.write(`Playwright exited after receiving ${status.signal}.\n`);
    process.exit(1);
  }
  if (status.code !== 0) process.exit(status.code ?? 1);
}
