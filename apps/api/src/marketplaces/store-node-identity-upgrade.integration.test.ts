import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TenantContextSchema, MarketplaceCapabilitySnapshotViewSchema } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase, withTenant, marketplaceAccounts, marketplaceCredentials, marketplaceAuthorizationSessions, marketplaceCapabilitySnapshots,
  marketplaceStoreNodes, marketplaceStoreNodeBindings } from "@yummyai/database";
import { requireStoreNodeIdentityEnvironment } from "../../../../tools/testing/require-store-node-identity-environment.mjs";
import { authorityBounded } from "../../../../tools/testing/marketplace-authority-legacy-upgrade.mjs";
import { assertStoreNodeOriginal178Graph, nodeIdentitySha } from "./store-node-identity.test-fixture.js";
import { MarketplaceAuthorityWorkspaceService } from "./marketplace-authority-workspace.service.js";

const target = requireStoreNodeIdentityEnvironment(process.env, "pre-0179"), database = connectDatabase(target.url);
const root = fileURLToPath(new URL("../../../../", import.meta.url)), Row = z.record(z.string(), z.unknown());
const Seed = z.object({ type: z.literal("store.node.seeded178"), nonce: z.literal(target.nonce), context: TenantContextSchema, activeId: z.uuidv7(), pendingId: z.uuidv7(),
  rows: z.object({ accounts: z.array(Row), credentials: z.array(Row), sessions: z.array(Row), capabilities: z.array(Row) }).strict(),
  latest: MarketplaceCapabilitySnapshotViewSchema, counts: z.record(z.string(), z.number()) }).strict();
const Checked = z.object({ type: z.literal("store.node.checked178"), nonce: z.literal(target.nonce), activeId: z.uuidv7(), status: z.literal("active"),
  latest: MarketplaceCapabilitySnapshotViewSchema, pendingStatus: z.literal("active"), counts: z.record(z.string(), z.number()),
  stages: z.object({ beforeOwnerReads: z.record(z.string(), z.number()), afterOwnerReads: z.record(z.string(), z.number()), afterOAuth: z.record(z.string(), z.number()), afterSync: z.record(z.string(), z.number()) }).strict(),
  requestKinds: z.array(z.enum(["shop", "sections", "return_policies", "taxonomy", "shipping_profiles", "readiness_profiles", "unexpected"])) }).strict();
