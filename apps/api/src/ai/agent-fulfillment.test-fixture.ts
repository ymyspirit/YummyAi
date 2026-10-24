import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { Permission, erpPermissionContext, intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, ProductionEditorDocumentSchema, TenantContextSchema, type TenantContext, type ShapedPillowDocument } from "@yummyai/contracts";
import { AGENT_FULFILLMENT_VERSION, AGENT_FULFILLMENT_TOOL, AgentFulfillmentCallSchema, type AgentFulfillmentKind } from "@yummyai/contracts/ai/agent-fulfillment";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { RecordQualityGroupsInputSchema } from "@yummyai/contracts/order/quality-groups";
import { CreateShipmentInputSchema } from "@yummyai/contracts/order/shipment";
import { LogisticsConnectionProfileSchema, type LogisticsQuote, type LogisticsTaskSnapshot, type LogisticsConnectionProfile } from "@yummyai/contracts/logistics";
import { orders, orderLines, orderSourceSnapshots, marketplaceAccounts, fulfillmentSuppliers, orderWorkItems, orderWorkRevisions,
  productionEditorProjects, productionEditorVersions, productionEditorImages, memberships, membershipRoles, roles, loadCurrentMembershipContext,
  connectDatabase, withTenant, type DatabaseConnection } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { encryptProductionBytes } from "@yummyai/production-editor";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { HttpLogisticsGateway, LogisticsExecutor, LogisticsReadOwner } from "@yummyai/logistics";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { factoryErpImportFixture } from "../orders/factory-erp-import.test-fixture.js";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "../orders/order.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { HttpAmazonReportArchiveGateway } from "../orders/amazon-report-archive.gateway.js";
import { ClamAvProductionEditorScanner, ProductionEditorService } from "../design/production-editor.service.js";
import { OrderWorkspaceService, sealWork } from "../orders/order-workspace.service.js";
import { OrderProductionService } from "../orders/order-production.service.js";
import { OrderProductionDeliveryService } from "../orders/order-production-delivery.service.js";
import { ProductionQuantityService } from "../orders/production-quantity.service.js";
import { OrderShipmentService } from "../orders/order-shipment.service.js";
import { FactoryErpSourceGateway } from "../orders/factory-erp-source.gateway.js";
import { FactoryErpImportService } from "../orders/factory-erp-import.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { syntheticManufacturingProduct } from "../orders/manufacturing-production.test-fixture.js";
import { syntheticSupplierProfile, syntheticFactoryProfile, syntheticFactoryCapability } from "../../../../tools/testing/factory-fixtures.js";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { LogisticsService, type LogisticsEnqueuer } from "../logistics/logistics.service.js";
import { AgentFulfillmentService } from "./agent-fulfillment.service.js";
import { AgentFulfillmentController } from "./agent-fulfillment.controller.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader, DatabaseApiClientContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { createOrderPiiVault } from "../orders/order-pii-vault.js";
import { createIntegrationSecretVault } from "../integrations/integration-secret-vault.js";
import { requireFulfillmentEnvironment } from "../../../../tools/testing/require-agent-fulfillment-environment.mjs";

export const fulfillmentHash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const fulfillmentBusinessTables = ["orders", "order_lines", "order_events", "order_work_items", "order_work_revisions", "production_orders", "production_order_versions",
  "production_manufacturing_bindings", "production_milestone_events", "production_delivery_packages", "production_delivery_items", "production_delivery_feedback",
  "production_quantity_reports", "production_quantity_reviews", "quality_inspections", "quality_inspection_groups", "quality_group_defects", "quality_defects",
  "factory_erp_imports", "factory_erp_applications", "factory_erp_bindings", "factory_erp_binding_items", "factory_erp_observations", "shipments", "shipment_versions",
  "shipment_packages", "shipment_package_lines", "shipment_production_allocations", "shipment_tracking_events", "shipment_writeback_requests", "logistics_tasks",
  "logistics_task_productions", "logistics_quotes", "logistics_labels", "logistics_events", "ai_budget_ledger", "agent_plan_runs", "agent_command_requests"] as const;

/** Only the external carrier transport is synthetic. All stored logistics
 * receipts, costs, task pins and state transitions use the original executor. */
export class FulfillmentCarrier extends HttpLogisticsGateway {
  readonly calls = { channels: 0, quotes: 0, creates: 0, lookups: 0, labels: 0, downloads: 0 };
  override async channels() { this.calls.channels++; return [{ code: "fixture", name: "Synthetic original carrier channel" }]; }
  override async quote(): Promise<LogisticsQuote[]> {
    this.calls.quotes++;
    return [{ channelCode: "fixture", channelName: "Synthetic original carrier channel", totalMinor: 500, currency: "USD",
      currencySource: "Synthetic account statement", transitDaysMin: 3, transitDaysMax: 5, transitSource: "Synthetic calendar-day maximum",
      conditionsVerified: true, priceSource: "Synthetic controlled carrier quote", quotedAt: new Date().toISOString(), diagnostic: null }];
  }
  override async create(_profile: LogisticsConnectionProfile, _credentials: unknown, _task: LogisticsTaskSnapshot, reference: string) {
    this.calls.creates++;
    return { providerOrderId: reference, trackingNumbers: [`SYNTHETIC-${reference}`], labelUrls: [], actualCostMinor: 600, actualCurrency: "USD" };
  }
  override async lookup() { this.calls.lookups++; return null; }
}

