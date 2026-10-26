import { isDeepStrictEqual } from "node:util";
import { authorize, intersectPermissionContexts, Permission, requireAssetAuthority } from "@yummyai/authz";
import { createEntityId, MockupTemplateInspectionSchema, type TenantContext } from "@yummyai/contracts";
import type { CreativeResponse } from "@yummyai/contracts/harness/creative-response";
import {
  assertCatalogSalesPlanAccess, creativeDerivedRights, currentCreativeAuthority, currentCreativeWorkspaceAuthority,
  requireBatchAccess, requireBatchInputs, requireCreativeVersionAccess, requireMockupBatchAccess,
  requireMockupDesignSource, requireMockupInspectionAccess, requireMockupInspectionSources,
  requireMockupPackAccess, requireMockupPackSources, requirePrintSpecAccess, requireReferenceAuthority,
} from "@yummyai/catalog-core";
import {
  artifactRelations, assetFiles, assertVisualDeliveryCurrent, creativeDesignBatchItems, creativeDesignCandidates,
  creativeDesignVersionAssets, creativeDesignVersions, creativeExecutions, creativeExecutionChecksum,
  creativeStudioEntries, creativeStudioGenerations, creativeStudioImageCancellations, creativeStudioImageRequests,
  creativeStudioRevisions, currentCreativeExecutionAuthority, modelProviderConfigs, modelRoutes,
  mockupBatches, mockupBatchItems, mockupBatchOutputs, mockupTemplateSlots, mockupTemplatePackVersions, mockupTemplateSourceInspections,
  visualDeliveryArtwork, visualDeliveryModelFingerprint, type TenantTransaction,
} from "@yummyai/database";
import {
  assertCreativeMethod, creativeHarness, creativeMockupStep, creativeOriginalFingerprint, creativeResponseChecksum,
  decodeCreativeOutputs, decodePodResponse, hashPodResponse, parseCreativeResponse, readCreativeExecutionSource,
  requireMockupCompletionEvidence, type CreativeLocalOutput, type CreativeOperation,
} from "@yummyai/pod-core";
import { MOCKUP_COMPILER_VERSION, MockupRenderManifestSchema } from "@yummyai/mockup-renderer";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

type Execution = typeof creativeExecutions.$inferSelect;
type Asset = typeof assetFiles.$inferSelect;
type OwnerKind = Exclude<Execution["kind"], "creative_candidate">;
type LockOptions = { lock?: "share" | "update" };
const reads = [Permission.DesignRead, Permission.AssetRead];
const writes = [...reads, Permission.DesignWrite, Permission.DesignReview, Permission.AssetWrite];
const closed = (status: string) => status === "cancelled" || status === "completed";
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: unknown) => creativeExecutionChecksum(json(value));

/** This module owns real business writes only. The calling service owns the
 * trusted archive, scanning, private object I/O, fenced adoption lease and its
 * independent immutable adoption fact in this same tenant transaction. */
export class CreativeAdoptionOwnerError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: "CREATIVE_ADOPTION_OWNER_BLOCKED" | "CREATIVE_ADOPTION_OWNER_CHANGED"
    | "CREATIVE_ADOPTION_OWNER_RESPONSE_INVALID" | "CREATIVE_ADOPTION_OWNER_UNSUPPORTED") {
    super(code);
    this.name = "CreativeAdoptionOwnerError";
  }
}
const blocked = (): never => { throw new CreativeAdoptionOwnerError("CREATIVE_ADOPTION_OWNER_BLOCKED"); };
const changed = (): never => { throw new CreativeAdoptionOwnerError("CREATIVE_ADOPTION_OWNER_CHANGED"); };
const invalid = (): never => { throw new CreativeAdoptionOwnerError("CREATIVE_ADOPTION_OWNER_RESPONSE_INVALID"); };
const unsupported = (): never => { throw new CreativeAdoptionOwnerError("CREATIVE_ADOPTION_OWNER_UNSUPPORTED"); };

const AdaptationResult = z.object({ mode: z.enum(["crop", "ai_outpaint"]), generatedRegions: z.array(z.object({
  x: z.number().finite(), y: z.number().finite(), width: z.number().positive().finite(), height: z.number().positive().finite(),
}).strict()).max(100), qualitySnapshot: z.record(z.string(), z.unknown()) }).strict();
const CompileResult = z.object({ manifest: MockupRenderManifestSchema, ssimPermille: z.int().min(990).max(1000),
  warnings: MockupTemplateInspectionSchema.shape.warnings }).strict();
const MockupResult = z.object({ outputId: z.uuidv7(), width: z.int().positive().max(100000), height: z.int().positive().max(100000),
  qualitySnapshot: z.record(z.string(), z.unknown()) }).strict();

export type CreativeAdoptionOwnerPin = {
  version: 1; executionId: string; kind: OwnerKind; ownerId: string; parentId: string | null; status: string; checksum: string;
};
export type CreativeAdoptionOwnerOutput = CreativeLocalOutput & {
  checksumSha256: string; byteSize: number; width: number | null; height: number | null;
  aiGenerated: boolean; rightsStatus: "unverified"; rightsMetadata: Record<string, unknown>;
};
export type CreativeAdoptionOwnerPlan = { pin: CreativeAdoptionOwnerPin; outputs: CreativeAdoptionOwnerOutput[] };
export type CreativeAdoptionRegisteredAsset = { role: string; id: string; version: number; checksumSha256: string };
type SavedOwner =
  | { kind: "adaptation_spec"; creativeDesignVersionId: string; printSpecVersionId: string; linkId: string; assetId: string }
  | { kind: "adaptation_outpaint"; creativeDesignVersionId: string; printSpecVersionId: string; parentExecutionId: string;
      assetId: string; parentStatus: string; parentRequiresLocalAdaptation: true }
  | { kind: "template_compile"; inspectionId: string; manifestAssetId: string; ssimPermille: number; confirmed: false }
  | { kind: "mockup_render"; batchId: string; itemId: string; outputId: string; assetId: string; attempt: number; approved: false }
  | { kind: "studio_generation"; generationId: string; entryId: string; revisionId: string; revision: 1; assetId: string };
