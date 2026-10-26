import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { authorize, erpPermissionContext, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { StudioRpcSchema } from "@yummyai/contracts/pod/creative-studio";
import { CreativeOwnerResponseAdoptionReceiptSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { StudioImagePricingSchema, StudioPaidImageInputSchema, StudioPaidImageQuoteSchema,
  StudioPaidImageRequestSchema, type StudioPaidImageInput, type StudioPaidImageQuote } from "@yummyai/contracts/pod/studio-paid-image";
import { aiBudgetLedger, assetFiles, creativeExecutions, creativeOwnerResponseAdoptions, creativeStudioEntries, creativeStudioGenerations,
  creativeStudioImageRequests as requests, creativeStudioImageCancellations as cancellations, modelProviderConfigs, modelRoutes, recordAuditInTransaction,
  visualDeliveryModelFingerprint, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { checkStudioImageBudget, reserveStudioImageBudget, stageCreativeExecution, studioImageAdmission,
  studioImageHash, studioImageWireSize } from "@yummyai/pod-core";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { modelConfigurationRevision } from "../ai/model-configuration-revision.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { currentCreativeWorkspaceAuthority, requireReferenceAuthority } from "./canvas-workflow-access.js";
import { StudioGenerationEnqueuer } from "./studio-generation.service.js";
import { currentDesignAuthority } from "./design-access.js";
import { resolveStudioVisualImagePrerequisites, StudioVisualImagePrerequisiteError } from "./studio-visual-image-prerequisites.js";
import type { VisualDeliverySnapshot } from "@yummyai/contracts/catalog/product-visuals";

type Row = typeof requests.$inferSelect;
type Prepare = { scope: string; input: unknown };
type Address = { scope: string; requestId: string };
type Commit = Address & { quoteHash: string; confirmed: true };
const changed = () => new ConflictException({ code: "studio_paid_image_changed" });
const invalid = () => new BadRequestException({ code: "studio_paid_image_invalid" });
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
const inputFingerprint = (input: StudioPaidImageInput, visualDelivery: VisualDeliverySnapshot | null) =>
  studioImageHash(visualDelivery ? { input, visualDelivery } : input);
const parse = (operation: string, raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const result = StudioRpcSchema.safeParse({ ...raw, operation });
  if (!result.success) throw invalid();
  return result.data;
};

/** A prepared quote is an immutable original request, never a paid queue item.
 * The existing generation owner, budget ledger and execution Harness perform
 * every committed effect. Lookup never calls generation.get's legacy submit. */
@Injectable()
export class StudioPaidImageService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(StudioGenerationEnqueuer) private readonly queue: StudioGenerationEnqueuer,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService) {}

  private async authority(tx: TenantTransaction, context: TenantContext, scope: string, write = false) {
    return currentCreativeWorkspaceAuthority(tx, context, scope, write ? [Permission.DesignWrite, Permission.AssetWrite] : []);
  }
  private async lock(tx: TenantTransaction, context: TenantContext) {
    // Same order as all model producers, followed by the personal original key.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`},0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:studio-generation`},0))`);
  }
  private async row(tx: TenantTransaction, context: TenantContext, address: Address, lock = false) {
    const query = tx.select().from(requests).where(and(eq(requests.ownerId, context.userId), eq(requests.requestId, address.requestId)));
    const [row] = await (lock ? query.for("update") : query.for("share"));
    if (row && row.scope !== address.scope) throw changed();
    return row;
  }
  private async clock(tx: TenantTransaction) {
    const [row] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
    const now = new Date(row!.now);
    if (!Number.isFinite(now.getTime())) throw changed();
    return now;
  }
  private async references(tx: TenantTransaction, authority: TenantContext, refs: StudioPaidImageQuote["references"], checkedAt: number, exact: boolean) {
    const ids = [...new Set(refs.map(ref => ref.assetId))];
    const assets = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).for("share") : [];
    if (ids.length !== assets.length) throw changed();
    requireReferenceAuthority(authority, assets, checkedAt);
    for (const ref of refs) {
      const asset = assets.find(file => file.id === ref.assetId)!;
      const kind = (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind;
      if (asset.deletedAt || asset.assetDomain !== "authorized" || !["owned", "licensed", "ai_generated"].includes(kind ?? "")
        || !["image/png", "image/jpeg", "image/webp"].includes(asset.mediaType)
        || exact && (asset.rightsStatus !== "approved" || asset.version !== ref.version || asset.checksumSha256 !== ref.checksum)) throw changed();
    }
  }

  private async resolve(tx: TenantTransaction, context: TenantContext, scope: string, original: StudioPaidImageInput,
    project: Awaited<ReturnType<CanvasBridgeService["get"]>> | null) {
    const { authority, checkedAt } = await this.authority(tx, context, scope, true);
    const routes = await tx.select().from(modelRoutes).orderBy(modelRoutes.id);
    const route = routes.find(value => value.id === original.modelId.toLowerCase());
    if (!route || route.status !== "enabled" || route.taskType !== "studio_image" || route.targets.length !== 1) throw changed();
    const target = route.targets[0]!;
    const [provider] = await tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, target.providerConfigId), eq(modelProviderConfigs.status, "enabled"))).for("share");
    if (!provider || !["openai", "openai-compatible"].includes(provider.provider)
      || modelConfigurationRevision(provider, routes) !== original.selectionRevision) throw changed();
    if (!/^[\p{L}\p{N}_.:/ -]{1,160}$/u.test(target.providerModel)) throw invalid();
    const pricing = StudioImagePricingSchema.safeParse(target.imagePricing);
    if (!pricing.success) throw new ConflictException({ code: "studio_image_pricing_required" });
    const normalized = StudioPaidImageInputSchema.safeParse({ ...original, modelId: route.id, size: studioImageWireSize(original.size),
      prompt: project?.designInstructions ? `${original.prompt}\n\n项目固定需求：\n${project.designInstructions}` : original.prompt });
    if (!normalized.success) throw invalid();
    const references: StudioPaidImageQuote["references"] = [];
    for (const key of normalized.data.referenceKeys) {
      const [entry] = await tx.select({ asset: assetFiles }).from(creativeStudioEntries).innerJoin(assetFiles, eq(assetFiles.id, creativeStudioEntries.assetId))
        .where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.namespace, "image_files"),
          eq(creativeStudioEntries.key, key), isNull(creativeStudioEntries.deletedAt), isNull(assetFiles.deletedAt))).for("share", { of: [creativeStudioEntries, assetFiles] });
      if (!entry) throw changed();
      if (!references.some(ref => ref.assetId === entry.asset.id)) references.push({ assetId: entry.asset.id, version: entry.asset.version, checksum: entry.asset.checksumSha256 });
    }
    if (project?.workflow?.requirements) for (const asset of project.referenceAssets) {
      if (!references.some(ref => ref.assetId === asset.id)) references.push({ assetId: asset.id, version: asset.version, checksum: asset.checksumSha256 });
    }
    if (references.length > 10) throw invalid();
    let visual: Awaited<ReturnType<typeof resolveStudioVisualImagePrerequisites>>;
    try {
      visual = await resolveStudioVisualImagePrerequisites(tx, authority, { scope, input: normalized.data, references,
        model: { modelId: route.id, providerConfigId: provider.id, model: target.providerModel,
          providerFingerprint: visualDeliveryModelFingerprint(provider, target) }, pricing: pricing.data, checkedAt });
    } catch (cause) {
      if (cause instanceof StudioVisualImagePrerequisiteError) throw new ConflictException({ code: cause.code });
      throw cause;
    }
    const input = visual.input, refs = visual.references;
    await this.references(tx, authority, refs, (await this.clock(tx)).getTime(), true);
    await checkStudioImageBudget(tx, context.tenantId, { pricing: pricing.data, model: target.providerModel, provider: provider.provider });
    return { authority, input, refs, provider, route, target, pricing: pricing.data,
      visualDelivery: visual.visualDelivery, visualCeilingUsd: visual.visualCeilingUsd };
  }

  async prepare(context: TenantContext, raw: Prepare) {
    const parsed = parse("paid.image.prepare", raw);
    if (parsed.operation !== "paid.image.prepare") throw invalid();
    const original = StudioPaidImageInputSchema.safeParse(parsed.input);
    if (!original.success) throw invalid();
    const { scope } = parsed;
    // Original project versions are immutable; the owning transaction rechecks
    // the current project status and every source permission before any write.
    const project = scope === "unassigned" ? null : await this.bridge.get(context, scope);
    return withTenant(this.database.db, context, async tx => {
      await this.authority(tx, context, scope, true); await this.lock(tx, context);
      // The immutable cancellation table deliberately has no UPDATE grant.
      // The shared original-key advisory lock serializes its INSERT with prepare.
      const [cancelled] = await tx.select().from(cancellations).where(and(eq(cancellations.ownerId, context.userId), eq(cancellations.requestId, original.data.requestId)));
      if (cancelled) throw new ConflictException({ code: "studio_paid_image_cancelled" });
      const existing = await this.row(tx, context, { scope, requestId: original.data.requestId }, true);
      if (existing) {
        if (!isDeepStrictEqual(existing.originalInput, original.data)) throw changed();
        return this.view(tx, context, existing);
      }
      const current = await this.resolve(tx, context, scope, original.data, project), now = await this.clock(tx);
      const fixed = { version: 1 as const, inputFingerprint: inputFingerprint(current.input, current.visualDelivery),
        modelId: current.route.id, providerConfigId: current.provider.id, model: current.target.providerModel,
        label: current.route.modelKey, providerLabel: current.provider.label, selectionRevision: original.data.selectionRevision,
        providerFingerprint: visualDeliveryModelFingerprint(current.provider, current.target), contextAuthority: stamp(current.authority),
        unit: "image" as const, count: 1 as const, currency: "USD" as const, basis: "operator_estimate" as const,
        pricing: current.pricing, size: current.input.size, quality: current.input.quality, background: current.input.background,
        references: current.refs, ...(current.visualDelivery ? { visualDelivery: current.visualDelivery } : {}),
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString() };
      const quote = StudioPaidImageQuoteSchema.parse({ ...fixed, quoteHash: studioImageHash(fixed) });
      const [created] = await tx.insert(requests).values({ id: createEntityId(), tenantId: context.tenantId, ownerId: context.userId,
        scope, requestId: current.input.requestId, originalInput: original.data, input: current.input, quote, createdAt: now }).returning();
      await recordAuditInTransaction(tx, context, { action: "studio.image.prepare", resourceType: "studio_image_request", resourceId: created!.id,
        result: "success", metadata: { quoteHash: quote.quoteHash, modelId: quote.modelId } });
      return this.view(tx, context, created!);
    });
  }

  async commit(context: TenantContext, raw: Commit) {
    const parsed = parse("paid.image.commit", raw);
    if (parsed.operation !== "paid.image.commit") throw invalid();
    // Do not even resolve provider credentials while the operator gate is off.
    const admission = studioImageAdmission(context.tenantId);
    if (!admission.enabled) throw new ConflictException({ code: "studio_paid_execution_paused" });
    const project = parsed.scope === "unassigned" ? null : await this.bridge.get(context, parsed.scope);
    const committed = await withTenant(this.database.db, context, async tx => {
      await this.authority(tx, context, parsed.scope, true); await this.lock(tx, context);
      const row = await this.row(tx, context, parsed, true);
      if (!row) throw new NotFoundException({ code: "studio_paid_image_missing" });
      if (row.quote.quoteHash !== parsed.quoteHash) throw changed();
      // Original committed results are read back, never enqueued by replay.
      if (row.generationId) return { row, created: false };
      if (row.cancelledAt) throw new ConflictException({ code: "studio_paid_image_cancelled" });
      const now = await this.clock(tx);
      if (new Date(row.quote.expiresAt).getTime() <= now.getTime()) throw new ConflictException({ code: "studio_paid_image_expired" });
      const current = await this.resolve(tx, context, row.scope, row.originalInput, project);
      const { quoteHash, ...quote } = row.quote;
      if (studioImageHash(quote) !== quoteHash || stamp(current.authority) !== quote.contextAuthority
        || !isDeepStrictEqual(current.input, row.input) || inputFingerprint(current.input, current.visualDelivery) !== quote.inputFingerprint
        || !isDeepStrictEqual(current.refs, quote.references) || !isDeepStrictEqual(current.pricing, quote.pricing)
        || !isDeepStrictEqual(current.visualDelivery, quote.visualDelivery ?? null)
        || visualDeliveryModelFingerprint(current.provider, current.target) !== quote.providerFingerprint) throw changed();
      if (!studioImageAdmission(context.tenantId).enabled) throw new ConflictException({ code: "studio_paid_execution_paused" });
      const id = createEntityId();
      await tx.insert(creativeStudioGenerations).values({ id, tenantId: context.tenantId, ownerId: context.userId, scope: row.scope,
        requestId: row.requestId, input: row.input, references: quote.references,
        modelSnapshot: { providerConfigId: quote.providerConfigId, model: quote.model, capability: "image", routeId: quote.modelId,
          providerFingerprint: quote.providerFingerprint, ...(current.visualCeilingUsd !== undefined ? { visualCeilingUsd: current.visualCeilingUsd } : {}),
          paidImage: { imageRequestId: row.id, quoteHash, reservationUsd: quote.pricing.reservationUsd, estimatedUsd: quote.pricing.estimatedUsd } } });
      await reserveStudioImageBudget(tx, context.tenantId, { pricing: current.pricing, model: quote.model, provider: current.provider.provider }, id);
      await stageCreativeExecution(tx, current.authority, { kind: "studio_generation", ownerId: id, stepKey: "generate" }, "external_request");
      const acceptedAt = await this.clock(tx);
      if (acceptedAt.getTime() >= Date.parse(quote.expiresAt)) throw new ConflictException({ code: "studio_paid_image_expired" });
      const [saved] = await tx.update(requests).set({ generationId: id, committedAt: acceptedAt }).where(eq(requests.id, row.id)).returning();
      await recordAuditInTransaction(tx, context, { action: "studio.image.commit", resourceType: "studio_image_request", resourceId: row.id,
        result: "success", metadata: { generationId: id, quoteHash } });
      return { row: saved!, created: true };
    });
    if (committed.created) {
      // A lost queue ACK is an unknown delivery. The persisted original intent
      // and existing scheduler own recovery; neither lookup nor replay queues it.
      try { await this.queue.enqueue({ id: committed.row.generationId!, tenantId: context.tenantId, userId: context.userId }); }
      catch { /* Original pending intent and reservation remain available. */ }
    }
    const found = await this.lookup(context, { scope: committed.row.scope, requestId: committed.row.requestId });
    if (found.status !== "found") throw changed();
    return found.request;
  }

  async lookup(context: TenantContext, raw: Address) {
    const parsed = parse("paid.image.lookup", raw);
    if (parsed.operation !== "paid.image.lookup") throw invalid();
    return withTenant(this.database.db, context, async tx => {
      await this.authority(tx, context, parsed.scope);
      const row = await this.row(tx, context, parsed);
      return row ? { status: "found" as const, request: await this.view(tx, context, row) }
        : { status: "missing" as const, scope: parsed.scope, requestId: parsed.requestId };
    });
  }
  async requests(context: TenantContext, raw: { scope: string; cursor?: string; limit?: number }) {
    const parsed = parse("paid.image.requests", raw);
    if (parsed.operation !== "paid.image.requests") throw invalid();
    return withTenant(this.database.db, context, async tx => {
      await this.authority(tx, context, parsed.scope);
      const rows = await tx.select().from(requests).where(and(eq(requests.ownerId, context.userId), eq(requests.scope, parsed.scope),
        parsed.cursor ? lt(requests.id, parsed.cursor) : undefined)).orderBy(desc(requests.id)).limit(parsed.limit + 1).for("share");
      const items = []; for (const row of rows.slice(0, parsed.limit)) items.push(await this.view(tx, context, row));
      return { items, nextCursor: rows.length > parsed.limit ? items.at(-1)!.id : null };
    });
  }
  async cancel(context: TenantContext, raw: Address & { quoteHash: string }) {
    const parsed = parse("paid.image.cancel", raw);
    if (parsed.operation !== "paid.image.cancel") throw invalid();
    return withTenant(this.database.db, context, async tx => {
      const { authority } = await this.authority(tx, context, parsed.scope);
      authorize(authority, Permission.DesignWrite, { ownerId: context.userId });
      authorize(authority, Permission.AssetWrite, { ownerId: context.userId });
      await this.lock(tx, context);
      const row = await this.row(tx, context, parsed, true);
      if (!row) throw new NotFoundException({ code: "studio_paid_image_missing" });
      if (row.quote.quoteHash !== parsed.quoteHash || row.generationId) throw changed();
      if (row.cancelledAt) return this.view(tx, context, row);
      const [saved] = await tx.update(requests).set({ cancelledAt: await this.clock(tx) }).where(eq(requests.id, row.id)).returning();
      return this.view(tx, context, saved!);
    });
  }

  async abandon(context: TenantContext, raw: Address) {
    const parsed = parse("paid.image.abandon", raw);
    if (parsed.operation !== "paid.image.abandon") throw invalid();
    return withTenant(this.database.db, context, async tx => {
      // Cancellation carries no former prompt, reference or result bytes. A
      // terminal/archived parent must not force an unsubmitted quote to linger.
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
      authorize(authority, Permission.DesignWrite, { ownerId: context.userId });
      authorize(authority, Permission.AssetWrite, { ownerId: context.userId });
      await this.lock(tx, context);
      const row = await this.row(tx, context, parsed, true);
      if (row?.generationId) throw changed();
      const [existing] = await tx.select().from(cancellations).where(and(eq(cancellations.ownerId, context.userId), eq(cancellations.requestId, parsed.requestId)));
      if (existing && existing.scope !== parsed.scope) throw changed();
      if (row && !row.cancelledAt) await tx.update(requests).set({ cancelledAt: await this.clock(tx) }).where(eq(requests.id, row.id));
      const [saved] = existing ? [existing] : await tx.insert(cancellations).values({ id: createEntityId(), tenantId: context.tenantId,
        ownerId: context.userId, scope: parsed.scope, requestId: parsed.requestId }).returning();
      return { version: 1 as const, id: saved!.id, scope: parsed.scope, requestId: parsed.requestId, status: "cancelled" as const };
    });
  }

  private async view(tx: TenantTransaction, context: TenantContext, row: Row) {
    const { authority, checkedAt } = await this.authority(tx, context, row.scope);
    await this.references(tx, authority, row.quote.references, checkedAt, false);
    const [generation] = row.generationId ? await tx.select().from(creativeStudioGenerations)
      .where(and(eq(creativeStudioGenerations.id, row.generationId), eq(creativeStudioGenerations.ownerId, context.userId))).for("share") : [];
    if (row.generationId && !generation) throw changed();
    const [execution] = generation ? await tx.select().from(creativeExecutions).where(and(eq(creativeExecutions.studioGenerationId, generation.id),
      eq(creativeExecutions.kind, "studio_generation"), eq(creativeExecutions.stepKey, "generate"))).for("share") : [];
    const [budget] = generation ? await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, generation.id)).for("share") : [];
    const [asset] = generation?.status === "completed" && generation.assetId ? await tx.select().from(assetFiles)
      .where(and(eq(assetFiles.id, generation.assetId), isNull(assetFiles.deletedAt), eq(assetFiles.assetDomain, "authorized"))).for("share") : [];
    if (asset) requireReferenceAuthority(authority, [asset], checkedAt);
    let responseAdoption;
    if (asset && generation && execution && ["failed", "uncertain"].includes(execution.phase)) {
      const [adopted] = await tx.select().from(creativeOwnerResponseAdoptions).where(and(
        eq(creativeOwnerResponseAdoptions.executionId, execution.id), eq(creativeOwnerResponseAdoptions.requestedBy, context.userId),
        eq(creativeOwnerResponseAdoptions.status, "committed"))).for("share");
      if (adopted) {
        const parsed = CreativeOwnerResponseAdoptionReceiptSchema.safeParse(adopted.receipt);
        const { checksum, ...owner } = adopted.ownerReceipt ?? {};
        const receipt = parsed.success ? parsed.data : undefined;
        if (!receipt || !adopted.planPin || receipt.id !== adopted.id || receipt.executionId !== execution.id || receipt.kind !== "studio_generation"
          || receipt.ownerId !== generation.id || receipt.parentId !== (row.scope === "unassigned" ? null : row.scope)
          || receipt.originalPhase !== execution.phase || receipt.inputFingerprint !== execution.inputFingerprint
          || receipt.responseChecksum !== execution.responseChecksum || receipt.encryptedChecksum !== execution.encryptedChecksum
          || checksum !== studioImageHash(owner) || checksum !== receipt.ownerReceiptChecksum || receipt.artifacts.length !== 1
          || receipt.artifacts[0]!.assetId !== asset.id || receipt.artifacts[0]!.version !== asset.version
          || receipt.artifacts[0]!.checksumSha256 !== asset.checksumSha256 || receipt.artifacts[0]!.byteSize !== asset.byteSize
          || receipt.artifacts[0]!.mediaType !== asset.mediaType || studioImageHash(asset.rightsMetadata.creativeResponseAdoption)
            !== studioImageHash({ adoptionId: adopted.id, executionId: execution.id, ownerKind: "studio_generation", ownerId: generation.id,
              basisChecksum: adopted.planPin.checksum, role: receipt.artifacts[0]!.role })) throw changed();
        responseAdoption = receipt;
      }
    }
    return StudioPaidImageRequestSchema.parse({ version: 1, id: row.id, scope: row.scope, requestId: row.requestId, originalInput: row.originalInput, input: row.input, quote: row.quote,
      status: row.cancelledAt ? "cancelled" : responseAdoption ? "completed" : execution?.phase === "uncertain" ? "uncertain"
        : generation?.status === "completed" && execution?.phase === "failed" ? "failed" : generation?.status ?? "prepared",
      generationId: row.generationId, createdAt: row.createdAt.toISOString(), committedAt: row.committedAt?.toISOString() ?? null,
      admission: studioImageAdmission(context.tenantId),
      ...(responseAdoption ? { responseAdoption } : {}),
      execution: { phase: execution?.phase ?? null, costUsd: execution?.receipt?.costUsd ?? null, budgetState: budget?.state ?? null,
        budgetAmountUsd: budget?.amountUsd ?? null, errorCode: execution?.errorCode ?? null },
      result: asset ? { assetId: asset.id, namespace: "image_files", key: `image:${generation!.id}`, mediaType: asset.mediaType,
        checksumSha256: asset.checksumSha256, byteSize: asset.byteSize, rightsStatus: asset.rightsStatus } : null });
  }
}
