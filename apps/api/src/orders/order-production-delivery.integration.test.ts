import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, ProductionEditorDocumentSchema, type ShapedPillowDocument, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { FACTORY_ERP_HEADERS } from "@yummyai/contracts/order/factory-erp-import";
import { connectDatabase, migrateDatabase, withTenant, marketplaceAccounts, orderSourceSnapshots, orders, orderLines, orderWorkItems, orderWorkRevisions,
  productionEditorProjects, productionEditorVersions, productionEditorImages, fulfillmentSuppliers, orderDesignAgentRuns,
  productionDeliveryPackages, productionDeliveryItems, productionDeliveryFeedback, productionOrders,memberships,roles,membershipRoles,factoryAccessGrants,factoryTaskAssignments,factoryTaskReceipts } from "@yummyai/database";
import { encryptProductionBytes } from "@yummyai/production-editor";
import { applyPillowFactoryStandard } from "@yummyai/production-editor/products";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { assertAssetAccess,Storage as PrivateStorage, type Storage, type StoredAsset, type AssetDomain, type PutPrivateInput } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AuditService } from "../audit/audit.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService, sealWork } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderProductionDeliveryService, deliveryFilePath } from "./order-production-delivery.service.js";
import { FulfillmentAttentionService } from "../dashboard/fulfillment-attention.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { OrderReviewService } from "./order-review.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { OrderTaskService } from "./order-task.service.js";
import { OrderWholeDetailService } from "./order-whole-detail.service.js";
import type { LogisticsService } from "../logistics/logistics.service.js";
import type { ShiposService } from "../suppliers/shipos.service.js";
import {FactoryCollaborationService} from "./factory-collaboration.service.js";
import {DatabaseMembershipContextLoader} from "../auth/tenant-context.guard.js";
import { syntheticManufacturingProduct } from "./manufacturing-production.test-fixture.js";
import { FactoryErpImportService } from "./factory-erp-import.service.js";
import { FactoryErpSourceGateway } from "./factory-erp-source.gateway.js";

