import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type ShapedPillowDocument } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import type { ProductionPhysicalQuantities } from "@yummyai/contracts/order/production-quantity";
import { FactoryQuantityReportInputSchema } from "@yummyai/contracts/suppliers/factory-quantity";
import { memberships, orderWorkItems, orderWorkRevisions, productionEditorImages, productionEditorProjects, productionEditorVersions,
  withTenant, type DatabaseConnection } from "@yummyai/database";
import { encryptProductionBytes } from "@yummyai/production-editor";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { ClamAvProductionEditorScanner, ProductionEditorService } from "../design/production-editor.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity, factoryCapacityFixture } from "../suppliers/factory-capacity.test-fixture.js";
import { syntheticManufacturingProduct } from "./manufacturing-production.test-fixture.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { HttpAmazonReportArchiveGateway } from "./amazon-report-archive.gateway.js";
import { FactoryCollaborationService } from "./factory-collaboration.service.js";
import { FactoryProductionQuantityService } from "./factory-production-quantity.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderWorkspaceService, sealWork } from "./order-workspace.service.js";
import { ProductionQuantityService } from "./production-quantity.service.js";

export function requireFactoryQuantityEnvironment(target: "current" | "pre-0162") {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (process.env.E2E_FACTORY_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== target || !nonce ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Factory quantity requires its exact isolated schema, nonce database and bucket before connection");
  return { url, nonce };
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const physicalCounts = (u: number | null, w: number | null, c: number | null, s: number | null): ProductionPhysicalQuantities =>
  ({ unstartedQuantity: u, inProcessQuantity: w, completedQuantity: c, scrappedQuantity: s });

/** Synthetic private work admission; actual approval, JPG rendering, release,
 * capacity, grant, assignment and acceptance all use their public owners. */
export function factoryQuantityFixture(database: DatabaseConnection) {
  requireFactoryQuantityEnvironment("current");
  const base = factoryCapacityFixture(database), storage = createStorageFromEnvironment(), scanner = new ClamAvProductionEditorScanner();
  const noExternal = async () => { throw new Error("Synthetic factory quantity must not call a marketplace or model"); };
  const reports = new AmazonOrderReportService(database, base.vault, base.orders, base.audit, new HttpAmazonReportArchiveGateway(),
    { schedule: async () => undefined }, { schedule: async () => undefined });
  const editor = new ProductionEditorService(database, base.vault, storage, reports, base.audit, { enqueue: async () => undefined }, scanner);
  const work = new OrderWorkspaceService(database, base.vault, storage, reports, editor, scanner);
  const production = new OrderProductionService(database, base.vault, base.orders, base.audit, editor, base.factories);
  const delivery = new OrderProductionDeliveryService(database, base.vault, editor, production, base.audit, base.factories);
  const collaboration = new FactoryCollaborationService(database, base.audit, delivery), loader = new DatabaseMembershipContextLoader(database);
  const quantities = new ProductionQuantityService(database, base.audit), factoryQuantities = new FactoryProductionQuantityService(database, delivery, base.audit);
  const worker = new ProductionEditorRenderProcessor(database, storage, base.vault, base.vault, { generate: noExternal }, new ClamAvScanner());
  let photo: Buffer, profileVersionId: string;
  const document = (assetId?: string): ShapedPillowDocument => {
    const value = createDefaultProductionDocument("shaped_pillow");
    if (value.productType !== "shaped_pillow") throw new Error("Synthetic formal pillow document required");
    const px = 25.4 / 150, edge = 1900 * px;
    value.spec = { ...value.spec, widthMm: edge, heightMm: edge, declaredLongestMm: 254, sizeBasis: "artwork",
      minimumNeckBasis: "cut_contour", barcodeTab: { ...value.spec.barcodeTab, centerXMm: 950 * px } };
    value.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: edge, yMm: 0, smooth: false }, { xMm: edge, yMm: edge, smooth: false }, { xMm: 0, yMm: edge, smooth: false }];
    value.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
    value.layers = assetId ? [{ id: "synthetic-counted-art", kind: "image", name: "Synthetic known square print", assetId, assetVersion: 1,
      xMm: 200 * px, yMm: 200 * px, widthMm: 254, heightMm: 254, rotationDeg: 0, opacity: 1, visible: true, locked: true, flipX: false, flipY: false }] : [];
    return value;
  };
  async function initialize() {
    await base.initialize();
    photo = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 27, g: 113, b: 190, alpha: 1 } } }).png().toBuffer();
    let template = await editor.create(base.context, { name: `Synthetic factory quantity template ${createEntityId()}`, document: document() });
    const image = await editor.upload(base.context, template.project.id, "synthetic-owned-count.png", photo);
    template = await editor.save(base.context, template.project.id, { expectedVersionId: template.version.id, document: document(image.id) });
    await editor.review(base.context, template.project.id, template.version.id);
    const profiles = await work.saveProfile(base.context, { code: `FQ-${createEntityId()}`, name: "Synthetic exact factory JPG",
      projectId: template.project.id, versionId: template.version.id, instructions: "Synthetic original factory standard", expectedVersion: 0, idempotencyKey: randomUUID() });
    profileVersionId = profiles.find(value => value.projectId === template.project.id)!.versionId;
  }
  async function member(factoryId: string, canRespond = true, expiresAt?: string) {
    const userId = createEntityId(), membershipId = createEntityId(), subject = `factory-quantity-${userId}`;
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [userId, subject, `${userId}@example.invalid`, `Synthetic factory counter ${userId}`]);
    await withTenant(database.db, base.context, tx => tx.insert(memberships).values({ id: membershipId, tenantId: base.context.tenantId, userId, status: "active" }));
    const grant = await collaboration.createGrant(base.context, { factoryId, membershipId, canRespond,
      expiresAt: expiresAt ?? new Date(Date.parse((await base.clock()).now) + 3600000).toISOString(), idempotencyKey: randomUUID() });
    const context = await loader.load({ sub: subject, tenant_id: base.context.tenantId });
    if (!context || context.permissions.includes(Permission.OrderRead) || context.permissions.includes(Permission.OrderWrite)) throw new Error("Synthetic factory must have no internal order authority");
    return { userId, membershipId, subject, grant, context };
  }
  async function scene(options: { quantity?: number; accepted?: boolean; canRespond?: boolean } = {}) {
    const quantity = options.quantity ?? 10, basicSite = await base.factory(), site = await createSyntheticFactory(base.factories, base.context, basicSite.supplierId, "shaped_pillow");
    const pools = [];
    for (const rate of [2, 3]) pools.push(await createSyntheticFactoryCapacity(database, base.context, { factory: site.factory,
      bindings: [{ capabilityVersionId: site.capability.versionId, unitsPerItem: rate }], capacityUnits: 100 * rate }));
    const capacityPlan = { allocations: pools.map(pool => pool.capacityPlan.allocations[0]!) };
    let order = await base.orders.ingestNormalized(base.context, { accountId: base.owner.accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId: `SYNTHETIC-FQ-${createEntityId()}`,
      providerStatus: "paid", placedAt: (await base.clock()).now, orderTotal: null, lines: [{ externalLineId: randomUUID(), externalListingId: null, skuCode: null,
        title: "Synthetic counted pillow batch", quantity, unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
    for (const toState of ["awaiting_customization", "awaiting_design", "awaiting_customer_approval", "awaiting_routing", "in_production"] as const)
      order = await base.orders.transition(base.context, order.id, { toState, expectedSequence: order.latestEventSequence, idempotencyKey: randomUUID(), reason: "Synthetic explicit test production preparation" });
    const lineId = order.lines[0]!.id, revisionId = createEntityId(), projectId = createEntityId(), versionId = createEntityId(), assetId = createEntityId();
    const manufacturing = await syntheticManufacturingProduct(database, base.context, { profileVersionId, document: document(assetId) });
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: profileVersionId, artworkVersionId: manufacturing.artworkVersionId, specificationVersionId: manufacturing.specificationVersionId,
      salesRecipeVersionId: manufacturing.salesRecipeVersionId, designExecutor: "human", fields: [], images: [], instructions: "Synthetic reviewed full batch artwork", customerApprovalRequired: false, dueAt: null });
    const workKey = randomBytes(32), projectKey = randomBytes(32), doc = document(assetId);
    const blob = await storage.putPrivate(base.context, { body: encryptProductionBytes(projectKey, photo), domain: "order", fileName: `${assetId}.pe`, mediaType: "application/octet-stream" });
    try {
      await withTenant(database.db, base.context, async tx => {
        await tx.insert(orderWorkItems).values({ id: lineId, tenantId: base.context.tenantId, encryptedDataKey: base.vault.encrypt(workKey.toString("base64")), revision: 1, projectionVersion: 1,
          preparation: "pushed", artwork: "in_review", expiresAt: new Date(Date.parse((await base.clock()).now) + 86400000) });
        await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId: base.context.tenantId, workItemId: lineId, revision: 1, profileVersionId,
          encryptedDraft: sealWork(workKey, draft), checksum: sha(JSON.stringify(draft)), createdBy: base.context.userId });
        await tx.insert(productionEditorProjects).values({ id: projectId, tenantId: base.context.tenantId, name: "shaped_pillow", encryptedDataKey: base.vault.encrypt(projectKey.toString("base64")),
          sourceWorkItemId: lineId, sourceWorkRevisionId: revisionId, expiresAt: new Date(Date.now() + 86400000), createdBy: base.context.userId });
        await tx.insert(productionEditorVersions).values({ id: versionId, tenantId: base.context.tenantId, projectId, versionNumber: 1, encryptedDocument: sealWork(projectKey, doc), checksum: sha(JSON.stringify(doc)), createdBy: base.context.userId });
        await tx.update(productionEditorProjects).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(productionEditorProjects.id, projectId));
        await tx.insert(productionEditorImages).values({ id: assetId, tenantId: base.context.tenantId, projectId, encryptedMetadata: sealWork(projectKey, { name: "Synthetic owned original", kind: "image", mediaType: "image/png", width: 2048, height: 2048 }),
          originalObjectKey: blob.objectKey, previewObjectKey: blob.objectKey, checksum: sha(photo), byteSize: photo.byteLength });
        await tx.update(orderWorkItems).set({ pushedRevisionId: revisionId, editorProjectId: projectId }).where(eq(orderWorkItems.id, lineId));
      });
    } finally { workKey.fill(0); projectKey.fill(0); }
    const preflight = await editor.preflight(base.context, projectId, { expectedVersionId: versionId, purpose: "production", format: "jpeg", background: "white" });
    if (preflight.issues.some(issue => issue.severity === "error" || issue.severity === "manual")) throw new Error("Synthetic formal JPG must pass actual renderer preflight");
    const approved = await work.action(base.context, lineId, { action: "approve_artwork", expectedRevision: 1, expectedProjectionVersion: 1,
      expectedEditorVersionId: versionId, reason: "Synthetic operator physically checked known fixture geometry", idempotencyKey: randomUUID() });
    const render = (await editor.get(base.context, projectId)).renders.find(value => value.purpose === "production")!;
    await worker.process(JobEnvelopeSchema.parse({ jobId: render.id, type: "production_editor_render", tenantId: base.context.tenantId, requestedBy: base.context.userId,
      correlationId: render.id, idempotencyKey: render.id, payload: { renderId: render.id } }));
    if ((await editor.getRender(base.context, projectId, render.id)).status !== "completed") throw new Error("Actual synthetic JPG rendering did not complete");
    const actual = await production.releaseArtwork(base.context, lineId, { ...site.pins, expectedRevision: approved.line.revision,
      expectedProjectionVersion: approved.line.projectionVersion, renderId: render.id, supplierId: basicSite.supplierId, quantity,
      manufacturing: manufacturing.manufacturing, capacityPlan, instructions: "Synthetic exact approved JPG and original BOM", expectedCompletionAt: pools[0]!.expectedCompletionAt, idempotencyKey: randomUUID() });
    const id = actual.productionOrder.id, productionVersionId = actual.versions[0]!.id;
    const packet = await delivery.create(base.context, { supplierId: basicSite.supplierId, factoryId: site.factory.id,
      items: [{ productionOrderId: id, productionVersionId, expectedProjectionVersion: actual.productionOrder.projectionVersion }], idempotencyKey: randomUUID() });
    const collaborator = await member(site.factory.id, options.canRespond ?? true);
    const assignment = await collaboration.assign(base.context, collaborator.grant.id, { deliveryItemId: packet.items[0]!.id,
      fileChecksum: packet.items[0]!.snapshot!.file.checksum, packageChecksum: packet.checksum,
      expiresAt: new Date(Date.parse((await base.clock()).now) + 1800000).toISOString(), idempotencyKey: randomUUID() });
    if (options.accepted !== false && options.canRespond !== false) for (const kind of ["received", "accepted"] as const) {
      const view = await delivery.factoryTask(collaborator.context, assignment.id);
      await delivery.factoryFeedback(collaborator.context, assignment.id, { kind, expectedSequence: view.sequence, fileChecksum: view.file!.checksum,
        manufacturingChecksum: view.manufacturing!.recipe!.checksum, idempotencyKey: randomUUID(), reference: `Synthetic actual ${kind}`,
        note: "Synthetic collaborator personally checked this original file and manufacturing version", occurredAt: (await base.clock()).now,
        confirmedFileVersion: true, affectedQuantity: null });
    }
    return { id, productionVersionId, order, lineId, projectId, versionId, manufacturing, site, pools, capacityPlan, packet, assignment, collaborator };
  }
  async function input(value: Awaited<ReturnType<typeof scene>>, counts: ProductionPhysicalQuantities = physicalCounts(4, 2, 3, 1)) {
    const view = await factoryQuantities.workspace(value.collaborator.context, value.assignment.id, {});
    return FactoryQuantityReportInputSchema.parse({ idempotencyKey: randomUUID(), fileChecksum: view.basis.fileChecksum, manufacturingChecksum: view.basis.manufacturingChecksum,
      acceptedFeedbackId: view.basis.acceptedFeedbackId, expectedBasisFingerprint: view.basis.fingerprint, wholeProductionConfirmed: true,
      observedAt: (await base.clock()).now, quantities: counts, evidenceCode: "SYNTHETIC_FACTORY_FULL_COUNT", reference: "Synthetic full original batch physically counted" });
  }
  async function state() {
    const result = await base.state();
    await withTenant(database.db, base.context, async tx => {
      for (const table of ["factory_quantity_report_origins", "production_quantity_reports", "production_quantity_reviews", "factory_capacity_stop_effects", "quality_inspections",
        "quality_inspection_groups", "quality_group_defects", "production_recovery_groups", "shipment_production_allocations", "inventory_movements", "inventory_reservation_events"])
        result[table] = (await tx.execute<{ digest: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)::text,'[]')) as digest from ${sql.identifier(table)} item`))[0]!.digest;
    });
    return result;
  }
  return { base, storage, scanner, editor, work, production, delivery, collaboration, quantities, factoryQuantities, loader, initialize, scene, member, input, state,
    dispose() { photo?.fill(0); } };
}