let child: ChildProcess | undefined, exited: Promise<void> | undefined;
afterAll(async () => { const failures: unknown[] = [];
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try { if (exited) await authorityBounded(exited, "store_node_upgrade_child_exit_timeout", 10_000); } catch (error) { failures.push(error); }
  try { await database.client.end(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "store_node_upgrade_cleanup_failed"); });

describe("genuine original178 to179 node identity additive migration", () => {
  it("preserves every original account credential OAuth and capability column and leaves old owner flows operational without backfilling node authority", async () => {
    const source = process.env.E2E_STORE_NODE_LEGACY_SOURCE!; await assertStoreNodeOriginal178Graph(source);
    const waiting = new Map<string, { done(value: unknown): void; reject(error: Error): void }>();
    const receive = (kind: string) => new Promise<unknown>((done, reject) => waiting.set(kind, { done, reject }));
    const seeded = receive("store.node.seeded178"), checked = receive("store.node.checked178"); void checked.catch(() => {});
    let startupCode: string | null = null, startupErrorName: string | null = null, missingExport: string | null = null;
    child = spawn(process.execPath, ["--import", pathToFileURL(resolve(source, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/marketplaces/store-node-identity-legacy.test-fixture.ts"), "--store-node-original178-child"], {
      cwd: resolve(source, "apps/api"), windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(source, "apps/api/tsconfig.json") } });
    child.stderr?.on("data", (bytes: Buffer) => { const text = bytes.toString("utf8"), match = /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)\b/.exec(text); if (match) startupCode ??= match[1]!;
      const name = /\b(SyntaxError|ReferenceError|TypeError|RangeError)\b/.exec(text); if (name) startupErrorName ??= name[1]!;
      const symbol = /does not provide an export named '(marketplaceStoreNodes|marketplaceStoreNodeBindings|StoreNodeWorkspaceSchema|StoreNodeService)'/.exec(text); if (symbol) missingExport ??= symbol[1]!;
    });
    exited = new Promise(done => child!.once("exit", (code, signal) => { for (const waiter of waiting.values()) waiter.reject(new Error("store_node_original178_exit:" + JSON.stringify({ code, signal, startupCode, startupErrorName, missingExport }))); waiting.clear(); done(); }));
    child.on("message", raw => { if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") return;
      if (raw.type === "store.node.failed178") { const safe = z.object({ type: z.literal("store.node.failed178"), phase: z.string().regex(/^original178_[a-z_]+$/),
        code: z.string().regex(/^[A-Z0-9_]{1,80}$/).nullable(), errorName: z.string().regex(/^[A-Za-z]{1,40}$/), location: z.object({ file: z.string().regex(/^[A-Za-z0-9_./-]+$/), line: z.int().positive() }).strict().nullable() }).strict().safeParse(raw);
        for (const waiter of waiting.values()) waiter.reject(new Error("store_node_original178_failure:" + JSON.stringify(safe.success ? safe.data : { phase: "invalid_safe_diagnostic" }))); waiting.clear();
      } else { const waiter = waiting.get(raw.type); if (waiter) { waiting.delete(raw.type); waiter.done(raw); } }
    });
    child.once("error", () => { for (const waiter of waiting.values()) waiter.reject(new Error("store_node_original178_spawn_failed")); waiting.clear(); });
    const seed = Seed.parse(await authorityBounded(seeded, "store_node_original178_seed_timeout", 120_000));
    await migrateDatabase(database); const [migration] = await database.client.unsafe("select count(*)::int as count from drizzle.__drizzle_migrations"); expect(migration?.count).toBe(179);
    const current = await withTenant(database.db, seed.context, async tx => ({ accounts: await tx.select().from(marketplaceAccounts), credentials: await tx.select().from(marketplaceCredentials),
      sessions: await tx.select().from(marketplaceAuthorizationSessions), capabilities: await tx.select().from(marketplaceCapabilitySnapshots), nodes: await tx.select().from(marketplaceStoreNodes), bindings: await tx.select().from(marketplaceStoreNodeBindings) }));
    for (const name of ["accounts", "credentials", "sessions", "capabilities"] as const) {
      const actual = JSON.parse(JSON.stringify(current[name])) as Array<Record<string, unknown>>;
      expect(actual).toHaveLength(seed.rows[name].length);
      for (const row of seed.rows[name]) { const match = actual.find(value => value.id === row.id); expect(match).toBeDefined();
        expect(Object.fromEntries(Object.keys(row).map(key => [key, match![key]]))).toEqual(row); }
    }
    expect(current.nodes).toEqual([]); expect(current.bindings).toEqual([]);
    const authority = await new MarketplaceAuthorityWorkspaceService(database).get(seed.context, seed.activeId);
    expect(authority.account.status).toBe("active"); expect(authority.lifecycle.capabilityCurrent).toBe(true);
    child.send({ type: "store.node.check178", nonce: target.nonce });
    const old = Checked.parse(await authorityBounded(checked, "store_node_original178_owner_timeout")); expect(old.activeId).toBe(seed.activeId); expect(old.latest).toEqual(seed.latest);
    expect(old.stages.beforeOwnerReads).toEqual(seed.counts); expect(old.stages.afterOwnerReads).toEqual(old.stages.beforeOwnerReads);
    expect(old.stages.afterOAuth.oauth! - old.stages.afterOwnerReads.oauth!).toBe(1); expect(old.stages.afterOAuth.read).toBe(old.stages.afterOwnerReads.read);
    expect(old.stages.afterSync.read! - old.stages.afterOAuth.read!).toBe(6); expect(old.stages.afterSync.refresh! - old.stages.afterOAuth.refresh!).toBe(1);
    expect(old.counts.oauth! - seed.counts.oauth!).toBe(1); expect(old.counts.read! - seed.counts.read!).toBe(6);
    expect([...old.requestKinds].sort()).toEqual(["shop", "sections", "return_policies", "taxonomy", "shipping_profiles", "readiness_profiles"].sort());
    await authorityBounded(exited!, "store_node_original178_close_timeout"); expect(child.exitCode).toBe(0);
    await writeFile(resolve(root, "tmp/store-node-identity-20261022-c7e3a6d2/qa", target.nonce + "-upgrade-proof.json"), JSON.stringify({ operation: "c7e3a6d2", sourceSchema: 178, targetSchema: 179,
      originalSource: "3487 exact source files and392 pinned workspace links", preservedColumns: Object.fromEntries(Object.entries(seed.rows).map(([name, rows]) => [name, { rows: rows.length, columns: rows[0] ? Object.keys(rows[0]).sort() : [], sha256: nodeIdentitySha(JSON.stringify(rows)) }])),
      oldPendingOAuthCompletedByReal178Owner: true, oldCapabilityReceiptUnchanged: true, oldGetAndLatestExternalCalls: 0, oldSyncReadRequests: old.requestKinds,
      oldSyncRefreshes: 1, newNodes: 0, newBindings: 0, noNodeBackfill: true, childExit: child.exitCode }));
  });
});
