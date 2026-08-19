import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AssignResearchProductTypeInputSchema,
  type AssignResearchProductTypeInput,
  type CaptureDraft,
  type ResearchClassificationEvidenceSource,
  type ResearchItemClassification,
  type TenantContext,
} from "@yummyai/contracts";
import {
  researchItems,
  researchProductTypeAliases,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, eq, inArray } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

export interface ResearchClassificationCandidate {
  evidenceKey: string;
  evidenceLabel: string;
  evidenceSource: ResearchClassificationEvidenceSource;
}

@Injectable()
export class ResearchClassificationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async suggestFromCapture(
    tx: TenantTransaction,
    context: TenantContext,
    itemId: string,
    draft: CaptureDraft,
    current?: {
      classificationSource: string | null;
      classificationStatus: string;
    },
  ): Promise<void> {
    if (
      current?.classificationStatus === "confirmed" ||
      current?.classificationSource === "manual"
    ) {
      return;
    }
    const candidate = extractResearchClassificationCandidate(draft);
    if (!candidate) return;

    const aliasConditions = and(
      eq(researchProductTypeAliases.tenantId, context.tenantId),
      eq(researchProductTypeAliases.platform, draft.platform),
      eq(researchProductTypeAliases.evidenceSource, candidate.evidenceSource),
      eq(researchProductTypeAliases.evidenceKey, candidate.evidenceKey),
    );
    let [alias] = await tx
      .select()
      .from(researchProductTypeAliases)
      .where(aliasConditions)
      .limit(1);
    if (!alias) {
      await tx
        .insert(researchProductTypeAliases)
        .values({
          tenantId: context.tenantId,
          platform: draft.platform,
          evidenceSource: candidate.evidenceSource,
          evidenceKey: candidate.evidenceKey,
          evidenceLabel: candidate.evidenceLabel,
          productTypeKey: candidate.evidenceKey,
          productTypeName: candidate.evidenceLabel,
          updatedBy: context.userId,
        })
        .onConflictDoNothing();
      [alias] = await tx
        .select()
        .from(researchProductTypeAliases)
        .where(aliasConditions)
        .limit(1);
    }

    await tx
      .update(researchItems)
      .set({
        productTypeKey: alias?.productTypeKey ?? candidate.evidenceKey,
        productTypeName: alias?.productTypeName ?? candidate.evidenceLabel,
        classificationStatus: "suggested",
        classificationSource: candidate.evidenceSource,
        classificationEvidenceSource: candidate.evidenceSource,
        classificationEvidenceKey: candidate.evidenceKey,
        classificationEvidenceLabel: candidate.evidenceLabel,
        classificationUpdatedBy: context.userId,
        classificationUpdatedAt: new Date(),
      })
      .where(eq(researchItems.id, itemId));
  }

  async assign(
    context: TenantContext,
    rawInput: AssignResearchProductTypeInput,
  ): Promise<{
    cascaded: number;
    classification: ResearchItemClassification;
    updated: number;
  }> {
    const input = AssignResearchProductTypeInputSchema.parse(rawInput);
    const productType = input.productTypeName
      ? normalizeResearchProductType(input.productTypeName)
      : null;
    const result = await withTenant(this.database.db, context, async (tx) => {
      const selected = await tx
        .select({
          id: researchItems.id,
          platform: researchItems.platform,
          evidenceKey: researchItems.classificationEvidenceKey,
          evidenceLabel: researchItems.classificationEvidenceLabel,
          evidenceSource: researchItems.classificationEvidenceSource,
        })
        .from(researchItems)
        .where(inArray(researchItems.id, input.itemIds));
      if (selected.length !== input.itemIds.length) {
        throw new NotFoundException("One or more research items were not found");
      }

      const now = new Date();
      await tx
        .update(researchItems)
        .set({
          productTypeKey: productType?.key ?? null,
          productTypeName: productType?.name ?? null,
          classificationStatus: productType ? "confirmed" : "unclassified",
          classificationSource: "manual",
          classificationUpdatedBy: context.userId,
          classificationUpdatedAt: now,
        })
        .where(inArray(researchItems.id, input.itemIds));

      const cascadedIds = new Set<string>();
      if (productType) {
        const aliases = uniqueEvidenceAliases(selected);
        for (const alias of aliases) {
          await tx
            .insert(researchProductTypeAliases)
            .values({
              tenantId: context.tenantId,
              platform: alias.platform,
              evidenceSource: alias.evidenceSource,
              evidenceKey: alias.evidenceKey,
              evidenceLabel: alias.evidenceLabel,
              productTypeKey: productType.key,
              productTypeName: productType.name,
              updatedBy: context.userId,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                researchProductTypeAliases.tenantId,
                researchProductTypeAliases.platform,
                researchProductTypeAliases.evidenceSource,
                researchProductTypeAliases.evidenceKey,
              ],
              set: {
                evidenceLabel: alias.evidenceLabel,
                productTypeKey: productType.key,
                productTypeName: productType.name,
                updatedBy: context.userId,
                updatedAt: now,
              },
            });
          const cascaded = await tx
            .update(researchItems)
            .set({
              productTypeKey: productType.key,
              productTypeName: productType.name,
              classificationSource: alias.evidenceSource,
              classificationUpdatedBy: context.userId,
              classificationUpdatedAt: now,
            })
            .where(
              and(
                eq(researchItems.platform, alias.platform),
                eq(researchItems.classificationStatus, "suggested"),
                eq(researchItems.classificationEvidenceSource, alias.evidenceSource),
                eq(researchItems.classificationEvidenceKey, alias.evidenceKey),
              ),
            )
            .returning({ id: researchItems.id });
          cascaded.forEach((entry) => cascadedIds.add(entry.id));
        }
      }

      const result = {
        cascaded: cascadedIds.size,
        classification: {
          productType,
          status: productType ? ("confirmed" as const) : ("unclassified" as const),
          source: "manual" as const,
          evidenceSource: null,
          evidenceLabel: null,
          updatedAt: now.toISOString(),
        },
        updated: selected.length,
      };
      await this.audit.recordInTransaction(tx, context, {
        action: "research_item.product_type.assign",
        resourceType: "research_item",
        resourceId: input.itemIds[0],
        result: "success",
        metadata: {
          cascaded: result.cascaded,
          productTypeKey: result.classification.productType?.key ?? null,
          selected: result.updated,
        },
      });
      return result;
    });
    return result;
  }
}

