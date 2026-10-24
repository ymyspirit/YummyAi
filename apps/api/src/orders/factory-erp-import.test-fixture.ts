import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, ProductionEditorDocumentSchema, type ShapedPillowDocument } from "@yummyai/contracts";
import { FACTORY_ERP_HEADERS, type ApplyFactoryErpImport, type FactoryErpImportView, type FactoryErpItemSelection, type UploadFactoryErpImport } from "@yummyai/contracts/order/factory-erp-import";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { memberships, membershipRoles, roles, loadCurrentMembershipContext, orders, orderLines, orderSourceSnapshots, orderWorkItems, orderWorkRevisions, productionEditorImages, productionEditorProjects, productionEditorVersions,
  withTenant, type DatabaseConnection } from "@yummyai/database";
import { encryptProductionBytes } from "@yummyai/production-editor";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { ClamAvProductionEditorScanner, ProductionEditorService } from "../design/production-editor.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity, factoryCapacityFixture } from "../suppliers/factory-capacity.test-fixture.js";
import { syntheticManufacturingProduct } from "./manufacturing-production.test-fixture.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { HttpAmazonReportArchiveGateway } from "./amazon-report-archive.gateway.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderWorkspaceService, sealWork } from "./order-workspace.service.js";
import { FactoryErpSourceGateway } from "./factory-erp-source.gateway.js";
import { FactoryErpImportService } from "./factory-erp-import.service.js";

export function requireFactoryErpImportEnvironment() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || !nonce ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Factory ERP imports require the exact isolated current-schema nonce database and bucket before connection");
  return { url, nonce };
}

export const factoryErpImportTables = ["factory_erp_imports", "factory_erp_applications", "factory_erp_bindings", "factory_erp_binding_items", "factory_erp_observations", "factory_erp_application_rows"] as const;
const physicalTables = ["production_orders", "production_order_versions", "production_manufacturing_bindings", "production_milestone_events", "production_delivery_feedback",
  "factory_capacity_reservations", "factory_capacity_events", "factory_capacity_stop_effects", "production_quantity_reports", "production_quantity_reviews", "quality_inspections",
  "quality_inspection_groups", "quality_group_defects", "shipments", "shipment_versions", "shipment_production_allocations", "inventory_movements", "inventory_reservation_events"] as const;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Initial source/order/lines at in_production and encrypted private work are
 * explicit synthetic admission, not coverage of upstream customization/routing.
 * Real owner preflight, review, JPG rendering, approved manufacturing, capacity
 * release and submitted receipts follow; no acceptance or four-bucket facts. */
