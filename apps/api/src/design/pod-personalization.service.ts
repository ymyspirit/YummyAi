import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  ConfirmTemplateSourceInspectionInputSchema,
  ClonePersonalizationTemplateInputSchema,
  CreatePersonalizationTemplateVersionInputSchema,
  CreateProductionManifestInputSchema,
  CreateSkuTemplateBindingInputSchema,
  CreateTemplateSourceInspectionInputSchema,
  PersonalizationTemplateSourceInspectionListSchema,
  PersonalizationTemplateSourceInspectionSchema,
  PersonalizationTemplateVersionListSchema,
  PersonalizationTemplateVersionSchema,
  PodPersonalizationOptionsViewSchema,
  PodReviewDecisionInputSchema,
  ProductionManifestListSchema,
  ProductionManifestSchema,
  SkuTemplateBindingSchema,
  TEMPLATE_SOURCE_PARSER,
  VectorFulfillmentQualityCheckSnapshotSchema,
  createEntityId,
  type ConfirmTemplateSourceInspectionInput,
  type ClonePersonalizationTemplateInput,
  type CreatePersonalizationTemplateVersionInput,
  type CreateProductionManifestInput,
  type CreateSkuTemplateBindingInput,
  type CreateTemplateSourceInspectionInput,
  type PodReviewDecisionInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  designVersionFiles,
  designVersions,
  orderCustomizationRequirements,
  orderCustomizationVersions,
  orderLines,
  orderPersonalizationRenderTasks,
  personalizationTemplateSourceInspections,
  personalizationTemplateVersions,
  productPlans,
  productionManifests,
  skuTemplateBindings,
  skus,
  spus,
  templateSlots,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PERSONALIZATION_TEMPLATE_SOURCE_INSPECTION_ENQUEUER } from "../platform.tokens.js";

export interface PersonalizationTemplateSourceInspectionEnqueuer {
  enqueue(input: { inspectionId: string; tenantId: string; requestedBy: string; maxAttempts: number }): Promise<void>;
}