export function extractResearchClassificationCandidate(
  draft: CaptureDraft,
): ResearchClassificationCandidate | null {
  const taxonomyLabel = lastNonEmpty(draft.taxonomy.map((node) => node.label));
  if (taxonomyLabel) return candidate("marketplace_taxonomy", taxonomyLabel);

  const ehuntLabel = lastNonEmpty(draft.ehuntAnalysis?.categoryPath ?? []);
  if (ehuntLabel) return candidate("ehunt_category", ehuntLabel);

  if (draft.platform === "amazon") {
    const bsrLabel = extractAmazonBestSellerCategory(draft);
    if (bsrLabel) return candidate("amazon_bsr", bsrLabel);
  }
  return null;
}

export function normalizeResearchProductType(value: string) {
  const name = normalizeLabel(value);
  return { key: name.toLowerCase(), name };
}

function candidate(
  evidenceSource: ResearchClassificationEvidenceSource,
  value: string,
): ResearchClassificationCandidate | null {
  const normalized = normalizeResearchProductType(value);
  return normalized.name
    ? {
        evidenceKey: normalized.key,
        evidenceLabel: normalized.name,
        evidenceSource,
      }
    : null;
}

function extractAmazonBestSellerCategory(draft: CaptureDraft): string | null {
  for (const section of draft.productInformation) {
    for (const item of section.items) {
      if (!/best sellers rank/i.test(item.label)) continue;
      const linked = lastNonEmpty(
        item.links.map((link) => cleanBestSellerCategory(link.label)),
      );
      if (linked) return linked;
      const matches = [
        ...item.value.matchAll(/#[0-9,]+\s+in\s+([^#\n\r(]+)/gi),
      ];
      const fromValue = lastNonEmpty(
        matches.map((match) => cleanBestSellerCategory(match[1] ?? "")),
      );
      if (fromValue) return fromValue;
    }
  }
  return null;
}

function cleanBestSellerCategory(value: string) {
  return normalizeLabel(value.replace(/^#[0-9,]+\s+in\s+/i, ""));
}

function lastNonEmpty(values: readonly string[]) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = normalizeLabel(values[index] ?? "");
    if (value) return value;
  }
  return null;
}

function normalizeLabel(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function uniqueEvidenceAliases(
  rows: Array<{
    evidenceKey: string | null;
    evidenceLabel: string | null;
    evidenceSource: string | null;
    platform: string;
  }>,
) {
  const aliases = new Map<
    string,
    {
      evidenceKey: string;
      evidenceLabel: string;
      evidenceSource: ResearchClassificationEvidenceSource;
      platform: "amazon" | "etsy";
    }
  >();
  for (const row of rows) {
    if (
      !row.evidenceKey ||
      !row.evidenceLabel ||
      !isEvidenceSource(row.evidenceSource) ||
      (row.platform !== "amazon" && row.platform !== "etsy")
    ) {
      continue;
    }
    aliases.set(
      `${row.platform}\u0000${row.evidenceSource}\u0000${row.evidenceKey}`,
      {
        evidenceKey: row.evidenceKey,
        evidenceLabel: row.evidenceLabel,
        evidenceSource: row.evidenceSource,
        platform: row.platform,
      },
    );
  }
  return [...aliases.values()];
}

function isEvidenceSource(
  value: string | null,
): value is ResearchClassificationEvidenceSource {
  return (
    value === "marketplace_taxonomy" ||
    value === "ehunt_category" ||
    value === "amazon_bsr"
  );
}
