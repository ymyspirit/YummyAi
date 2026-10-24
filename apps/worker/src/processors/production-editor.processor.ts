import { createHash } from "node:crypto";
import { ForbiddenError } from "@yummyai/authz";
import { assertCatalogEditorSource, CatalogAccessNotFoundError, CatalogAuthorityChangedError, CatalogError } from "@yummyai/catalog-core";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, ProductionEditorDocumentSchema, ProductionEditorExportOptionsSchema, ProductionImageEditOptionsSchema, type TenantContext, type ProductionEditorExportOptions, type ProductionImageEditOptions, type ProductionEditorPreflight } from "@yummyai/contracts";
import { productionEditorProjects as projects, productionEditorVersions as versions, productionEditorImages as images, productionEditorRenders as renders, amazonOrderReportLines, orders, orderLines, orderWorkItems, modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { ProductionEditorRenderJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { decryptProductionBytes, encryptProductionBytes, getBuiltinFont, renderProductionDocument } from "@yummyai/production-editor";
import type { Storage, AssetDomain } from "@yummyai/storage";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { HttpStudioGateway, type StudioGateway } from "./studio-generation.gateway.js";
import { OrderImageEnhancementOptionsSchema } from "@yummyai/contracts/pod/production-editor-api";
import { ClamAvScanner } from "@yummyai/storage";
import { enhanceOrderImages } from "./order-image-enhancement.js";
import { ArtworkAuditRepository } from "@yummyai/order-design";

type Project = typeof projects.$inferSelect & { catalogContext?: TenantContext };

/** Queue data contains only immutable task identity. Customer documents and files are hydrated inside RLS. */
export class ProductionEditorRenderProcessor {
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly vault: SecretVault, private readonly modelVault?: SecretVault, private readonly imageGateway: StudioGateway = new HttpStudioGateway(), private readonly scanner: Pick<ClamAvScanner, "scan"> = new ClamAvScanner(), private readonly assistVault?: SecretVault) {}

  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { renderId } = ProductionEditorRenderJobPayloadSchema.parse(envelope.payload);
    let context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, dataScope: "tenant", permissions: ["design:read", "asset:read", "order:read", "order:pii:read"] };
    const token = createEntityId();
    const claimed = await withTenant(this.database.db, context, async (tx) => {
      const [candidate] = await tx.select({ row: renders, leaseLive: sql<boolean>`coalesce(${renders.leaseUntil},${renders.updatedAt}+interval '2 minutes')>clock_timestamp()` }).from(renders).where(eq(renders.id, renderId)).for("update");
      const row = candidate?.row;
      if (!row) throw new Error("production_render_not_found");
      if (row.requestedBy !== envelope.requestedBy) throw new Error("production_render_owner_mismatch");
      if (row.status === "completed" || row.status === "processing" && candidate.leaseLive) return null;
      // Database ownership survives a lost Redis lock. Only an expired lease can
      // be replaced; the fencing token prevents an old process from committing.
      await tx.update(renders).set({ status: "processing", processingToken: token, leaseUntil: sql`clock_timestamp()+interval '2 minutes'`, startedAt: new Date(), attempt: envelope.attempt, errorCode: null, updatedAt: new Date() }).where(eq(renders.id, renderId));
      return row;
    });
    if (!claimed) return { renderId, disposition: "already_claimed" as const };
    let activeKey: Buffer | undefined;
    let heartbeatPending: Promise<unknown> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = withTenant(this.database.db, context, tx => tx.update(renders)
        .set({ leaseUntil: sql`clock_timestamp()+interval '2 minutes'` })
        .where(and(eq(renders.id, renderId), eq(renders.status, "processing"), eq(renders.processingToken, token))))
        .catch(() => { process.stderr.write("Production render lease renewal unavailable\n"); })
        .finally(() => { heartbeatPending = undefined; });
    }, 15_000);
    heartbeat.unref();
    try {
      if (signal.aborted) throw new Error("production_render_aborted");
      const project = await this.project(context, claimed.projectId), key = this.key(project);
      context = project.catalogContext ?? context;
      activeKey = key;
      const rawOptions = openJson(key, claimed.encryptedOptions);
      const enhancement = OrderImageEnhancementOptionsSchema.safeParse(rawOptions);
      if (enhancement.success) {
        if (claimed.status !== "queued") throw new Error("production_image_submission_interrupted");
        const [version] = await withTenant(this.database.db, context, tx => tx.select().from(versions).where(and(eq(versions.id, claimed.versionId), eq(versions.projectId, project.id))));
        if (!version || project.currentVersionId !== version.id) throw new Error("production_version_changed");
        const document = ProductionEditorDocumentSchema.parse(openJson(key, version.encryptedDocument));
        if (createHash("sha256").update(JSON.stringify(document)).digest("hex") !== version.checksum) throw new Error("production_version_checksum_mismatch");
        await enhanceOrderImages({ database: this.database, storage: this.storage, context, project, key, options: enhancement.data, document, versionId: version.id, renderId, token, signal,
          validate: async () => { if ((await this.project(context, project.id)).currentVersionId !== version.id) throw new Error("production_version_changed"); },
          generate: (options, bytes, requestId) => this.modelImage(context, options, bytes, requestId, false),
          scan: (body, fileName) => this.scanner.scan({ body, fileName, mediaType: "image/png" }),
        });
        return { renderId, disposition: "completed" as const };
      }
      const imageEdit = ProductionImageEditOptionsSchema.safeParse(rawOptions);
      const options = imageEdit.success ? imageEdit.data : ProductionEditorExportOptionsSchema.parse(rawOptions);
      // An interrupted external request may already have been billed. Never submit it again.
      if (options.purpose === "image_edit" && claimed.status !== "queued") throw new Error("production_image_submission_interrupted");
      this.assertVersion(project, claimed.versionId, options);
      const [version] = await withTenant(this.database.db, context, (tx) => tx.select().from(versions).where(and(eq(versions.id, claimed.versionId), eq(versions.projectId, project.id))));
      if (!version) throw new Error("production_version_not_found");
      const document = ProductionEditorDocumentSchema.parse(openJson(key, version.encryptedDocument));
      if (createHash("sha256").update(JSON.stringify(document)).digest("hex") !== version.checksum) throw new Error("production_version_checksum_mismatch");
      const resolve = async (assetId: string, kind: "image" | "font") => {
        const [asset] = await withTenant(this.database.db, context, (tx) => tx.select().from(images).where(and(eq(images.id, assetId), eq(images.projectId, project.id))));
        if (!asset) throw new Error("production_asset_not_found");
        const metadata = openJson<{ kind: string }>(key, asset.encryptedMetadata);
        if (metadata.kind !== kind) throw new Error("production_asset_type_mismatch");
        const bytes = await this.read(context, project, asset.originalObjectKey);
        if (createHash("sha256").update(bytes).digest("hex") !== asset.checksum) throw new Error("production_asset_checksum_mismatch");
        return { bytes };
      };
      const artworkAudit = this.assistVault && project.sourceWorkItemId ? await new ArtworkAuditRepository(this.database, this.assistVault).current(context, project.id, version.id) : null;
      const result = options.purpose === "image_edit" ? await this.modelImage(context, options, (await resolve(options.sourceImageId, "image")).bytes, renderId) : await renderProductionDocument(document, options, {
        artworkAudit,
        resolveAsset: async (id, version) => { if (version !== 1) throw new Error("production_asset_version_mismatch"); return resolve(id, "image"); },
        resolveFont: (id) => id === "geist_regular" ? getBuiltinFont(id) : resolve(id, "font"),
      });
      if (signal.aborted) throw new Error("production_render_aborted");
      if (options.purpose === "production" && !result.preflight.productionReady) throw new Error("production_preflight_failed");
      this.assertVersion(await this.project(context, project.id), claimed.versionId, options);
      if (options.purpose === "production" && artworkAudit && this.assistVault) {
        const currentAudit = await new ArtworkAuditRepository(this.database, this.assistVault).current(context, project.id, version.id);
        if (JSON.stringify(currentAudit) !== JSON.stringify(artworkAudit)) throw new Error("production_audit_changed");
      }
      const domain = this.domain(project), extension = options.purpose === "image_edit" ? "png" : options.format === "jpeg" ? "jpg" : options.format === "tiff" ? "tif" : "png";
      const filePurpose = options.purpose === "image_edit" ? "model-cutout" : options.purpose === "preview" && options.previewFullResolution ? "proof" : options.purpose;
      const name = options.purpose === "production" && document.productType === "shaped_pillow" && options.format === "jpeg"
        ? await this.pillowProductionName(context, project, `${filePurpose}-${renderId}.jpg`) : `${filePurpose}-${renderId}.${extension}`;
      const object = await this.storage.putPrivate(context, { body: encryptProductionBytes(key, result.bytes), domain, fileName: `${renderId}-result.pe`, mediaType: "application/octet-stream" });
      const manifest = { files: [{ key: "result", name, mediaType: result.mediaType, byteSize: result.bytes.byteLength, objectKey: object.objectKey }], preflight: result.preflight };
      // Revalidate source and retention after storage I/O and before committing a downloadable result.
      this.assertVersion(await this.project(context, project.id), claimed.versionId, options);
      await withTenant(this.database.db, context, async (tx) => {
        await this.catalogSource(tx, context, project);
        const [locked] = await tx.select().from(projects).where(eq(projects.id, project.id)).for("update");
        if (!locked?.encryptedDataKey || locked.status !== "active" || locked.expiresAt && locked.expiresAt <= new Date()) throw new Error("production_project_expired");
        this.assertVersion(locked, claimed.versionId, options);
        const updated = await tx.update(renders).set({ status: "completed", encryptedManifest: encryptProductionBytes(key, Buffer.from(JSON.stringify(manifest))).toString("base64"), processingToken: null, leaseUntil: null, startedAt: null, errorCode: null, updatedAt: new Date() }).where(and(eq(renders.id, renderId), eq(renders.processingToken, token))).returning({ id: renders.id });
        if (!updated.length) throw new Error("production_claim_lost");
      });
      return { renderId, disposition: "completed" as const };
    } catch (error) {
      // Never persist exception text: renderer/library errors can include customer text or filenames.
      const code = error instanceof Error && /^production_[a-z0-9_]+$/.test(error.message) ? error.message : "production_render_failed";
      await withTenant(this.database.db, context, (tx) => tx.update(renders).set({ status: "failed", errorCode: code, processingToken: null, leaseUntil: null, startedAt: null, updatedAt: new Date() }).where(and(eq(renders.id, renderId), eq(renders.processingToken, token))));
      throw new Error(code);
    } finally { clearInterval(heartbeat); await heartbeatPending; activeKey?.fill(0); }
  }

  private async pillowProductionName(context: TenantContext, project: Project, fallback: string) {
    const source = await withTenant(this.database.db, context, async tx => {
      if (project.sourceWorkItemId) return (await tx.select({ externalOrderId: orders.externalOrderId }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId)).where(eq(orderLines.id, project.sourceWorkItemId)))[0];
      if (project.sourceReportLineId) return (await tx.select({ externalOrderId: orders.externalOrderId }).from(amazonOrderReportLines).innerJoin(orders, eq(orders.id, amazonOrderReportLines.orderId)).where(eq(amazonOrderReportLines.id, project.sourceReportLineId)))[0];
      return undefined;
    });
    if (!source) return fallback;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(source.externalOrderId)) throw new Error("production_order_file_name_invalid");
    return `${source.externalOrderId}.jpg`;
  }

  private async modelImage(context: TenantContext, input: ProductionImageEditOptions, source: Buffer, requestId: string, cutout = true) {
    if (!this.modelVault) throw new Error("production_image_model_unavailable");
    const [provider] = await withTenant(this.database.db, context, tx => tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, input.providerConfigId), eq(modelProviderConfigs.status, "enabled"))));
    const [route] = await withTenant(this.database.db, context, tx => tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.modelId), eq(modelRoutes.taskType, "studio_image"), eq(modelRoutes.status, "enabled"))));
    if (!provider || !route || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== provider.id || route.targets[0]!.providerModel !== input.model) throw new Error("production_image_model_changed");
    // Normalize orientation and file format only; segmentation is entirely performed by the selected model.
    const reference = await sharp(source, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer();
    const sourceMetadata = await sharp(reference).metadata();
    const preserveAlpha = !!sourceMetadata.hasAlpha && ((await sharp(reference).ensureAlpha().stats()).channels[3]?.min ?? 255) < 255;
    let output;
    try {
      output = await this.modelVault.withSecret(provider.encryptedApiKey, apiKey => this.imageGateway.generate({
        endpoint: provider.endpoint ?? "https://api.openai.com/v1", apiKey, model: input.model, capability: "image", providerTaskId: null,
        references: [{ bytes: reference, mediaType: "image/png" }],
        input: { requestId, modelId: input.modelId, prompt: input.prompt, referenceKeys: [], size: input.size, quality: "high", background: cutout || preserveAlpha ? "transparent" : "auto", seconds: 4 },
      }, async () => undefined));
    } catch (error) {
      throw new Error(error instanceof Error && /^studio_[a-z0-9_]+$/.test(error.message) ? error.message.replace(/^studio_/, "production_image_") : "production_image_provider_failed");
    }
    if (!("bytes" in output) || !output.mediaType.startsWith("image/")) throw new Error("production_image_invalid_result");
    const bytes = await sharp(output.bytes, { limitInputPixels: 100_000_000, failOn: "warning" }).rotate().toColourspace("srgb").png().toBuffer();
    const metadata = await sharp(bytes).metadata(), stats = await sharp(bytes).ensureAlpha().stats();
    const alpha = !!metadata.hasAlpha && (stats.channels[3]?.min ?? 255) < 255;
    if (!cutout && preserveAlpha && !alpha) throw new Error("production_enhancement_alpha_lost");
    const preflight: ProductionEditorPreflight = { productionReady: false, widthPx: metadata.width!, heightPx: metadata.height!, issues: [{ code: "model_image_review", severity: "manual", message: cutout ? "模型抠图仅为图片素材，请检查主体还原、边缘和透明通道后加入画布；此结果不是生产排版预览。" : "保真美化结果需要与顾客原图对照审核。" }, ...(cutout && !alpha ? [{ code: "model_image_missing_alpha", severity: "error" as const, message: "模型结果没有真实透明通道，不能作为抠图直接应用；系统不会改用内置分割脚本。" }] : [])] };
    if (`${metadata.width}x${metadata.height}` !== input.size) preflight.issues.push({ code: "model_image_size_mismatch", severity: "warning", message: `请求尺寸 ${input.size}，模型实际返回 ${metadata.width} × ${metadata.height} px；按实际像素核验印刷清晰度。` });
    return { bytes, mediaType: "image/png", preflight };
  }

  private async project(context: TenantContext, id: string): Promise<Project> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(projects).where(eq(projects.id, id)));
    if (!row?.encryptedDataKey || row.status !== "active") throw new Error("production_project_unavailable");
    if (row.expiresAt && row.expiresAt <= new Date()) { await this.erase(context, id); throw new Error("production_project_expired"); }
    if (row.sourceWorkItemId) {
      const [source] = await withTenant(this.database.db, context, (tx) => tx.select({ work: orderWorkItems, address: orders.addressStatus }).from(orderWorkItems).innerJoin(orderLines, eq(orderLines.id, orderWorkItems.id)).innerJoin(orders, eq(orders.id, orderLines.orderId)).where(eq(orderWorkItems.id, row.sourceWorkItemId!)));
      if (!source?.work.encryptedDataKey || source.work.expiresAt <= new Date() || source.address === "anonymized") { await this.erase(context, id); throw new Error("production_project_expired"); }
      if (source.work.held || source.work.pushedRevisionId !== row.sourceWorkRevisionId) throw new Error("production_work_changed");
    }
    if (row.sourceReportLineId) {
      const [source] = await withTenant(this.database.db, context, (tx) => tx.select({ report: amazonOrderReportLines, order: orders }).from(amazonOrderReportLines).innerJoin(orders, eq(orders.id, amazonOrderReportLines.orderId)).where(eq(amazonOrderReportLines.id, row.sourceReportLineId!)));
      if (!source || source.report.state === "expired" || source.report.expiresAt <= new Date() || source.order.addressStatus === "anonymized") { await this.erase(context, id); throw new Error("production_source_expired"); }
      if (source.report.currentVersionId !== row.sourceReportVersionId || source.report.reviewedVersionId !== row.sourceReportVersionId || !["ready", "partial"].includes(source.report.state)) throw new Error("production_source_changed");
    }
    const source = await withTenant(this.database.db, context, tx => this.catalogSource(tx, context, row));
    return source ? { ...row, catalogContext: source.context } : row;
  }
  private async catalogSource(tx: TenantTransaction, context: TenantContext, project: Project) {
    try {
      return await assertCatalogEditorSource(tx, context, project, { operation: "render", reloadMembership: true });
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_SOURCE_ARCHIVED") throw new Error("production_catalog_source_archived");
      if (error instanceof CatalogAccessNotFoundError || error instanceof CatalogAuthorityChangedError || error instanceof CatalogError || error instanceof ForbiddenError) throw new Error("production_catalog_access_revoked");
      throw error;
    }
  }
  private assertVersion(project: Project, versionId: string, options: ProductionEditorExportOptions | ProductionImageEditOptions) { if (project.currentVersionId !== versionId || options.purpose === "production" && project.reviewedVersionId !== versionId) throw new Error("production_version_changed"); }
  private key(project: Project) { if (!project.encryptedDataKey) throw new Error("production_project_expired"); return this.vault.withSecret(project.encryptedDataKey, (value) => Buffer.from(value, "base64")); }
  private domain(project: Project): AssetDomain { return project.sourceReportLineId || project.sourceWorkItemId ? "order" : "authorized"; }
  private async read(context: TenantContext, project: Project, objectKey: string) { const domain = this.domain(project); return decryptProductionBytes(this.key(project), await this.storage.readPrivate(context, { id: project.id, tenantId: context.tenantId, assetDomain: domain, objectKey }, { requiredDomain: domain })); }
  private async erase(context: TenantContext, id: string) { await withTenant(this.database.db, context, (tx) => tx.update(projects).set({ encryptedDataKey: null, name: "", status: "expired", updatedAt: new Date() }).where(eq(projects.id, id))); }
}
function openJson<T>(key: Uint8Array, value: string): T { return JSON.parse(decryptProductionBytes(key, Buffer.from(value, "base64")).toString("utf8")) as T; }