@Injectable()
export class PodPersonalizationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PERSONALIZATION_TEMPLATE_SOURCE_INSPECTION_ENQUEUER)
    private readonly inspectionEnqueuer: PersonalizationTemplateSourceInspectionEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createTemplateSourceInspection(context: TenantContext, rawInput: CreateTemplateSourceInspectionInput) {
    const input = CreateTemplateSourceInspectionInputSchema.parse(rawInput);
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      const [replayed] = await tx.select({ id: personalizationTemplateSourceInspections.id })
        .from(personalizationTemplateSourceInspections)
        .where(eq(personalizationTemplateSourceInspections.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return { id: replayed.id, replayed: true };
      const asset = await requireAuthorizedAsset(tx, input.sourceAssetId, input.sourceAssetVersion);
      const source = templateSourceKind(asset.mediaType, asset.fileName);
      if (!source) throw new BadRequestException("Template source inspection only supports PNG or PSD assets");
      const rightsSourceKind = (asset.rightsMetadata as { source?: { kind?: string } }).source?.kind;
      const id = createEntityId();
      await tx.insert(personalizationTemplateSourceInspections).values({
        id,
        tenantId: context.tenantId,
        sourceAssetId: asset.id,
        sourceAssetVersion: asset.version,
        checksumSha256: asset.checksumSha256,
        source,
        assetDomain: asset.assetDomain,
        rightsStatus: asset.rightsStatus,
        rightsSourceKind,
        idempotencyKey: input.idempotencyKey,
        parserKey: TEMPLATE_SOURCE_PARSER.key,
        parserVersion: TEMPLATE_SOURCE_PARSER.version,
        requestedBy: context.userId,
      });
      return { id, replayed: false };
    });
    if (!prepared.replayed) {
      try {
        await this.inspectionEnqueuer.enqueue({
          inspectionId: prepared.id,
          tenantId: context.tenantId,
          requestedBy: context.userId,
          maxAttempts: 3,
        });
      } catch {
        await withTenant(this.database.db, context, (tx) => tx.update(personalizationTemplateSourceInspections).set({
          status: "failed",
          errorCode: "QUEUE_UNAVAILABLE",
          errorMessage: "Template source inspection queue is unavailable",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(personalizationTemplateSourceInspections.id, prepared.id)));
        throw new ServiceUnavailableException("Template source inspection queue is unavailable");
      }
      await this.record(context, "pod.personalization_template_source_inspection.create", "personalization_template_source_inspection", prepared.id, {
        sourceAssetId: input.sourceAssetId,
        sourceAssetVersion: input.sourceAssetVersion,
      });
    }
    return this.getTemplateSourceInspection(context, prepared.id);
  }

  async listTemplateSourceInspections(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select()
      .from(personalizationTemplateSourceInspections)
      .orderBy(desc(personalizationTemplateSourceInspections.createdAt)).limit(100));
    return PersonalizationTemplateSourceInspectionListSchema.parse({ items: rows.map(mapTemplateSourceInspection) });
  }

  async getTemplateSourceInspection(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select()
      .from(personalizationTemplateSourceInspections)
      .where(eq(personalizationTemplateSourceInspections.id, id)).limit(1));
    if (!row) throw new NotFoundException("Template source inspection not found");
    return mapTemplateSourceInspection(row);
  }

  async confirmTemplateSourceInspection(
    context: TenantContext,
    inspectionId: string,
    rawInput: ConfirmTemplateSourceInspectionInput,
  ) {
    const input = ConfirmTemplateSourceInspectionInputSchema.parse(rawInput);
    const inspection = await this.getTemplateSourceInspection(context, inspectionId);
    if (inspection.status !== "completed" || !inspection.canvas) {
      throw new ConflictException("Only a completed template source inspection can be confirmed");
    }
    if (inspection.warnings.length && !input.acknowledgeWarnings) {
      throw new ConflictException("Template source inspection warnings must be explicitly acknowledged");
    }
    const detectedByKey = new Map(inspection.slots.map((slot) => [slot.stableKey, slot]));
    const slots = input.slots.map((slot) => {
      const detected = detectedByKey.get(slot.stableKey);
      if (!detected) throw new BadRequestException(`Confirmed slot ${slot.stableKey} was not detected by the source inspection`);
      return {
        ...slot,
        psdGroup: inspection.source === "psd" ? slot.kind : undefined,
        geometry: detected.geometry,
        validationSnapshot: {
          ...detected.validationSnapshot,
          sourceInspectionId: inspection.id,
          sourceLayerPath: detected.sourceLayerPath,
          confidencePermille: detected.confidencePermille,
          classificationConfirmed: true,
        },
      };
    });
    const template = await this.createTemplate(context, {
      templateId: input.templateId,
      name: input.name,
      source: inspection.source,
      sourceAssetId: inspection.sourceAssetId,
      sourceAssetVersion: inspection.sourceAssetVersion,
      sourceInspectionId: inspection.id,
      canvas: inspection.canvas,
      slots,
    });
    await this.record(context, "pod.personalization_template_source_inspection.confirm", "personalization_template_source_inspection", inspection.id, {
      templateVersionId: template.id,
      slotCount: slots.length,
    });
    return template;
  }

  async createTemplate(context: TenantContext, rawInput: CreatePersonalizationTemplateVersionInput) {
    const input = CreatePersonalizationTemplateVersionInputSchema.parse(rawInput);
    const templateId = input.templateId ?? createEntityId();
    const versionId = createEntityId();
    const duplicateNames = new Set(input.slots.filter((slot, index, slots) => slots.some(
      (candidate, candidateIndex) => candidateIndex !== index && candidate.kind === slot.kind && candidate.name === slot.name,
    )).map((slot) => `${slot.kind}:${slot.name}`));
    const normalizedSlots = input.slots.map((slot) => ({
      ...slot,
      reuseLabel: slot.reuseLabel ?? (duplicateNames.has(`${slot.kind}:${slot.name}`) ? `same-name:${slot.name}`.slice(0, 120) : undefined),
    }));
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pod-template:${templateId}`}, 0))`);
      const [latest] = await tx.select().from(personalizationTemplateVersions)
        .where(eq(personalizationTemplateVersions.templateId, templateId))
        .orderBy(desc(personalizationTemplateVersions.versionNumber)).limit(1);
      if (input.templateId && !latest) throw new NotFoundException("Personalization template not found");

      if (input.sourceTemplateVersionId) {
        const [sourceTemplate] = await tx.select({ status: personalizationTemplateVersions.status })
          .from(personalizationTemplateVersions)
          .where(eq(personalizationTemplateVersions.id, input.sourceTemplateVersionId)).limit(1);
        if (!sourceTemplate || sourceTemplate.status !== "approved") {
          throw new ConflictException("Copied templates require an approved tenant-local source version");
        }
      }

      if (input.sourceAssetId) {
        const source = await requireAuthorizedAsset(tx, input.sourceAssetId, input.sourceAssetVersion);
        if (input.source === "psd" && !isPsd(source.mediaType, source.fileName)) {
          throw new BadRequestException("PSD templates require an approved PSD source asset");
        }
      }
      if (input.sourceInspectionId) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pod-template-source-inspection:${input.sourceInspectionId}`}, 0))`);
        const [existing] = await tx.select({ id: personalizationTemplateVersions.id }).from(personalizationTemplateVersions)
          .where(eq(personalizationTemplateVersions.sourceInspectionId, input.sourceInspectionId)).limit(1);
        if (existing) throw new ConflictException("Template source inspection has already created an immutable template version");
        const [inspection] = await tx.select().from(personalizationTemplateSourceInspections)
          .where(eq(personalizationTemplateSourceInspections.id, input.sourceInspectionId)).limit(1);
        assertTemplateMatchesInspection(input, inspection);
      }
      if (input.previewAssetId) await requireAuthorizedAsset(tx, input.previewAssetId);

      await tx.insert(personalizationTemplateVersions).values({
        id: versionId,
        tenantId: context.tenantId,
        templateId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        name: input.name,
        source: input.source,
        sourceAssetId: input.sourceAssetId,
        sourceAssetVersion: input.sourceAssetVersion,
        sourceInspectionId: input.sourceInspectionId,
        sourceTemplateVersionId: input.sourceTemplateVersionId,
        canvas: input.canvas,
        previewAssetId: input.previewAssetId,
        createdBy: context.userId,
      });
      if (normalizedSlots.length) {
        await tx.insert(templateSlots).values(normalizedSlots.map((slot) => ({
          id: createEntityId(),
          tenantId: context.tenantId,
          templateVersionId: versionId,
          stableKey: slot.stableKey,
          name: slot.name,
          kind: slot.kind,
          psdGroup: slot.psdGroup,
          geometry: slot.geometry,
          fillMode: slot.fillMode,
          validationSnapshot: slot.validationSnapshot,
          replaceable: slot.replaceable,
          reuseLabel: slot.reuseLabel,
        })));
      }
    });
    await this.record(context, "pod.personalization_template.create", "personalization_template_version", versionId, {
      templateId,
      source: input.source,
      sourceTemplateVersionId: input.sourceTemplateVersionId,
      slotCount: input.slots.length,
    });
    return this.getTemplate(context, versionId);
  }

  async cloneTemplate(context: TenantContext, sourceTemplateVersionId: string, rawInput: ClonePersonalizationTemplateInput) {
    const input = ClonePersonalizationTemplateInputSchema.parse(rawInput);
    const source = await this.getTemplate(context, sourceTemplateVersionId);
    if (source.status !== "approved") throw new ConflictException("Only approved template versions can be copied");
    return this.createTemplate(context, {
      name: input.name,
      source: "popular_template",
      sourceTemplateVersionId: source.id,
      ...(source.sourceAssetId ? {
        sourceAssetId: source.sourceAssetId,
        sourceAssetVersion: source.sourceAssetVersion,
      } : {}),
      canvas: source.canvas,
      ...(source.previewAssetId ? { previewAssetId: source.previewAssetId } : {}),
      slots: source.slots.map((slot) => ({
        stableKey: slot.stableKey,
        name: slot.name,
        kind: slot.kind,
        ...(slot.psdGroup ? { psdGroup: slot.psdGroup } : {}),
        geometry: slot.geometry,
        fillMode: slot.fillMode,
        validationSnapshot: slot.validationSnapshot,
        replaceable: slot.replaceable,
        ...(slot.reuseLabel ? { reuseLabel: slot.reuseLabel } : {}),
      })),
    });
  }

  async listTemplates(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select({ id: personalizationTemplateVersions.id })
      .from(personalizationTemplateVersions).orderBy(desc(personalizationTemplateVersions.createdAt)).limit(500));
    return PersonalizationTemplateVersionListSchema.parse({
      items: await Promise.all(rows.map((row) => this.getTemplate(context, row.id))),
    });
  }

  async personalizationOptions(context: TenantContext) {
    const result = await withTenant(this.database.db, context, async (tx) => {
      const skuRows = await tx.select({
        id: skus.id,
        code: skus.code,
        spuCode: spus.code,
        productName: productPlans.name,
      }).from(skus)
        .innerJoin(spus, eq(skus.spuId, spus.id))
        .innerJoin(productPlans, eq(spus.productPlanId, productPlans.id))
        .where(inArray(skus.status, ["draft", "active"]))
        .orderBy(asc(productPlans.name), asc(skus.code))
        .limit(500);
      const sources = await tx.select({
        id: assetFiles.id,
        version: assetFiles.version,
        fileName: assetFiles.fileName,
        mediaType: assetFiles.mediaType,
      }).from(assetFiles).where(and(
        eq(assetFiles.assetDomain, "authorized"),
        eq(assetFiles.rightsStatus, "approved"),
        isNull(assetFiles.deletedAt),
        sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') <> 'customer_provided'`,
      )).orderBy(desc(assetFiles.createdAt)).limit(500);
      return { skuRows, sources };
    });
    return PodPersonalizationOptionsViewSchema.parse({
      skus: result.skuRows,
      sourceAssets: result.sources,
    });
  }

  async getTemplate(context: TenantContext, id: string) {
    const result = await withTenant(this.database.db, context, async (tx) => {
      const [version] = await tx.select().from(personalizationTemplateVersions)
        .where(eq(personalizationTemplateVersions.id, id)).limit(1);
      if (!version) throw new NotFoundException("Personalization template version not found");
      const slots = await tx.select().from(templateSlots).where(eq(templateSlots.templateVersionId, id))
        .orderBy(asc(templateSlots.stableKey));
      return { version, slots };
    });
    return mapTemplate(result.version, result.slots);
  }

  async reviewTemplate(context: TenantContext, id: string, rawInput: PodReviewDecisionInput) {
    const input = PodReviewDecisionInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [version] = await tx.select().from(personalizationTemplateVersions)
        .where(eq(personalizationTemplateVersions.id, id)).limit(1);
      if (!version) throw new NotFoundException("Personalization template version not found");
      if (!(["draft", "pending_review"] as const).includes(version.status as "draft" | "pending_review")) {
        throw new ConflictException("Only draft or pending-review templates can be reviewed");
      }
      const slots = await tx.select().from(templateSlots).where(eq(templateSlots.templateVersionId, id));
      if (input.decision === "approve" && !slots.some((slot) => slot.replaceable)) {
        throw new ConflictException("Approved personalization templates require at least one replaceable slot");
      }
      if (version.sourceAssetId) await requireAuthorizedAsset(tx, version.sourceAssetId, version.sourceAssetVersion ?? undefined);
      if (version.previewAssetId) await requireAuthorizedAsset(tx, version.previewAssetId);
      await tx.update(personalizationTemplateVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
      }).where(eq(personalizationTemplateVersions.id, id));
    });
    await this.record(context, `pod.personalization_template.${input.decision}`, "personalization_template_version", id, {
      ...(input.decision === "reject" ? { reason: input.reason } : {}),
    });
    return this.getTemplate(context, id);
  }

  async createBinding(context: TenantContext, rawInput: CreateSkuTemplateBindingInput) {
    const input = CreateSkuTemplateBindingInputSchema.parse(rawInput);
    const [row] = await withTenant(this.database.db, context, async (tx) => {
      const [sku] = await tx.select().from(skus).where(eq(skus.id, input.skuId)).limit(1);
      if (!sku) throw new NotFoundException("SKU not found");
      const [template] = await tx.select().from(personalizationTemplateVersions)
        .where(eq(personalizationTemplateVersions.id, input.templateVersionId)).limit(1);
      if (!template || template.status !== "approved") throw new ConflictException("An approved template version is required");
      const [overlap] = await tx.select().from(skuTemplateBindings).where(and(
        eq(skuTemplateBindings.skuId, input.skuId),
        eq(skuTemplateBindings.sizeLabel, input.sizeLabel),
        eq(skuTemplateBindings.status, "active"),
        or(isNull(skuTemplateBindings.effectiveTo), gt(skuTemplateBindings.effectiveTo, new Date(input.effectiveFrom))),
      )).limit(1);
      if (overlap) throw new ConflictException("An active SKU template binding already covers this size and period");
      return tx.insert(skuTemplateBindings).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        skuId: input.skuId,
        templateVersionId: input.templateVersionId,
        sizeLabel: input.sizeLabel,
        mappingSnapshot: input.mappingSnapshot,
        effectiveFrom: new Date(input.effectiveFrom),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : undefined,
        createdBy: context.userId,
      }).returning();
    });
    await this.record(context, "pod.sku_template_binding.create", "sku_template_binding", row!.id, {
      skuId: input.skuId,
      templateVersionId: input.templateVersionId,
      sizeLabel: input.sizeLabel,
    });
    return mapBinding(row!);
  }

  async listBindings(context: TenantContext, skuId: string) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(skuTemplateBindings)
      .where(eq(skuTemplateBindings.skuId, skuId)).orderBy(desc(skuTemplateBindings.effectiveFrom)).limit(200));
    return { items: rows.map(mapBinding) };
  }

  async createProductionManifest(context: TenantContext, rawInput: CreateProductionManifestInput) {
    const input = CreateProductionManifestInputSchema.parse(rawInput);
    if (input.qualityCheckSnapshot.passed !== true) throw new ConflictException("Production quality checks must pass before manifest creation");
    const id = createEntityId();
    let canonicalQualityCheckSnapshot = input.qualityCheckSnapshot;
    await withTenant(this.database.db, context, async (tx) => {
      if (input.orderLineId) {
        const [line] = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.id, input.orderLineId)).limit(1);
        if (!line) throw new NotFoundException("Order line not found");
      }
      if (input.designVersionId) {
        const [version] = await tx.select().from(designVersions).where(eq(designVersions.id, input.designVersionId)).limit(1);
        if (!version || version.status !== "approved") throw new ConflictException("An approved design version is required for production");
      }
      if (input.templateVersionId) {
        const [template] = await tx.select().from(personalizationTemplateVersions)
          .where(eq(personalizationTemplateVersions.id, input.templateVersionId)).limit(1);
        if (!template || template.status !== "approved") throw new ConflictException("An approved template version is required for production");
      }
      canonicalQualityCheckSnapshot = await assertVectorManifestQuality(tx, input) ?? canonicalQualityCheckSnapshot;
      await assertManifestAssets(tx, input);
      await tx.insert(productionManifests).values({
        id,
        tenantId: context.tenantId,
        orderLineId: input.orderLineId,
        designVersionId: input.designVersionId,
        templateVersionId: input.templateVersionId,
        inputSnapshot: input.inputSnapshot,
        fileSnapshot: input.files,
        qualityCheckSnapshot: canonicalQualityCheckSnapshot,
        createdBy: context.userId,
      });
    });
    await this.record(context, "pod.production_manifest.create", "production_manifest", id, {
      orderLineId: input.orderLineId,
      designVersionId: input.designVersionId,
      templateVersionId: input.templateVersionId,
      fileCount: input.files.length,
    });
    return this.getProductionManifest(context, id);
  }

  async listProductionManifests(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(productionManifests)
      .orderBy(desc(productionManifests.createdAt)).limit(500));
    return ProductionManifestListSchema.parse({ items: rows.map(mapProductionManifest) });
  }

  async getProductionManifest(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(productionManifests)
      .where(eq(productionManifests.id, id)).limit(1));
    if (!row) throw new NotFoundException("Production manifest not found");
    return mapProductionManifest(row);
  }

  async reviewProductionManifest(context: TenantContext, id: string, rawInput: PodReviewDecisionInput) {
    const input = PodReviewDecisionInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [manifest] = await tx.select().from(productionManifests).where(eq(productionManifests.id, id)).limit(1);
      if (!manifest) throw new NotFoundException("Production manifest not found");
      if (manifest.status !== "pending_review") throw new ConflictException("Only pending production manifests can be reviewed");
      if (input.decision === "approve") {
        await assertVectorManifestQuality(tx, {
          designVersionId: manifest.designVersionId ?? undefined,
          files: manifest.fileSnapshot,
          qualityCheckSnapshot: manifest.qualityCheckSnapshot,
        });
        await assertManifestAssets(tx, {
          orderLineId: manifest.orderLineId ?? undefined,
          inputSnapshot: manifest.inputSnapshot,
          files: manifest.fileSnapshot,
        });
      }
      await tx.update(productionManifests).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        reviewedBy: context.userId,
        reviewedAt: new Date(),
        rejectionReason: input.decision === "reject" ? input.reason : null,
      }).where(eq(productionManifests.id, id));
    });
    await this.record(context, `pod.production_manifest.${input.decision}`, "production_manifest", id, {
      ...(input.decision === "reject" ? { reason: input.reason } : {}),
    });
    return this.getProductionManifest(context, id);
  }

  private record(context: TenantContext, action: string, resourceType: string, resourceId: string, metadata?: Record<string, unknown>) {
    return this.audit.record(context, { action, resourceType, resourceId, result: "success", metadata });
  }
}

