import "reflect-metadata";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema, createEntityId } from "@yummyai/contracts";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { requireListingSyncIntentEnvironment } from "../../../../tools/testing/require-listing-sync-intent-environment.mjs";
import { listingSyncIntentFixture, listingSyncIntentLane, intentContent, intentPermissions, intentSha, type IntentSource } from "./listing-sync-intent.test-fixture.js";

const Id = z.uuidv7(), Actor = z.object({ userId: Id, tenantId: Id, roleId: Id, membershipId: Id, subject: z.string().optional() }).passthrough();
const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("seed") }).strict(),
  z.object({ operation: z.enum(["snapshot", "advance", "close"]), groupId: Id }).strict(),
  z.object({ operation: z.literal("offline_result"), groupId: Id, requestId: Id }).strict(),
  z.object({ operation: z.literal("rights"), groupId: Id, enabled: z.boolean() }).strict(),
]);
async function browserApi() {
  const target = requireListingSyncIntentEnvironment(process.env, "current", true), actor = Actor.parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator), database = connectDatabase(target.url);
  const ceiling = TenantContextSchema.parse({ tenantId: actor.tenantId, userId: actor.userId, permissions: [...intentPermissions], dataScope: "tenant" });
  const original = await withTenant(database.db, ceiling, async tx => (await tx.select().from(roles).where(and(eq(roles.id, actor.roleId), eq(roles.tenantId, actor.tenantId))))[0]);
  if (!original) { await database.client.end(); throw new Error("listing_sync_intent_browser_role_missing"); }
  const fullPermissions = [...new Set([...original.permissions, ...intentPermissions])];
  const rights = (enabled: boolean) => withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: enabled ? fullPermissions : fullPermissions.filter(bit => ![Permission.ListingRead, Permission.ListingPublish, Permission.StoreRead].includes(bit as typeof Permission.ListingRead)), dataScope: original.dataScope }).where(eq(roles.id, actor.roleId)));
  let ready = false, closed = false, control: ReturnType<typeof createServer> | undefined;
  const f = listingSyncIntentFixture(database, { actor: { ...actor, subject: actor.subject ?? "runner-owned-personal-operator" }, apiPort: 8130, ready: () => ready });
  const groups = new Map<string, { source: IntentSource; closed: boolean }>();
  const closeGroup = async (groupId: string) => {
    const group = groups.get(groupId); if (!group || group.closed) throw new Error("listing_sync_intent_browser_group_missing");
    await rights(true); group.closed = true; return { restoredRole: true, retainedImmutableHistory: true, sourceId: group.source.id };
  };
  const close = async () => { if (closed) return; closed = true; ready = false; const errors: unknown[] = [];
    for (const [id, group] of groups) if (!group.closed) try { await closeGroup(id); } catch (error) { errors.push(error); }
    try { if (control) { control.closeAllConnections(); await new Promise<void>(done => control!.close(() => done())); } } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try { await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: original.permissions, dataScope: original.dataScope }).where(eq(roles.id, actor.roleId))); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "listing_sync_intent_browser_cleanup_failed");
  };
  try {
    await rights(true); await f.initialize(); const key = randomBytes(32).toString("base64url");
    control = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json"); const supplied = request.headers["x-fixture-control"];
      if (request.method !== "POST" || request.url !== "/" || typeof supplied !== "string" || supplied.length !== key.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) { response.writeHead(404); response.end(); return; }
      try {
        const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) throw new Error("bounded"); chunks.push(Buffer.from(chunk)); }
        const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); let result: unknown;
        if (input.operation === "seed") { await rights(true); const source = await f.seed(), groupId = createEntityId(); groups.set(groupId, { source, closed: false }); result = { groupId, source, actorId: actor.userId, tenantId: actor.tenantId }; }
        else {
          const group = groups.get(input.groupId); if (!group || group.closed) throw new Error("owned_group_required");
          if (input.operation === "close") result = await closeGroup(input.groupId);
          else if (input.operation === "rights") { await rights(input.enabled); result = { updated: true }; }
          else if (input.operation === "advance") { const context = await f.current(), saved = await f.listings.saveVersion(context, group.source.listingId, { ...intentContent("Synthetic later browser draft " + group.source.id),
            mainImageId: "synthetic-historical-image-reference", attributes: { brand: "Synthetic" } }, "human", group.source.versionId); await f.listings.approveVersion(context, group.source.listingId, saved.id); result = { versionId: saved.id }; }
          else if (input.operation === "offline_result") {
            const rows = await f.rows(); if (!rows.requests.some(row => row.id === input.requestId && row.listingId === group.source.listingId)) throw new Error("owned_request_required");
            await f.offlineResult(input.requestId); result = { recordedSyntheticOfflineResult: true };
          } else {
            const rows = await f.rows(), own = rows.requests.filter(row => row.listingId === group.source.listingId), ids = own.map(row => row.id);
            result = { business: await f.business(), providerCalls: f.evidence.providerAttempts, enqueueCalls: f.evidence.enqueueCalls.filter(id => ids.includes(id)),
              requests: own.map(row => ({ id: row.id, listingVersionId: row.listingVersionId, desiredChecksum: row.desiredChecksum, idempotencyKey: row.idempotencyKey })),
              events: rows.events.filter(row => ids.includes(row.requestId)).map(row => ({ id: row.id, requestId: row.requestId, sequence: row.sequence, status: row.status, snapshotChecksum: row.snapshotChecksum })),
              immutableBodySha: intentSha(JSON.stringify({ requests: own, events: rows.events.filter(row => ids.includes(row.requestId)), intents: rows.intents.filter(row => ids.includes(row.requestId)) })), jobs: await f.jobs(ids) };
          }
        }
        response.writeHead(200); response.end(JSON.stringify(result));
      } catch { response.writeHead(409); response.end('{"code":"listing_sync_intent_browser_control_rejected"}'); }
    });
    await new Promise<void>((done, fail) => { control!.once("error", fail); control!.listen(0, "127.0.0.1", done); });
    const address = control.address(); if (!address || typeof address === "string") throw new Error("listing_sync_intent_browser_control_address_invalid");
    await writeFile(resolve(listingSyncIntentLane, "browser-control-" + target.nonce + ".json"), JSON.stringify({ nonce: target.nonce, pid: process.pid, origin: "http://127.0.0.1:" + address.port, key }), { flag: "wx", mode: 0o600 }); ready = true;
    let closing: Promise<void> | undefined;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
  } catch { await close().catch(() => {}); throw new Error("listing_sync_intent_browser_startup_failed"); }
}
if (process.argv.includes("--listing-sync-intent-api")) void browserApi().catch(() => { process.stderr.write("listing_sync_intent_browser_startup_failed\n"); process.exitCode = 1; });
