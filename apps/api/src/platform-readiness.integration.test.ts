import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connectDatabase } from "@yummyai/database";
import { expect, it } from "vitest";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
  throw new Error("API startup acceptance requires disposable resources");

it.each([
  { entryPoint: "API startup", arguments: ["src/main.ts"] },
  { entryPoint: "Database readiness CLI", arguments: [fileURLToPath(new URL("../../../packages/database/src/migrate.ts", import.meta.url)), "--check"] },
])("$entryPoint rejects missing migrations without creating schema or opening an HTTP server", async ({ entryPoint, arguments: entryArguments }) => {
  const source = new URL(process.env.DATABASE_URL!), target = new URL(source), adminUrl = new URL(source);
  const name = `order_daily_e2e_${randomUUID().replaceAll("-", "")}`;
  target.pathname = `/${name}`; adminUrl.pathname = "/postgres";
  if (target.pathname === source.pathname || !/^order_daily_e2e_[a-f0-9]{32}$/.test(name)) throw new Error("Unsafe startup fixture");
  const admin = connectDatabase(adminUrl.href); let created = false, removed = false, tables = -1;
  try {
    await admin.client.unsafe(`create database ${name}`); created = true;
    let code: unknown, stderr = "", stdout = "";
    try {
      await promisify(execFile)(process.execPath, ["--import", "tsx", ...entryArguments], {
        // Cold TypeScript imports share CPU with the isolated suite. Keep the
        // exact exit/diagnostic/no-schema assertions below after this deadline.
        cwd: fileURLToPath(new URL("../", import.meta.url)), windowsHide: true, timeout: 45000, maxBuffer: 512 * 1024,
        env: { ...process.env, DATABASE_URL: target.href, PORT: "0", TSX_DISABLE_CACHE: "1" },
      });
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: string; stdout?: string };
      code = failure.code; stderr = failure.stderr ?? ""; stdout = failure.stdout ?? "";
    }
    const fixture = connectDatabase(target.href);
    try {
      const [count] = await fixture.client.unsafe("select count(*)::int as count from information_schema.tables where table_schema in ('public','drizzle')");
      tables = count.count;
    } finally { await fixture.client.end(); }
    expect({ code, createdTables: tables, openedServer: stdout.includes("API listening") }).toEqual({ code: 1, createdTables: 0, openedServer: false });
    expect(stderr + stdout).toContain("Database migrations do not match the current application code");
  } finally {
    if (created) {
      await admin.client.unsafe(`drop database ${name} with (force)`);
      removed = (await admin.client.unsafe("select datname from pg_database where datname=$1", [name])).length === 0;
    }
    await admin.client.end();
    process.stdout.write(JSON.stringify({ apiReadinessDatabaseProof: { entryPoint, database: name, createdTables: tables, databaseDeleted: removed, ordinaryDatabaseTouched: false } }) + "\n");
    expect(!created || removed).toBe(true);
  }
}, 60000);