export type CreativeAdoptionOwnerReceipt = Omit<CreativeAdoptionOwnerPin, "checksum"> & {
  adoptionId: string; checksum: string; basisChecksum: string; saved: SavedOwner;
  artifacts: Array<{ role: string; assetId: string; version: number; checksumSha256: string }>;
};

function operation(row: Execution): CreativeOperation {
  const ownerId = row.kind === "creative_adaptation" ? row.creativeVersionId
    : row.kind === "template_compile" ? row.inspectionId : row.kind === "mockup_render" ? row.mockupItemId
      : row.kind === "studio_generation" ? row.studioGenerationId : null;
  if (!ownerId) return unsupported();
  return { kind: row.kind, ownerId, stepKey: row.stepKey };
}

/** Parent-first business locks match the existing cancellation/Worker owners.
 * A supplied execution is an expected row, never authority for caller-made ids. */
export async function loadCreativeResponseAdoptionOwner(tx: TenantTransaction, context: TenantContext,
  expected: Execution, options: LockOptions = {}) {
  const lock = options.lock ?? "share";
  const { authority, checkedAt } = await currentCreativeAuthority(tx, context, reads);
  const [association] = await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, expected.id));
  if (!association || digest(association) !== digest(expected)) return changed();
  // Root execution precedes its child. Do not lock a parent execution only
  // after locking its business batch: the operator owns execution first.
  const executionIds = [association.id, ...(association.parentExecutionId ? [association.parentExecutionId] : [])].sort();
  const executions = await tx.select().from(creativeExecutions).where(inArray(creativeExecutions.id, executionIds))
    .orderBy(asc(creativeExecutions.id)).for(lock);
  const execution = executions.find(row => row.id === expected.id);
  if (!execution || execution.tenantId !== context.tenantId || digest(execution) !== digest(expected)) return changed();
  const op = operation(execution);
  const owner = await loadOwner(tx, authority, execution, op, lock);
  const source = await readCreativeExecutionSource(tx, authority, op);
  return { execution, authority, checkedAt, operation: op, owner, source };
}
export type CreativeAdoptionOwnerScope = Awaited<ReturnType<typeof loadCreativeResponseAdoptionOwner>>;

/** Finite metadata only. Never serialize OwnerScope: it contains private source
 * and provider rows. Read-only receipt lookup may use this after completion. */
export function creativeAdoptionOwnerScopePin(scope: CreativeAdoptionOwnerScope): CreativeAdoptionOwnerPin {
  return { version: 1, executionId: scope.execution.id, ...summaryOwner(scope.owner),
    checksum: digest({ version: 1, execution: scope.execution, owner: scope.owner, source: scope.source }) };
}

/** Prepare-time admission without decrypting or trusting any supplied response.
 * SourcePin should retain this independently of the later decoded-output pin. */
export async function authorizeCreativeResponseAdoptionOwner(tx: TenantTransaction, context: TenantContext,
  scope: CreativeAdoptionOwnerScope): Promise<CreativeAdoptionOwnerPin> {
  const admitted = await admitOwner(tx, context, scope);
  return { ...creativeAdoptionOwnerScopePin(scope), checksum: digest({ version: 1, execution: scope.execution,
    owner: scope.owner, source: scope.source, dependencies: admitted.dependencies }) };
}

