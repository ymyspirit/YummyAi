import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { join } from "node:path";

// Upgrade suites own genuine historical databases; they cannot share a fully migrated suite database.
const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length > 2) throw new Error("Use the disposable targeted runner for filtered integration suites");
const suites = ["all-integration", "creative-recovery-integration", "incoming-process-integration", "quality-upgrade-integration", "shipment-upgrade-integration", "quality-groups-upgrade-integration", "manufacturing-upgrade-integration", "manufacturing-delivery-upgrade-integration", "shipos-upgrade-integration", "inventory-upgrade-integration", "receipt-request-upgrade-integration", "incoming-upgrade-integration", "procurement-upgrade-integration"];
const results = [];
for (const suite of suites) {
  const env = { ...process.env };
  if (env.YUMMYAI_TEST_CACHE_DIR) env.YUMMYAI_TEST_CACHE_DIR = join(env.YUMMYAI_TEST_CACHE_DIR, suite);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href, join(root, "tools/scripts/run-order-daily-acceptance.mts"), "--suite=" + suite,
      ...(suite === "all-integration" ? [] : ["--cache=false"])],
      { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
  results.push({ suite, exitCode: code });
}
process.stdout.write(JSON.stringify({ integrationAcceptance: results, passed: results.every(result => result.exitCode === 0) }) + "\n");
process.exitCode = results.every(result => result.exitCode === 0) ? 0 : 1;
