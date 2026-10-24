import { createHash, randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FactoryErpApplyResultSchema, FactoryErpImportViewSchema, type ApplyFactoryErpImport, type FactoryErpImportView } from "@yummyai/contracts/order/factory-erp-import";
import { amazonOrderReportBatches, amazonOrderReportLines, amazonOrderReportVersions, connectDatabase, factoryErpApplications, factoryErpApplicationRows, factoryErpBindings, factoryErpImports, factoryErpObservations, memberships, orderWorkItems, withTenant, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FACTORY_ERP_READ, FACTORY_ERP_WRITE } from "./factory-erp-import.service.js";
import { sealFactoryErpProof } from "./factory-erp-evidence.js";
import { factoryErpImportFixture, factoryErpImportTables, requireFactoryErpImportEnvironment } from "./factory-erp-import.test-fixture.js";

requireFactoryErpImportEnvironment();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function pg(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  if ("code" in error) return error as { code?: string; message?: string };
  return "cause" in error ? pg(error.cause) : {};
}
const guard = (message: string) => (error: unknown) => pg(error).code === "23514" && pg(error).message === message;
const xid = async (tx: TenantTransaction) => (await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`))[0]!.xid;

describe.sequential("factory ERP original sources, explicit delivery groups and append-only status observations", () => {
  const database = connectDatabase(), f = factoryErpImportFixture(database), importer = f.service();
  beforeAll(() => f.initialize());
  afterEach(async () => { vi.restoreAllMocks(); await f.base.grant(); });
  // The disposable runner owns the exact tenant DB, bucket and Redis teardown,
  // including committed immutable history when this process fails.
  afterAll(async () => { vi.restoreAllMocks(); f.dispose(); await database.client.end(); });
  type Scene = Awaited<ReturnType<typeof f.scene>>;
  const head = (scene: Scene, status = "已审核", externalId = `SYNTHETIC-HEAD-${createEntityId()}`) => {
    const row = f.rawRow(scene.quantity, status, externalId); row[6] = String(scene.items.length); return row;
  };
  const original = async (id: string) => (await withTenant(database.db, f.base.seed(), tx => tx.select().from(factoryErpImports).where(eq(factoryErpImports.id, id))))[0]!;
  const auditCount = async (action: string, id: string) => (await withTenant(database.db, f.base.seed(), tx => tx.execute<{ count: number }>(sql`
    select count(*)::integer as count from audit_events where action=${action} and entity_id=${id}`)))[0]!.count;

  it("preserves scanned private original bytes and binds a complete two-item head only to its exact factory, quantity and original file versions", async () => {
    const scene = await f.scene(), otherSite = await f.site(), row = head(scene), upload = f.uploadInput(scene.site.factory.id, [row]);
    const physical = await f.physicalState(), view = FactoryErpImportViewSchema.parse(await importer.upload(f.base.context, upload));
    expect(view).toMatchObject({ factoryId: scene.site.factory.id, rowCount: 1, fileChecksum: upload.checksumSha256, coverage: "current_page_or_unspecified", diagnostics: [] });
    expect(view.rows[0]!.rawCells).toEqual(row);
    expect(view.rows[0]!.binding).toBeNull();
    const stored = await original(view.id), bytes = Buffer.from(upload.contentBase64, "base64");
    expect(stored.objectKey).toBe(`tenants/${f.base.context.tenantId}/order/${stored.storedChecksum}/${view.id}-factory-erp-source.pe`);
    expect(stored.storedChecksum).not.toBe(stored.fileChecksum);
    const cipher = await f.storage.readPrivate(f.base.context, { id: stored.id, tenantId: stored.tenantId, assetDomain: "order", objectKey: stored.objectKey }, { requiredDomain: "order" });
    expect(sha(cipher)).toBe(stored.storedChecksum);
    expect(Buffer.from(cipher).includes(Buffer.from(row[0]!))).toBe(false);
    const recovered = await f.source.read(f.base.context, view.id, stored.objectKey, stored.storedChecksum, stored.fileChecksum);
    try { expect(recovered.equals(bytes)).toBe(true); } finally { recovered.fill(0); bytes.fill(0); }
    if (stored.encryptedPayload === null) throw new Error("Fresh retained source must contain its private preview");
    const scan = f.base.vault.withSecret(stored.encryptedPayload, value => (JSON.parse(value) as { scan: { engine: string; result: string; signatureVersion: string } }).scan);
    expect(scan).toMatchObject({ engine: "clamav-clamd", result: "clean" });
    expect(scan.signatureVersion).not.toBe("unavailable");
    const candidates = await importer.candidates(f.base.context, { factoryId: scene.site.factory.id });
    expect(candidates.items.map(item => item.deliveryItemId).sort()).toEqual(scene.items.map(item => item.deliveryItemId).sort());
    const input = f.applyInput(view, scene.items), before = await f.importState();
    const badPins: ApplyFactoryErpImport[] = [
      { ...input, idempotencyKey: randomUUID(), rows: [{ ...input.rows[0]!, items: [scene.items[0]!] }] },
      ...["productionVersionId", "fileChecksum", "manufacturingChecksum"].map(field => ({ ...input, idempotencyKey: randomUUID(), rows: [{ ...input.rows[0]!, items: scene.items.map((item, index) => index ? item :
        { ...item, [field]: field === "productionVersionId" ? createEntityId() : "d".repeat(64) }) }] })),
    ];
    for (const invalid of badPins) {
      await expect(importer.apply(f.base.context, view.id, invalid)).rejects.toBeInstanceOf(ConflictException);
      expect(await f.importState()).toEqual(before);
    }
    const wrongFactory = await importer.upload(f.base.context, f.uploadInput(otherSite.factory.id, [row])), wrongBefore = await f.importState();
    await expect(importer.apply(f.base.context, wrongFactory.id, f.applyInput(wrongFactory, scene.items))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.importState()).toEqual(wrongBefore);
    const result = FactoryErpApplyResultSchema.parse(await importer.apply(f.base.context, view.id, input));
    expect(result).toMatchObject({ importId: view.id, appliedRows: 1, observations: [{ rowNumber: 2, status: "scheduled", disposition: "advanced" }] });
    const fixed = await importer.get(f.base.context, view.id, {});
    expect(fixed.rows[0]!.binding!.items.map(item => item.deliveryItemId).sort()).toEqual(scene.items.map(item => item.deliveryItemId).sort());
    expect(await f.physicalState()).toEqual(physical);
    for (const item of scene.packet.items) expect(item.feedback.map(value => value.kind)).toEqual(["submitted"]);
  });

  it("never regresses a shipped head or interprets voids and current-page absence as cancellation, physical production or shipment quantity", async () => {
    const scene = await f.scene({ quantities: [1, 2, 1] }), selected = scene.items.slice(0, 2);
    const linked = { ...scene, items: selected, quantity: selected.reduce((sum, item) => sum + scene.productions.find(value => value.order.id === item.productionOrderId)!.quantity, 0) };
    const externalId = `SYNTHETIC-PROGRESS-${createEntityId()}`, physical = await f.physicalState();
    const apply = async (status: string, updated: string) => {
      const row = head(linked, status, externalId); row[11] = "2020-01-01 00:00:00"; row[12] = updated;
      const view = await importer.upload(f.base.context, f.uploadInput(scene.site.factory.id, [row]));
      return importer.apply(f.base.context, view.id, f.applyInput(view, linked.items));
    };
    await apply("已审核", "2026-10-21 09:10:11");
    await apply("已出库", "2026-10-21 10:11:12");
    const older = await apply("已审核", "2020-01-01 01:02:03");
    expect(older.observations[0]).toMatchObject({ disposition: "unchanged", status: "shipped" });
    const voided = await apply("已作废", "2026-10-21 11:12:13");
    expect(voided.observations[0]).toMatchObject({ disposition: "exception", status: "shipped" });
    const packet = await f.delivery.get(f.base.context, scene.packet.id);
    for (const item of packet.items.filter(value => linked.items.some(pin => pin.deliveryItemId === value.id))) {
      expect(item.factoryErp).toMatchObject({ externalId, status: "shipped", exception: "voided_requires_review", rawStatus: "已出库", shippedQuantity: null,
        updatedAtLocal: "2026-10-21 10:11:12" });
      expect(item.status).toBe("submitted");
    }
    expect(packet.items.find(item => item.id === scene.items[2]!.deliveryItemId)!.factoryErp).toBeNull();
    expect(await f.physicalState()).toEqual(physical);
    const history = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpObservations).where(eq(factoryErpObservations.bindingId, voided.observations[0]!.bindingId)));
    expect(history.map(value => value.rawStatus).sort()).toEqual(["已审核", "已审核", "已出库", "已作废"].sort());
  });

  it("recovers concurrent uploads and applications in a fresh service with one original result and rejects changed bodies and actors", async () => {
    const scene = await f.scene({ quantities: [1] }), request = f.uploadInput(scene.site.factory.id, [head(scene)]), before = await f.importState();
    const discard = vi.spyOn(f.source, "discard"), storeReal = f.source.store.bind(f.source);
    let arrived = 0, release = () => {};
    const storedBoth = new Promise<void>(resolve => { release = resolve; });
    const deadline = setTimeout(() => release(), 10_000);
    const store = vi.spyOn(f.source, "store").mockImplementation(async (...args) => {
      const receipt = await storeReal(...args);
      if (++arrived === 2) release();
      await storedBoth;
      return receipt;
    });
    const views: FactoryErpImportView[] = [];
    try {
      // Both actual objects exist before either transaction can claim the key.
      // The deadline releases a failed participant; all branches are awaited.
      const outcomes = await Promise.allSettled([importer.upload(f.base.context, request), f.service().upload(f.base.context, request)]);
      expect(outcomes.map(value => value.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(arrived).toBe(2);
      views.push(...outcomes.flatMap(value => value.status === "fulfilled" ? [value.value] : []));
    } finally { release(); clearTimeout(deadline); store.mockRestore(); }
    expect(views[0]!.id).toBe(views[1]!.id);
    expect(await auditCount("factory_erp.import_uploaded", views[0]!.id)).toBe(1);
    expect((await f.importState()).factory_erp_imports!.count).toBe(before.factory_erp_imports!.count + 1);
    expect(discard).toHaveBeenCalledTimes(1);
    const savedSource = await original(views[0]!.id);
    expect(discard.mock.calls[0]![2]).not.toBe(savedSource.objectKey);
    expect(await f.service().upload(f.base.context, request)).toEqual(views[0]);
    await expect(importer.upload(f.base.context, { ...request, fileName: "synthetic-changed-name.csv" })).rejects.toBeInstanceOf(ConflictException);
    const other = await f.actor();
    await expect(importer.upload(other, request)).rejects.toBeInstanceOf(ConflictException);
    const input = f.applyInput(views[0]!, scene.items), results = await Promise.all([
      importer.apply(f.base.context, views[0]!.id, input), f.service().apply(f.base.context, views[0]!.id, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await f.service().apply(f.base.context, views[0]!.id, input)).toEqual(results[0]);
    expect(await auditCount("factory_erp.import_applied", results[0]!.id)).toBe(1);
    const after = await f.importState();
    await expect(importer.apply(f.base.context, views[0]!.id, { ...input, rows: [{ ...input.rows[0]!, items: [{ ...scene.items[0]!, fileChecksum: "f".repeat(64) }] }] })).rejects.toBeInstanceOf(ConflictException);
    await expect(importer.apply(other, views[0]!.id, input)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.importState()).toEqual(after);
    const sameRowNewSource = await importer.upload(f.base.context, { ...request, idempotencyKey: randomUUID() });
    const duplicate = await importer.apply(f.base.context, sameRowNewSource.id, f.applyInput(sameRowNewSource, scene.items));
    expect(duplicate.observations[0]).toMatchObject({ observationId: results[0]!.observations[0]!.observationId, disposition: "unchanged" });
    expect((await f.importState()).factory_erp_observations!.count).toBe(after.factory_erp_observations!.count);
  });

  it("checks fresh membership and each tenant permission before reads and successful-key replay without allowing another tenant or a wider request to restore them", async () => {
    const scene = await f.scene({ quantities: [1] }), request = f.uploadInput(scene.site.factory.id, [head(scene)]), view = await importer.upload(f.base.context, request);
    const input = f.applyInput(view, scene.items); await importer.apply(f.base.context, view.id, input);
    await expect(importer.get(f.base.foreignContext, view.id, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(importer.apply(f.base.foreignContext, view.id, input)).rejects.toBeInstanceOf(NotFoundException);
    await f.base.grant(FACTORY_ERP_READ);
    expect((await importer.get(f.base.context, view.id, {})).id).toBe(view.id);
    const unchanged = await f.importState(), scan = vi.spyOn(f.scanner, "scan");
    await expect(importer.upload(f.base.context, request)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(importer.apply(f.base.context, view.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(scan).not.toHaveBeenCalled();
    await f.base.grant([Permission.OrderWrite], "self", FACTORY_ERP_READ);
    expect((await importer.get(f.base.context, view.id, {})).id).toBe(view.id);
    await expect(importer.apply(f.base.context, view.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await f.base.grant(FACTORY_ERP_READ, "self", [Permission.OrderWrite]);
    await expect(importer.get(f.base.context, view.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await f.base.grant();
    const ceiling = { ...f.base.context, permissions: [...FACTORY_ERP_READ], permissionScopes: Object.fromEntries(FACTORY_ERP_READ.map(permission => [permission, "tenant" as const])) };
    await expect(importer.apply(ceiling, view.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    for (const permission of [Permission.DesignRead, Permission.AssetRead]) for (const scope of ["self", "team"] as const) {
      // Other read/write grants remain tenant-wide; one narrow permission must
      // not be promoted by the global scope or the other role.
      await f.base.grant([permission], scope, FACTORY_ERP_WRITE.filter(value => value !== permission));
      await expect(importer.get(f.base.context, view.id, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importer.upload(f.base.context, request)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importer.apply(f.base.context, view.id, input)).rejects.toBeInstanceOf(ForbiddenError);
      await f.base.grant();
      const narrowRequest = { ...f.base.context, permissionScopes: { ...(f.base.context.permissionScopes ?? {}), [permission]: scope } };
      await expect(importer.get(narrowRequest, view.id, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importer.upload(narrowRequest, request)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importer.apply(narrowRequest, view.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(scan).not.toHaveBeenCalled();
    await withTenant(database.db, f.base.seed(), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.base.owner.membershipId)));
    await expect(importer.get(f.base.context, view.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await f.base.grant();
    expect(await f.importState()).toEqual(unchanged);
  });

  it("rechecks authority after real scanning and real upload and compensates only its exact unreferenced encrypted source", async () => {
    const scene = await f.scene({ quantities: [1] }), keptRequest = f.uploadInput(scene.site.factory.id, [head(scene)]), kept = await importer.upload(f.base.context, keptRequest);
    const saved = await original(kept.id), before = await f.importState(), scanReal = f.scanner.scan.bind(f.scanner), putReal = f.storage.putPrivate.bind(f.storage);
    const put = vi.spyOn(f.storage, "putPrivate"), discard = vi.spyOn(f.source, "discard");
    const scan = vi.spyOn(f.scanner, "scan").mockImplementationOnce(async input => {
      const actual = await scanReal(input); await f.base.grant(FACTORY_ERP_READ); return actual;
    });
    try {
      await expect(importer.upload(f.base.context, { ...keptRequest, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
      expect(put).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled(); expect(await f.importState()).toEqual(before);
    } finally { scan.mockRestore(); await f.base.grant(); }
    put.mockImplementationOnce(async (context, input) => { const receipt = await putReal(context, input); await f.base.grant(FACTORY_ERP_READ); return receipt; });
    try {
      await expect(importer.upload(f.base.context, { ...keptRequest, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
      expect(discard).toHaveBeenCalledTimes(1);
      const [, discardedId, discardedKey] = discard.mock.calls[0]!;
      expect(discardedKey).not.toBe(saved.objectKey);
      expect(await f.importState()).toEqual(before);
      await f.base.grant();
      await expect(f.storage.readPrivate(f.base.context, { id: discardedId, tenantId: f.base.context.tenantId, assetDomain: "order", objectKey: discardedKey }, { requiredDomain: "order" })).rejects.toThrow();
      const bytes = await f.source.read(f.base.context, kept.id, saved.objectKey, saved.storedChecksum, saved.fileChecksum);
      try { expect(sha(bytes)).toBe(kept.fileChecksum); } finally { bytes.fill(0); }
    } finally { await f.base.grant(); }
  });

  it("rejects application after membership changes during the actual private source read and retains the referenced original object", async () => {
    const scene = await f.scene({ quantities: [1] }), view = await importer.upload(f.base.context, f.uploadInput(scene.site.factory.id, [head(scene)]));
    const input = f.applyInput(view, scene.items), saved = await original(view.id), before = await f.importState(), physical = await f.physicalState();
    const readReal = f.storage.readPrivate.bind(f.storage), discard = vi.spyOn(f.source, "discard");
    const read = vi.spyOn(f.storage, "readPrivate").mockImplementationOnce(async (...args) => {
      const bytes = await readReal(...args); await f.base.grant(FACTORY_ERP_READ.filter(permission => permission !== Permission.AssetRead)); return bytes;
    });
    try {
      await expect(importer.apply(f.base.context, view.id, input)).rejects.toBeInstanceOf(ForbiddenError);
      expect(read).toHaveBeenCalledTimes(1); expect(discard).not.toHaveBeenCalled();
      expect(await f.importState()).toEqual(before); expect(await f.physicalState()).toEqual(physical);
    } finally { read.mockRestore(); await f.base.grant(); }
    const recovered = await f.source.read(f.base.context, view.id, saved.objectKey, saved.storedChecksum, saved.fileChecksum);
    try { expect(sha(recovered)).toBe(view.fileChecksum); } finally { recovered.fill(0); }
    expect((await importer.apply(f.base.context, view.id, input)).appliedRows).toBe(1);
  });

  it("rolls back upload and complete application facts when their own transaction audit fails and retries the unchanged original intent once", async () => {
    const scene = await f.scene({ quantities: [1] }), request = f.uploadInput(scene.site.factory.id, [head(scene)]), before = await f.importState(), physical = await f.physicalState();
    const realAudit = f.base.audit.recordInTransaction.bind(f.base.audit), failure = new Error("Synthetic factory ERP audit rollback");
    let sawUncommittedUpload = false, sawUncommittedApplication = false;
    const audit = vi.spyOn(f.base.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      const id = await realAudit(tx, context, event);
      if (event.action === "factory_erp.import_uploaded") {
        sawUncommittedUpload = (await tx.select().from(factoryErpImports).where(eq(factoryErpImports.id, event.resourceId!))).length === 1;
        throw failure;
      }
      return id;
    });
    const discard = vi.spyOn(f.source, "discard");
    await expect(importer.upload(f.base.context, request)).rejects.toBe(failure);
    expect(sawUncommittedUpload).toBe(true); expect(discard).toHaveBeenCalledTimes(1); expect(await f.importState()).toEqual(before);
    audit.mockRestore();
    const view = await f.service().upload(f.base.context, request), input = f.applyInput(view, scene.items), uploaded = await f.importState();
    expect(await auditCount("factory_erp.import_uploaded", view.id)).toBe(1);
    const applyAudit = vi.spyOn(f.base.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      const id = await realAudit(tx, context, event);
      if (event.action === "factory_erp.import_applied") {
        sawUncommittedApplication = (await tx.select().from(factoryErpApplications).where(eq(factoryErpApplications.id, event.resourceId!))).length === 1 &&
          (await tx.select().from(factoryErpObservations).where(eq(factoryErpObservations.applicationId, event.resourceId!))).length === 1;
        throw failure;
      }
      return id;
    });
    await expect(importer.apply(f.base.context, view.id, input)).rejects.toBe(failure);
    expect(sawUncommittedApplication).toBe(true); expect(await f.importState()).toEqual(uploaded); expect(await f.physicalState()).toEqual(physical);
    applyAudit.mockRestore();
    const result = await f.service().apply(f.base.context, view.id, input);
    expect(await f.service().apply(f.base.context, view.id, input)).toEqual(result);
    expect(await auditCount("factory_erp.import_applied", result.id)).toBe(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("forces tenant RLS and immutable app access and rejects raw source or application closure and later-transaction child laundering", async () => {
    const scene = await f.scene({ quantities: [1] }), view = await importer.upload(f.base.context, f.uploadInput(scene.site.factory.id, [head(scene)]));
    const result = await importer.apply(f.base.context, view.id, f.applyInput(view, scene.items)), source = await original(view.id);
    const laterRow = head(scene, "已审核", view.rows[0]!.externalId); laterRow[12] = "2026-10-21 09:11:12";
    const laterView = await importer.upload(f.base.context, f.uploadInput(scene.site.factory.id, [laterRow])), before = await f.importState();
    const [application] = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpApplications).where(eq(factoryErpApplications.id, result.id)));
    const [binding] = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpBindings).where(eq(factoryErpBindings.id, result.observations[0]!.bindingId)));
    expect(application).toBeTruthy(); expect(binding).toBeTruthy();
    const role = await withTenant(database.db, f.base.context, tx => tx.execute<{ role: string; forced: boolean }>(sql`select current_user::text as role,
      (select relforcerowsecurity from pg_class where oid='factory_erp_imports'::regclass) as forced`));
    expect(role[0]).toEqual({ role: "yummyai_app", forced: true });
    for (const table of factoryErpImportTables) {
      const foreign = await withTenant(database.db, f.base.foreignContext, tx => tx.execute(sql`select id from ${sql.identifier(table)}`));
      expect(foreign).toHaveLength(0);
      await expect(withTenant(database.db, f.base.context, tx => tx.execute(sql`update ${sql.identifier(table)} set id=id`))).rejects.toSatisfy(error => pg(error).code === "42501");
      await expect(withTenant(database.db, f.base.context, tx => tx.execute(sql`delete from ${sql.identifier(table)}`))).rejects.toSatisfy(error => pg(error).code === "42501");
    }
    const sourceClone = async (tx: TenantTransaction) => {
      const id = createEntityId();
      await tx.insert(factoryErpImports).values({ ...source, id, idempotencyKey: randomUUID(), creationTransactionId: await xid(tx),
        objectKey: `tenants/${source.tenantId}/order/${source.storedChecksum}/${id}-factory-erp-source.pe`,
        // This is a rolled-back SQL closure control, not another real upload.
        // Re-sign only the public claims for its genuinely new identity.
        sourceProof: sealFactoryErpProof(f.base.vault, { ...source, id }) });
      return id;
    };
    await expect(withTenant(database.db, f.base.context, async tx => { await sourceClone(tx); await tx.execute(sql`set constraints all immediate`); }))
      .rejects.toSatisfy(guard("factory_erp_source_audit_required"));
    const rollback = new Error("Synthetic valid raw closure control rollback");
    await expect(withTenant(database.db, f.base.context, async tx => {
      const id = await sourceClone(tx);
      await f.base.audit.recordInTransaction(tx, f.base.context, { action: "factory_erp.import_uploaded", resourceType: "factory_erp_import", resourceId: id, result: "success", metadata: {} });
      await tx.execute(sql`set constraints all immediate`);
      throw rollback;
    })).rejects.toBe(rollback);
    await expect(withTenant(database.db, f.base.context, async tx => {
      const id = createEntityId(), input = { ...application!.input, idempotencyKey: randomUUID() }, createdAt = new Date();
      const requestCanonical = canonicalJson({ version: 1, operation: "factory-erp-apply", importId: view.id, input }), requestChecksum = sha(requestCanonical);
      await tx.insert(factoryErpApplications).values({ ...application!, id, input, idempotencyKey: input.idempotencyKey, requestCanonical, requestChecksum,
        createdAt, creationTransactionId: await xid(tx), result: { ...application!.result, id, requestChecksum, createdAt: createdAt.toISOString() } });
      await f.base.audit.recordInTransaction(tx, f.base.context, { action: "factory_erp.import_applied", resourceType: "factory_erp_application", resourceId: id, result: "success", metadata: { importId: view.id, rows: 1 } });
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toSatisfy(guard("factory_erp_rows_closure_required"));
    await expect(withTenant(database.db, f.base.context, tx => tx.insert(factoryErpBindings).values({ ...binding!, id: createEntityId(), externalKey: "e".repeat(64), creationTransactionId: sql`pg_current_xact_id()::text` })))
      .rejects.toSatisfy(guard("factory_erp_application_birth_required"));
    const nativeGraph = async (tx: TenantTransaction, tamper: "none" | "result_status" | "observation_status" = "none") => {
      const id = createEntityId(), observationId = createEntityId(), input = f.applyInput(laterView, scene.items), createdAt = new Date(), creationTransactionId = await xid(tx);
      const requestCanonical = canonicalJson({ version: 1, operation: "factory-erp-apply", importId: laterView.id, input }), requestChecksum = sha(requestCanonical);
      const raw = laterView.rows[0]!;
      const originalRow = { rowNumber: raw.rowNumber, rawCells: raw.rawCells, externalId: raw.externalId, sourceLabel: raw.sourceLabel, orderReference: raw.orderReference,
        trackingReference: raw.trackingReference, sizeText: raw.sizeText, customizationText: raw.customizationText, itemKinds: raw.itemKinds, itemQuantity: raw.itemQuantity,
        carrier: raw.carrier, carrierService: raw.carrierService, rawStatus: raw.rawStatus, createdAtLocal: raw.createdAtLocal, updatedAtLocal: raw.updatedAtLocal };
      const fullResult = { id, importId: laterView.id, fileChecksum: laterView.fileChecksum, previewChecksum: laterView.previewChecksum, requestChecksum,
        createdAt: createdAt.toISOString(), appliedRows: 1, observations: [{ rowNumber: 2, bindingId: binding!.id, observationId, disposition: "unchanged" as const,
          status: tamper === "result_status" ? "shipped" as const : "scheduled" as const }] };
      await tx.insert(factoryErpApplications).values({ ...application!, id, importId: laterView.id, idempotencyKey: input.idempotencyKey, input,
        requestCanonical, requestChecksum, createdAt, creationTransactionId, result: fullResult });
      const observation = { tenantId: f.base.context.tenantId, bindingId: binding!.id, applicationId: id, importId: laterView.id, rowNumber: 2,
        rowChecksum: sha(canonicalJson({ ...originalRow, rowNumber: undefined })), rawStatus: tamper === "observation_status" ? "已出库" : originalRow.rawStatus,
        encryptedPayload: f.base.vault.encrypt(JSON.stringify(originalRow)), createdBy: f.base.context.userId, creationTransactionId, createdAt };
      await tx.insert(factoryErpObservations).values({ ...observation, id: observationId });
      await tx.insert(factoryErpApplicationRows).values({ id: createEntityId(), tenantId: f.base.context.tenantId, applicationId: id, rowNumber: 2,
        bindingId: binding!.id, observationId, disposition: "unchanged" });
      await f.base.audit.recordInTransaction(tx, f.base.context, { action: "factory_erp.import_applied", resourceType: "factory_erp_application", resourceId: id,
        result: "success", metadata: { importId: laterView.id, rows: 1 } });
      return observation;
    };
    await expect(withTenant(database.db, f.base.context, async tx => {
      await nativeGraph(tx, "result_status");
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toSatisfy(guard("factory_erp_status_mismatch"));
    await expect(withTenant(database.db, f.base.context, async tx => {
      // Source claims stay pinned to the real 已审核 file. The BEFORE guard
      // rejects the forged observation before an audit could seal it.
      await nativeGraph(tx, "observation_status");
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toSatisfy(guard("factory_erp_observation_source_required"));
    let completeClosureFlushed = false;
    await expect(withTenant(database.db, f.base.context, async tx => {
      const observation = await nativeGraph(tx);
      await tx.execute(sql`set constraints all immediate`);
      completeClosureFlushed = true;
      // The complete, genuinely sourced graph passed its deferred checks. Even
      // this same full transaction must not append another unrequested fact.
      await tx.insert(factoryErpObservations).values({ ...observation, id: createEntityId(), rowChecksum: sha("Synthetic forbidden post-audit observation"), rawStatus: "已出库" });
    })).rejects.toSatisfy(guard("factory_erp_application_sealed"));
    expect(completeClosureFlushed).toBe(true);
    expect(await f.importState()).toEqual(before);
  });

  it("preserves legacy non-membership delivery creation and exact replay while withholding factory ERP sources and denying the new importer", async () => {
    const scene = await f.scene({ quantities: [1] }), upload = f.uploadInput(scene.site.factory.id, [head(scene)]);
    const view = await importer.upload(f.base.context, upload), input = f.applyInput(view, scene.items);
    await importer.apply(f.base.context, view.id, input);
    const personal = await f.delivery.get(f.base.context, scene.packet.id);
    expect(personal.items[0]!.factoryErp).toMatchObject({ externalId: view.rows[0]!.externalId, status: "scheduled" });
    const personalProduction = await f.production.get(f.base.context, scene.productions[0]!.order.id);
    expect(personalProduction.deliveryReceipt).toMatchObject({ packageId: scene.packet.id, itemId: scene.items[0]!.deliveryItemId,
      status: "submitted", factoryErp: { externalId: view.rows[0]!.externalId, status: "scheduled" } });
    const [storedPackage] = await withTenant(database.db, f.base.seed(), tx => tx.execute<{ idempotency_key: string }>(sql`
      select idempotency_key from production_delivery_packages where id=${scene.packet.id}`));
    expect(storedPackage).toBeTruthy();
    const originalCreate = { factoryId: scene.site.factory.id, supplierId: scene.site.supplierId,
      items: scene.productions.map(value => ({ productionOrderId: value.order.id, productionVersionId: value.version.id,
        expectedProjectionVersion: value.order.projectionVersion })), idempotencyKey: storedPackage!.idempotency_key };
    // The user is real, but this explicit legacy adapter has no per-permission
    // membership map. It must not gain access to the new private source domain.
    const legacy = f.base.seed();
    expect(legacy.permissionScopes).toBeUndefined();
    await withTenant(database.db, legacy, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.base.owner.membershipId)));
    try {
      const [membership] = await withTenant(database.db, legacy, tx => tx.select().from(memberships).where(eq(memberships.id, f.base.owner.membershipId)));
      expect(membership).toMatchObject({ userId: legacy.userId, status: "disabled" });
      const physical = await f.physicalState(), before = await f.importState();
      const saved = await f.delivery.get(legacy, scene.packet.id);
      expect(saved).toEqual({ ...personal, items: personal.items.map(item => ({ ...item, factoryErp: null })) });
      expect(saved.items[0]!.feedback.map(event => event.kind)).toEqual(["submitted"]);
      const legacyProduction = await f.production.get(legacy, scene.productions[0]!.order.id);
      expect(legacyProduction).toEqual({ ...personalProduction, deliveryReceipt: { ...personalProduction.deliveryReceipt, factoryErp: null } });
      expect(await f.delivery.create(legacy, originalCreate)).toEqual(saved);
      expect(await f.importState()).toEqual(before);

      const current = await withTenant(database.db, legacy, tx => tx.execute<{ id: string; projection_version: number }>(sql`
        select id,projection_version from production_orders where id=${scene.productions[0]!.order.id}`));
      expect(current).toHaveLength(1);
      const newCreate = { ...originalCreate, idempotencyKey: randomUUID(), items: originalCreate.items.map(item =>
        ({ ...item, expectedProjectionVersion: current.find(value => value.id === item.productionOrderId)!.projection_version })) };
      const created = await f.delivery.create(legacy, newCreate);
      expect(created.id).not.toBe(scene.packet.id);
      expect(created.items).toHaveLength(1);
      expect(created.items[0]).toMatchObject({ productionOrderId: scene.productions[0]!.order.id, factoryErp: null,
        status: "pending", feedback: [], snapshot: { productionVersionId: scene.productions[0]!.version.id,
          file: { checksum: scene.items[0]!.fileChecksum }, manufacturing: { plan: { checksum: scene.items[0]!.manufacturingChecksum } } } });
      expect(await auditCount("production_delivery.create", created.id)).toBe(1);
      const afterCreate = await f.importState(), scan = vi.spyOn(f.scanner, "scan");
      expect(await f.delivery.create(legacy, newCreate)).toEqual(created);
      await expect(importer.get(legacy, view.id, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importer.upload(legacy, upload)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importer.apply(legacy, view.id, input)).rejects.toBeInstanceOf(ForbiddenError);
      expect(scan).not.toHaveBeenCalled();
      expect(await f.importState()).toEqual(afterCreate);
      expect(await f.physicalState()).toEqual(physical);
    } finally {
      await withTenant(database.db, legacy, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, f.base.owner.membershipId)));
    }
  });

  it("binds a submitted report-backed delivery with two null source versions but rejects a changed or expired original report without new import facts", async () => {
    const scene = await f.scene({ quantities: [1] }), production = scene.productions[0]!, context = f.base.context;
    const batchId = createEntityId(), reportId = createEntityId(), versionId = createEntityId();
    const now = (await f.base.clock()).now, expiresAt = new Date(Date.parse(now) + 86_400_000);
    const source = JSON.stringify({ synthetic: true, orderId: scene.order.id, orderLineId: production.lineId,
      admission: "report-source-null-comparison-only-not-an-Amazon-import" });
    // This exact synthetic report/work association tests the schema boundary.
    // The original reviewed JPG, manufacturing, capacity and submission owners
    // above remain unchanged; no existing revision or production state is rewritten.
    await withTenant(database.db, context, async tx => {
      await tx.insert(amazonOrderReportBatches).values({ id: batchId, tenantId: context.tenantId, accountId: f.base.owner.accountId,
        marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-null-source-report.txt", reportChecksum: sha(source),
        encryptedReport: f.base.vault.encrypt(source), rowCount: 1, orderCount: 1, newOrderCount: 1,
        status: "completed", createdBy: context.userId, expiresAt });
      await tx.insert(amazonOrderReportLines).values({ id: reportId, tenantId: context.tenantId, orderId: scene.order.id,
        orderLineId: production.lineId, batchId, sourceChecksum: sha(source), encryptedSource: f.base.vault.encrypt(source),
        state: "none", currentVersionId: null, versionNumber: 0, expiresAt });
      await tx.update(orderWorkItems).set({ reportLineId: reportId }).where(eq(orderWorkItems.id, production.lineId));
    });
    const [pins] = await withTenant(database.db, context, tx => tx.execute<{ report_id: string; report_version: string | null; revision_source_version: string | null }>(sql`
      select ar.id as report_id,ar.current_version_id as report_version,wr.source_version_id as revision_source_version
      from order_work_items w join order_work_revisions wr on wr.tenant_id=w.tenant_id and wr.id=w.pushed_revision_id and wr.work_item_id=w.id
      join amazon_order_report_lines ar on ar.tenant_id=w.tenant_id and ar.id=w.report_line_id
      where w.id=${production.lineId}`));
    expect(pins).toEqual({ report_id: reportId, report_version: null, revision_source_version: null });
    const current = async () => (await withTenant(database.db, context, tx => tx.execute<{ admissible: boolean }>(sql`
      select factory_erp_delivery_current(${context.tenantId}::uuid,${scene.items[0]!.deliveryItemId}::uuid,${scene.site.factory.id}::uuid) as admissible`)))[0]!.admissible;
    expect(await current()).toBe(true);
    const view = await importer.upload(context, f.uploadInput(scene.site.factory.id, [head(scene)]));
    const result = await importer.apply(context, view.id, f.applyInput(view, scene.items));
    expect(result.observations).toMatchObject([{ rowNumber: 2, status: "scheduled", disposition: "advanced" }]);
    expect(await auditCount("factory_erp.import_applied", result.id)).toBe(1);
    const physical = await f.physicalState(), saved = await f.importState();

    await withTenant(database.db, context, tx => tx.update(amazonOrderReportLines).set({
      expiresAt: new Date(Date.parse(now) - 1_000) }).where(eq(amazonOrderReportLines.id, reportId)));
    expect(await current()).toBe(false);
    await expect(importer.apply(context, view.id, f.applyInput(view, scene.items))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.importState()).toEqual(saved);

    await withTenant(database.db, context, async tx => {
      await tx.insert(amazonOrderReportVersions).values({ id: versionId, tenantId: context.tenantId, reportLineId: reportId,
        versionNumber: 1, checksum: sha(source), encryptedDocument: f.base.vault.encrypt(source),
        scanEngine: "synthetic-schema-only", scanSignature: "not-an-external-scan", expiresAt });
      await tx.update(amazonOrderReportLines).set({ currentVersionId: versionId, versionNumber: 1, expiresAt }).where(eq(amazonOrderReportLines.id, reportId));
    });
    expect(await current()).toBe(false);
    await expect(importer.apply(context, view.id, f.applyInput(view, scene.items))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.importState()).toEqual(saved);

    expect(await f.physicalState()).toEqual(physical);
  });
});