async function loadOwner(tx: TenantTransaction, authority: TenantContext, execution: Execution, op: CreativeOperation,
  lock: "share" | "update") {
  if (op.kind === "creative_adaptation") {
    const [association] = await tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignVersions)
      .innerJoin(creativeDesignCandidates, eq(creativeDesignCandidates.id, creativeDesignVersions.sourceCandidateId))
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId))
      .where(eq(creativeDesignVersions.id, op.ownerId));
    if (!association) return changed();
    const batch = await requireBatchAccess(tx, authority, association.batchId, [Permission.DesignRead], { lock });
    const items = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, batch.id))
      .orderBy(asc(creativeDesignBatchItems.id)).for(lock);
    const { version } = await requireCreativeVersionAccess(tx, authority, op.ownerId, [Permission.DesignRead], { lock });
    const [candidate] = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, version.sourceCandidateId)).for("share");
    const item = items.find(row => row.id === candidate?.itemId);
    if (!candidate || !item || !/^(spec|outpaint):[a-f0-9-]{36}$/.test(op.stepKey)) return changed();
    const spec = await requirePrintSpecAccess(tx, authority, op.stepKey.slice(op.stepKey.indexOf(":") + 1), [Permission.DesignRead]);
    const links = await tx.select().from(creativeDesignVersionAssets).where(eq(creativeDesignVersionAssets.creativeDesignVersionId, version.id))
      .orderBy(asc(creativeDesignVersionAssets.id));
    const masters = links.filter(row => row.role === "master");
    const [master] = masters.length === 1 ? await tx.select().from(assetFiles).where(eq(assetFiles.id, masters[0]!.assetId)).for("share") : [];
    const [parent] = execution.parentExecutionId ? await tx.select().from(creativeExecutions)
      .where(eq(creativeExecutions.id, execution.parentExecutionId)).for("share") : [];
    return { kind: "creative_adaptation" as const, batch, items, version, candidate, item, links, master: master ?? null, spec, parent: parent ?? null };
  }
  if (op.kind === "template_compile") {
    const packs = await tx.select({ pack: mockupTemplatePackVersions, slot: mockupTemplateSlots }).from(mockupTemplateSlots)
      .innerJoin(mockupTemplatePackVersions, eq(mockupTemplatePackVersions.id, mockupTemplateSlots.templatePackVersionId))
      .where(eq(mockupTemplateSlots.inspectionId, op.ownerId)).orderBy(asc(mockupTemplatePackVersions.id), asc(mockupTemplateSlots.id))
      .for("share", { of: [mockupTemplatePackVersions] });
    const inspection = await requireMockupInspectionAccess(tx, authority, op.ownerId, [Permission.DesignRead], lock);
    const { source } = await requireMockupInspectionSources(tx, authority, inspection);
    const currentSlots = await tx.select({ id: mockupTemplateSlots.id }).from(mockupTemplateSlots)
      .where(eq(mockupTemplateSlots.inspectionId, inspection.id)).orderBy(asc(mockupTemplateSlots.id));
    if (digest(currentSlots.map(row => row.id)) !== digest(packs.map(row => row.slot.id).sort())) return changed();
    return { kind: "template_compile" as const, inspection, source, packs };
  }
  if (op.kind === "mockup_render") {
    const [association] = await tx.select({ batchId: mockupBatchItems.batchId }).from(mockupBatchItems).where(eq(mockupBatchItems.id, op.ownerId));
    if (!association) return changed();
    const batch = await requireMockupBatchAccess(tx, authority, association.batchId, [Permission.DesignRead], lock);
    const items = await tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batch.id)).orderBy(asc(mockupBatchItems.id)).for(lock);
    const item = items.find(row => row.id === op.ownerId);
    const step = creativeMockupStep(op.stepKey);
    const [output] = await tx.select().from(mockupBatchOutputs).where(and(eq(mockupBatchOutputs.itemId, op.ownerId),
      eq(mockupBatchOutputs.templateSlotId, step.slotId), eq(mockupBatchOutputs.attempt, step.attempt))).for(lock);
    const pack = await requireMockupPackAccess(tx, authority, batch.templatePackVersionId, [Permission.DesignRead]);
    if (!item || !output) return changed();
    return { kind: "mockup_render" as const, batch, items, item, output, pack };
  }
  if (op.kind === "studio_generation") {
    const [association] = await tx.select({ scope: creativeStudioGenerations.scope }).from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, op.ownerId));
    if (!association) return changed();
    await currentCreativeWorkspaceAuthority(tx, authority, association.scope);
    const [generation] = await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, op.ownerId)).for(lock);
    if (!generation || generation.scope !== association.scope) return changed();
    authorize(authority, Permission.DesignRead, { ownerId: generation.ownerId });
    const entries = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, generation.ownerId),
      eq(creativeStudioEntries.scope, generation.scope), eq(creativeStudioEntries.namespace, "image_files"),
      eq(creativeStudioEntries.key, `image:${generation.id}`))).for("share");
    const prepared = await tx.select().from(creativeStudioImageRequests).where(eq(creativeStudioImageRequests.generationId, generation.id)).for("share");
    const cancellations = await tx.select().from(creativeStudioImageCancellations).where(and(eq(creativeStudioImageCancellations.ownerId, generation.ownerId),
      eq(creativeStudioImageCancellations.scope, generation.scope), eq(creativeStudioImageCancellations.requestId, generation.requestId)));
    return { kind: "studio_generation" as const, generation, entries, prepared, cancellations };
  }
  return unsupported();
}

function available(authority: TenantContext, file: Asset, checkedAt: number, allowAiDraft = false) {
  requireAssetAuthority(authority, Permission.AssetRead, file);
  requireReferenceAuthority(authority, [file], checkedAt);
  const kind = (file.rightsMetadata.source as { kind?: string } | undefined)?.kind;
  if (file.deletedAt || file.assetDomain !== "authorized" || ["competitor", "customer_provided"].includes(kind ?? "")
    || (file.rightsStatus !== "approved" && !(allowAiDraft && file.rightsStatus === "unverified" && kind === "ai_generated"))) return blocked();
}

/** Reuse the original captured ceiling, intersect the real current caller, then
 * recheck each actual owner and its still-licensed immutable inputs. */
