import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEntityId, TenantContextSchema, MarketplacePublicationRequestViewSchema, MarketplacePublicationEventViewSchema } from "@yummyai/contracts";
import { PublicationPreviewRequestViewSchema, PublicationPreviewReceiptSchema } from "@yummyai/contracts/marketplace/publication-preview";
import { connectDatabase, migrateDatabase, withTenant, marketplaceAccounts, marketplaceCapabilitySnapshots, productPlans, spus, assetFiles,
  listings, listingVersions, marketplacePublicationRequests, marketplacePublicationEvents, marketplacePublicationIntents,
  marketplaceStoreNodeExecutions, marketplaceStoreNodeExecutionSteps } from "@yummyai/database";
import { createQueue, QueueName } from "@yummyai/jobs";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { createMarketplaceSecretVault } from "@yummyai/marketplace-connectors";
import { requirePublicationNodePreviewEnvironment } from "../../../../tools/testing/publication-node-preview-environment.mjs";
import { assertPublicationNodePreviewOriginal181Graph } from "./publication-node-preview-graph.test-fixture.js";
import { MarketplacePublicationService } from "./marketplace-publication.service.js";
import { RedisMarketplacePublicationEnqueuer } from "./redis-marketplace-publication-enqueuer.js";
import { AuditService } from "../audit/audit.service.js";
import { DrizzlePublicationExecutionRepository } from "../../../worker/src/processors/marketplace-publication.processor.js";

const isolated = requirePublicationNodePreviewEnvironment(process.env, "pre-0182"), root = fileURLToPath(new URL("../../../../", import.meta.url));
const lane = resolve(root, "tmp/publication-node-preview-20261022-a6f4c2d9/qa"), database = connectDatabase(isolated.url), Row = z.record(z.string(), z.unknown());
const oldTables = ["accounts", "capabilities", "plans", "spus", "assets", "listings", "versions", "requests", "events", "executions", "steps"] as const;
const Seed = z.object({ type: z.literal("publication.preview.seeded181"), nonce: z.literal(isolated.nonce), context: TenantContextSchema,
  original: MarketplacePublicationRequestViewSchema, scheduled: MarketplacePublicationRequestViewSchema,
  rows: z.object({ accounts: z.array(Row), capabilities: z.array(Row), plans: z.array(Row), spus: z.array(Row), assets: z.array(Row), listings: z.array(Row),
    versions: z.array(Row), requests: z.array(Row), events: z.array(Row), executions: z.array(Row), steps: z.array(Row) }).strict(),
  enqueues: z.literal(2), syntheticHistoricalPrerequisites: z.literal(true) }).strict();
const Checked = z.object({ type: z.literal("publication.preview.checked181"), nonce: z.literal(isolated.nonce), original: MarketplacePublicationRequestViewSchema,
  events: z.array(MarketplacePublicationEventViewSchema), ids: z.array(z.uuidv7()), additionalEnqueues: z.literal(0) }).strict();
const Failed = z.object({ type: z.literal("publication.preview.failed181"), phase: z.string().regex(/^original181_[a-z_]+$/),
  code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/).nullable(),
  errorName: z.enum(["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError", "Other"]),
  constructorName: z.enum(["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError", "ZodError", "DrizzleQueryError", "DatabaseError", "ConflictException", "NotFoundException", "ServiceUnavailableException", "ForbiddenError", "Other"]),
  location: z.object({ file: z.string().regex(/^[A-Za-z0-9_./@+-]+$/), line: z.int().positive() }).strict().nullable() }).strict();