function formalDocument(assetId?: string): ShapedPillowDocument {
  const document = createDefaultProductionDocument("shaped_pillow");
  if (document.productType !== "shaped_pillow") throw new Error("Synthetic formal pillow document required");
  const px = 25.4 / 150, edge = 1900 * px;
  document.spec = { ...document.spec, widthMm: edge, heightMm: edge, declaredLongestMm: 254, sizeBasis: "artwork",
    minimumNeckBasis: "cut_contour", barcodeTab: { ...document.spec.barcodeTab, centerXMm: 950 * px } };
  document.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: edge, yMm: 0, smooth: false }, { xMm: edge, yMm: edge, smooth: false }, { xMm: 0, yMm: edge, smooth: false }];
  document.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
  document.layers = assetId ? [{ id: "synthetic-fulfillment-art", kind: "image", name: "Synthetic known square print", assetId, assetVersion: 1,
    xMm: 200 * px, yMm: 200 * px, widthMm: 254, heightMm: 254, rotationDeg: 0, opacity: 1, visible: true, locked: true, flipX: false, flipY: false }] : [];
  return document;
}

/** Each seed accepts the actual member context. Initial routing/work admissions
 * and operator attestations are synthetic; no physical production is claimed. */
export function fulfillmentOwnerPorts(database: DatabaseConnection, vault: SecretVault, integrationVault: SecretVault) {
  const storage = createStorageFromEnvironment(), audit = new AuditService(database), ordersService = new OrderService(database, vault, audit);
  const scanner = new ClamAvProductionEditorScanner(), factories = new FactoryDirectoryService(database, audit);
  const reports = new AmazonOrderReportService(database, vault, ordersService, audit, new HttpAmazonReportArchiveGateway(),
    { schedule: async () => undefined }, { schedule: async () => undefined });
  const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: async () => undefined }, scanner);
  const work = new OrderWorkspaceService(database, vault, storage, reports, editor, scanner);
  const production = new OrderProductionService(database, vault, ordersService, audit, editor, factories);
  const quantities = new ProductionQuantityService(database, audit), delivery = new OrderProductionDeliveryService(database, vault, editor, production, audit, factories);
  const shipmentEnqueues: unknown[] = [], shipping = new OrderShipmentService(database, vault, ordersService, audit, { enqueue: async input => { shipmentEnqueues.push(input); } });
  const source = new FactoryErpSourceGateway(storage, vault, new ClamAvScanner()), imports = new FactoryErpImportService(database, vault, source, delivery, audit);
  const noModel = async () => { throw new Error("Fulfillment read acceptance must not call a model"); };
  const renderer = new ProductionEditorRenderProcessor(database, storage, vault, vault, { generate: noModel }, new ClamAvScanner());
  const carrier = new FulfillmentCarrier(), logisticsEnqueues: Parameters<LogisticsEnqueuer["enqueue"]>[0][] = [];
  const logistics = new LogisticsService(database, integrationVault, vault, storage, carrier, ordersService, { enqueue: async input => { logisticsEnqueues.push(input); } });
  const logisticsExecutor = new LogisticsExecutor(database, integrationVault, vault, storage, carrier), logisticsRead = new LogisticsReadOwner(database, vault);
  const clock = async (context: TenantContext) => {
    const [row] = await withTenant(database.db, context, tx => tx.execute<{ now: string | Date }>(sql`select clock_timestamp() as now`));
    return new Date(row!.now).toISOString();
  };
  async function state(context: TenantContext) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of fulfillmentBusinessTables) result[table] = (await tx.execute<{ count: number; hash: string }>(sql`
        select count(*)::integer as count, md5(coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)::text,'[]')) as hash
        from ${sql.identifier(table)} item`))[0]!;
      return result;
    });
  }
  async function initialOrder(context: TenantContext, accountId: string) {
    const id = createEntityId(), sourceId = createEntityId(), number = `SYNTHETIC-INITIAL-${id}`, now = await clock(context);
    const redacted = { synthetic: true, admission: "initial_order_with_original_positive_sequence_default" };
    return withTenant(database.db, context, async tx => {
      await tx.insert(orderSourceSnapshots).values({ id: sourceId, tenantId: context.tenantId, accountId, platform: "etsy", externalEventId: createEntityId(),
        externalOrderId: number, normalizedOrderId: id, redactedPayload: redacted, payloadChecksum: fulfillmentHash(JSON.stringify(redacted)) });
      const [admitted] = await tx.insert(orders).values({ id, tenantId: context.tenantId, accountId, sourceSnapshotId: sourceId, platform: "etsy", externalOrderId: number,
        providerStatus: "synthetic", workflowState: "pending", lineCount: 1, placedAt: new Date(now) }).returning({ id: orders.id, latestEventSequence: orders.latestEventSequence });
      await tx.insert(orderLines).values({ id: createEntityId(), tenantId: context.tenantId, orderId: id, externalLineId: `INITIAL-${id}`, title: "Synthetic legal initial order admission", quantity: 1 });
      return admitted!;
    });
  }
  async function seed(context: TenantContext, quantitiesInput: number[] = [5], options: { usLogistics?: boolean; wholeRelease?: boolean } = {}) {
    await storage.ensureBucket();
    const seedId = createEntityId(), accountId = createEntityId(), supplierId = createEntityId(), sourceId = createEntityId();
    const now = await clock(context), photo = await sharp({ create: { width: 2048, height: 2048, channels: 4,
      background: { r: 27, g: 113, b: 190, alpha: 1 } } }).png().toBuffer();
    try {
      await withTenant(database.db, context, async tx => {
        await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: context.tenantId, platform: "etsy", displayName: `Synthetic fulfillment account ${seedId}`,
          region: "GLOBAL", authorizationMode: "etsy_oauth", createdBy: context.userId });
        await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: context.tenantId, name: `Synthetic fulfillment supplier ${seedId}`,
          kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile, createdBy: context.userId });
      });
      const factoryName = `Synthetic fulfillment site ${seedId}`;
      let site: Awaited<ReturnType<typeof createSyntheticFactory>>;
      if (options.usLogistics) {
        const factoryProfile = syntheticFactoryProfile(factoryName);
        factoryProfile.productionAddress = { countryCode: "US", province: "CA", city: "Synthetic city", district: "", street: "100 Synthetic fixture street; not a real business",
          postalCode: "90001", recipient: "Synthetic fixture sender", phone: "1234567890" };
        factoryProfile.timeZone = "America/Los_Angeles";
        const factory = await factories.create(context, { supplierId, code: `TEST-${randomUUID()}`, profile: factoryProfile, idempotencyKey: randomUUID() });
        const capability = await factories.createCapability(context, factory.id, { profile: syntheticFactoryCapability("shaped_pillow"), idempotencyKey: randomUUID() });
        site = { factory, capability, pins: { factoryId: factory.id, factoryVersionId: factory.versionId, capabilityVersionId: capability.versionId } };
      } else site = await createSyntheticFactory(factories, context, supplierId, "shaped_pillow", factoryName);
      const capacity = await createSyntheticFactoryCapacity(database, context, { factory: site.factory,
        bindings: [{ capabilityVersionId: site.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10000 });
      let template = await editor.create(context, { name: `Synthetic fulfillment template ${seedId}`, document: formalDocument() });
      const templateImage = await editor.upload(context, template.project.id, `synthetic-${seedId}.png`, photo);
      template = await editor.save(context, template.project.id, { expectedVersionId: template.version.id, document: formalDocument(templateImage.id) });
      await editor.review(context, template.project.id, template.version.id);
      const profileCode = `FULFILL-${seedId}`;
      const profiles = await work.saveProfile(context, { code: profileCode, name: `Synthetic original JPG profile ${seedId}`, projectId: template.project.id,
        versionId: template.version.id, instructions: "Synthetic pinned ps-pillow-2026-09-17 fixture only", expectedVersion: 0, idempotencyKey: randomUUID() });
      const profile = profiles.find(value => value.code === profileCode); if (!profile) throw new Error("Actual reviewed print profile missing");
      const order = { id: createEntityId(), externalOrderId: `SYNTHETIC-FULFILL-${seedId}`,
        lines: quantitiesInput.map(quantity => ({ id: createEntityId(), quantity, sku: `FULFILL-${createEntityId()}` })) };
      const redacted = { synthetic: true, admission: "isolated-initial-production-only" };
      await withTenant(database.db, context, async tx => {
        await tx.insert(orderSourceSnapshots).values({ id: sourceId, tenantId: context.tenantId, accountId, platform: "etsy", externalEventId: randomUUID(),
          externalOrderId: order.externalOrderId, normalizedOrderId: order.id, redactedPayload: redacted, payloadChecksum: fulfillmentHash(JSON.stringify(redacted)) });
        await tx.insert(orders).values({ id: order.id, tenantId: context.tenantId, accountId, sourceSnapshotId: sourceId, platform: "etsy", externalOrderId: order.externalOrderId,
          providerStatus: "paid", workflowState: "in_production", lineCount: order.lines.length, addressStatus: "protected", placedAt: new Date(now) });
        await tx.insert(orderLines).values(order.lines.map(line => ({ id: line.id, tenantId: context.tenantId, orderId: order.id,
          externalLineId: `SYNTHETIC-LINE-${line.id}`, title: "Synthetic exact fulfillment pillow", quantity: line.quantity, skuCode: line.sku })));
      });
      await ordersService.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: `SYNTHETIC-UPDATE-${seedId}`, externalOrderId: order.externalOrderId,
        providerStatus: "paid", placedAt: now, orderTotal: null, redactedSource: redacted,
        lines: order.lines.map(line => ({ externalLineId: `SYNTHETIC-LINE-${line.id}`, externalListingId: null, skuCode: line.sku,
          title: "Synthetic exact fulfillment pillow", quantity: line.quantity, unitPrice: null, customizationCount: 0 })),
        protectedDetails: { buyer: { name: "SYNTHETIC_PRIVATE_FULFILLMENT_BUYER", email: "private-fulfillment@example.invalid", phone: "1234567890" },
          shippingAddress: { recipient: "SYNTHETIC_PRIVATE_FULFILLMENT_RECIPIENT", lines: ["SYNTHETIC_PRIVATE_FULFILLMENT_ADDRESS"], city: "Test City", region: "CA", postalCode: "00000", countryCode: "US" }, customizations: [] } });
      const productions = [], wholePrepared = [];
      for (const line of order.lines) {
        const revisionId = createEntityId(), projectId = createEntityId(), versionId = createEntityId(), assetId = createEntityId();
        const manufacturing = await syntheticManufacturingProduct(database, context, { profileVersionId: profile.versionId, document: formalDocument(assetId) });
        const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: profile.versionId, artworkVersionId: manufacturing.artworkVersionId,
          specificationVersionId: manufacturing.specificationVersionId, salesRecipeVersionId: manufacturing.salesRecipeVersionId, designExecutor: "human",
          fields: [], images: [], instructions: "Synthetic explicitly operator-reviewed original pillow", customerApprovalRequired: false, dueAt: null });
        const workKey = randomBytes(32), projectKey = randomBytes(32), document = ProductionEditorDocumentSchema.parse(formalDocument(assetId));
        const blob = await storage.putPrivate(context, { body: encryptProductionBytes(projectKey, photo), domain: "order", fileName: `${assetId}.pe`, mediaType: "application/octet-stream" });
        try {
          await withTenant(database.db, context, async tx => {
            await tx.insert(orderWorkItems).values({ id: line.id, tenantId: context.tenantId, encryptedDataKey: vault.encrypt(workKey.toString("base64")), revision: 1,
              projectionVersion: 1, preparation: "pushed", artwork: "in_review", expiresAt: new Date(Date.parse(now) + 86400000) });
            await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId: context.tenantId, workItemId: line.id, revision: 1, profileVersionId: profile.versionId,
              encryptedDraft: sealWork(workKey, draft), checksum: fulfillmentHash(JSON.stringify(draft)), createdBy: context.userId });
            await tx.insert(productionEditorProjects).values({ id: projectId, tenantId: context.tenantId, name: "shaped_pillow", encryptedDataKey: vault.encrypt(projectKey.toString("base64")),
              sourceWorkItemId: line.id, sourceWorkRevisionId: revisionId, expiresAt: new Date(Date.parse(now) + 86400000), createdBy: context.userId });
            await tx.insert(productionEditorVersions).values({ id: versionId, tenantId: context.tenantId, projectId, versionNumber: 1,
              encryptedDocument: sealWork(projectKey, document), checksum: fulfillmentHash(JSON.stringify(document)), createdBy: context.userId });
            await tx.update(productionEditorProjects).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(productionEditorProjects.id, projectId));
            await tx.insert(productionEditorImages).values({ id: assetId, tenantId: context.tenantId, projectId,
              encryptedMetadata: sealWork(projectKey, { name: "Synthetic original owned fixture image", kind: "image", mediaType: "image/png", width: 2048, height: 2048 }),
              originalObjectKey: blob.objectKey, previewObjectKey: blob.objectKey, checksum: fulfillmentHash(photo), byteSize: photo.byteLength });
            await tx.update(orderWorkItems).set({ pushedRevisionId: revisionId, editorProjectId: projectId }).where(eq(orderWorkItems.id, line.id));
          });
        } finally { workKey.fill(0); projectKey.fill(0); }
        const preflight = await editor.preflight(context, projectId, { expectedVersionId: versionId, purpose: "production", format: "jpeg", background: "white" });
        if (preflight.issues.some(issue => issue.severity === "error" || issue.severity === "manual")) throw new Error("Actual synthetic JPG preflight must pass every original gate");
        const approved = await work.action(context, line.id, { action: "approve_artwork", expectedRevision: 1, expectedProjectionVersion: 1,
          expectedEditorVersionId: versionId, reason: "Synthetic operator checked known fixture geometry and pinned manufacturing version", idempotencyKey: randomUUID() });
        const render = (await editor.get(context, projectId)).renders.find(value => value.purpose === "production");
        if (!render) throw new Error("Actual formal production render missing");
        await renderer.process(JobEnvelopeSchema.parse({ jobId: render.id, type: "production_editor_render", tenantId: context.tenantId, requestedBy: context.userId,
          correlationId: render.id, idempotencyKey: render.id, payload: { renderId: render.id } }));
        if ((await editor.getRender(context, projectId, render.id)).status !== "completed") throw new Error("Actual formal JPG render failed");
        if (options.wholeRelease) {
          wholePrepared.push({ line, manufacturing, projectId, renderId: render.id, editorVersionId: versionId,
            expectedRevision: approved.line.revision, expectedProjectionVersion: approved.line.projectionVersion });
          continue;
        }
        const released = await production.releaseArtwork(context, line.id, { ...site.pins, expectedRevision: approved.line.revision, expectedProjectionVersion: approved.line.projectionVersion,
          renderId: render.id, supplierId, quantity: line.quantity, manufacturing: manufacturing.manufacturing, capacityPlan: capacity.capacityPlan,
          instructions: "Synthetic exact original formal JPG and BOM", expectedCompletionAt: capacity.expectedCompletionAt, idempotencyKey: randomUUID() });
        productions.push({ lineId: line.id, quantity: line.quantity, manufacturing, projectId, renderId: render.id, editorVersionId: versionId,
          order: released.productionOrder, version: released.versions[0]! });
      }
      if (options.wholeRelease) {
        const released = await production.releaseWholeOrder(context, order.id, { supplierId, factoryId: site.factory.id, factoryVersionId: site.factory.versionId,
          items: wholePrepared.map(value => ({ lineId: value.line.id, quantity: value.line.quantity, expectedRevision: value.expectedRevision,
            expectedProjectionVersion: value.expectedProjectionVersion, renderId: value.renderId, capabilityVersionId: site.capability.versionId,
            manufacturing: value.manufacturing.manufacturing, capacityPlan: capacity.capacityPlan })),
          instructions: "Synthetic real whole-order release of the exact reviewed files and manufacturing", expectedCompletionAt: capacity.expectedCompletionAt,
          idempotencyKey: randomUUID() });
        for (const productionOrderId of released.productionOrderIds) {
          const actual = await production.get(context, productionOrderId), value = wholePrepared.find(row => row.line.id === actual.productionOrder.orderLineId);
          if (!value) throw new Error("Actual whole-order release returned an unrelated source");
          productions.push({ lineId: value.line.id, quantity: value.line.quantity, manufacturing: value.manufacturing, projectId: value.projectId,
            renderId: value.renderId, editorVersionId: value.editorVersionId, order: actual.productionOrder, version: actual.versions[0]! });
        }
      }
      let packet = await delivery.create(context, { supplierId, factoryId: site.factory.id,
        items: productions.map(value => ({ productionOrderId: value.order.id, productionVersionId: value.version.id, expectedProjectionVersion: value.order.projectionVersion })), idempotencyKey: randomUUID() });
      for (const item of packet.items) {
        if (!item.snapshot?.manufacturing) throw new Error("Actual formal file manufacturing pin missing");
        packet = await delivery.recordFeedback(context, packet.id, item.id, { kind: "submitted", expectedSequence: 0, idempotencyKey: randomUUID(),
          fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum, reference: "SYNTHETIC_FORMAL_FILE_SUBMITTED",
          note: "Synthetic operator submission receipt for these exact fixture bytes only", occurredAt: await clock(context), verifiedByOperator: true });
      }
      return { seedId, accountId, order: await ordersService.get(context, order.id), site: { ...site, supplierId, capacity }, productions, packet,
        items: packet.items.map(item => { if (!item.snapshot?.manufacturing) throw new Error("Actual source manufacturing pin missing");
          return { deliveryItemId: item.id, productionOrderId: item.productionOrderId, productionVersionId: item.snapshot.productionVersionId,
            fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum }; }), quantity: quantitiesInput.reduce((sum, quantity) => sum + quantity, 0) };
    } finally { photo.fill(0); }
  }
  type Scene = Awaited<ReturnType<typeof seed>>;
  async function observe(context: TenantContext, scene: Scene, status: "已审核" | "已出库" | "已作废", externalId = `SYNTHETIC-HEAD-${scene.seedId}`) {
    const raw = [externalId, "Synthetic owned factory export", scene.order.externalOrderId, `SYNTHETIC-FACTORY-TRACK-${scene.seedId}`, "", "", String(scene.items.length), String(scene.quantity),
      "Synthetic factory carrier", "Synthetic factory service", status, "2026-10-21 08:09:10", "2026-10-21 09:10:11"];
    const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
    const { FACTORY_ERP_HEADERS } = await import("@yummyai/contracts/order/factory-erp-import");
    const bytes = Buffer.from([FACTORY_ERP_HEADERS, raw].map(row => row.map(quote).join(",")).join("\r\n"));
    const view = await imports.upload(context, { factoryId: scene.site.factory.id, fileName: "synthetic-current-page.csv", contentBase64: bytes.toString("base64"),
      checksumSha256: fulfillmentHash(bytes), options: { csvEncoding: "utf-8", delimiter: "," }, idempotencyKey: randomUUID() });
    const application = await imports.apply(context, view.id, { fileChecksum: view.fileChecksum, previewChecksum: view.previewChecksum, idempotencyKey: randomUUID(), confirmed: true,
      rows: [{ rowNumber: 2, items: scene.items, wholeGroupConfirmed: true }] });
    return { view, application };
  }
  async function quality(context: TenantContext, scene: Scene, passed = 3) {
    const first = scene.productions[0]; if (!first || passed < 1 || passed > first.quantity) throw new Error("Actual quality fixture quantity required");
    let packet = await delivery.get(context, scene.packet.id), item = packet.items.find(value => value.productionOrderId === first.order.id)!;
    for (const kind of ["received", "accepted"] as const) {
      if (!item.snapshot?.manufacturing) throw new Error("Actual delivery manufacturing pin missing");
      packet = await delivery.recordFeedback(context, packet.id, item.id, { kind, expectedSequence: item.sequence, idempotencyKey: randomUUID(), fileChecksum: item.snapshot.file.checksum,
        manufacturingChecksum: item.snapshot.manufacturing.plan.checksum, reference: `SYNTHETIC_EXPLICIT_${kind.toUpperCase()}`, note: "Optional synthetic operator evidence for the QC case only",
        occurredAt: await clock(context), verifiedByOperator: true }); item = packet.items.find(value => value.id === item.id)!;
    }
    for (const type of ["started", "completed"] as const) {
      const current = await production.get(context, first.order.id);
      await production.recordMilestone(context, first.order.id, { type, expectedProjectionVersion: current.productionOrder.projectionVersion,
        externalEventId: `SYNTHETIC-${type}-${createEntityId()}`, occurredAt: await clock(context), evidence: { code: "SYNTHETIC_OPERATOR_ATTESTATION", note: "Synthetic physical observation, not autonomous production", assetIds: [] } });
    }
    const standard = await production.createQualityStandard(context, { name: `Synthetic original quality standard ${createEntityId()}`, skuId: null, supplierId: scene.site.supplierId,
      minimumScoreBps: 9000, criteria: [{ code: "PRINT", label: "Synthetic known physical print check", weightBps: 10000, blocking: true }] });
    const basis = await production.qualityGroups(context, first.order.id), held = first.quantity - passed;
    const result = await production.inspectGroups(context, first.order.id, RecordQualityGroupsInputSchema.parse({ formatVersion: 3, productionVersionId: basis.productionVersionId,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedRootInspectionId: basis.rootInspectionId, qualityStandardVersionId: standard.id,
      inspectedAt: await clock(context), segregationConfirmed: true, idempotencyKey: randomUUID(), groups: [
        { key: "good", label: "Synthetic isolated good bin", quantity: passed, criterionResults: [{ code: "PRINT", scoreBps: 10000, passed: true, evidenceAssetIds: [] }], defects: [] },
        ...(held ? [{ key: "held", label: "Synthetic isolated held bin", quantity: held, criterionResults: [{ code: "PRINT", scoreBps: 0, passed: false, evidenceAssetIds: [] }],
          defects: [{ code: "PRINT_DEFECT", severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic known held physical group", evidenceAssetIds: [] }] }] : []),
      ] }));
    return { ...result, standardId: standard.id };
  }
  async function shipment(context: TenantContext, scene: Scene, handedOver = false) {
    const sources = await shipping.productionSources(context, scene.order.id), source = sources.find(value => value.orderLineId === scene.productions[0]?.lineId && value.availableQuantity >= 1 && value.blockers.length === 0);
    if (!source?.qualityInspectionId) throw new Error("Actual eligible quality-backed shipment source required");
    const quantity = Math.min(3, source.availableQuantity), input = CreateShipmentInputSchema.parse({ shipDate: await clock(context), shipFromCountryCode: "US", idempotencyKey: randomUUID(),
      packages: [{ packageReferenceId: `SYNTHETIC-PACKAGE-${createEntityId()}`, trackingNumber: `SYNTHETIC-TRACKING-${createEntityId()}`, carrierCode: "SYNTHETIC",
        carrierName: "Synthetic original carrier", carrierService: "Synthetic service", lines: [{ orderLineId: source.orderLineId, quantity,
          productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
            qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity }] }] }] });
    let view = await shipping.create(context, scene.order.id, input);
    view = await shipping.reviewVersion(context, view.shipment.id, view.versions[0]!.id, { decision: "approved", reasonCode: "SYNTHETIC_OPERATOR_REVIEW",
      reason: "Synthetic human check of this exact original package and quality group", expectedCurrentVersion: 1, idempotencyKey: randomUUID() });
    if (handedOver) view = await shipping.dispatch(context, view.shipment.id, { expectedVersion: 1, reason: "Synthetic explicit operator pickup evidence", occurredAt: await clock(context), idempotencyKey: randomUUID() });
    return view;
  }
  async function logisticsTask(context: TenantContext, scene: Scene, execute = true, productionIndex = 0) {
    const address = scene.site.factory.profile.pickupAddress ?? scene.site.factory.profile.productionAddress;
    if (!address) throw new Error("Actual fixed factory origin required");
    const profile = LogisticsConnectionProfileSchema.parse({ name: `Synthetic original shipping route ${createEntityId()}`, provider: "shipos", factoryId: scene.site.factory.id,
      originCountryCode: "US", sender: { name: "Synthetic sender", address1: address.street, city: address.city, region: address.province, postalCode: address.postalCode,
        countryCode: address.countryCode, phone: "1234567890", email: "sender@example.invalid" }, baseUrl: "https://api.shipos.cn", currency: "USD", currencySource: "Synthetic original account currency",
      labelHosts: ["shipease.oss-cn-hangzhou.aliyuncs.com"], channels: [{ code: "fixture", name: "Synthetic channel", countryCodes: ["US"], transitDaysMin: 3, transitDaysMax: 5,
        transitSource: "Synthetic calendar-day SLA", conditionsVerified: true, conditionsEvidence: "Synthetic fixed route evidence", maxWeightGrams: 10000, maxDimensionMm: 1000 }],
      apiCompatibilityEvidence: "Synthetic account compatibility", purchasePermissionEvidence: "Synthetic isolated purchase authorization", labelMode: "factory_pull" });
    const saved = await logistics.saveConnection(context, { expectedVersion: 0, profile, credentials: { provider: "shipos", appKey: "synthetic-fulfillment-key", appSecret: "synthetic-fulfillment-secret" }, idempotencyKey: randomUUID() });
    await logistics.verify(context, saved.connectionId, { expectedVersion: 1, idempotencyKey: randomUUID() });
    await logistics.saveRule(context, { connectionId: saved.connectionId, expectedVersion: 0, rule: { name: "Synthetic finite route budget", currency: "USD", autoPurchase: true,
      maxTicketMinor: 1000, maxDailyMinor: 1000000, quoteMaxAgeSeconds: 120, allowedChannelCodes: ["fixture"], evidence: "Synthetic bounded isolated authorization" }, idempotencyKey: randomUUID() });
    const selected = scene.productions[productionIndex]; if (!selected) throw new Error("Actual source production selection required");
    const current = await ordersService.get(context, scene.order.id), ready = Date.parse(scene.site.capacity.expectedCompletionAt), line = scene.order.lines.find(value => value.id === selected.lineId);
    if (!line?.skuCode) throw new Error("Actual source SKU required for original declaration gate");
    const task = await logistics.createTask(context, { orderId: scene.order.id, productionOrderIds: [selected.order.id], connectionId: saved.connectionId,
      readyAt: new Date(ready).toISOString(), latestShipAt: new Date(ready + 86400000).toISOString(), deliverBy: new Date(ready + 10 * 86400000).toISOString(), deadlineSource: "Synthetic fixed dispatch and delivery windows",
      expectedOrderSequence: current.latestEventSequence, idempotencyKey: randomUUID(), packages: [{ weightGrams: 500, dimensionsMm: { length: 300, width: 300, height: 100 },
        evidence: "Synthetic measured fixture package", containsBattery: false, declarations: [{ sku: line.skuCode, nameEn: "Synthetic pillow", nameCn: "合成测试抱枕", quantity: selected.quantity,
          unitPriceMinor: 1000, currency: "USD", unitWeightGrams: 100, hsCode: "630492", originCountryCode: "US" }] }] });
    if (execute) await logisticsExecutor.run(context, task.taskId, "purchase");
    return task;
  }
  return { database, vault, storage, audit, orders: ordersService, factories, editor, work, production, quantities, delivery, shipping, source, imports,
    logistics, logisticsRead, logisticsExecutor, carrier, logisticsEnqueues, shipmentEnqueues, clock, seed, observe, quality, shipment, logisticsTask, state, initialOrder };
}

/** Validate every disposable resource before constructing any resource client. */
export function requireAgentFulfillmentEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const checked = requireFulfillmentEnvironment(environment);
  return { ...checked, redis: environment.E2E_DISPOSABLE_REDIS_URL! };
}

/** API seeds reuse the original real render/release/delivery/import owners.
 * Their initial order/work admission is explicitly synthetic; these facts do
 * not establish physical manufacture, factory acceptance or carrier pickup. */
export function agentFulfillmentFixture(database: DatabaseConnection) {
  const environment = requireAgentFulfillmentEnvironment();
  const facts = factoryErpImportFixture(database);
  const owners = fulfillmentOwnerPorts(database, facts.base.vault, new SecretVault(Buffer.alloc(32, 213)));
  const service = () => new AgentFulfillmentService(database, owners.orders, owners.production, owners.quantities, owners.delivery, owners.shipping, owners.logisticsRead);
  let app: INestApplication | undefined, origin: string | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
  const issuer = "https://synthetic-fulfillment-oidc.invalid", audience = "synthetic-fulfillment-api";
  let closed = false;
  async function initialize() {
    try { await facts.base.initialize(); await owners.storage.ensureBucket(); }
    catch (error) {
      try { await close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Fulfillment fixture initialization and cleanup failed"); }
      throw error;
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    await app?.close();
    facts.dispose();
  }
  const current = (actor?: Parameters<typeof facts.base.current>[0]) => facts.base.current(actor);
  const grant = (permissions: readonly string[] = Object.values(Permission), scope: TenantContext["dataScope"] = "tenant", wider: readonly string[] = []) =>
    facts.base.grant(permissions, scope, wider);
  async function request(context: TenantContext, orderId: string, kind: AgentFulfillmentKind, pageSize = 5, cursor: string | null = null) {
    const workspace = await service().workspace(context), order = await owners.orders.get(context, orderId);
    return AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL, executionContract: workspace.executionContract,
      definitionChecksum: workspace.definition.definitionChecksum, input: { orderId, expectedSequence: order.latestEventSequence, kind, pageSize, cursor } });
  }
  async function token(actor = facts.base.owner, seconds = 300) {
    signing ??= await generateKeyPair("RS256");
    return new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(`capacity-${actor.userId}`)
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(signing.privateKey);
  }
  async function startHttp() {
    if (origin) return origin;
    signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, AgentFulfillmentController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentFulfillmentService, useValue: service() },
    ] }) class ActualFulfillmentHttpModule {}
    const reflector = new Reflector(), loader = new DatabaseApiClientContextLoader(database);
    app = await NestFactory.create(ActualFulfillmentHttpModule, { logger: false });
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer, audience, verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(loader));
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  return { environment, database, facts, owners, current, grant, initialize, close, service, request, token, startHttp,
    stamp: (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context)) };
}

