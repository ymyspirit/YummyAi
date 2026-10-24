import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  captureCreativeExecutionAuthority,
  creativeExecutions,
  creativeExecutionChecksum,
  canvasPrintSpecVersions,
  connectDatabase,
  creativeDesignBatchItems,
  creativeDesignBatches,
  creativeDesignCandidates,
  creativeDesignSkuBindings,
  creativeDesignVersionAssets,
  creativeDesignVersions,
  designTasks,
  designVersions,
  listingArtifactBindings,
  listings,
  listingVersions,
  migrateDatabase,
  mockupBatchItems,
  mockupBatchOutputs,
  mockupBatches,
  mockupTemplatePackVersions,
  mockupTemplateSlots,
  mockupTemplateSourceInspections,
  skus,
  withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodGovernanceService } from "./pod-governance.service.js";
import { CreativeExecutionOperatorService } from "./creative-execution-operator.service.js";
import { creativeHarness, selectCreativeMethod } from "@yummyai/pod-core";
import type { CreativeExecutionKind } from "@yummyai/contracts/harness";

describe("controlled creative-to-design promotion", () => {
  const database = connectDatabase();
  const userId = createEntityId();
  const context: TenantContext = {
    tenantId: createEntityId(),
    userId,
    permissions: [Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview, Permission.AssetRead, Permission.ProductRead, Permission.ListingRead, Permission.ListingWrite],
    dataScope: "tenant",
  };
  const catalog = new ProductService(new DrizzleCatalogRepository(database));
  const storage = {} as Storage;
  const designs = new DesignService(new DrizzleDesignRepository(database, storage));
  const governance = new PodGovernanceService(database, new AuditService(database));
  const operator = new CreativeExecutionOperatorService(database);
  async function syntheticReadRecord(kind: CreativeExecutionKind, id: string, stepKey: string) {
    return withTenant(database.db, context, async tx => {
      const effect = kind === "creative_candidate" ? "external_request" : "internal_write";
      const captured = await captureCreativeExecutionAuthority(tx, context, creativeHarness(kind, effect).requiredPermissions);
      const method = await selectCreativeMethod(tx, captured.authority, kind, effect);
      const [row] = await tx.insert(creativeExecutions).values({
        id: createEntityId(), tenantId: context.tenantId, requestedBy: userId, kind, stepKey, effect,
        candidateId: kind === "creative_candidate" ? id : null, creativeVersionId: kind === "creative_adaptation" ? id : null,
        inspectionId: kind === "template_compile" ? id : null, mockupItemId: kind === "mockup_render" ? id : null,
        authoritySnapshot: captured.snapshot, authorityChecksum: captured.checksum, ...method,
        inputFingerprint: creativeExecutionChecksum({ kind, id, purpose: "synthetic read policy fixture; never executed" }),
      }).returning();
      return row!;
    });
  }
  const specId = createEntityId();
  const creativeVersionId = createEntityId();
  let compatibleSkuId: string;
  let secondSkuId: string;
  let spuId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations (id, name, slug) values ($1, 'Canvas Promotion', $2)", [context.tenantId, `canvas-promotion-${context.tenantId}`]);
    await database.client.unsafe(
      "insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Canvas Reviewer')",
      [userId, `canvas-promotion-${userId}`, `${userId}@example.test`],
    );
    const catalogCreator = { ...context, permissions: [...context.permissions, Permission.ProductWrite] };
    const plan = await catalog.createPlan(catalogCreator, { name: "Canvas promotion plan", sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await catalog.transition(catalogCreator, plan.id, "pending_approval");
    await catalog.transition(catalogCreator, plan.id, "approved");
    const spu = await catalog.createSpu(catalogCreator, plan.id, { code: "CANVAS-PROMO-SPU", name: "Canvas promotion" });
    spuId = spu.id;
    compatibleSkuId = (await catalog.createSku(catalogCreator, { spuId, code: "CANVAS-4X3-A", attributes: { canvas_aspect_ratio: "4:3" } })).id;
    secondSkuId = (await catalog.createSku(catalogCreator, { spuId, code: "CANVAS-SECOND", attributes: { canvas_aspect_ratio: "1:1" } })).id;

    const assetId = createEntityId();
    const batchId = createEntityId();
    const itemId = createEntityId();
    const candidateId = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(canvasPrintSpecVersions).values({
        id: specId, tenantId: context.tenantId, specId: createEntityId(), versionNumber: 1,
        name: "Canvas 4:3", aspectWidth: 4, aspectHeight: 3, targetDpi: 300,
        bleedMm: "30", safeZoneMm: "15", wrapMode: "extend",
        physicalSizes: [{ key: "400x300", label: "400 × 300 mm", widthMm: 400, heightMm: 300 }],
        status: "approved", createdBy: userId, reviewedBy: userId, reviewedAt: new Date(),
      });
      await tx.insert(assetFiles).values({
        id: assetId, tenantId: context.tenantId, objectKey: `authorized/${assetId}`,
        assetDomain: "authorized", fileName: "canvas-4x3.png", mediaType: "image/png", byteSize: 1024,
        checksumSha256: "a".repeat(64), rightsStatus: "approved",
        rightsMetadata: { source: { kind: "ai_generated", reference: candidateId }, approvedAt: new Date().toISOString(), approvedBy: userId }, aiGenerated: true,
      });
      await tx.insert(creativeDesignBatches).values({
        id: batchId, tenantId: context.tenantId, name: "Promotion source", itemCount: 1,
        generatedCount: 1, approvedCount: 1, status: "completed", requestChecksum: "b".repeat(64), createdBy: userId,
      });
      await tx.insert(creativeDesignBatchItems).values({
        id: itemId, tenantId: context.tenantId, batchId, ordinal: 0, rowKey: "row-1", name: "Promotion source",
        prompt: "Original canvas landscape", candidateCount: 2, printSpecVersionIds: [specId],
        focalPoint: { xPermille: 500, yPermille: 500 }, status: "completed",
      });
      await tx.insert(creativeDesignCandidates).values({
        id: candidateId, tenantId: context.tenantId, itemId, ordinal: 0, status: "selected",
        assetId, assetVersion: 1, checksumSha256: "a".repeat(64), promptTemplateVersion: "canvas-v1",
        parameterSnapshot: {}, inputChecksum: "c".repeat(64), completedAt: new Date(),
      });
      await tx.insert(creativeDesignVersions).values({
        id: creativeVersionId, tenantId: context.tenantId, familyId: createEntityId(), versionNumber: 1,
        sourceCandidateId: candidateId, name: "Reviewed 4:3 landscape", status: "approved",
        createdBy: userId, reviewedBy: userId, reviewedAt: new Date(),
      });
      await tx.insert(creativeDesignVersionAssets).values({
        id: createEntityId(), tenantId: context.tenantId, creativeDesignVersionId: creativeVersionId, assetId, assetVersion: 1,
        role: "aspect_variant", printSpecVersionId: specId, adaptationMode: "crop", generatedRegions: [],
      });
    });
  });

  afterAll(async () => database.client.end());

  it("validates every requested SKU before creating any formal design record", async () => {
    await expect(designs.promoteApprovedCreativeBindings(context, creativeVersionId, { bindings: [
      { skuId: compatibleSkuId, printSpecVersionId: specId },
      { skuId: secondSkuId, printSpecVersionId: specId },
    ] })).rejects.toThrow(/missing compatible/);

    const tasks = await withTenant(database.db, context, (tx) => tx.select().from(designTasks));
    expect(tasks).toEqual([]);
  });

  it("atomically creates approved formal versions and preserves the creative approval chain", async () => {
    await withTenant(database.db, context, (tx) => tx.update(skus).set({ attributes: { canvas_print_spec_version_id: specId } }).where(eq(skus.id, secondSkuId)));
    const promoted = await designs.promoteApprovedCreativeBindings(context, creativeVersionId, { bindings: [
      { skuId: compatibleSkuId, printSpecVersionId: specId },
      { skuId: secondSkuId, printSpecVersionId: specId },
    ] });

    expect(promoted).toHaveLength(2);
    const [tasks, versions, bindings] = await withTenant(database.db, context, async (tx) => Promise.all([
      tx.select().from(designTasks),
      tx.select().from(designVersions),
      tx.select().from(creativeDesignSkuBindings),
    ]));
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.status === "approved" && task.primaryVersionId)).toBe(true);
    expect(versions).toHaveLength(2);
    expect(versions.every((version) => version.status === "approved" && version.reviewedBy === userId)).toBe(true);
    expect(bindings.map((binding) => binding.creativeDesignVersionId)).toEqual([creativeVersionId, creativeVersionId]);
  });

  it("binds reviewed mockups only when every required template slot is present", async () => {
    const [formal] = await withTenant(database.db, context, (tx) => tx.select().from(creativeDesignSkuBindings)
      .where(eq(creativeDesignSkuBindings.skuId, compatibleSkuId)).limit(1));
    expect(formal).toBeDefined();

    const sourceAssetId = createEntityId();
    const firstOutputAssetId = createEntityId();
    const secondOutputAssetId = createEntityId();
    const inspectionId = createEntityId();
    const detailInspectionId = createEntityId();
    const packVersionId = createEntityId();
    const firstSlotId = createEntityId();
    const secondSlotId = createEntityId();
    const batchId = createEntityId();
    const itemId = createEntityId();
    const firstOutputId = createEntityId();
    const secondOutputId = createEntityId();
    const listingId = createEntityId();
    const listingVersionId = createEntityId();
    const now = new Date();

    await withTenant(database.db, context, async (tx) => {
      await tx.insert(assetFiles).values([
        {
          id: sourceAssetId, tenantId: context.tenantId, objectKey: `authorized/${sourceAssetId}`,
          assetDomain: "authorized", fileName: "controlled.psd", mediaType: "image/vnd.adobe.photoshop",
          byteSize: 2048, checksumSha256: "d".repeat(64), rightsStatus: "approved",
        },
        ...[
          [firstOutputAssetId, "hero.png", "e"],
          [secondOutputAssetId, "detail.png", "f"],
        ].map(([id, fileName, checksum]) => ({
          id: id!, tenantId: context.tenantId, objectKey: `authorized/${id}`,
          assetDomain: "authorized" as const, fileName: fileName!, mediaType: "image/png", byteSize: 1024,
          checksumSha256: checksum!.repeat(64), rightsStatus: "approved" as const,
        })),
      ]);
      await tx.insert(mockupTemplateSourceInspections).values({
        id: inspectionId, tenantId: context.tenantId, sourceAssetId, sourceAssetVersion: 1,
        checksumSha256: "d".repeat(64), slotKey: "hero", status: "completed", compilerVersion: "controlled-psd-v1",
        compilation: {
          canvasWidth: 1200, canvasHeight: 900, slotKey: "hero", transform: [0, 0, 1200, 0, 1200, 900, 0, 900],
          backgroundAssetId: firstOutputAssetId, foregroundAssetId: firstOutputAssetId,
          previewAssetId: firstOutputAssetId, manifestAssetId: firstOutputAssetId,
          checksumSha256: "e".repeat(64), ssimPermille: 1000, compilerVersion: "controlled-psd-v1",
        },
        requestedBy: userId, confirmedBy: userId, completedAt: now, confirmedAt: now,
      });
      const [originalInspection] = await tx.select().from(mockupTemplateSourceInspections).where(eq(mockupTemplateSourceInspections.id, inspectionId));
      await tx.insert(mockupTemplateSourceInspections).values({ ...originalInspection!, id: detailInspectionId, slotKey: "detail",
        compilation: { ...originalInspection!.compilation!, slotKey: "detail" } });
      await tx.insert(mockupTemplatePackVersions).values({
        id: packVersionId, tenantId: context.tenantId, packId: createEntityId(), versionNumber: 1,
        name: "Amazon canvas pair", platform: "amazon", locale: "en-US", status: "approved",
        createdBy: userId, reviewedBy: userId, reviewedAt: now,
      });
      await tx.insert(mockupTemplateSlots).values([
        { id: firstSlotId, tenantId: context.tenantId, templatePackVersionId: packVersionId, inspectionId, slotKey: "hero", label: "Hero", ordinal: 0, required: true, acceptedPrintSpecVersionIds: [specId] },
        { id: secondSlotId, tenantId: context.tenantId, templatePackVersionId: packVersionId, inspectionId: detailInspectionId, slotKey: "detail", label: "Detail", ordinal: 1, required: true, acceptedPrintSpecVersionIds: [specId] },
      ]);
      await tx.insert(mockupBatches).values({
        id: batchId, tenantId: context.tenantId, name: "Reviewed mockups", templatePackVersionId: packVersionId,
        platform: "amazon", locale: "en-US", status: "completed", itemCount: 1, completedCount: 1,
        requestChecksum: "1".repeat(64), createdBy: userId, completedAt: now,
      });
      await tx.insert(mockupBatchItems).values({
        id: itemId, tenantId: context.tenantId, batchId, ordinal: 0, designVersionId: formal!.designVersionId,
        skuId: compatibleSkuId, status: "completed", reviewedBy: userId, reviewedAt: now, completedAt: now,
      });
      await tx.insert(mockupBatchOutputs).values([
        { id: firstOutputId, tenantId: context.tenantId, itemId, templateSlotId: firstSlotId, slotKey: "hero", status: "approved", assetId: firstOutputAssetId, assetVersion: 1, checksumSha256: "e".repeat(64), width: 1200, height: 900, completedAt: now },
        { id: secondOutputId, tenantId: context.tenantId, itemId, templateSlotId: secondSlotId, slotKey: "detail", status: "approved", assetId: secondOutputAssetId, assetVersion: 1, checksumSha256: "f".repeat(64), width: 1200, height: 900, completedAt: now },
      ]);
      await tx.insert(listings).values({
        id: listingId, tenantId: context.tenantId, spuId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER",
        locale: "en-US", status: "draft", createdBy: userId,
      });
      await tx.insert(listingVersions).values({
        id: listingVersionId, tenantId: context.tenantId, listingId, versionNumber: 1, ruleVersion: "amazon-2026.08",
        status: "draft", source: "human", createdBy: userId,
        content: { platform: "amazon", locale: "en-US", title: "Canvas listing", description: "Reviewed mockup slots", bullets: [], tags: [], mediaAssetIds: [], variants: [{ skuId: compatibleSkuId, skuCode: "CANVAS-4X3-A", optionValues: {} }], attributes: {}, compliance: {} },
        validation: { completeness: 80, blockers: [], warnings: [] },
      });
    });

    await expect(governance.createApprovedMockupListingBindings(context, {
      batchId, itemId, listingVersionId, slots: [{ outputId: firstOutputId, slotKey: "gallery.1" }],
    })).rejects.toThrow(/required mockup slots/i);
    expect(await withTenant(database.db, context, (tx) => tx.select().from(listingArtifactBindings)
      .where(eq(listingArtifactBindings.listingVersionId, listingVersionId)))).toHaveLength(0);

    await expect(governance.createListingArtifactBinding(context, {
      listingVersionId, assetId: firstOutputAssetId, assetVersion: 1, contentKind: "image", slotKey: "gallery.hero",
    })).rejects.toThrow(/整款审核与槽位映射/);
    await expect(governance.createApprovedMockupListingBindings(context, {
      batchId, itemId, listingVersionId,
      slots: [
        { outputId: firstOutputId, slotKey: "gallery.1" },
        { outputId: secondOutputId, slotKey: "gallery.2" },
      ],
    })).rejects.toMatchObject({ status: 409 });
    expect(await withTenant(database.db, context, tx => tx.select().from(listingArtifactBindings)
      .where(eq(listingArtifactBindings.listingVersionId, listingVersionId)))).toEqual([]);
    const inspectionExecution = await syntheticReadRecord("template_compile", inspectionId, "compile");
    const mockupExecution = await syntheticReadRecord("mockup_render", itemId, `slot:${firstSlotId}`);
    expect((await operator.history(context, "inspection", inspectionId)).entries.map(row => row.id)).toEqual([inspectionExecution.id]);
    expect((await operator.history(context, "mockup_batch", batchId)).entries.map(row => row.id)).toEqual([mockupExecution.id]);
    const selfOnly = { ...context, userId: createEntityId(), dataScope: "self" as const };
    await expect(operator.history(selfOnly, "inspection", inspectionId)).rejects.toMatchObject({ status: 403 });
    await expect(operator.history(selfOnly, "mockup_batch", batchId)).rejects.toMatchObject({ status: 403 });
  });

  it("reads candidate and adaptation history by their actual batch while preserving archived evidence", async () => {
    const [source] = await withTenant(database.db, context, tx => tx.select({ candidateId: creativeDesignVersions.sourceCandidateId,
      batchId: creativeDesignBatchItems.batchId }).from(creativeDesignVersions)
      .innerJoin(creativeDesignCandidates, eq(creativeDesignCandidates.id, creativeDesignVersions.sourceCandidateId))
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId)).where(eq(creativeDesignVersions.id, creativeVersionId)));
    expect((await operator.history(context, "design_batch", source!.batchId)).entries).toEqual([]);
    const first = await syntheticReadRecord("creative_candidate", source!.candidateId, "generate");
    const second = await syntheticReadRecord("creative_adaptation", creativeVersionId, `spec:${specId}`);
    const history = await operator.history(context, "design_batch", source!.batchId);
    expect(new Set(history.entries.map(row => row.id))).toEqual(new Set([first.id, second.id]));
    const collaborator = createEntityId(), privateVersion = createEntityId(), privateCandidate = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic collaborator')", [collaborator, `operator-${collaborator}`, `${collaborator}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const [original] = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, source!.candidateId));
      await tx.insert(creativeDesignCandidates).values({ ...original!, id: privateCandidate, ordinal: 1 });
      await tx.insert(creativeDesignVersions).values({ id: privateVersion, tenantId: context.tenantId,
        familyId: createEntityId(), versionNumber: 1, sourceCandidateId: privateCandidate, name: "Synthetic collaborator version", status: "adapting", createdBy: collaborator });
    });
    const hidden = await syntheticReadRecord("creative_adaptation", privateVersion, `spec:${specId}`);
    const self = { ...context, dataScope: "self" as const };
    expect(new Set((await operator.history(self, "design_batch", source!.batchId)).entries.map(row => row.id))).toEqual(new Set([first.id, second.id]));
    await expect(operator.act(self, hidden.id, { action: "record_check", commandId: "5788284c-9d7c-4c3c-9bb7-b4e66976a206", expectedFingerprint: "a".repeat(64),
      finding: "needs_owner_review", proofChecksum: "b".repeat(64), matchesOriginalRequest: true })).rejects.toMatchObject({ status: 403 });
    await withTenant(database.db, context, tx => tx.update(creativeDesignBatches).set({ archivedAt: new Date() }).where(eq(creativeDesignBatches.id, source!.batchId)));
    expect((await operator.history(context, "design_batch", source!.batchId)).entries).toHaveLength(3);
    await expect(operator.history({ ...context, userId: createEntityId(), dataScope: "self" }, "design_batch", source!.batchId)).rejects.toMatchObject({ status: 403 });
  });
});