async function admitOwner(tx: TenantTransaction, context: TenantContext, scope: CreativeAdoptionOwnerScope) {
  const { execution, owner, checkedAt } = scope;
  if (execution.requestedBy !== context.userId || !["failed", "uncertain"].includes(execution.phase)
    || execution.completionEvidence || execution.completionChecksum || execution.leaseToken || execution.leaseExpiresAt
    || !execution.responseObjectKey || !execution.encryptedChecksum || !execution.responseChecksum || execution.responsePurgedAt
    || !execution.responseExpiresAt || execution.responseExpiresAt.getTime() <= checkedAt) return blocked();
  if (execution.effect === "external_request" && (!execution.submissionToken || !execution.submittedAt || !execution.receipt)) return blocked();
  if (execution.effect === "internal_write" && (execution.receipt || execution.submittedAt || execution.submissionToken)) return blocked();
  const original = await currentCreativeExecutionAuthority(tx, context, execution, writes);
  const authority = intersectPermissionContexts(scope.authority, original);
  await assertCreativeMethod(tx, authority, execution);
  if (creativeOriginalFingerprint(scope.operation, scope.source, execution) !== execution.inputFingerprint) return changed();

  if (owner.kind === "creative_adaptation") {
    const { batch, item, version, master, candidate, spec, links, parent } = owner;
    for (const permission of writes) authorize(authority, permission, { ownerId: version.createdBy });
    if (batch.archivedAt || closed(batch.status) || closed(item.status) || !["adapting", "rejected"].includes(version.status)
      || version.reviewedAt || version.reviewedBy || spec.status !== "approved" || !master
      || !item.printSpecVersionIds.includes(spec.id) || links.some(row => row.role === "aspect_variant" && row.printSpecVersionId === spec.id)
      || candidate.assetId !== master.id || candidate.assetVersion !== master.version || candidate.checksumSha256 !== master.checksumSha256
      || links.find(row => row.role === "master")?.assetVersion !== master.version) return blocked();
    await requireBatchAccess(tx, authority, batch.id, [Permission.DesignWrite], { mutation: true });
    await requireBatchInputs(tx, authority, batch, checkedAt);
    available(authority, master, checkedAt, true);
    if (scope.operation.stepKey.startsWith("outpaint:")) {
      if (execution.effect !== "external_request" || !parent || parent.kind !== "creative_adaptation" || parent.effect !== "internal_write"
        || parent.creativeVersionId !== version.id || parent.stepKey !== `spec:${spec.id}` || parent.requestedBy !== context.userId
        || !["failed", "uncertain"].includes(parent.phase) || parent.leaseToken || parent.leaseExpiresAt || parent.completionEvidence) return blocked();
      const parentAuthority = await currentCreativeExecutionAuthority(tx, context, parent, creativeHarness(parent.kind, parent.effect).requiredPermissions);
      await assertCreativeMethod(tx, intersectPermissionContexts(authority, parentAuthority), parent);
      const source = await readCreativeExecutionSource(tx, authority, { kind: parent.kind, ownerId: version.id, stepKey: parent.stepKey });
      if (creativeOriginalFingerprint({ kind: parent.kind, ownerId: version.id, stepKey: parent.stepKey }, source, parent) !== parent.inputFingerprint) return changed();
    } else if (execution.effect !== "internal_write" || execution.parentExecutionId) return blocked();
    return { ...scope, authority, dependencies: [master] };
  }
  if (owner.kind === "template_compile") {
    for (const permission of writes) authorize(authority, permission, { ownerId: owner.inspection.requestedBy });
    if (execution.effect !== "internal_write" || execution.stepKey !== "compile" || owner.inspection.status !== "failed"
      || owner.inspection.compilation || owner.inspection.confirmedAt || owner.inspection.confirmedBy
      || owner.inspection.compilerVersion !== MOCKUP_COMPILER_VERSION || owner.packs.some(row => row.pack.status !== "draft")) return blocked();
    await requireMockupInspectionSources(tx, authority, owner.inspection, checkedAt);
    return { ...scope, authority, dependencies: [owner.source] };
  }
  if (owner.kind === "mockup_render") {
    for (const permission of writes) authorize(authority, permission, { ownerId: owner.batch.createdBy });
    if (execution.effect !== "internal_write" || closed(owner.batch.status) || closed(owner.item.status)
      || owner.item.reviewedAt || owner.item.reviewedBy || owner.item.rejectionReason
      || owner.output.status !== "failed" || owner.output.assetId || owner.output.assetVersion || owner.output.checksumSha256
      || owner.pack.status !== "approved" || owner.pack.platform !== owner.batch.platform || owner.pack.locale !== owner.batch.locale) return blocked();
    const [latest] = await tx.select({ id: mockupBatchOutputs.id }).from(mockupBatchOutputs).where(and(eq(mockupBatchOutputs.itemId, owner.item.id),
      eq(mockupBatchOutputs.templateSlotId, owner.output.templateSlotId))).orderBy(desc(mockupBatchOutputs.attempt)).limit(1);
    if (latest?.id !== owner.output.id) return blocked();
    const design = await requireMockupDesignSource(tx, authority, owner.item.designVersionId, owner.item.skuId, checkedAt);
    const templates = await requireMockupPackSources(tx, authority, owner.pack, checkedAt);
    if (templates.slots.some(slot => !slot.acceptedPrintSpecVersionIds.includes(design.printSpecVersionId))) return blocked();
    for (const inspection of templates.inspections) {
      const { assets } = await requireMockupInspectionSources(tx, authority, inspection, checkedAt, true);
      await requireMockupCompletionEvidence(tx, authority, { kind: "template_compile", ownerId: inspection.id, stepKey: "compile" }, assets, true);
    }
    const slot = templates.slots.find(row => row.id === owner.output.templateSlotId);
    const inspection = templates.inspections.find(row => row.id === slot?.inspectionId);
    if (!slot || !inspection?.compilation) return blocked();
    const { source } = await requireMockupInspectionSources(tx, authority, inspection, checkedAt, true);
    return { ...scope, authority, dependencies: [design.artwork, source], mockupInspectionId: inspection.id,
      mockupCanvas: { width: inspection.compilation.canvasWidth, height: inspection.compilation.canvasHeight } };
  }
  const generation = owner.generation;
  if (generation.modelSnapshot.capability !== "image") return unsupported();
  for (const permission of writes) authorize(authority, permission, { ownerId: generation.ownerId });
  if (execution.effect !== "external_request" || execution.stepKey !== "generate" || generation.ownerId !== context.userId
    || generation.status !== "failed" || generation.assetId || generation.resultText
    || owner.entries.length || owner.cancellations.length || owner.prepared.some(row => row.cancelledAt || row.ownerId !== context.userId
      || row.scope !== generation.scope || row.requestId !== generation.requestId || row.generationId !== generation.id || !row.committedAt)) return blocked();
  await currentCreativeWorkspaceAuthority(tx, authority, generation.scope, [Permission.DesignWrite, Permission.AssetWrite]);
  const model = generation.modelSnapshot;
  if (!model.routeId || !model.providerFingerprint || generation.input.modelId !== model.routeId) return blocked();
  const [provider] = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, model.providerConfigId)).for("share");
  const [route] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, model.routeId)).for("share");
  if (!provider || provider.status !== "enabled" || !["openai", "openai-compatible"].includes(provider.provider)
    || !route || route.status !== "enabled" || route.taskType !== "studio_image" || route.targets.length !== 1
    || route.targets[0]!.providerConfigId !== provider.id || route.targets[0]!.providerModel !== model.model
    || visualDeliveryModelFingerprint(provider, route.targets[0]!) !== model.providerFingerprint) return blocked();
  if (model.visualCeilingUsd !== undefined) {
    const workspace = await currentCreativeWorkspaceAuthority(tx, authority, generation.scope, [Permission.DesignWrite]);
    const batch = await requireBatchAccess(tx, workspace.authority, generation.scope, [Permission.DesignRead], { canvas: true, mutation: true });
    const pin = batch.canvasWorkflow?.visualDelivery;
    if (!pin || pin.slotKey !== generation.input.visualSlotKey || pin.callCeilingUsd !== model.visualCeilingUsd
      || pin.providerFingerprint !== model.providerFingerprint) return blocked();
    await assertCatalogSalesPlanAccess(tx, authority, pin.salesPlanId, [Permission.ProductRead]);
    await assertVisualDeliveryCurrent(tx, pin);
    if (pin.slotKey !== "artwork") {
      const originalAsset = await visualDeliveryArtwork(tx, pin, generation.input.visualArtworkVersionId ?? "");
      if (!generation.references.some(ref => ref.assetId === originalAsset)) return blocked();
    }
  }
  const ids = [...new Set(generation.references.map(ref => ref.assetId))].sort();
  const files = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).orderBy(asc(assetFiles.id)).for("share") : [];
  if (files.length !== ids.length) return changed();
  for (const ref of generation.references) {
    const file = files.find(row => row.id === ref.assetId)!;
    if (file.version !== ref.version || file.checksumSha256 !== ref.checksum) return changed();
    available(authority, file, checkedAt);
    if (!["owned", "licensed", "ai_generated"].includes((file.rightsMetadata.source as { kind?: string } | undefined)?.kind ?? "")) return blocked();
  }
  return { ...scope, authority, dependencies: files };
}

