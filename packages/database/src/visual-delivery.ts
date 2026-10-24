import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { VisualDeliverySnapshot } from "@yummyai/contracts/catalog/product-visuals";
import type { TenantTransaction } from "./tenant-transaction.js";
import { salesPlans } from "./schema/sales-plans.js";
import {
  productSpecifications,
  productSpecificationVersions,
} from "./schema/product-development.js";
import { spus, productPlans } from "./schema/catalog.js";
import { printProfileVersions } from "./schema/order-workspace.js";
import { productionEditorProjects } from "./schema/production-editor.js";
import {
  creativeDesignVersions,
  creativeDesignCandidates,
  creativeDesignBatchItems,
  creativeDesignBatches,
} from "./schema/pod-batches.js";
import { auditEvents } from "./schema/audit.js";

/** Shared, read-only source pin used by API preflight and Worker immediately before a paid call. */
export async function visualDeliverySource(tx: TenantTransaction, planId: string) {
  const [row] = await tx
    .select({ plan: salesPlans, spu: spus, product: productPlans })
    .from(salesPlans)
    .innerJoin(spus, eq(spus.id, salesPlans.spuId))
    .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
    .where(eq(salesPlans.id, planId));
  if (
    !row ||
    row.plan.archivedAt ||
    row.spu.status === "archived" ||
    row.product.status === "archived"
  )
    throw new Error("visual_source_changed");
  const ids = row.plan.fields.specificationIds;
  const specs = ids.length
    ? await tx
        .select({
          spec: productSpecifications,
          version: productSpecificationVersions,
          process: printProfileVersions,
          template: {
            id: productionEditorProjects.id,
            status: productionEditorProjects.status,
            archivedAt: productionEditorProjects.archivedAt,
            currentVersionId: productionEditorProjects.currentVersionId,
            reviewedVersionId: productionEditorProjects.reviewedVersionId,
          },
        })
        .from(productSpecifications)
        .innerJoin(
          productSpecificationVersions,
          and(
            eq(productSpecificationVersions.specificationId, productSpecifications.id),
            eq(productSpecificationVersions.versionNumber, productSpecifications.versionNumber),
          ),
        )
        .leftJoin(
          printProfileVersions,
          eq(printProfileVersions.id, productSpecificationVersions.processProfileVersionId),
        )
        .leftJoin(
          productionEditorProjects,
          eq(productionEditorProjects.id, printProfileVersions.projectId),
        )
        .where(
          and(eq(productSpecifications.spuId, row.spu.id), inArray(productSpecifications.id, ids)),
        )
        .orderBy(productSpecifications.id)
    : [];
  const source = {
    planId,
    revision: row.plan.revision,
    fields: row.plan.fields,
    product: row.product,
    spu: row.spu,
    specs,
  };
  return { ...source, fingerprint: createHash("sha256").update(stable(source)).digest("hex") };
}
export async function assertVisualDeliveryCurrent(
  tx: TenantTransaction,
  pin: VisualDeliverySnapshot,
) {
  const source = await visualDeliverySource(tx, pin.salesPlanId);
  if (
    source.revision !== pin.salesPlanRevision ||
    source.fingerprint !== pin.sourceFingerprint ||
    !source.specs.length ||
    source.specs.length !== source.fields.specificationIds.length ||
    source.specs.some(
      (s) =>
        s.process?.productType !== "shaped_pillow" ||
        !s.version.facts.factsConfirmed ||
        s.template?.status !== "active" ||
        !!s.template.archivedAt ||
        s.template.currentVersionId !== s.process.sourceVersionId ||
        s.template.reviewedVersionId !== s.process.sourceVersionId,
    )
  )
    throw new Error("visual_source_changed");
  return source;
}
export async function visualDeliveryArtwork(
  tx: TenantTransaction,
  pin: VisualDeliverySnapshot,
  versionId: string,
) {
  const [row] = await tx
    .select({ version: creativeDesignVersions, candidate: creativeDesignCandidates })
    .from(creativeDesignVersions)
    .innerJoin(
      creativeDesignCandidates,
      eq(creativeDesignCandidates.id, creativeDesignVersions.sourceCandidateId),
    )
    .innerJoin(
      creativeDesignBatchItems,
      eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId),
    )
    .innerJoin(
      creativeDesignBatches,
      eq(creativeDesignBatches.id, creativeDesignBatchItems.batchId),
    )
    .where(
      and(
        eq(creativeDesignVersions.id, versionId),
        eq(creativeDesignVersions.status, "approved"),
        isNull(creativeDesignBatches.archivedAt),
        sql`${creativeDesignBatches.canvasWorkflow}->'visualDelivery'->>'groupId' = ${pin.groupId}`,
        sql`${creativeDesignBatches.canvasWorkflow}->'visualDelivery'->>'slotKey' = 'artwork'`,
      ),
    );
  if (!row?.candidate.assetId) throw new Error("visual_artwork_changed");
  await assertVisualDeliveryReview(tx, pin, versionId);
  return row.candidate.assetId;
}
/** Generic artwork approval cannot replace the four explicit visual-delivery checks. */
export async function assertVisualDeliveryReview(
  tx: TenantTransaction,
  pin: VisualDeliverySnapshot,
  versionId: string,
) {
  const [review] = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityId, versionId),
        eq(auditEvents.action, "product_visual.review"),
        eq(auditEvents.result, "success"),
        sql`${auditEvents.metadata}->>'groupId' = ${pin.groupId}`,
        sql`${auditEvents.metadata}->>'sourceFingerprint' = ${pin.sourceFingerprint}`,
        sql`${auditEvents.metadata}->>'decision' = 'approve'`,
        sql`${auditEvents.metadata}->'checks' = '{"identity":true,"shape":true,"facts":true,"sides":true}'::jsonb`,
      ),
    )
    .limit(1);
  if (!review) throw new Error("visual_review_required");
}
function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Pins configuration privately without placing credentials or endpoints in the workflow JSON. */
export function visualDeliveryModelFingerprint(
  provider: { provider: string; endpoint: string | null; encryptedApiKey: string },
  target: unknown,
) {
  return createHash("sha256")
    .update(
      stable({
        provider: provider.provider,
        endpoint: provider.endpoint,
        credentialVersion: provider.encryptedApiKey,
        target,
      }),
    )
    .digest("hex");
}
