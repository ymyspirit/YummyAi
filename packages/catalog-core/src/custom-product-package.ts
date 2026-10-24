import { ForbiddenError, Permission, authorize, permissionScope } from "@yummyai/authz";
import {
  CaptureDraftSchema,
  createEntityId,
  type CaptureDraft,
  type TenantContext,
} from "@yummyai/contracts";
import {
  CatalogOperationParametersSchema,
  CatalogPreparedOperationSchema,
  type CatalogPreparedOperation,
} from "@yummyai/contracts/catalog/operation";
import {
  CustomProductPackageCompletenessSchema,
  CustomProductProfileV1Schema,
  GenerateProvisionalCustomProductProfileInputSchema,
  SaveCustomProductProfileInputSchema,
  type CustomProductPackageAsset,
  type CustomProductPackageCompleteness,
  type CustomProductPackageCompetitor,
  type CustomProductPackageExportMode,
  type CustomProductProfileV1,
  type SourcedTextFact,
} from "@yummyai/contracts/catalog/custom-product-package";
import {
  assetFiles,
  captureSnapshots,
  catalogOperationReceipts,
  recordAuditEvent,
  productPlans,
  researchItems,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import {
  buildCustomProductPackage,
  checksumSha256,
  type CustomProductPackageAssetFile,
  type Storage,
} from "@yummyai/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { catalogErrors, type CatalogErrors } from "./errors.js";
import { catalogFingerprint } from "./fingerprint.js";
import { currentCatalogContext, CatalogAuthorityChangedError, assertCatalogUnambiguousPlan } from "./access.js";

const POLICY_VERSION = "amazon-custom-product-package-2026-07-31";

export interface CustomProductPackageExport {
  bytes: Uint8Array;
  fileName: string;
  sha256: string;
  completeness: CustomProductPackageCompleteness;
}
export type CatalogExecutionGuard = (tx: TenantTransaction) => Promise<void>;

export class CatalogPackageService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
    private readonly errors: CatalogErrors = catalogErrors,
  ) {}

  async generateProvisionalProfile(
    context: TenantContext,
    planId: string,
    rawInput: { researchItemId: string; targetMarketplace?: string },
  ) {
    authorize(context, Permission.ProductWrite);
    authorize(context, Permission.ResearchRead);
    const input = GenerateProvisionalCustomProductProfileInputSchema.parse(rawInput);
    const plan = await this.requireEditablePlan(context, planId);
    const evidence = await this.loadResearchEvidence(context, input.researchItemId);
    const profile = provisionalProfile(plan, evidence, input.targetMarketplace);
    return this.persistProfile(context, planId, profile, {
      expectedBasis: catalogPlanChecksum(plan),
      sources: [
        {
          researchItemId: evidence.item.id,
          snapshotId: evidence.snapshot.id,
          productTypeName: evidence.item.productTypeName,
        },
      ],
    });
  }

  async saveProfile(
    context: TenantContext,
    planId: string,
    rawInput: { profile: CustomProductProfileV1 },
  ) {
    const { profile } = SaveCustomProductProfileInputSchema.parse(rawInput);
    return this.persistProfile(context, planId, profile);
  }

  async completeness(context: TenantContext, planId: string) {
    const plan = await this.requirePlan(context, planId);
    if (!plan.customProductProfile)
      throw this.errors.unprocessable("Create an Amazon Custom product profile before export");
    const evidence = await this.loadPackageEvidence(context, plan.customProductProfile);
    return evaluateCompleteness(plan.customProductProfile, evidence.assets);
  }

  async export(
    context: TenantContext,
    planId: string,
    mode: CustomProductPackageExportMode,
    pinned?: CatalogPreparedOperation,
  ): Promise<CustomProductPackageExport> {
    authorize(context, Permission.AssetRead);
    const plan = await this.requirePlan(context, planId);
    if (
      pinned &&
      (pinned.productPlanId !== planId || pinned.basisChecksum !== catalogPlanChecksum(plan))
    )
      throw this.errors.conflict("Product facts changed after the export input was pinned");
    const profile = plan.customProductProfile;
    if (!profile)
      throw this.errors.unprocessable("Create an Amazon Custom product profile before export");
    if (
      pinned &&
      (new Set(pinned.sources.map((source) => source.researchItemId)).size !==
        new Set(profile.researchItemIds).size ||
        profile.researchItemIds.some(
          (id) => !pinned.sources.some((source) => source.researchItemId === id),
        ))
    )
      throw this.errors.conflict("Pinned research sources do not match the product profile");
    const evidence = await this.loadPackageEvidence(context, profile, pinned);
    const createdAt = pinned?.preparedAt ?? new Date().toISOString();
    const completeness = evaluateCompleteness(profile, evidence.assets, new Date(createdAt));
    if (mode === "release" && completeness.status !== "ready") {
      throw this.errors.unprocessable({
        message:
          "Release export is blocked until all product facts and authorized assets are ready",
        completeness,
      });
    }
    const provisionalClaims = unverifiedFacts(profile).map((fact) => fact.value);
    const packageResult = await buildCustomProductPackage({
      mode,
      planId: plan.id,
      tenantId: context.tenantId,
      targetMarketplace: profile.targetMarketplace?.value ?? "amazon.com",
      policyVersion: POLICY_VERSION,
      createdBy: context.userId,
      createdAt,
      product: {
        planId: plan.id,
        name: plan.name,
        ...(plan.description ? { description: plan.description } : {}),
        profile,
      },
      customization: {
        schemaVersion: "1.0",
        definition: plan.customization,
        surfaces: profile.surfaces,
      },
      competitors: evidence.competitors,
      reviewInsights: evidence.reviewInsights,
      brandStyle: {
        status: profile.colors.length || profile.prohibitedElements.length ? "provided" : "missing",
        styleKeywords: [],
        colors: profile.colors
          .map((color) => color.value)
          .filter((color) => /^#[0-9a-f]{6}$/i.test(color)),
        prohibitedElements: profile.prohibitedElements,
      },
      claims: {
        verifiedClaims: profile.approvedClaims,
        provisionalClaims,
        prohibitedClaims: profile.prohibitedClaims,
        evidenceNotes: [
          "competitor_reference and inferred_from_research values are draft inputs only",
          "Amazon Studio must not promote unverified values into publishable claims",
        ],
      },
      completeness,
      assets: evidence.assets,
      assetFiles: evidence.assetFiles,
    });
    return {
      bytes: packageResult.bytes,
      sha256: packageResult.sha256,
      fileName: `${safeName(profile.sku?.value ?? plan.name)}-amazon-custom-product.zip`,
      completeness,
    };
  }

  async prepareOperation(
    tx: TenantTransaction,
    context: TenantContext,
    planId: string,
    operation: "profile" | "package",
    raw: Record<string, unknown>,
    operationId = createEntityId(),
  ): Promise<CatalogPreparedOperation> {
    context = await currentCatalogContext(tx, context);
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.ProductWrite);
    const parameters = CatalogOperationParametersSchema.parse(raw);
    const [plan] = await tx
      .select()
      .from(productPlans)
      .where(eq(productPlans.id, planId))
      .limit(1)
      .for("share");
    if (!plan) throw this.errors.notFound("Product plan not found");
    this.requirePlanScope(context, plan);
    authorize(context, Permission.ProductWrite, { ownerId: plan.createdBy, teamId: plan.teamId });
    if (plan.status === "archived")
      throw this.errors.conflict("Archived product plans cannot execute capabilities");
    const sourceIds =
      operation === "profile"
        ? parameters.researchItemId
          ? [parameters.researchItemId]
          : (plan.customProductProfile?.researchItemIds ?? [])
        : (plan.customProductProfile?.researchItemIds ?? []);
    const sources: CatalogPreparedOperation["sources"] = [];
    if (operation === "profile" || sourceIds.length) authorize(context, Permission.ResearchRead);
    if (operation === "profile" && parameters.researchSnapshotId) {
      const [snapshot] = await tx
        .select()
        .from(captureSnapshots)
        .where(eq(captureSnapshots.id, parameters.researchSnapshotId))
        .limit(1);
      if (
        !snapshot ||
        (parameters.researchItemId && snapshot.researchItemId !== parameters.researchItemId)
      )
        throw this.errors.notFound("Research snapshot does not match the selected source");
      sources.push({
        researchItemId: snapshot.researchItemId,
        snapshotId: snapshot.id,
        productTypeName: null,
      });
    } else {
      if (operation === "profile" && sourceIds.length !== 1)
        throw this.errors.unprocessable(
          "Select exactly one research snapshot for provisional facts",
        );
      for (const id of sourceIds) {
        const [snapshot] = await tx
          .select()
          .from(captureSnapshots)
          .where(eq(captureSnapshots.researchItemId, id))
          .orderBy(desc(captureSnapshots.capturedAt))
          .limit(1);
        if (!snapshot) throw this.errors.notFound("Research capture snapshot not found");
        sources.push({ researchItemId: id, snapshotId: snapshot.id, productTypeName: null });
      }
    }
    for (const source of sources) {
      const [item] = await tx
        .select()
        .from(researchItems)
        .where(eq(researchItems.id, source.researchItemId))
        .limit(1);
      if (!item || item.archivedAt) throw this.errors.notFound("Research source is unavailable");
      source.productTypeName = item.productTypeName;
      if (
        permissionScope(context, Permission.ResearchRead) !== "tenant" &&
        item.ownerUserId !== context.userId
      )
        throw new ForbiddenError(Permission.ResearchRead, "outside_data_scope");
    }
    const assets: CatalogPreparedOperation["assets"] = [];
    if (operation === "package") {
      authorize(context, Permission.AssetRead);
      if (!plan.customProductProfile)
        throw this.errors.unprocessable("Create a product profile before exporting a package");
      for (const id of new Set(
        plan.customProductProfile.assetAssignments.map((assignment) => assignment.assetId),
      )) {
        const [asset] = await tx.select().from(assetFiles).where(eq(assetFiles.id, id)).limit(1);
        if (!asset || asset.deletedAt)
          throw this.errors.notFound("Assigned product asset is unavailable");
        assets.push(assetPin(asset));
      }
    }
    const times = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
    return CatalogPreparedOperationSchema.parse({
      schemaVersion: 1,
      operation,
      operationId,
      productPlanId: planId,
      basisChecksum: catalogPlanChecksum(plan),
      preparedAt: new Date(times[0]!.now).toISOString(),
      targetMarketplace:
        parameters.targetMarketplace ??
        plan.customProductProfile?.targetMarketplace?.value ??
        "amazon.com",
      mode: parameters.mode ?? "draft",
      sources,
      assets,
    });
  }

  async executePreparedProfile(
    context: TenantContext,
    raw: CatalogPreparedOperation,
    guard: CatalogExecutionGuard,
  ) {
    authorize(context, Permission.ProductWrite);
    authorize(context, Permission.ResearchRead);
    const input = CatalogPreparedOperationSchema.parse(raw);
    if (input.operation !== "profile" || input.sources.length !== 1)
      throw this.errors.unprocessable("Provisional facts require one pinned research source");
    await this.withCurrentTenant(this.database.db, context, guard);
    await this.requirePlan(context, input.productPlanId);
    const previous = await this.receipt(context, input.operationId);
    if (previous)
      return this.profileReceipt(previous, input.productPlanId, catalogFingerprint(input));
    const plan = await this.requireEditablePlan(context, input.productPlanId);
    const source = input.sources[0]!;
    const evidence = await this.loadResearchEvidence(
      context,
      source.researchItemId,
      source.snapshotId,
    );
    evidence.item = { ...evidence.item, productTypeName: source.productTypeName };
    const profile = provisionalProfile(
      plan,
      evidence,
      input.targetMarketplace,
      new Date(input.preparedAt),
    );
    return this.persistProfile(context, input.productPlanId, profile, {
      operationId: input.operationId,
      inputChecksum: catalogFingerprint(input),
      expectedBasis: input.basisChecksum,
      sources: input.sources,
      guard,
    });
  }

  async executePreparedExport(
    context: TenantContext,
    raw: CatalogPreparedOperation,
    guard: CatalogExecutionGuard,
  ) {
    authorize(context, Permission.ProductWrite);
    authorize(context, Permission.AssetRead);
    const input = CatalogPreparedOperationSchema.parse(raw),
      checksum = catalogFingerprint(input);
    if (input.operation !== "package")
      throw this.errors.unprocessable("A pinned package operation is required");
    await this.withCurrentTenant(this.database.db, context, guard);
    await this.requirePlan(context, input.productPlanId);
    const previous = await this.receipt(context, input.operationId);
    if (previous) {
      if (
        previous.productPlanId !== input.productPlanId ||
        previous.operation !== "package" ||
        previous.inputChecksum !== checksum
      )
        throw this.errors.conflict("Catalog operation identity belongs to another input");
      return { receiptId: previous.id, ...previous.result, sha256: previous.outputChecksum };
    }
    const result = await this.export(context, input.productPlanId, input.mode, input);
    await this.withCurrentTenant(this.database.db, context, guard);
    const stored = await this.storage.putPrivate(context, {
      body: result.bytes,
      domain: "authorized",
      fileName: "product-package.zip",
      mediaType: "application/zip",
    });
    if (stored.checksumSha256 !== result.sha256)
      throw this.errors.conflict("Product package storage checksum mismatch");
    return this.withCurrentTenant(this.database.db, context, async (tx, currentContext) => {
      context = currentContext;
      await guard(tx);
      const [plan] = await tx
        .select()
        .from(productPlans)
        .where(eq(productPlans.id, input.productPlanId))
        .for("share");
      if (!plan || catalogPlanChecksum(plan) !== input.basisChecksum)
        throw this.errors.conflict("Product facts changed before package commit");
      for (const pin of input.assets) {
        const [current] = await tx
          .select()
          .from(assetFiles)
          .where(eq(assetFiles.id, pin.id))
          .for("share");
        if (
          !current ||
          current.deletedAt ||
          catalogFingerprint(assetPin(current)) !== catalogFingerprint(pin)
        )
          throw this.errors.conflict("Product asset changed before package commit");
      }
      const [existing] = await tx
        .select()
        .from(catalogOperationReceipts)
        .where(eq(catalogOperationReceipts.id, input.operationId));
      if (existing) {
        if (
          existing.inputChecksum !== checksum ||
          existing.operation !== "package" ||
          existing.productPlanId !== input.productPlanId
        )
          throw this.errors.conflict("Catalog operation identity changed");
        return { receiptId: existing.id, ...existing.result, sha256: existing.outputChecksum };
      }
      const payload = {
        kind: "package",
        fileName: result.fileName,
        objectKey: stored.objectKey,
        sha256: result.sha256,
        byteSize: result.bytes.byteLength,
        mode: input.mode,
        sources: input.sources,
        assets: input.assets,
        completeness: result.completeness,
      };
      await tx.insert(catalogOperationReceipts).values({
        id: input.operationId,
        tenantId: context.tenantId,
        productPlanId: input.productPlanId,
        operation: "package",
        inputChecksum: checksum,
        outputChecksum: result.sha256,
        result: payload,
        createdBy: context.userId,
      });
      return { receiptId: input.operationId, ...payload };
    });
  }

  private async receipt(context: TenantContext, id: string) {
    return this.withCurrentTenant(this.database.db, context, async (tx, currentContext) => {
      context = currentContext;
      return (
        await tx
          .select()
          .from(catalogOperationReceipts)
          .where(eq(catalogOperationReceipts.id, id))
          .limit(1)
      )[0];
    });
  }

  async assertPreparedCurrent(
    tx: TenantTransaction,
    context: TenantContext,
    input: CatalogPreparedOperation,
    producedProfileChecksum?: string,
  ) {
    context = await currentCatalogContext(tx, context);
    authorize(context, Permission.ProductRead);
    const [plan] = await tx
      .select()
      .from(productPlans)
      .where(eq(productPlans.id, input.productPlanId))
      .limit(1);
    if (!plan || plan.status === "archived")
      throw this.errors.notFound("Product plan is unavailable");
    this.requirePlanScope(context, plan);
    if (
      producedProfileChecksum
        ? catalogFingerprint(plan.customProductProfile) !== producedProfileChecksum
        : catalogPlanChecksum(plan) !== input.basisChecksum
    )
      throw this.errors.conflict("Product facts changed during capability execution");
    for (const source of input.sources) {
      authorize(context, Permission.ResearchRead);
      const [item] = await tx
        .select()
        .from(researchItems)
        .where(eq(researchItems.id, source.researchItemId))
        .limit(1);
      if (
        !item ||
        item.archivedAt ||
        (permissionScope(context, Permission.ResearchRead) !== "tenant" &&
          item.ownerUserId !== context.userId)
      )
        throw this.errors.conflict("Pinned research source is no longer available");
    }
    for (const pin of input.assets) {
      authorize(context, Permission.AssetRead);
      const [asset] = await tx.select().from(assetFiles).where(eq(assetFiles.id, pin.id)).limit(1);
      if (
        !asset ||
        asset.deletedAt ||
        catalogFingerprint(assetPin(asset)) !== catalogFingerprint(pin)
      )
        throw this.errors.conflict("Pinned product asset is no longer available");
    }
  }

  async getOperationReceipt(context: TenantContext, planId: string, id: string) {
    await this.requirePlan(context, planId);
    const row = await this.receipt(context, id);
    if (!row || row.productPlanId !== planId)
      throw this.errors.notFound("Catalog operation receipt not found");
    if (Array.isArray(row.result.sources) && row.result.sources.length) {
      authorize(context, Permission.ResearchRead);
      for (const source of row.result.sources as CatalogPreparedOperation["sources"])
        await this.loadResearchEvidence(context, source.researchItemId, source.snapshotId);
    }
    const result = { ...row.result };
    delete result.objectKey;
    return {
      id: row.id,
      operation: row.operation,
      inputChecksum: row.inputChecksum,
      outputChecksum: row.outputChecksum,
      result,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async authorizedPackageReceipt(context: TenantContext, planId: string, id: string) {
    authorize(context, Permission.AssetRead);
    const plan = await this.requirePlan(context, planId),
      row = await this.receipt(context, id);
    if (
      !row ||
      row.productPlanId !== planId ||
      row.operation !== "package" ||
      typeof row.result.objectKey !== "string"
    )
      throw this.errors.notFound("Product package receipt not found");
    if (plan.status === "archived")
      throw this.errors.conflict("Archived product packages cannot mint a new read URL");
    await this.withCurrentTenant(this.database.db, context, async (tx, currentContext) => {
      context = currentContext;
      if (Array.isArray(row.result.sources) && row.result.sources.length) {
        authorize(context, Permission.ResearchRead);
        for (const source of row.result.sources as CatalogPreparedOperation["sources"]) {
          const [item] = await tx
            .select()
            .from(researchItems)
            .where(eq(researchItems.id, source.researchItemId))
            .limit(1);
          if (
            !item ||
            item.archivedAt ||
            (permissionScope(context, Permission.ResearchRead) !== "tenant" &&
              item.ownerUserId !== context.userId)
          )
            throw this.errors.conflict("Product package research authorization changed");
        }
      }
      const pins = row.result.assets;
      if (!Array.isArray(pins))
        throw this.errors.conflict("Product package asset evidence is missing");
      for (const raw of pins) {
        const pin = raw as CatalogPreparedOperation["assets"][number];
        const [asset] = await tx
          .select()
          .from(assetFiles)
          .where(eq(assetFiles.id, pin.id))
          .limit(1);
        if (
          !asset ||
          asset.deletedAt ||
          catalogFingerprint(assetPin(asset)) !== catalogFingerprint(pin)
        )
          throw this.errors.conflict("Product package asset authorization changed");
      }
    });
    return row;
  }

  async readOperationPackage(context: TenantContext, planId: string, id: string) {
    const row = await this.authorizedPackageReceipt(context, planId, id);
    const url = await this.storage.signRead(
      context,
      {
        id,
        tenantId: context.tenantId,
        assetDomain: "authorized",
        objectKey: String(row.result.objectKey),
      },
      { requiredDomain: "authorized", expiresInSeconds: 60 },
    );
    await recordAuditEvent(this.database, context, {
      action: "catalog.package.read_url.create",
      resourceType: "catalog_operation_receipt",
      resourceId: id,
      result: "success",
      metadata: { planId, checksum: row.outputChecksum },
    });
    return { url, expiresInSeconds: 60, fileName: row.result.fileName, sha256: row.outputChecksum };
  }

  async downloadOperationPackage(context: TenantContext, planId: string, id: string) {
    const row = await this.authorizedPackageReceipt(context, planId, id);
    const bytes = await this.storage.readPrivate(
      context,
      {
        id,
        tenantId: context.tenantId,
        assetDomain: "authorized",
        objectKey: String(row.result.objectKey),
      },
      { requiredDomain: "authorized" },
    );
    if (checksumSha256(bytes) !== row.outputChecksum)
      throw this.errors.conflict("Stored product package checksum no longer matches its receipt");
    await this.authorizedPackageReceipt(context, planId, id);
    await recordAuditEvent(this.database, context, {
      action: "catalog.package.download",
      resourceType: "catalog_operation_receipt",
      resourceId: id,
      result: "success",
      metadata: { planId, checksum: row.outputChecksum },
    });
    return {
      bytes,
      fileName: String(row.result.fileName ?? "custom-product-package.zip"),
      sha256: row.outputChecksum,
    };
  }

  private profileReceipt(
    receipt: typeof catalogOperationReceipts.$inferSelect,
    planId: string,
    inputChecksum: string,
  ) {
    if (
      receipt.productPlanId !== planId ||
      receipt.operation !== "profile" ||
      receipt.inputChecksum !== inputChecksum
    )
      throw this.errors.conflict("Catalog operation identity belongs to another input");
    return {
      planId,
      profile: CustomProductProfileV1Schema.parse(receipt.result.profile),
      receiptId: receipt.id,
    };
  }

  private async persistProfile(
    context: TenantContext,
    planId: string,
    profile: CustomProductProfileV1,
    options: {
      operationId?: string;
      inputChecksum?: string;
      expectedBasis?: string;
      sources?: CatalogPreparedOperation["sources"];
      guard?: CatalogExecutionGuard;
    } = {},
  ) {
    authorize(context, Permission.ProductWrite);
    authorize(context, Permission.ProductRead);
    const operationId = options.operationId ?? createEntityId(),
      inputChecksum = options.inputChecksum ?? catalogFingerprint({ planId, profile });
    return this.withCurrentTenant(this.database.db, context, async (tx, currentContext) => {
      context = currentContext;
      if (options.guard) await options.guard(tx);
      const [plan] = await tx
        .select()
        .from(productPlans)
        .where(eq(productPlans.id, planId))
        .for("update");
      if (!plan) throw this.errors.notFound("Product plan not found");
      this.requirePlanScope(context, plan);
      authorize(context, Permission.ProductWrite, { ownerId: plan.createdBy, teamId: plan.teamId });
      await assertCatalogUnambiguousPlan(tx, planId, this.errors.conflict);
      const [previous] = await tx
        .select()
        .from(catalogOperationReceipts)
        .where(eq(catalogOperationReceipts.id, operationId));
      if (previous) return this.profileReceipt(previous, planId, inputChecksum);
      if (!["researching", "approved", "developing"].includes(plan.status))
        throw this.errors.conflict("Product facts cannot be edited in the current plan state");
      if (options.expectedBasis && options.expectedBasis !== catalogPlanChecksum(plan))
        throw this.errors.conflict("Product facts changed after the input was pinned");
      await tx.insert(catalogOperationReceipts).values({
        id: operationId,
        tenantId: context.tenantId,
        productPlanId: planId,
        operation: "profile",
        inputChecksum,
        outputChecksum: catalogFingerprint(profile),
        createdBy: context.userId,
        result: { kind: "profile", profile, sources: options.sources ?? [] },
      });
      await tx
        .update(productPlans)
        .set({ customProductProfile: profile, updatedAt: sql`clock_timestamp()` })
        .where(eq(productPlans.id, planId));
      return { planId, profile, receiptId: operationId };
    });
  }

  private async withCurrentTenant<T>(
    database: DatabaseConnection["db"],
    context: TenantContext,
    operation: (tx: TenantTransaction, current: TenantContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTenant(database, context, async (tx) =>
        operation(tx, await currentCatalogContext(tx, context)),
      );
    } catch (error) {
      if (error instanceof CatalogAuthorityChangedError) throw this.errors.conflict(error.message);
      throw error;
    }
  }

  private requirePlanScope(context: TenantContext, plan: typeof productPlans.$inferSelect) {
    authorize(context, Permission.ProductRead, { ownerId: plan.createdBy, teamId: plan.teamId });
  }

  private async requirePlan(context: TenantContext, planId: string) {
    authorize(context, Permission.ProductRead);
    const [plan] = await this.withCurrentTenant(
      this.database.db,
      context,
      async (tx, currentContext) => {
        context = currentContext;
        return tx.select().from(productPlans).where(eq(productPlans.id, planId)).limit(1);
      },
    );
    if (!plan) throw this.errors.notFound("Product plan not found");
    this.requirePlanScope(context, plan);
    return plan;
  }

  private async requireEditablePlan(context: TenantContext, planId: string) {
    const plan = await this.requirePlan(context, planId);
    authorize(context, Permission.ProductWrite, { ownerId: plan.createdBy, teamId: plan.teamId });
    if (!["researching", "approved", "developing"].includes(plan.status)) {
      throw this.errors.conflict(
        "Amazon Custom product facts can only be edited while the plan is researching or developing",
      );
    }
    return plan;
  }

  private async loadResearchEvidence(
    context: TenantContext,
    researchItemId: string,
    snapshotId?: string,
  ): Promise<ResearchEvidence> {
    const result = await this.withCurrentTenant(
      this.database.db,
      context,
      async (tx, currentContext) => {
        context = currentContext;
        const [item] = await tx
          .select()
          .from(researchItems)
          .where(eq(researchItems.id, researchItemId))
          .limit(1);
        const [snapshot] = await tx
          .select()
          .from(captureSnapshots)
          .where(
            and(
              eq(captureSnapshots.researchItemId, researchItemId),
              snapshotId ? eq(captureSnapshots.id, snapshotId) : undefined,
            ),
          )
          .orderBy(desc(captureSnapshots.capturedAt))
          .limit(1);
        return { item, snapshot };
      },
    );
    if (!result.item || result.item.archivedAt || !result.snapshot)
      throw this.errors.notFound("Research item or capture snapshot not found");
    authorize(context, Permission.ResearchRead);
    if (
      permissionScope(context, Permission.ResearchRead) !== "tenant" &&
      result.item.ownerUserId !== context.userId
    )
      throw new ForbiddenError(Permission.ResearchRead, "outside_data_scope");
    return {
      item: result.item,
      snapshot: result.snapshot,
      draft: CaptureDraftSchema.parse(result.snapshot.draft),
    };
  }

  private async loadPackageEvidence(
    context: TenantContext,
    profile: CustomProductProfileV1,
    pinned?: CatalogPreparedOperation,
  ) {
    const researchEvidence = await Promise.all(
      profile.researchItemIds.map((id) =>
        this.loadResearchEvidence(
          context,
          id,
          pinned?.sources.find((source) => source.researchItemId === id)?.snapshotId,
        ),
      ),
    );
    const competitors = researchEvidence.map(toCompetitor);
    const referenceAssets = researchEvidence.flatMap(toReferenceAssets);
    const reviews = researchEvidence.flatMap((evidence) => evidence.draft.reviews);
    const reviewInsights = {
      status: reviews.length ? ("available" as const) : ("unavailable" as const),
      collectedReviewCount: reviews.length,
      reportedReviewCount: researchEvidence.reduce(
        (count, evidence) => count + (evidence.draft.reviewCount ?? 0),
        0,
      ),
      purchaseMotivations: profile.targetAudiences.map((fact) => fact.value),
      painPoints: [],
      notes: reviews.length
        ? [
            "Review text remains research evidence and is not copied into publishable Listing content.",
          ]
        : ["No first-party review text was available in the selected capture snapshot."],
    };

    const assignments = profile.assetAssignments;
    const assignedRows = assignments.length
      ? await this.withCurrentTenant(this.database.db, context, async (tx, currentContext) => {
          context = currentContext;
          return tx
            .select()
            .from(assetFiles)
            .where(
              inArray(
                assetFiles.id,
                assignments.map((assignment) => assignment.assetId),
              ),
            );
        })
      : [];
    const assignedById = new Map(assignedRows.map((asset) => [asset.id, asset]));
    const authorizedAssets: CustomProductPackageAsset[] = [];
    const assetFileEntries: CustomProductPackageAssetFile[] = [];
    for (const assignment of assignments) {
      const asset = assignedById.get(assignment.assetId);
      if (!asset) continue;
      if (asset.deletedAt) throw this.errors.notFound("Assigned product asset is unavailable");
      const currentPin = assetPin(asset),
        expected = pinned?.assets.find((pin) => pin.id === asset.id);
      if (pinned && (!expected || catalogFingerprint(expected) !== catalogFingerprint(currentPin)))
        throw this.errors.conflict("Product asset changed after the input was pinned");
      const exportable =
        asset.assetDomain === "authorized" &&
        asset.rightsStatus === "approved" &&
        !["competitor", "customer_provided"].includes(currentPin.rightsSourceKind ?? "");
      authorizedAssets.push({
        id: asset.id,
        fileName: asset.fileName,
        role: assignment.role,
        rightsStatus: exportable ? "owned" : "unverified",
        usePolicy: exportable ? "generation_allowed" : "blocked",
        mediaType: asset.mediaType,
        sha256: asset.checksumSha256,
        byteSize: asset.byteSize,
        includedInPackage: exportable,
      });
      if (exportable) {
        const bytes = await this.storage.readPrivate(
          context,
          {
            id: asset.id,
            tenantId: asset.tenantId,
            assetDomain: "authorized",
            objectKey: asset.objectKey,
          },
          { requiredDomain: "authorized" },
        );
        if (checksumSha256(bytes) !== asset.checksumSha256 || bytes.byteLength !== asset.byteSize)
          throw this.errors.conflict("Product asset bytes do not match their pinned metadata");
        assetFileEntries.push({
          path: `assets/${roleDirectory(assignment.role)}/${safeName(asset.fileName)}`,
          mediaType: asset.mediaType,
          bytes,
        });
      }
    }
    return {
      competitors,
      reviewInsights,
      assets: [...authorizedAssets, ...referenceAssets],
      assetFiles: assetFileEntries,
    };
  }
}

interface ResearchEvidence {
  item: typeof researchItems.$inferSelect;
  snapshot: typeof captureSnapshots.$inferSelect;
  draft: CaptureDraft;
}

export function provisionalProfile(
  plan: typeof productPlans.$inferSelect,
  evidence: ResearchEvidence,
  targetMarketplace: string,
  now = new Date(),
): CustomProductProfileV1 {
  const description =
    evidence.draft.contentBlocks.find((block) => block.kind === "description")?.text ?? "";
  const sourceUrl = evidence.item.normalizedUrl;
  const competitor = (value: string, evidencePath: string): SourcedTextFact => ({
    value,
    source: "competitor_reference",
    verificationStatus: "unverified",
    sourceUrl,
    evidencePath,
  });
  const inferred = (value: string, evidencePath: string): SourcedTextFact => ({
    value,
    source: "inferred_from_research",
    verificationStatus: "unverified",
    sourceUrl,
    evidencePath,
  });
  const sizeVariant = evidence.draft.variants.find((variant) => /size/i.test(variant.label));
  const material = /3mm wood and acrylic/i.test(description) ? ["3mm wood and acrylic"] : [];
  const process = /\b(?:single|double)[- ]side(?:d)? printed\b/i.exec(description)?.[0];
  const externalId = evidence.draft.externalId ?? evidence.item.id.slice(0, 12);
  return CustomProductProfileV1Schema.parse({
    schemaVersion: "1.0",
    sku: inferred(`DRAFT-${externalId}`, "draft.externalId"),
    targetMarketplace: {
      value: targetMarketplace,
      source: "seller_provided",
      verificationStatus: "unverified",
      notes: "Selected for the Amazon Custom draft workflow.",
    },
    ...(evidence.item.productTypeName
      ? { productType: inferred(evidence.item.productTypeName, "researchItem.classification") }
      : {}),
    materials: material.map((value) => competitor(value, "draft.contentBlocks.description")),
    colors: [],
    sizeOptions: (sizeVariant?.options ?? []).map((option) =>
      competitor(normalizeCompetitorOptionLabel(option.label), "draft.variants.Size"),
    ),
    packageContents: [],
    manufacturingProcess: process
      ? competitor(process, "draft.contentBlocks.description")
      : undefined,
    targetAudiences: [],
    sellingPoints: [],
    surfaces: [
      {
        key: "front",
        label: "Front",
        fieldKeys: plan.customization.fields.map((field) => field.key).slice(0, 15),
        ...(process ? { process } : {}),
        source: "seller_provided",
        verificationStatus: "unverified",
        evidencePath: "productPlan.customization.fields",
        notes:
          "Draft surface placeholder; the actual manufacturing surface and area require seller confirmation.",
      },
    ],
    approvedClaims: [],
    prohibitedClaims: [
      "Do not publish competitor claims such as nontoxic, odor-free, durable, or vivid color without seller evidence.",
    ],
    prohibitedElements: ["Competitor artwork, photos, shop names, logos, and exact Listing copy"],
    researchItemIds: [evidence.item.id],
    assetAssignments: [],
    updatedAt: now.toISOString(),
  });
}

function toCompetitor(evidence: ResearchEvidence): CustomProductPackageCompetitor {
  return {
    researchItemId: evidence.item.id,
    snapshotId: evidence.snapshot.id,
    platform: evidence.draft.platform,
    marketplace: evidence.draft.marketplace,
    sourceUrl: evidence.item.normalizedUrl,
    title: evidence.draft.title ?? evidence.item.latestTitle ?? "Untitled competitor",
    capturedAt: evidence.draft.capturedAt,
    captureStatus: evidence.draft.captureStatus,
    ...(evidence.draft.price ? { price: evidence.draft.price } : {}),
    ...(evidence.draft.rating !== null ? { rating: evidence.draft.rating } : {}),
    ...(evidence.draft.favoriteCount !== null
      ? { favoriteCount: evidence.draft.favoriteCount }
      : {}),
    tags: evidence.draft.ehuntAnalysis?.tags.map((tag) => tag.label) ?? [],
  };
}

function toReferenceAssets(evidence: ResearchEvidence): CustomProductPackageAsset[] {
  return evidence.draft.media.map((media, index) => ({
    id: `${evidence.snapshot.id}:${media.id}`,
    fileName: `competitor-${String(index + 1).padStart(2, "0")}.${media.kind === "video" ? "mp4" : "jpg"}`,
    role: "competitor_reference",
    rightsStatus: "reference_only",
    usePolicy: "analysis_only",
    mediaType: media.kind === "video" ? "video/mp4" : "image/jpeg",
    sourceUrl: media.sourceUrl,
    includedInPackage: false,
  }));
}

export function evaluateCompleteness(
  profile: CustomProductProfileV1,
  assets: CustomProductPackageAsset[],
  now = new Date(),
): CustomProductPackageCompleteness {
  const issues: CustomProductPackageCompleteness["issues"] = [];
  const blocker = (code: string, path: string, message: string) =>
    issues.push({ code, severity: "blocker" as const, path, message });
  const warning = (code: string, path: string, message: string) =>
    issues.push({ code, severity: "warning" as const, path, message });
  if (!profile.sku) blocker("missing_sku", "product.profile.sku", "SKU is required.");
  if (!profile.targetMarketplace)
    blocker(
      "missing_marketplace",
      "product.profile.targetMarketplace",
      "Target Amazon marketplace is required.",
    );
  if (!profile.productType)
    blocker("missing_product_type", "product.profile.productType", "Product type is required.");
  if (!profile.brand)
    blocker("missing_brand", "product.profile.brand", "Brand is required for a release package.");
  if (!profile.materials.length)
    blocker("missing_material", "product.profile.materials", "At least one material is required.");
  if (!profile.sizeOptions.length)
    blocker(
      "missing_size",
      "product.profile.sizeOptions",
      "At least one finished size is required.",
    );
  if (!profile.packageQuantity)
    blocker(
      "missing_package_quantity",
      "product.profile.packageQuantity",
      "Package quantity is required.",
    );
  if (!profile.packageContents.length)
    blocker(
      "missing_package_contents",
      "product.profile.packageContents",
      "Package contents are required.",
    );
  if (!profile.manufacturingProcess)
    blocker(
      "missing_process",
      "product.profile.manufacturingProcess",
      "Manufacturing process is required.",
    );
  if (!profile.surfaces.length)
    blocker(
      "missing_surface",
      "product.profile.surfaces",
      "At least one customization surface is required.",
    );
  profile.surfaces.forEach((surface, index) => {
    if (!surface.areaMm)
      blocker(
        "missing_custom_area",
        `product.profile.surfaces.${index}.areaMm`,
        "Customization area width and height in millimeters are required.",
      );
    if (!surface.fieldKeys.length)
      blocker(
        "missing_surface_fields",
        `product.profile.surfaces.${index}.fieldKeys`,
        "Each customization surface must contain at least one field.",
      );
  });
  const facts = allFacts(profile);
  const unverified = facts.filter((fact) => fact.verificationStatus !== "confirmed");
  if (unverified.length)
    warning(
      "unverified_facts",
      "product.profile",
      `${unverified.length} product facts still require seller confirmation.`,
    );
  const authorizedAssetCount = assets.filter(
    (asset) => asset.includedInPackage && ["owned", "licensed"].includes(asset.rightsStatus),
  ).length;
  const referenceOnlyAssetCount = assets.filter(
    (asset) => asset.rightsStatus === "reference_only",
  ).length;
  if (!authorizedAssetCount)
    blocker(
      "missing_authorized_assets",
      "assets",
      "At least one rights-approved real product or finished sample asset is required.",
    );
  const blockerCount = issues.filter((issue) => issue.severity === "blocker").length;
  const score = Math.max(
    0,
    Math.min(
      100,
      100 - blockerCount * 9 - issues.filter((issue) => issue.severity === "warning").length * 4,
    ),
  );
  return CustomProductPackageCompletenessSchema.parse({
    status: blockerCount ? "blocked" : issues.length ? "partial" : "ready",
    score,
    issues,
    confirmedFactCount: facts.length - unverified.length,
    unverifiedFactCount: unverified.length,
    authorizedAssetCount,
    referenceOnlyAssetCount,
    evaluatedAt: now.toISOString(),
  });
}

function allFacts(profile: CustomProductProfileV1) {
  return [
    profile.sku,
    profile.targetMarketplace,
    profile.productType,
    profile.brand,
    ...profile.materials,
    ...profile.colors,
    ...profile.sizeOptions,
    profile.packageQuantity,
    ...profile.packageContents,
    profile.manufacturingProcess,
    ...profile.targetAudiences,
    ...profile.sellingPoints,
    ...profile.surfaces,
  ].filter((fact): fact is NonNullable<typeof fact> => Boolean(fact));
}

function unverifiedFacts(profile: CustomProductProfileV1): SourcedTextFact[] {
  return allFacts(profile).filter(
    (fact): fact is SourcedTextFact =>
      "value" in fact && typeof fact.value === "string" && fact.verificationStatus !== "confirmed",
  );
}

function roleDirectory(role: CustomProductPackageAsset["role"]) {
  return {
    real_product: "real-product",
    finished_sample: "finished-samples",
    packaging: "packaging",
    print_template: "print-templates",
    style_reference: "style-reference",
    competitor_reference: "competitor-reference",
  }[role];
}

function safeName(input: string) {
  return (
    input
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 160) || "custom-product"
  );
}

export function normalizeCompetitorOptionLabel(input: string) {
  return input.replace(/\s*\(\s*\$[\d,.]+\s*\)\s*$/i, "").trim();
}

export function catalogPlanChecksum(plan: typeof productPlans.$inferSelect): string {
  return catalogFingerprint({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    status: plan.status,
    customization: plan.customization,
    profile: plan.customProductProfile,
  });
}

function assetPin(
  asset: typeof assetFiles.$inferSelect,
): CatalogPreparedOperation["assets"][number] {
  return {
    id: asset.id,
    version: asset.version,
    checksumSha256: asset.checksumSha256,
    domain: asset.assetDomain,
    rightsStatus: asset.rightsStatus,
    rightsSourceKind: (asset.rightsMetadata as { source?: { kind?: string } }).source?.kind ?? null,
    fileName: asset.fileName,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
  };
}