type TenantTransaction = Parameters<Parameters<typeof withTenant>[2]>[0];

async function assertVectorManifestQuality(
  tx: TenantTransaction,
  input: Pick<CreateProductionManifestInput, "designVersionId" | "files" | "qualityCheckSnapshot">,
) {
  const svgFiles = input.files.filter((file) => file.mediaType === "image/svg+xml");
  if (!svgFiles.length) return undefined;
  if (svgFiles.length !== input.files.length) {
    throw new ConflictException("A vector production manifest cannot mix SVG and raster production files");
  }
  if (!input.designVersionId) {
    throw new ConflictException("Vector production requires an approved design version source");
  }
  const [render] = await tx.select({
    id: orderPersonalizationRenderTasks.id,
    parameterSnapshot: orderPersonalizationRenderTasks.parameterSnapshot,
    qualityCheckSnapshot: orderPersonalizationRenderTasks.qualityCheckSnapshot,
    toolKey: orderPersonalizationRenderTasks.toolKey,
  }).from(orderPersonalizationRenderTasks)
    .where(eq(orderPersonalizationRenderTasks.resultVersionId, input.designVersionId)).limit(1);
  if (!render || render.toolKey !== "vector_fulfillment") {
    throw new ConflictException("SVG production files require an authoritative vector fulfillment task");
  }
  const quality = VectorFulfillmentQualityCheckSnapshotSchema.safeParse(render.qualityCheckSnapshot);
  if (!quality.success || !quality.data.exportReady) {
    throw new ConflictException("Vector fulfillment quality evidence is missing or not export-ready");
  }
  const versionFiles = await tx.select({ assetId: designVersionFiles.assetFileId }).from(designVersionFiles)
    .where(eq(designVersionFiles.versionId, input.designVersionId));
  const allowedAssetIds = new Set(versionFiles.map((file) => file.assetId));
  if (svgFiles.some((file) => !allowedAssetIds.has(file.assetId))) {
    throw new ConflictException("SVG production files must belong to the approved vector design version");
  }
  if (quality.data.outputChecks.length !== svgFiles.length) {
    throw new ConflictException("SVG production files do not completely match vector quality evidence");
  }
  const parameters = render.parameterSnapshot as {
    colorMode?: string;
    vectorHeight?: number;
    vectorUnit?: string;
    vectorWidth?: number;
  };
  for (const file of svgFiles) {
    const check = quality.data.outputChecks.find((candidate) => (
      candidate.fileName === file.fileName || `${render.id}-${candidate.fileName}` === file.fileName
    ));
    if (
      !check
      || check.width !== file.width
      || check.height !== file.height
      || check.unit !== file.unit
      || file.dpi !== undefined
      || file.colorMode !== parameters.colorMode
      || file.width !== parameters.vectorWidth
      || file.height !== parameters.vectorHeight
      || file.unit !== parameters.vectorUnit
    ) {
      throw new ConflictException("SVG production metadata does not match its pinned vector quality evidence");
    }
  }
  return quality.data;
}

