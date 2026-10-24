import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TenantContextSchema, MarketplacePublicationRequestViewSchema, MarketplacePublicationEventViewSchema, type TenantContext } from "@yummyai/contracts";
import { PublicationPreviewRequestViewSchema } from "@yummyai/contracts/marketplace/publication-preview";
import { connectDatabase, migrateDatabase, withTenant, marketplacePublicationIntents, marketplacePublicationNodeOperations, marketplacePublicationNodeResults } from "@yummyai/database";
import { createQueue, QueueName } from "@yummyai/jobs";
import { createMarketplaceSecretVault, HttpMarketplaceAuthorizationGateway } from "@yummyai/marketplace-connectors";
import { requirePublicationNodeSubmitEnvironment } from "../../../../tools/testing/publication-node-submit-environment.mjs";
import { publicationSubmitLegacyCellSha, publicationSubmitLegacyTables } from "../../../../tools/testing/publication-node-submit-legacy-upgrade.mjs";
import { assertPublicationNodeSubmitOriginal182Graph, original182GraphPath, original182Root } from "./publication-node-submit-graph.test-fixture.js";
import { executionBounded } from "./publication-node-preview-provider.test-fixture.js";
import { AuditService } from "../audit/audit.service.js";
import { MarketplacePublicationService } from "./marketplace-publication.service.js";
import { RedisMarketplacePublicationEnqueuer } from "./redis-marketplace-publication-enqueuer.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";

const isolated = requirePublicationNodeSubmitEnvironment(process.env, "pre-0183"), root = fileURLToPath(new URL("../../../../", import.meta.url)),
  database = connectDatabase(isolated.url), Digest = z.string().regex(/^[a-f0-9]{64}$/), Id = z.uuidv7();
const Row = z.object({ key: z.string().min(1).max(100), columns: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), Digest) }).strict();
const Seed = z.object({ type: z.literal("publication.submit.seeded182"), nonce: z.literal(isolated.nonce), context: TenantContextSchema,
  original: MarketplacePublicationRequestViewSchema, preview: MarketplacePublicationRequestViewSchema, waiting: MarketplacePublicationRequestViewSchema,
  unknown: MarketplacePublicationRequestViewSchema, anchorAccountId: Id,
  rows: z.array(z.object({ table: z.enum(publicationSubmitLegacyTables), columns: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)), rows: z.array(Row) }).strict()),
  providerCounts: z.record(z.string(), z.int().nonnegative()), serviceClose: z.object({ apiClosed: z.literal(true), bootstrapClosed: z.literal(true), providerClosed: z.literal(true), databaseClosed: z.literal(true) }).passthrough(),
  environmentBoundary: z.object({ parentTarget: z.literal("pre-0183"), childTarget: z.literal("current"), originalRoot: z.literal(original182Root), oldFixtureLaneInsideOwnedCopy: z.literal(true) }).strict(),
  syntheticHistoricalAssetMetadata: z.literal(true) }).strict();
const Checked = z.object({ type: z.literal("publication.submit.checked182"), nonce: z.literal(isolated.nonce), original: MarketplacePublicationRequestViewSchema,
  events: MarketplacePublicationEventViewSchema.array(), preview: PublicationPreviewRequestViewSchema, originalReaderSource: z.literal("frozen182"),
  cliStarted: z.literal(false), databaseClosed: z.literal(true), queueClosed: z.literal(true) }).strict();
const Failed = z.object({ type: z.literal("publication.submit.failed182"), phase: z.string().regex(/^original182_[a-z_]+$/),
  code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/).nullable(), errorName: z.string().regex(/^[A-Za-z]{1,40}$/),
  constructorName: z.string().regex(/^[A-Za-z]{1,50}$/), location: z.object({ file: z.string().regex(/^[A-Za-z0-9_./@+-]+$/), line: z.int().positive() }).strict().nullable() }).strict();
