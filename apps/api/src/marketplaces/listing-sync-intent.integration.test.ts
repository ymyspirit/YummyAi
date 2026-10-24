import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, MarketplaceListingSyncRequestViewSchema } from "@yummyai/contracts";
import { ListingSyncIntentReceiptSchema, ListingSyncIntentWorkspaceSchema } from "@yummyai/contracts/marketplace/listing-sync-intent";
import { connectDatabase, migrateDatabase, withTenant, marketplaceListingSyncIntents, marketplaceListingSyncRequests, marketplaceListingSyncEvents } from "@yummyai/database";
import { requireListingSyncIntentEnvironment } from "../../../../tools/testing/require-listing-sync-intent-environment.mjs";
import { listingSyncIntentFixture, listingSyncIntentLane, intentContent, intentPermissions, intentSha } from "./listing-sync-intent.test-fixture.js";

const target = requireListingSyncIntentEnvironment(), database = connectDatabase(target.url), f = listingSyncIntentFixture(database), proof: object[] = [];
const endpoint = (input: ReturnType<typeof f.input>) => "/v1/marketplace-listing-syncs/receipt?" + new URLSearchParams(f.lookup(input));
const stable = (value: unknown): string => Array.isArray(value) ? "[" + value.map(stable).join(",") + "]" : value && typeof value === "object"
  ? "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ":" + stable(entry)).join(",") + "}" : JSON.stringify(value) ?? "null";
function code(error: unknown): string | undefined { if (!error || typeof error !== "object") return undefined;
  return "code" in error && typeof error.code === "string" ? error.code : "cause" in error ? code(error.cause) : undefined; }