async function requireAuthorizedAsset(tx: TenantTransaction, id: string, version?: number) {
  const [asset] = await tx.select().from(assetFiles).where(and(eq(assetFiles.id, id), isNull(assetFiles.deletedAt))).limit(1);
  if (!asset || (version !== undefined && asset.version !== version)) throw new NotFoundException("Pinned asset version not found");
  if (asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved") {
    throw new ConflictException("Personalization and production require rights-approved authorized assets");
  }
  if ((asset.rightsMetadata as { source?: { kind?: string } }).source?.kind === "customer_provided") {
    throw new ConflictException("Customer-order assets cannot be reused as template sources");
  }
  return asset;
}

async function assertManifestAssets(
  tx: TenantTransaction,
  input: Pick<CreateProductionManifestInput, "inputSnapshot" | "files"> & { orderLineId?: string },
) {
  const snapshots = [...input.inputSnapshot, ...input.files];
  const assetIds = [...new Set(snapshots.map((snapshot) => snapshot.assetId))];
  const assets = await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, assetIds), isNull(assetFiles.deletedAt)));
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const customerCustomizationVersionIds = new Set<string>();
  for (const snapshot of snapshots) {
    const asset = byId.get(snapshot.assetId);
    if (
      !asset
      || asset.version !== snapshot.assetVersion
      || asset.checksumSha256 !== snapshot.checksumSha256
      || asset.rightsStatus !== "approved"
    ) throw new ConflictException("Production manifest assets must match approved immutable evidence");
    const source = asset.rightsMetadata as { source?: { kind?: string; reference?: string } };
    if (source.source?.kind === "customer_provided") {
      if (asset.assetDomain !== "order") {
        throw new ConflictException("Customer-order assets must remain in the order-private asset domain");
      }
      const versionId = source.source.reference?.match(/^order-customization:([0-9a-f-]+)$/)?.[1];
      if (!versionId) throw new ConflictException("Customer-order asset is missing its protected customization reference");
      customerCustomizationVersionIds.add(versionId);
    } else if (asset.assetDomain !== "authorized") {
      throw new ConflictException("Non-customer production assets must use the authorized asset domain");
    }
  }
  if (customerCustomizationVersionIds.size) {
    if (!input.orderLineId) throw new ConflictException("Customer-order assets require an order-line-scoped production manifest");
    const scoped = await tx.select({ id: orderCustomizationVersions.id })
      .from(orderCustomizationVersions)
      .innerJoin(orderCustomizationRequirements, eq(orderCustomizationVersions.requirementId, orderCustomizationRequirements.id))
      .where(and(
        inArray(orderCustomizationVersions.id, [...customerCustomizationVersionIds]),
        eq(orderCustomizationRequirements.orderLineId, input.orderLineId),
      ));
    if (scoped.length !== customerCustomizationVersionIds.size) {
      throw new ConflictException("Customer-order assets do not belong to the production order line");
    }
  }
}