let child: ChildProcess | undefined, exit: Promise<void> | undefined, producer: RedisMarketplacePublicationEnqueuer | undefined, queue: ReturnType<typeof createQueue> | undefined;
let anchor: { context: TenantContext; id: string } | undefined;
const queueIds = new Set<string>();
const waiters = new Map<string, { done(value: unknown): void; fail(error: Error): void }>();
function startOriginal(mode: "seed" | "read") {
  let startupCode: string | null = null, startupErrorName: string | null = null;
  const running = spawn(process.execPath, ["--import", pathToFileURL(resolve(original182Root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
    resolve(root, "tools/testing/publication-node-submit-legacy-upgrade.mts"), `--publication-node-submit-original182-${mode}-child`], {
    cwd: resolve(original182Root, "apps/api"), windowsHide: true,
    env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(original182Root, "apps/api/tsconfig.json") }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  child = running;
  running.stderr?.on("data", (bytes: Buffer) => {
    const text = bytes.toString("utf8"); startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)\b/.exec(text)?.[1] ?? null;
    startupErrorName ??= /\b(SyntaxError|ReferenceError|TypeError|RangeError|TransformError)\b/.exec(text)?.[1] ?? null;
  });
  running.on("message", raw => {
    const failure = Failed.safeParse(raw); if (failure.success) { for (const waiter of waiters.values()) waiter.fail(new Error(JSON.stringify(failure.data))); waiters.clear(); return; }
    if (raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string" && "nonce" in raw && raw.nonce === isolated.nonce) {
      waiters.get(raw.type)?.done(raw); waiters.delete(raw.type);
    }
  });
  exit = new Promise<void>(done => running.once("exit", (code, signal) => {
    for (const waiter of waiters.values()) waiter.fail(new Error(JSON.stringify({ code: "publication_submit_original182_early_exit", mode, exitCode: code, signal, startupCode, startupErrorName })));
    waiters.clear(); done();
  }));
  return running;
}
afterAll(async () => {
  const errors: unknown[] = [];
  if (child?.connected) child.send({ operation: "close" });
  if (exit) try { await executionBounded(exit, "publication_submit_original182_graceful_exit_deadline", 10_000); }
    catch (error) { errors.push(error); if (child?.exitCode === null) child.kill("SIGKILL"); try { await executionBounded(exit, "publication_submit_original182_kill_deadline", 5000); } catch (failure) { errors.push(failure); } }
  try { for (const id of queueIds) await (await queue?.getJob(id))?.remove(); } catch (error) { errors.push(error); }
  try { await queue?.close(); await producer?.onModuleDestroy(); } catch (error) { errors.push(error); }
  if (anchor) try { await new MarketplaceAuthorizationService(database, createMarketplaceSecretVault(), new HttpMarketplaceAuthorizationGateway(), new AuditService(database))
    .revoke(anchor.context, anchor.id); } catch (error) { errors.push(error); }
  try { await database.client.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "publication_submit_upgrade_cleanup_failed");
});

describe("genuine original182 node preview and central child to183 independent submission operations", () => {
  it("preserves_every_original_column_and_route keeps old hashes and real cached preview history without dispatching an old central child", async () => {
    await assertPublicationNodeSubmitOriginal182Graph(process.env.E2E_PUBLICATION_NODE_SUBMIT_LEGACY_SOURCE!);
    const parentTarget = process.env.E2E_LEGACY_SCHEMA_TARGET, receive = (type: string) => new Promise<unknown>((done, fail) => waiters.set(type, { done, fail })),
      seeded = receive("publication.submit.seeded182"), seedProcess = startOriginal("seed");
    const seed = Seed.parse(await executionBounded(seeded, "publication_submit_original182_seed_deadline", 130_000));
    await executionBounded(exit!, "publication_submit_original182_seed_exit_deadline", 10_000); expect(seedProcess.exitCode).toBe(0);
    anchor = { context: seed.context, id: seed.anchorAccountId }; queueIds.add(seed.original.id);
    expect(process.env.E2E_LEGACY_SCHEMA_TARGET).toBe(parentTarget); expect(seed.preview.current.status).toBe("validation_passed");
    expect(seed.unknown.current.status).toBe("reconciliation_required"); expect(seed.waiting.current.status).toBe("queued");
    expect(seed.original).toMatchObject({ action: "amazon_submit", parentRequestId: seed.preview.id, current: { status: "queued" } });
    expect(seed.providerCounts.amazon_listing_submit ?? 0).toBe(0);
    expect(seed.rows.map(row => row.table)).toEqual([...publicationSubmitLegacyTables]);
    expect(seed.rows.find(row => row.table === "marketplace_credentials")!.rows.length).toBeGreaterThan(0);
    expect(seed.rows.find(row => row.table === "marketplace_store_node_execution_steps")!.rows.length).toBeGreaterThan(0);
    const graph = JSON.parse(await readFile(original182GraphPath, "utf8")) as { links: unknown[]; sourceSha256: string; sourceFiles: number };
    queue = createQueue(QueueName.Publication); const queueBefore = await queue.getJobCounts();
    await migrateDatabase(database); const [ledger] = await database.client.unsafe("select count(*)::int as count from drizzle.__drizzle_migrations"); expect(ledger?.count).toBe(183);
    const preserved = await withTenant(database.db, seed.context, async tx => {
      const summaries: Array<{ table: string; rows: number; columns: number; everyOriginalValueEqual: true }> = [];
      for (const old of seed.rows) {
        const selected = await tx.execute<Record<string, unknown>>(sql.raw("select * from " + old.table)), actual = new Map(selected.map(row => [String(row.id ?? row.account_id), row]));
        expect(actual.size, old.table).toBe(old.rows.length);
        for (const row of old.rows) {
          const value = actual.get(row.key); expect(value, old.table + ":" + row.key).toBeDefined();
          for (const column of old.columns) expect(publicationSubmitLegacyCellSha(value![column]), old.table + ":" + column).toBe(row.columns[column]);
        }
        summaries.push({ table: old.table, rows: old.rows.length, columns: old.columns.length, everyOriginalValueEqual: true });
      }
      expect(await tx.select().from(marketplacePublicationNodeOperations)).toEqual([]); expect(await tx.select().from(marketplacePublicationNodeResults)).toEqual([]);
      const originalIntent = (await tx.select().from(marketplacePublicationIntents)).find(row => row.requestId === seed.original.id);
      expect(originalIntent?.route).toBe("central"); expect(originalIntent?.nodeExecutionId).toBeNull(); return summaries;
    });
    producer = new RedisMarketplacePublicationEnqueuer(); const owner = new MarketplacePublicationService(database, producer, new AuditService(database));
    expect((await owner.get(seed.context, seed.original.id)).payloadChecksum).toBe(seed.original.payloadChecksum);
    expect((await owner.getPreview(seed.context, seed.preview.id)).request.id).toBe(seed.preview.id);
    await expect(owner.getSubmission(seed.context, seed.original.id)).rejects.toMatchObject({ status: 404 });
    const ready = receive("publication.submit.reader.ready182"), checked = receive("publication.submit.checked182"); void checked.catch(() => {});
    const readProcess = startOriginal("read");
    await executionBounded(ready, "publication_submit_original182_reader_ready_deadline", 20_000);
    readProcess.send({ operation: "read", context: seed.context, requestId: seed.original.id, previewId: seed.preview.id });
    const oldRead = Checked.parse(await executionBounded(checked, "publication_submit_original182_read_deadline", 30_000));
    expect(oldRead.original).toEqual(seed.original); expect(oldRead.preview.request.id).toBe(seed.preview.id);
    expect(await queue.getJobCounts()).toEqual(queueBefore);
    await executionBounded(exit!, "publication_submit_original182_exit_deadline", 10_000); expect(readProcess.exitCode).toBe(0); expect(readProcess.pid).not.toBe(seedProcess.pid);
    await writeFile(resolve(isolated.lane, isolated.nonce + "-upgrade-proof.json"), JSON.stringify({ operation: "74c2e8b1", sourceSchema: 182, targetSchema: 183,
      originalSourceFiles: graph.sourceFiles, originalSourceSha256: graph.sourceSha256, originalLinks: graph.links.length, preserved,
      originalPreviewId: seed.preview.id, originalCentralChildId: seed.original.id, originalChildRoute: "central", operationRowsBackfilled: 0,
      extraCentralEnqueues: 0, originalReaderProviderDelta: 0, originalReaderSource: oldRead.originalReaderSource, environmentBoundary: seed.environmentBoundary,
      originalServicesClosedBeforeMigration: true, seedProcess: { pid: seedProcess.pid, exitCode: seedProcess.exitCode },
      readProcess: { pid: readProcess.pid, exitCode: readProcess.exitCode, cliStarted: false, databaseClosed: oldRead.databaseClosed, queueClosed: oldRead.queueClosed }, actualSellerPublication: false }));
  });
});
