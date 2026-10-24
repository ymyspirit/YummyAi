import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { connectDatabase, FACTORY_ERP_RETENTION_ACTOR, factoryErpImports, factoryErpRetentionContext,
  redactExpiredFactoryErpSources, claimFactoryErpSourcePurges, finishFactoryErpSourcePurge, failFactoryErpSourcePurge,
  withTenant, type FactoryErpPurgeTicket } from "@yummyai/database";
import { FactoryErpSourcePurger } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { assertFactoryErpProof } from "./factory-erp-evidence.js";
import { factoryErpImportFixture, factoryErpImportTables } from "./factory-erp-import.test-fixture.js";

const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (!nonce || process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory ERP source retention requires its exact current-schema disposable database and bucket before connection");
const storageRequire = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url));
const sdk = storageRequire("@aws-sdk/client-s3") as typeof S3Sdk;
const bucket = process.env.S3_PRIVATE_BUCKET!, workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const makeClient = () => new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true,
  region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function pg(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  if ("code" in error) return error as { code?: string; message?: string };
  return "cause" in error ? pg(error.cause) : {};
}

describe.sequential("factory ERP exact private-source retention and recoverable purge leases", () => {
  const database = connectDatabase(), f = factoryErpImportFixture(database), s3 = makeClient(), purger = new FactoryErpSourcePurger(makeClient(), bucket);
  const proofs: Array<{ beforeSha256: string; afterSha256: string; restored: boolean }> = [];
  const children: InvoiceProcess[] = [];
  beforeAll(async () => { await f.initialize(); await s3.send(new sdk.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } })); });
  afterAll(async () => {
    try { for (const child of children) if (child.child.exitCode === null) await child.stop(true); }
    finally {
      try {
        const owned = resolve(workspace, "tmp/factory-erp-lifecycle-20261021-a9f6d812");
        await mkdir(owned, { recursive: true });
        await writeFile(resolve(owned, "qa-retention-clock-restore.json"), JSON.stringify({ nonce, function: "public.factory_erp_source_now()", proofs }, null, 2) + "\n");
      } finally { f.dispose(); purger.close(); s3.destroy(); await database.client.end(); }
    }
  });
  type Scene = Awaited<ReturnType<typeof f.scene>>;
  type Entry = Awaited<ReturnType<typeof seedSource>>;
  const maintenance = () => factoryErpRetentionContext(f.base.context.tenantId);
  const maintain = <T>(use: Parameters<typeof withTenant<T>>[2]) => withTenant(database.db, maintenance(), use);
  async function source(id: string) { return (await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpImports).where(eq(factoryErpImports.id, id))))[0]!; }
  async function seedSource(scene: Scene, status = "已出库", externalId = `SYNTHETIC-RETENTION-${createEntityId()}`) {
    const row = f.rawRow(scene.quantity, status, externalId); row[6] = String(scene.items.length);
    const service = f.service(), view = await service.upload(f.base.context, f.uploadInput(scene.site.factory.id, [row]));
    const input = f.applyInput(view, scene.items), result = await service.apply(f.base.context, view.id, input), stored = await source(view.id);
    if (!stored.encryptedPayload) throw new Error("Actual unredacted source required");
    const scan = f.base.vault.withSecret(stored.encryptedPayload, value => JSON.parse(value).scan as { engine: string; result: string });
    expect(scan).toMatchObject({ engine: "clamav-clamd", result: "clean" });
    return { view, input, result, stored };
  }
  async function sourceTime(id: string, offset: "before" | "exact" | "after" = "after") {
    const at = offset === "before" ? sql`expires_at - interval '1 microsecond'` : offset === "exact" ? sql`expires_at` : sql`expires_at + interval '1 second'`;
    const [row] = await withTenant(database.db, f.base.context, tx => tx.execute<{ at: string }>(sql`
      select to_char((${at}) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from factory_erp_imports where id=${id}::uuid`));
    return row!.at;
  }
  async function withClock<T>(use: (set: (at: string) => Promise<void>) => Promise<T>) {
    const [identity] = await database.client.unsafe("select current_database() as name,pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
    expect(identity!.name).toBe(`order_daily_e2e_${nonce}`);
    const original = String(identity!.definition), beforeSha256 = sha(original);
    const set = async (at: string) => {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(at)) throw new Error("Synthetic exact source clock required");
      const replacement = original.replace(/AS \$function\$[\s\S]*?\$function\$/, `AS $function$ SELECT '${at}'::timestamptz $function$`);
      if (replacement === original) throw new Error("Unexpected source-clock function shape");
      await database.client.unsafe(replacement);
    };
    try { return await use(set); }
    finally {
      await database.client.unsafe(original);
      const [restored] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
      const afterSha256 = sha(String(restored!.definition)); proofs.push({ beforeSha256, afterSha256, restored: beforeSha256 === afterSha256 });
      expect(afterSha256).toBe(beforeSha256);
    }
  }
  async function versions(key: string) {
    const values: Array<{ id: string; marker: boolean }> = []; let keyMarker: string | undefined, versionMarker: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 2, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
      for (const item of result.Versions ?? []) if (item.Key === key) values.push({ id: item.VersionId!, marker: false });
      for (const item of result.DeleteMarkers ?? []) if (item.Key === key) values.push({ id: item.VersionId!, marker: true });
      if (!result.IsTruncated) return values.sort((a, b) => a.id.localeCompare(b.id));
      keyMarker = result.NextKeyMarker; versionMarker = result.NextVersionIdMarker;
    }
    throw new Error("Synthetic exact-key version scan did not terminate");
  }
  async function addVersions(entry: Entry) {
    const bytes = await f.storage.readPrivate(f.base.context, { id: entry.stored.id, tenantId: f.base.context.tenantId, assetDomain: "order", objectKey: entry.stored.objectKey }, { requiredDomain: "order" });
    try {
      expect(sha(bytes)).toBe(entry.stored.storedChecksum);
      await s3.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: entry.stored.objectKey, Body: bytes, ContentType: "application/octet-stream" }));
      await s3.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: entry.stored.objectKey + "-neighbor", Body: bytes, ContentType: "application/octet-stream" }));
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: entry.stored.objectKey }));
    } finally { bytes.fill(0); }
    const listed = await versions(entry.stored.objectKey);
    expect(listed.filter(value => !value.marker)).toHaveLength(2); expect(listed.filter(value => value.marker)).toHaveLength(1);
    return listed;
  }
  async function job(id: string) { return (await maintain(tx => tx.execute<Record<string, unknown>>(sql`select * from factory_erp_source_purges where import_id=${id}::uuid`)))[0]; }
  async function auditCount(action: string, id: string) { return (await maintain(tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from audit_events where action=${action} and entity_id=${id}`)))[0]!.count; }
  async function privateFlags(id: string) {
    return withTenant(database.db, f.base.context, tx => tx.execute<{ kind: string; cleared: boolean; stamped: boolean }>(sql`
      select 'source' as kind,encrypted_payload is null as cleared,private_redacted_at is not null as stamped from factory_erp_imports where id=${id}::uuid
      union all select 'observation',encrypted_payload is null,private_redacted_at is not null from factory_erp_observations where import_id=${id}::uuid
      union all select 'binding',b.encrypted_payload is null,b.private_redacted_at is not null from factory_erp_bindings b
        join factory_erp_applications a on a.tenant_id=b.tenant_id and a.id=b.application_id where a.import_id=${id}::uuid`));
  }
  async function immutable() {
    return withTenant(database.db, f.base.context, async tx => {
      const result: Record<string, string> = {};
      for (const table of factoryErpImportTables) result[table] = (await tx.execute<{ digest: string }>(sql`select md5(coalesce(jsonb_agg(
        to_jsonb(item)-'encrypted_payload'-'private_redacted_at' order by to_jsonb(item)->>'id')::text,'[]')) as digest from ${sql.identifier(table)} item`))[0]!.digest;
      result.businessAudits = (await tx.execute<{ digest: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(a) order by id)::text,'[]')) as digest
        from audit_events a where action not in('factory_erp.source_redacted','factory_erp.source_purged')`))[0]!.digest;
      return result;
    });
  }
  async function claim(entry: Entry) {
    expect(await maintain(tx => redactExpiredFactoryErpSources(tx, { importId: entry.view.id, limit: 1 }))).toBe(1);
    const tickets = await maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id, limit: 1, leaseMs: 60_000 }));
    expect(tickets).toHaveLength(1); return tickets[0]!;
  }

  it("clears only expired private copies and every exact object version while retaining the two-item submitted group, shipped status, void exception and original hashes", async () => {
    const scene = await f.scene({ quantities: [1, 2] }), externalId = `SYNTHETIC-RETENTION-GROUP-${scene.order.id}`, entries: Entry[] = [];
    for (const status of ["已审核", "已出库", "已作废"]) entries.push(await seedSource(scene, status, externalId));
    for (const entry of entries) await addVersions(entry);
    const before = await immutable(), physical = await f.physicalState(), packet = await f.delivery.get(f.base.context, scene.packet.id);
    await withClock(async set => {
      await set(await sourceTime(entries.at(-1)!.view.id));
      for (const entry of entries) {
        const ticket = await claim(entry), flags = await privateFlags(entry.view.id);
        expect(flags.length).toBeGreaterThanOrEqual(2); expect(flags.every(value => value.cleared && value.stamped)).toBe(true);
        const receipt = await purger.purge(ticket); expect(receipt).toEqual({ verifiedAbsent: true, deletedVersions: 3 });
        const done = await maintain(tx => finishFactoryErpSourcePurge(tx, ticket, receipt)); expect(done).toMatchObject({ importId: entry.view.id, replayed: false });
        expect(await versions(ticket.objectKey)).toEqual([]); expect(await versions(ticket.objectKey + "-neighbor")).toHaveLength(1);
        const retained = await source(entry.view.id); expect(retained.sourceProof).toBe(entry.stored.sourceProof); expect(retained.sourceClaims).toEqual(entry.stored.sourceClaims);
        expect(() => assertFactoryErpProof(f.base.vault, retained)).not.toThrow();
        expect(await auditCount("factory_erp.source_redacted", entry.view.id)).toBe(1); expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(1);
        await expect(f.service().get(f.base.context, entry.view.id, {})).rejects.toBeInstanceOf(NotFoundException);
        expect(await f.service().apply(f.base.context, entry.view.id, entry.input)).toEqual(entry.result);
        const lifecycle = await f.service().lifecycle(f.base.context, entry.view.id);
        expect(lifecycle).toMatchObject({ access: "expired", purgeStatus: "purged", lastApplicationId: entry.result.id });
        for (const privateField of ["fileName", "objectKey", "rawCells", "externalId", "trackingReference", "encryptedPayload"])
          expect(lifecycle).not.toHaveProperty(privateField);
        expect((await f.service().listApplications(f.base.context, entry.view.id, {})).items.map(value => value.id)).toEqual([entry.result.id]);
        expect(await f.service().application(f.base.context, entry.view.id, entry.result.id)).toEqual(entry.result);
        await expect(f.service().apply(f.base.context, entry.view.id, { ...entry.input, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(NotFoundException);
      }
      const first = entries[0]!, other = await f.actor();
      await expect(f.service().apply(other, first.view.id, first.input)).rejects.toBeInstanceOf(ConflictException);
      await expect(f.service().apply(f.base.context, first.view.id, { ...first.input,
        rows: [{ ...first.input.rows[0]!, rowNumber: 3 }] })).rejects.toBeInstanceOf(ConflictException);
      const after = await f.delivery.get(f.base.context, scene.packet.id);
      for (const item of after.items) {
        const original = packet.items.find(value => value.id === item.id)!;
        expect(item.snapshot).toEqual(original.snapshot); expect(item.feedback).toEqual(original.feedback); expect(item.status).toBe("submitted");
        expect(item.factoryErp).toMatchObject({ status: "shipped", exception: "voided_requires_review", shippedQuantity: null,
          observationId: original.factoryErp!.observationId, importId: original.factoryErp!.importId, externalId: "", trackingReference: "", privateSourceExpired: true });
        const production = await f.production.get(f.base.context, item.productionOrderId);
        expect(production.productionOrder.status).toBe("submitted"); expect(production.milestones.map(value => value.type)).toEqual(["submitted"]);
        expect(production.inspections).toEqual([]);
      }
      expect(await immutable()).toEqual(before); expect(await f.physicalState()).toEqual(physical);
    });
  });

  it("uses the exact database expiry boundary and rejects other tenants, interactive actors, raw rewrites and forged completion tickets without deleting a source", async () => {
    const scene = await f.scene(), entry = await seedSource(scene), before = await immutable();
    await withClock(async set => {
      await set(await sourceTime(entry.view.id, "before"));
      expect(await maintain(tx => redactExpiredFactoryErpSources(tx, { importId: entry.view.id }))).toBe(0);
      expect(await maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id }))).toEqual([]);
      expect((await privateFlags(entry.view.id)).every(value => !value.cleared && !value.stamped)).toBe(true);
      await expect(withTenant(database.db, f.base.context, tx => redactExpiredFactoryErpSources(tx, { importId: entry.view.id }))).rejects.toThrow("FACTORY_ERP_RETENTION_ACTOR_REQUIRED");
      await expect(withTenant(database.db, f.base.context, tx => tx.execute(sql`update factory_erp_imports set encrypted_payload=null,private_redacted_at=factory_erp_source_now() where id=${entry.view.id}::uuid`)))
        .rejects.toSatisfy(error => pg(error).code === "23514" && pg(error).message === "factory_erp_retention_actor_required");
      await set(await sourceTime(entry.view.id, "exact"));
      const foreign = factoryErpRetentionContext(f.base.foreignContext.tenantId);
      expect(await withTenant(database.db, foreign, tx => redactExpiredFactoryErpSources(tx, { importId: entry.view.id }))).toBe(0);
      expect(await withTenant(database.db, foreign, tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id }))).toEqual([]);
      const ticket = await claim(entry), claimed = await job(entry.view.id), listed = await versions(ticket.objectKey);
      const [foreignRow] = await withTenant(database.db, foreign, tx => tx.execute<{ count: number; non_owner: boolean; forced: boolean }>(sql`select count(*)::int as count,
        current_user='yummyai_app' as non_owner,(select relforcerowsecurity from pg_class where oid='factory_erp_source_purges'::regclass) as forced from factory_erp_source_purges where import_id=${entry.view.id}::uuid`));
      expect(foreignRow).toEqual({ count: 0, non_owner: true, forced: true });
      await expect(withTenant(database.db, f.base.seed(), tx => tx.execute(sql`insert into memberships(id,tenant_id,user_id,status)
        values(${createEntityId()}::uuid,${f.base.context.tenantId}::uuid,${FACTORY_ERP_RETENTION_ACTOR}::uuid,'active')`)))
        .rejects.toSatisfy(error => pg(error).code === "23514" && pg(error).message === "factory_erp_retention_actor_noninteractive");
      await expect(maintain(tx => tx.execute(sql`update factory_erp_source_purges set object_key=object_key||'-neighbor' where import_id=${entry.view.id}::uuid`)))
        .rejects.toSatisfy(error => pg(error).code === "23514" && pg(error).message === "factory_erp_redacted_exact_source_required");
      await expect(maintain(tx => tx.execute(sql`update factory_erp_source_purges set purged_at=factory_erp_source_now(),deleted_versions=0,
        completion_transaction_id=pg_current_xact_id()::text where import_id=${entry.view.id}::uuid`)))
        .rejects.toSatisfy(error => pg(error).code === "23514" && pg(error).message === "factory_erp_purge_audit_required");
      await expect(withTenant(database.db, foreign, tx => finishFactoryErpSourcePurge(tx, ticket, { verifiedAbsent: true, deletedVersions: 0 }))).rejects.toThrow("FACTORY_ERP_PURGE_TICKET_SCOPE_CHANGED");
      for (const invalid of [{ ...ticket, leaseToken: createEntityId() }, { ...ticket, attempts: ticket.attempts + 1 }, { ...ticket, storedChecksum: "0".repeat(64) }])
        await expect(maintain(tx => finishFactoryErpSourcePurge(tx, invalid, { verifiedAbsent: true, deletedVersions: 0 }))).rejects.toThrow("FACTORY_ERP_PURGE_TICKET_CHANGED");
      const malformedClient = makeClient(); let requests = 0;
      malformedClient.middlewareStack.add(next => async args => { requests++; return next(args); }, { step: "initialize", name: "syntheticMalformedTicketCounter" });
      const malformed = new FactoryErpSourcePurger(malformedClient, bucket);
      try {
        for (const invalid of [{ ...ticket, tenantId: f.base.foreignContext.tenantId }, { ...ticket, objectKey: ticket.objectKey + "-neighbor" }, { ...ticket, storedChecksum: "0".repeat(64) }])
          await expect(malformed.purge(invalid)).rejects.toMatchObject({ code: "storage_delete_failed" });
        expect(requests).toBe(0);
      } finally { malformed.close(); }
      expect(await job(entry.view.id)).toEqual(claimed); expect(await versions(ticket.objectKey)).toEqual(listed);
      expect(await immutable()).toEqual(before);
      const flags = await privateFlags(entry.view.id); expect(flags.every(value => value.cleared && value.stamped)).toBe(true);
    });
  });

  it("does not complete after an actual partial version deletion loses its response and retries only the remaining exact versions after backoff", async () => {
    const entry = await seedSource(await f.scene()); await addVersions(entry);
    await withClock(async set => {
      await set(await sourceTime(entry.view.id)); const ticket = await claim(entry), faultyClient = makeClient(); let deleted = false;
      faultyClient.middlewareStack.add((next, context) => async args => {
        const result = await next(args);
        if (context.commandName === "DeleteObjectCommand" && !deleted) { deleted = true; throw new Error("Synthetic lost real version-deletion response"); }
        return result;
      }, { step: "initialize", name: "syntheticLostDeletionResponse" });
      const faulty = new FactoryErpSourcePurger(faultyClient, bucket);
      try { await expect(faulty.purge(ticket)).rejects.toMatchObject({ code: "storage_delete_failed" }); }
      finally { faulty.close(); }
      expect(deleted).toBe(true); expect(await versions(ticket.objectKey)).toHaveLength(2); expect((await job(entry.view.id))!.purged_at).toBeNull();
      expect(await maintain(tx => failFactoryErpSourcePurge(tx, ticket, "storage_delete_failed"))).toBe(true);
      expect(await maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id }))).toEqual([]);
      const failed = await job(entry.view.id); expect(failed).toMatchObject({ last_failure_code: "storage_delete_failed", lease_token: null, attempts: 1 });
      await set(new Date(new Date(failed!.next_attempt_at as string | Date).getTime() + 1_000).toISOString());
      const [retry] = await maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id })); expect(retry!.attempts).toBe(2);
      const receipt = await purger.purge(retry!); expect(receipt).toEqual({ verifiedAbsent: true, deletedVersions: 2 });
      await maintain(tx => finishFactoryErpSourcePurge(tx, retry!, receipt));
      expect(await versions(ticket.objectKey)).toEqual([]); expect(await versions(ticket.objectKey + "-neighbor")).toHaveLength(1);
      expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(1);
    });
  });

  it("rolls back completion and its audit on a real blocked-audit cancellation while retaining committed redaction and the original recoverable lease", async () => {
    const entry = await seedSource(await f.scene());
    await withClock(async set => {
      await set(await sourceTime(entry.view.id)); const ticket = await claim(entry), receipt = await purger.purge(ticket), before = await job(entry.view.id);
      let release = () => {}, writerPid = 0, blockerPid = 0;
      let ready = () => {}; const locked = new Promise<void>(done => { ready = done; }), gate = new Promise<void>(done => { release = done; });
      const deadline = setTimeout(() => release(), 15_000);
      const blocker = database.client.begin(async tx => {
        const [pid] = await tx.unsafe("select pg_backend_pid() as pid"); blockerPid = Number(pid!.pid);
        await tx.unsafe("lock table audit_events in access exclusive mode"); ready(); await gate;
      });
      let finishing: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        await Promise.race([locked, blocker.then(() => { throw new Error("Synthetic audit blocker ended before its lock barrier"); })]);
        finishing = maintain(async tx => { const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); writerPid = pid!.pid;
          await finishFactoryErpSourcePurge(tx, ticket, receipt); }).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        await expect.poll(async () => writerPid ? (await database.client.unsafe("select pg_blocking_pids($1)::int[] as pids from pg_stat_activity where pid=$1 and datname=current_database()", [writerPid]))[0]?.pids : [],
          { timeout: 10_000 }).toContain(blockerPid);
        const [cancelled] = await database.client.unsafe("select pg_cancel_backend(pid) as cancelled from pg_stat_activity where pid=$1 and datname=current_database()", [writerPid]);
        expect(cancelled!.cancelled).toBe(true);
        const outcome = await finishing; expect(outcome.ok).toBe(false); if (outcome.ok) throw new Error("Synthetic audit cancellation failed");
        expect(pg(outcome.error).code).toBe("57014");
      } finally { release(); clearTimeout(deadline); await blocker; if (finishing) await finishing; }
      expect(await job(entry.view.id)).toEqual(before); expect((await privateFlags(entry.view.id)).every(value => value.cleared && value.stamped)).toBe(true);
      expect(await versions(ticket.objectKey)).toEqual([]); expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(0);
      expect(await maintain(tx => finishFactoryErpSourcePurge(tx, ticket, { verifiedAbsent: true, deletedVersions: 0 }))).toMatchObject({ replayed: false });
      expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(1);
    });
  });

  it("recovers a lost committed database completion result with the same original token even after its lease time and never audits success twice", async () => {
    const entry = await seedSource(await f.scene());
    await withClock(async set => {
      await set(await sourceTime(entry.view.id)); const ticket = await claim(entry), proof = await purger.purge(ticket);
      let original: Awaited<ReturnType<typeof finishFactoryErpSourcePurge>> | undefined;
      const lost = new Error("Synthetic committed database response lost");
      await expect((async () => { original = await maintain(tx => finishFactoryErpSourcePurge(tx, ticket, proof)); throw lost; })()).rejects.toBe(lost);
      expect(original).toMatchObject({ importId: entry.view.id, replayed: false });
      await set(new Date(Date.parse(ticket.leaseExpiresAt) + 1_000).toISOString());
      const replay = await maintain(tx => finishFactoryErpSourcePurge(tx, ticket, { verifiedAbsent: true, deletedVersions: 0 }));
      expect(replay).toEqual({ ...original!, replayed: true }); expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(1);
      expect(await maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id }))).toEqual([]);
    });
  });

  it("allows one concurrent lease and a genuine expired-lease takeover while refusing the old token and duplicate completion", async () => {
    const entry = await seedSource(await f.scene());
    await withClock(async set => {
      await set(await sourceTime(entry.view.id)); expect(await maintain(tx => redactExpiredFactoryErpSources(tx, { importId: entry.view.id }))).toBe(1);
      const results = await Promise.all([maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id })), maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id }))]);
      expect(results.flat()).toHaveLength(1); const first = results.flat()[0]!; expect(first.attempts).toBe(1);
      await set(new Date(Date.parse(first.leaseExpiresAt) + 1_000).toISOString());
      await expect(maintain(tx => finishFactoryErpSourcePurge(tx, first, { verifiedAbsent: true, deletedVersions: 0 }))).rejects.toThrow("FACTORY_ERP_PURGE_LEASE_EXPIRED");
      const [second] = await maintain(tx => claimFactoryErpSourcePurges(tx, { importId: entry.view.id })); expect(second!.attempts).toBe(2); expect(second!.leaseToken).not.toBe(first.leaseToken);
      await expect(maintain(tx => finishFactoryErpSourcePurge(tx, first, { verifiedAbsent: true, deletedVersions: 0 }))).rejects.toThrow("FACTORY_ERP_PURGE_TICKET_CHANGED");
      const proof = await purger.purge(second!); await maintain(tx => finishFactoryErpSourcePurge(tx, second!, proof));
      await expect(maintain(tx => finishFactoryErpSourcePurge(tx, first, proof))).rejects.toThrow("FACTORY_ERP_PURGE_TICKET_CHANGED");
      expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(1);
    });
  });

  it("survives an actual purge-process death after physical deletion and finishes from a fresh process using the original persisted lease", async () => {
    const entry = await seedSource(await f.scene());
    const start = async (mode: "pause_after_delete" | "finish", ticket: FactoryErpPurgeTicket) => {
      const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/factory-erp-source-retention-legacy.mts")], {
        cwd: resolve(workspace, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, TSX_DISABLE_CACHE: "1", E2E_FACTORY_ERP_SOURCE_RETENTION_PURGE_CHILD: mode },
      }));
      children.push(child); await child.wait("factory.erp.retention.ready", undefined, 15_000);
      await new Promise<void>((done, reject) => child.child.send({ type: "factory.erp.retention.purge", ticket }, error => error ? reject(error) : done())); return child;
    };
    await withClock(async set => {
      await set(await sourceTime(entry.view.id)); const ticket = await claim(entry), before = await job(entry.view.id);
      const first = await start("pause_after_delete", ticket);
      await first.wait("factory.erp.retention.deleted", undefined, 30_000); expect(await versions(ticket.objectKey)).toEqual([]);
      expect(await job(entry.view.id)).toEqual(before); expect(first.child.kill("SIGKILL")).toBe(true); await first.closed;
      const second = await start("finish", ticket); const completed = await second.wait("factory.erp.retention.completed", undefined, 30_000);
      expect(completed).toMatchObject({ importId: entry.view.id, replayed: false, deletedVersions: 0 }); expect(await second.closed).toBe(0);
      expect((await job(entry.view.id))!.attempts).toBe(1); expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(1);
      expect(FACTORY_ERP_RETENTION_ACTOR).toBe("00000000-0000-7000-8000-000000000009");
    });
  });

  it("keeps a coherent lifecycle snapshot while a real factory-lock wait spans source redaction and completed physical purge", async () => {
    const scene = await f.scene(), entry = await seedSource(scene), service = f.service(), before = await immutable();
    await withClock(async set => {
      await set(await sourceTime(entry.view.id));
      let release = () => {}, ready = () => {}, rejectReady: (error: Error) => void = () => {};
      let blockerPid = 0, timedOut = false, readSettled = false;
      const locked = new Promise<void>((done, reject) => { ready = done; rejectReady = reject; });
      const gate = new Promise<void>(done => { release = done; });
      const deadline = setTimeout(() => {
        timedOut = true; release(); rejectReady(new Error("Synthetic factory lifecycle lock barrier timed out"));
      }, 45_000);
      const blocker = withTenant(database.db, f.base.context, async tx => {
        await tx.execute(sql`set local statement_timeout='10s'`);
        const [identity] = await tx.execute<{ pid: number; app: boolean }>(sql`select pg_backend_pid() as pid,current_user='yummyai_app' as app`);
        blockerPid = identity!.pid; expect(identity!.app).toBe(true);
        const factories = await tx.execute<{ id: string }>(sql`select id from fulfillment_factories
          where tenant_id=${f.base.context.tenantId}::uuid and id=${scene.site.factory.id}::uuid for update`);
        expect(Array.from(factories, row => row.id)).toEqual([scene.site.factory.id]); ready(); await gate;
      });
      type Lifecycle = Awaited<ReturnType<typeof service.lifecycle>>;
      let reading: Promise<{ ok: true; value: Lifecycle } | { ok: false; error: unknown }> | undefined;
      try {
        await Promise.race([locked, blocker.then(() => { throw new Error("Synthetic factory blocker ended before its lock barrier"); })]);
        reading = service.lifecycle(f.base.context, entry.view.id).then(value => {
          readSettled = true; return { ok: true as const, value };
        }, error => { readSettled = true; return { ok: false as const, error }; });
        // This actual FOR SHARE statement follows the source snapshot. The
        // maintenance transactions below do not take the held factory lock.
        await expect.poll(async () => Array.from(await database.client.unsafe<{ pid: number; wait_event_type: string; state: string }[]>(
          "select pid,wait_event_type,state from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and state='active' and $1=any(pg_blocking_pids(pid)) and query like '%\"fulfillment_factories\"%' and query like '%\"fulfillment_suppliers\"%' and query ilike '%for share%'",
          [blockerPid]), row => ({ pid: row.pid, wait_event_type: row.wait_event_type, state: row.state })),
          { timeout: 10_000 }).toEqual([{ pid: expect.any(Number), wait_event_type: "Lock", state: "active" }]);
        expect(readSettled).toBe(false);
        const ticket = await claim(entry), receipt = await purger.purge(ticket, { signal: AbortSignal.timeout(20_000) });
        expect(receipt).toEqual({ verifiedAbsent: true, deletedVersions: 1 });
        await maintain(tx => finishFactoryErpSourcePurge(tx, ticket, receipt));
        expect(await versions(ticket.objectKey)).toEqual([]);
        expect((await privateFlags(entry.view.id)).every(value => value.cleared && value.stamped)).toBe(true);
        expect(readSettled).toBe(false); expect(timedOut).toBe(false);
      } finally {
        release(); clearTimeout(deadline);
        try { await blocker; } finally { if (reading) await reading; }
      }
      if (!reading) throw new Error("Synthetic lifecycle read was not started");
      const first = await reading;
      if (!first.ok) throw first.error;
      expect(first.value).toMatchObject({ id: entry.view.id, access: "expired", privateRedactedAt: null,
        purgeStatus: "pending", attempts: 0, purgedAt: null, lastApplicationId: entry.result.id });
      const next = await service.lifecycle(f.base.context, entry.view.id);
      expect(next).toMatchObject({ id: entry.view.id, access: "expired", purgeStatus: "purged", attempts: 1, nextAttemptAt: null, lastApplicationId: entry.result.id });
      expect(next.privateRedactedAt).not.toBeNull(); expect(next.purgedAt).not.toBeNull();
      expect(await auditCount("factory_erp.source_redacted", entry.view.id)).toBe(1);
      expect(await auditCount("factory_erp.source_purged", entry.view.id)).toBe(1);
      expect(await immutable()).toEqual(before);
    });
  });
});
