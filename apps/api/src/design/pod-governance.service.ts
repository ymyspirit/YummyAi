import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  ArtifactRelationSchema,
  CreateDesignRecipeVersionInputSchema,
  CreateListingArtifactBindingInputSchema,
  CreateRightsAssessmentInputSchema,
  CreateVisualFingerprintInputSchema,
  DesignRecipeVersionSchema,
  ListingArtifactBindingSchema,
  PodListingArtifactOptionsViewSchema,
  RightsAssessmentSchema,
  VisualFingerprintSchema,
  VisualSearchInputSchema,
  VisualSearchResultSchema,
  createEntityId,
  type CreateArtifactRelationInput,
  type CreateDesignRecipeVersionInput,
  type CreateListingArtifactBindingInput,
  type CreateRightsAssessmentInput,
  type CreateVisualFingerprintInput,
  type TenantContext,
  type VisualSearchInput,
} from "@yummyai/contracts";
import {
  artifactRelations,
  assetFiles,
  creativeDesignSkuBindings,
  designTasks,
  designRecipeVersions,
  designVersionFiles,
  designVersions,
  listingArtifactBindings,
  listings,
  listingVersions,
  mockupBatchItems,
  mockupBatchOutputs,
  mockupBatches,
  mockupTemplatePackVersions,
  mockupTemplateSlots,
  rightsAssessments,
  skus,
  visualFingerprints,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

@Injectable()
export class PodGovernanceService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createRecipe(context: TenantContext, rawInput: CreateDesignRecipeVersionInput) {
    const input = CreateDesignRecipeVersionInputSchema.parse(rawInput);
    const recipeId = input.recipeId ?? createEntityId();
    const row = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pod-recipe:${recipeId}`}, 0))`);
      const [latest] = await tx.select().from(designRecipeVersions)
        .where(eq(designRecipeVersions.recipeId, recipeId))
        .orderBy(desc(designRecipeVersions.versionNumber)).limit(1);
      if (input.recipeId && !latest) throw new NotFoundException("Design recipe not found");
      const [created] = await tx.insert(designRecipeVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        recipeId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        toolKey: input.toolKey,
        parameterSnapshot: input.parameterSnapshot,
        modelPolicy: input.modelPolicy,
        promptTemplateVersion: input.promptTemplateVersion,
        createdBy: context.userId,
      }).returning();
      return created!;
    });
    await this.record(context, "pod.recipe_version.create", "design_recipe_version", row.id, {
      recipeId,
      versionNumber: row.versionNumber,
      toolKey: row.toolKey,
    });
    return mapRecipe(row);
  }

  async listRecipes(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(designRecipeVersions)
      .orderBy(desc(designRecipeVersions.createdAt)).limit(500));
    return { items: rows.map(mapRecipe) };
  }

  async createRightsAssessment(context: TenantContext, rawInput: CreateRightsAssessmentInput) {
    const input = CreateRightsAssessmentInputSchema.parse(rawInput);
    if (input.status === "approved" && !input.rightsSource) {
      throw new BadRequestException("Approved rights assessments require a pinned rights source");
    }
    const row = await withTenant(this.database.db, context, async (tx) => {
      const [asset] = await tx.select().from(assetFiles).where(and(
        eq(assetFiles.id, input.assetId),
        isNull(assetFiles.deletedAt),
      )).limit(1);
      if (!asset || asset.version !== input.assetVersion) throw new NotFoundException("Pinned asset version not found");
      if (asset.assetDomain === "order") authorize(context, Permission.OrderPiiRead);

      if (input.supersedesAssessmentId) {
        const [previous] = await tx.select().from(rightsAssessments)
          .where(eq(rightsAssessments.id, input.supersedesAssessmentId)).limit(1);
        if (!previous || previous.assetId !== input.assetId || previous.assetVersion !== input.assetVersion) {
          throw new BadRequestException("Superseded assessment must belong to the same asset version");
        }
      }

      const id = createEntityId();
      await tx.insert(rightsAssessments).values({
        id,
        tenantId: context.tenantId,
        assetId: input.assetId,
        assetVersion: input.assetVersion,
        taskId: input.taskId,
        supersedesAssessmentId: input.supersedesAssessmentId,
        rightsSource: input.rightsSource,
        scopeSnapshot: input.scopeSnapshot,
        status: input.status,
        legalRisk: input.legalRisk,
        visualSimilarityPermille: input.visualSimilarityPermille,
        evidenceSnapshot: input.evidence,
        modelKey: input.modelKey,
        modelVersion: input.modelVersion,
        decisionReason: input.decisionReason,
        assessedBy: context.userId,
      });

      if (input.legalRisk === "high" || input.status === "blocked" || input.status === "rejected") {
        await tx.update(assetFiles).set({
          rightsStatus: "rejected",
          rightsMetadata: {
            assessmentId: id,
            legalRisk: input.legalRisk,
            status: input.status,
            assessedAt: new Date().toISOString(),
          },
        }).where(eq(assetFiles.id, asset.id));
      } else if (
        input.status === "approved"
        && input.rightsSource
        && (asset.assetDomain === "authorized" || asset.assetDomain === "order")
      ) {
        if (input.rightsSource.kind === "competitor") throw new ConflictException("Competitor evidence cannot authorize an asset");
        if (asset.assetDomain === "order" && input.rightsSource.kind !== "customer_provided") {
          throw new ConflictException("Order-private assets require customer-provided rights evidence");
        }
        if (asset.assetDomain === "order") {
          const pinned = (asset.rightsMetadata as { source?: { reference?: string } }).source?.reference;
          if (!pinned || input.rightsSource.reference !== pinned) {
            throw new ConflictException("Order-private asset rights evidence must retain its pinned customization reference");
          }
        }
        await tx.update(assetFiles).set({
          rightsStatus: "approved",
          rightsMetadata: {
            source: input.rightsSource,
            assessmentId: id,
            approvedAt: new Date().toISOString(),
            approvedBy: context.userId,
          },
        }).where(eq(assetFiles.id, asset.id));
      }

      const [created] = await tx.select().from(rightsAssessments).where(eq(rightsAssessments.id, id)).limit(1);
      return created!;
    });
    await this.record(context, "pod.rights_assessment.create", "rights_assessment", row.id, {
      assetId: row.assetId,
      assetVersion: row.assetVersion,
      status: row.status,
      legalRisk: row.legalRisk,
    });
    return mapAssessment(row);
  }

  async listRightsAssessments(context: TenantContext, assetId: string) {
    const rows = await withTenant(this.database.db, context, async (tx) => {
      const [asset] = await tx.select({ domain: assetFiles.assetDomain }).from(assetFiles)
        .where(eq(assetFiles.id, assetId)).limit(1);
      if (asset?.domain === "order") authorize(context, Permission.OrderPiiRead);
      return tx.select().from(rightsAssessments)
        .where(eq(rightsAssessments.assetId, assetId))
        .orderBy(desc(rightsAssessments.assessedAt)).limit(200);
    });
    return { items: rows.map(mapAssessment) };
  }

  async registerFingerprint(context: TenantContext, rawInput: CreateVisualFingerprintInput) {
    const input = CreateVisualFingerprintInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      const [asset] = await tx.select().from(assetFiles).where(and(
        eq(assetFiles.id, input.assetId),
        isNull(assetFiles.deletedAt),
      )).limit(1);
      if (!asset || asset.version !== input.assetVersion || asset.checksumSha256 !== input.checksumSha256) {
        throw new BadRequestException("Fingerprint must match the current immutable asset evidence");
      }
      if (asset.assetDomain === "order") {
        throw new ConflictException("Order-private customer assets cannot enter visual fingerprint indexes");
      }
      const [existing] = await tx.select().from(visualFingerprints).where(and(
        eq(visualFingerprints.assetId, input.assetId),
        eq(visualFingerprints.assetVersion, input.assetVersion),
        eq(visualFingerprints.fingerprintAlgorithm, input.fingerprintAlgorithm),
        eq(visualFingerprints.fingerprintVersion, input.fingerprintVersion),
      )).limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(visualFingerprints).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        ...input,
      }).returning();
      return created!;
    });
    await this.record(context, "pod.visual_fingerprint.register", "visual_fingerprint", row.id, {
      assetId: row.assetId,
      assetVersion: row.assetVersion,
      algorithm: row.fingerprintAlgorithm,
    });
    return mapFingerprint(row);
  }

  async visualSearch(context: TenantContext, rawInput: VisualSearchInput) {
    const input = VisualSearchInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      const queryConditions = [
        eq(visualFingerprints.assetId, input.assetId),
        eq(visualFingerprints.indexStatus, "indexed"),
        isNull(assetFiles.deletedAt),
        inArray(assetFiles.assetDomain, ["research", "authorized"]),
      ];
      if (input.assetVersion) queryConditions.push(eq(visualFingerprints.assetVersion, input.assetVersion));
      const [query] = await tx.select({ fingerprint: visualFingerprints, asset: assetFiles })
        .from(visualFingerprints)
        .innerJoin(assetFiles, eq(visualFingerprints.assetId, assetFiles.id))
        .where(and(...queryConditions))
        .orderBy(desc(visualFingerprints.createdAt)).limit(1);
      if (!query) throw new NotFoundException("Indexed visual fingerprint not found");

      const candidateConditions = [
        eq(visualFingerprints.indexStatus, "indexed"),
        eq(visualFingerprints.fingerprintAlgorithm, query.fingerprint.fingerprintAlgorithm),
        eq(visualFingerprints.fingerprintVersion, query.fingerprint.fingerprintVersion),
        isNull(assetFiles.deletedAt),
        inArray(assetFiles.assetDomain, ["research", "authorized"]),
      ];
      if (input.domain !== "all") candidateConditions.push(eq(assetFiles.assetDomain, input.domain));
      const candidates = await tx.select({ fingerprint: visualFingerprints, asset: assetFiles })
        .from(visualFingerprints)
        .innerJoin(assetFiles, eq(visualFingerprints.assetId, assetFiles.id))
        .where(and(...candidateConditions))
        .orderBy(desc(visualFingerprints.createdAt))
        .limit(Math.min(2_000, Math.max(200, input.limit * 20)));
      return { query, candidates };
    });

    const hits = result.candidates.flatMap(({ fingerprint, asset }) => {
      if (fingerprint.id === result.query.fingerprint.id) return [];
      const exactChecksumMatch = fingerprint.checksumSha256 === result.query.fingerprint.checksumSha256;
      const distance = fingerprint.perceptualHash && result.query.fingerprint.perceptualHash
        ? hammingHex(fingerprint.perceptualHash, result.query.fingerprint.perceptualHash)
        : undefined;
      if (!exactChecksumMatch && (distance === undefined || distance > input.maxHammingDistance)) return [];
      const bits = fingerprint.perceptualHash ? fingerprint.perceptualHash.length * 4 : 0;
      return [{
        fingerprintId: fingerprint.id,
        assetId: fingerprint.assetId,
        assetVersion: fingerprint.assetVersion,
        assetDomain: asset.assetDomain as "research" | "authorized",
        exactChecksumMatch,
        ...(distance !== undefined && bits ? { perceptualSimilarityPermille: Math.max(0, 1_000 - Math.round(distance / bits * 1_000)) } : {}),
      }];
    }).sort((left, right) => Number(right.exactChecksumMatch) - Number(left.exactChecksumMatch)
      || (right.perceptualSimilarityPermille ?? -1) - (left.perceptualSimilarityPermille ?? -1))
      .slice(0, input.limit);

    const response = VisualSearchResultSchema.parse({ queryFingerprintId: result.query.fingerprint.id, hits });
    await this.record(context, "pod.visual_search.run", "visual_fingerprint", response.queryFingerprintId, {
      queryAssetId: input.assetId,
      resultCount: response.hits.length,
      domain: input.domain,
    });
    return response;
  }

  async traceAsset(context: TenantContext, assetId: string) {
    const rows = await withTenant(this.database.db, context, async (tx) => {
      const [asset] = await tx.select({ domain: assetFiles.assetDomain }).from(assetFiles)
        .where(eq(assetFiles.id, assetId)).limit(1);
      if (asset?.domain === "order") authorize(context, Permission.OrderPiiRead);
      return tx.select().from(artifactRelations)
        .where(or(eq(artifactRelations.fromAssetId, assetId), eq(artifactRelations.toAssetId, assetId)))
        .orderBy(desc(artifactRelations.createdAt)).limit(1_000);
    });
    return { relations: rows.map(mapRelation) };
  }

  async createListingArtifactBinding(context: TenantContext, rawInput: CreateListingArtifactBindingInput) {
    const input = CreateListingArtifactBindingInputSchema.parse(rawInput);
    const [row] = await withTenant(this.database.db, context, async (tx) => {
      const [listingVersion] = await tx.select().from(listingVersions)
        .where(eq(listingVersions.id, input.listingVersionId)).limit(1);
      if (!listingVersion) throw new NotFoundException("Listing version not found");
      const [asset] = await tx.select().from(assetFiles).where(and(
        eq(assetFiles.id, input.assetId),
        isNull(assetFiles.deletedAt),
      )).limit(1);
      if (!asset || asset.version !== input.assetVersion) throw new NotFoundException("Pinned asset version not found");
      if (asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved") {
        throw new ConflictException("Listing candidates require rights-approved authorized assets");
      }
      if (input.contentKind === "title" && asset.mediaType !== "text/plain") {
        throw new BadRequestException("Title slots require a text/plain artifact");
      }
      if (input.contentKind === "image" && !asset.mediaType.startsWith("image/")) {
        throw new BadRequestException("Image slots require an image artifact");
      }
      const [approvedDesignResult] = await tx.select({ id: designVersionFiles.id })
        .from(designVersionFiles)
        .innerJoin(designVersions, eq(designVersionFiles.versionId, designVersions.id))
        .where(and(
          eq(designVersionFiles.assetFileId, asset.id),
          inArray(designVersionFiles.role, ["effect", "production"]),
          eq(designVersions.status, "approved"),
        ))
        .limit(1);
      let approvedMockupResult = false;
      if (!approvedDesignResult && input.contentKind === "image") {
        const [output] = await tx.select().from(mockupBatchOutputs).where(and(
          eq(mockupBatchOutputs.assetId, asset.id),
          eq(mockupBatchOutputs.assetVersion, asset.version),
          eq(mockupBatchOutputs.status, "approved"),
        )).limit(1);
        if (output) {
          const [lineage] = await tx.select({ id: creativeDesignSkuBindings.id }).from(mockupBatchItems)
            .innerJoin(mockupBatches, eq(mockupBatchItems.batchId, mockupBatches.id))
            .innerJoin(mockupTemplatePackVersions, eq(mockupBatches.templatePackVersionId, mockupTemplatePackVersions.id))
            .innerJoin(creativeDesignSkuBindings, and(
              eq(mockupBatchItems.designVersionId, creativeDesignSkuBindings.designVersionId),
              eq(mockupBatchItems.skuId, creativeDesignSkuBindings.skuId),
            ))
            .innerJoin(designVersions, eq(mockupBatchItems.designVersionId, designVersions.id))
            .innerJoin(designTasks, eq(designVersions.taskId, designTasks.id))
            .where(and(
              eq(mockupBatchItems.id, output.itemId),
              eq(mockupBatchItems.status, "completed"),
              eq(mockupTemplatePackVersions.status, "approved"),
              eq(designVersions.status, "approved"),
              eq(designTasks.status, "approved"),
            )).limit(1);
          approvedMockupResult = Boolean(lineage);
        }
      }
      if (!approvedDesignResult && !approvedMockupResult) {
        throw new ConflictException("Listing candidates require an approved design result or an approved mockup derived from one");
      }
      return tx.insert(listingArtifactBindings).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        ...input,
        createdBy: context.userId,
      }).returning();
    });
    await this.record(context, "pod.listing_artifact_binding.create", "listing_artifact_binding", row!.id, {
      listingVersionId: input.listingVersionId,
      assetId: input.assetId,
      contentKind: input.contentKind,
      slotKey: input.slotKey,
    });
    return mapListingBinding(row!);
  }

  async createApprovedMockupListingBindings(context: TenantContext, input: {
    batchId: string;
    itemId: string;
    listingVersionId: string;
    slots: Array<{ outputId: string; slotKey: string }>;
  }) {
    const bindingIds = await withTenant(this.database.db, context, async (tx) => {
      const [item] = await tx.select({ item: mockupBatchItems, batch: mockupBatches, sku: skus }).from(mockupBatchItems)
        .innerJoin(mockupBatches, eq(mockupBatchItems.batchId, mockupBatches.id))
        .innerJoin(skus, eq(mockupBatchItems.skuId, skus.id))
        .where(and(eq(mockupBatchItems.id, input.itemId), eq(mockupBatchItems.batchId, input.batchId))).limit(1);
      if (!item) throw new NotFoundException("Mockup batch item not found");
      if (item.item.status !== "completed") throw new ConflictException("Only approved, complete mockup items can be bound to a Listing");
      const [pack] = await tx.select().from(mockupTemplatePackVersions)
        .where(eq(mockupTemplatePackVersions.id, item.batch.templatePackVersionId)).limit(1);
      if (!pack || pack.status !== "approved") throw new ConflictException("Mockup Listing candidates require an approved template pack");
      const [formal] = await tx.select({ bindingId: creativeDesignSkuBindings.id }).from(creativeDesignSkuBindings)
        .innerJoin(designVersions, eq(creativeDesignSkuBindings.designVersionId, designVersions.id))
        .innerJoin(designTasks, eq(creativeDesignSkuBindings.designTaskId, designTasks.id))
        .where(and(
          eq(creativeDesignSkuBindings.designVersionId, item.item.designVersionId),
          eq(creativeDesignSkuBindings.skuId, item.item.skuId),
          eq(designVersions.status, "approved"),
          eq(designTasks.status, "approved"),
        )).limit(1);
      if (!formal) throw new ConflictException("Mockup output is not derived from an approved formal design binding");
      const [listing] = await tx.select({ version: listingVersions, listing: listings }).from(listingVersions)
        .innerJoin(listings, eq(listingVersions.listingId, listings.id))
        .where(eq(listingVersions.id, input.listingVersionId)).limit(1);
      if (!listing) throw new NotFoundException("Listing version not found");
      if (listing.listing.spuId !== item.sku.spuId || listing.listing.platform !== item.batch.platform || listing.listing.locale !== item.batch.locale) {
        throw new ConflictException("Listing product, platform, and locale must match the mockup batch item");
      }
      const outputIds = input.slots.map((slot) => slot.outputId);
      const outputs = await tx.select({ output: mockupBatchOutputs, asset: assetFiles }).from(mockupBatchOutputs)
        .innerJoin(assetFiles, eq(mockupBatchOutputs.assetId, assetFiles.id))
        .where(and(
          eq(mockupBatchOutputs.itemId, item.item.id),
          inArray(mockupBatchOutputs.id, outputIds),
          eq(mockupBatchOutputs.status, "approved"),
          eq(assetFiles.assetDomain, "authorized"),
          eq(assetFiles.rightsStatus, "approved"),
          isNull(assetFiles.deletedAt),
        ));
      if (outputs.length !== outputIds.length) throw new ConflictException("Every selected mockup output must be approved, authorized, and belong to the item");
      const outputById = new Map(outputs.map((row) => [row.output.id, row]));
      if (outputs.some(({ output, asset }) => output.assetVersion !== asset.version || !asset.mediaType.startsWith("image/"))) {
        throw new ConflictException("Mockup Listing candidates require pinned image asset versions");
      }
      const requiredSlots = await tx.select().from(mockupTemplateSlots).where(and(
        eq(mockupTemplateSlots.templatePackVersionId, item.batch.templatePackVersionId), eq(mockupTemplateSlots.required, true),
      ));
      const mappedTemplateKeys = new Set(outputs.map(({ output }) => output.slotKey));
      if (requiredSlots.some((slot) => !mappedTemplateKeys.has(slot.slotKey))) throw new ConflictException("All required mockup slots must be included in the Listing binding");
      const targetSlotKeys = input.slots.map((slot) => slot.slotKey);
      if (new Set(targetSlotKeys).size !== targetSlotKeys.length) throw new BadRequestException("Listing slot mappings must be unique");
      const existing = await tx.select({ slotKey: listingArtifactBindings.slotKey }).from(listingArtifactBindings).where(and(
        eq(listingArtifactBindings.listingVersionId, listing.version.id), eq(listingArtifactBindings.contentKind, "image"), inArray(listingArtifactBindings.slotKey, targetSlotKeys),
      ));
      if (existing.length) throw new ConflictException("One or more Listing image slots are already bound");
      const rows = input.slots.map((slot) => {
        const { output } = outputById.get(slot.outputId)!;
        return {
          id: createEntityId(), tenantId: context.tenantId, listingVersionId: listing.version.id,
          assetId: output.assetId!, assetVersion: output.assetVersion!, contentKind: "image" as const,
          slotKey: slot.slotKey, status: "candidate" as const, createdBy: context.userId,
        };
      });
      await tx.insert(listingArtifactBindings).values(rows);
      await this.audit.recordInTransaction(tx, context, {
        action: "pod.mockup_item.listing_bind", resourceType: "mockup_batch_item", resourceId: item.item.id,
        result: "success", metadata: { listingVersionId: listing.version.id, slotCount: rows.length },
      });
      return rows.map((row) => row.id);
    });
    return bindingIds;
  }

  async listListingArtifactBindings(context: TenantContext, listingVersionId: string) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(listingArtifactBindings)
      .where(eq(listingArtifactBindings.listingVersionId, listingVersionId))
      .orderBy(desc(listingArtifactBindings.createdAt)).limit(100));
    return { items: rows.map(mapListingBinding) };
  }

  async listingOptions(context: TenantContext) {
    const data = await withTenant(this.database.db, context, async (tx) => {
      const [versionRows, assetRows, bindingRows] = await Promise.all([
        tx.select({
          id: listingVersions.id,
          listingId: listingVersions.listingId,
          versionNumber: listingVersions.versionNumber,
          platform: listings.platform,
          locale: listings.locale,
          status: listingVersions.status,
        }).from(listingVersions)
          .innerJoin(listings, eq(listingVersions.listingId, listings.id))
          .orderBy(desc(listingVersions.createdAt))
          .limit(500),
        tx.select({
          id: assetFiles.id,
          version: assetFiles.version,
          fileName: assetFiles.fileName,
          mediaType: assetFiles.mediaType,
        }).from(designVersionFiles)
          .innerJoin(designVersions, eq(designVersionFiles.versionId, designVersions.id))
          .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
          .where(and(
            inArray(designVersionFiles.role, ["effect", "production"]),
            eq(designVersions.status, "approved"),
            eq(assetFiles.assetDomain, "authorized"),
            eq(assetFiles.rightsStatus, "approved"),
            isNull(assetFiles.deletedAt),
            sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind', '') <> 'customer_provided'`,
            or(sql`${assetFiles.mediaType} like 'image/%'`, eq(assetFiles.mediaType, "text/plain")),
          ))
          .orderBy(desc(assetFiles.createdAt))
          .limit(500),
        tx.select().from(listingArtifactBindings)
          .orderBy(desc(listingArtifactBindings.createdAt))
          .limit(500),
      ]);
      return { versionRows, assetRows, bindingRows };
    });
    const uniqueAssets = [...new Map(data.assetRows.map((asset) => [`${asset.id}:${asset.version}`, asset])).values()];
    return PodListingArtifactOptionsViewSchema.parse({
      listingVersions: data.versionRows,
      assets: uniqueAssets,
      bindings: data.bindingRows.map(mapListingBinding),
    });
  }

  async createArtifactRelations(context: TenantContext, inputs: readonly CreateArtifactRelationInput[]) {
    if (!inputs.length) return [];
    const created = await withTenant(this.database.db, context, async (tx) => {
      const assetIds = [...new Set(inputs.flatMap((input) => [input.fromAssetId, input.toAssetId]))];
      const assets = await tx.select().from(assetFiles).where(inArray(assetFiles.id, assetIds));
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      if (assets.some((asset) => asset.assetDomain === "order")) {
        throw new ConflictException("Order-private customer assets cannot enter the shared artifact relation graph");
      }
      for (const input of inputs) {
        if (byId.get(input.fromAssetId)?.version !== input.fromAssetVersion || byId.get(input.toAssetId)?.version !== input.toAssetVersion) {
          throw new BadRequestException("Artifact relations require current pinned asset versions");
        }
      }
      return tx.insert(artifactRelations).values(inputs.map((input) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        ...input,
        createdBy: context.userId,
      }))).onConflictDoNothing().returning();
    });
    return created.map(mapRelation);
  }

  private record(context: TenantContext, action: string, resourceType: string, resourceId: string, metadata?: Record<string, unknown>) {
    return this.audit.record(context, { action, resourceType, resourceId, result: "success", metadata });
  }
}