/** The browser child alone imports decorated owners. It seeds only the actual
 * current personal member supplied by the verified page session. */
async function fulfillmentBrowserChild() {
  const environment = requireAgentFulfillmentEnvironment(), database = connectDatabase(environment.url);
  const owners = fulfillmentOwnerPorts(database, createOrderPiiVault(), createIntegrationSecretVault());
  let context: TenantContext | undefined, membershipId: string | undefined, source: Awaited<ReturnType<typeof owners.seed>> | undefined;
  const RoleRows = z.array(z.object({ id: z.uuidv7(), permissions: z.array(z.string()), dataScope: z.enum(["self", "team", "tenant"]) }).strict());
  let originalRoles: z.infer<typeof RoleRows> = [], auxiliaryRoleId: string | undefined;
  let closed = false, serial = Promise.resolve(), phase = "ready";
  async function restore() {
    if (!context || !membershipId) return;
    await withTenant(database.db, context, async tx => {
      for (const role of originalRoles) await tx.update(roles).set({ permissions: role.permissions, dataScope: role.dataScope }).where(eq(roles.id, role.id));
      if (auxiliaryRoleId) {
        await tx.delete(membershipRoles).where(and(eq(membershipRoles.membershipId, membershipId!), eq(membershipRoles.roleId, auxiliaryRoleId)));
        await tx.delete(roles).where(eq(roles.id, auxiliaryRoleId)); auxiliaryRoleId = undefined;
      }
    });
    const actual = RoleRows.parse(await withTenant(database.db, context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
      .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).where(eq(membershipRoles.membershipId, membershipId!))));
    const normalize = (values: typeof originalRoles) => JSON.stringify([...values].sort((a, b) => a.id.localeCompare(b.id)));
    if (normalize(actual) !== normalize(originalRoles)) throw new Error("fulfillment_personal_role_restore_mismatch");
  }
  async function close() {
    if (closed) return { closed: true, restored: true };
    closed = true; const errors: unknown[] = [];
    try { await restore(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "fulfillment_child_cleanup_failed");
    return { closed: true, restored: true };
  }
  process.on("disconnect", () => { void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => { serial = serial.then(async () => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    if (message.nonce !== environment.nonce || typeof message.id !== "number") return;
    try {
      let value: unknown;
      if (message.operation === "seed") {
        phase = "actual_personal_membership";
        if (context) throw new Error("fulfillment_personal_source_already_seeded");
        const caller = TenantContextSchema.parse(message.context);
        context = await withTenant(database.db, caller, async tx => TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true }))));
        const [member] = await withTenant(database.db, context, tx => tx.select({ id: memberships.id }).from(memberships)
          .where(and(eq(memberships.userId, context!.userId), eq(memberships.status, "active"))));
        if (!member) throw new Error("fulfillment_actual_personal_member_missing"); membershipId = member.id;
        originalRoles = RoleRows.parse(await withTenant(database.db, context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
          .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).where(eq(membershipRoles.membershipId, membershipId!))));
        if (!originalRoles.length) throw new Error("fulfillment_personal_roles_missing");
        phase = "actual_jpg_release_and_delivery"; source = await owners.seed(context, [5, 1, 1, 1, 1, 1], { usLogistics: true });
        phase = "actual_factory_csv_observation"; const observation = await owners.observe(context, source, "已出库");
        phase = "actual_logistics_receipt"; const logistics = await owners.logisticsTask(context, source);
        phase = "actual_operator_quality_groups"; const quality = await owners.quality(context, source, 3);
        phase = "actual_operator_package_handover"; const shipment = await owners.shipment(context, source, true);
        const current = await owners.orders.get(context, source.order.id);
        value = { orderId: source.order.id, lineId: source.productions[0]!.lineId, orderNumber: source.order.externalOrderId, expectedSequence: current.latestEventSequence,
          productionIds: source.productions.map(row => row.order.id), firstProductionId: source.productions[0]!.order.id,
          firstProductionVersionId: source.productions[0]!.version.id, fileChecksum: source.items[0]!.fileChecksum,
          importId: observation.view.id, inspectionId: quality.inspectionId, shipmentId: shipment.shipment.id, logisticsTaskId: logistics.taskId };
      } else if (message.operation === "state") {
        if (!context) throw new Error("fulfillment_personal_context_missing");
        value = { tables: await owners.state(context), carrier: { ...owners.carrier.calls }, logisticsEnqueues: owners.logisticsEnqueues.length, shipmentEnqueues: owners.shipmentEnqueues.length };
      } else if (message.operation === "narrow") {
        phase = "actual_personal_permission_narrow";
        if (!context || !membershipId || ![Permission.OrderRead, Permission.OrderPiiRead].includes(message.bit as typeof Permission.OrderRead | typeof Permission.OrderPiiRead))
          throw new Error("fulfillment_permission_narrow_invalid");
        await restore(); const bit = message.bit as typeof Permission.OrderRead | typeof Permission.OrderPiiRead;
        await withTenant(database.db, context, async tx => {
          for (const role of originalRoles) await tx.update(roles).set({ permissions: role.permissions.filter(permission => permission !== bit) }).where(eq(roles.id, role.id));
          auxiliaryRoleId = createEntityId();
          await tx.insert(roles).values({ id: auxiliaryRoleId, tenantId: context!.tenantId, name: `Synthetic fulfillment narrow ${auxiliaryRoleId}`, permissions: [bit], dataScope: "self" });
          await tx.insert(membershipRoles).values({ tenantId: context!.tenantId, membershipId: membershipId!, roleId: auxiliaryRoleId });
        });
        const current = await withTenant(database.db, context, tx => loadCurrentMembershipContext(tx, context!));
        value = { contextAuthority: erpSessionAuthority(erpPermissionContext(current)) };
      } else if (message.operation === "restore") { await restore(); value = { restored: true }; }
      else if (message.operation === "close") value = await close();
      else throw new Error("fulfillment_child_operation_invalid");
      process.send?.({ type: "result", nonce: environment.nonce, id: message.id, value });
    } catch (error) {
      let code: string | null = null, cause: unknown = error;
      for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) {
        if ("code" in cause && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code)) code ??= cause.code;
        cause = "cause" in cause ? cause.cause : null;
      }
      process.send?.({ type: "failure", nonce: environment.nonce, id: message.id, phase, code });
    }
  }); });
  process.send?.({ type: "ready", nonce: environment.nonce });
}
if (process.argv.includes("--agent-fulfillment-browser-child")) void fulfillmentBrowserChild().catch(() => { process.exitCode = 1; });
