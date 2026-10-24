import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TenantContextSchema, MarketplaceCapabilitySnapshotViewSchema } from "@yummyai/contracts";
import { StoreNodeWorkspaceSchema } from "@yummyai/contracts/marketplace/store-node";
import { connectDatabase, migrateDatabase, withTenant, marketplaceAccounts, marketplaceCredentials, marketplaceAuthorizationSessions,
  marketplaceCapabilitySnapshots, marketplaceStoreNodes, marketplaceStoreNodeBindings } from "@yummyai/database";
import { requireStoreNodeExecutionEnvironment } from "../../../../tools/testing/require-store-node-execution-environment.mjs";
import { assertStoreNodeExecutionOriginal179Graph } from "./store-node-execution-graph.test-fixture.js";
import { executionBounded } from "./store-node-execution-provider.test-fixture.js";

const target = requireStoreNodeExecutionEnvironment(process.env, "pre-0180"), database = connectDatabase(target.url), root = fileURLToPath(new URL("../../../../", import.meta.url));
const Row = z.record(z.string(), z.unknown()), Id = z.uuidv7();
const Seed = z.object({ type: z.literal("store.node.execution.seeded179"), nonce: z.literal(target.nonce), context: TenantContextSchema, accountId: Id, nodeId: Id,
  rows: z.object({ accounts: z.array(Row), credentials: z.array(Row), sessions: z.array(Row), capabilities: z.array(Row), nodes: z.array(Row), bindings: z.array(Row) }).strict(),
  latest: MarketplaceCapabilitySnapshotViewSchema, sequence: z.int().positive() }).strict();
const Checked = z.object({ type: z.literal("store.node.execution.checked179"), nonce: z.literal(target.nonce), latest: MarketplaceCapabilitySnapshotViewSchema,
  beforeExecution: StoreNodeWorkspaceSchema.shape.execution, after: StoreNodeWorkspaceSchema, providerUnchanged: z.literal(true), originalCli: z.literal(true) }).strict();
