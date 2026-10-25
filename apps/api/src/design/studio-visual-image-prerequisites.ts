import { isDeepStrictEqual } from "node:util";
import { authorize, Permission, requireAssetAuthority } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { VisualDeliverySnapshotSchema, VISUAL_SLOTS, type VisualDeliverySnapshot } from "@yummyai/contracts/catalog/product-visuals";
import { StudioPaidImageInputSchema, StudioImagePricingSchema, type StudioImagePricing,
  type StudioPaidImageInput, type StudioPaidImageQuote } from "@yummyai/contracts/pod/studio-paid-image";
import { assertCatalogSalesPlanAccess, currentCreativeWorkspaceAuthority, requireBatchAccess,
  requireCreativeVersionAccess, requireReferenceAuthority } from "@yummyai/catalog-core";
import { aiBudgetLedger, assetFiles, assertVisualDeliveryCurrent, creativeDesignBatches, creativeDesignCandidates,
  creativeDesignVersionAssets, creativeStudioGenerations, visualDeliveryArtwork, type TenantTransaction } from "@yummyai/database";
import { studioImageHash } from "@yummyai/pod-core";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

type References = StudioPaidImageQuote["references"];
export type StudioVisualImagePrerequisitesInput = {
  scope: string; input: StudioPaidImageInput; references: References;
  /** Computed by the paid resolver from the currently locked model configuration. */
  model: Pick<StudioPaidImageQuote, "modelId" | "providerConfigId" | "model" | "providerFingerprint">;
  pricing: StudioImagePricing; checkedAt: number;
};
export type StudioVisualImagePrerequisites = {
  input: StudioPaidImageInput; references: References; visualDelivery: VisualDeliverySnapshot | null; visualCeilingUsd?: number;
  budget: { slotAttempts: number; activeGenerations: number; occupiedUsd: string; reservationUsd: string; totalBudgetUsd: string } | null;
};