beforeAll(async () => { await migrateDatabase(database); await f.initialize(); });
afterEach(async () => { for (const actor of [f.a, f.peer, f.foreign]) await f.rights(actor); expect(f.evidence.providerAttempts).toBe(0); });
afterAll(async () => { const errors: unknown[] = []; try { await f.close(); } catch (error) { errors.push(error); }
  try { await mkdir(listingSyncIntentLane, { recursive: true }); await writeFile(resolve(listingSyncIntentLane, target.nonce + "-current-proof.json"), JSON.stringify({ operation: "b7d3e8f2", cases: proof,
    syntheticPublishedPrerequisites: true, syntheticOfflineSnapshots: true, noPlatformExecutionClaim: true, cleanup: f.evidence, cleanupFailureCount: errors.length })); } catch (error) { errors.push(error); }
  try { await database.client.end(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "Listing intent fixture cleanup failed");
});

describe.sequential("original Listing sync intent and exact personal receipts", () => {
  it("serializes concurrent identical personal HTTP intents into one original request one event and one real Redis enqueue", async () => {
    const source = await f.seed(), input = f.input(source), before = f.evidence.enqueueCalls.length, beforeBusiness = await f.business();
    const values = await Promise.all(Array.from({ length: 4 }, () => f.http("/v1/marketplace-listing-syncs", { method: "POST", body: input })));
    expect(values.map(value => value.status)).toEqual([201, 201, 201, 201]); const requests = values.map(value => MarketplaceListingSyncRequestViewSchema.parse(value.body));
    expect(new Set(requests.map(value => value.id)).size).toBe(1); const id = requests[0]!.id, rows = await f.rows();
    expect(rows.requests.filter(row => row.listingId === source.listingId)).toHaveLength(1); expect(rows.events.filter(row => row.requestId === id)).toHaveLength(1);
    expect(rows.intents.filter(row => row.requestKey === input.requestKey)).toHaveLength(1); expect(f.evidence.enqueueCalls.slice(before)).toEqual([id]);
    expect(await f.jobs([id])).toEqual([{ id, requestId: id }]); expect(await f.business()).toEqual({ ...beforeBusiness, syncs: beforeBusiness.syncs + 1 });
    proof.push({ case: "concurrent_same_intent", requestId: id, key: input.requestKey, enqueueCalls: 1, queueJobs: 1, providerCalls: 0 });
  });

  it("rejects the same original key with any different complete target even when price and inventory are equal", async () => {
    const source = await f.seed(), other = await f.seed(), input = f.input(source, { action: "read" }), context = await f.current();
    const original = await f.service.create(context, input), alternate = await f.service.create(context, f.input(other, { action: "read" }));
    expect(alternate.desiredChecksum).toBe(original.desiredChecksum); const before = f.evidence.enqueueCalls.length;
    for (const change of [{ accountId: other.accountId }, { listingId: other.listingId }, { listingVersionId: other.versionId },
      { sourcePublicationRequestId: source.secondPublicationId }, { action: "read_full_content" as const }]) {
      const response = await f.http("/v1/marketplace-listing-syncs", { method: "POST", body: { ...input, ...change } });
      expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: "listing_sync_intent_conflict" });
    }
    expect(f.evidence.enqueueCalls).toHaveLength(before); expect((await f.service.receipt(context, f.lookup(input))).request?.id).toBe(original.id);
    proof.push({ case: "complete_target_conflict", originalId: original.id, equalDesiredChecksum: true, rejectedFields: 5, additionalEnqueues: 0 });
  });

  it("recovers a discarded original201 by read-only receipt and preserves the exact original offline snapshot checksum", async () => {
    const source = await f.seed(), input = f.input(source), created = await f.http("/v1/marketplace-listing-syncs", { method: "POST", body: input }); expect(created.status).toBe(201);
    // The caller discards its response. Recovery is independent of that body.
    const receipt = ListingSyncIntentReceiptSchema.parse((await f.http(endpoint(input))).body); expect(receipt.found).toBe(true); const id = receipt.request!.id;
    const snapshot = await f.offlineResult(id), before = await f.rows(), attempts = f.evidence.enqueueCalls.length;
    const response = await f.http(endpoint(input)); expect(response.status).toBe(200); const restored = ListingSyncIntentReceiptSchema.parse(response.body);
    expect(restored.request?.current.snapshot).toEqual(snapshot); expect(restored.request?.current.snapshot?.price).toEqual({ amount: 12.34, currency: "USD" });
    expect(restored.request?.current.snapshot?.inventory).toEqual({ quantity: 7 });
    expect(restored.request?.current.snapshotChecksum).toBe(intentSha(stable({ content: snapshot.content, price: snapshot.price, inventory: snapshot.inventory })));
    expect(await f.rows()).toEqual(before); expect(f.evidence.enqueueCalls).toHaveLength(attempts);
    proof.push({ case: "discarded201_exact_receipt", id, requestChecksum: restored.requestChecksum, snapshotChecksum: restored.request?.current.snapshotChecksum, additionalPost: 0, offlineSyntheticResult: true });
  });

  it("keeps an enqueue failure durably discoverable and never requeues it from receipt lookup or original-key replay", async () => {
    const source = await f.seed(), input = f.input(source), before = f.evidence.enqueueCalls.length; f.failNextEnqueue();
    const failed = await f.http("/v1/marketplace-listing-syncs", { method: "POST", body: input }); expect(failed.status).toBe(503); expect(failed.body).toMatchObject({ code: "listing_sync_queue_unavailable" });
    const receipt = ListingSyncIntentReceiptSchema.parse((await f.http(endpoint(input))).body); expect(receipt.request?.current).toMatchObject({ status: "failed", code: "SYNC_QUEUE_UNAVAILABLE" });
    const id = receipt.request!.id, replay = await f.http("/v1/marketplace-listing-syncs", { method: "POST", body: input }); expect(replay.status).toBe(201);
    expect(MarketplaceListingSyncRequestViewSchema.parse(replay.body).id).toBe(id); expect(f.evidence.enqueueCalls.slice(before)).toEqual([id]); expect(await f.jobs([id])).toEqual([]);
    expect((await f.rows()).events.filter(row => row.requestId === id).map(row => row.status)).toEqual(["queued", "failed"]);
    proof.push({ case: "queue_failure_original_receipt", id, enqueueAttempts: 1, redisJobs: 0, events: 2 });
  });

  it("rechecks current membership and specific Listing and store object scopes without borrowing a stale caller ceiling", async () => {
    const source = await f.seed(), input = f.input(source), stale = await f.current(), original = await f.service.create(stale, input), before = f.evidence.enqueueCalls.length;
    await f.rights(f.a, intentPermissions.filter(bit => bit !== Permission.ListingPublish));
    await expect(f.service.create(stale, input)).rejects.toMatchObject({ statusCode: 403 });
    expect((await f.service.receipt(await f.current(), f.lookup(input))).request?.id).toBe(original.id);
    await f.rights(f.a); const peerBefore = await f.current(f.peer); await f.rights(f.peer, intentPermissions, "self");
    await expect(f.service.get(peerBefore, original.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.workspace(peerBefore, source.listingId)).rejects.toMatchObject({ status: 404 });
    await f.rights(f.a, intentPermissions.filter(bit => bit !== Permission.ListingRead));
    await expect(f.service.receipt(stale, f.lookup(input))).rejects.toMatchObject({ statusCode: 403 });
    expect(f.evidence.enqueueCalls).toHaveLength(before); proof.push({ case: "current_permissions_and_objects", id: original.id, additionalEnqueues: 0 });
  });

  it("isolates personal locators by actor and tenant while retaining original object-authorized direct reads", async () => {
    const source = await f.seed(), input = f.input(source), original = await f.service.create(await f.current(), input), lookup = f.lookup(input);
    expect((await f.service.receipt(await f.current(f.peer), lookup)).found).toBe(false); expect((await f.service.receipt(await f.current(f.foreign), lookup)).found).toBe(false);
    expect((await f.service.get(await f.current(f.peer), original.id)).id).toBe(original.id);
    await expect(f.service.get(await f.current(f.foreign), original.id)).rejects.toMatchObject({ status: 404 });
    const peerOriginal = await f.service.create(await f.current(f.peer), input); expect(peerOriginal.id).not.toBe(original.id);
    expect((await f.service.receipt(await f.current(f.peer), lookup)).request?.id).toBe(peerOriginal.id);
    proof.push({ case: "actor_and_tenant_locators", ownerRequest: original.id, peerRequest: peerOriginal.id, sameKeyDifferentActor: true });
  });

  it("enforces original RLS and immutable request event and locator rows through the non-owner tenant role", async () => {
    const source = await f.seed(), input = f.input(source), original = await f.service.create(await f.current(), input), own = await f.rows(), context = await f.current();
    expect((await f.rows(f.foreign)).intents.some(row => row.requestId === original.id)).toBe(false);
    const locator = own.intents.find(row => row.requestId === original.id)!, event = own.events.find(row => row.requestId === original.id)!;
    const attempts = [() => withTenant(database.db, context, tx => tx.update(marketplaceListingSyncRequests).set({ desiredChecksum: "a".repeat(64) }).where(eq(marketplaceListingSyncRequests.id, original.id))),
      () => withTenant(database.db, context, tx => tx.update(marketplaceListingSyncEvents).set({ code: "SYNTHETIC_REWRITE" }).where(eq(marketplaceListingSyncEvents.id, event.id))),
      () => withTenant(database.db, context, tx => tx.execute(sql`update marketplace_listing_sync_intents set request_checksum=${"b".repeat(64)} where id=${locator.id}`)),
      () => withTenant(database.db, context, tx => tx.insert(marketplaceListingSyncIntents).values({ id: createEntityId(), tenantId: context.tenantId, requestKey: createEntityId(), createdBy: f.peer.userId, requestId: original.id, requestChecksum: locator.requestChecksum }))];
    for (const attempt of attempts) { const error = await attempt().then(() => null, error => error as unknown); expect(["23514", "42501", "23505"]).toContain(code(error)); }
    expect(await f.rows()).toEqual(own); proof.push({ case: "rls_and_immutable", id: original.id, rejectedWrites: attempts.length });
  });

  it("returns the original pinned receipt after the current Listing version changes without creating or dispatching another request", async () => {
    const source = await f.seed(), input = f.input(source), context = await f.current(), original = await f.service.create(context, input), before = f.evidence.enqueueCalls.length;
    const saved = await f.listings.saveVersion(context, source.listingId, { ...intentContent("Synthetic later draft " + source.id),
      mainImageId: "synthetic-historical-image-reference", attributes: { brand: "Synthetic" } }, "human", source.versionId);
    await f.listings.approveVersion(context, source.listingId, saved.id);
    expect(saved.id).not.toBe(source.versionId); const response = await f.http(endpoint(input)); expect(response.status).toBe(200);
    const receipt = ListingSyncIntentReceiptSchema.parse(response.body); expect(receipt.request?.id).toBe(original.id); expect(receipt.request?.listingVersionId).toBe(source.versionId); expect(receipt.request?.desiredChecksum).toBe(original.desiredChecksum);
    const workspace = ListingSyncIntentWorkspaceSchema.parse((await f.http("/v1/marketplace-listing-syncs/workspace?listingId=" + source.listingId)).body);
    expect(workspace.listing.currentVersionId).toBe(saved.id); const replay = await f.service.create(await f.current(), input); expect(replay.id).toBe(original.id);
    expect(f.evidence.enqueueCalls).toHaveLength(before); expect((await f.rows()).requests.filter(row => row.listingId === source.listingId)).toHaveLength(1);
    proof.push({ case: "new_version_keeps_original_receipt", id: original.id, oldVersion: source.versionId, currentVersion: saved.id, additionalDispatch: 0 });
  });
});