const bounded = async <T>(promise: Promise<T>, code: string, ms = 90_000) => { let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, fail) => { timer = setTimeout(() => fail(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); } };
let child: ChildProcess | undefined, exited: Promise<void> | undefined, producer: RedisMarketplacePublicationEnqueuer | undefined, queue: ReturnType<typeof createQueue> | undefined;
const queueIds = new Set<string>();
afterAll(async () => {
  const errors: unknown[] = [];
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try { if (exited) await bounded(exited, "publication_preview_original181_exit_deadline", 10_000); } catch (error) { errors.push(error); }
  try { for (const id of queueIds) await (await queue?.getJob(id))?.remove(); } catch (error) { errors.push(error); }
  try { await queue?.close(); await producer?.onModuleDestroy(); } catch (error) { errors.push(error); }
  try { await database.client.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Publication preview genuine181 teardown failed");
});

describe("genuine original181 Publication owner to182 node preview migration", () => {
  it("preserves all original column values and queued events without inventing a birth ceiling or dispatching old central requests", async () => {
    const source = process.env.E2E_PUBLICATION_NODE_PREVIEW_LEGACY_SOURCE!; await assertPublicationNodePreviewOriginal181Graph(source);
    const waits = new Map<string, { done(value: unknown): void; fail(error: Error): void }>();
    const receive = (type: string) => new Promise<unknown>((done, fail) => waits.set(type, { done, fail }));
    const seeded = receive("publication.preview.seeded181"), checked = receive("publication.preview.checked181"); void checked.catch(() => {});
    let startupCode: string | null = null, startupErrorName: string | null = null;
    child = spawn(process.execPath, ["--import", pathToFileURL(resolve(source, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/marketplaces/publication-node-preview-legacy.test-fixture.ts"), "--publication-node-preview-original181-child"], {
      cwd: resolve(source, "apps/api"), windowsHide: true, env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(source, "apps/api/tsconfig.json") },
      stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr?.on("data", (bytes: Buffer) => { const text = bytes.toString("utf8");
      startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)\b/.exec(text)?.[1] ?? null;
      startupErrorName ??= /\b(SyntaxError|ReferenceError|TypeError|RangeError|TransformError)\b/.exec(text)?.[1] ?? null;
    });
    child.on("message", raw => { const failure = Failed.safeParse(raw);
      if (failure.success) { for (const waiter of waits.values()) waiter.fail(new Error(JSON.stringify(failure.data))); waits.clear(); return; }
      if (raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string" && "nonce" in raw && raw.nonce === isolated.nonce) {
        waits.get(raw.type)?.done(raw); waits.delete(raw.type);
      }
    });
    exited = new Promise<void>(done => child!.once("exit", (code, signal) => {
      for (const waiter of waits.values()) waiter.fail(new Error(JSON.stringify({ code: "publication_preview_original181_early_exit", exitCode: code, signal, startupCode, startupErrorName })));
      waits.clear(); done();
    }));
    child.once("error", () => { for (const waiter of waits.values()) waiter.fail(new Error("publication_preview_original181_spawn_failed")); waits.clear(); });
    const seed = Seed.parse(await bounded(seeded, "publication_preview_original181_seed_deadline"));
    queueIds.add(seed.original.id); queueIds.add(seed.scheduled.id);
    expect(seed.original.action).toBe("amazon_validation_preview"); expect(seed.original.current.status).toBe("queued"); expect(seed.scheduled.current.status).toBe("scheduled");
    await migrateDatabase(database); expect((await database.client.unsafe("select count(*)::int count from drizzle.__drizzle_migrations"))[0]?.count).toBe(182);
    const actual = await withTenant(database.db, seed.context, async tx => ({ accounts: await tx.select().from(marketplaceAccounts), capabilities: await tx.select().from(marketplaceCapabilitySnapshots),
      plans: await tx.select().from(productPlans), spus: await tx.select().from(spus), assets: await tx.select().from(assetFiles), listings: await tx.select().from(listings), versions: await tx.select().from(listingVersions),
      requests: await tx.select().from(marketplacePublicationRequests), events: await tx.select().from(marketplacePublicationEvents), executions: await tx.select().from(marketplaceStoreNodeExecutions), steps: await tx.select().from(marketplaceStoreNodeExecutionSteps) }));
    const preserved: Record<string, object> = {};
    for (const name of oldTables) {
      const values = JSON.parse(JSON.stringify(actual[name])) as Array<z.infer<typeof Row>>; expect(values).toHaveLength(seed.rows[name].length);
      for (const row of seed.rows[name]) { const found = values.find(value => value.id === row.id); expect(found).toBeDefined();
        expect(Object.fromEntries(Object.keys(row).map(key => [key, found![key]]))).toEqual(row); }
      preserved[name] = { rows: values.length, columns: Object.keys(seed.rows[name][0] ?? {}).sort(), allOriginalColumnValuesEqual: true };
    }
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(marketplacePublicationIntents))).toEqual([]);
    producer = new RedisMarketplacePublicationEnqueuer(); queue = createQueue(QueueName.Publication);
    let enqueues = 0; const enqueue = producer.enqueue.bind(producer); producer.enqueue = async input => { enqueues++; await enqueue(input); };
    const owner = new MarketplacePublicationService(database, producer, new AuditService(database));
    const legacy = PublicationPreviewRequestViewSchema.parse(await owner.getPreview(seed.context, seed.original.id));
    expect(legacy).toMatchObject({ admission: "legacy", intent: null, execution: null, access: { canCancel: false, canContinue: false } });
    expect(legacy.request).toEqual(seed.original); expect(await owner.events(seed.context, seed.original.id)).toHaveLength(1);
    const absent = PublicationPreviewReceiptSchema.parse(await owner.previewReceipt(seed.context, { requestKey: createEntityId(), requestChecksum: "a".repeat(64) }));
    expect(absent.found).toBe(false); expect(enqueues).toBe(0);
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(marketplacePublicationIntents))).toEqual([]);
    child.send({ type: "publication.preview.check181", nonce: isolated.nonce });
    const old = Checked.parse(await bounded(checked, "publication_preview_original181_read_deadline", 30_000));
    expect(old.original).toEqual(seed.original); expect(old.events).toHaveLength(1); expect(old.ids.sort()).toEqual([seed.original.id, seed.scheduled.id].sort());
    expect(old.additionalEnqueues).toBe(0); await bounded(exited!, "publication_preview_original181_close_deadline", 20_000); expect(child.exitCode).toBe(0);
    const execution = new DrizzlePublicationExecutionRepository(database, createMarketplaceSecretVault(), createStorageFromEnvironment());
    expect(await execution.claim(seed.context, seed.original.id, 0)).toBeUndefined();
    expect((await owner.events(seed.context, seed.original.id)).at(-1)).toMatchObject({ status: "reconciliation_required", code: "PUBLICATION_LEGACY_AUTHORITY_MISSING", retryable: false });
    expect((await owner.get(seed.context, seed.original.id)).payloadChecksum).toBe(seed.original.payloadChecksum);
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(marketplacePublicationIntents))).toEqual([]);
    expect(enqueues).toBe(0);
    await mkdir(lane, { recursive: true }); await writeFile(resolve(lane, isolated.nonce + "-upgrade-proof.json"), JSON.stringify({ operation: "a6f4c2d9", sourceSchema: 181, targetSchema: 182,
      originalSourceFiles: 3599, pinnedLinks: 400, originalSourceSha256: "acc1e6a3b0d908ec31e0e9adf85d6254bece36c89df6986e98af573529f6a012",
      preserved, legacyOriginalId: seed.original.id, legacyOriginalPayloadChecksum: seed.original.payloadChecksum, legacySidecarsBackfilled: 0,
      currentGetExtraEnqueues: enqueues, original181ReadExtraEnqueues: old.additionalEnqueues, actualCurrentWorkerRejectedLegacyBirth: true,
      syntheticHistoricalPrerequisites: true, platformHttpCalls: 0, childExit: child.exitCode }));
  });
});