async function inspectOutput(output: CreativeLocalOutput, aiGenerated: boolean, rightsMetadata: Record<string, unknown>, maxPixels = 64_000_000): Promise<CreativeAdoptionOwnerOutput> {
  let width: number | null = null, height: number | null = null;
  if (output.mediaType !== "application/json") {
    const formats: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/tiff": "tiff" };
    if (!formats[output.mediaType]) return invalid();
    const image = sharp(output.bytes, { failOn: "error", limitInputPixels: maxPixels, pages: -1 });
    try {
      const metadata = await image.metadata();
      width = metadata.width ?? null; height = metadata.height ?? null;
      if (metadata.format !== formats[output.mediaType] || (metadata.pages ?? 1) !== 1 || !width || !height
        || !Number.isSafeInteger(width * height) || width * height > maxPixels) return invalid();
      await image.stats();
    } finally { image.destroy(); }
  }
  return { ...output, checksumSha256: hashPodResponse(output.bytes), byteSize: output.bytes.byteLength,
    width, height, aiGenerated, rightsStatus: "unverified", rightsMetadata: json(rightsMetadata) };
}

/** Use the native adaptArtwork/cropToRatio floor rules, without introducing a
 * manufacturing tolerance or relabeling dimensions. Native crop results retain
 * their exact rectangle; native outpaint retains its pre-crop expanded size. */
function assertAdaptationDimensions(output: CreativeAdoptionOwnerOutput, details: z.infer<typeof AdaptationResult>, desiredRatio: number) {
  const dimensions = z.object({ width: z.int().positive(), height: z.int().positive() }).passthrough();
  if (!output.width || !output.height || !Number.isFinite(desiredRatio) || desiredRatio <= 0) return invalid();
  if (details.mode === "crop") {
    const crop = dimensions.parse(details.qualitySnapshot.crop);
    if (output.width !== crop.width || output.height !== crop.height
      || !(output.width === Math.max(1, Math.floor(output.height * desiredRatio))
        || output.height === Math.max(1, Math.floor(output.width / desiredRatio)))) return invalid();
  } else {
    const expanded = dimensions.parse(details.qualitySnapshot.expandedDimensions), ratio = expanded.width / expanded.height;
    const width = ratio > desiredRatio ? Math.floor(expanded.height * desiredRatio) : expanded.width;
    const height = ratio > desiredRatio ? expanded.height : Math.floor(expanded.width / desiredRatio);
    if (output.width !== width || output.height !== height) return invalid();
  }
}

function responseMatches(execution: Execution, response: CreativeResponse) {
  if (creativeResponseChecksum(response) !== execution.responseChecksum) return invalid();
  if (response.kind === "local") {
    if (execution.effect !== "internal_write" || execution.receipt) return invalid();
  } else {
    const receipt = response.kind === "pod" ? response.checkpoint.receipt : response.receipt;
    if (execution.effect !== "external_request" || !isDeepStrictEqual(receipt, execution.receipt)) return invalid();
  }
}