function isPsd(mediaType: string, fileName: string) {
  return mediaType === "image/vnd.adobe.photoshop" || fileName.toLowerCase().endsWith(".psd");
}

function templateSourceKind(mediaType: string, fileName: string): "png" | "psd" | undefined {
  if (isPsd(mediaType, fileName)) return "psd";
  if (mediaType === "image/png" || fileName.toLowerCase().endsWith(".png")) return "png";
  return undefined;
}

function assertTemplateMatchesInspection(
  input: CreatePersonalizationTemplateVersionInput,
  inspection: typeof personalizationTemplateSourceInspections.$inferSelect | undefined,
) {
  if (!inspection || inspection.status !== "completed" || !inspection.canvas) {
    throw new ConflictException("Imported templates require a completed source inspection");
  }
  if (
    inspection.source !== input.source
    || inspection.sourceAssetId !== input.sourceAssetId
    || inspection.sourceAssetVersion !== input.sourceAssetVersion
    || inspection.parserKey !== TEMPLATE_SOURCE_PARSER.key
    || inspection.parserVersion !== TEMPLATE_SOURCE_PARSER.version
  ) throw new ConflictException("Template source does not match the completed inspection snapshot");
  if (
    inspection.canvas.width !== input.canvas.width
    || inspection.canvas.height !== input.canvas.height
    || inspection.canvas.dpi !== input.canvas.dpi
    || inspection.canvas.colorMode !== input.canvas.colorMode
    || inspection.canvas.background !== input.canvas.background
  ) {
    throw new ConflictException("Imported template canvas must match the inspected source canvas");
  }
  const byKey = new Map(inspection.slotSnapshot.map((slot) => [slot.stableKey, slot]));
  for (const slot of input.slots) {
    const detected = byKey.get(slot.stableKey);
    if (!detected || !sameGeometry(detected.geometry, slot.geometry)) {
      throw new ConflictException(`Template slot ${slot.stableKey} does not match the inspected source geometry`);
    }
  }
}

