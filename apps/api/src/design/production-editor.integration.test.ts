import { createHash } from "node:crypto";
import { ConflictException, NotFoundException, UnprocessableEntityException, ServiceUnavailableException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type ProductionEditorImageView, type ProductionEditorDocument, type RectangularPrintDocument, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, marketplaceAccounts, migrateDatabase, modelProviderConfigs, modelRoutes, orderProtectedDetails, productionEditorProjects, productionEditorVersions, productionEditorImages, productionEditorRenders, withTenant } from "@yummyai/database";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { getBuiltinFont } from "@yummyai/production-editor";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { assertAssetAccess, type Storage, type PutPrivateInput, type StoredAsset, type AssetDomain } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import type { StudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { AuditService } from "../audit/audit.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderService } from "../orders/order.service.js";
import { ProductionEditorService, type ProductionEditorScanner } from "./production-editor.service.js";
import * as localMatting from "./local-image-matting.js";

function draft(): ProductionEditorDocument { return { schemaVersion: 1, name: "Synthetic production draft", productType: "tire_cover", spec: { diameterMm: 50, dpi: 150, safeInsetMm: 2, opening: null }, contour: [], layers: [], confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } }; }
function rectangularDraft(): RectangularPrintDocument { return { ...draft(), productType: "rectangular_print", name: "Synthetic rectangular print", spec: { widthMm: 101.6, heightMm: 50.8, dpi: 150, safeInsetMm: 5 }, contour: [] }; }
function imageLayer(asset: ProductionEditorImageView) { return { id: "photo", name: "Synthetic picture", kind: "image" as const, assetId: asset.id, assetVersion: 1, xMm: 5, yMm: 5, widthMm: 40, heightMm: 40, rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false }; }
async function image(width = 512, height = 512, alpha = false) { return sharp({ create: { width, height, channels: 4, background: { r: 30, g: 100, b: 210, alpha: alpha ? 0.5 : 1 } } }).png().toBuffer(); }