export class StudioVisualImagePrerequisiteError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: "studio_visual_image_changed" | "studio_visual_image_budget_exceeded" | "studio_visual_image_attempt_limit") {
    super(code); this.name = "StudioVisualImagePrerequisiteError";
  }
}
const changed = (): never => { throw new StudioVisualImagePrerequisiteError("studio_visual_image_changed"); };
const budgetExceeded = (): never => { throw new StudioVisualImagePrerequisiteError("studio_visual_image_budget_exceeded"); };
const attemptLimit = (): never => { throw new StudioVisualImagePrerequisiteError("studio_visual_image_attempt_limit"); };
const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const micros = (value: string): bigint => {
  if (!/^(0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(value)) return budgetExceeded();
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const decimal = (value: bigint) => `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;
const snapshotMoney = (value: number): string => {
  const text = value.toFixed(6);
  if (!Number.isFinite(value) || Number(text) !== value) return budgetExceeded();
  micros(text);
  return text;
};

function sharedPin(pin: VisualDeliverySnapshot) {
  const { slotKey: _slotKey, ...shared } = pin;
  void _slotKey;
  return shared;
}

async function reference(tx: TenantTransaction, context: TenantContext, id: string, checkedAt: number,
  expected?: { version: number; checksum: string }) {
  const [file] = await tx.select().from(assetFiles).where(eq(assetFiles.id, id)).for("share");
  if (!file) return changed();
  requireAssetAuthority(context, Permission.AssetRead, file);
  requireReferenceAuthority(context, [file], checkedAt);
  const kind = (file.rightsMetadata.source as { kind?: string } | undefined)?.kind;
  if (file.deletedAt || file.assetDomain !== "authorized" || file.rightsStatus !== "approved"
    || !["image/png", "image/jpeg", "image/webp"].includes(file.mediaType) || !["owned", "licensed", "ai_generated"].includes(kind ?? "")
    || expected && (file.version !== expected.version || file.checksumSha256 !== expected.checksum)) return changed();
  return file;
}

/** A read-only prerequisite adapter for the existing paid prepare/commit owner.
 * The paid owner must hold its model-configuration/personal-original-key locks,
 * invoke this again during commit, bind the returned visual snapshot into the
 * quote, and reserve its exact quoted amount atomically with the generation.
 * No model credential, provider call, asset attach, new owner or queue is used. */
export async function resolveStudioVisualImagePrerequisites(tx: TenantTransaction, context: TenantContext,
  args: StudioVisualImagePrerequisitesInput): Promise<StudioVisualImagePrerequisites> {
  const parsed = StudioPaidImageInputSchema.safeParse(args.input);
  const priced = StudioImagePricingSchema.safeParse(args.pricing);
  if (!parsed.success || !priced.success || !Number.isFinite(args.checkedAt)) return changed();
  let input = parsed.data;
  const references = args.references.map(value => ({ ...value }));
  if (new Set(references.map(value => value.assetId)).size !== references.length) return changed();
  if (args.scope === "unassigned") {
    if (input.visualSlotKey || input.visualArtworkVersionId) return changed();
    return { input, references, visualDelivery: null, budget: null };
  }
  const { authority, checkedAt } = await currentCreativeWorkspaceAuthority(tx, context, args.scope, [Permission.DesignWrite, Permission.AssetWrite]);
  const project = await requireBatchAccess(tx, authority, args.scope, [Permission.DesignRead, Permission.DesignWrite], { canvas: true, mutation: true });
  if (!project.canvasWorkflow?.visualDelivery) {
    if (input.visualSlotKey || input.visualArtworkVersionId) return changed();
    return { input, references, visualDelivery: null, budget: null };
  }
  const fixed = VisualDeliverySnapshotSchema.safeParse(project.canvasWorkflow.visualDelivery);
  if (!fixed.success) return changed();
  const pin = fixed.data;
  authorize(authority, Permission.ProductRead);
  await assertCatalogSalesPlanAccess(tx, authority, pin.salesPlanId, [Permission.ProductRead]);
  if (project.createdBy !== context.userId || input.visualSlotKey !== pin.slotKey || !sameId(input.modelId, pin.modelId)
    || input.size !== pin.size || input.quality !== "high" || input.background !== (pin.slotKey === "artwork" ? "transparent" : "opaque")
    || !sameId(args.model.modelId, pin.modelId) || !sameId(args.model.providerConfigId, pin.providerConfigId) || args.model.model !== pin.providerModel
    || args.model.providerFingerprint !== pin.providerFingerprint || pin.slotKey === "artwork" && input.visualArtworkVersionId) return changed();
  try { await assertVisualDeliveryCurrent(tx, pin); }
  catch (cause) {
    if (cause instanceof Error && cause.message === "visual_source_changed") return changed();
    throw cause;
  }

  const sample = await reference(tx, authority, pin.sampleAssetId, checkedAt);
  const sampleKind = (sample.rightsMetadata.source as { kind?: string } | undefined)?.kind;
  if (sample.aiGenerated || !["owned", "licensed"].includes(sampleKind ?? "")) return changed();
  const priorSample = references.find(value => value.assetId === sample.id);
  if (priorSample && (priorSample.version !== sample.version || priorSample.checksum !== sample.checksumSha256)) return changed();
  if (!priorSample) references.push({ assetId: sample.id, version: sample.version, checksum: sample.checksumSha256 });

  if (pin.slotKey !== "artwork") {
    if (!input.visualArtworkVersionId) return changed();
    let artworkAssetId: string;
    try { artworkAssetId = await visualDeliveryArtwork(tx, pin, input.visualArtworkVersionId); }
    catch (cause) {
      if (cause instanceof Error && ["visual_artwork_changed", "visual_review_required"].includes(cause.message)) return changed();
      throw cause;
    }
    const { version, batch } = await requireCreativeVersionAccess(tx, authority, input.visualArtworkVersionId, [Permission.DesignRead]);
    if (batch.archivedAt || batch.status === "cancelled" || version.status !== "approved") return changed();
    const [candidate] = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, version.sourceCandidateId)).for("share");
    const links = await tx.select().from(creativeDesignVersionAssets).where(and(eq(creativeDesignVersionAssets.creativeDesignVersionId, version.id),
      eq(creativeDesignVersionAssets.role, "master")));
    if (!candidate || candidate.assetId !== artworkAssetId || !candidate.assetVersion || !candidate.checksumSha256
      || links.length !== 1 || links[0]!.assetId !== artworkAssetId || links[0]!.assetVersion !== candidate.assetVersion) return changed();
    const artwork = await reference(tx, authority, artworkAssetId, checkedAt, { version: candidate.assetVersion, checksum: candidate.checksumSha256 });
    const originalReference = references.find(value => value.assetId === artwork.id);
    if (originalReference && (originalReference.version !== artwork.version || originalReference.checksum !== artwork.checksumSha256)) return changed();
    const rest = references.filter(value => value.assetId !== artwork.id);
    references.splice(0, references.length, { assetId: artwork.id, version: artwork.version, checksum: artwork.checksumSha256 }, ...rest);
    // Same immutable subject instruction as the legacy visual producer. The
    // main resolver appends the project's original brief before this helper.
    input = { ...input, prompt: `${input.prompt}\n\n套图固定图稿版本：${input.visualArtworkVersionId}。首张参考图是已审核的唯一图稿来源，须保持图案、身份、姿态、比例和文字不变；真实样品参考用于核对抱枕轮廓、材质和单双面。不能用样品照片替换图稿内容。` };
  }
  if (!StudioPaidImageInputSchema.safeParse(input).success || references.length > 10) return changed();
  for (const ref of references) await reference(tx, authority, ref.assetId, checkedAt, ref);

  // Keep the existing lock order. Read-only prepare checks availability; only
  // the paid owner's commit inserts the exact pricing reservation in the ledger.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:${pin.groupId}:visual-budget`},0))`);
  const group = await tx.select().from(creativeDesignBatches).where(and(eq(creativeDesignBatches.createdBy, context.userId),
    isNull(creativeDesignBatches.archivedAt), sql`${creativeDesignBatches.canvasWorkflow}->'visualDelivery'->>'groupId' = ${pin.groupId}`))
    .orderBy(asc(creativeDesignBatches.id)).for("share");
  const pins = group.map(row => VisualDeliverySnapshotSchema.safeParse(row.canvasWorkflow?.visualDelivery));
  if (group.length !== VISUAL_SLOTS.length || pins.some(value => !value.success) || group.some(row => row.status === "cancelled")) return changed();
  const groupPins = pins.map(value => value.success ? value.data : changed());
  if (new Set(groupPins.map(value => value.slotKey)).size !== VISUAL_SLOTS.length
    || groupPins.some(value => !isDeepStrictEqual(sharedPin(value), sharedPin(pin))) || !group.some(row => row.id === project.id)) return changed();
  const attempts = await tx.select({ id: creativeStudioGenerations.id, scope: creativeStudioGenerations.scope }).from(creativeStudioGenerations)
    .where(inArray(creativeStudioGenerations.scope, group.map(row => row.id))).orderBy(asc(creativeStudioGenerations.id)).for("share");
  const slotAttempts = attempts.filter(row => row.scope === args.scope).length;
  const active = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(
    eq(creativeStudioGenerations.ownerId, context.userId), inArray(creativeStudioGenerations.status, ["queued", "running"]))).limit(4);
  if (slotAttempts >= 4 || active.length >= 4) return attemptLimit();
  const rows = attempts.length ? await tx.select().from(aiBudgetLedger).where(inArray(aiBudgetLedger.requestId, attempts.map(row => row.id)))
    .orderBy(asc(aiBudgetLedger.id)).for("share") : [];
  // A generation without its original reservation is an unknown accounting
  // state, never free capacity. No historical attempt/hold is created or fixed.
  if (attempts.some(attempt => rows.filter(row => row.requestId === attempt.id).length !== 1)
    || rows.some(row => row.taskType !== "studio_image")) return budgetExceeded();
  const occupied = rows.filter(row => row.state !== "released").reduce((sum, row) => sum + micros(row.amountUsd), 0n);
  const reservation = micros(priced.data.reservationUsd), ceiling = snapshotMoney(pin.callCeilingUsd), total = snapshotMoney(pin.totalBudgetUsd);
  if (reservation > micros(ceiling) || occupied + reservation > micros(total)) return budgetExceeded();
  return { input, references, visualDelivery: pin, visualCeilingUsd: pin.callCeilingUsd,
    budget: { slotAttempts, activeGenerations: active.length, occupiedUsd: decimal(occupied), reservationUsd: decimal(reservation), totalBudgetUsd: total } };
}

/** The quote hash already covers this complete reusable schema. This helper is
 * useful for a caller that needs a finite comparison without serializing rows. */
export const studioVisualImagePrerequisiteChecksum = (value: StudioVisualImagePrerequisites) => studioImageHash({
  visualDelivery: value.visualDelivery, input: value.input, references: value.references,
});