// Finally teardown belongs to the isolated runner, even if this process fails.
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Use the disposable production-delivery-integration runner");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
describe("immutable pillow delivery and operator factory feedback", () => {
  const database = connectDatabase(), tenantId = createEntityId(), otherTenant = createEntityId(), userId = createEntityId(), accountId = createEntityId(), supplierId = createEntityId();
  const context: TenantContext = { tenantId, userId, dataScope: "tenant", permissions: Object.values(Permission) }, other = { ...context, tenantId: otherTenant };
  const vault = new SecretVault(Buffer.alloc(32, 93)), audit = new AuditService(database), orderService = new OrderService(database, vault, audit), objects = new Map<string, Uint8Array>();
  let onFactoryRead:(()=>Promise<void>)|undefined;
  const factoryClient={async send(command:{input:{Key?:string}}){
    const stored=objects.get(command.input.Key??"");if(!stored)throw new Error("Synthetic stored factory file missing");await onFactoryRead?.();
    const body=Uint8Array.from(stored);
    return{ContentLength:body.byteLength,Body:{transformToWebStream:()=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(body);controller.close();}})}};
  }};
  const factoryStorage=new PrivateStorage(factoryClient as unknown as ConstructorParameters<typeof PrivateStorage>[0],"synthetic-private");
  const storage = {
    putPrivate: async (ctx: TenantContext, input: PutPrivateInput) => { const checksumSha256 = sha(input.body), objectKey = `tenants/${ctx.tenantId}/${input.domain}/${checksumSha256}/${input.fileName}`; objects.set(objectKey, Uint8Array.from(input.body)); return { objectKey, checksumSha256, deduplicated: false }; },
    readPrivate: async (ctx: TenantContext, asset: StoredAsset, options: { requiredDomain: AssetDomain }) => { assertAssetAccess(ctx, asset, options.requiredDomain); const bytes = objects.get(asset.objectKey); if (!bytes) throw new Error("Fixture private blob missing"); return Uint8Array.from(bytes); },
    readFactoryAssignedPrivate:factoryStorage.readFactoryAssignedPrivate.bind(factoryStorage),
  } as unknown as Storage;
  const clean = async () => ({ result: "clean" as const, engine: "synthetic", signatureVersion: "fixture-v1", scannedAt: new Date().toISOString() });
  const reports = new AmazonOrderReportService(database, vault, orderService, audit, { download: async () => { throw new Error("No marketplace calls"); }, scan: clean }, { schedule: async () => undefined }, { schedule: async () => undefined });
  const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: async () => undefined }, { scan: clean });
  const factories = new FactoryDirectoryService(database, audit);
  const work = new OrderWorkspaceService(database, vault, storage, reports, editor, { scan: clean }), production = new OrderProductionService(database, vault, orderService, audit, editor, factories);
  const delivery = new OrderProductionDeliveryService(database, vault, editor, production, audit, factories);
  const collaboration=new FactoryCollaborationService(database,audit,delivery),loader=new DatabaseMembershipContextLoader(database);
  const review = new OrderReviewService(work, production, new OrderShipmentService(database, vault, orderService, audit, { enqueue: async () => { throw new Error("No marketplace calls"); } }),
    new OrderAfterSalesService(database, vault, audit), delivery, new FinanceService(database, audit), database, vault);
  const worker = new ProductionEditorRenderProcessor(database, storage, vault, vault, { generate: async () => { throw new Error("No model calls"); } }, { scan: clean });
  let photo: Buffer, profileVersionId: string;
  let factoryFixture: Awaited<ReturnType<typeof createSyntheticFactory>>;
  const capacityByFactory = new Map<string, Awaited<ReturnType<typeof createSyntheticFactoryCapacity>>>();
  function document(assetId = createEntityId()): ShapedPillowDocument {
    const doc = applyPillowFactoryStandard({ schemaVersion: 1, name: "Synthetic manually reviewed pillow", productType: "shaped_pillow", spec: { widthMm: 254, heightMm: 254, dpi: 150, sideMode: "single", declaredLongestMm: 254, sizeBasis: "cut_contour", whiteBorderMm: 5, cutLineMm: 1.016, minimumNeckMm: 50, minimumNeckBasis: "cut_contour", panelGapMm: 10, barcodeTab: { widthMm: 20, heightMm: 10, centerXMm: 127 } },
      contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 254, yMm: 0, smooth: false }, { xMm: 254, yMm: 254, smooth: false }, { xMm: 0, yMm: 254, smooth: false }], layers: [], confirmations: { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true } });
    doc.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
    const border = doc.spec.whiteBorderMm;
    doc.spec.declaredLongestMm = 254 - border * 2;
    doc.layers = [{ id: "synthetic-photo", kind: "image", name: "Synthetic test image", assetId, assetVersion: 1, xMm: border, yMm: border, widthMm: 254 - border * 2, heightMm: 254 - border * 2, rotationDeg: 0, opacity: 1, visible: true, locked: true, flipX: false, flipY: false }];
    return doc;
  }
  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic delivery',$2),($3,'Synthetic other',$4)", [tenantId, `delivery-${tenantId}`, otherTenant, `other-${otherTenant}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic operator')", [userId, `delivery-${userId}`, `${userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const membershipId=createEntityId(),roleId=createEntityId();await tx.insert(memberships).values({id:membershipId,tenantId,userId,status:"active"});await tx.insert(roles).values({id:roleId,tenantId,name:"Synthetic factory access operator",permissions:[...context.permissions],dataScope:"tenant"});await tx.insert(membershipRoles).values({tenantId,membershipId,roleId});
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId, platform: "amazon", displayName: "Synthetic delivery store", region: "NA", authorizationMode: "amazon_private", createdBy: userId });
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId, name: "Synthetic Manual Factory", kind: "manual", status: "active", regionCode: "CN", settlementCurrency: "CNY", profile: syntheticSupplierProfile, createdBy: userId });
    });
    factoryFixture = await createSyntheticFactory(factories, context, supplierId, "shaped_pillow");
    photo = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 27, g: 113, b: 190, alpha: 1 } } }).png().toBuffer();
    const doc = document(); doc.layers = [];
    let template = await editor.create(context, { name: "Synthetic manufacturing template", document: doc });
    const asset = await editor.upload(context, template.project.id, "synthetic-template.png", photo);
    template = await editor.save(context, template.project.id, { expectedVersionId: template.version.id, document: document(asset.id) });
    await editor.review(context, template.project.id, template.version.id);
    const profiles = await work.saveProfile(context, { code: `DELIVERY-${tenantId}`, name: "Synthetic pinned manufacturing", projectId: template.project.id, versionId: template.version.id, instructions: "Fixture manufacturing", expectedVersion: 0, idempotencyKey: randomUUID() });
    profileVersionId = profiles.find(profile => profile.projectId === template.project.id)!.versionId;
  }, 60_000);
  afterAll(async () => { photo?.fill(0); objects.clear(); await database.client.end(); });
  async function fixture(rules = false, site = factoryFixture, shared?: { orderId: string; orderNumber: string }) {
    if (!capacityByFactory.has(site.factory.id)) capacityByFactory.set(site.factory.id, await createSyntheticFactoryCapacity(database, context,
      { factory: site.factory, bindings: [{ capabilityVersionId: site.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10_000 }));
    const capacity = capacityByFactory.get(site.factory.id)!;
    const orderId = shared?.orderId ?? createEntityId(), lineId = createEntityId(), revisionId = createEntityId(), projectId = createEntityId(), versionId = createEntityId(), assetId = createEntityId(), sourceId = createEntityId();
    const workKey = randomBytes(32), projectKey = randomBytes(32), orderNumber = shared?.orderNumber ?? `SYNTHETIC-DELIVERY-${orderId}`;
    const manufacturingBasis = await syntheticManufacturingProduct(database, context, { profileVersionId, document: document(assetId) });
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: profileVersionId, artworkVersionId: manufacturingBasis.artworkVersionId, specificationVersionId: manufacturingBasis.specificationVersionId, salesRecipeVersionId: manufacturingBasis.salesRecipeVersionId, designExecutor: "human", fields: [], images: [], instructions: "Synthetic manufacturing instructions", customerApprovalRequired: false, dueAt: null }), doc = ProductionEditorDocumentSchema.parse(document(assetId));
    const blob = await storage.putPrivate(context, { body: encryptProductionBytes(projectKey, photo), domain: "order", fileName: `${assetId}.pe`, mediaType: "application/octet-stream" });
    try { await withTenant(database.db, context, async tx => {
      await tx.insert(orderSourceSnapshots).values({ id: sourceId, tenantId, accountId, platform: "amazon", externalEventId: randomUUID(), externalOrderId: orderNumber, normalizedOrderId: orderId, redactedPayload: { synthetic: true }, payloadChecksum: "a".repeat(64) });
      if (shared) await tx.update(orders).set({ lineCount: 2 }).where(eq(orders.id, orderId));
      else await tx.insert(orders).values({ id: orderId, tenantId, accountId, sourceSnapshotId: sourceId, platform: "amazon", externalOrderId: orderNumber, providerStatus: "paid", workflowState: "in_production", lineCount: 1, addressStatus: "protected", placedAt: new Date() });
      await tx.insert(orderLines).values({ id: lineId, tenantId, orderId, externalLineId: lineId, title: "Synthetic pillow", quantity: 2 });
      await tx.insert(orderWorkItems).values({ id: lineId, tenantId, encryptedDataKey: vault.encrypt(workKey.toString("base64")), revision: 1, projectionVersion: 1, preparation: "pushed", artwork: "in_review", expiresAt: new Date(Date.now() + 86_400_000) });
      await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId, workItemId: lineId, revision: 1, profileVersionId, encryptedDraft: sealWork(workKey, draft), checksum: sha(JSON.stringify(draft)), createdBy: userId });
      await tx.insert(productionEditorProjects).values({ id: projectId, tenantId, name: "shaped_pillow", encryptedDataKey: vault.encrypt(projectKey.toString("base64")), sourceWorkItemId: lineId, sourceWorkRevisionId: revisionId, expiresAt: new Date(Date.now() + 86_400_000), createdBy: userId });
      await tx.insert(productionEditorVersions).values({ id: versionId, tenantId, projectId, versionNumber: 1, encryptedDocument: sealWork(projectKey, doc), checksum: sha(JSON.stringify(doc)), createdBy: userId });
      await tx.update(productionEditorProjects).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(productionEditorProjects.id, projectId));
      await tx.insert(productionEditorImages).values({ id: assetId, tenantId, projectId, encryptedMetadata: sealWork(projectKey, { name: "Synthetic fixture photo", kind: "image", mediaType: "image/png", width: 2048, height: 2048 }), originalObjectKey: blob.objectKey, previewObjectKey: blob.objectKey, checksum: sha(photo), byteSize: photo.length });
      await tx.update(orderWorkItems).set({ pushedRevisionId: revisionId, editorProjectId: projectId }).where(eq(orderWorkItems.id, lineId));
      if (rules) { const snapshot = { ruleSnapshot: { schemaVersion: 1, capturedAt: new Date().toISOString(), rules: [] } };
        await tx.insert(orderDesignAgentRuns).values({ id: createEntityId(), tenantId, workItemId: lineId, workRevisionId: revisionId, status: "awaiting_review", executorKey: "synthetic-metadata-only", recipeVersion: "synthetic-v1", policyVersion: "synthetic-v1", encryptedSnapshot: sealWork(workKey, snapshot), inputChecksum: sha(JSON.stringify(snapshot)), projectId, currentEditorVersionId: versionId, requestedBy: userId }); }
    }); } finally { workKey.fill(0); projectKey.fill(0); }
    const check = await editor.preflight(context, projectId, { expectedVersionId: versionId, purpose: "production", format: "jpeg", background: "white" });
    expect(check.issues.filter(issue => issue.severity === "error" || issue.severity === "manual")).toEqual([]);
    const approved = await work.action(context, lineId, { action: "approve_artwork", expectedRevision: 1, expectedProjectionVersion: 1, expectedEditorVersionId: versionId, reason: "Synthetic operator reviewed geometry and artwork", idempotencyKey: randomUUID() });
    const render = (await editor.get(context, projectId)).renders.find(row => row.purpose === "production")!; expect(render).toBeTruthy();
    await worker.process(JobEnvelopeSchema.parse({ jobId: render.id, type: "production_editor_render", tenantId, requestedBy: userId, correlationId: render.id, idempotencyKey: render.id, payload: { renderId: render.id } }));
    expect((await editor.getRender(context, projectId, render.id)).status).toBe("completed");
    const released = await production.releaseArtwork(context, lineId, { ...site.pins, expectedRevision: approved.line.revision, expectedProjectionVersion: approved.line.projectionVersion, renderId: render.id, supplierId, quantity: 2,
      manufacturing: manufacturingBasis.manufacturing, capacityPlan: capacity.capacityPlan,
      instructions: "Synthetic two-panel pillow, keep exact pixels and 150 DPI", expectedCompletionAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), idempotencyKey: randomUUID() });
    return { lineId, projectId, versionId, orderId, orderNumber, productionId: released.productionOrder.id, manufacturing: manufacturingBasis.manufacturing,
      capacityPlan: capacity.capacityPlan, selection: { productionOrderId: released.productionOrder.id, productionVersionId: released.versions[0]!.id, expectedProjectionVersion: released.productionOrder.projectionVersion } };
  }
  const create = (f: Awaited<ReturnType<typeof fixture>>) => delivery.create(context, { supplierId, factoryId: factoryFixture.factory.id, items: [f.selection], idempotencyKey: randomUUID() });
  async function collaborator(canRespond=true){const user=createEntityId(),membershipId=createEntityId(),subject=`factory-${user}`;await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic factory collaborator')",[user,subject,`${user}@example.test`]);await withTenant(database.db,context,tx=>tx.insert(memberships).values({id:membershipId,tenantId,userId:user,status:"active"}));const grant=await collaboration.createGrant(context,{factoryId:factoryFixture.factory.id,membershipId,canRespond,expiresAt:new Date(Date.now()+86_400_000).toISOString(),idempotencyKey:randomUUID()});const actor=await loader.load({sub:subject,tenant_id:tenantId});expect(actor).not.toBeNull();return{actor:actor!,grant,membershipId,subject};}
  const assign=(grantId:string,packet:Awaited<ReturnType<typeof create>>)=>collaboration.assign(context,grantId,{deliveryItemId:packet.items[0]!.id,fileChecksum:packet.items[0]!.snapshot!.file.checksum,packageChecksum:packet.checksum,expiresAt:new Date(Date.now()+3_600_000).toISOString(),idempotencyKey:randomUUID()});
  const factoryReply=(view:Awaited<ReturnType<typeof delivery.factoryTask>>,kind:"received"|"accepted"|"rejected")=>({kind,expectedSequence:view.sequence,fileChecksum:view.file!.checksum,manufacturingChecksum:view.manufacturing?.recipe?.checksum,idempotencyKey:randomUUID(),reference:"Synthetic first-person receipt",note:"Synthetic collaborator checked this exact formal file",occurredAt:new Date().toISOString(),confirmedFileVersion:true,affectedQuantity:kind==="rejected"?1:null});
  it("grants only assigned factory rights, returns a minimal task and original JPG, and records first-person receipts without approving production",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),assignment=await assign(member.grant.id,packet);
    expect(member.actor.permissions).toEqual([Permission.FactoryTaskRead,Permission.FactoryTaskRespond]);expect(member.actor.dataScope).toBe("self");
    const view=await delivery.factoryTask(member.actor,assignment.id);expect(view.manufacturing).toMatchObject({quantity:2,factoryStandardId:"ps-pillow-2026-09-17"});expect(view.file!.checksum).toBe(packet.items[0]!.snapshot!.file.checksum);
    expect(view.manufacturing!.recipe).toMatchObject({ quantity: 2, unit: "each", recipeOutputQuantity: 1, proposalOnly: true,
      materials: [{ plannedNumerator: "1", plannedDenominator: "1", responsibility: "merchant" }], operations: [{ responsibility: "factory" }] });
    expect(JSON.stringify(view.manufacturing!.recipe)).not.toMatch(/stockItemId|notes|expectedSecondsPerOutput|spuId/);
    expect(JSON.stringify(view)).not.toMatch(/encrypted|objectKey|orderNumber|orderLineId|tenantId|cost|prompt|recordedBy/);expect(JSON.stringify(view)).not.toContain(f.orderNumber);
    const file=await delivery.factoryFile(member.actor,assignment.id);expect(sha(file.body)).toBe(view.file!.checksum);expect(file.name).toBe(`factory-task-${assignment.id}.jpg`);file.body.fill(0);
    await expect(delivery.get(member.actor,packet.id)).rejects.toBeInstanceOf(ForbiddenError);await expect(editor.get(member.actor,packet.items[0]!.snapshot!.editorProjectId)).rejects.toBeInstanceOf(ForbiddenError);
    const received=await delivery.factoryFeedback(member.actor,assignment.id,factoryReply(view,"received"));expect(received.receipts[0]).toMatchObject({origin:"factory",kind:"received"});
    for (const manufacturingChecksum of [undefined, "f".repeat(64)]) await expect(delivery.factoryFeedback(member.actor, assignment.id,
      { ...factoryReply(received, "accepted"), manufacturingChecksum })).rejects.toBeInstanceOf(ConflictException);
    expect((await delivery.factoryTask(member.actor, assignment.id)).status).toBe("received");
    const accepted=await delivery.factoryFeedback(member.actor,assignment.id,factoryReply(received,"accepted"));expect(accepted.status).toBe("accepted");
    const [productionRow]=await withTenant(database.db,context,tx=>tx.select().from(productionOrders).where(eq(productionOrders.id,f.productionId)));expect(productionRow!.status).toBe("acknowledged");
    const internal=await delivery.get(context,packet.id);expect(internal.items[0]!.feedback.map(event=>event.origin)).toEqual(["factory","factory"]);
  },60_000);
  it("isolates another collaborator and tenant, and read-only grants cannot record responses",async()=>{
    const f=await fixture(),packet=await create(f),owner=await collaborator(),otherMember=await collaborator(),readOnly=await collaborator(false),assignment=await assign(owner.grant.id,packet),readAssignment=await assign(readOnly.grant.id,packet);
    expect((await delivery.factoryTasks(otherMember.actor,{})).items).toHaveLength(0);await expect(delivery.factoryTask(otherMember.actor,assignment.id)).rejects.toBeInstanceOf(NotFoundException);await expect(delivery.factoryTask({...owner.actor,tenantId:otherTenant},assignment.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(readOnly.actor.permissions).toEqual([Permission.FactoryTaskRead]);const view=await delivery.factoryTask(readOnly.actor,readAssignment.id);expect(view.canRespond).toBe(false);await expect(delivery.factoryFeedback(readOnly.actor,readAssignment.id,factoryReply(view,"received"))).rejects.toBeInstanceOf(ForbiddenError);
  },60_000);
  it("does not revive old assignments when a revoked factory grant is explicitly replaced",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),old=await assign(member.grant.id,packet);
    await collaboration.revokeGrant(context,member.grant.id,{idempotencyKey:randomUUID(),reason:"Synthetic cooperation revoked"});expect((await loader.load({sub:member.subject,tenant_id:tenantId}))!.permissions).toEqual([]);await expect(delivery.factoryTask(member.actor,old.id)).rejects.toBeInstanceOf(NotFoundException);
    const replacement=await collaboration.createGrant(context,{factoryId:factoryFixture.factory.id,membershipId:member.membershipId,canRespond:true,expiresAt:new Date(Date.now()+86_400_000).toISOString(),idempotencyKey:randomUUID()});const current=await assign(replacement.id,packet);
    expect((await delivery.factoryTasks(member.actor,{})).items.map(row=>row.id)).toEqual([current.id]);await expect(delivery.factoryFile(member.actor,old.id)).rejects.toBeInstanceOf(NotFoundException);
  },60_000);
  it("revokes individual tasks, preserves idempotent original receipts and rejects replay after revocation",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),assignment=await assign(member.grant.id,packet),view=await delivery.factoryTask(member.actor,assignment.id),input=factoryReply(view,"received");
    const first=await delivery.factoryFeedback(member.actor,assignment.id,input),repeated=await delivery.factoryFeedback(member.actor,assignment.id,input);expect(repeated.receipts).toEqual(first.receipts);
    await collaboration.revokeAssignment(context,assignment.id,{idempotencyKey:randomUUID(),reason:"Synthetic file assignment revoked"});await expect(delivery.factoryFeedback(member.actor,assignment.id,input)).rejects.toBeInstanceOf(NotFoundException);expect((await delivery.factoryTasks(member.actor,{})).items).toHaveLength(0);
    const origins=await withTenant(database.db,context,tx=>tx.select().from(factoryTaskReceipts).where(eq(factoryTaskReceipts.assignmentId,assignment.id)));expect(origins).toHaveLength(1);
  },60_000);
  it("does not return a file when the grant is revoked during actual storage reading",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),assignment=await assign(member.grant.id,packet);let reads=0;
    onFactoryRead=async()=>{reads++;await collaboration.revokeGrant(context,member.grant.id,{idempotencyKey:randomUUID(),reason:"Synthetic revocation during storage read"});};
    try{await expect(delivery.factoryFile(member.actor,assignment.id)).rejects.toBeInstanceOf(NotFoundException);expect(reads).toBe(1);}finally{onFactoryRead=undefined;}
  },60_000);
  it("withholds private task evidence after retention ends, without exposing operator notes",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),assignment=await assign(member.grant.id,packet);
    await delivery.recordFeedback(context,packet.id,packet.items[0]!.id,{...receipt(packet,"received"),note:"Private operator buyer/address information must stay internal"});
    const current=await delivery.factoryTask(member.actor,assignment.id);expect(current.receipts[0]!.origin).toBe("operator");expect(JSON.stringify(current)).not.toContain("Private operator buyer");
    await withTenant(database.db,context,tx=>tx.update(orderWorkItems).set({expiresAt:new Date(0)}).where(eq(orderWorkItems.id,f.lineId)));
    const expired=await delivery.factoryTask(member.actor,assignment.id);expect(expired).toMatchObject({manufacturing:null,file:null,receipts:[],canRespond:false});await expect(delivery.factoryFile(member.actor,assignment.id)).rejects.toBeInstanceOf(NotFoundException);await expect(delivery.factoryFeedback(member.actor,assignment.id,factoryReply(current,"accepted"))).rejects.toThrow();
  },60_000);
  it("waits through a short database clock rollback for actual assignment and grant revocation",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),assignment=await assign(member.grant.id,packet);
    for(const [table,id] of [["factory_task_assignments",assignment.id],["factory_access_grants",member.grant.id]] as const){
      await database.client.begin(async fixtureTx=>{
        await fixtureTx.unsafe("set local session_replication_role=replica");
        await fixtureTx.unsafe(`update ${table} set created_at=clock_timestamp()+interval '350 milliseconds' where tenant_id=$1 and id=$2`,[tenantId,id]);
      });
      const input={reason:"Synthetic operator revocation after wall clock rollback",idempotencyKey:randomUUID()};
      if(table==="factory_task_assignments")await collaboration.revokeAssignment(context,id,input);
      else await collaboration.revokeGrant(context,id,input);
      const [timing]=await withTenant(database.db,context,tx=>tx.execute<{ordered:boolean}>(sql`select revoked_at>=created_at and revoked_at<=clock_timestamp() as ordered from ${sql.identifier(table)} where id=${id}::uuid`));
      expect(timing!.ordered).toBe(true);
    }
  },60_000);
  it("protects grant and assignment history in SQL and does not permit a collaborator to mint authority",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),assignment=await assign(member.grant.id,packet);
    await expect(withTenant(database.db,context,tx=>tx.update(factoryAccessGrants).set({expiresAt:new Date(Date.now()+172_800_000)}).where(eq(factoryAccessGrants.id,member.grant.id)))).rejects.toThrow();
    await expect(withTenant(database.db,context,tx=>tx.update(factoryTaskAssignments).set({fileChecksum:"f".repeat(64)}).where(eq(factoryTaskAssignments.id,assignment.id)))).rejects.toThrow();
    await expect(withTenant(database.db,member.actor,tx=>tx.insert(factoryAccessGrants).values({id:createEntityId(),tenantId,factoryId:factoryFixture.factory.id,membershipId:member.membershipId,canRespond:true,expiresAt:new Date(Date.now()+86_400_000),idempotencyKey:randomUUID(),requestChecksum:"a".repeat(64),createdBy:member.actor.userId}))).rejects.toThrow();
    expect(await withTenant(database.db,other,tx=>tx.select().from(factoryTaskAssignments).where(eq(factoryTaskAssignments.id,assignment.id)))).toHaveLength(0);
  },60_000);
  it("rejects stale, wrong-file and expanded factory commands and serializes competing original receipts",async()=>{
    const f=await fixture(),packet=await create(f),member=await collaborator(),assignment=await assign(member.grant.id,packet),view=await delivery.factoryTask(member.actor,assignment.id),input=factoryReply(view,"received");
    await expect(delivery.factoryFeedback(member.actor,assignment.id,{...input,fileChecksum:"f".repeat(64)})).rejects.toBeInstanceOf(ConflictException);
    await expect(delivery.factoryFeedback(member.actor,assignment.id,{...input,cost:{amountMinor:1,currency:"USD"}})).rejects.toThrow();
    const results=await Promise.allSettled([delivery.factoryFeedback(member.actor,assignment.id,input),delivery.factoryFeedback(member.actor,assignment.id,{...input,idempotencyKey:randomUUID()})]);expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const current=await delivery.factoryTask(member.actor,assignment.id);expect(current.sequence).toBe(1);expect(current.receipts).toHaveLength(1);
    await expect(delivery.factoryFeedback(member.actor,assignment.id,{...factoryReply(current,"accepted"),expectedSequence:0})).rejects.toBeInstanceOf(ConflictException);
  },60_000);
  function coordinator() {
    // Isolated adapter controls logistics availability; ZIP + actual carrier pin is covered by logistics E2E.
    const pins = new Map<string, string>(); let available = true, readable = true;
    const logistics = { workspace: async () => { if (!readable) throw new Error("Private fixture transport details"); return { tasks: [] }; }, deliveryForProduction: async (_ctx: TenantContext, versionId: string) => {
      if (!available) return null;
      if (!pins.has(versionId)) pins.set(versionId, createEntityId());
      return { taskId: pins.get(versionId)!, externalReference: "Synthetic", provider: "shipos", labelMode: "factory_pull", trackingNumbers: [], labels: [] };
    } } as unknown as LogisticsService;
    const whole = new OrderWholeDetailService(work, production, new OrderShipmentService(database, vault, orderService, audit, { enqueue: async () => { throw new Error("No marketplace calls"); } }),
      new OrderAfterSalesService(database, vault, audit), editor, { orderEvidence: async () => [] } as unknown as ShiposService);
    const taskDelivery = new OrderProductionDeliveryService(database, vault, editor, production, audit, factories, logistics);
    return { service: new OrderTaskService(whole, taskDelivery, logistics, database, vault), taskDelivery, availability: (value: boolean) => { available = value; }, readable: (value: boolean) => { readable = value; } };
  }
  it("coordinates distinct factories and reuses an immutable package after concurrent and lost-response retries", async () => {
    const f = await fixture(), secondFactory = await createSyntheticFactory(factories, context, supplierId, "shaped_pillow"), second = await fixture(false, secondFactory, f), c = coordinator();
    const initial = await c.service.get(context, f.lineId);
    expect(initial.groups).toHaveLength(2); expect(initial.groups.every(group => group.canPrepare)).toBe(true);
    expect((await delivery.workspace(context, { order: f.orderId })).packages).toHaveLength(0);
    const selected = initial.groups[0]!, input = { groupId: selected.id, expectedFingerprint: selected.fingerprint };
    const [first, replay] = await Promise.all([c.service.prepareDelivery(context, f.lineId, input), c.service.prepareDelivery(context, f.lineId, input)]);
    const id = first.groups.find(group => group.id === selected.id)!.package!.id;
    expect(replay.groups.find(group => group.id === selected.id)!.package!.id).toBe(id);
    expect((await c.service.prepareDelivery(context, f.lineId, input)).groups.find(group => group.id === selected.id)!.package!.id).toBe(id);
    const list = c.taskDelivery.workspace.bind(c.taskDelivery);
    const limitedHistory = vi.spyOn(c.taskDelivery, "workspace").mockImplementation(async (ctx, query) => ({ ...await list(ctx, query), packages: [] }));
    expect((await c.service.get(context, f.lineId)).groups.find(group => group.id === selected.id)!.package!.id).toBe(id);
    limitedHistory.mockRestore();
    const otherGroup = first.groups.find(group => group.id !== selected.id)!;
    expect(otherGroup.package).toBeNull(); expect(otherGroup.canPrepare).toBe(true);
    await c.service.prepareDelivery(context, f.lineId, { groupId: otherGroup.id, expectedFingerprint: otherGroup.fingerprint });
    const packets = (await delivery.workspace(context, { order: f.orderId })).packages;
    expect(packets).toHaveLength(2); expect(packets.every(packet => packet.items.length === 1)).toBe(true);
    expect(new Set(packets.map(packet => packet.factory?.factoryId)).size).toBe(2);
    expect((await production.get(context, f.productionId)).productionOrder.status).toBe("planned");
    expect((await production.get(context, second.productionId)).productionOrder.status).toBe("planned");
  }, 60000);
  it("prepares a new logistics-bound package without rewriting an older artwork-only package", async () => {
    const f = await fixture(), old = await create(f), c = coordinator();
    const group = (await c.service.get(context, f.lineId)).groups[0]!;
    expect(group.package).toBeNull(); expect(group.canPrepare).toBe(true);
    const result = await c.service.prepareDelivery(context, f.lineId, { groupId: group.id, expectedFingerprint: group.fingerprint });
    expect(result.groups[0]!.package!.id).not.toBe(old.id);
    expect((await delivery.get(context, old.id)).checksum).toBe(old.checksum);
    expect((await delivery.get(context, old.id)).items[0]!.snapshot!.logistics).toBeUndefined();
  }, 60000);
  it("refuses missing logistics, changed basis, cancelled orders and permission or tenant escape", async () => {
    const f = await fixture(), c = coordinator(); c.availability(false);
    const blocked = await c.service.get(context, f.lineId), group = blocked.groups[0]!;
    expect(group.canPrepare).toBe(false);
    await expect(c.service.prepareDelivery(context, f.lineId, { groupId: group.id, expectedFingerprint: group.fingerprint })).rejects.toBeInstanceOf(ConflictException);
    c.availability(true);
    await expect(c.service.prepareDelivery(context, f.lineId, { groupId: group.id, expectedFingerprint: group.fingerprint })).rejects.toBeInstanceOf(ConflictException);
    const ready = (await c.service.get(context, f.lineId)).groups[0]!, input = { groupId: ready.id, expectedFingerprint: ready.fingerprint };
    c.readable(false); const failed = await c.service.get(context, f.lineId);
    expect(failed.groups[0]!.canPrepare).toBe(false); expect(JSON.stringify(failed)).not.toContain("Private fixture transport details"); c.readable(true);
    await expect(c.service.get(other, f.lineId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.service.get({ ...context, dataScope: "self" }, f.lineId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(c.service.prepareDelivery({ ...context, permissions: context.permissions.filter(p => p !== Permission.OrderWrite) }, f.lineId, input)).rejects.toBeInstanceOf(ForbiddenError);
    await withTenant(database.db, context, tx => tx.update(orders).set({ sideState: "cancelled" }).where(eq(orders.id, f.orderId)));
    const cancelled = await c.service.get(context, f.lineId); expect(cancelled.task.state).toBe("cancelled"); expect(cancelled.groups[0]!.canPrepare).toBe(false);
    await expect(c.service.prepareDelivery(context, f.lineId, input)).rejects.toBeInstanceOf(ConflictException);
    expect((await delivery.workspace(context, { order: f.orderId })).packages).toHaveLength(0);
  }, 60000);
  const receipt = (packet: Awaited<ReturnType<typeof create>>, kind: string, extra: Record<string, unknown> = {}) => ({ kind, expectedSequence: packet.items[0]!.sequence, fileChecksum: packet.items[0]!.snapshot!.file.checksum,
    manufacturingChecksum: packet.items[0]!.snapshot!.manufacturing?.plan.checksum,
    reference: "SYNTHETIC_FACTORY_MSG", note: "Synthetic operator checked actual response", occurredAt: new Date().toISOString(), verifiedByOperator: true, idempotencyKey: randomUUID(), ...extra });
  it("pins exact approved JPG and template in deterministic ZIP without releasing production", async () => {
    const f = await fixture(), packet = await create(f), pin = packet.items[0]!.snapshot!;
    expect(pin).toMatchObject({ editorVersionId: f.versionId, ruleSnapshotStatus: "legacy_missing", minimumNeckBasis: "cut_contour", minimumNeckMm: 50 }); expect(pin.templateVersionId).toBeTruthy();
    const a = await delivery.download(context, packet.id), b = await delivery.download(context, packet.id); expect(sha(a.body)).toBe(sha(b.body));
    const zip = await JSZip.loadAsync(a.body), bytes = await zip.file(pin.file.path)!.async("nodebuffer"); expect(sha(bytes)).toBe(pin.file.checksum);
    expect(await sharp(bytes).metadata()).toMatchObject({ density: 150, format: "jpeg", channels: 3, hasAlpha: false, chromaSubsampling: "4:4:4", width: pin.file.width, height: pin.file.height });
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")); expect(sha(JSON.stringify(manifest))).toBe(packet.checksum); expect(JSON.stringify(manifest)).not.toMatch(/objectKey|encrypted|buyerAddress|apiKey/);
    expect(sha(await zip.file("manifest.json")!.async("nodebuffer"))).toBe(packet.checksum);
    expect(manifest.schemaVersion).toBe(3); expect(manifest.items[0].manufacturing.plan.checksum).toBe(pin.manufacturing!.plan.checksum);
    expect(await zip.file("制造材料清单.csv")!.async("string")).toContain("商家供料");
    expect(await zip.file("制造工序清单.csv")!.async("string")).toContain("工厂执行");
    expect(await zip.file("本单生产说明.csv")!.async("string")).toContain(pin.instructions);
    expect((await production.get(context, f.productionId)).productionOrder.status).toBe("planned"); expect(packet.items[0]!.feedback).toHaveLength(0);
    expect((await delivery.workspace(context, { line: f.lineId, supplier: supplierId })).packages.map(row => row.id)).toEqual([packet.id]);
    const byOrder = await delivery.workspace(context, { order: f.orderId });
    expect(byOrder.candidates.map(row => row.orderLineId)).toEqual([f.lineId]);
    expect(byOrder.packages.map(row => row.id)).toEqual([packet.id]);
    expect((await delivery.workspace(context, { order: createEntityId() })).packages).toEqual([]);
    expect((await delivery.workspace(other, { order: f.orderId })).candidates).toEqual([]);
    expect((await delivery.workspace(context, { line: f.lineId, supplier: createEntityId() })).packages).toHaveLength(0);
    expect((await delivery.workspace(context, { line: f.lineId, dueBefore: new Date().toISOString() })).packages).toHaveLength(0);
  });
  it("replays concurrent creation and rejects changed retry contents", async () => {
    const f = await fixture(true), input = { supplierId, factoryId: factoryFixture.factory.id, items: [f.selection], idempotencyKey: randomUUID() };
    const [a, b] = await Promise.all([delivery.create(context, input), delivery.create(context, input)]); expect(a.id).toBe(b.id); expect(a.items[0]!.snapshot!.ruleSnapshotStatus).toBe("pinned");
    await expect(delivery.create(context, { ...input, items: [{ ...f.selection, expectedProjectionVersion: 99 }] })).rejects.toBeInstanceOf(ConflictException);
  });
  async function submittedPhysicalState(productionId: string) {
    return withTenant(database.db, context, async tx => {
      const [state] = await tx.execute<{ reports: number; reviews: number; inspections: number; capacity: string }>(sql`
        select (select count(*)::int from production_quantity_reports where production_order_id=${productionId}::uuid) as reports,
          (select count(*)::int from production_quantity_reviews where production_order_id=${productionId}::uuid) as reviews,
          (select count(*)::int from quality_inspections where production_order_id=${productionId}::uuid) as inspections,
          (select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id)::text,'[]')) from factory_capacity_events e
            join factory_capacity_reservations r on r.tenant_id=e.tenant_id and r.id=e.reservation_id
            where r.production_order_id=${productionId}::uuid) as capacity`);
      return state!;
    });
  }
  it("submitted-only: creating and downloading the original package stays planned until one submitted receipt schedules the batch", async () => {
    const f = await fixture(), original = await production.get(context, f.productionId), physical = await submittedPhysicalState(f.productionId);
    expect(original.productionOrder.status).toBe("planned"); expect(original.milestones).toEqual([]);
    expect(physical).toMatchObject({ reports: 0, reviews: 0, inspections: 0 });
    const packet = await create(f), downloaded = await delivery.download(context, packet.id);
    try { expect(downloaded.body.byteLength).toBeGreaterThan(0); } finally { downloaded.body.fill(0); }
    expect((await production.get(context, f.productionId)).productionOrder).toEqual(original.productionOrder);
    expect((await delivery.get(context, packet.id)).items[0]).toMatchObject({ status: "pending", sequence: 0, feedback: [] });
    const input = receipt(packet, "submitted"), saved = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, input);
    expect(saved.items[0]).toMatchObject({ status: "submitted", sequence: 1, feedback: [{ kind: "submitted", origin: "operator", reference: input.reference }] });
    expect(saved.items[0]!.feedback).toHaveLength(1);
    const current = await production.get(context, f.productionId);
    expect(current.productionOrder).toMatchObject({ status: "submitted", projectionVersion: original.productionOrder.projectionVersion + 1 });
    expect(current.milestones).toHaveLength(1);
    expect(current.milestones[0]).toMatchObject({ type: "submitted", evidenceCode: "DELIVERY_SUBMITTED", externalEventId: `DELIVERY:${packet.items[0]!.id}:1` });
    expect(current.versions).toEqual(original.versions); expect(current.inspections).toEqual([]);
    expect(await submittedPhysicalState(f.productionId)).toEqual(physical);
    expect((await delivery.get(context, packet.id)).items[0]!.feedback.map(row => row.kind)).toEqual(["submitted"]);
  });
  it("submitted-only: concurrent original submissions and a fresh replay keep one event and one success audit", async () => {
    const f = await fixture(), packet = await create(f), input = receipt(packet, "submitted"), before = await production.get(context, f.productionId);
    const results = await Promise.all([delivery.recordFeedback(context, packet.id, packet.items[0]!.id, input),
      delivery.recordFeedback(context, packet.id, packet.items[0]!.id, input)]);
    const id = results[0]!.items[0]!.feedback[0]!.id;
    for (const result of results) expect(result.items[0]).toMatchObject({ status: "submitted", sequence: 1, feedback: [{ id, kind: "submitted" }] });
    const fresh = new OrderProductionDeliveryService(database, vault, editor, production, audit, factories);
    expect((await fresh.recordFeedback(context, packet.id, packet.items[0]!.id, input)).items[0]!.feedback).toEqual(results[0]!.items[0]!.feedback);
    await expect(fresh.recordFeedback(context, packet.id, packet.items[0]!.id, { ...input, note: "Synthetic changed submitted body" })).rejects.toBeInstanceOf(ConflictException);
    const actual = await production.get(context, f.productionId);
    expect(actual.productionOrder).toMatchObject({ status: "submitted", projectionVersion: before.productionOrder.projectionVersion + 1 });
    expect(actual.milestones.map(row => row.type)).toEqual(["submitted"]);
    const [counts] = await withTenant(database.db, context, tx => tx.execute<{ receipts: number; audits: number }>(sql`
      select (select count(*)::int from production_delivery_feedback where item_id=${packet.items[0]!.id}::uuid) as receipts,
        (select count(*)::int from audit_events where entity_id=${packet.id}::uuid and action='production_delivery.feedback'
          and result='success' and metadata->>'itemId'=${packet.items[0]!.id}) as audits`));
    expect(counts).toEqual({ receipts: 1, audits: 1 });
  });
  it("submitted-only: an audit failure rolls back the submitted receipt, production projection and complete original row", async () => {
    const f = await fixture(), packet = await create(f), input = receipt(packet, "submitted"), original = await production.get(context, f.productionId), physical = await submittedPhysicalState(f.productionId);
    const realAudit = audit.recordInTransaction.bind(audit); let reached = false;
    const failure = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === "production_delivery.feedback" && event.resourceId === packet.id) {
        reached = true;
        const [inside] = await tx.select().from(productionOrders).where(eq(productionOrders.id, f.productionId));
        expect(inside).toMatchObject({ status: "submitted", projectionVersion: original.productionOrder.projectionVersion + 1 });
        const [receipts] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from production_delivery_feedback where item_id=${packet.items[0]!.id}::uuid and kind='submitted'`);
        expect(receipts?.count).toBe(1);
        throw new Error("Synthetic submitted audit failure");
      }
      return realAudit(tx, actor, event);
    });
    try { await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, input)).rejects.toThrow("Synthetic submitted audit failure"); }
    finally { failure.mockRestore(); }
    expect(reached).toBe(true); expect(await production.get(context, f.productionId)).toEqual(original);
    expect((await delivery.get(context, packet.id)).items[0]).toMatchObject({ status: "pending", sequence: 0, feedback: [] });
    expect(await submittedPhysicalState(f.productionId)).toEqual(physical);
    const [auditCount] = await withTenant(database.db, context, tx => tx.execute<{ count: number }>(sql`
      select count(*)::int as count from audit_events where entity_id=${packet.id}::uuid and action='production_delivery.feedback'`));
    expect(auditCount?.count).toBe(0);
    const restored = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, input);
    expect(restored.items[0]).toMatchObject({ status: "submitted", sequence: 1 }); expect(restored.items[0]!.feedback.map(row => row.kind)).toEqual(["submitted"]);
  });
  it("binds and deduplicates received/accepted replies and advances progress atomically", async () => {
    const f = await fixture(); let packet = await create(f);
    const attention = new FulfillmentAttentionService(database, vault);
    // Earlier cases retain their pending delivery history in this disposable
    // tenant. Find this actual item across the supported 12-item pages.
    const currentAttention = async () => {
      for (let page = 1; ; page++) {
        const workspace = await attention.workspace(context, { source: "delivery", page });
        const item = workspace.items.find(row => row.entityId === packet.items[0]!.id);
        if (item || !workspace.hasMore) return item;
      }
    };
    expect(await currentAttention()).toMatchObject({status:"pending",href:expect.stringContaining(`delivery=${packet.id}`)});
    expect((await attention.workspace(other,{source:"delivery"})).items).toEqual([]);
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "accepted"))).rejects.toBeInstanceOf(ConflictException);
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "received", { fileChecksum: "0".repeat(64) }))).rejects.toBeInstanceOf(ConflictException);
    const input = receipt(packet, "received"); packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, input); await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, input);
    expect(packet.items[0]).toMatchObject({ sequence: 1, status: "received" }); expect((await production.get(context, f.productionId)).productionOrder.status).toBe("submitted");
    expect(await currentAttention()).toMatchObject({ status: "legacy_received", nextAction: "同步工厂进度" });
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, { ...input, note: "Changed same reply" })).rejects.toBeInstanceOf(ConflictException);
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "accepted")); expect(packet.items[0]).toMatchObject({ sequence: 2, status: "accepted" });
    expect(await currentAttention()).toBeUndefined();
    const current = await production.get(context, f.productionId); expect(current.productionOrder.status).toBe("acknowledged"); expect(current.milestones).toHaveLength(2);
  });
  it("projects original factory CSV progress and void exceptions without optional receipts or shipment side effects", async () => {
    const f = await fixture(); let packet = await create(f);
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "submitted"));
    const operator = (await loader.load({ sub: `delivery-${userId}`, tenant_id: tenantId }))!;
    expect(operator.permissionScopes).toBeDefined();
    const attention = new FulfillmentAttentionService(database, vault);
    const importer = new FactoryErpImportService(database, vault, new FactoryErpSourceGateway(storage, vault, { scan: clean }), delivery, audit);
    const item = packet.items[0]!, pin = item.snapshot!, externalId = `PRIVATE-ERP-HEAD-${createEntityId()}`;
    const selection = { deliveryItemId: item.id, productionOrderId: f.productionId, productionVersionId: pin.productionVersionId,
      fileChecksum: pin.file.checksum, manufacturingChecksum: pin.manufacturing!.plan.checksum };
    const physical = await submittedPhysicalState(f.productionId), submitted = await production.get(context, f.productionId);
    async function collect(service = attention, actor = operator) {
      const first = await service.workspace(actor, { source: "delivery" }), items = [...first.items];
      expect(first.sources.find(source => source.source === "delivery")?.count).toBe(first.total);
      for (let page = 2; (page - 1) * first.pageSize < first.total; page++) {
        const next = await service.workspace(actor, { source: "delivery", page });
        expect(next.total).toBe(first.total); expect(next.sources).toEqual(first.sources);
        expect(next.items.length).toBeGreaterThan(0); items.push(...next.items);
      }
      expect(items).toHaveLength(first.total); expect(new Set(items.map(row => row.id)).size).toBe(first.total);
      expect(JSON.stringify(items)).not.toMatch(/PRIVATE-ERP|trackingReference|rawStatus|shippedQuantity/);
      return { ...first, items };
    }
    async function importStatus(status: string) {
      const row = [externalId, "Synthetic owned source", "PRIVATE-ERP-REFERENCE", "PRIVATE-ERP-TRACKING", "", "", "1", "2",
        "PRIVATE-ERP-CARRIER", "PRIVATE-ERP-SERVICE", status, "2026-10-21 08:09:10", "2026-10-21 09:10:11"];
      const quote = (text: string) => /[,\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      const bytes = Buffer.from([FACTORY_ERP_HEADERS, row].map(values => values.map(quote).join(",")).join("\r\n"), "utf8");
      const source = await importer.upload(operator, { factoryId: factoryFixture.factory.id, fileName: "synthetic-factory-current-page.csv",
        contentBase64: bytes.toString("base64"), checksumSha256: sha(bytes), options: { csvEncoding: "utf-8", delimiter: "," }, idempotencyKey: randomUUID() });
      await importer.apply(operator, source.id, { fileChecksum: source.fileChecksum, previewChecksum: source.previewChecksum,
        idempotencyKey: randomUUID(), confirmed: true, rows: [{ rowNumber: 2, items: [selection], wholeGroupConfirmed: true }] });
    }
    expect((await collect()).items.find(row => row.entityId === item.id)).toMatchObject({ status: "scheduled_by_submission", nextAction: "同步工厂进度" });
    await importStatus("已审核");
    expect((await collect()).items.find(row => row.entityId === item.id)).toMatchObject({ status: "factory_scheduled", nextAction: "同步工厂进度" });
    await importStatus("已出库");
    expect((await collect()).items.find(row => row.entityId === item.id)).toMatchObject({ status: "factory_shipped", nextAction: "核对实际发货" });
    expect((await collect(attention, context)).items.find(row => row.entityId === item.id)?.status).toBe("scheduled_by_submission");
    expect((await collect(new FulfillmentAttentionService(database))).items.find(row => row.entityId === item.id))
      .toMatchObject({ status: "factory_status_unavailable", priority: "blocked" });
    await expect(collect(new FulfillmentAttentionService(database, new SecretVault(Buffer.alloc(32, 94))))).rejects.toThrow();
    expect((await delivery.get(context, packet.id)).items[0]!.feedback.map(value => value.kind)).toEqual(["submitted"]);
    expect(await production.get(context, f.productionId)).toEqual(submitted);
    expect(await submittedPhysicalState(f.productionId)).toEqual(physical);

    // Optional legacy acceptance may close its old queue. A later original
    // factory void must re-enter only the member-authorized exception queue.
    packet = await delivery.recordFeedback(context, packet.id, item.id, receipt(packet, "received"));
    packet = await delivery.recordFeedback(context, packet.id, item.id, receipt(packet, "accepted"));
    const beforeVoid = await collect(), legacyBeforeVoid = await collect(attention, context);
    expect(beforeVoid.items.some(row => row.entityId === item.id)).toBe(false);
    const accepted = await production.get(context, f.productionId), acceptedPhysical = await submittedPhysicalState(f.productionId);
    await importStatus("已作废");
    const afterVoid = await collect(), legacyAfterVoid = await collect(attention, context);
    expect(afterVoid.total).toBe(beforeVoid.total + 1);
    expect(afterVoid.items.find(row => row.entityId === item.id))
      .toMatchObject({ status: "factory_voided_requires_review", nextAction: "核对工厂作废", priority: "blocked" });
    expect(legacyAfterVoid.total).toBe(legacyBeforeVoid.total); expect(legacyAfterVoid.items).toEqual(legacyBeforeVoid.items);
    const emptyAdapterPage = await attention.workspace(context, { source: "delivery", page: 10_000 });
    expect(emptyAdapterPage).toMatchObject({ total: legacyBeforeVoid.total, hasMore: false, items: [] });
    await expect(attention.workspace({ ...operator, tenantId: otherTenant }, { source: "delivery", page: 10_000 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await production.get(context, f.productionId)).toEqual(accepted);
    expect(await submittedPhysicalState(f.productionId)).toEqual(acceptedPhysical);
  }, 60_000);
  it("prevents old milestone routes bypassing new file receipts", async () => {
    const f = await fixture(); await create(f);
    await expect(production.recordMilestone(context, f.productionId, { type: "submitted", expectedProjectionVersion: 1, externalEventId: null, occurredAt: new Date().toISOString(), evidence: { code: "SYNTHETIC", note: null, assetIds: [] } })).rejects.toBeInstanceOf(ConflictException);
  });
  it("creates a partial remake from explicitly reviewed artwork and links it to the rejected delivery", async () => {
    const f = await fixture(); let packet = await create(f);
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rejected", { affectedQuantity: 1 }));
    const attention = new FulfillmentAttentionService(database, vault);
    expect((await attention.workspace(context,{source:"delivery"})).items.find(item=>item.entityId===packet.items[0]!.id)).toMatchObject({status:"rejected",priority:"blocked"});
    expect((await attention.workspace(context,{source:"production"})).items.some(item=>item.entityId===f.productionId)).toBe(false);
    expect((await attention.workspace({...context,permissions:context.permissions.filter(p=>p!==Permission.DesignRead)},{source:"production"})).items.some(item=>item.entityId===f.productionId)).toBe(true);
    const detail = await work.detail(context, f.lineId), render = (await editor.get(context, f.projectId)).renders.find(row => row.purpose === "production" && row.status === "completed")!;
    const input = { type: "remake", manufacturing: f.manufacturing, capacityPlan: f.capacityPlan, originalProductionOrderId: f.productionId, remakeQuantity: 1, reason: "Synthetic factory agreed partial remake", expectedCompletionAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: randomUUID(),
      reviewedArtwork: { renderId: render.id, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, instructions: "Synthetic reviewed replacement instructions" } };
    const result = await production.recover(context, input), replay = await production.recover(context, input);
    expect((await attention.workspace(context,{source:"delivery"})).items.some(item=>item.entityId===packet.items[0]!.id)).toBe(false);
    expect(replay).toEqual(result); expect(result.replacementProductionOrderId).toBeTruthy();
    await expect(production.recover(context, { ...input, remakeQuantity: 2 })).rejects.toBeInstanceOf(ConflictException);
    await withTenant(database.db, context, tx => tx.update(fulfillmentSuppliers).set({ status: "suspended" }).where(eq(fulfillmentSuppliers.id, supplierId)));
    try { await expect(production.recover(context, { ...input, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException); }
    finally { await withTenant(database.db, context, tx => tx.update(fulfillmentSuppliers).set({ status: "active" }).where(eq(fulfillmentSuppliers.id, supplierId))); }
    const replacement = await production.get(context, result.replacementProductionOrderId!); expect(replacement.versions[0]).toMatchObject({ quantity: 1, sourceEditorVersionId: f.versionId, sourceRenderId: render.id });
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rework", { affectedQuantity: 1, replacementProductionOrderId: result.replacementProductionOrderId }));
    expect(packet.items[0]!.feedback.at(-1)).toMatchObject({ replacementEditorVersionId: f.versionId, replacementEditorVersionNumber: 1 });
    const reviewed = await review.get(context, f.lineId);
    expect(reviewed.lines[0]).toMatchObject({ remakeCount: 1, remakeQuantity: 1, factoryRejections: 1, factoryId: factoryFixture.factory.id });
    expect(reviewed.rework).toEqual(expect.arrayContaining([expect.objectContaining({ source: "factory", originalVersionId: f.versionId,
      replacementVersionId: f.versionId, replacementVersionNumber: 1, replacementProductionOrderId: result.replacementProductionOrderId })]));
    const next = await delivery.create(context, { supplierId, factoryId: factoryFixture.factory.id, items: [{ productionOrderId: replacement.productionOrder.id, productionVersionId: replacement.versions[0]!.id, expectedProjectionVersion: replacement.productionOrder.projectionVersion }], idempotencyKey: randomUUID() });
    expect(next.canDownload).toBe(true); expect(next.items[0]!.snapshot!.quantity).toBe(1); expect(packet.canDownload).toBe(false);
  });
  it("pins a newly reviewed editor version for corrected remake without rewriting the original packet", async () => {
    const f = await fixture(); let packet = await create(f);
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rejected", { affectedQuantity: 1 }));
    for (const type of ["cancel_requested", "cancelled"] as const) { const record = await production.get(context, f.productionId); await production.recordMilestone(context, f.productionId, { type, expectedProjectionVersion: record.productionOrder.projectionVersion, externalEventId: null, evidence: { code: "SYNTHETIC_STOP", note: null, assetIds: [] }, occurredAt: new Date().toISOString() }); }
    let detail = await work.detail(context, f.lineId);
    detail = await work.action(context, f.lineId, { action: "reject_artwork", expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: f.versionId, reason: "Synthetic stopped original before revision", idempotencyKey: randomUUID() });
    const current = await editor.get(context, f.projectId), changed = structuredClone(current.version.document); changed.layers[0]!.name = "Synthetic corrected layer note";
    const next = await editor.save(context, f.projectId, { expectedVersionId: current.version.id, document: changed });
    for (const action of ["submit_artwork", "approve_artwork"] as const) { detail = await work.action(context, f.lineId, { action, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: next.version.id, reason: "Synthetic operator reviewed new version", idempotencyKey: randomUUID() }); }
    const render = (await editor.get(context, f.projectId)).renders.find(row => row.versionId === next.version.id && row.purpose === "production")!;
    await worker.process(JobEnvelopeSchema.parse({ jobId: render.id, type: "production_editor_render", tenantId, requestedBy: userId, correlationId: render.id, idempotencyKey: render.id, payload: { renderId: render.id } }));
    const result = await production.recover(context, { type: "remake", manufacturing: f.manufacturing, capacityPlan: f.capacityPlan, originalProductionOrderId: f.productionId, remakeQuantity: 1, reason: "Synthetic corrected version remake", expectedCompletionAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: randomUUID(),
      reviewedArtwork: { renderId: render.id, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, instructions: "New reviewed version, preserve image" } });
    const child = await production.get(context, result.replacementProductionOrderId!); expect(child.versions[0]!.sourceEditorVersionId).toBe(next.version.id);
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rework", { affectedQuantity: 1, replacementProductionOrderId: result.replacementProductionOrderId }));
    expect(packet.items[0]!.snapshot!.editorVersionId).toBe(f.versionId); expect(packet.items[0]!.feedback.at(-1)!.replacementEditorVersionNumber).toBe(2);
  });
  it("blocks rejected-file download and preserves quoted and confirmed repair cost history", async () => {
    const f = await fixture(); let packet = await create(f); packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "received"));
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rejected", { affectedQuantity: 1, cost: { amountMinor: 2500, currency: "CNY", basis: "quote", reference: "QUOTE_001" } }));
    expect(packet.canDownload).toBe(false); await expect(delivery.download(context, packet.id)).rejects.toBeInstanceOf(ConflictException); expect((await production.get(context, f.productionId)).productionOrder.status).toBe("failed");
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rework", { affectedQuantity: 1, cost: { amountMinor: 1500, currency: "CNY", basis: "confirmed", reference: "AGREEMENT_001" } }));
    expect(packet.items[0]!.feedback.map(event => event.cost?.basis ?? null)).toEqual([null, "quote", "confirmed"]); expect(packet.items[0]!.status).toBe("rejected");
    const reviewed = await review.get(context, f.lineId);
    expect(reviewed.costs.filter(cost => cost.source === "factory")).toMatchObject([
      { basis: "quote", current: false, amountMinor: 2500, ledgerFactIds: [] },
      { basis: "confirmed", current: true, amountMinor: 1500, ledgerFactIds: [] },
    ]);
    expect(reviewed.profit.profitMinor).toBeNull();
  });
  it("rejects excessive quantity, future events and unrelated replacement orders", async () => {
    const f = await fixture(), unrelated = await fixture(); let packet = await create(f);
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rejected", { affectedQuantity: 3 }))).rejects.toBeInstanceOf(ConflictException);
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "received", { occurredAt: new Date(Date.now() + 86_400_000).toISOString() }))).rejects.toBeInstanceOf(ConflictException);
    packet = await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rejected", { affectedQuantity: 1 }));
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "rework", { affectedQuantity: 1, replacementProductionOrderId: unrelated.productionId }))).rejects.toBeInstanceOf(ConflictException);
  });
  it("retains original snapshot but revokes download after hold, revision change or expiry", async () => {
    const f = await fixture(), packet = await create(f);
    const attention = new FulfillmentAttentionService(database, vault);
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ held: true }).where(eq(orderWorkItems.id, f.lineId))); expect((await delivery.get(context, packet.id)).canDownload).toBe(false);
    expect((await attention.workspace(context,{source:"delivery"})).items.some(item=>item.entityId===packet.items[0]!.id)).toBe(false);
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ held: false, artwork: "changes_requested", approvedEditorVersionId: null }).where(eq(orderWorkItems.id, f.lineId)));
    expect((await attention.workspace(context,{source:"delivery"})).items.some(item=>item.entityId===packet.items[0]!.id)).toBe(false);
    expect((await delivery.get(context, packet.id)).items[0]!.snapshot!.editorVersionId).toBe(f.versionId); await expect(delivery.download(context, packet.id)).rejects.toBeInstanceOf(ConflictException);
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(orderWorkItems.id, f.lineId)));
    const expired = await delivery.get(context, packet.id); expect(expired.items[0]).toMatchObject({ snapshot: null, feedback: [] }); expect(JSON.stringify(expired)).not.toContain(f.orderNumber);
    expect((await attention.workspace(context,{source:"delivery"})).items.some(item=>item.entityId===packet.items[0]!.id)).toBe(false);
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "received"))).rejects.toBeInstanceOf(ConflictException);
  });
  it("rechecks revocation after private file reads before returning ZIP bytes", async () => {
    const f = await fixture(), packet = await create(f), original = editor.renderFile.bind(editor);
    const spy = vi.spyOn(editor, "renderFile").mockImplementationOnce(async (...args) => { const file = await original(...args); await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ held: true }).where(eq(orderWorkItems.id, f.lineId))); return file; });
    try { await expect(delivery.download(context, packet.id)).rejects.toBeInstanceOf(ConflictException); } finally { spy.mockRestore(); }
  });
  it("enforces RLS, private permissions and immutable history including owner writes", async () => {
    const f = await fixture(), packet = await create(f); expect((await delivery.workspace(other, {})).packages).toHaveLength(0);
    await expect(delivery.get(other, packet.id)).rejects.toBeInstanceOf(NotFoundException); await expect(delivery.download(other, packet.id)).rejects.toBeInstanceOf(NotFoundException);
    for (const permission of [Permission.OrderPiiRead, Permission.AssetRead, Permission.DesignRead]) await expect(delivery.get({ ...context, permissions: context.permissions.filter(p => p !== permission) }, packet.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(delivery.workspace({ ...context, dataScope: "self" }, {})).rejects.toBeInstanceOf(ForbiddenError);
    await withTenant(database.db, other, async tx => { expect(await tx.select().from(productionDeliveryItems)).toHaveLength(0); expect(await tx.select().from(productionDeliveryFeedback)).toHaveLength(0); });
    await expect(withTenant(database.db, context, tx => tx.update(productionDeliveryPackages).set({ checksum: "b".repeat(64) }).where(eq(productionDeliveryPackages.id, packet.id)))).rejects.toThrow();
    await expect(database.client.unsafe("update production_delivery_packages set checksum=$1 where id=$2", ["b".repeat(64), packet.id])).rejects.toThrow("immutable");
  });
  it("does not retain partial packages, rejects changed bytes and prevents archive path collisions", async () => {
    const f = await fixture(), blocked = await fixture(); await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ held: true }).where(eq(orderWorkItems.id, blocked.lineId)));
    const before = (await withTenant(database.db, context, tx => tx.select().from(productionDeliveryPackages))).length;
    await expect(delivery.create(context, { supplierId, factoryId: factoryFixture.factory.id, items: [f.selection, blocked.selection], idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect((await withTenant(database.db, context, tx => tx.select().from(productionDeliveryPackages))).length).toBe(before);
    const packet = await create(f), spy = vi.spyOn(editor, "renderFile").mockResolvedValueOnce({ body: Buffer.from("changed bytes"), name: "bad.jpg", mediaType: "image/jpeg", inline: false });
    try { await expect(delivery.download(context, packet.id)).rejects.toBeInstanceOf(ConflictException); } finally { spy.mockRestore(); }
    expect(deliveryFilePath(f.lineId, f.productionId, "../../a\\b<script>")).not.toMatch(/\.\.|<|\\/); expect(deliveryFilePath(f.lineId, f.productionId, "SAME-ORDER")).not.toBe(deliveryFilePath(createEntityId(), createEntityId(), "SAME-ORDER"));
  });
  it("separates two factories under one supplier and preserves the chosen address when the factory is revised", async () => {
    const a = await createSyntheticFactory(factories, context, supplierId, "shaped_pillow", "Synthetic site A"), b = await createSyntheticFactory(factories, context, supplierId, "shaped_pillow", "Synthetic site B");
    const f = await fixture(false, a), g = await fixture(false, b);
    const input = { supplierId, factoryId: a.factory.id, items: [f.selection], idempotencyKey: randomUUID() };
    const before = (await withTenant(database.db, context, tx => tx.select().from(productionDeliveryPackages))).length;
    await expect(delivery.create(context, { ...input, items: [f.selection, g.selection] })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.createBatch(context, { supplierId, productionOrderIds: [f.productionId, g.productionId], expectedCompletionAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: randomUUID() })).rejects.toThrow("同一具体工厂");
    expect((await withTenant(database.db, context, tx => tx.select().from(productionDeliveryPackages))).length).toBe(before);
    const revised = await factories.revise(context, a.factory.id, { expectedVersion: 1, profile: { ...a.factory.profile, productionAddress: { ...a.factory.profile.productionAddress!, street: "Synthetic new address" } }, idempotencyKey: randomUUID() });
    const packet = await delivery.create(context, input), download = await delivery.download(context, packet.id), zip = await JSZip.loadAsync(download.body);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.schemaVersion).toBe(3); expect(manifest.factory.factoryId).toBe(a.factory.id); expect(manifest.factory.factoryVersionId).toBe(a.factory.versionId);
    expect(manifest.factory.factoryProfile.productionAddress.street).toBe(a.factory.profile.productionAddress!.street);
    const paused = await factories.revise(context, a.factory.id, { expectedVersion: revised.versionNumber, profile: { ...revised.profile, status: "suspended" }, idempotencyKey: randomUUID() });
    expect((await delivery.get(context, packet.id)).canDownload).toBe(false);
    await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, receipt(packet, "accepted"))).rejects.toBeInstanceOf(ConflictException);
    await factories.revise(context, a.factory.id, { expectedVersion: paused.versionNumber, profile: revised.profile, idempotencyKey: randomUUID() });
    expect((await delivery.get(context, packet.id)).factory!.factoryVersionId).toBe(a.factory.versionId);
    expect((await delivery.workspace(context, { factory: b.factory.id })).candidates.map(candidate => candidate.productionOrderId)).toContain(g.productionId);
    expect((await delivery.workspace(context, { factory: b.factory.id })).packages.map(row => row.id)).not.toContain(packet.id);
  });
  it("rolls back package and receipt mutations when their audit fails, and restores the original intent without duplicate audit", async () => {
    const f = await fixture(), input = { supplierId, factoryId: factoryFixture.factory.id, items: [f.selection], idempotencyKey: randomUUID() };
    const realAudit = audit.recordInTransaction.bind(audit);
    let failure = vi.spyOn(audit, "recordInTransaction").mockImplementation((tx, actor, event) => event.action === "production_delivery.create" ? Promise.reject(new Error("Synthetic package audit failure")) : realAudit(tx, actor, event));
    try { await expect(delivery.create(context, input)).rejects.toThrow("Synthetic package audit failure"); } finally { failure.mockRestore(); }
    expect((await delivery.workspace(context, { line: f.lineId })).packages).toHaveLength(0);
    const packet = await delivery.create(context, input), original = await production.get(context, f.productionId), request = receipt(packet, "received");
    failure = vi.spyOn(audit, "recordInTransaction").mockImplementation((tx, actor, event) => event.action === "production_delivery.feedback" ? Promise.reject(new Error("Synthetic receipt audit failure")) : realAudit(tx, actor, event));
    try { await expect(delivery.recordFeedback(context, packet.id, packet.items[0]!.id, request)).rejects.toThrow("Synthetic receipt audit failure"); } finally { failure.mockRestore(); }
    expect((await delivery.get(context, packet.id)).items[0]).toMatchObject({ status: "pending", sequence: 0, feedback: [] });
    expect((await production.get(context, f.productionId)).productionOrder).toEqual(original.productionOrder);
    await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, request);
    const observe = vi.spyOn(audit, "recordInTransaction");
    try {
      expect((await delivery.create(context, input)).id).toBe(packet.id);
      expect((await delivery.recordFeedback(context, packet.id, packet.items[0]!.id, request)).items[0]!.sequence).toBe(1);
      expect(observe.mock.calls.filter(([, , event]) => event.action === "production_delivery.create" || event.action === "production_delivery.feedback")).toHaveLength(0);
    } finally { observe.mockRestore(); }
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(productionDeliveryPackages).where(eq(productionDeliveryPackages.id, packet.id)));
    const [item] = await withTenant(database.db, context, tx => tx.select().from(productionDeliveryItems).where(eq(productionDeliveryItems.id, packet.items[0]!.id)));
    for (const invalid of [{ manufacturingBindingId: null, manufacturingContentChecksum: null, manufacturingPlanChecksum: null }, { manufacturingContentChecksum: "f".repeat(64) }]) {
      await expect(withTenant(database.db, context, async tx => {
        const next = createEntityId(); await tx.insert(productionDeliveryPackages).values({ ...stored!, id: next, idempotencyKey: randomUUID() });
        await tx.insert(productionDeliveryItems).values({ ...item!, ...invalid, id: createEntityId(), packageId: next });
      })).rejects.toMatchObject({ cause: { code: "23514" } });
    }
  });
  // Historical manifest/checksum and unknown-factory assertions run against the
  // genuine pre-0134 database in manufacturing-upgrade.integration.test.ts.
});