describe("production editor persistence and private rendering", () => {
  const database = connectDatabase(), tenantA = createEntityId(), tenantB = createEntityId(), userA = createEntityId(), userB = createEntityId(), accountId = createEntityId();
  const permissions = ["design:read", "design:write", "design:review", "asset:read", "order:read", "order:write", "order:pii:read", "order:pii:anonymize"];
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions, dataScope: "tenant" }, contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions, dataScope: "tenant" };
  const vault = new SecretVault(Buffer.alloc(32, 121)), audit = new AuditService(database), orderService = new OrderService(database, vault, audit);
  const objects = new Map<string, Uint8Array>();
  const storage = {
    putPrivate: vi.fn(async (context: TenantContext, input: PutPrivateInput) => { const checksumSha256 = createHash("sha256").update(input.body).digest("hex"), objectKey = `tenants/${context.tenantId}/${input.domain}/${checksumSha256}/${input.fileName}`; objects.set(objectKey, Uint8Array.from(input.body)); return { objectKey, checksumSha256, deduplicated: false }; }),
    readPrivate: vi.fn(async (context: TenantContext, asset: StoredAsset, options: { requiredDomain: AssetDomain }) => { assertAssetAccess(context, asset, options.requiredDomain); const result = objects.get(asset.objectKey); if (!result) throw new Error("Synthetic object missing"); return result; }),
  } as unknown as Storage;
  const clean = () => ({ result: "clean" as const, engine: "synthetic", signatureVersion: "synthetic-1", scannedAt: new Date().toISOString() });
  const scanner: ProductionEditorScanner = { scan: vi.fn(async () => clean()) };
  const enqueuer = { enqueue: vi.fn(async () => undefined) };
  const reports = new AmazonOrderReportService(database, vault, orderService, audit, { download: async () => { throw new Error("No network in synthetic test"); }, scan: async () => clean() }, { schedule: async () => undefined }, { schedule: async () => undefined });
  const service = new ProductionEditorService(database, vault, storage, reports, audit, enqueuer, scanner);
  const worker = new ProductionEditorRenderProcessor(database, storage, vault);
  const create = () => service.create(contextA, { name: "Synthetic private project name", document: draft() });
  async function prepared(confirmed = false) {
    const project = await create(), asset = await service.upload(contextA, project.project.id, "synthetic.png", await image(), "image") as ProductionEditorImageView;
    const document = draft(); document.layers = [imageLayer(asset)];
    if (confirmed) document.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
    return { project: await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document }), asset };
  }
  function envelope(renderId: string, context = contextA) { return JobEnvelopeSchema.parse({ jobId: createEntityId(), tenantId: context.tenantId, requestedBy: context.userId, correlationId: renderId, idempotencyKey: renderId, payload: { renderId } }); }
  async function source() {
    const orderId = `SYNTHETIC-${createEntityId()}`, lineId = `SYNTHETIC-LINE-${createEntityId()}`;
    const content = "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\tcustomized-url\n" + `${orderId}\t${lineId}\t2026-09-01T12:00:00Z\tSYNTHETIC\tSynthetic item\t1\tUSD\t20.00\thttps://zme-caps.amazon.com/synthetic`;
    const batch = await reports.importReport(contextA, { accountId, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic.txt", content });
    const line = (await reports.workspace(contextA, { batchId: batch.id })).lines[0];
    const zip = new JSZip();
    zip.file("order.json", JSON.stringify({ orderId, orderItemId: lineId, customizationData: { type: "PageContainerCustomization", snapshot: { imageName: "preview.png" }, children: [{ type: "ImageCustomization", image: { imageName: "buyer.png", buyerFilename: "synthetic-buyer.png" } }] } }));
    zip.file("preview.png", await image(16, 12)); zip.file("buyer.png", await image(48, 36));
    const parsed = await reports.process(contextA, line.id, null, await zip.generateAsync({ type: "nodebuffer" }));
    return { line, parsed, externalOrderId: orderId, source: { reportLineId: line.id, reportVersionId: parsed.versionId! } };
  }

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3),($4,$5,$6)", [tenantA, "Synthetic Editor A", `editor-a-${tenantA}`, tenantB, "Synthetic Editor B", `editor-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `editor-a-${userA}`, `${userA}@example.test`, "Synthetic A", userB, `editor-b-${userB}`, `${userB}@example.test`, "Synthetic B"]);
    await withTenant(database.db, contextA, (tx) => tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: tenantA, platform: "amazon", displayName: "Synthetic Editor Shop", region: "NA", authorizationMode: "amazon_private", marketplaceIds: ["ATVPDKIKX0DER"], createdBy: userA }));
  }, 60_000);
  afterAll(async () => { objects.clear(); await database.client.end(); });

  it("encrypts documents, original names and storage bytes while exposing safe image dimensions and actual alpha", async () => {
    const project = await create();
    const bytes = await image(48, 36, true);
    const asset = await service.upload(contextA, project.project.id, "synthetic-private-name.png", bytes) as ProductionEditorImageView;
    expect(asset).toMatchObject({ width: 48, height: 36, hasAlpha: true, actualAlpha: true, version: 1 });
    const state = await withTenant(database.db, contextA, async (tx) => ({ project: (await tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, project.project.id)))[0], images: await tx.select().from(productionEditorImages).where(eq(productionEditorImages.projectId, project.project.id)), versions: await tx.select().from(productionEditorVersions).where(eq(productionEditorVersions.projectId, project.project.id)) }));
    expect(JSON.stringify(state)).not.toContain("Synthetic private project name");
    expect(JSON.stringify(state)).not.toContain("synthetic-private-name.png");
    expect(Buffer.from(objects.get(state.images[0].originalObjectKey)!)).not.toEqual(bytes);
    expect(Buffer.from((await service.image(contextA, project.project.id, asset.id, "original")).body)).toEqual(bytes);
    const preview = await service.image(contextA, project.project.id, asset.id, "preview");
    expect(preview).toMatchObject({ mediaType: "image/png", inline: true });
    expect((await sharp(preview.body).metadata()).width).toBe(48);
  });

  it("uses the selected model for private order cutouts, never reruns a billed request and applies only real alpha", async () => {
    const evidence = await source(); await reports.review(contextA, evidence.line.id, evidence.parsed.versionId!);
    const project = await service.create(contextA, { name: "Synthetic model-cutout order", document: draft(), source: evidence.source });
    const providerId = createEntityId(), modelId = createEntityId(), modelVault = new SecretVault(Buffer.alloc(32, 87));
    await withTenant(database.db, contextA, async tx => {
      await tx.insert(modelProviderConfigs).values({ id: providerId, tenantId: tenantA, provider: "openai-compatible", label: "Synthetic image model", endpoint: "https://example.test/v1", encryptedApiKey: modelVault.encrypt("synthetic-model-key"), createdBy: userA });
      await tx.insert(modelRoutes).values({ id: modelId, tenantId: tenantA, modelKey: `cutout-${modelId}`, taskType: "studio_image", targets: [{ providerConfigId: providerId, providerModel: "gpt-image-2.5", timeoutMs: 600000 }] });
    });
    const generate = vi.fn<StudioGateway["generate"]>(async () => ({ bytes: await image(512, 512, true), mediaType: "image/png" }));
    const modelWorker = new ProductionEditorRenderProcessor(database, storage, vault, modelVault, { generate });
    const input = { requestId: createEntityId(), expectedVersionId: project.version.id, modelId, prompt: "Synthetic private customer cutout instruction", size: "2048x2048" };
    const sourceImageId = project.images[0]!.id;
    await expect(service.editImageWithModel(contextB, project.project.id, sourceImageId, input)).rejects.toBeInstanceOf(NotFoundException);
    const job = await service.editImageWithModel(contextA, project.project.id, sourceImageId, input);
    expect(job).toMatchObject({ id: input.requestId, purpose: "image_edit", status: "queued" });
    expect((await service.editImageWithModel(contextA, project.project.id, sourceImageId, input)).id).toBe(job.id);
    await expect(service.editImageWithModel(contextA, project.project.id, sourceImageId, { ...input, prompt: "Changed request" })).rejects.toBeInstanceOf(ConflictException);
    await modelWorker.process(envelope(job.id)); await modelWorker.process(envelope(job.id));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ model: "gpt-image-2.5", capability: "image", input: { background: "transparent", size: "2048x2048" }, references: [{ mediaType: "image/png" }] });
    const done = await service.getRender(contextA, project.project.id, job.id);
    expect(done).toMatchObject({ purpose: "image_edit", status: "completed", preflight: { productionReady: false } });
    expect(done.preflight?.issues).toContainEqual(expect.objectContaining({ code: "model_image_size_mismatch", severity: "warning" }));
    const applied = await service.applyModelImage(contextA, project.project.id, job.id, project.version.id);
    expect(applied).toMatchObject({ actualAlpha: true, name: "gpt-image-2.5-抠图.png" });
    expect((await service.applyModelImage(contextA, project.project.id, job.id, project.version.id)).id).toBe(applied.id);
    const [asset] = await withTenant(database.db, contextA, tx => tx.select().from(productionEditorImages).where(eq(productionEditorImages.id, applied.id)));
    expect(asset!.originalObjectKey).toContain(`/${tenantA}/order/`);
    expect((await service.get(contextA, project.project.id)).version.document.layers).toHaveLength(0);
    await expect(service.renderFile(contextB, project.project.id, job.id, "result")).rejects.toBeInstanceOf(NotFoundException);
    const rows = await withTenant(database.db, contextA, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, job.id)));
    expect(JSON.stringify(rows)).not.toContain(input.prompt); expect(JSON.stringify(rows)).not.toContain("synthetic-model-key");
    const interrupted = await service.editImageWithModel(contextA, project.project.id, sourceImageId, { ...input, requestId: createEntityId() });
    await withTenant(database.db, contextA, tx => tx.update(productionEditorRenders).set({ status: "processing", updatedAt: sql`now()-interval '3 minutes'` }).where(eq(productionEditorRenders.id, interrupted.id)));
    await expect(modelWorker.process(envelope(interrupted.id))).rejects.toThrow("production_image_submission_interrupted");
    expect(generate).toHaveBeenCalledTimes(1);
    generate.mockImplementationOnce(async () => ({ bytes: await image(), mediaType: "image/png" }));
    const opaque = await service.editImageWithModel(contextA, project.project.id, sourceImageId, { ...input, requestId: createEntityId() });
    await modelWorker.process(envelope(opaque.id));
    await expect(service.applyModelImage(contextA, project.project.id, opaque.id, project.version.id)).rejects.toBeInstanceOf(UnprocessableEntityException);
    const changed = await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document: { ...project.version.document, exportBackground: "white" } });
    await expect(service.applyModelImage(contextA, project.project.id, job.id, changed.version.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("normalizes EXIF dimensions for display while preserving original JPEG bytes", async () => {
    const project = await create();
    const bytes = await sharp(await image(30, 20)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const asset = await service.upload(contextA, project.project.id, "synthetic-rotated.jpg", bytes) as ProductionEditorImageView;
    expect(asset).toMatchObject({ width: 20, height: 30 });
    const preview = await service.image(contextA, project.project.id, asset.id);
    expect(await sharp(preview.body).metadata()).toMatchObject({ width: 20, height: 30 });
    expect(Buffer.from((await service.image(contextA, project.project.id, asset.id, "original")).body)).toEqual(bytes);
  });

  it("keeps cutout originals and editable recipes private, versioned and recoverable", async () => {
    const { project, asset } = await prepared();
    const recipe = { schemaVersion: 1 as const, maskPngBase64: null, operations: [{ kind: "polygon" as const, mode: "keep" as const, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }] }] };
    const payload = { expectedVersionId: project.version.id, name: "Synthetic cutout", recipe };
    const result = await service.applyCutout(contextA, project.project.id, asset.id, payload) as ProductionEditorImageView;
    expect(result).toMatchObject({ width: 512, height: 512, actualAlpha: true });
    expect(result.id).not.toBe(asset.id);
    const reopened = await service.cutoutEditor(contextA, project.project.id, result.id);
    expect(reopened.source.id).toBe(asset.id);
    expect(reopened.recipe).toEqual(recipe);
    expect(Buffer.from((await service.image(contextA, project.project.id, asset.id, "original")).body)).toEqual(await image());
    const restored = await service.applyCutout(contextA, project.project.id, reopened.source.id, { ...payload, recipe: { schemaVersion: 1, maskPngBase64: null, operations: [] } }) as ProductionEditorImageView;
    expect(restored.actualAlpha).toBe(false);
    await expect(service.applyCutout(contextA, project.project.id, result.id, payload)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.cutoutEditor(contextB, project.project.id, result.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.applyCutout(contextB, project.project.id, asset.id, payload)).rejects.toBeInstanceOf(NotFoundException);
    const other = await create();
    await expect(service.cutoutEditor(contextA, other.project.id, result.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.applyCutout(contextA, other.project.id, asset.id, { ...payload, expectedVersionId: other.version.id })).rejects.toBeInstanceOf(NotFoundException);
    const latest = await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document: { ...project.version.document, layers: [imageLayer(result)] } });
    expect((await service.get(contextA, project.project.id, project.version.id)).version.document.layers[0]).toMatchObject({ assetId: asset.id });
    await expect(service.applyCutout(contextA, project.project.id, asset.id, payload)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.segmentImage(contextA, project.project.id, asset.id, { expectedVersionId: project.version.id, box: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, points: [] })).rejects.toBeInstanceOf(ConflictException);
    const render = await service.render(contextA, project.project.id, { expectedVersionId: latest.version.id, format: "png", background: "transparent", purpose: "preview" });
    await worker.process(envelope(render.id));
    expect((await service.getRender(contextA, project.project.id, render.id)).status).toBe("completed");
  });

  it("authorizes refinement by tenant and original asset, and saves fractional alpha as an editable private copy", async () => {
    const { project, asset } = await prepared();
    const recipe = { schemaVersion: 1 as const, maskPngBase64: null, operations: [{ kind: "polygon" as const, mode: "keep" as const, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }] }] };
    const input = { expectedVersionId: project.version.id, recipe, radius: 0.01, strokes: [] };
    const mask = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
    const output = { maskPngBase64: mask.toString("base64"), engine: "vitmatte-small" as const, width: 512, height: 512 };
    const engine = vi.spyOn(localMatting, "runLocalMatting").mockResolvedValue(output);
    try {
      await expect(service.refineImage(contextB, project.project.id, asset.id, input)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.refineImage({ ...contextA, permissions: ["design:read", "asset:read"] }, project.project.id, asset.id, input)).rejects.toThrow();
      const other = await create();
      await expect(service.refineImage(contextA, other.project.id, asset.id, { ...input, expectedVersionId: other.version.id })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.refineImage(contextA, project.project.id, asset.id, { ...input, recipe: { schemaVersion: 1, maskPngBase64: null, operations: [] } })).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(engine).not.toHaveBeenCalled();
      expect(await service.refineImage(contextA, project.project.id, asset.id, input)).toEqual(output);
      expect(engine).toHaveBeenCalledOnce();
      expect(await sharp(engine.mock.calls[0]![0].image).metadata()).toMatchObject({ width: 512, height: 512, format: "png" });
      const unchanged = await service.get(contextA, project.project.id);
      expect(unchanged.version.id).toBe(project.version.id); expect(unchanged.images).toHaveLength(1);
      const refinedRecipe = { schemaVersion: 1 as const, maskPngBase64: output.maskPngBase64, operations: [] };
      const copy = await service.applyCutout(contextA, project.project.id, asset.id, { expectedVersionId: project.version.id, name: "Synthetic soft edge", recipe: refinedRecipe }) as ProductionEditorImageView;
      const reopened = await service.cutoutEditor(contextA, project.project.id, copy.id);
      expect(reopened.source.id).toBe(asset.id); expect(reopened.recipe).toEqual(refinedRecipe);
      const copyPixels = await sharp((await service.image(contextA, project.project.id, copy.id, "original")).body).raw().toBuffer();
      expect([...copyPixels.subarray(0, 4)]).toEqual([30, 100, 210, 128]);
      expect(Buffer.from((await service.image(contextA, project.project.id, asset.id, "original")).body)).toEqual(await image());
      await expect(service.refineImage(contextA, project.project.id, copy.id, input)).rejects.toBeInstanceOf(UnprocessableEntityException);
    } finally { engine.mockRestore(); }
  });

  it("does not return refinement for a changed version or mutate the draft when the engine fails", async () => {
    const { project, asset } = await prepared();
    const input = { expectedVersionId: project.version.id, recipe: { schemaVersion: 1 as const, maskPngBase64: null, operations: [{ kind: "polygon" as const, mode: "keep" as const, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }] }] }, radius: 0.01, strokes: [] };
    const engine = vi.spyOn(localMatting, "runLocalMatting").mockRejectedValue(new Error("offline_engine_failed"));
    try {
      await expect(service.refineImage(contextA, project.project.id, asset.id, input)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect((await service.get(contextA, project.project.id)).version.id).toBe(project.version.id);
      engine.mockImplementationOnce(async ({ mask, width, height }) => {
        await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document: project.version.document });
        return { maskPngBase64: Buffer.from(mask).toString("base64"), engine: "vitmatte-small", width, height };
      });
      await expect(service.refineImage(contextA, project.project.id, asset.id, input)).rejects.toBeInstanceOf(ConflictException);
      expect((await service.get(contextA, project.project.id)).images).toHaveLength(1);
    } finally { engine.mockRestore(); }
  });

  it("keeps saved versions immutable, detects concurrent saves and can open historical documents", async () => {
    const project = await create(), document = draft(); document.name = "Synthetic second version";
    const second = await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document });
    expect(second.version.versionNumber).toBe(2);
    expect(second.versions).toHaveLength(2);
    await expect(service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document })).rejects.toBeInstanceOf(ConflictException);
    expect((await service.get(contextA, project.project.id, project.version.id)).version.document.name).toBe("Synthetic private project name");
    await expect(withTenant(database.db, contextA, (tx) => tx.update(productionEditorVersions).set({ checksum: "changed" }).where(eq(productionEditorVersions.id, project.version.id)))).rejects.toThrow();
  });

  it("persists a rectangular print and renders exact private preview and production pixels through the worker", async () => {
    const project = await service.create(contextA, { name: "Synthetic rectangular worker lifecycle", document: rectangularDraft() });
    const projectId = project.project.id;
    try {
      expect(project.project.productType).toBe("rectangular_print");
      const original = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
      const asset = await service.upload(contextA, projectId, "synthetic-rectangle-alpha.png", original, "image") as ProductionEditorImageView;
      expect(asset).toMatchObject({ width: 600, height: 600, actualAlpha: true });
      const document = rectangularDraft();
      // A square photograph occupies the middle half of the rectangular sheet.
      // Its alpha must remain fractional; the outer sheet must remain transparent.
      document.layers = [{ ...imageLayer(asset), xMm: 25.4, yMm: 0, widthMm: 50.8, heightMm: 50.8 }];
      const saved = await service.save(contextA, projectId, { expectedVersionId: project.version.id, document });
      expect(saved.version.document).toEqual(document);
      expect(saved.version.versionNumber).toBe(2);
      const request = { expectedVersionId: saved.version.id, format: "png", background: "transparent", purpose: "production" };
      await expect(service.render(contextA, projectId, request)).rejects.toBeInstanceOf(UnprocessableEntityException);
      const preview = await service.render(contextA, projectId, { ...request, purpose: "preview", previewFullResolution: true });
      expect(await worker.process(envelope(preview.id))).toMatchObject({ disposition: "completed" });
      const previewResult = await service.getRender(contextA, projectId, preview.id);
      expect(previewResult).toMatchObject({ status: "completed", purpose: "preview", preflight: { productionReady: false, widthPx: 600, heightPx: 300 } });
      const proof = await service.renderFile(contextA, projectId, preview.id, "result");
      expect(await sharp(proof.body).metadata()).toMatchObject({ width: 600, height: 300, density: 150, hasAlpha: true, space: "srgb" });
      // Review alone cannot bypass the unconfirmed physical/visual preflight.
      await service.review(contextA, projectId, saved.version.id);
      await expect(service.render(contextA, projectId, request)).rejects.toBeInstanceOf(UnprocessableEntityException);
      const confirmed = await service.save(contextA, projectId, { expectedVersionId: saved.version.id, document: { ...document, confirmations: { ...document.confirmations, physicalSize: true, visualReview: true } } });
      const productionRequest = { ...request, expectedVersionId: confirmed.version.id };
      // A new immutable version never inherits the previous review decision.
      await expect(service.render(contextA, projectId, productionRequest)).rejects.toBeInstanceOf(UnprocessableEntityException);
      await service.review(contextA, projectId, confirmed.version.id);
      const render = await service.render(contextA, projectId, productionRequest);
      expect(await worker.process(envelope(render.id))).toMatchObject({ disposition: "completed" });
      const result = await service.getRender(contextA, projectId, render.id);
      expect(result).toMatchObject({ status: "completed", purpose: "production", preflight: { productionReady: true, widthPx: 600, heightPx: 300 } });
      expect(result.files).toHaveLength(1);
      const production = await service.renderFile(contextA, projectId, render.id, "result");
      expect(await sharp(production.body).metadata()).toMatchObject({ width: 600, height: 300, density: 150, hasAlpha: true, space: "srgb" });
      const pixels = await sharp(production.body).ensureAlpha().raw().toBuffer();
      const offset = (150 * 600 + 300) * 4;
      expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
      expect([...pixels.subarray(offset, offset + 3)]).toEqual([255, 0, 0]);
      expect(pixels[offset + 3]).toBe(128);
      expect([...pixels.subarray(pixels.length - 4)]).toEqual([0, 0, 0, 0]);
      expect(pixels).toEqual(await sharp(proof.body).ensureAlpha().raw().toBuffer());
      expect(Buffer.from((await service.image(contextA, projectId, asset.id, "original")).body)).toEqual(original);
      await expect(service.renderFile(contextB, projectId, render.id, "result")).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await service.remove(contextA, projectId);
      expect((await service.list(contextA)).projects.map((entry) => entry.id)).not.toContain(projectId);
    }
  });

  it("delivers factory pillows as order-named 150 DPI JPG after review, with private originals preserved", async () => {
    const evidence = await source();
    await reports.review(contextA, evidence.line.id, evidence.parsed.versionId!);
    const initial = createDefaultProductionDocument("shaped_pillow");
    if (initial.productType !== "shaped_pillow") throw new Error("fixture");
    const project = await service.create(contextA, { name: "Synthetic factory JPG pillow", document: initial, source: evidence.source });
    const projectId = project.project.id;
    try {
      const original = await image(1500, 1500);
      const asset = await service.upload(contextA, projectId, "synthetic-factory-pillow.png", original) as ProductionEditorImageView;
      const mm = (px: number) => px * 25.4 / 150;
      const document = { ...initial, spec: { ...initial.spec, widthMm: mm(1900), heightMm: mm(1900), declaredLongestMm: 254,
        barcodeTab: { ...initial.spec.barcodeTab, centerXMm: mm(950) } },
        contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: mm(1900), yMm: 0, smooth: false }, { xMm: mm(1900), yMm: mm(1900), smooth: false }, { xMm: 0, yMm: mm(1900), smooth: false }],
        layers: [{ ...imageLayer(asset), xMm: mm(200), yMm: mm(200), widthMm: 254, heightMm: 254 }],
        confirmations: { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true } };
      const saved = await service.save(contextA, projectId, { expectedVersionId: project.version.id, document });
      const request = { expectedVersionId: saved.version.id, format: "jpeg", background: "white", purpose: "production" };
      expect((await service.preflight(contextA, projectId, { ...request, format: "png" })).issues).toContainEqual(expect.objectContaining({ code: "factory_jpg_required" }));
      await expect(service.render(contextA, projectId, request)).rejects.toBeInstanceOf(UnprocessableEntityException);
      const proof = await service.render(contextA, projectId, { ...request, purpose: "preview", previewFullResolution: true });
      await worker.process(envelope(proof.id));
      await service.review(contextA, projectId, saved.version.id);
      const render = await service.render(contextA, projectId, request);
      await worker.process(envelope(render.id));
      const file = await service.renderFile(contextA, projectId, render.id, "result");
      expect(file).toMatchObject({ name: `${evidence.externalOrderId}.jpg`, mediaType: "image/jpeg" });
      expect(await sharp(file.body).metadata()).toMatchObject({ format: "jpeg", density: 150, width: 4012, height: 2206, channels: 3, hasAlpha: false, space: "srgb" });
      expect(Buffer.from((await service.image(contextA, projectId, asset.id, "original")).body)).toEqual(original);
      await expect(service.renderFile(contextB, projectId, render.id, "result")).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.get(contextA, projectId, project.version.id)).version.document).toEqual(project.version.document);
    } finally {
      await service.remove(contextA, projectId);
      expect((await service.list(contextA)).projects.some(entry => entry.id === projectId)).toBe(false);
    }
  });

  it("pins rectangular automation recipes to saved versions and reads historical documents without creating versions", async () => {
    const project = await service.create(contextA, { name: "Synthetic rectangular recipe versions", document: rectangularDraft() });
    const projectId = project.project.id;
    try {
      expect(Object.hasOwn(project.version.document, "automation")).toBe(false);
      const automation = { schemaVersion: 1 as const, workflow: "template" as const, imagePolicy: "preserve" as const, modelRouteId: null, allowOrderImageTransfer: false, modelCallLimit: 0, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null };
      const configured = await service.save(contextA, projectId, { expectedVersionId: project.version.id, document: { ...project.version.document, automation } });
      expect(configured.version.document.automation).toEqual(automation);
      expect(configured.version.versionNumber).toBe(2);
      const revised = await service.save(contextA, projectId, { expectedVersionId: configured.version.id, document: { ...configured.version.document, automation: { ...automation, modelCallLimit: 1 } } });
      expect(revised.version.versionNumber).toBe(3);
      const versionsBefore = await withTenant(database.db, contextA, tx => tx.select({ id: productionEditorVersions.id, checksum: productionEditorVersions.checksum, document: productionEditorVersions.encryptedDocument }).from(productionEditorVersions).where(eq(productionEditorVersions.projectId, projectId)).orderBy(productionEditorVersions.versionNumber));
      expect(versionsBefore).toHaveLength(3);
      for (let iteration = 0; iteration < 2; iteration++) {
        const historical = await service.get(contextA, projectId, project.version.id);
        expect(historical.version.document).toEqual(project.version.document);
        expect(Object.hasOwn(historical.version.document, "automation")).toBe(false);
        expect(historical.project.currentVersionId).toBe(revised.version.id);
        const earlierRecipe = await service.get(contextA, projectId, configured.version.id);
        expect(earlierRecipe.version.document.automation).toEqual(automation);
        expect(earlierRecipe.versions).toHaveLength(3);
      }
      expect((await service.get(contextA, projectId)).version.document.automation).toEqual({ ...automation, modelCallLimit: 1 });
      const versionsAfter = await withTenant(database.db, contextA, tx => tx.select({ id: productionEditorVersions.id, checksum: productionEditorVersions.checksum, document: productionEditorVersions.encryptedDocument }).from(productionEditorVersions).where(eq(productionEditorVersions.projectId, projectId)).orderBy(productionEditorVersions.versionNumber));
      expect(versionsAfter).toEqual(versionsBefore);
      await expect(service.get(contextB, projectId, configured.version.id)).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await service.remove(contextA, projectId);
      expect((await service.list(contextA)).projects.map((entry) => entry.id)).not.toContain(projectId);
    }
  });

  it("isolates projects, assets, versions, renders and writes across tenants", async () => {
    const { project, asset } = await prepared();
    expect((await service.list(contextB)).projects).toEqual([]);
    await expect(service.get(contextB, project.project.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.image(contextB, project.project.id, asset.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.upload(contextB, project.project.id, "synthetic.png", await image())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.save(contextB, project.project.id, { expectedVersionId: project.version.id, document: draft() })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.review(contextB, project.project.id, project.version.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, contextB, (tx) => tx.select().from(productionEditorVersions).where(eq(productionEditorVersions.projectId, project.project.id)))).toEqual([]);
  });

  it("rejects cross-project assets, executable/vector uploads and failed scans", async () => {
    const first = await prepared(), other = await create(), document = draft(); document.layers = [imageLayer(first.asset)];
    await expect(service.save(contextA, other.project.id, { expectedVersionId: other.version.id, document })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.upload(contextA, other.project.id, "bad.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).rejects.toBeInstanceOf(UnprocessableEntityException);
    const rejected = new ProductionEditorService(database, vault, storage, reports, audit, enqueuer, { scan: async () => ({ ...clean(), result: "infected" }) });
    await expect(rejected.upload(contextA, other.project.id, "synthetic.png", await image())).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.upload(contextA, other.project.id, "oversized.png", new Uint8Array(64 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await service.get(contextA, other.project.id)).images).toEqual([]);
  });

  it("keeps standalone projects readable when order projects require additional permissions", async () => {
    const standalone = await create(), evidence = await source();
    await reports.review(contextA, evidence.line.id, evidence.parsed.versionId!);
    const linked = await service.create(contextA, { name: "Synthetic order project", document: draft(), source: evidence.source });
    const designer: TenantContext = { ...contextA, permissions: ["design:read", "asset:read"] };
    const workspace = await service.list(designer);
    expect(workspace.projects.map((project) => project.id)).toContain(standalone.project.id);
    expect(workspace.projects.map((project) => project.id)).not.toContain(linked.project.id);
    await expect(service.get(designer, linked.project.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.image(designer, linked.project.id, linked.images[0].id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts a TIFF source larger than 44 MiB and preserves original bytes", async () => {
    const project = await create();
    const bytes = await sharp({ create: { width: 3500, height: 3500, channels: 4, background: { r: 90, g: 80, b: 70, alpha: 0.7 } } }).tiff({ compression: "none" }).toBuffer();
    expect(bytes.byteLength).toBeGreaterThan(44 * 1024 * 1024);
    const asset = await service.upload(contextA, project.project.id, "synthetic-large.tif", bytes) as ProductionEditorImageView;
    expect(asset).toMatchObject({ width: 3500, height: 3500, mediaType: "image/tiff", actualAlpha: true });
    expect(createHash("sha256").update((await service.image(contextA, project.project.id, asset.id, "original")).body).digest("hex")).toBe(asset.checksumSha256);
  }, 30_000);

  it("stores validated project fonts privately and rejects invalid font files", async () => {
    const project = await create(), builtin = await getBuiltinFont("geist_regular");
    const font = await service.upload(contextA, project.project.id, "synthetic-font.ttf", builtin.bytes, "font");
    expect(font).toMatchObject({ builtin: false });
    expect((await service.get(contextA, project.project.id)).fonts).toHaveLength(2);
    expect(Buffer.from((await service.font(contextA, project.project.id, font.id)).body)).toEqual(Buffer.from(builtin.bytes));
    await expect(service.upload(contextA, project.project.id, "invalid.ttf", Buffer.from("not a font"), "font")).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("persists the independent cut contour and preserves border artwork through the worker", async () => {
    const document: ProductionEditorDocument = { schemaVersion: 1, name: "Synthetic preserved pillow", productType: "shaped_pillow", exportBackground: "white", spec: { widthMm: 80, heightMm: 80, dpi: 150, sideMode: "single", declaredLongestMm: 80, sizeBasis: "cut_contour", whiteBorderMm: 10, artworkClipMode: "none", cutLineMm: 1.016, minimumNeckMm: 50, minimumNeckBasis: "cut_contour", panelGapMm: 10, barcodeTab: { widthMm: 20, heightMm: 10, centerXMm: 40 } }, contour: [[0, 0], [80, 0], [80, 80], [0, 80]].map(([xMm, yMm]) => ({ xMm: xMm!, yMm: yMm!, smooth: false })), layers: [], confirmations: draft().confirmations };
    const project = await service.create(contextA, { name: document.name, document });
    const asset = await service.upload(contextA, project.project.id, "synthetic.png", await image(), "image") as ProductionEditorImageView;
    const layer = { ...imageLayer(asset), xMm: 0, yMm: 0, widthMm: 80, heightMm: 80 };
    document.layers = [layer];
    const saved = await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document });
    const reloaded = await service.get(contextA, project.project.id);
    expect(reloaded.version.document).toEqual(document);
    const render = await service.render(contextA, project.project.id, { expectedVersionId: saved.version.id, format: "png", background: "white", purpose: "preview", previewFullResolution: true });
    await worker.process(envelope(render.id));
    const file = await service.renderFile(contextA, project.project.id, render.id, "result");
    const bytes = await sharp(file.body).extract({ left: 21, top: 240, width: 1, height: 1 }).raw().toBuffer();
    expect([...bytes]).not.toEqual([255, 255, 255]);
    expect((await service.get(contextA, project.project.id)).version.document.layers).toEqual([layer]);
    expect((await service.get(contextA, project.project.id, project.version.id)).version.document).toEqual(project.version.document);
    await expect(service.renderFile(contextB, project.project.id, render.id, "result")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires manual review and trusted production preflight but still permits draft preview", async () => {
    const { project } = await prepared();
    const request = { expectedVersionId: project.version.id, format: "png", background: "transparent", purpose: "production" };
    await expect(service.render(contextA, project.project.id, request)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await service.review(contextA, project.project.id, project.version.id);
    await expect(service.render(contextA, project.project.id, request)).rejects.toBeInstanceOf(UnprocessableEntityException);
    const preview = await service.render(contextA, project.project.id, { ...request, purpose: "preview" });
    expect(preview.status).toBe("queued");
    expect((await service.preflight(contextA, project.project.id, request)).productionReady).toBe(false);
    await worker.process(envelope(preview.id));
    const done = await service.getRender(contextA, project.project.id, preview.id);
    expect(done).toMatchObject({ status: "completed", purpose: "preview" });
    const file = await service.renderFile(contextA, project.project.id, preview.id, "result");
    const dimensions = await sharp(file.body).metadata();
    expect(Math.max(dimensions.width!, dimensions.height!)).toBeLessThanOrEqual(1600);
    const proof = await service.render(contextA, project.project.id, { ...request, purpose: "preview", previewFullResolution: true });
    await worker.process(envelope(proof.id));
    const proofResult = await service.getRender(contextA, project.project.id, proof.id);
    expect(proofResult).toMatchObject({ status: "completed", purpose: "preview", preflight: { productionReady: false } });
    const proofFile = await service.renderFile(contextA, project.project.id, proof.id, "result");
    expect(proofFile.name).toMatch(/^proof-/);
    const proofMetadata = await sharp(proofFile.body).metadata();
    expect([proofMetadata.width, proofMetadata.height, proofMetadata.density]).toEqual([proofResult.preflight!.widthPx, proofResult.preflight!.heightPx, project.version.document.spec.dpi]);
    await expect(service.render(contextA, project.project.id, { ...request, previewFullResolution: true })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("renders reviewed confirmed versions asynchronously, deduplicates retries and blocks stale jobs", async () => {
    const { project } = await prepared(true);
    await service.review(contextA, project.project.id, project.version.id);
    const render = await service.render(contextA, project.project.id, { expectedVersionId: project.version.id, format: "png", background: "transparent", purpose: "production" });
    expect(render.status).toBe("queued");
    expect(await worker.process(envelope(render.id))).toMatchObject({ disposition: "completed" });
    expect(await worker.process(envelope(render.id))).toMatchObject({ disposition: "already_claimed" });
    const done = await service.getRender(contextA, project.project.id, render.id);
    expect(done.preflight?.productionReady).toBe(true);
    expect(done.files).toHaveLength(1);
    await expect(service.getRender(contextB, project.project.id, render.id)).rejects.toBeInstanceOf(NotFoundException);
    const queued = await service.render(contextA, project.project.id, { expectedVersionId: project.version.id, format: "png", background: "transparent", purpose: "production" });
    await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document: project.version.document });
    await expect(worker.process(envelope(queued.id))).rejects.toThrow("production_version_changed");
    expect((await service.getRender(contextA, project.project.id, queued.id)).status).toBe("failed");
  });

  it("requires a reviewed current order source and imports the buyer original rather than the Amazon preview", async () => {
    const evidence = await source();
    await expect(service.create(contextA, { name: "Synthetic order project", document: draft(), source: evidence.source })).rejects.toBeInstanceOf(ConflictException);
    await reports.review(contextA, evidence.line.id, evidence.parsed.versionId!);
    const project = await service.create(contextA, { name: "Synthetic order project", document: draft(), source: evidence.source });
    expect(project.images).toHaveLength(1);
    expect(project.images[0]).toMatchObject({ width: 48, height: 36 });
    expect(project.project.expiresAt).not.toBeNull();
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(productionEditorImages).where(eq(productionEditorImages.projectId, project.project.id)));
    expect(stored.originalObjectKey).toContain(`/tenants/`.slice(1) + `${tenantA}/order/`);
    await expect(service.create(contextB, { name: "Invalid cross tenant", document: draft(), source: evidence.source })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("enforces the lowest barcode position through saved pillow versions and worker output", async () => {
    const document: ProductionEditorDocument = {
      ...draft(), productType: "shaped_pillow", spec: { widthMm: 80, heightMm: 80, dpi: 150, sideMode: "single", declaredLongestMm: 80, sizeBasis: "cut_contour", whiteBorderMm: 5, cutLineMm: 1.016, minimumNeckMm: 50, minimumNeckBasis: "cut_contour", panelGapMm: 10, barcodeTab: { widthMm: 20, heightMm: 10, centerXMm: 12 } },
      contour: [[0, 0], [80, 0], [80, 40], [50, 80], [30, 80], [0, 40]].map(([xMm, yMm]) => ({ xMm, yMm, smooth: false })),
      confirmations: { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true },
    };
    const project = await service.create(contextA, { name: "Synthetic bottom barcode pillow", document });
    const asset = await service.upload(contextA, project.project.id, "synthetic-pillow.png", await image()) as ProductionEditorImageView;
    document.layers = [imageLayer(asset)];
    const invalid = await service.save(contextA, project.project.id, { expectedVersionId: project.version.id, document });
    const options = { expectedVersionId: invalid.version.id, format: "png", background: "transparent", purpose: "production" };
    expect((await service.preflight(contextA, project.project.id, options)).issues.map((issue) => issue.code)).toContain("barcode_not_at_bottom");
    await service.review(contextA, project.project.id, invalid.version.id);
    await expect(service.render(contextA, project.project.id, options)).rejects.toBeInstanceOf(UnprocessableEntityException);
    document.spec.barcodeTab.centerXMm = 40;
    const fixed = await service.save(contextA, project.project.id, { expectedVersionId: invalid.version.id, document });
    expect((await service.get(contextA, project.project.id, invalid.version.id)).version.document).toMatchObject({ spec: { barcodeTab: { centerXMm: 12 } } });
    await service.review(contextA, project.project.id, fixed.version.id);
    const render = await service.render(contextA, project.project.id, { ...options, expectedVersionId: fixed.version.id });
    expect(await worker.process(envelope(render.id))).toMatchObject({ disposition: "completed" });
    const file = await service.renderFile(contextA, project.project.id, render.id, "result");
    expect(await sharp(file.body).metadata()).toMatchObject({ density: 150 });
  });

  it("recovers a stalled processing render redelivered with the same attempt", async () => {
    const { project } = await prepared();
    const render = await service.render(contextA, project.project.id, { expectedVersionId: project.version.id, format: "png", background: "transparent", purpose: "preview" });
    const delivery = envelope(render.id);
    await withTenant(database.db, contextA, (tx) => tx.update(productionEditorRenders).set({ status: "processing", processingToken: createEntityId(), startedAt: new Date(Date.now()-180_000), updatedAt: sql`now()-interval '3 minutes'`, attempt: delivery.attempt }).where(eq(productionEditorRenders.id, render.id)));
    expect(await worker.process(delivery)).toMatchObject({ disposition: "completed" });
    expect((await service.getRender(contextA, project.project.id, render.id)).files).toHaveLength(1);
  });

  it("crypto-erases linked project assets when the source order is anonymized", async () => {
    const evidence = await source(); await reports.review(contextA, evidence.line.id, evidence.parsed.versionId!);
    const project = await service.create(contextA, { name: "Synthetic order project", document: draft(), source: evidence.source });
    const derived = await service.applyCutout(contextA, project.project.id, project.images[0].id, { expectedVersionId: project.version.id, name: "Synthetic derived", recipe: { schemaVersion: 1, maskPngBase64: null, operations: [] } }) as ProductionEditorImageView;
    const core = await orderService.get(contextA, evidence.line.orderId);
    await withTenant(database.db, contextA, (tx) => tx.update(orderProtectedDetails).set({ retentionExpiresAt: new Date(Date.now() - 1000) }).where(eq(orderProtectedDetails.orderId, core.id)));
    const [protectedRow] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, core.id)));
    await orderService.anonymizeProtectedDetails(contextA, core.id, { expectedSequence: core.latestEventSequence, expectedEnvelopeVersion: protectedRow.envelopeVersion, idempotencyKey: `synthetic-delete-${createEntityId()}`, reason: "Synthetic retention cleanup" });
    await expect(service.image(contextA, project.project.id, project.images[0].id, "original")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cutoutEditor(contextA, project.project.id, derived.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.image(contextA, project.project.id, derived.id, "original")).rejects.toBeInstanceOf(NotFoundException);
    const [row] = await withTenant(database.db, contextA, (tx) => tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, project.project.id)));
    expect(row).toMatchObject({ status: "expired", encryptedDataKey: null, name: "" });
  });

  it("crypto-erases expired projects and user-deleted standalone projects", async () => {
    const evidence = await source(); await reports.review(contextA, evidence.line.id, evidence.parsed.versionId!);
    const linked = await service.create(contextA, { name: "Synthetic order project", document: draft(), source: evidence.source });
    await withTenant(database.db, contextA, (tx) => tx.update(productionEditorProjects).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(productionEditorProjects.id, linked.project.id)));
    await expect(service.get(contextA, linked.project.id)).rejects.toBeInstanceOf(NotFoundException);
    const standalone = await create(); await service.remove(contextA, standalone.project.id);
    await expect(service.get(contextA, standalone.project.id)).rejects.toBeInstanceOf(NotFoundException);
    for (const id of [linked.project.id, standalone.project.id]) {
      const [row] = await withTenant(database.db, contextA, (tx) => tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, id)));
      expect(row.encryptedDataKey).toBeNull();
    }
    expect((await withTenant(database.db, contextA, (tx) => tx.select().from(productionEditorRenders))).every((row) => !JSON.stringify(row).includes("Synthetic picture"))).toBe(true);
  });
});