async function planOwner(tx: TenantTransaction, context: TenantContext, expected: Execution, raw: CreativeResponse, options: LockOptions) {
  const scope = await loadCreativeResponseAdoptionOwner(tx, context, expected, options);
  const admitted = await admitOwner(tx, context, scope), { owner, execution } = admitted;
  const response = parseCreativeResponse(raw);
  responseMatches(execution, response);
  let outputs: CreativeAdoptionOwnerOutput[];
  let details: unknown;
  if (owner.kind === "creative_adaptation") {
    const master = owner.master!;
    if (execution.stepKey.startsWith("outpaint:")) {
      if (response.kind !== "pod") return invalid();
      const decoded = decodePodResponse(response.checkpoint);
      const raster = decoded.outputs.find(output => ["image/png", "image/jpeg", "image/webp", "image/tiff"].includes(output.mediaType));
      if (!raster || decoded.modelKey !== execution.receipt?.modelKey || decoded.modelVersion !== execution.receipt.modelVersion) return invalid();
      // Match the v1 structured-result gateway receipt: replace base64 with
      // exact byte size/SHA while preserving the original JSON property order.
      if (response.checkpoint.kind === "result") {
        const original = JSON.parse(response.checkpoint.rawBody) as { outputs: Array<Record<string, unknown>> } & Record<string, unknown>;
        const summary = { ...original, outputs: original.outputs.map((output, index) => {
          const metadata = Object.fromEntries(Object.entries(output).filter(([key]) => key !== "dataBase64"));
          const bytes = decoded.outputs[index]!.bytes;
          return { ...metadata, byteSize: bytes.byteLength, sha256: hashPodResponse(bytes) };
        }) };
        if (hashPodResponse(JSON.stringify(summary)) !== execution.responseChecksum) return invalid();
      }
      details = { modelKey: decoded.modelKey, modelVersion: decoded.modelVersion, qualitySnapshot: decoded.qualityCheckSnapshot,
        generatedRegions: raster.metadata.inferenceRegions ?? [] };
      outputs = [await inspectOutput({ bytes: raster.bytes, mediaType: raster.mediaType, role: "expanded" }, true, {
        source: master.rightsMetadata.source, derivative: { kind: "ai_outpaint", sourceAssetId: master.id, sourceAssetVersion: master.version,
          sourceChecksum: master.checksumSha256, originalRights: master.rightsMetadata },
        modelKey: decoded.modelKey, modelVersion: decoded.modelVersion, creativeDesignVersionId: owner.version.id,
      })];
    } else {
      if (response.kind !== "local") return invalid();
      const result = AdaptationResult.parse(response.result), decoded = decodeCreativeOutputs(response);
      if (decoded.length !== 1 || decoded[0]!.role !== "aspect_variant" || decoded[0]!.mediaType !== "image/png") return invalid();
      details = result;
      outputs = [await inspectOutput(decoded[0]!, master.aiGenerated || result.mode === "ai_outpaint", {
        source: master.rightsMetadata.source, creativeDesignVersionId: owner.version.id, printSpecVersionId: owner.spec.id,
        derivative: { kind: result.mode, sourceAssetId: master.id, sourceAssetVersion: master.version, sourceChecksum: master.checksumSha256,
          originalRights: master.rightsMetadata }, adaptationMode: result.mode, generatedRegions: result.generatedRegions,
      })];
      assertAdaptationDimensions(outputs[0]!, result, owner.spec.aspectWidth / owner.spec.aspectHeight);
    }
  } else if (owner.kind === "template_compile") {
    if (response.kind !== "local") return invalid();
    const result = CompileResult.parse(response.result), decoded = decodeCreativeOutputs(response), roles = decoded.map(row => row.role);
    if (new Set(roles).size !== roles.length || roles.some(role => !["background", "foreground", "mask", "preview", "manifest"].includes(role))
      || ["background", "foreground", "preview", "manifest"].some(role => !roles.includes(role))
      || decoded.some(row => row.mediaType !== (row.role === "manifest" ? "application/json" : "image/png"))
      || result.manifest.slotKey !== owner.inspection.slotKey || result.manifest.compilerVersion !== owner.inspection.compilerVersion
      || Boolean(result.manifest.files.mask) !== roles.includes("mask")) return invalid();
    const manifestBytes = decoded.find(row => row.role === "manifest")!.bytes;
    const manifest = MockupRenderManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
    if (!isDeepStrictEqual(manifest, result.manifest) || manifest.source.byteSize !== owner.source.byteSize) return invalid();
    details = result;
    outputs = [];
    for (const output of decoded) {
      const inspected = await inspectOutput(output, owner.source.aiGenerated, {
        ...creativeDerivedRights([owner.source], { kind: "controlled_psd_compile", compilerVersion: MOCKUP_COMPILER_VERSION }),
        inspectionId: owner.inspection.id, compiledAssetKind: output.role,
      }, 100_000_000);
      if (output.role !== "manifest" && (inspected.width !== manifest.canvas.width || inspected.height !== manifest.canvas.height)) return invalid();
      outputs.push(inspected);
    }
  } else if (owner.kind === "mockup_render") {
    if (response.kind !== "local") return invalid();
    const result = MockupResult.parse(response.result), decoded = decodeCreativeOutputs(response);
    if (result.outputId !== owner.output.id || decoded.length !== 1 || decoded[0]!.role !== "mockup" || decoded[0]!.mediaType !== "image/png") return invalid();
    details = result;
    const dependencies = admitted.dependencies;
    const inspectionId = "mockupInspectionId" in admitted ? admitted.mockupInspectionId : undefined;
    if (!inspectionId || dependencies.length !== 2) return changed();
    outputs = [await inspectOutput(decoded[0]!, dependencies.some(row => row.aiGenerated), {
      ...creativeDerivedRights(dependencies, { kind: "controlled_mockup_render", compilerVersion: MOCKUP_COMPILER_VERSION }),
      mockupBatchItemId: owner.item.id, mockupOutputId: owner.output.id, designVersionId: owner.item.designVersionId,
      templatePackVersionId: owner.pack.id, templateInspectionId: inspectionId,
    }, 100_000_000)];
    const canvas = "mockupCanvas" in admitted ? admitted.mockupCanvas : undefined;
    if (!canvas || outputs[0]!.width !== result.width || outputs[0]!.height !== result.height
      || outputs[0]!.width !== canvas.width || outputs[0]!.height !== canvas.height) return invalid();
  } else {
    if (response.kind !== "studio" || response.text !== null) return unsupported();
    const decoded = decodeCreativeOutputs(response);
    if (decoded.length !== 1 || !["image/png", "image/jpeg", "image/webp"].includes(decoded[0]!.mediaType)
      || decoded[0]!.role !== "image" || decoded[0]!.bytes.length > 20 * 1024 * 1024
      || response.receipt.modelKey !== owner.generation.modelSnapshot.model || response.providerTaskId !== owner.generation.providerTaskId) return invalid();
    details = { modelVersion: response.receipt.modelVersion };
    const inherited = admitted.dependencies.length
      ? creativeDerivedRights(admitted.dependencies, { kind: "studio_image_generation", generationId: owner.generation.id })
      : { source: { kind: "ai_generated", reference: `studio:${owner.generation.id}` } };
    outputs = [await inspectOutput(decoded[0]!, true, { ...inherited,
      studioScope: owner.generation.scope, generationId: owner.generation.id, model: owner.generation.modelSnapshot.model,
      modelVersion: response.receipt.modelVersion, references: owner.generation.references })];
  }
  outputs = outputs.map(output => ({ ...output, rightsMetadata: { ...output.rightsMetadata,
    creativeResponseOriginal: { executionId: execution.id, inputFingerprint: execution.inputFingerprint, responseChecksum: execution.responseChecksum } } }));
  const summary = summaryOwner(owner);
  const checksum = digest({ version: 1, execution, source: scope.source, owner, dependencies: admitted.dependencies,
    details, outputs: outputs.map(output => ({ role: output.role, mediaType: output.mediaType, checksumSha256: output.checksumSha256,
      byteSize: output.byteSize, width: output.width, height: output.height, aiGenerated: output.aiGenerated,
      rightsStatus: output.rightsStatus, rightsMetadata: output.rightsMetadata })) });
  return { admitted, details, plan: { pin: { version: 1 as const, executionId: execution.id, ...summary, checksum }, outputs } };
}