function mapRecipe(row: typeof designRecipeVersions.$inferSelect) {
  return DesignRecipeVersionSchema.parse({
    ...row,
    promptTemplateVersion: row.promptTemplateVersion ?? undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  });
}

function mapAssessment(row: typeof rightsAssessments.$inferSelect) {
  return RightsAssessmentSchema.parse({
    assetId: row.assetId,
    assetVersion: row.assetVersion,
    taskId: row.taskId ?? undefined,
    supersedesAssessmentId: row.supersedesAssessmentId ?? undefined,
    rightsSource: row.rightsSource ?? undefined,
    scopeSnapshot: row.scopeSnapshot,
    status: row.status,
    legalRisk: row.legalRisk,
    visualSimilarityPermille: row.visualSimilarityPermille ?? undefined,
    evidence: row.evidenceSnapshot,
    modelKey: row.modelKey ?? undefined,
    modelVersion: row.modelVersion ?? undefined,
    decisionReason: row.decisionReason ?? undefined,
    id: row.id,
    assessedBy: row.assessedBy ?? undefined,
    assessedAt: row.assessedAt.toISOString(),
  });
}

function mapFingerprint(row: typeof visualFingerprints.$inferSelect) {
  return VisualFingerprintSchema.parse({
    ...row,
    perceptualHash: row.perceptualHash ?? undefined,
    vectorIndexReference: row.vectorIndexReference ?? undefined,
    createdAt: row.createdAt.toISOString(),
    removedAt: row.removedAt?.toISOString(),
  });
}

function mapRelation(row: typeof artifactRelations.$inferSelect) {
  return ArtifactRelationSchema.parse({
    ...row,
    taskId: row.taskId ?? undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  });
}

function mapListingBinding(row: typeof listingArtifactBindings.$inferSelect) {
  return ListingArtifactBindingSchema.parse({
    ...row,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  });
}

function hammingHex(left: string, right: string) {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const xor = Number.parseInt(left[index]!, 16) ^ Number.parseInt(right[index]!, 16);
    distance += ((xor >> 0) & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return distance;
}