export function factoryErpImportFixture(database: DatabaseConnection) {
  requireFactoryErpImportEnvironment();
  const base = factoryCapacityFixture(database), storage = createStorageFromEnvironment(), scanner = new ClamAvScanner();
  const editorScanner = new ClamAvProductionEditorScanner();
  const noExternal = async () => { throw new Error("Synthetic factory ERP import must not call a marketplace or model"); };
  const reports = new AmazonOrderReportService(database, base.vault, base.orders, base.audit, new HttpAmazonReportArchiveGateway(),
    { schedule: async () => undefined }, { schedule: async () => undefined });
  const editor = new ProductionEditorService(database, base.vault, storage, reports, base.audit, { enqueue: async () => undefined }, editorScanner);
  const work = new OrderWorkspaceService(database, base.vault, storage, reports, editor, editorScanner);
  const production = new OrderProductionService(database, base.vault, base.orders, base.audit, editor, base.factories);
  const delivery = new OrderProductionDeliveryService(database, base.vault, editor, production, base.audit, base.factories);
  const source = new FactoryErpSourceGateway(storage, base.vault, scanner);
  const service = () => new FactoryErpImportService(database, base.vault, source, delivery, base.audit);
  const worker = new ProductionEditorRenderProcessor(database, storage, base.vault, base.vault, { generate: noExternal }, new ClamAvScanner());
  let photo: Buffer | undefined, profileVersionId: string;
  const document = (assetId?: string): ShapedPillowDocument => {
    const value = createDefaultProductionDocument("shaped_pillow");
    if (value.productType !== "shaped_pillow") throw new Error("Synthetic formal pillow document required");
    const px = 25.4 / 150, edge = 1900 * px;
    value.spec = { ...value.spec, widthMm: edge, heightMm: edge, declaredLongestMm: 254, sizeBasis: "artwork",
      minimumNeckBasis: "cut_contour", barcodeTab: { ...value.spec.barcodeTab, centerXMm: 950 * px } };
    value.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: edge, yMm: 0, smooth: false }, { xMm: edge, yMm: edge, smooth: false }, { xMm: 0, yMm: edge, smooth: false }];
    value.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
    value.layers = assetId ? [{ id: "synthetic-erp-art", kind: "image", name: "Synthetic known square print", assetId, assetVersion: 1,
      xMm: 200 * px, yMm: 200 * px, widthMm: 254, heightMm: 254, rotationDeg: 0, opacity: 1, visible: true, locked: true, flipX: false, flipY: false }] : [];
    return value;
  };
  async function initialize() {
    await storage.ensureBucket();
    await base.initialize();
    photo = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 27, g: 113, b: 190, alpha: 1 } } }).png().toBuffer();
    let template = await editor.create(base.context, { name: `Synthetic factory ERP template ${createEntityId()}`, document: document() });
    const image = await editor.upload(base.context, template.project.id, "synthetic-owned-erp.png", photo);
    template = await editor.save(base.context, template.project.id, { expectedVersionId: template.version.id, document: document(image.id) });
    await editor.review(base.context, template.project.id, template.version.id);
    const profiles = await work.saveProfile(base.context, { code: `FERP-${createEntityId()}`, name: "Synthetic exact factory ERP JPG",
      projectId: template.project.id, versionId: template.version.id, instructions: "Synthetic original factory standard", expectedVersion: 0, idempotencyKey: randomUUID() });
    profileVersionId = profiles.find(value => value.projectId === template.project.id)!.versionId;
  }
  async function site() {
    const supplier = await base.factory(), actual = await createSyntheticFactory(base.factories, base.context, supplier.supplierId, "shaped_pillow");
    const capacity = await createSyntheticFactoryCapacity(database, base.context, { factory: actual.factory,
      bindings: [{ capabilityVersionId: actual.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10000 });
    return { ...actual, supplierId: supplier.supplierId, capacity };
  }
  async function scene(options: { site?: Awaited<ReturnType<typeof site>>; quantities?: number[] } = {}) {
    if (!photo) throw new Error("Initialize the synthetic formal-file fixture first");
    const actualSite = options.site ?? await site(), quantities = options.quantities ?? [1, 2], now = (await base.clock()).now;
    const order = { id: createEntityId(), externalOrderId: `SYNTHETIC-FERP-${createEntityId()}`,
      lines: quantities.map(quantity => ({ id: createEntityId(), quantity })) }, sourceId = createEntityId();
    const redactedPayload = { synthetic: true, admission: "factory-erp-import-isolated-initial-production" };
    await withTenant(database.db, base.context, async tx => {
      await tx.insert(orderSourceSnapshots).values({ id: sourceId, tenantId: base.context.tenantId, accountId: base.owner.accountId, platform: "etsy",
        externalEventId: randomUUID(), externalOrderId: order.externalOrderId, normalizedOrderId: order.id,
        redactedPayload, payloadChecksum: sha(JSON.stringify(redactedPayload)) });
      await tx.insert(orders).values({ id: order.id, tenantId: base.context.tenantId, accountId: base.owner.accountId, sourceSnapshotId: sourceId, platform: "etsy",
        externalOrderId: order.externalOrderId, providerStatus: "paid", workflowState: "in_production", lineCount: order.lines.length,
        addressStatus: "protected", placedAt: new Date(now) });
      await tx.insert(orderLines).values(order.lines.map(line => ({ id: line.id, tenantId: base.context.tenantId, orderId: order.id,
        externalLineId: `SYNTHETIC-LINE-${line.id}`, title: "Synthetic factory ERP pillow", quantity: line.quantity })));
    });
    const productions = [];
    for (const line of order.lines) {
      const lineId = line.id, quantity = line.quantity, revisionId = createEntityId(), projectId = createEntityId(), versionId = createEntityId(), assetId = createEntityId();
      const manufacturing = await syntheticManufacturingProduct(database, base.context, { profileVersionId, document: document(assetId) });
      const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: profileVersionId, artworkVersionId: manufacturing.artworkVersionId, specificationVersionId: manufacturing.specificationVersionId,
        salesRecipeVersionId: manufacturing.salesRecipeVersionId, designExecutor: "human", fields: [], images: [], instructions: "Synthetic original reviewed pillow", customerApprovalRequired: false, dueAt: null });
      const workKey = randomBytes(32), projectKey = randomBytes(32), doc = ProductionEditorDocumentSchema.parse(document(assetId));
      const documentChecksum = sha(JSON.stringify(doc));
      if (documentChecksum !== sha(JSON.stringify(ProductionEditorDocumentSchema.parse(doc))))
        throw new Error("Synthetic encrypted document checksum must match its schema-normalized worker input");
      const blob = await storage.putPrivate(base.context, { body: encryptProductionBytes(projectKey, photo), domain: "order", fileName: `${assetId}.pe`, mediaType: "application/octet-stream" });
      try {
        await withTenant(database.db, base.context, async tx => {
          await tx.insert(orderWorkItems).values({ id: lineId, tenantId: base.context.tenantId, encryptedDataKey: base.vault.encrypt(workKey.toString("base64")), revision: 1, projectionVersion: 1,
            preparation: "pushed", artwork: "in_review", expiresAt: new Date(Date.parse(now) + 86400000) });
          await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId: base.context.tenantId, workItemId: lineId, revision: 1, profileVersionId,
            encryptedDraft: sealWork(workKey, draft), checksum: sha(JSON.stringify(draft)), createdBy: base.context.userId });
          await tx.insert(productionEditorProjects).values({ id: projectId, tenantId: base.context.tenantId, name: "shaped_pillow", encryptedDataKey: base.vault.encrypt(projectKey.toString("base64")),
            sourceWorkItemId: lineId, sourceWorkRevisionId: revisionId, expiresAt: new Date(Date.parse(now) + 86400000), createdBy: base.context.userId });
          await tx.insert(productionEditorVersions).values({ id: versionId, tenantId: base.context.tenantId, projectId, versionNumber: 1, encryptedDocument: sealWork(projectKey, doc), checksum: documentChecksum, createdBy: base.context.userId });
          await tx.update(productionEditorProjects).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(productionEditorProjects.id, projectId));
          await tx.insert(productionEditorImages).values({ id: assetId, tenantId: base.context.tenantId, projectId, encryptedMetadata: sealWork(projectKey, { name: "Synthetic owned ERP original", kind: "image", mediaType: "image/png", width: 2048, height: 2048 }),
            originalObjectKey: blob.objectKey, previewObjectKey: blob.objectKey, checksum: sha(photo!), byteSize: photo!.byteLength });
          await tx.update(orderWorkItems).set({ pushedRevisionId: revisionId, editorProjectId: projectId }).where(eq(orderWorkItems.id, lineId));
        });
      } finally { workKey.fill(0); projectKey.fill(0); }
      const preflight = await editor.preflight(base.context, projectId, { expectedVersionId: versionId, purpose: "production", format: "jpeg", background: "white" });
      if (preflight.issues.some(issue => issue.severity === "error" || issue.severity === "manual")) throw new Error("Synthetic formal JPG must pass actual renderer preflight");
      const approved = await work.action(base.context, lineId, { action: "approve_artwork", expectedRevision: 1, expectedProjectionVersion: 1,
        expectedEditorVersionId: versionId, reason: "Synthetic operator checked known fixture geometry", idempotencyKey: randomUUID() });
      const render = (await editor.get(base.context, projectId)).renders.find(value => value.purpose === "production");
      if (!render) throw new Error("Synthetic original production render missing");
      await worker.process(JobEnvelopeSchema.parse({ jobId: render.id, type: "production_editor_render", tenantId: base.context.tenantId, requestedBy: base.context.userId,
        correlationId: render.id, idempotencyKey: render.id, payload: { renderId: render.id } }));
      if ((await editor.getRender(base.context, projectId, render.id)).status !== "completed") throw new Error("Actual synthetic JPG rendering did not complete");
      const released = await production.releaseArtwork(base.context, lineId, { ...actualSite.pins, expectedRevision: approved.line.revision,
        expectedProjectionVersion: approved.line.projectionVersion, renderId: render.id, supplierId: actualSite.supplierId, quantity,
        manufacturing: manufacturing.manufacturing, capacityPlan: actualSite.capacity.capacityPlan, instructions: "Synthetic exact approved JPG and original BOM",
        expectedCompletionAt: actualSite.capacity.expectedCompletionAt, idempotencyKey: randomUUID() });
      productions.push({ lineId, quantity, manufacturing, projectId, editorVersionId: versionId, order: released.productionOrder, version: released.versions[0]! });
    }
    let packet = await delivery.create(base.context, { supplierId: actualSite.supplierId, factoryId: actualSite.factory.id,
      items: productions.map(value => ({ productionOrderId: value.order.id, productionVersionId: value.version.id, expectedProjectionVersion: value.order.projectionVersion })), idempotencyKey: randomUUID() });
    for (const item of packet.items) {
      if (!item.snapshot?.manufacturing) throw new Error("Synthetic formal delivery manufacturing pin missing");
      packet = await delivery.recordFeedback(base.context, packet.id, item.id, { kind: "submitted", expectedSequence: 0, idempotencyKey: randomUUID(),
        fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum, reference: "SYNTHETIC_FILE_SUBMITTED",
        note: "Synthetic operator actually submitted these fixed fixture bytes", occurredAt: (await base.clock()).now, verifiedByOperator: true });
    }
    const items: FactoryErpItemSelection[] = packet.items.map(item => {
      if (!item.snapshot?.manufacturing) throw new Error("Synthetic original manufacturing pin missing");
      return { deliveryItemId: item.id, productionOrderId: item.productionOrderId, productionVersionId: item.snapshot.productionVersionId,
        fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum };
    });
    return { order, site: actualSite, productions, packet, items, quantity: quantities.reduce((sum, quantity) => sum + quantity, 0) };
  }
  function rawRow(quantity = 3, status = "已审核", externalId = `SYNTHETIC-${createEntityId()}`): string[] {
    return [externalId, "Synthetic owned source", "SYNTHETIC-REFERENCE-ONLY", "000SYNTHETIC-TRACKING", "", "", "2", String(quantity),
      "Synthetic carrier", "Synthetic service", status, "2026-10-21 08:09:10", "2026-10-21 09:10:11"];
  }
  function uploadInput(factoryId: string, rows: string[][] = [rawRow()]): UploadFactoryErpImport {
    const quote = (text: string) => /[,\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    const bytes = Buffer.from([FACTORY_ERP_HEADERS, ...rows].map(values => values.map(quote).join(",")).join("\r\n"), "utf8");
    return { factoryId, fileName: "synthetic-factory-current-page.csv", contentBase64: bytes.toString("base64"), checksumSha256: sha(bytes),
      options: { csvEncoding: "utf-8", delimiter: "," }, idempotencyKey: randomUUID() };
  }
  function applyInput(view: FactoryErpImportView, items: FactoryErpItemSelection[], rowNumber = 2): ApplyFactoryErpImport {
    return { fileChecksum: view.fileChecksum, previewChecksum: view.previewChecksum, idempotencyKey: randomUUID(), confirmed: true,
      rows: [{ rowNumber, items, wholeGroupConfirmed: true }] };
  }
  async function tableState(tables: readonly string[]) {
    return withTenant(database.db, base.seed(), async tx => {
      const result: Record<string, { count: number; digest: string }> = {};
      for (const table of tables) result[table] = (await tx.execute<{ count: number; digest: string }>(sql`select count(*)::integer as count,
        md5(coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)::text,'[]')) as digest from ${sql.identifier(table)} item`))[0]!;
      return result;
    });
  }
  async function actor() {
    const userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [userId, `factory-erp-${userId}`, `${userId}@example.invalid`, `Synthetic ERP importer ${userId}`]);
    await withTenant(database.db, base.seed(), async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId: base.context.tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: base.context.tenantId, name: `Synthetic ERP importer role ${roleId}`, permissions: Object.values(Permission), dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: base.context.tenantId, membershipId, roleId });
    });
    return withTenant(database.db, base.seed(), tx => loadCurrentMembershipContext(tx, { ...base.seed(), userId }));
  }
  return { base, storage, scanner, source, editor, work, production, delivery, service, initialize, site, scene, rawRow, uploadInput, applyInput, actor,
    importState: () => tableState([...factoryErpImportTables, "audit_events"]), physicalState: () => tableState(physicalTables),
    dispose() { photo?.fill(0); } };
}
