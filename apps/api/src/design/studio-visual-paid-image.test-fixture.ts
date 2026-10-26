import { createHash, randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { SalesPlanFieldsSchema, type SalesPlanView } from "@yummyai/contracts/catalog/sales-plan";
import type { VisualSlotKey } from "@yummyai/contracts/catalog/product-visuals";
import { CanvasResultReceiptSchema } from "@yummyai/contracts/pod/canvas-bridge";
import { StudioNamespaceSchema } from "@yummyai/contracts/pod/creative-studio";
import { STUDIO_RESULT_INTENT_PREFIX, StudioOriginalInspectionSchema, StudioPinnedResultRequestSchema, StudioResultIntentSchema, StudioResultLookupSchema,
  studioResultIntentKey, type StudioPinnedResultRequest } from "@yummyai/contracts/pod/studio-original";
import type { StudioPaidImageRequest } from "@yummyai/contracts/pod/studio-paid-image";
import { assetFiles, aiBudgetLedger, creativeDesignBatches, creativeExecutions, creativeStudioEntries,
  creativeStudioGenerations, creativeStudioImageRequests, withTenant } from "@yummyai/database";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { and, asc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { requireStudioVisualPaidImageEnvironment } from "../../../../tools/testing/studio-visual-paid-image-environment.mjs";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { HttpStudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { StudioGenerationProcessor } from "../../../worker/src/processors/studio-generation.processor.js";
import { AuditService } from "../audit/audit.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import type { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { ProductVisualsService } from "../catalog/product-visuals.service.js";
import { SalesPlanService } from "../catalog/sales-plan.service.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { CanvasWorkflowService } from "./canvas-workflow.service.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { ProductionEditorService } from "./production-editor.service.js";
import { createStudioPaidImageFixture } from "./studio-paid-image.test-fixture.js";
import { parseStudioIntent, storedStudioValue } from "./studio-media-inspection-owner.js";

export type VisualPaidGroup = { plan: SalesPlanView; id: string; slots: Array<{ slotKey: VisualSlotKey; projectId: string }> };
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

/** Only bounded fixture/HTTP/database codes are reported, never query text,
 * provider responses, source paths, prompts or credentials from nested causes. */
function cleanupCodes(error: unknown) {
  const codes = new Set<string>(), seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 8 || seen.size >= 48) return;
    seen.add(value);
    if (value instanceof HttpException) codes.add("http_" + value.getStatus());
    if ("code" in value && typeof value.code === "string" && /^[A-Z0-9_]{5,100}$/.test(value.code)) codes.add(value.code);
    if (value instanceof Error && /^visual_fixture_[a-z_]+$/.test(value.message)) codes.add(value.message);
    if (value instanceof Error && value.message.startsWith("studio_paid_image_fixture_cleanup_failed phases="))
      codes.add(value.message.slice("studio_paid_image_fixture_cleanup_failed phases=".length).replace(/[^a-z0-9_:,+]/gi, "").slice(0, 500));
    if ("cause" in value) visit(value.cause, depth + 1);
    if (value instanceof AggregateError) for (const child of value.errors) visit(child, depth + 1);
  };
  visit(error, 0); return [...codes];
}

/** Uses the existing paid owner and reviewed synthetic product geometry. Only
 * queue delivery and the provider response transport are injected. No image is
 * customer artwork, a supplier specification or a production release. */
export async function createStudioVisualPaidImageFixture() {
  const environment = requireStudioVisualPaidImageEnvironment(), paid = await createStudioPaidImageFixture();
  const { database: db, storage } = paid;
  const actor = await paid.actor(undefined, "tenant"), context = await paid.grant(actor.context, Object.values(Permission), "tenant");
  const vault = new SecretVault(Buffer.alloc(32, 79)), audit = new AuditService(db), scan = paid.base.scanner;
  const reports = {} as AmazonOrderReportService;
  const editor = new ProductionEditorService(db, vault, storage, reports, audit, { enqueue: async () => {
    throw new Error("visual_fixture_production_render_forbidden");
  } }, scan);
  const work = new OrderWorkspaceService(db, vault, storage, reports, editor, scan), pod = paid.base.pod;
  const bridge = new CanvasBridgeService(db, storage, audit, pod, scan);
  const workflow = new CanvasWorkflowService(db, storage, bridge, pod, editor, audit);
  const assets = new CreativeStudioService(db, storage, scan, bridge, audit, paid.generations);
  const plans = new SalesPlanService(db, new ListingService(new DrizzleListingRepository(db)));
  const catalog = new ProductDevelopmentService(db, storage);
  const service = new ProductVisualsService(db, storage, plans, bridge, workflow, paid.generations, assets, audit, paid.paid);
  const planIds = new Set<string>(), scopes = new Set<string>();
  const calls: Array<{ path: string; n: number; size: string; quality: string; background: string; referenceChecksums: string[] }> = [];
  let templateId: string | undefined, specificationId: string, spuId: string, modelId = "";
  const sampleId = createEntityId();
  let costKnown = true;
  const opaque = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#428bc4" } }).png().toBuffer();
  const transparent = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 800, height: 800, channels: 4, background: "#428bc4" } }).png().toBuffer(), top: 112, left: 112 }]).png().toBuffer();
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "http://127.0.0.1:9" || !["/v1/images/generations", "/v1/images/edits"].includes(url.pathname) || init?.method !== "POST")
      throw new Error("visual_fixture_external_transport_forbidden");
    let n: number, background: string, size: string, quality: string;
    const referenceChecksums: string[] = [];
    if (typeof init.body === "string") {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      n = Number(body.n); background = String(body.background); size = String(body.size); quality = String(body.quality);
    } else if (init.body instanceof FormData) {
      n = Number(init.body.get("n")); background = String(init.body.get("background"));
      size = String(init.body.get("size")); quality = String(init.body.get("quality"));
      for (const key of ["image", "image[]"]) for (const value of init.body.getAll(key)) {
        if (!(value instanceof Blob)) throw new Error("visual_fixture_reference_not_bytes");
        referenceChecksums.push(sha(new Uint8Array(await value.arrayBuffer())));
      }
    } else throw new Error("visual_fixture_wire_body_invalid");
    if (n !== 1 || size !== "1024x1024" || quality !== "high" || !["transparent", "opaque"].includes(background))
      throw new Error("visual_fixture_not_one_fixed_image");
    calls.push({ path: url.pathname, n, size, quality, background, referenceChecksums });
    return Response.json({ model: "synthetic-visual-image-v1", data: [{ b64_json: (background === "transparent" ? transparent : opaque).toString("base64") }],
      ...(costKnown ? { costUsd: 0.01234567 } : {}) }, { headers: { "x-request-id": "synthetic-visual-image-" + calls.length } });
  };
  const processor = new StudioGenerationProcessor(db, storage, paid.modelVault, new HttpStudioGateway(transport),
    { scan: input => scan.scan(input.body, input.fileName, input.mediaType) }, paid.vault);
  const current = () => paid.current(context);
  async function setup() {
    paid.admission(context, false);
    await paid.policy(context); modelId = (await paid.channel(context)).modelId;
    const stored = await storage.putPrivate(context, { domain: "authorized", fileName: "synthetic-owned-pillow-sample.png", mediaType: "image/png", body: opaque });
    await withTenant(db.db, context, tx => tx.insert(assetFiles).values({ id: sampleId, tenantId: context.tenantId, ownerUserId: context.userId,
      ...stored, assetDomain: "authorized", fileName: "synthetic-owned-pillow-sample.png", mediaType: "image/png", byteSize: opaque.length,
      rightsStatus: "approved", rightsMetadata: { source: { kind: "owned" }, fixture: "synthetic-visual-input-only" } }));
    // Matches the existing product-visuals fixture, not the user's current
    // supplier rule or any live order's pinned manufacturing version.
    const document = createDefaultProductionDocument("shaped_pillow");
    if (document.productType !== "shaped_pillow") throw new Error("visual_fixture_product_type_invalid");
    document.name = "Synthetic visual geometry template";
    document.spec = { ...document.spec, widthMm: 254, heightMm: 254, declaredLongestMm: 254, sizeBasis: "cut_contour", minimumNeckBasis: "cut_contour",
      whiteBorderMm: 5, barcodeTab: { widthMm: 40, heightMm: 20, centerXMm: 127 }, sideMode: "single" };
    document.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 254, yMm: 0, smooth: false },
      { xMm: 254, yMm: 254, smooth: false }, { xMm: 0, yMm: 254, smooth: false }];
    for (const key of Object.keys(document.confirmations) as Array<keyof typeof document.confirmations>) document.confirmations[key] = true;
    let template = await editor.create(context, { name: document.name, document }); templateId = template.project.id;
    const source = await editor.upload(context, templateId, "synthetic.png", await sharp(opaque).resize(2048, 2048).png().toBuffer());
    if (!("version" in source)) throw new Error("visual_fixture_uploaded_media_invalid");
    document.layers = [{ id: "source", kind: "image", name: "Synthetic geometric source", assetId: source.id, assetVersion: source.version,
      xMm: 40, yMm: 40, widthMm: 170, heightMm: 170, rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false }];
    template = await editor.save(context, templateId, { expectedVersionId: template.version.id, document });
    await editor.review(context, templateId, template.version.id);
    const [profile] = await work.saveProfile(context, { code: "VIS-" + context.tenantId.slice(-8), name: document.name, projectId: templateId,
      versionId: template.version.id, instructions: "Synthetic template only No production release", expectedVersion: 0, idempotencyKey: randomUUID() });
    if (!profile) throw new Error("visual_fixture_profile_missing");
    const created = await catalog.createSpu(context, { code: "VIS-" + context.tenantId.slice(-8), name: "Synthetic visual product", idempotencyKey: randomUUID() });
    spuId = created.spu.id;
    const saved = await catalog.saveSpecification(context, { spuId, code: "ONE", name: "Synthetic ten inch", attributes: { size: "10" },
      facts: syntheticSpecificationFacts({ material: "Synthetic fabric", dimensions: "10 inch synthetic pillow", packageContents: "One synthetic pillow", packageQuantity: 1, factsConfirmed: true }),
      processProfileVersionId: profile.versionId, expectedVersion: 0, idempotencyKey: randomUUID() });
    specificationId = saved.specification.id;
  }
  async function group(totalBudgetUsd = 2): Promise<VisualPaidGroup> {
    const created = await plans.create(await current(), { spuId, fields: SalesPlanFieldsSchema.parse({ name: "Synthetic visual plan " + createEntityId(), mode: "custom", fulfillment: "fbm",
      specificationIds: [specificationId], positioning: "Synthetic original geometric subject" }), idempotencyKey: randomUUID() });
    planIds.add(created.plan.id);
    const prepared = await service.prepare(await current(), created.plan.id, { requestId: randomUUID(), expectedRevision: created.plan.revision,
      sampleAssetId: sampleId, sampleAttestation: "Synthetic owned sample front and white back", modelId, size: "1024x1024", direction: created.plan.fields.positioning,
      callCeilingUsd: 0.1, totalBudgetUsd, budgetAttested: true });
    const workspace = await service.get(await current(), created.plan.id), project = workspace.projects.find(row => row.id === prepared.groupId);
    if (!project || project.slots.length !== 4) throw new Error("visual_fixture_four_real_slots_missing");
    for (const slot of project.slots) scopes.add(slot.projectId);
    return { plan: created.plan, id: prepared.groupId, slots: project.slots };
  }
  async function prepare(value: VisualPaidGroup, slotKey: VisualSlotKey, artworkVersionId?: string) {
    const model = (await paid.generations.models(await current())).find(row => row.id === modelId);
    if (!model) throw new Error("visual_fixture_current_model_missing");
    return service.prepareImage(await current(), value.plan.id, value.id, { requestId: randomUUID(), slotKey, selectionRevision: model.selectionRevision,
      prompt: "Synthetic fixed subject", ...(artworkVersionId ? { artworkVersionId } : {}) });
  }
  const address = (request: StudioPaidImageRequest) => ({ slotKey: request.quote.visualDelivery!.slotKey, requestId: request.requestId });
  const commit = async (value: VisualPaidGroup, request: StudioPaidImageRequest) => service.commitImage(await current(), value.plan.id, value.id,
    { ...address(request), quoteHash: request.quote.quoteHash, confirmed: true });
  const lookup = async (value: VisualPaidGroup, request: StudioPaidImageRequest) => service.lookupImage(await current(), value.plan.id, value.id, request.requestId,
    { slotKey: address(request).slotKey });
  const original = async (value: VisualPaidGroup, request: StudioPaidImageRequest) => service.prepareImageOriginal(await current(), value.plan.id, value.id, address(request));
  async function process(request: StudioPaidImageRequest) {
    if (!request.generationId) throw new Error("visual_fixture_committed_generation_missing");
    await withTenant(db.db, await current(), tx => tx.update(creativeExecutions).set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
      .where(and(eq(creativeExecutions.studioGenerationId, request.generationId!), eq(creativeExecutions.phase, "pending"))));
    const envelope: JobEnvelope = { jobId: createEntityId(), correlationId: createEntityId(), idempotencyKey: request.generationId, traceId: createTraceId(),
      tenantId: context.tenantId, requestedBy: context.userId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload: { generationId: request.generationId } };
    return processor.process(envelope);
  }
  async function intent(value: VisualPaidGroup, request: StudioPaidImageRequest) {
    const prepared = await original(value, request);
    const input = StudioPinnedResultRequestSchema.parse({ operation: "result.submit.pinned", scope: prepared.scope, key: prepared.key, source: prepared.inspection.source,
      title: "Synthetic exact visual original", submissionId: randomUUID(), rightsAttested: true, sourceReference: "Synthetic AI original retained from its paid request" });
    const saved = StudioResultIntentSchema.parse({ version: 1, status: "prepared", request: input });
    await assets.invoke(await current(), { operation: "state.set", scope: prepared.scope, namespace: "app_state", key: studioResultIntentKey(input.source), revision: 0, value: saved });
    return { prepared, input };
  }
  const submit = async (input: StudioPinnedResultRequest) => CanvasResultReceiptSchema.parse(await assets.invoke(await current(), input));
  const resultLookup = async (input: StudioPinnedResultRequest) => StudioResultLookupSchema.parse(await assets.invoke(await current(), { ...input, operation: "result.lookup" }));
  async function facts() {
    return withTenant(db.db, await current(), async tx => {
      const [identity] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      return { role: identity!.role, generations: await tx.select().from(creativeStudioGenerations).orderBy(asc(creativeStudioGenerations.id)),
        executions: await tx.select().from(creativeExecutions).orderBy(asc(creativeExecutions.id)), ledger: await tx.select().from(aiBudgetLedger).orderBy(asc(aiBudgetLedger.id)),
        requests: await tx.select().from(creativeStudioImageRequests).orderBy(asc(creativeStudioImageRequests.id)),
        entries: await tx.select().from(creativeStudioEntries).orderBy(asc(creativeStudioEntries.id)), calls: [...calls], queue: [...paid.queueCalls] };
    });
  }
  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    const failures: unknown[] = [], phases: string[] = [];
    const attempt = async (phase: string, action: () => Promise<void>) => {
      try { await action(); }
      catch (cause) {
        phases.push(phase + ":" + (cleanupCodes(cause).join("+") || "no_public_code"));
        failures.push(new Error("visual_fixture_cleanup_" + phase + "_failed", { cause }));
      }
    };
    try {
      await paid.grant(context, Object.values(Permission), "tenant");
      const currentContext = await current();
      const batches = await withTenant(db.db, currentContext, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.createdBy, context.userId)));
      for (const batch of batches) if (batch.canvasWorkflow?.visualDelivery) scopes.add(batch.id);
      const before = await facts();
      await attempt("preparations", async () => {
        for (const row of before.requests) if (!row.generationId && !row.cancelledAt) await paid.paid.abandon(currentContext, { scope: row.scope, requestId: row.requestId });
      });
      await attempt("executions", async () => {
        for (const generation of before.generations) if (["queued", "running"].includes(generation.status))
          await paid.recovery.fail(currentContext, { kind: "studio_generation", ownerId: generation.id, stepKey: "generate" }, undefined, "CREATIVE_FIXTURE_UNSUBMITTED_CANCELLED", true);
      });
      // The original owner forbids removing unresolved submission intents.
      // Confirm only an actual receipt returned by that exact owner lookup.
      await attempt("intent_receipts", async () => {
        for (const row of before.entries.filter(value => scopes.has(value.scope) && !value.deletedAt && value.namespace === "app_state"
          && value.key.startsWith(STUDIO_RESULT_INTENT_PREFIX))) {
          const intent = parseStudioIntent(storedStudioValue(row.value), row.scope, row.key);
          if (intent.status === "confirmed") continue;
          const found = await resultLookup(intent.request);
          if (found.status !== "found") throw new Error("visual_fixture_cleanup_intent_receipt_missing");
          const value = StudioResultIntentSchema.parse({ version: 1, status: "confirmed", request: intent.request, receipt: found.receipt });
          await assets.invoke(currentContext, { operation: "state.set", scope: row.scope, namespace: "app_state", key: row.key, revision: row.revision, value });
        }
      });
      await attempt("entries", async () => {
        for (const row of (await facts()).entries) if (scopes.has(row.scope) && !row.deletedAt)
          await assets.invoke(currentContext, { operation: "state.remove", scope: row.scope, namespace: StudioNamespaceSchema.parse(row.namespace), key: row.key, revision: row.revision });
      });
      for (const scope of scopes) {
        await attempt("projects", async () => {
          const batch = batches.find(row => row.id === scope);
          if (batch && !["completed", "cancelled"].includes(batch.status)) await pod.cancelDesignBatch(currentContext, scope);
          if (batch && !batch.archivedAt) await pod.archiveDesignBatch(currentContext, scope, { archived: true, reason: "Synthetic visual paid acceptance cleanup" });
        });
      }
      for (const id of planIds) {
        await attempt("plans", async () => {
          const { plan } = await plans.get(currentContext, id);
          if (!plan.archived) await plans.archive(currentContext, id, { expectedRevision: plan.revision, idempotencyKey: randomUUID() });
        });
      }
      await attempt("template", async () => {
        if (templateId) await editor.archive(currentContext, templateId, { archived: true, reason: "Synthetic visual paid acceptance cleanup" });
      });
      await attempt("verification", async () => {
        const after = await facts();
        const remaining = await withTenant(db.db, currentContext, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.createdBy, context.userId)));
        if (after.generations.some(row => ["queued", "running"].includes(row.status)) || after.requests.some(row => !row.generationId && !row.cancelledAt)
          || after.entries.some(row => scopes.has(row.scope) && !row.deletedAt) || remaining.some(row => scopes.has(row.id) && !row.archivedAt))
          throw new Error("visual_fixture_active_resources_remain");
      });
    } catch (cause) {
      phases.push("setup:" + (cleanupCodes(cause).join("+") || "no_public_code")); failures.push(cause);
    }
    await attempt("paid_close", async () => { await paid.close(); });
    if (failures.length) throw new AggregateError(failures, "visual_paid_fixture_cleanup_failed phases=" + phases.join(","));
    // The runner removes the exact nonce DB/bucket/Redis after close. Immutable
    // requests, ledger, versions and source assets remain only until that removal.
    return { archivedProjects: scopes.size, archivedPlans: planIds.size, retainedHistoryUntilDisposableRemoval: true };
  }
  try {
    await setup();
    return { environment, paid, db, storage, context, current, service, plans, workflow, assets, editor, bridge, group, prepare, address, commit, lookup,
      process, original, intent, submit, resultLookup, facts, calls, sampleId, modelId, opaque, transparent, close,
      costKnown(value: boolean) { costKnown = value; }, inspect: StudioOriginalInspectionSchema.parse };
  } catch (primary) {
    try { await close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "visual_paid_fixture_setup_and_cleanup_failed"); }
    throw primary;
  }
}