function sameGeometry(
  left: { x: number; y: number; width: number; height: number; rotationDegrees: number },
  right: { x: number; y: number; width: number; height: number; rotationDegrees: number },
) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.rotationDegrees === right.rotationDegrees;
}

function mapTemplateSourceInspection(row: typeof personalizationTemplateSourceInspections.$inferSelect) {
  return PersonalizationTemplateSourceInspectionSchema.parse({
    id: row.id,
    sourceAssetId: row.sourceAssetId,
    sourceAssetVersion: row.sourceAssetVersion,
    checksumSha256: row.checksumSha256,
    source: row.source,
    status: row.status,
    parserKey: row.parserKey,
    parserVersion: row.parserVersion,
    canvas: row.canvas ?? undefined,
    slots: row.slotSnapshot,
    warnings: row.warningSnapshot,
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    requestedBy: row.requestedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  });
}

function mapTemplate(
  version: typeof personalizationTemplateVersions.$inferSelect,
  slots: Array<typeof templateSlots.$inferSelect>,
) {
  return PersonalizationTemplateVersionSchema.parse({
    id: version.id,
    templateId: version.templateId,
    versionNumber: version.versionNumber,
    name: version.name,
    source: version.source,
    sourceAssetId: version.sourceAssetId ?? undefined,
    sourceAssetVersion: version.sourceAssetVersion ?? undefined,
    sourceInspectionId: version.sourceInspectionId ?? undefined,
    sourceTemplateVersionId: version.sourceTemplateVersionId ?? undefined,
    canvas: version.canvas,
    previewAssetId: version.previewAssetId ?? undefined,
    status: version.status,
    slots: slots.map((slot) => ({
      id: slot.id,
      templateVersionId: slot.templateVersionId,
      stableKey: slot.stableKey,
      name: slot.name,
      kind: slot.kind,
      psdGroup: slot.psdGroup ?? undefined,
      geometry: slot.geometry,
      fillMode: slot.fillMode,
      validationSnapshot: slot.validationSnapshot,
      replaceable: slot.replaceable,
      reuseLabel: slot.reuseLabel ?? undefined,
    })),
    createdBy: version.createdBy ?? undefined,
    createdAt: version.createdAt.toISOString(),
  });
}

function mapBinding(row: typeof skuTemplateBindings.$inferSelect) {
  return SkuTemplateBindingSchema.parse({
    ...row,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString(),
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  });
}

function mapProductionManifest(row: typeof productionManifests.$inferSelect) {
  return ProductionManifestSchema.parse({
    id: row.id,
    orderLineId: row.orderLineId ?? undefined,
    designVersionId: row.designVersionId ?? undefined,
    templateVersionId: row.templateVersionId ?? undefined,
    inputSnapshot: row.inputSnapshot,
    files: row.fileSnapshot,
    qualityCheckSnapshot: row.qualityCheckSnapshot,
    status: row.status,
    reviewedBy: row.reviewedBy ?? undefined,
    reviewedAt: row.reviewedAt?.toISOString(),
    rejectionReason: row.rejectionReason ?? undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  });
}