function summaryOwner(owner: CreativeAdoptionOwnerScope["owner"]) {
  if (owner.kind === "creative_adaptation") return { kind: owner.kind, ownerId: owner.version.id, parentId: owner.batch.id, status: owner.version.status };
  if (owner.kind === "template_compile") return { kind: owner.kind, ownerId: owner.inspection.id, parentId: null, status: owner.inspection.status };
  if (owner.kind === "mockup_render") return { kind: owner.kind, ownerId: owner.item.id, parentId: owner.batch.id, status: owner.output.status };
  return { kind: owner.kind, ownerId: owner.generation.id, parentId: owner.generation.scope === "unassigned" ? null : owner.generation.scope, status: owner.generation.status };
}

/** Every output is fully decoded and provenance is derived from current real
 * sources. The service must scan all bytes before registering any output. */
export async function pinCreativeResponseAdoptionOwner(tx: TenantTransaction, context: TenantContext, execution: Execution,
  response: CreativeResponse, options: LockOptions = {}): Promise<CreativeAdoptionOwnerPlan> {
  return (await planOwner(tx, context, execution, response, options)).plan;
}

/** Use this exact metadata for each new unverified asset. No source is relabeled
 * owned, licensed or original AI merely because this command adopted it. */
export function creativeAdoptionOwnerAssetMetadata(plan: CreativeAdoptionOwnerPlan, output: CreativeAdoptionOwnerOutput,
  adoptionId: string): Record<string, unknown> {
  z.uuidv7().parse(adoptionId);
  if (!plan.outputs.some(row => row.role === output.role && row.checksumSha256 === output.checksumSha256)) return invalid();
  return json({ ...output.rightsMetadata, creativeResponseAdoption: { adoptionId, executionId: plan.pin.executionId,
    ownerKind: plan.pin.kind, ownerId: plan.pin.ownerId, basisChecksum: plan.pin.checksum, role: output.role } });
}

async function registered(tx: TenantTransaction, authority: TenantContext, plan: CreativeAdoptionOwnerPlan,
  pins: CreativeAdoptionRegisteredAsset[], adoptionId: string) {
  if (pins.length !== plan.outputs.length || new Set(pins.map(row => row.role)).size !== pins.length
    || new Set(pins.map(row => row.id)).size !== pins.length) return invalid();
  const ids = pins.map(row => row.id).sort();
  const files = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).orderBy(asc(assetFiles.id)).for("share") : [];
  if (files.length !== ids.length) return changed();
  return plan.outputs.map(output => {
    const pin = pins.find(row => row.role === output.role), file = files.find(row => row.id === pin?.id);
    if (!pin || !file || file.tenantId !== authority.tenantId || file.ownerUserId !== authority.userId || file.deletedAt
      || file.assetDomain !== "authorized" || file.rightsStatus !== "unverified" || file.version !== pin.version
      || !file.objectKey.startsWith(`tenants/${authority.tenantId}/authorized/${output.checksumSha256}/`)
      || file.checksumSha256 !== pin.checksumSha256 || file.checksumSha256 !== output.checksumSha256 || file.mediaType !== output.mediaType
      || file.byteSize !== output.byteSize || file.aiGenerated !== output.aiGenerated
      || !isDeepStrictEqual(json(file.rightsMetadata), creativeAdoptionOwnerAssetMetadata(plan, output, adoptionId))) return changed();
    requireAssetAuthority(authority, Permission.AssetRead, file);
    requireAssetAuthority(authority, Permission.AssetWrite, file);
    return { role: output.role, file };
  });
}

/** Call only inside the service's fenced final transaction, after exact object
 * readback and scans. Original execution, fees and review records are never
 * rewritten. Its independent adoption fact must commit atomically with this. */
