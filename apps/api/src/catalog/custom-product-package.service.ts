import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CaptureDraftSchema, type CaptureDraft, type TenantContext } from "@yummyai/contracts";
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
  productPlans,
  researchItems,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import {
  buildCustomProductPackage,
  type CustomProductPackageAssetFile,
  type Storage,
} from "@yummyai/storage";
import { and, desc, eq, inArray } from "drizzle-orm";

import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";

const POLICY_VERSION = "amazon-custom-product-package-2026-07-31";

export interface CustomProductPackageExport {
  bytes: Uint8Array;
  fileName: string;
  sha256: string;
  completeness: CustomProductPackageCompleteness;
}

@Injectable()
export class CustomProductPackageService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
  ) {}

  async generateProvisionalProfile(
    context: TenantContext,
    planId: string,
    rawInput: { researchItemId: string; targetMarketplace?: string },
  ) {
    const input = GenerateProvisionalCustomProductProfileInputSchema.parse(rawInput);
    const plan = await this.requireEditablePlan(context, planId);
    const evidence = await this.loadResearchEvidence(context, input.researchItemId);
    const profile = provisionalProfile(plan, evidence, input.targetMarketplace);
    return this.saveProfile(context, planId, { profile });
  }

  async saveProfile(
    context: TenantContext,
    planId: string,
    rawInput: { profile: CustomProductProfileV1 },
  ) {
    const { profile } = SaveCustomProductProfileInputSchema.parse(rawInput);
    await this.requireEditablePlan(context, planId);
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .update(productPlans)
        .set({ customProductProfile: profile, updatedAt: new Date() })
        .where(and(eq(productPlans.tenantId, context.tenantId), eq(productPlans.id, planId)))
        .returning({
          id: productPlans.id,
          customProductProfile: productPlans.customProductProfile,
        }),
    );
    if (!row?.customProductProfile) throw new NotFoundException("Product plan not found");
    return {
      planId: row.id,
      profile: CustomProductProfileV1Schema.parse(row.customProductProfile),
    };
  }

  async completeness(context: TenantContext, planId: string) {
    const plan = await this.requirePlan(context, planId);
    if (!plan.customProductProfile)
      throw new UnprocessableEntityException(
        "Create an Amazon Custom product profile before export",
      );
    const evidence = await this.loadPackageEvidence(context, plan.customProductProfile);
    return evaluateCompleteness(plan.customProductProfile, evidence.assets);
  }

  async export(
    context: TenantContext,
    planId: string,
    mode: CustomProductPackageExportMode,
  ): Promise<CustomProductPackageExport> {
    authorize(context, Permission.AssetRead);
    const plan = await this.requirePlan(context, planId);
    const profile = plan.customProductProfile;
    if (!profile)
      throw new UnprocessableEntityException(
        "Create an Amazon Custom product profile before export",
      );
    const evidence = await this.loadPackageEvidence(context, profile);
    const completeness = evaluateCompleteness(profile, evidence.assets);
    if (mode === "release" && completeness.status !== "ready") {
      throw new UnprocessableEntityException({
        message:
          "Release export is blocked until all product facts and authorized assets are ready",
        completeness,
      });
    }
    const createdAt = new Date().toISOString();
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

  private async requirePlan(context: TenantContext, planId: string) {
    const [plan] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(productPlans).where(eq(productPlans.id, planId)).limit(1),
    );
    if (!plan) throw new NotFoundException("Product plan not found");
    return plan;
  }

  private async requireEditablePlan(context: TenantContext, planId: string) {
    const plan = await this.requirePlan(context, planId);
    if (!["researching", "approved", "developing"].includes(plan.status)) {
      throw new ConflictException(
        "Amazon Custom product facts can only be edited while the plan is researching or developing",
      );
    }
    return plan;
  }

  private async loadResearchEvidence(
    context: TenantContext,
    researchItemId: string,
  ): Promise<ResearchEvidence> {
    const result = await withTenant(this.database.db, context, async (tx) => {
      const [item] = await tx
        .select()
        .from(researchItems)
        .where(eq(researchItems.id, researchItemId))
        .limit(1);
      const [snapshot] = await tx
        .select()
        .from(captureSnapshots)
        .where(eq(captureSnapshots.researchItemId, researchItemId))
        .orderBy(desc(captureSnapshots.capturedAt))
        .limit(1);
      return { item, snapshot };
    });
    if (!result.item || !result.snapshot)
      throw new NotFoundException("Research item or capture snapshot not found");
    return {
      item: result.item,
      snapshot: result.snapshot,
      draft: CaptureDraftSchema.parse(result.snapshot.draft),
    };
  }

  private async loadPackageEvidence(context: TenantContext, profile: CustomProductProfileV1) {
    const researchEvidence = await Promise.all(
      profile.researchItemIds.map((id) => this.loadResearchEvidence(context, id)),
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
      ? await withTenant(this.database.db, context, (tx) =>
          tx
            .select()
            .from(assetFiles)
            .where(
              inArray(
                assetFiles.id,
                assignments.map((assignment) => assignment.assetId),
              ),
            ),
        )
      : [];
    const assignedById = new Map(assignedRows.map((asset) => [asset.id, asset]));
    const authorizedAssets: CustomProductPackageAsset[] = [];
    const assetFileEntries: CustomProductPackageAssetFile[] = [];
    for (const assignment of assignments) {
      const asset = assignedById.get(assignment.assetId);
      if (!asset) continue;
      const exportable = asset.assetDomain === "authorized" && asset.rightsStatus === "approved";
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

function provisionalProfile(
  plan: typeof productPlans.$inferSelect,
  evidence: ResearchEvidence,
  targetMarketplace: string,
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
  const tags = evidence.draft.ehuntAnalysis?.tags.map((tag) => tag.label) ?? [];
  const material = /3mm wood and acrylic/i.test(description) ? ["3mm wood and acrylic"] : [];
  const process = /single-side printed/i.test(description)
    ? "Single-side printed with a copperplate paper surface"
    : undefined;
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
    productType: inferred(
      evidence.item.productTypeName ?? "Cake Toppers",
      "researchItem.classification",
    ),
    materials: material.map((value) => competitor(value, "draft.contentBlocks.description")),
    colors: [],
    sizeOptions: (sizeVariant?.options ?? []).map((option) =>
      competitor(normalizeCompetitorOptionLabel(option.label), "draft.variants.Size"),
    ),
    packageContents: [],
    manufacturingProcess: process
      ? competitor(process, "draft.contentBlocks.description")
      : undefined,
    targetAudiences: [
      inferred("Milestone birthday shoppers", "draft.title"),
      inferred("Buyers seeking personalized nostalgic photo gifts", "draft.title"),
    ],
    sellingPoints: [
      inferred("Buyer-uploaded photo personalization", "draft.title"),
      inferred("Vintage milestone birthday theme", "draft.title"),
      ...tags.slice(0, 5).map((tag) => inferred(tag, "draft.ehuntAnalysis.tags")),
    ],
    surfaces: [
      {
        key: "front",
        label: "Front",
        fieldKeys: plan.customization.fields.map((field) => field.key).slice(0, 15),
        ...(process ? { process } : {}),
        source: "inferred_from_research",
        verificationStatus: "unverified",
        sourceUrl,
        evidencePath: "draft.contentBlocks.description",
      },
    ],
    approvedClaims: [],
    prohibitedClaims: [
      "Do not publish competitor claims such as nontoxic, odor-free, durable, or vivid color without seller evidence.",
    ],
    prohibitedElements: ["Competitor artwork, photos, shop names, logos, and exact Listing copy"],
    researchItemIds: [evidence.item.id],
    assetAssignments: [],
    updatedAt: new Date().toISOString(),
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
