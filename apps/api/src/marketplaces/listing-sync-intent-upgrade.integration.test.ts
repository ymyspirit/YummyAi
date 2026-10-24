import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateMarketplaceListingSyncInputSchema, MarketplaceListingSyncEventViewSchema, MarketplaceListingSyncRequestViewSchema, TenantContextSchema } from "@yummyai/contracts";
import { listingSyncIntentRequestText } from "@yummyai/contracts/marketplace/listing-sync-intent";
import { connectDatabase, migrateDatabase, withTenant, marketplaceAccounts, marketplaceCapabilitySnapshots, listings, listingVersions, marketplacePublicationRequests,
  marketplacePublicationEvents, marketplaceListingSyncRequests, marketplaceListingSyncEvents, marketplaceListingSyncIntents } from "@yummyai/database";
import { createQueue, QueueName } from "@yummyai/jobs";
import { createHash } from "node:crypto";
import { requireListingSyncIntentEnvironment } from "../../../../tools/testing/require-listing-sync-intent-environment.mjs";
import { assertListingSyncIntentOriginal180Graph } from "./listing-sync-intent-graph.test-fixture.js";
import { MarketplaceListingSyncService } from "./marketplace-listing-sync.service.js";
import { RedisMarketplaceListingSyncEnqueuer } from "./redis-marketplace-listing-sync-enqueuer.js";
import { AuditService } from "../audit/audit.service.js";
import { ChannelInventoryService } from "../channel-inventory/channel-inventory.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";

const target = requireListingSyncIntentEnvironment(process.env, "pre-0181"), root = fileURLToPath(new URL("../../../../", import.meta.url));
const lane = resolve(root, "tmp/listing-sync-intent-20261022-b7d3e8f2/qa"), database = connectDatabase(target.url), Row = z.record(z.string(), z.unknown());
const Seed = z.object({ type: z.literal("listing.sync.intent.seeded180"), nonce: z.literal(target.nonce), context: TenantContextSchema,
  input: CreateMarketplaceListingSyncInputSchema, other: CreateMarketplaceListingSyncInputSchema, original: MarketplaceListingSyncRequestViewSchema, alias: MarketplaceListingSyncRequestViewSchema,
  rows: z.object({ accounts: z.array(Row), capabilities: z.array(Row), listings: z.array(Row), versions: z.array(Row), publications: z.array(Row), publicationEvents: z.array(Row), requests: z.array(Row), events: z.array(Row) }).strict(),
  enqueueCalls: z.int().positive(), syntheticPublishedPrerequisites: z.literal(true) }).strict();
const Checked = z.object({ type: z.literal("listing.sync.intent.checked180"), nonce: z.literal(target.nonce), original: MarketplaceListingSyncRequestViewSchema,
  events: z.array(MarketplaceListingSyncEventViewSchema), additionalEnqueues: z.literal(0) }).strict();
const Failed = z.object({ type: z.literal("listing.sync.intent.failed180"), phase: z.string().regex(/^original180_[a-z_]+$/), code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/).nullable(),
  errorName: z.enum(["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError", "Other"]), constructorName: z.enum(["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError", "ZodError", "DrizzleQueryError", "DatabaseError", "ConflictException", "NotFoundException", "ServiceUnavailableException", "ForbiddenError", "Other"]),
  location: z.object({ file: z.string().regex(/^[A-Za-z0-9_./@+-]+$/), line: z.int().positive() }).strict().nullable() }).strict();