export async function commitCreativeResponseAdoptionOwner(tx: TenantTransaction, context: TenantContext, execution: Execution,
  response: CreativeResponse, expectedPin: CreativeAdoptionOwnerPin, assets: CreativeAdoptionRegisteredAsset[], adoptionId: string): Promise<CreativeAdoptionOwnerReceipt> {
  z.uuidv7().parse(adoptionId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${execution.id}:creative-response-owner-adoption`},0))`);
  const prepared = await planOwner(tx, context, execution, response, { lock: "update" });
  if (!isDeepStrictEqual(prepared.plan.pin, expectedPin)) return changed();
  const { admitted, plan } = prepared, { owner, authority } = admitted;
  const stored = await registered(tx, authority, plan, assets, adoptionId);
  const file = (role: string) => stored.find(row => row.role === role)?.file ?? invalid();
  const relation = async (from: Asset, to: Asset, relationType: "result_to_derivative" | "result_to_template") => {
    await tx.insert(artifactRelations).values({ id: createEntityId(), tenantId: context.tenantId,
      fromAssetId: from.id, fromAssetVersion: from.version, toAssetId: to.id, toAssetVersion: to.version,
      relationType, createdBy: context.userId }).onConflictDoNothing();
  };
  let saved: SavedOwner, status: string;
  if (owner.kind === "creative_adaptation") {
    if (execution.stepKey.startsWith("outpaint:")) {
      const output = file("expanded");
      await relation(owner.master!, output, "result_to_derivative");
      status = "child_artifact_ready";
      saved = { kind: "adaptation_outpaint", creativeDesignVersionId: owner.version.id, printSpecVersionId: owner.spec.id,
        parentExecutionId: owner.parent!.id, assetId: output.id, parentStatus: owner.parent!.phase, parentRequiresLocalAdaptation: true };
    } else {
      const details = AdaptationResult.parse(prepared.details), output = file("aspect_variant"), linkId = createEntityId();
      await tx.insert(creativeDesignVersionAssets).values({ id: linkId, tenantId: context.tenantId,
        creativeDesignVersionId: owner.version.id, assetId: output.id, assetVersion: output.version, role: "aspect_variant",
        printSpecVersionId: owner.spec.id, adaptationMode: details.mode, generatedRegions: details.generatedRegions, qualitySnapshot: details.qualitySnapshot });
      await relation(owner.master!, output, "result_to_derivative");
      const ready = new Set([...owner.links.filter(row => row.role === "aspect_variant").map(row => row.printSpecVersionId), owner.spec.id]);
      status = owner.item.printSpecVersionIds.every(id => ready.has(id)) ? "pending_review" : owner.version.status;
      if (status === "pending_review") await tx.update(creativeDesignVersions).set({ status: "pending_review", rejectionReason: null })
        .where(eq(creativeDesignVersions.id, owner.version.id));
      saved = { kind: "adaptation_spec", creativeDesignVersionId: owner.version.id, printSpecVersionId: owner.spec.id, linkId, assetId: output.id };
    }
  } else if (owner.kind === "template_compile") {
    const details = CompileResult.parse(prepared.details), manifest = file("manifest"), mask = stored.find(row => row.role === "mask")?.file;
    await tx.update(mockupTemplateSourceInspections).set({ status: "completed", compilation: {
      canvasWidth: details.manifest.canvas.width, canvasHeight: details.manifest.canvas.height,
      slotKey: details.manifest.slotKey, transform: details.manifest.transform, backgroundAssetId: file("background").id,
      foregroundAssetId: file("foreground").id, ...(mask ? { maskAssetId: mask.id } : {}), previewAssetId: file("preview").id,
      manifestAssetId: manifest.id, checksumSha256: manifest.checksumSha256, ssimPermille: details.ssimPermille, compilerVersion: MOCKUP_COMPILER_VERSION,
    }, warnings: details.warnings, errorCode: null, errorMessage: null, completedAt: sql`clock_timestamp()` })
      .where(eq(mockupTemplateSourceInspections.id, owner.inspection.id));
    for (const output of stored) await relation(owner.source, output.file, "result_to_template");
    status = "completed";
    saved = { kind: "template_compile", inspectionId: owner.inspection.id, manifestAssetId: manifest.id, ssimPermille: details.ssimPermille, confirmed: false };
  } else if (owner.kind === "mockup_render") {
    const details = MockupResult.parse(prepared.details), output = file("mockup");
    await tx.update(mockupBatchOutputs).set({ status: "succeeded", assetId: output.id, assetVersion: output.version,
      checksumSha256: output.checksumSha256, width: details.width, height: details.height, qualitySnapshot: details.qualitySnapshot,
      errorCode: null, errorMessage: null, completedAt: sql`clock_timestamp()` }).where(eq(mockupBatchOutputs.id, owner.output.id));
    for (const [index, source] of admitted.dependencies.entries()) await relation(source, output, index === 0 ? "result_to_derivative" : "result_to_template");
    await refreshMockupOwner(tx, owner.item.id, owner.batch.id);
    status = "succeeded";
    saved = { kind: "mockup_render", batchId: owner.batch.id, itemId: owner.item.id, outputId: owner.output.id, assetId: output.id,
      attempt: owner.output.attempt, approved: false };
  } else {
    const output = stored[0]!.file, entryId = createEntityId(), revisionId = createEntityId(), generation = owner.generation;
    await tx.insert(creativeStudioEntries).values({ id: entryId, tenantId: context.tenantId, ownerId: context.userId,
      scope: generation.scope, namespace: "image_files", key: `image:${generation.id}`, revision: 1, assetId: output.id });
    await tx.insert(creativeStudioRevisions).values({ id: revisionId, tenantId: context.tenantId, entryId, revision: 1, assetId: output.id });
    await tx.update(creativeStudioGenerations).set({ status: "completed", assetId: output.id, error: null, updatedAt: sql`clock_timestamp()` })
      .where(eq(creativeStudioGenerations.id, generation.id));
    status = "completed";
    saved = { kind: "studio_generation", generationId: generation.id, entryId, revisionId, revision: 1, assetId: output.id };
  }
  const { checksum: basisChecksum, ...identity } = plan.pin;
  const receipt = { ...identity, adoptionId, status, basisChecksum, saved,
    artifacts: stored.map(row => ({ role: row.role, assetId: row.file.id, version: row.file.version, checksumSha256: row.file.checksumSha256 })) };
  return { ...receipt, checksum: digest(receipt) };
}

/** Same latest-slot aggregation as the real Worker, after the caller has locked
 * the batch and all its items. No review state or production approval is added. */
async function refreshMockupOwner(tx: TenantTransaction, itemId: string, batchId: string) {
  const rows = await tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, itemId));
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!latest.has(row.slotKey) || latest.get(row.slotKey)!.attempt < row.attempt) latest.set(row.slotKey, row);
  const outputs = [...latest.values()], active = outputs.some(row => ["queued", "running"].includes(row.status));
  const good = outputs.filter(row => ["succeeded", "approved", "rejected"].includes(row.status)).length;
  await tx.update(mockupBatchItems).set({ status: active ? "running" : good === outputs.length ? "awaiting_review" : good ? "partially_succeeded" : "failed",
    completedAt: active ? null : sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(mockupBatchItems.id, itemId));
  const items = await tx.select({ status: mockupBatchItems.status }).from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId));
  const failedCount = items.filter(row => row.status === "failed").length, completedCount = items.filter(row => row.status === "completed").length;
  const finished = items.every(row => ["awaiting_review", "partially_succeeded", "failed", "completed"].includes(row.status));
  const status = finished ? failedCount === items.length ? "failed" : failedCount > 0 || items.some(row => row.status === "partially_succeeded")
    ? "partially_succeeded" : "awaiting_review" : "running";
  await tx.update(mockupBatches).set({ status, failedCount, completedCount, completedAt: finished ? sql`clock_timestamp()` : null,
    updatedAt: sql`clock_timestamp()` }).where(eq(mockupBatches.id, batchId));
}
