import { createHash } from "node:crypto";

import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type CustomizationDefinition, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles, connectDatabase, designTasks, designVersionFiles, designVersions, listingVersions, listings, migrateDatabase,
  orderCustomizationFileIntakes, orderCustomizationFileScanEvents, orderCustomizationVersions,
  orderExceptions, orderPersonalizationBatchItems, orderPersonalizationBatches, orderProofDecisions,
  orderPersonalizationRenderTasks, orderProtectedDetails, personalizationTemplateVersions, productPlans, skus, skuTemplateBindings, spus,
  templateSlots, withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderPersonalizationBatchService, type OrderPersonalizationBatchEnqueuer } from "../design/order-personalization-batch.service.js";
import { OrderPersonalizationRenderService, type OrderPersonalizationRenderEnqueuer } from "../design/order-personalization-render.service.js";
import { PodPersonalizationService } from "../design/pod-personalization.service.js";
import { OrderCustomizationService } from "./order-customization.service.js";
import { OrderService } from "./order.service.js";

describe("order customization and approval", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId(); const accountA = createEntityId();
  const planId = createEntityId(); const spuId = createEntityId(); const skuId = createEntityId();
  const listingId = createEntityId(); const listingVersionId = createEntityId();
  const designTaskId = createEntityId(); const designVersionId = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write", "order:pii:read", "asset:read"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write", "order:pii:read", "asset:read"], dataScope: "tenant" };
  const vault = new SecretVault(Buffer.alloc(32, 31));
  let orders: OrderService;
  let service: OrderCustomizationService;
  let orderId: string;
  let lineId: string;
  let requirementId: string;
  let customizationVersionId: string;
  const personalizationBatchJobs: string[] = [];

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Customization A", `custom-a-${tenantA}`, tenantB, "Customization B", `custom-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `custom-a-${userA}`, `a-${userA}@example.test`, "A", userB, `custom-b-${userB}`, `b-${userB}@example.test`, "B"]);
    await database.client.unsafe("insert into marketplace_accounts (id,tenant_id,platform,display_name,region,authorization_mode,created_by) values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [accountA, tenantA, "Customization Shop", userA]);
    await withTenant(database.db, contextA, async (tx) => {
      const customization = customizationSchema();
      await tx.insert(productPlans).values({ id: planId, tenantId: tenantA, name: "Custom product", status: "approved", customization, createdBy: userA });
      await tx.insert(spus).values({ id: spuId, tenantId: tenantA, productPlanId: planId, code: "CUSTOM", name: "Custom product", status: "ready", customization });
      await tx.insert(skus).values({ id: skuId, tenantId: tenantA, spuId, code: "CUSTOM-PINK", status: "active" });
      await tx.insert(listings).values({ id: listingId, tenantId: tenantA, spuId, platform: "etsy", marketplaceId: "etsy", locale: "en-US", status: "approved", primaryVersionId: listingVersionId, createdBy: userA });
      await tx.insert(listingVersions).values({
        id: listingVersionId, tenantId: tenantA, listingId, versionNumber: 1, ruleVersion: "etsy-2026.07", status: "approved", source: "human", createdBy: userA, approvedBy: userA, approvedAt: new Date(),
        content: { platform: "etsy", locale: "en-US", title: "Custom product", description: "Custom", bullets: [], tags: ["custom"], mainImageId: "asset-main", mediaAssetIds: ["asset-main"], variants: [{ skuId, skuCode: "CUSTOM-PINK", optionValues: { color: "pink" } }], attributes: {}, compliance: {} },
        validation: { completeness: 100, blockers: [], warnings: [] },
      });
      await tx.insert(designTasks).values({ id: designTaskId, tenantId: tenantA, skuId, title: "Order proof", brief: "Order proof", status: "approved", primaryVersionId: designVersionId, createdBy: userA });
      await tx.insert(designVersions).values({ id: designVersionId, tenantId: tenantA, taskId: designTaskId, versionNumber: 1, status: "approved", createdBy: userA, reviewedBy: userA, reviewedAt: new Date() });
    });
    const audit = new AuditService(database);
    orders = new OrderService(database, vault, audit);
    const storage = {
      promoteQuarantineToOrder: async (_context: TenantContext, input: { checksumSha256: string; fileName: string }) => ({
        checksumSha256: input.checksumSha256,
        deduplicated: false,
        objectKey: `tenants/${tenantA}/order/${input.checksumSha256}/${input.fileName}`,
      }),
    } as unknown as Storage;
    service = new OrderCustomizationService(database, vault, storage, orders, audit);
    const order = await orders.ingestNormalized(contextA, orderFixture(accountA));
    orderId = order.id; lineId = order.lines[0]!.id;
  });

  afterAll(async () => { await database.client.end(); });

  it("encrypts mapped values and blocks workflow until a quarantined file is scanned and promoted", async () => {
    const initialized = await service.initialize(contextA, orderId, { orderLineId: lineId, fulfillmentPath: "customer_approval_required", customerApprovalDueAt: "2099-07-25T12:00:00.000Z" });
    requirementId = initialized.id; customizationVersionId = initialized.versionId;
    expect(initialized).toMatchObject({ status: "quarantined", completeness: 100, mappedFieldKeys: ["name", "portrait"], fileFieldKeys: ["portrait"] });
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderCustomizationVersions).where(eq(orderCustomizationVersions.id, customizationVersionId)));
    expect(stored?.encryptedValues).not.toMatch(/Alex|provider-file/);
    expect(JSON.stringify(stored)).not.toMatch(/Alex|provider-file/);

    const awaitingCustomization = await orders.transition(contextA, orderId, { toState: "awaiting_customization", expectedSequence: 1, idempotencyKey: "customization-start" });
    await expect(orders.transition(contextA, orderId, { toState: "awaiting_design", expectedSequence: awaitingCustomization.latestEventSequence, idempotencyKey: "design-too-early" })).rejects.toBeInstanceOf(ConflictException);

    const checksum = "d".repeat(64);
    const intake = await service.registerFile(contextA, customizationVersionId, { fieldKey: "portrait", fileName: "Alex portrait.png", mediaType: "image/png", byteSize: 1024, checksumSha256: checksum, objectKey: `tenants/${tenantA}/quarantine/${checksum}/source.png` });
    expect(intake.safeFileName).toBe("portrait.png");
    await expect(service.promoteFile(contextA, intake.id)).rejects.toBeInstanceOf(ConflictException);
    await service.recordScan(contextA, intake.id, { result: "clean", engine: "clamav", signatureVersion: "20260722", scannedAt: "2026-07-22T12:00:00.000Z" });
    const promoted = await service.promoteFile(contextA, intake.id);
    expect(promoted).toMatchObject({ scanStatus: "promoted" });
    expect((await service.get(contextA, requirementId)).status).toBe("awaiting_design");
    const [asset] = await withTenant(database.db, contextA, (tx) => tx.select().from(assetFiles).where(eq(assetFiles.id, promoted.authorizedAssetId!)));
    expect(asset).toMatchObject({ assetDomain: "order", fileName: "portrait.png", rightsStatus: "approved" });

    const awaitingDesign = await orders.transition(contextA, orderId, { toState: "awaiting_design", expectedSequence: awaitingCustomization.latestEventSequence, idempotencyKey: "design-ready" });
    const proof = await service.createProof(contextA, orderId, requirementId, { customizationVersionId, designVersionId, dueAt: "2099-07-25T12:00:00.000Z" });
    expect((await service.get(contextA, requirementId)).status).toBe("awaiting_customer");
    const awaitingCustomer = await orders.transition(contextA, orderId, { toState: "awaiting_customer_approval", expectedSequence: awaitingDesign.latestEventSequence, idempotencyKey: "customer-proof-ready" });
    await expect(orders.transition(contextA, orderId, { toState: "awaiting_routing", expectedSequence: awaitingCustomer.latestEventSequence, idempotencyKey: "route-too-early" })).rejects.toBeInstanceOf(ConflictException);
    await service.recordDecision(contextA, orderId, proof.proof.id, { decision: "approved", externalDecisionId: "customer-decision-1" });
    const routed = await orders.transition(contextA, orderId, { toState: "awaiting_routing", expectedSequence: awaitingCustomer.latestEventSequence, idempotencyKey: "route-approved" });
    expect(routed.workflowState).toBe("awaiting_routing");
  });

  it("creates an identifier-only, idempotent personalization batch without exposing protected values", async () => {
    personalizationBatchJobs.length = 0;
    const batchOrder = await orders.ingestNormalized(contextA, orderFixture(accountA, "personalization-batch"));
    const batchOrderId = batchOrder.id;
    const batchLineId = batchOrder.lines[0]!.id;
    const batchRequirement = await service.initialize(contextA, batchOrderId, {
      orderLineId: batchLineId,
      fulfillmentPath: "template_ready",
    });
    const batchCustomizationVersionId = batchRequirement.versionId;
    await prepareRequiredFile(service, contextA, batchCustomizationVersionId, "f");
    const templateVersionId = createEntityId();
    const bindingId = createEntityId();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(personalizationTemplateVersions).values({
        id: templateVersionId,
        tenantId: tenantA,
        templateId: createEntityId(),
        versionNumber: 1,
        name: "Order portrait template",
        source: "blank",
        canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
        status: "approved",
        createdBy: userA,
      });
      await tx.insert(templateSlots).values({
        id: createEntityId(),
        tenantId: tenantA,
        templateVersionId,
        stableKey: "customer.photo",
        name: "Customer photo",
        kind: "image",
        geometry: { x: 0, y: 0, width: 3000, height: 3000, rotationDegrees: 0 },
        fillMode: "cover",
        validationSnapshot: { required: true },
        replaceable: true,
      });
      await tx.insert(skuTemplateBindings).values({
        id: bindingId,
        tenantId: tenantA,
        skuId,
        templateVersionId,
        sizeLabel: "default",
        mappingSnapshot: { slotFieldMap: { "customer.photo": "portrait" } },
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        createdBy: userA,
      });
    });
    const enqueuer: OrderPersonalizationBatchEnqueuer = {
      enqueue: async ({ batchId }) => { personalizationBatchJobs.push(batchId); },
    };
    const batches = new OrderPersonalizationBatchService(database, enqueuer, new AuditService(database));
    const options = await batches.options(contextA);
    expect(options.items.find((item) => item.orderLineId === batchLineId && item.bindingId === bindingId)).toMatchObject({
      externalOrderId: "custom-order-personalization-batch",
      skuCode: "CUSTOM-PINK",
      customizationVersionId: batchCustomizationVersionId,
      templateVersionId,
      eligible: true,
      blockers: [],
    });
    expect(JSON.stringify(options)).not.toMatch(/Alex|provider-file|encryptedValues/);
    expect((await batches.options(contextB)).items).toEqual([]);
    const idempotencyKey = createEntityId();
    const input = {
      idempotencyKey,
      items: [{
        orderId: batchOrderId,
        orderLineId: batchLineId,
        customizationVersionId: batchCustomizationVersionId,
        bindingId,
      }],
    };
    const created = await batches.create(contextA, input);
    const replayed = await batches.create(contextA, input);
    expect(replayed.id).toBe(created.id);
    expect(personalizationBatchJobs).toEqual([created.id]);
    expect(JSON.stringify(created)).not.toMatch(/Alex|provider-file|encryptedResolution/);
    expect(created).toMatchObject({ status: "queued", itemCount: 1, preparedCount: 0, failedCount: 0 });
    expect(created.items[0]).toMatchObject({
      orderLineId: batchLineId,
      customizationVersionId: batchCustomizationVersionId,
      bindingId,
      status: "queued",
    });
    await expect(batches.create(contextA, {
      idempotencyKey,
      items: [{
        orderId: batchOrderId,
        orderLineId: batchLineId,
        customizationVersionId: batchCustomizationVersionId,
        bindingId: createEntityId(),
      }],
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(batches.get(contextB, created.id)).rejects.toBeInstanceOf(NotFoundException);

    const [storedBatch] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderPersonalizationBatches)
      .where(eq(orderPersonalizationBatches.id, created.id)));
    const [storedItem] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderPersonalizationBatchItems)
      .where(eq(orderPersonalizationBatchItems.batchId, created.id)));
    expect(storedBatch?.requestChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(storedItem).toMatchObject({ encryptedResolution: null, resolutionChecksum: null });
    const resolution = vault.encrypt(JSON.stringify({
      version: 2,
      orderId: batchOrderId,
      orderLineId: batchLineId,
      customizationVersionId: batchCustomizationVersionId,
      templateVersionId,
      slots: [{
        slotId: createEntityId(),
        stableKey: "customer.name",
        kind: "text",
        value: "Private render value",
      }],
    }));
    const completedAt = new Date();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.update(orderPersonalizationBatchItems).set({
        status: "prepared",
        templateVersionId,
        encryptedResolution: resolution,
        resolutionChecksum: createHash("sha256").update(resolution).digest("hex"),
        resolvedSlotCount: 1,
        completedAt,
        updatedAt: completedAt,
      }).where(eq(orderPersonalizationBatchItems.id, storedItem!.id));
      await tx.update(orderPersonalizationBatches).set({
        status: "completed",
        preparedCount: 1,
        completedAt,
        updatedAt: completedAt,
      }).where(eq(orderPersonalizationBatches.id, created.id));
    });
    const renderJobs: string[] = [];
    const renderEnqueuer: OrderPersonalizationRenderEnqueuer = {
      enqueue: async ({ renderTaskId }) => { renderJobs.push(renderTaskId); },
    };
    vi.stubEnv("POD_ORDER_PROCESSOR_URL", "https://processor.example.test/render");
    vi.stubEnv("POD_ORDER_PROCESSOR_API_KEY", "test-order-key");
    vi.stubEnv("POD_ORDER_PROCESSOR_DEPLOYMENT_ID", "order-render-test");
    vi.stubEnv("POD_ORDER_ENABLED_TOOLS", "image_composite,group_photo,pet_outfit,vector_fulfillment");
    const renders = new OrderPersonalizationRenderService(database, renderEnqueuer, new AuditService(database));
    const renderInput = {
      idempotencyKey: createEntityId(),
      batchItemId: storedItem!.id,
      toolKey: "image_composite" as const,
      parameterSnapshot: {
        outputFormat: "png" as const,
        fitMode: "template" as const,
        autoComposition: "off" as const,
        allowAiEnhancement: false,
        identityMode: "standard" as const,
        customerAssetUsage: "mapped" as const,
        referenceIdentityTransfer: "not_applicable" as const,
      },
    };
    const render = await renders.create(contextA, renderInput);
    expect((await renders.create(contextA, renderInput)).id).toBe(render.id);
    expect(renderJobs).toEqual([render.id]);
    expect(JSON.stringify(render)).not.toMatch(/Private render value|encryptedResolution/);
    expect(render).toMatchObject({ batchItemId: storedItem!.id, status: "queued", toolKey: "image_composite" });
    const groupPhoto = await renders.create(contextA, {
      ...renderInput,
      idempotencyKey: createEntityId(),
      toolKey: "group_photo",
      parameterSnapshot: {
        ...renderInput.parameterSnapshot,
        autoComposition: "subject_focus",
        allowAiEnhancement: true,
        identityMode: "strict",
        customerAssetUsage: "all",
      },
    });
    const petOutfit = await renders.create(contextA, {
      ...renderInput,
      idempotencyKey: createEntityId(),
      toolKey: "pet_outfit",
      parameterSnapshot: {
        ...renderInput.parameterSnapshot,
        autoComposition: "balanced",
        allowAiEnhancement: true,
        identityMode: "strict",
        customerAssetUsage: "all",
        referenceIdentityTransfer: "forbid",
      },
    });
    const vector = await renders.create(contextA, {
      ...renderInput,
      idempotencyKey: createEntityId(),
      toolKey: "vector_fulfillment",
      parameterSnapshot: vectorParameters(),
    });
    expect(groupPhoto).toMatchObject({ toolKey: "group_photo", status: "queued" });
    expect(petOutfit).toMatchObject({ toolKey: "pet_outfit", status: "queued" });
    expect(vector).toMatchObject({ toolKey: "vector_fulfillment", status: "queued", parameterSnapshot: { outputFormat: "svg", textToPath: true } });
    expect(renderJobs).toEqual([render.id, groupPhoto.id, petOutfit.id, vector.id]);
    await expect(renders.get(contextB, render.id)).rejects.toBeInstanceOf(NotFoundException);
    const [storedRender] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderPersonalizationRenderTasks)
      .where(eq(orderPersonalizationRenderTasks.id, render.id)));
    expect(storedRender?.requestChecksum).toMatch(/^[a-f0-9]{64}$/);
    const vectorAssetId = createEntityId();
    const vectorVersionId = createEntityId();
    const vectorChecksum = "7".repeat(64);
    const vectorQuality = vectorQualitySnapshot();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(assetFiles).values({
        id: vectorAssetId,
        tenantId: tenantA,
        ownerUserId: userA,
        objectKey: `tenants/${tenantA}/order/${vectorChecksum}/${vector.id}-production.svg`,
        assetDomain: "order",
        fileName: `${vector.id}-production.svg`,
        mediaType: "image/svg+xml",
        byteSize: 512,
        checksumSha256: vectorChecksum,
        rightsStatus: "approved",
        rightsMetadata: {
          source: { kind: "customer_provided", reference: `order-customization:${batchCustomizationVersionId}` },
          orderPersonalizationRenderTaskId: vector.id,
          outputMetadata: { width: 300, height: 400, unit: "mm", colorMode: "spot", transparent: true, aiInference: "none" },
        },
      });
      await tx.insert(designVersions).values({
        id: vectorVersionId,
        tenantId: tenantA,
        taskId: vector.designTaskId,
        versionNumber: 1,
        status: "approved",
        changeNote: "Reviewed vector integration result",
        createdBy: userA,
      });
      await tx.insert(designVersionFiles).values({
        id: createEntityId(),
        tenantId: tenantA,
        versionId: vectorVersionId,
        assetFileId: vectorAssetId,
        role: "production",
      });
      await tx.update(orderPersonalizationRenderTasks).set({
        status: "awaiting_review",
        progressPercent: 100,
        resultVersionId: vectorVersionId,
        qualityCheckSnapshot: vectorQuality,
        completedAt,
        updatedAt: completedAt,
      }).where(eq(orderPersonalizationRenderTasks.id, vector.id));
    });
    const personalization = new PodPersonalizationService(database, { enqueue: async () => undefined }, new AuditService(database));
    const manifest = await personalization.createProductionManifest(contextA, {
      orderLineId: batchLineId,
      designVersionId: vectorVersionId,
      templateVersionId,
      inputSnapshot: [{ assetId: vectorAssetId, assetVersion: 1, checksumSha256: vectorChecksum }],
      files: [{
        assetId: vectorAssetId,
        assetVersion: 1,
        checksumSha256: vectorChecksum,
        fileName: `${vector.id}-production.svg`,
        mediaType: "image/svg+xml",
        width: 300,
        height: 400,
        unit: "mm",
        colorMode: "spot",
      }],
      qualityCheckSnapshot: { passed: true },
    });
    expect(manifest.qualityCheckSnapshot).toMatchObject({ exportReady: true, textConvertedToPaths: true, rasterImagesEmbedded: false });
    await expect(personalization.createProductionManifest(contextA, {
      orderLineId: batchLineId,
      designVersionId,
      inputSnapshot: [{ assetId: vectorAssetId, assetVersion: 1, checksumSha256: vectorChecksum }],
      files: manifest.files,
      qualityCheckSnapshot: { passed: true },
    })).rejects.toBeInstanceOf(ConflictException);
    vi.unstubAllEnvs();
    await expect(database.client.unsafe(
      "update order_personalization_batch_items set encrypted_resolution = 'mutated' where id = $1",
      [storedItem!.id],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("turns an expired proof into an exception and never implicit approval", async () => {
    const proof = await service.createProof(contextA, orderId, requirementId, { customizationVersionId, designVersionId, dueAt: "2026-07-21T12:00:00.000Z" });
    const expired = await service.expireProof(contextA, proof.proof.id, new Date("2026-07-22T12:00:00.000Z"));
    expect(expired.status).toBe("rejected");
    const exceptions = await withTenant(database.db, contextA, (tx) => tx.select().from(orderExceptions).where(eq(orderExceptions.orderId, orderId)));
    expect(exceptions.some((entry) => entry.category === "customer_timeout" && entry.code === "CUSTOMER_APPROVAL_TIMEOUT")).toBe(true);
    const order = await orders.get(contextA, orderId);
    await expect(orders.transition(contextA, orderId, { toState: "in_production", expectedSequence: order.latestEventSequence, idempotencyKey: "production-after-timeout" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("supports template-ready and designer-required proof paths without customer decisions", async () => {
    const templateOrder = await orders.ingestNormalized(contextA, orderFixture(accountA, "template"));
    const template = await service.initialize(contextA, templateOrder.id, { orderLineId: templateOrder.lines[0]!.id, fulfillmentPath: "template_ready" });
    await prepareRequiredFile(service, contextA, template.versionId, "a");
    expect((await service.get(contextA, template.id)).status).toBe("ready");
    await service.createProof(contextA, templateOrder.id, template.id, { customizationVersionId: template.versionId, designVersionId: null });
    expect((await service.get(contextA, template.id)).status).toBe("approved");

    const designerOrder = await orders.ingestNormalized(contextA, orderFixture(accountA, "designer"));
    const designer = await service.initialize(contextA, designerOrder.id, { orderLineId: designerOrder.lines[0]!.id, fulfillmentPath: "designer_required" });
    await prepareRequiredFile(service, contextA, designer.versionId, "b");
    expect((await service.get(contextA, designer.id)).status).toBe("awaiting_design");
    await expect(service.createProof(contextA, designerOrder.id, designer.id, { customizationVersionId: designer.versionId, designVersionId: null })).rejects.toBeInstanceOf(ConflictException);
    await service.createProof(contextA, designerOrder.id, designer.id, { customizationVersionId: designer.versionId, designVersionId });
    expect((await service.get(contextA, designer.id)).status).toBe("approved");
  });

  it("serializes conflicting customer decisions so one proof has one final outcome", async () => {
    const raceOrder = await orders.ingestNormalized(contextA, orderFixture(accountA, "decision-race"));
    const requirement = await service.initialize(contextA, raceOrder.id, {
      orderLineId: raceOrder.lines[0]!.id, fulfillmentPath: "customer_approval_required", customerApprovalDueAt: "2099-07-30T12:00:00.000Z",
    });
    await prepareRequiredFile(service, contextA, requirement.versionId, "c");
    const proof = await service.createProof(contextA, raceOrder.id, requirement.id, { customizationVersionId: requirement.versionId, designVersionId, dueAt: "2099-07-30T12:00:00.000Z" });
    const outcomes = await Promise.allSettled([
      service.recordDecision(contextA, raceOrder.id, proof.proof.id, { decision: "approved", externalDecisionId: "race-approved" }),
      service.recordDecision(contextA, raceOrder.id, proof.proof.id, { decision: "rejected", externalDecisionId: "race-rejected", reasonCode: "CUSTOMER_REQUESTED_CHANGE" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const decisions = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProofDecisions).where(eq(orderProofDecisions.proofVersionId, proof.proof.id)));
    expect(decisions).toHaveLength(1);
  });

  it("keeps unsupported files quarantined with immutable policy evidence", async () => {
    const unsupportedOrder = await orders.ingestNormalized(contextA, orderFixture(accountA, "unsupported"));
    const requirement = await service.initialize(contextA, unsupportedOrder.id, { orderLineId: unsupportedOrder.lines[0]!.id, fulfillmentPath: "designer_required" });
    const checksum = "e".repeat(64);
    const intake = await service.registerFile(contextA, requirement.versionId, { fieldKey: "portrait", fileName: "payload.svg", mediaType: "image/svg+xml", byteSize: 512, checksumSha256: checksum, objectKey: `tenants/${tenantA}/quarantine/${checksum}/source.svg` });
    expect(intake.scanStatus).toBe("unsupported");
    expect((await service.get(contextA, requirement.id)).status).toBe("quarantined");
    const evidence = await withTenant(database.db, contextA, (tx) => tx.select().from(orderCustomizationFileScanEvents).where(eq(orderCustomizationFileScanEvents.intakeId, intake.id)));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ result: "unsupported", engine: "schema-policy" });
    await expect(service.promoteFile(contextA, intake.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("keeps customization and file evidence tenant isolated", async () => {
    await expect(service.get(contextB, requirementId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, contextB, (tx) => tx.select().from(orderCustomizationFileIntakes))).toEqual([]);
  });

  it("appends a remapped version after a protected provider update and rejects stale writers", async () => {
    const update = orderFixture(accountA);
    update.externalEventId = "custom-event-2";
    update.providerStatus = "paid-updated";
    update.protectedDetails!.customizations[0]!.values[0] = { key: "name", label: "Name", type: "text", value: "Jordan" };
    await orders.ingestNormalized(contextA, update);

    const remapped = await service.remap(contextA, orderId, requirementId, { expectedVersionNumber: 1 });
    expect(remapped).toMatchObject({ versionNumber: 2, completeness: 100, status: "quarantined" });
    expect((await service.list(contextA, orderId)).map((entry) => entry.versionNumber)).toEqual([2]);
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderCustomizationVersions).where(eq(orderCustomizationVersions.id, remapped.versionId)));
    expect(stored?.encryptedValues).not.toContain("Jordan");
    const [protectedRow] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)));
    expect(protectedRow?.envelopeVersion).toBe(2);
    await expect(service.remap(contextA, orderId, requirementId, { expectedVersionNumber: 1 })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.get(contextB, requirementId)).rejects.toBeInstanceOf(NotFoundException);
  });
});

function vectorParameters() {
  return {
    outputFormat: "svg" as const,
    fitMode: "template" as const,
    autoComposition: "off" as const,
    allowAiEnhancement: false,
    identityMode: "standard" as const,
    customerAssetUsage: "mapped" as const,
    referenceIdentityTransfer: "not_applicable" as const,
    colorMode: "spot" as const,
    transparent: true,
    vectorTemplateProfile: "laser-cut-v1",
    vectorWidth: 300,
    vectorHeight: 400,
    vectorUnit: "mm" as const,
    vectorLayoutMode: "template" as const,
    textToPath: true,
    hollowMode: true,
    bridgeWidthMm: 1.5,
    minimumLineWidthMm: 0.3,
    pathRepair: "safe" as const,
  };
}

function vectorQualitySnapshot() {
  return {
    passed: true,
    exportReady: true,
    templateProfileMatched: true,
    canvasMatched: true,
    textConvertedToPaths: true,
    authorizedFontsOnly: true,
    pathsClosed: true,
    selfIntersectionsDetected: false,
    duplicatePathsDetected: false,
    isolatedNodesDetected: false,
    holeDirectionsValid: true,
    minimumLineWidthPassed: true,
    minimumBridgeWidthPassed: true,
    outOfBoundsDetected: false,
    rasterImagesEmbedded: false,
    repairs: ["close_path"],
    outputChecks: [{
      fileName: "production.svg",
      usedInputStableKeys: ["customer.name"],
      width: 300,
      height: 400,
      unit: "mm",
      viewBox: "0 0 300 400",
      pathCount: 12,
      minimumLineWidthMm: 0.3,
      minimumBridgeWidthMm: 1.5,
    }],
  };
}

function customizationSchema(): CustomizationDefinition {
  return { version: 4, fields: [
    { key: "name", label: "Name", type: "short_text", required: true, validation: { maxLength: 100 } },
    { key: "portrait", label: "Portrait", type: "image", required: true, validation: { allowedMediaTypes: ["image/png", "image/jpeg"], maxFiles: 1, maxBytes: 5_000_000 } },
  ] };
}

async function prepareRequiredFile(service: OrderCustomizationService, context: TenantContext, versionId: string, checksumCharacter: string) {
  const checksum = checksumCharacter.repeat(64);
  const intake = await service.registerFile(context, versionId, {
    fieldKey: "portrait", fileName: "portrait.png", mediaType: "image/png", byteSize: 1024,
    checksumSha256: checksum, objectKey: `tenants/${context.tenantId}/quarantine/${checksum}/source.png`,
  });
  await service.recordScan(context, intake.id, { result: "clean", engine: "clamav", signatureVersion: "20260722", scannedAt: "2026-07-22T12:00:00.000Z" });
  await service.promoteFile(context, intake.id);
}

function orderFixture(accountId: string, suffix = "1"): NormalizeOrderInput {
  return {
    accountId, platform: "etsy", externalEventId: `custom-event-${suffix}`, externalOrderId: `custom-order-${suffix}`, providerStatus: "paid",
    placedAt: "2026-07-22T10:00:00.000Z", orderTotal: { amountMinor: 2500, currency: "USD" },
    lines: [{ externalLineId: "custom-line-1", externalListingId: null, skuCode: "CUSTOM-PINK", title: "Custom product", quantity: 1, unitPrice: { amountMinor: 2500, currency: "USD" }, customizationCount: 2 }],
    redactedSource: { receiptId: `custom-order-${suffix}` },
    protectedDetails: {
      buyer: { name: null, email: null, phone: null },
      shippingAddress: { recipient: null, lines: ["Fulfillment Street"], city: "Seattle", region: "WA", postalCode: "98101", countryCode: "US" },
      customizations: [{ externalLineId: "custom-line-1", values: [
        { key: "name", label: "Name", type: "text", value: "Alex" },
        { key: "portrait", label: "Portrait", type: "file_reference", externalReference: "provider-file-1" },
      ] }],
    },
  };
}