let child: ChildProcess | undefined, exited: Promise<void> | undefined;
afterAll(async () => { const errors: unknown[] = [];
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try { if (exited) await executionBounded(exited, "store_node_execution_upgrade_exit_deadline", 10_000); } catch (error) { errors.push(error); }
  try { await database.client.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Store node execution upgrade cleanup failed");
});

describe("genuine original179 source to180 node execution migration", () => {
  it("preserves every original marketplace and enrolled-node column and continues the original179 CLI heartbeat without adopting platform execution", async () => {
    const source = process.env.E2E_STORE_NODE_EXECUTION_LEGACY_SOURCE!; await assertStoreNodeExecutionOriginal179Graph(source);
    const waits = new Map<string, { done(raw: unknown): void; fail(error: Error): void }>();
    const receive = (type: string) => new Promise<unknown>((done, fail) => waits.set(type, { done, fail }));
    const seeded = receive("store.node.execution.seeded179"), checked = receive("store.node.execution.checked179"); void checked.catch(() => {});
    let startupCode: string | null = null, startupErrorName: string | null = null, missingExport: string | null = null;
    child = spawn(process.execPath, ["--import", pathToFileURL(resolve(source, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/marketplaces/store-node-execution-legacy.test-fixture.ts"), "--store-node-execution-original179-child"], { cwd: resolve(source, "apps/api"), windowsHide: true,
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(source, "apps/api/tsconfig.json") }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr?.on("data", (bytes: Buffer) => { const text = bytes.toString("utf8"), code = /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)\b/.exec(text); if (code) startupCode ??= code[1]!;
      const name = /\b(SyntaxError|ReferenceError|TypeError|RangeError)\b/.exec(text); if (name) startupErrorName ??= name[1]!;
      const symbol = /does not provide an export named '(marketplaceStoreNodeExecutions|marketplaceStoreNodeExecutionSteps|StoreNodeExecutionService|StoreNodeExecutionRuntime)'/.exec(text); if (symbol) missingExport ??= symbol[1]!;
    });
    exited = new Promise(done => child!.once("exit", (code, signal) => { for (const waiter of waits.values()) waiter.fail(new Error("store_node_original179_exit:" + JSON.stringify({ code, signal, startupCode, startupErrorName, missingExport }))); waits.clear(); done(); }));
    child.on("message", raw => { if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") return;
      if (raw.type === "store.node.execution.failed179") {
        const safe = z.object({ type: z.literal("store.node.execution.failed179"), phase: z.string().regex(/^original179_[a-z_]+$/),
          code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/).nullable(), errorName: z.string().regex(/^[A-Za-z]{1,40}$/),
          location: z.object({ file: z.string().regex(/^[A-Za-z0-9_./-]+$/), line: z.int().positive() }).strict().nullable() }).strict().safeParse(raw);
        for (const waiter of waits.values()) waiter.fail(new Error("store_node_original179_failure:" + JSON.stringify(safe.success ? safe.data : { phase: "invalid_safe_diagnostic" }))); waits.clear();
      } else { const waiter = waits.get(raw.type); if (waiter) { waits.delete(raw.type); waiter.done(raw); } }
    });
    child.once("error", () => { for (const waiter of waits.values()) waiter.fail(new Error("store_node_execution_upgrade_spawn_failed")); waits.clear(); });
    const seed = Seed.parse(await executionBounded(seeded, "store_node_original179_seed_deadline", 150_000));
    await migrateDatabase(database); expect((await database.client.unsafe("select count(*)::int count from drizzle.__drizzle_migrations"))[0]?.count).toBe(180);
    const current = await withTenant(database.db, seed.context, async tx => ({ accounts: await tx.select().from(marketplaceAccounts), credentials: await tx.select().from(marketplaceCredentials),
      sessions: await tx.select().from(marketplaceAuthorizationSessions), capabilities: await tx.select().from(marketplaceCapabilitySnapshots), nodes: await tx.select().from(marketplaceStoreNodes), bindings: await tx.select().from(marketplaceStoreNodeBindings) }));
    const columns: Record<string, object> = {};
    for (const name of ["accounts", "credentials", "sessions", "capabilities", "nodes", "bindings"] as const) {
      const actual = JSON.parse(JSON.stringify(current[name])) as Array<z.infer<typeof Row>>; expect(actual).toHaveLength(seed.rows[name].length);
      for (const row of seed.rows[name]) { const found = actual.find(value => value.id === row.id); expect(found).toBeDefined(); expect(Object.fromEntries(Object.keys(row).map(key => [key, found![key]]))).toEqual(row); }
      columns[name] = { rows: actual.length, columns: Object.keys(seed.rows[name][0] ?? {}).sort(), allOldColumnValuesEqual: true };
    }
    const newRows = await withTenant(database.db, seed.context, async tx => {
      const execution = await tx.execute<{ count: number }>(await import("drizzle-orm").then(({ sql }) => sql`select count(*)::int count from marketplace_store_node_executions`));
      const steps = await tx.execute<{ count: number }>(await import("drizzle-orm").then(({ sql }) => sql`select count(*)::int count from marketplace_store_node_execution_steps`));
      return { execution: execution[0]!.count, steps: steps[0]!.count };
    }); expect(newRows).toEqual({ execution: 0, steps: 0 });
    child.send({ type: "store.node.execution.check179", nonce: target.nonce }); const old = Checked.parse(await executionBounded(checked, "store_node_original179_owner_deadline", 45_000));
    expect(old.latest).toEqual(seed.latest); expect(old.beforeExecution).toEqual({ status: "not_integrated", supportsPlatformOperations: false }); expect(old.after.execution).toEqual(old.beforeExecution);
    const rows = await withTenant(database.db, seed.context, tx => tx.select().from(marketplaceStoreNodes)); expect(rows.find(value => value.id === seed.nodeId)!.lastSequence).toBeGreaterThan(seed.sequence);
    await executionBounded(exited!, "store_node_original179_exit_deadline", 30_000); expect(child.exitCode).toBe(0);
    const graph = JSON.parse(await readFile(resolve(root, "docs/project-control/checkpoints/2026-10-22-store-node-execution-e6f2c8a1-old179-source.json"), "utf8")) as { sourceSha256: string };
    await writeFile(resolve(root, "tmp/store-node-execution-20261022-e6f2c8a1/qa", target.nonce + "-upgrade-proof.json"), JSON.stringify({ operation: "e6f2c8a1", sourceSchema: 179, targetSchema: 180,
      originalSourceFiles: 3531, pinnedLinks: 399, originalSourceSha256: graph.sourceSha256, preserved: columns, emptyNewTables: newRows,
      actualOriginalCliResumed: true, oldHeartbeatProtocol: "erp-store-node-v1", originalCapabilityReceiptUnchanged: true, additionalProviderCalls: 0, childExit: child.exitCode }));
  });
});