const bounded = async <T>(promise: Promise<T>, label: string, ms = 90_000) => { let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, fail) => { timer = setTimeout(() => fail(new Error(label)), ms); })]); } finally { clearTimeout(timer); } };
let child: ChildProcess | undefined, exited: Promise<void> | undefined, producer: RedisMarketplaceListingSyncEnqueuer | undefined, queue: ReturnType<typeof createQueue> | undefined;
const ownedQueueIds = new Set<string>();
afterAll(async () => { const errors: unknown[] = [];
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try { if (exited) await bounded(exited, "listing_sync_intent_original180_exit_deadline", 10_000); } catch (error) { errors.push(error); }
  try { if (queue) for (const id of ownedQueueIds) await (await queue.getJob(id))?.remove(); } catch (error) { errors.push(error); }
  try { await queue?.close(); await producer?.onModuleDestroy(); } catch (error) { errors.push(error); }
  try { await database.client.end(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "Listing sync intent genuine180 teardown failed");
});

describe("genuine original180 owner history to181 intent migration", () => {
  it("preserves every original column and adopts the exact original180 UUID-key request without requeue after today's primary version changes", async () => {
    const source = process.env.E2E_LISTING_SYNC_INTENT_LEGACY_SOURCE!; await assertListingSyncIntentOriginal180Graph(source);
    const waits = new Map<string, { done(value: unknown): void; fail(error: Error): void }>();
    const receive = (type: string) => new Promise<unknown>((done, fail) => waits.set(type, { done, fail }));
    const seeded = receive("listing.sync.intent.seeded180"), checked = receive("listing.sync.intent.checked180"); void checked.catch(() => {});
    let startupCode: string | null = null, errorName: string | null = null;
    child = spawn(process.execPath, ["--import", pathToFileURL(resolve(source, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/marketplaces/listing-sync-intent-legacy.test-fixture.ts"), "--listing-sync-intent-original180-child"], {
      cwd: resolve(source, "apps/api"), windowsHide: true, env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(source, "apps/api/tsconfig.json") }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr?.on("data", (bytes: Buffer) => { const text = bytes.toString("utf8"); startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)\b/.exec(text)?.[1] ?? null;
      errorName ??= /\b(SyntaxError|ReferenceError|TypeError|RangeError|TransformError)\b/.exec(text)?.[1] ?? null; });
    child.on("message", raw => { const failure = Failed.safeParse(raw);
      if (failure.success) { const safe = new Error(JSON.stringify(failure.data)); for (const waiter of waits.values()) waiter.fail(safe); waits.clear(); return; }
      if (raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string" && "nonce" in raw && raw.nonce === target.nonce) { waits.get(raw.type)?.done(raw); waits.delete(raw.type); } });
    exited = new Promise<void>(done => child!.once("exit", (exitCode, signal) => { for (const waiter of waits.values()) waiter.fail(new Error(JSON.stringify({ code: "listing_sync_intent_original180_early_exit", exitCode, signal, startupCode, errorName }))); waits.clear(); done(); }));
    child.once("error", () => { for (const waiter of waits.values()) waiter.fail(new Error("listing_sync_intent_original180_spawn_failed")); waits.clear(); });
    const seed = Seed.parse(await bounded(seeded, "listing_sync_intent_original180_seed_deadline")); ownedQueueIds.add(seed.original.id);
    // Original180 really exhibits the old incomplete-target alias. Keep its rows unchanged.
    expect(seed.alias.id).toBe(seed.original.id); expect(seed.other.listingId).not.toBe(seed.original.listingId); expect(seed.enqueueCalls).toBe(2);
    await migrateDatabase(database); expect((await database.client.unsafe("select count(*)::int count from drizzle.__drizzle_migrations"))[0]?.count).toBe(181);
    const actual = await withTenant(database.db, seed.context, async tx => ({ accounts: await tx.select().from(marketplaceAccounts), capabilities: await tx.select().from(marketplaceCapabilitySnapshots),
      listings: await tx.select().from(listings), versions: await tx.select().from(listingVersions), publications: await tx.select().from(marketplacePublicationRequests), publicationEvents: await tx.select().from(marketplacePublicationEvents),
      requests: await tx.select().from(marketplaceListingSyncRequests), events: await tx.select().from(marketplaceListingSyncEvents) }));
    const columns: Record<string, object> = {};
    for (const name of Object.keys(seed.rows) as Array<keyof typeof seed.rows>) {
      const values = JSON.parse(JSON.stringify(actual[name])) as Array<z.infer<typeof Row>>; expect(values).toHaveLength(seed.rows[name].length);
      for (const row of seed.rows[name]) { const found = values.find(value => value.id === row.id); expect(found).toBeDefined(); expect(Object.fromEntries(Object.keys(row).map(key => [key, found![key]]))).toEqual(row); }
      columns[name] = { rows: values.length, columns: Object.keys(seed.rows[name][0] ?? {}).sort(), allOldValuesEqual: true };
    }
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(marketplaceListingSyncIntents))).toEqual([]);
    producer = new RedisMarketplaceListingSyncEnqueuer(); queue = createQueue(QueueName.ListingSync); const audit = new AuditService(database), owner = new MarketplaceListingSyncService(database, producer, audit, new ChannelInventoryService(database, audit));
    const lookup = { requestKey: seed.input.requestKey!, requestChecksum: createHash("sha256").update(listingSyncIntentRequestText(seed.input)).digest("hex") };
    expect((await owner.receipt(seed.context, lookup)).found).toBe(false);
    let enqueueCalls = 0; const enqueue = producer.enqueue.bind(producer); producer.enqueue = async input => { enqueueCalls++; await enqueue(input); };
    await expect(owner.create(seed.context, seed.other)).rejects.toMatchObject({ status: 409 });
    expect(enqueueCalls).toBe(0); expect(await withTenant(database.db, seed.context, tx => tx.select().from(marketplaceListingSyncIntents))).toEqual([]);
    expect((await owner.get(seed.context, seed.original.id)).listingId).toBe(seed.input.listingId);
    const created = await owner.create(seed.context, { ...seed.input, requestKey: (await import("@yummyai/contracts")).createEntityId() }); ownedQueueIds.add(created.id);
    expect(created.id).not.toBe(seed.original.id); expect(created.idempotencyKey).not.toBe(seed.original.idempotencyKey); expect(enqueueCalls).toBe(1);
    const listingOwner = new ListingService(new DrizzleListingRepository(database)), originalVersion = actual.versions.find(value => value.id === seed.input.listingVersionId)!;
    const newer = await listingOwner.saveVersion(seed.context, seed.input.listingId, { ...originalVersion.content, title: "Synthetic changed primary after migration",
      mainImageId: "synthetic-historical-image-reference", attributes: { brand: "Synthetic" }, compliance: { countryOfOrigin: "CN" } }, "human", originalVersion.id);
    await listingOwner.approveVersion(seed.context, seed.input.listingId, newer.id);
    expect(newer.id).not.toBe(seed.input.listingVersionId);
    const adopted = await owner.create(seed.context, seed.input); expect(adopted).toEqual(seed.original); expect(enqueueCalls).toBe(1);
    expect((await owner.get(seed.context, seed.original.id)).idempotencyKey).toBe(seed.original.idempotencyKey);
    expect((await owner.receipt(seed.context, lookup)).request?.id).toBe(seed.original.id);
    await expect(owner.create(seed.context, seed.other)).rejects.toMatchObject({ status: 409 });
    child.send({ type: "listing.sync.intent.check180", nonce: target.nonce }); const old = Checked.parse(await bounded(checked, "listing_sync_intent_original180_read_deadline", 30_000));
    expect(old.original).toEqual(seed.original); expect(old.events).toHaveLength(seed.rows.events.length);
    await bounded(exited!, "listing_sync_intent_original180_close_deadline", 20_000); expect(child.exitCode).toBe(0);
    await mkdir(lane, { recursive: true }); await writeFile(resolve(lane, target.nonce + "-upgrade-proof.json"), JSON.stringify({ operation: "b7d3e8f2", sourceSchema: 180, targetSchema: 181, originalSourceFiles: 3570, pinnedLinks: 400,
      originalSourceSha256: "4db87f01a7534050b30e538f0c7971a11b1c0527cac700b15a9e6715837be13d", preserved: columns, oldHash: seed.original.idempotencyKey, newHash: created.idempotencyKey,
      oldIncompleteTargetAliasReproduced: true, legacyHashCollisionRejectedBeforeAdoption: true, originalOwnerReadAfterUpgrade: true, legacyAdoptedAfterPrimaryChange: true, additionalLegacyEnqueues: 0,
      currentVersion: newer.id, childExit: child.exitCode, syntheticPublicationOnly: true, platformCalls: 0 }));
  });
});
