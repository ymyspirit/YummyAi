import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRestartPostgres, removeRestartPostgres } from "./isolated-postgres.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const option = process.argv.find(value => value.startsWith("--record="))?.slice("--record=".length);
if (!option || !/^docs\/project-control\/checkpoints\/2026-10-20-production-restart-[a-f0-9]{8}-attempt[0-9]+\.json$/.test(option)) throw Error("Fresh checkpoint record required");
const record = path.join(root, option);
await fs.writeFile(record, "{}\n", { flag: "wx" });
const operationId = randomUUID().replaceAll("-", ""), startedAt = new Date().toISOString();
let target: Awaited<ReturnType<typeof createRestartPostgres>> | undefined;
let exitCode = 1;
const result: Record<string, unknown> = { operationId, startedAt, phase: "creating_isolated_postgres", ordinaryDatabaseRestarted: false, ordinaryWorkerStarted: false };
const save = () => fs.writeFile(record, JSON.stringify(result, null, 2) + "\n");
await save();
try {
  target = await createRestartPostgres(operationId);
  result.postgres = target.identity; result.phase = "running_restart_acceptance"; await save();
  exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--env-file=.env", "--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "tools/scripts/run-order-daily-acceptance.mts", "--suite=production-command-restart"], {
      cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env, DATABASE_URL: target!.databaseUrl,
        YUMMYAI_RESTART_POSTGRES: JSON.stringify(target!.identity), TSX_DISABLE_CACHE: "1" },
    });
    result.runnerPid = child.pid; void save(); child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
  result.testExitCode = exitCode;
} catch (error) {
  // Keep credentials out of operational records and wrapper output.
  result.failure = error instanceof Error ? error.name : "unknown";
  process.stderr.write("Isolated production restart acceptance failed\n");
} finally {
  if (target) {
    try { result.cleanup = await removeRestartPostgres(target.identity); }
    catch { result.cleanupFailed = true; exitCode = 1; }
  }
  result.phase = "finished"; result.finishedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({ productionRestartContainer: result }) + "\n");
}
process.exitCode = exitCode;
