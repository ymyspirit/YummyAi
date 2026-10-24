import { ArchiveRecordInputSchema } from "@yummyai/contracts";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertCatalogEditorSource } from "@yummyai/catalog-core";
import { withCatalogTenant as withTenant } from "../catalog/catalog-access.js";
import type { ArtworkLayout } from "@yummyai/contracts/catalog/artwork";
import type { PrintBinding } from "@yummyai/contracts/catalog/composition";
import { printCompositionLayer } from "@yummyai/production-editor";
import type { CustomizationDefinition } from "@yummyai/contracts";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { ORDER_IMAGE_ENHANCEMENT_INSTRUCTION, ORDER_IMAGE_ENHANCEMENT_POLICY } from "@yummyai/contracts/order/workspace";
import { OrderImageEnhancementOptionsSchema, type OrderImageEnhancementOptions } from "@yummyai/contracts/pod/production-editor-api";
import { composeOrderArtwork } from "./order-artwork-layout.js";

import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException, ServiceUnavailableException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import {
  createEntityId, CreateProductionEditorProjectInputSchema, SaveProductionEditorVersionInputSchema,
  CreateProductionEditorRenderInputSchema, ProductionEditorDocumentSchema,
  CreateProductionImageEditInputSchema, ProductionImageEditOptionsSchema, type ProductionImageEditOptions,
  type TenantContext, type ProductionEditorDocument, type ProductionEditorDetailView,
  type ProductionEditorProjectView, type ProductionEditorImageView, type ProductionEditorFontView,
  type ProductionEditorRenderView, type ProductionEditorPreflight, type ProductionEditorExportOptions,
  type RecordCustomizationFileScanInput,
} from "@yummyai/contracts";
import {
  productionEditorProjects as projects, productionEditorVersions as versions, productionEditorImages as images,
  productionEditorRenders as renders, amazonOrderReportLines, orderWorkItems, orderLines, orders, printProfileVersions, modelRoutes, modelProviderConfigs, modelPreferences, orderDesignAgentRuns, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { decryptProductionBytes, encryptProductionBytes, getBuiltinFont, inspectProductionFont, preflightProductionDocument } from "@yummyai/production-editor";
import { productionExportDefaults } from "@yummyai/production-editor/products";
import { ClamAvScanner,createFactoryReadPermit, type Storage, type AssetDomain } from "@yummyai/storage";
import {requireFactoryTask} from "../orders/factory-access.js";
import { and, desc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { ApplyProductionCutoutInputSchema, SegmentProductionImageInputSchema, RefineProductionImageInputSchema, type ProductionCutoutRecipe } from "@yummyai/contracts/pod/production-cutout";
import { renderProductionCutout, prepareProductionMatting, renderProductionDocument } from "@yummyai/production-editor";
import { localSegmentationAvailable, runLocalSegmentation } from "./local-image-segmentation.js";
import { localMattingAvailable, runLocalMatting } from "./local-image-matting.js";

import { AuditService } from "../audit/audit.service.js";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION, ORDER_PII_VAULT, PRIVATE_STORAGE } from "../platform.tokens.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { ArtworkAuditRepository, OrderDesignRepository } from "@yummyai/order-design";

export const PRODUCTION_IMAGE_LIMIT = 64 * 1024 * 1024;
type Project = typeof projects.$inferSelect & { salesRecipeApproved?:boolean; catalogActive?:boolean };
type Image = typeof images.$inferSelect;
type CutoutMetadata = { sourceAssetId: string; recipe: ProductionCutoutRecipe };
type ModelEditMetadata = { renderId: string; sourceImageId: string; model: string; operation?: "enhance" | "cutout"; enhancementPolicy?: typeof ORDER_IMAGE_ENHANCEMENT_POLICY };
type AssetMetadata = { kind: "image" | "font"; name: string; mediaType: string; width: number; height: number; hasAlpha: boolean; actualAlpha: boolean; scan: RecordCustomizationFileScanInput; cutout?: CutoutMetadata; modelEdit?: ModelEditMetadata; buyerOriginal?: boolean };
type Manifest = { files: Array<{ key: string; name: string; mediaType: string; byteSize: number; objectKey: string; checksumSha256?: string }>; preflight: ProductionEditorPreflight };
export abstract class ProductionEditorRenderEnqueuer { abstract enqueue(input: { renderId: string; tenantId: string; requestedBy: string; maxAttempts: number }): Promise<void>; }
export abstract class ProductionEditorScanner { abstract scan(bytes: Uint8Array, name: string, mediaType: string): Promise<RecordCustomizationFileScanInput>; }
@Injectable()
export class ClamAvProductionEditorScanner extends ProductionEditorScanner {
  private readonly scanner = new ClamAvScanner();
  scan(body: Uint8Array, fileName: string, mediaType: string) { return this.scanner.scan({ body, fileName, mediaType }); }
}

@Injectable()
export class ProductionEditorService {
  private readonly catalogTransaction = new AsyncLocalStorage<{ context: TenantContext; tx: TenantTransaction }>();
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(AmazonOrderReportService) private readonly reports: AmazonOrderReportService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProductionEditorRenderEnqueuer) private readonly enqueuer: ProductionEditorRenderEnqueuer,
    @Inject(ProductionEditorScanner) private readonly scanner: ProductionEditorScanner,
    @Inject(AI_ASSIST_VAULT) private readonly assistVault?: SecretVault,
  ) {}

  /** The catalog owner already holds source locks; nested editor operations join
   * that exact tenant transaction instead of waiting on their own parent. */
  inCatalogTransaction<T>(context: TenantContext, tx: TenantTransaction, operation: () => Promise<T>) {
    const prior = this.catalogTransaction.getStore();
    if (prior && (prior.tx !== tx || prior.context.tenantId !== context.tenantId || prior.context.userId !== context.userId))
      throw new ConflictException("制作事务上下文已变化 请重新操作");
    return this.catalogTransaction.run({ context, tx }, operation);
  }

  private inTenant<T>(context: TenantContext, operation: (tx: TenantTransaction) => Promise<T>) {
    const owner = this.catalogTransaction.getStore();
    if (!owner) return withTenant(this.database.db, context, operation);
    if (owner.context.tenantId !== context.tenantId || owner.context.userId !== context.userId)
      throw new ConflictException("制作事务上下文不匹配");
    return operation(owner.tx);
  }

  async archive(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = ArchiveRecordInputSchema.parse(raw);
    return this.inTenant(context, async tx => {
      const [source] = await tx.select().from(projects).where(eq(projects.id, id));
      if (!source) throw new NotFoundException("记录不存在");
      await assertCatalogEditorSource(tx, context, source, { operation: "manage" });
      const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!row) throw new NotFoundException("记录不存在");
      if (row.sourceSalesRecipeId !== source.sourceSalesRecipeId || row.sourceSalesSkuId !== source.sourceSalesSkuId || row.createdBy !== source.createdBy)
        throw new ConflictException("制作来源已变化 请重新核对");
      if (row.sourceReportLineId || row.sourceWorkItemId) authorize(context, Permission.OrderWrite);
      if (input.archived && (await tx.select({ id: renders.id }).from(renders).where(and(eq(renders.projectId, id), sql`${renders.status} in ('queued','processing')`)).limit(1))[0]) throw new ConflictException("请先等待生成任务结束");
      if (Boolean(row.archivedAt) === input.archived) return { id, archived: input.archived };
      await tx.update(projects).set({ archivedAt: input.archived ? new Date() : null }).where(eq(projects.id, id));
      await this.audit.recordInTransaction(tx, context, { action: "production_editor_project.archive", resourceType: "production_editor_project", resourceId: id, result: "success", metadata: input });
      return { id, archived: input.archived };
    });
  }

  async list(context: TenantContext, scope?: "templates") {
    authorize(context, Permission.DesignRead);
    const rows = await this.inTenant(context, (tx) => tx.select().from(projects).where(and(eq(projects.status, "active"), sql`${projects.archivedAt} is null`, scope === "templates" ? sql`${projects.sourceReportLineId} is null and ${projects.sourceWorkItemId} is null and ${projects.sourceSalesRecipeId} is null` : undefined)).orderBy(desc(projects.updatedAt)).limit(100));
    const result: ProductionEditorProjectView[] = [];
    for (const row of rows) {
      if ((row.sourceReportLineId || row.sourceWorkItemId) && (!context.permissions.includes(Permission.OrderRead) || !context.permissions.includes(Permission.OrderPiiRead))) continue;
      try { const active = await this.project(context, row.id); result.push(this.projectView(active, await this.document(context, active, active.currentVersionId!))); }
      catch (error) { if (!(error instanceof NotFoundException || error instanceof ConflictException)) throw error; }
    }
    return { projects: result };
  }

  async create(context: TenantContext, body: unknown): Promise<ProductionEditorDetailView> {
    authorize(context, Permission.DesignWrite);
    const input = CreateProductionEditorProjectInputSchema.parse(body);
    const source = input.source ?? null;
    let expiresAt: Date | null = null;
    let sourceFiles: Array<{ key: string; name: string }> = [];
    if (source) {
      authorize(context, Permission.OrderWrite);
      const detail = await this.reports.detail(context, source.reportLineId);
      if (!detail.line.reviewed || detail.versionId !== source.reportVersionId || !["ready", "partial"].includes(detail.line.state)) throw new ConflictException("请先核对订单当前定制版本，再创建生产项目");
      const [row] = await this.inTenant(context, (tx) => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, source.reportLineId)));
      if (!row || row.expiresAt <= new Date()) throw new ConflictException("订单定制资料已过期");
      expiresAt = row.expiresAt;
      sourceFiles = detail.files.filter((file) => file.role === "buyer_image").map((file) => {
        const original = detail.files.find((candidate) => candidate.key === file.originalFileKey);
        if (!original || original.role !== "source") throw new ConflictException("订单原始图片引用不可用");
        return { key: original.key, name: original.name.split("/").at(-1)! };
      });
    }
    // Initial documents cannot refer to another project's assets.
    if (input.document.layers.some((layer) => layer.kind === "image" || layer.kind === "text" && layer.fontId !== "geist_regular")) throw new UnprocessableEntityException("请先创建项目，再上传或选择本项目素材");
    const id = createEntityId(), versionId = createEntityId(), key = randomBytes(32);
    const document = { ...input.document, name: input.name };
    await this.inTenant(context, async (tx) => {
      await tx.insert(projects).values({ id, tenantId: context.tenantId, name: document.productType, encryptedDataKey: this.vault.encrypt(key.toString("base64")), sourceReportLineId: source?.reportLineId, sourceReportVersionId: source?.reportVersionId, expiresAt, createdBy: context.userId });
      await tx.insert(versions).values({ id: versionId, tenantId: context.tenantId, projectId: id, versionNumber: 1, encryptedDocument: sealJson(key, document), checksum: sha(JSON.stringify(document)), createdBy: context.userId });
      await tx.update(projects).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(projects.id, id));
    });
    try {
      for (const file of sourceFiles) {
        const sourceFile = await this.reports.file(context, source!.reportLineId, file.key, source!.reportVersionId);
        await this.upload(context, id, file.name, sourceFile.body, "image");
      }
    } catch {
      await this.erase(context, id, "deleted");
      throw new UnprocessableEntityException("订单图片导入失败，未保留可解密的项目，请检查扫描服务与原图");
    } finally { key.fill(0); }
    await this.audit.record(context, { action: "production_editor.create", resourceType: "production_editor_project", resourceId: id, result: "success", metadata: { sourceLinked: !!source } });
    return this.get(context, id);
  }

  async get(context: TenantContext, id: string, versionId?: string): Promise<ProductionEditorDetailView> {
    const project = await this.project(context, id), key = this.key(project);
    const data = await this.inTenant(context, async (tx) => ({
      versions: await tx.select().from(versions).where(eq(versions.projectId, id)).orderBy(desc(versions.versionNumber)).limit(200),
      images: await tx.select().from(images).where(eq(images.projectId, id)).orderBy(desc(images.createdAt)).limit(200),
      renders: await tx.select().from(renders).where(eq(renders.projectId, id)).orderBy(desc(renders.createdAt)).limit(100),
    }));
    const selected = data.versions.find((row) => row.id === (versionId ?? project.currentVersionId));
    if (!selected) throw new NotFoundException("生产版本不存在");
    const current = data.versions.find((row) => row.id === project.currentVersionId)!;
    const meta = (row: typeof versions.$inferSelect) => ({ id: row.id, versionNumber: row.versionNumber, createdAt: row.createdAt.toISOString(), reviewed: project.reviewedVersionId === row.id });
    const assets = data.images.map((row) => ({ row, metadata: openJson<AssetMetadata>(key, row.encryptedMetadata) }));
    return {
      project: this.projectView(project, ProductionEditorDocumentSchema.parse(openJson(key, current.encryptedDocument))),
      version: { ...meta(selected), document: ProductionEditorDocumentSchema.parse(openJson(key, selected.encryptedDocument)) },
      versions: data.versions.map(meta),
      images: assets.filter(({ metadata }) => metadata.kind === "image").map(({ row, metadata }) => this.imageView(row, metadata)),
      fonts: [this.builtinFont(id), ...assets.filter(({ metadata }) => metadata.kind === "font").map(({ row, metadata }) => this.fontView(row, metadata))],
      renders: data.renders.map((row) => this.renderView(row, key)),
    };
  }

  async save(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = SaveProductionEditorVersionInputSchema.parse(body), project = await this.project(context, id);
    await this.assertWorkEditable(context, project);
    await this.checkAssets(context, project, input.document);
    if (input.document.productType !== project.name) throw new ConflictException("项目产品类型不可更改");
    await this.inTenant(context, async (tx) => {
      await this.assertWorkEditable(context, project, tx);
      const [locked] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!locked?.encryptedDataKey || locked.status !== "active" || locked.currentVersionId !== input.expectedVersionId) throw new ConflictException("项目版本已更新，请刷新后保存");
      if (project.sourceWorkItemId) {
        const [previousVersion] = await tx.select().from(versions).where(eq(versions.id, locked.currentVersionId!));
        if (!previousVersion) throw new ConflictException("当前制作版本不可用");
        const previousDocument = ProductionEditorDocumentSchema.parse(openJson(this.key(locked), previousVersion.encryptedDocument));
        if (JSON.stringify(input.document.automation ?? null) !== JSON.stringify(previousDocument.automation ?? null)) throw new ConflictException("订单已固定图片处理配方，请在产品制作版本中修改并重新审单");
        const jobs = await tx.select().from(renders).where(eq(renders.projectId, id));
        if (jobs.some(job => ["queued", "processing"].includes(job.status) && OrderImageEnhancementOptionsSchema.safeParse(openJson(this.key(locked), job.encryptedOptions)).success)) throw new ConflictException("顾客图片正在保真美化，完成后自动更新草稿，请稍后再保存");
      }
      const versionId = createEntityId();
      await tx.insert(versions).values({ id: versionId, tenantId: context.tenantId, projectId: id, versionNumber: locked.versionNumber + 1, encryptedDocument: sealJson(this.key(locked), input.document), checksum: sha(JSON.stringify(input.document)), createdBy: context.userId });
      await tx.update(projects).set({ currentVersionId: versionId, versionNumber: locked.versionNumber + 1, reviewedVersionId: null, reviewedBy: null, reviewedAt: null, updatedAt: new Date() }).where(eq(projects.id, id));
    });
    return this.get(context, id);
  }

  async review(context: TenantContext, id: string, expectedVersionId: string) {
    authorize(context, Permission.DesignReview);
    const source = await this.project(context, id);
    if (source.sourceWorkItemId) throw new ConflictException("请在制图中心提交并审核订单文件");
    await this.inTenant(context, async (tx) => {
      await assertCatalogEditorSource(tx, context, source, { operation: "review" });
      const [project] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!project?.encryptedDataKey || project.status !== "active" || project.currentVersionId !== expectedVersionId) throw new ConflictException("只能审核当前生产版本");
      await tx.update(projects).set({ reviewedVersionId: expectedVersionId, reviewedBy: context.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(projects.id, id));
      await this.audit.recordInTransaction(tx, context, { action: "production_editor.review", resourceType: "production_editor_version", resourceId: expectedVersionId, result: "success", metadata: { projectId: id } });
    });
    return this.get(context, id);
  }

  /** The order module owns the work lock and state transition. This module owns
   * editor version validation and approval, in that same tenant transaction. */
  async confirmWorkVersion(tx: TenantTransaction, context: TenantContext, workItemId: string, projectId: string, versionId: string, approve: boolean | "reject") {
    authorize(context, approve === false ? Permission.DesignWrite : Permission.DesignReview);
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project?.encryptedDataKey || project.status !== "active" || project.sourceWorkItemId !== workItemId || project.currentVersionId !== versionId) throw new ConflictException("制作文件版本已变化，请重新核对");
    if (approve === true) {
      await tx.update(projects).set({ reviewedVersionId: versionId, reviewedBy: context.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(projects.id, projectId));
      await this.audit.recordInTransaction(tx, context, { action: "production_editor.review", resourceType: "production_editor_version", resourceId: versionId, result: "success", metadata: { projectId } });
      // Approval and its export are durable together. The operator only reviews
      // the proof; delivery to the worker never depends on an open browser.
      const [version] = await tx.select().from(versions).where(and(eq(versions.id, versionId), eq(versions.projectId, projectId)));
      if (!version) throw new ConflictException("制作文件版本已变化，请重新核对");
      const key = this.key(project);
      try {
        const document = ProductionEditorDocumentSchema.parse(openJson(key, version.encryptedDocument));
        const exportOptions = { ...productionExportDefaults(document), purpose: "production" as const };
        const previous = await tx.select().from(renders).where(and(eq(renders.projectId, projectId), eq(renders.versionId, versionId), sql`${renders.status} in ('queued','processing','completed')`)).orderBy(desc(renders.createdAt));
        const existing = previous.find(row => {
          const saved = openJson<ProductionEditorExportOptions>(key, row.encryptedOptions);
          return saved.purpose === "production" && saved.format === exportOptions.format && saved.background === exportOptions.background;
        });
        if (existing) return existing.id;
        const renderId = createEntityId();
        await tx.insert(renders).values({ id: renderId, tenantId: context.tenantId, projectId, versionId, encryptedOptions: sealJson(key, exportOptions), requestedBy: context.userId });
        return renderId;
      } finally { key.fill(0); }
    } else if (approve === "reject") {
      await tx.update(projects).set({ reviewedVersionId: null, reviewedBy: null, reviewedAt: null, updatedAt: new Date() }).where(eq(projects.id, projectId));
      await this.audit.recordInTransaction(tx, context, { action: "production_editor.reject", resourceType: "production_editor_version", resourceId: versionId, result: "success", metadata: { projectId } });
    }
  }

  dispatchApprovedProduction(context: TenantContext, renderId: string) {
    authorize(context, Permission.DesignReview);
    // Redis can be reconnecting. Approval is already durable; never keep the
    // operator waiting for queue availability or the file itself.
    void this.enqueuer.enqueue({ renderId, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: 3 })
      .catch(() => { /* Leave queued for the durable production dispatcher. */ });
  }

  async upload(context: TenantContext, id: string, name: string, bytes: Uint8Array, kind: "image" | "font" = "image", cutout?: CutoutMetadata, modelEdit?: ModelEditMetadata, buyerOriginal = false): Promise<ProductionEditorImageView | ProductionEditorFontView> {
    authorize(context, Permission.DesignWrite);
    const project = await this.project(context, id);
    await this.assertWorkEditable(context, project);
    if (!bytes.byteLength || bytes.byteLength > (kind === "font" ? 10 * 1024 * 1024 : PRODUCTION_IMAGE_LIMIT)) throw new UnprocessableEntityException(kind === "font" ? "字体最大 10 MiB" : "图片最大 64 MiB");
    const safeName = name.split(/[\\/]/).at(-1)?.slice(0, 200) || (kind === "font" ? "font.ttf" : "image.png");
    let scan: RecordCustomizationFileScanInput;
    try { scan = await this.scanner.scan(bytes, safeName, "application/octet-stream"); } catch { throw new UnprocessableEntityException("安全扫描暂不可用，文件未保存"); }
    if (scan.result !== "clean" || scan.signatureVersion === "unavailable") throw new UnprocessableEntityException("文件未通过安全扫描");
    let metadata: AssetMetadata, preview: Uint8Array;
    try {
      if (kind === "font") {
        const magic = Buffer.from(bytes).subarray(0, 4);
        if (!magic.equals(Buffer.from([0, 1, 0, 0])) && magic.toString() !== "OTTO" && magic.toString() !== "true") throw new Error("unsupported_font");
        inspectProductionFont(bytes);
        metadata = { kind, name: safeName, mediaType: magic.toString() === "OTTO" ? "font/otf" : "font/ttf", width: 0, height: 0, hasAlpha: false, actualAlpha: false, scan };
        preview = bytes;
      } else {
        const decoded = sharp(bytes, { limitInputPixels: 100_000_000, failOn: "warning", pages: 1 });
        const info = await decoded.metadata();
        if (!info.format || !["png", "jpeg", "tiff"].includes(info.format) || !info.width || !info.height || (info.pages ?? 1) > 1) throw new Error("unsupported_image");
        const stats = await sharp(bytes, { limitInputPixels: 100_000_000 }).toColourspace("srgb").ensureAlpha().stats();
        const rotated = !!info.orientation && info.orientation >= 5 && info.orientation <= 8;
        metadata = { kind, name: safeName, mediaType: `image/${info.format}`, width: rotated ? info.height : info.width, height: rotated ? info.width : info.height, hasAlpha: !!info.hasAlpha, actualAlpha: !!info.hasAlpha && (stats.channels[3]?.min ?? 255) < 255, scan };
        preview = await decoded.rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer();
      }
    } catch { throw new UnprocessableEntityException(kind === "font" ? "仅支持有效的 TTF/OTF 字体" : "仅支持有效的单页 PNG/JPEG/TIFF，最多一亿像素"); }
    if (cutout) metadata.cutout = cutout;
    if (modelEdit) metadata.modelEdit = modelEdit;
    if (buyerOriginal) metadata.buyerOriginal = true;
    const imageId = createEntityId(), key = this.key(project), domain = this.domain(project);
    const original = await this.storage.putPrivate(context, { body: encryptProductionBytes(key, bytes), domain, fileName: `${imageId}-source.pe`, mediaType: "application/octet-stream" });
    const thumbnail = kind === "font" ? original : await this.storage.putPrivate(context, { body: encryptProductionBytes(key, preview), domain, fileName: `${imageId}-preview.pe`, mediaType: "application/octet-stream" });
    await this.project(context, id);
    const [row] = await this.inTenant(context, async (tx) => {
      await this.assertWorkEditable(context, project, tx);
      return tx.insert(images).values({ id: imageId, tenantId: context.tenantId, projectId: id, encryptedMetadata: sealJson(key, metadata), originalObjectKey: original.objectKey, previewObjectKey: thumbnail.objectKey, checksum: sha(bytes), byteSize: bytes.byteLength }).returning();
    });
    return kind === "font" ? this.fontView(row, metadata) : this.imageView(row, metadata);
  }

  async image(context: TenantContext, id: string, imageId: string, kind: "preview" | "original" = "preview") {
    authorize(context, Permission.AssetRead);
    const project = await this.project(context, id), row = await this.asset(context, id, imageId), key = this.key(project), metadata = openJson<AssetMetadata>(key, row.encryptedMetadata);
    const body = await this.readBlob(context, project, kind === "preview" ? row.previewObjectKey : row.originalObjectKey);
    await this.project(context, id);
    return { body, name: kind === "preview" && metadata.kind === "image" ? "preview.png" : metadata.name, mediaType: metadata.kind === "image" && kind === "preview" ? "image/png" : metadata.mediaType, inline: metadata.kind === "image" && kind === "preview" };
  }

  async cutoutEditor(context: TenantContext, id: string, imageId: string) {
    authorize(context, Permission.AssetRead);
    const project = await this.project(context, id), row = await this.asset(context, id, imageId);
    const metadata = openJson<AssetMetadata>(this.key(project), row.encryptedMetadata);
    if (metadata.kind !== "image") throw new UnprocessableEntityException("只能对图片抠图");
    const sourceRow = metadata.cutout ? await this.asset(context, id, metadata.cutout.sourceAssetId) : row;
    const sourceMetadata = openJson<AssetMetadata>(this.key(project), sourceRow.encryptedMetadata);
    if (sourceMetadata.kind !== "image") throw new UnprocessableEntityException("原始图片不可用");
    return { source: this.imageView(sourceRow, sourceMetadata), recipe: metadata.cutout?.recipe ?? { schemaVersion: 1, maskPngBase64: null, operations: [] }, automaticAvailable: localSegmentationAvailable(), refinementAvailable: localMattingAvailable() };
  }

  async segmentImage(context: TenantContext, id: string, imageId: string, body: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = SegmentProductionImageInputSchema.parse(body);
    const project = await this.project(context, id);
    if (project.currentVersionId !== input.expectedVersionId) throw new ConflictException("项目已更新");
    const row = await this.asset(context, id, imageId), metadata = openJson<AssetMetadata>(this.key(project), row.encryptedMetadata);
    if (metadata.kind !== "image" || metadata.cutout) throw new UnprocessableEntityException("请从保留的原图重新编辑");
    const original = await this.image(context, id, imageId, "original");
    let pixels: Buffer;
    try { pixels = await sharp(original.body, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).toColourspace("srgb").flatten({ background: "white" }).jpeg({ quality: 95 }).toBuffer(); }
    catch { throw new UnprocessableEntityException("原图无效或超过四千万像素"); }
    let result;
    try { result = await runLocalSegmentation(pixels, input); }
    catch { throw new ServiceUnavailableException("自动选区暂不可用，可使用套索及擦除恢复工具"); }
    const latest = await this.project(context, id);
    if (latest.currentVersionId !== input.expectedVersionId) throw new ConflictException("项目已更新，请重新打开抠图工具");
    return result;
  }

  async refineImage(context: TenantContext, id: string, imageId: string, body: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = RefineProductionImageInputSchema.parse(body);
    const project = await this.project(context, id);
    if (project.currentVersionId !== input.expectedVersionId) throw new ConflictException("项目已更新");
    const row = await this.asset(context, id, imageId), metadata = openJson<AssetMetadata>(this.key(project), row.encryptedMetadata);
    if (metadata.kind !== "image" || metadata.cutout) throw new UnprocessableEntityException("请从保留的原图重新编辑");
    const original = await this.image(context, id, imageId, "original");
    let pixels;
    try { pixels = await prepareProductionMatting(original.body, input.recipe); }
    catch { throw new UnprocessableEntityException("请先保留主体并移除背景，再细化毛发边缘"); }
    let result;
    try { result = await runLocalMatting(pixels, input); }
    catch { throw new ServiceUnavailableException("毛发细化暂不可用，当前抠图未被修改，请稍后重试"); }
    if ((await this.project(context, id)).currentVersionId !== input.expectedVersionId) throw new ConflictException("项目已更新，请重新打开抠图工具");
    return result;
  }

  async applyCutout(context: TenantContext, id: string, imageId: string, body: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = ApplyProductionCutoutInputSchema.parse(body);
    const project = await this.project(context, id);
    if (project.currentVersionId !== input.expectedVersionId) throw new ConflictException("项目已更新");
    const row = await this.asset(context, id, imageId), metadata = openJson<AssetMetadata>(this.key(project), row.encryptedMetadata);
    if (metadata.kind !== "image" || metadata.cutout) throw new UnprocessableEntityException("请从保留的原图重新编辑");
    const original = await this.image(context, id, imageId, "original");
    let output: Buffer;
    try { output = await renderProductionCutout(original.body, input.recipe); }
    catch { throw new UnprocessableEntityException("抠图为空、蒙版无效或原图超过四千万像素"); }
    if ((await this.project(context, id)).currentVersionId !== input.expectedVersionId) throw new ConflictException("项目已更新");
    return this.upload(context, id, `${input.name.replace(/\.png$/i, "")}.png`, output, "image", { sourceAssetId: imageId, recipe: input.recipe });
  }

  async font(context: TenantContext, id: string, fontId: string) {
    await this.project(context, id);
    if (fontId === "geist_regular") return { body: (await getBuiltinFont(fontId)).bytes, mediaType: "font/ttf", name: "Geist-Regular.ttf", inline: false };
    const project = await this.project(context, id), row = await this.asset(context, id, fontId);
    if (openJson<AssetMetadata>(this.key(project), row.encryptedMetadata).kind !== "font") throw new NotFoundException("字体不存在");
    return this.image(context, id, fontId, "original");
  }

  async preflight(context: TenantContext, id: string, body: unknown) {
    const input = CreateProductionEditorRenderInputSchema.parse(body), project = await this.project(context, id);
    if (project.currentVersionId !== input.expectedVersionId) throw new ConflictException("版本已更新，请刷新");
    const document = await this.document(context, project, input.expectedVersionId);
    const artworkAudit = this.assistVault && project.sourceWorkItemId ? await new ArtworkAuditRepository(this.database, this.assistVault).current(context, id, input.expectedVersionId) : null;
    const check = await preflightProductionDocument(document, options(input), { ...this.resolvers(context, project), artworkAudit });
    if (project.sourceWorkItemId && document.automation?.imagePolicy !== "preserve") {
      const rows = await this.inTenant(context, tx => tx.select().from(renders).where(eq(renders.projectId, id)).orderBy(desc(renders.createdAt)));
      const enhancement = rows.find(row => OrderImageEnhancementOptionsSchema.safeParse(openJson(this.key(project), row.encryptedOptions)).success);
      if (enhancement && enhancement.status !== "completed") {
        check.productionReady = false;
        check.issues.push({ code: "order_image_enhancement_pending", severity: "error", message: enhancement.status === "failed" ? "顾客图片保真美化未完成，请在图片美化任务中重试，完成后再提交审核。" : "顾客图片正在统一保真美化，完成后再提交审核。" });
      }
      const assets = await this.inTenant(context, tx => tx.select().from(images).where(eq(images.projectId, id)));
      const metadata = new Map(assets.map(asset => [asset.id, openJson<AssetMetadata>(this.key(project), asset.encryptedMetadata)]));
      const unenhanced = (assetId: string, seen = new Set<string>()): boolean => {
        if (seen.has(assetId)) return true;
        seen.add(assetId);
        const source = metadata.get(assetId);
        if (source?.modelEdit?.enhancementPolicy === ORDER_IMAGE_ENHANCEMENT_POLICY) return false;
        if (source?.buyerOriginal) return true;
        const parent = source?.modelEdit?.sourceImageId ?? source?.cutout?.sourceAssetId;
        return parent ? unenhanced(parent, seen) : false;
      };
      if (document.layers.some(layer => layer.kind === "image" && layer.visible && unenhanced(layer.assetId))) {
        check.productionReady = false;
        check.issues.push({ code: "order_image_enhancement_required", severity: "error", message: "画布仍在使用未美化的顾客图片，请使用保真美化后的素材或其抠图结果。" });
      }
    }
    return check;
  }

  /** Read-only analysis preview: does not create an export or approve this version. */
  async analysisRules(context: TenantContext, id: string) {
    const project = await this.project(context, id);
    if (!project.sourceWorkItemId) return null;
    const view = await new OrderDesignRepository(this.database, this.vault).view(context, project.sourceWorkItemId);
    return view.run?.ruleSnapshot ?? null;
  }

  async analysisPreview(context: TenantContext, id: string, expectedVersionId: string, fullResolution = false) {
    const project = await this.project(context, id);
    if (project.currentVersionId !== expectedVersionId) throw new ConflictException("生产稿版本已更新，请刷新后预检");
    const document = await this.document(context, project, expectedVersionId);
    const defaults = productionExportDefaults(document);
    const preflight = await preflightProductionDocument(document, { ...defaults, purpose: "production" }, this.resolvers(context, project));
    let preview: Buffer | null = null;
    try { preview = (await renderProductionDocument(document, { format: "png", background: defaults.background, purpose: "preview", ...(fullResolution ? {previewFullResolution: true} : {}) }, this.resolvers(context, project))).bytes; }
    catch { /* The rule report remains useful when an invalid document cannot render. */ }
    if ((await this.project(context, id)).currentVersionId !== expectedVersionId) throw new ConflictException("生产稿版本已更新，请刷新后预检");
    return { document, preflight, preview };
  }

  async render(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = CreateProductionEditorRenderInputSchema.parse(body), project = await this.project(context, id);
    const preflight = await this.preflight(context, id, input);
    if (input.purpose === "production" && !preflight.productionReady) throw new UnprocessableEntityException({ code: "production_preflight_failed", message: "正式文件未生成，请处理预检问题。", preflight });
    if (input.purpose === "production" && project.reviewedVersionId !== input.expectedVersionId) throw new UnprocessableEntityException("正式出图需要当前版本人工审核及生产参数检查全部通过");
    const renderId = createEntityId();
    await this.inTenant(context, async (tx) => {
      await assertCatalogEditorSource(tx, context, project, { operation: "render" });
      if (project.sourceWorkItemId) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`order-work:${project.sourceWorkItemId}`}, 0))`);
        const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, project.sourceWorkItemId));
        if (!work?.encryptedDataKey || work.held || work.pushedRevisionId !== project.sourceWorkRevisionId || (input.purpose === "production" && (work.artwork !== "approved" || work.approvedEditorVersionId !== input.expectedVersionId))) throw new ConflictException("订单任务已撤回、暂停或文件尚未审核");
      }
      const [locked] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!locked?.encryptedDataKey || locked.status !== "active" || locked.currentVersionId !== input.expectedVersionId || input.purpose === "production" && locked.reviewedVersionId !== input.expectedVersionId) throw new ConflictException("生产版本或审核状态已更新");
      await tx.insert(renders).values({ id: renderId, tenantId: context.tenantId, projectId: id, versionId: input.expectedVersionId, encryptedOptions: sealJson(this.key(locked), options(input)), requestedBy: context.userId });
    });
    try { await this.enqueuer.enqueue({ renderId, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: 3 }); }
    catch { await this.inTenant(context, (tx) => tx.update(renders).set({ status: project.sourceSalesRecipeId && project.sourceSalesSkuId || project.sourceWorkItemId && input.purpose === "production" ? "queued" : "failed", errorCode: "queue_unavailable", updatedAt: new Date() }).where(and(eq(renders.id, renderId), eq(renders.status, "queued")))); }
    return this.getRender(context, id, renderId);
  }

  async getRender(context: TenantContext, id: string, renderId: string): Promise<ProductionEditorRenderView> {
    const project = await this.project(context, id);
    const [row] = await this.inTenant(context, (tx) => tx.select().from(renders).where(and(eq(renders.projectId, id), eq(renders.id, renderId))));
    if (!row) throw new NotFoundException("出图任务不存在");
    return this.renderView(row, this.key(project));
  }

  async editImageWithModel(context: TenantContext, id: string, imageId: string, raw: unknown) {
    authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetRead);
    const input = CreateProductionImageEditInputSchema.parse(raw), project = await this.project(context, id);
    await this.assertWorkEditable(context, project);
    if (project.currentVersionId !== input.expectedVersionId) throw new ConflictException("图稿版本已变化，请刷新后重试");
    const source = await this.asset(context, id, imageId);
    if (project.sourceWorkItemId || project.sourceReportLineId) {
      const metadata = openJson<AssetMetadata>(this.key(project), source.encryptedMetadata);
      input.prompt += metadata.modelEdit?.enhancementPolicy === ORDER_IMAGE_ENHANCEMENT_POLICY
        ? "\n此输入已经完成保真美化，本次只按要求抠图，保持已美化图案不变。"
        : `\n执行规则：先按下述规则保真美化，再按上面的主体范围抠图。${ORDER_IMAGE_ENHANCEMENT_INSTRUCTION}`;
    }
    if (openJson<AssetMetadata>(this.key(project), source.encryptedMetadata).kind !== "image") throw new UnprocessableEntityException("请选择本项目的原始图片");
    const queued = await this.inTenant(context, async (tx) => {
      await this.assertWorkEditable(context, project, tx);
      const [locked] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!locked?.encryptedDataKey || locked.currentVersionId !== input.expectedVersionId) throw new ConflictException("图稿版本已变化");
      const [existing] = await tx.select().from(renders).where(eq(renders.id, input.requestId));
      if (existing) {
        if (existing.projectId !== id || existing.versionId !== input.expectedVersionId) throw new ConflictException("同一请求不能更换项目或版本");
        const previous = ProductionImageEditOptionsSchema.safeParse(openJson(this.key(locked), existing.encryptedOptions));
        if (!previous.success || previous.data.modelId !== input.modelId || previous.data.sourceImageId !== imageId || previous.data.prompt !== input.prompt || previous.data.size !== input.size) throw new ConflictException("同一抠图请求不能更换参数");
        return false;
      }
      const [route] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.modelId), eq(modelRoutes.taskType, "studio_image"), eq(modelRoutes.status, "enabled")));
      const target = route?.targets.length === 1 ? route.targets[0] : null;
      if (!target) throw new UnprocessableEntityException("请选择已配置的图像模型");
      const [provider] = await tx.select({ id: modelProviderConfigs.id, provider: modelProviderConfigs.provider }).from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, target.providerConfigId), eq(modelProviderConfigs.status, "enabled")));
      if (!provider || !["openai", "openai-compatible"].includes(provider.provider)) throw new UnprocessableEntityException("图像模型渠道不可用");
      const snapshot: ProductionImageEditOptions = { purpose: "image_edit", modelId: input.modelId, providerConfigId: provider.id, model: target.providerModel, sourceImageId: imageId, prompt: input.prompt, size: input.size, ...((project.sourceWorkItemId || project.sourceReportLineId) ? { enhancementPolicy: ORDER_IMAGE_ENHANCEMENT_POLICY } : {}) };
      await tx.insert(renders).values({ id: input.requestId, tenantId: context.tenantId, projectId: id, versionId: input.expectedVersionId, encryptedOptions: sealJson(this.key(locked), snapshot), requestedBy: context.userId });
      return true;
    });
    if (queued) {
      try { await this.enqueuer.enqueue({ renderId: input.requestId, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: 1 }); }
      catch { await this.inTenant(context, tx => tx.update(renders).set({ status: "failed", errorCode: "queue_unavailable" }).where(eq(renders.id, input.requestId))); }
    }
    return this.getRender(context, id, input.requestId);
  }

  async applyModelImage(context: TenantContext, id: string, renderId: string, expectedVersionId: string) {
    authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetRead);
    const project = await this.project(context, id);
    await this.assertWorkEditable(context, project);
    if (project.currentVersionId !== expectedVersionId) throw new ConflictException("图稿版本已变化，请刷新后重试");
    const [row] = await this.inTenant(context, tx => tx.select().from(renders).where(and(eq(renders.id, renderId), eq(renders.projectId, id))));
    if (!row?.encryptedManifest || row.status !== "completed") throw new ConflictException("模型抠图尚未完成");
    const snapshot = ProductionImageEditOptionsSchema.parse(openJson(this.key(project), row.encryptedOptions));
    if (row.versionId !== expectedVersionId) throw new ConflictException("此抠图结果属于其他版本，请核对后重新制作");
    const existing = await this.inTenant(context, tx => tx.select().from(images).where(eq(images.projectId, id)));
    for (const asset of existing) { const metadata = openJson<AssetMetadata>(this.key(project), asset.encryptedMetadata); if (metadata.modelEdit?.renderId === renderId) return this.imageView(asset, metadata); }
    const file = await this.renderFile(context, id, renderId, "result");
    const info = await sharp(file.body).metadata(), stats = await sharp(file.body).ensureAlpha().stats();
    if (!info.hasAlpha || (stats.channels[3]?.min ?? 255) === 255) throw new UnprocessableEntityException("模型返回了白底或不透明图片，没有真实透明通道；请调整模型提示重新生成，不会自动调用本地抠图脚本");
    return this.upload(context, id, `${snapshot.model}-抠图.png`, file.body, "image", undefined, { renderId, sourceImageId: snapshot.sourceImageId, model: snapshot.model, operation: "cutout", ...(snapshot.enhancementPolicy ? { enhancementPolicy: snapshot.enhancementPolicy } : {}) });
  }

  async enhanceOrderImages(context: TenantContext, id: string, expectedVersionId: string, requestId: string) {
    authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetRead);
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    const project = await this.project(context, id);
    await this.assertWorkEditable(context, project);
    if (!project.sourceWorkItemId) throw new ConflictException("仅支持订单私有制图任务");
    if (project.currentVersionId !== expectedVersionId) throw new ConflictException("图稿版本已变化，请刷新");
    const snapshot = await this.inTenant(context, async tx => {
      await this.assertWorkEditable(context, project, tx);
      const [locked] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!locked?.encryptedDataKey || locked.currentVersionId !== expectedVersionId) throw new ConflictException("图稿版本已变化");
      const previous = await tx.select().from(renders).where(eq(renders.projectId, id));
      const existing = previous.find(row => row.id === requestId);
      if (existing) {
        if (existing.versionId !== expectedVersionId || !OrderImageEnhancementOptionsSchema.safeParse(openJson(this.key(locked), existing.encryptedOptions)).success) throw new ConflictException("同一请求不能更换任务或版本");
        return false;
      }
      if (previous.some(row => ["queued", "processing"].includes(row.status) && OrderImageEnhancementOptionsSchema.safeParse(openJson(this.key(locked), row.encryptedOptions)).success)) throw new ConflictException("图片美化正在进行，请等待当前任务完成");
      const assets = await tx.select().from(images).where(eq(images.projectId, id));
      const sourceImageIds = assets.filter(asset => openJson<AssetMetadata>(this.key(locked), asset.encryptedMetadata).buyerOriginal).map(asset => asset.id);
      if (!sourceImageIds.length) throw new ConflictException("本单没有选定的顾客原图");
      const [preference] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
      const routes = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.taskType, "studio_image"), eq(modelRoutes.status, "enabled"))).orderBy(modelRoutes.id);
      const available = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.status, "enabled"));
      const usable = routes.filter(route => route.targets.length === 1 && available.some(provider => provider.id === route.targets[0]!.providerConfigId && ["openai", "openai-compatible"].includes(provider.provider)));
      const route = preference?.defaults.image ? usable.find(route => route.id === preference.defaults.image) : usable.length === 1 ? usable[0] : undefined;
      if (!route) throw new UnprocessableEntityException("请在 AI 模型配置中设置默认图像模型，用于所有顾客图片的保真美化");
      const target = route.targets[0]!;
      const options: OrderImageEnhancementOptions = { purpose: "order_image_enhancement", policy: ORDER_IMAGE_ENHANCEMENT_POLICY, modelId: route.id, providerConfigId: target.providerConfigId, model: target.providerModel, sourceImageIds };
      await tx.insert(renders).values({ id: requestId, tenantId: context.tenantId, projectId: id, versionId: expectedVersionId, requestedBy: context.userId, encryptedOptions: sealJson(this.key(locked), options) });
      return true;
    });
    if (snapshot) {
      try { await this.enqueuer.enqueue({ renderId: requestId, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: 1 }); }
      catch { await this.inTenant(context, tx => tx.update(renders).set({ status: "failed", errorCode: "queue_unavailable", updatedAt: new Date() }).where(eq(renders.id, requestId))); }
    }
    return this.getRender(context, id, requestId);
  }

  async renderFile(context: TenantContext, id: string, renderId: string, fileKey: string) {
    authorize(context, Permission.AssetRead);
    const project = await this.project(context, id);
    const [row] = await this.inTenant(context, (tx) => tx.select().from(renders).where(and(eq(renders.projectId, id), eq(renders.id, renderId))));
    if (row?.status !== "completed" || !row.encryptedManifest) throw new NotFoundException("出图文件尚不可用");
    const manifest = openJson<Manifest>(this.key(project), row.encryptedManifest), file = manifest.files.find((file) => file.key === fileKey);
    if (!file) throw new NotFoundException("出图文件不存在");
    const body = await this.readBlob(context, project, file.objectKey);
    if (file.checksumSha256 !== undefined && (body.byteLength !== file.byteSize || createHash("sha256").update(body).digest("hex") !== file.checksumSha256))
      throw new ConflictException("待审稿文件与原始制作交接不一致，请核对原任务");
    await this.project(context, id);
    return { body, name: file.name, mediaType: file.mediaType, inline: false };
  }

  /** Factory entry selects only the task's immutable formal file, never arbitrary editor IDs. */
  async factoryTaskFile(context:TenantContext,assignmentId:string,fileKey:string){
    authorize(context,Permission.FactoryTaskRead);
    const load=()=>this.inTenant(context,async tx=>{
      const scope=await requireFactoryTask(tx,context,assignmentId);
      const [source]=await tx.select({project:projects,render:renders,privateCurrent:sql<boolean>`${orderWorkItems.encryptedDataKey} is not null and ${orderWorkItems.expiresAt}>clock_timestamp() and ${orders.addressStatus}<>'anonymized' and (${projects.expiresAt} is null or ${projects.expiresAt}>clock_timestamp())`})
        .from(projects).innerJoin(renders,and(eq(renders.projectId,projects.id),eq(renders.id,scope.item.renderId)))
        .innerJoin(orderWorkItems,and(eq(orderWorkItems.id,scope.item.workItemId),eq(projects.sourceWorkItemId,orderWorkItems.id)))
        .innerJoin(orderLines,eq(orderLines.id,orderWorkItems.id)).innerJoin(orders,eq(orders.id,orderLines.orderId))
        .where(and(eq(projects.id,scope.item.editorProjectId),eq(projects.status,"active"),eq(projects.currentVersionId,scope.item.editorVersionId),eq(projects.reviewedVersionId,scope.item.editorVersionId),eq(projects.sourceWorkRevisionId,scope.item.workRevisionId),eq(renders.versionId,scope.item.editorVersionId),eq(renders.status,"completed")));
      if(!source?.privateCurrent||!source.project.encryptedDataKey||!source.render.encryptedManifest)throw new NotFoundException("工厂制作文件已失效或资料已到期");
      return{...source,scope};
    });
    const original=await load(),key=this.key(original.project);
    try{
      const manifest=openJson<Manifest>(key,original.render.encryptedManifest!);
      if(openJson<{purpose?:string}>(key,original.render.encryptedOptions).purpose!=="production"||!manifest.preflight.productionReady)throw new ConflictException("请选择已审核版本的正式生产文件");
      // The delivery owner supplies the original encrypted snapshot's selector.
      // No factory transport parameter can select another editor file.
      const file=manifest.files.find(value=>value.key===fileKey);
      if(!file||file.mediaType!=="image/jpeg"||file.byteSize!==original.scope.item.byteSize)throw new ConflictException("工厂正式文件与原交付索引不同");
      const asset={id:original.project.id,tenantId:context.tenantId,assetDomain:"order" as const,objectKey:file.objectKey};
      const assertCurrent=async()=>{const current=await load();if(current.project.encryptedDataKey!==original.project.encryptedDataKey||current.scope.item.renderId!==original.scope.item.renderId||current.scope.item.fileChecksum!==original.scope.item.fileChecksum||current.render.encryptedManifest!==original.render.encryptedManifest)throw new NotFoundException("工厂制作文件授权已变化");};
      const permit=await createFactoryReadPermit(context,asset,{maxBytes:50*1024*1024+1024,assertCurrent});
      const encrypted=await this.storage.readFactoryAssignedPrivate(context,asset,permit);let body:Buffer;
      try{body=decryptProductionBytes(key,encrypted);}finally{encrypted.fill(0);}
      try{if(body.byteLength!==original.scope.item.byteSize||createHash("sha256").update(body).digest("hex")!==original.scope.item.fileChecksum)throw new ConflictException("工厂正式文件与原交付校验值不同");await assertCurrent();return{body,name:`factory-task-${assignmentId}.jpg`,mediaType:"image/jpeg",inline:false};}catch(error){body.fill(0);throw error;}
    }finally{key.fill(0);}
  }

  async remove(context: TenantContext, id: string) {
    authorize(context, Permission.DesignWrite); const project = await this.project(context, id);
    const referenced = await this.inTenant(context, async (tx) => ({
      profiles: await tx.select({ id: printProfileVersions.id }).from(printProfileVersions).where(eq(printProfileVersions.projectId, id)).limit(1),
      work: await tx.select({ id: orderWorkItems.id }).from(orderWorkItems).where(eq(orderWorkItems.editorProjectId, id)).limit(1),
    }));
    if (project.sourceSalesRecipeId || referenced.profiles.length || referenced.work.length) throw new ConflictException("该文件已有印花或订单引用，请保留历史版本");
    if (project.sourceWorkItemId) await this.assertWorkEditable(context, project);
    await this.erase(context, id, "deleted"); return { deleted: true };
  }

  /** Internal handoff: the caller supplies a pinned, published template and selected originals. */
  async discardInterruptedWork(tx: TenantTransaction, workItemId: string, revisionId: string) {
    // The order service has verified a ten-minute abandoned start under its lock.
    await tx.update(projects).set({ status: "deleted", encryptedDataKey: null, name: "中断的制作初始化", updatedAt: new Date() })
      .where(and(eq(projects.sourceWorkItemId, workItemId), eq(projects.sourceWorkRevisionId, revisionId), eq(projects.status, "active")));
  }

  async createFromWork(context: TenantContext, input: { workItemId: string; revisionId: string; expiresAt: Date; name: string; template: ProductionEditorDetailView; originals: Array<{ name: string; bytes: Uint8Array }>; artworkOverride?: {name:string;bytes:Uint8Array}; printArtworks?: Array<{ binding: PrintBinding; name: string; bytes: Uint8Array }>; artworkMaterials?: Array<{name:string;bytes:Uint8Array;kind:"image"|"font"}>; copyTemplateLayers?: boolean; suppressAutomaticEnhancement?: boolean; automaticLayout?: {layout:ArtworkLayout;customization:CustomizationDefinition;draft:OrderWorkDraft;photoOnlyPillow?:boolean} }) {
    authorize(context, Permission.DesignWrite); authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    if (input.template.project.source || input.template.project.workSource) throw new UnprocessableEntityException("通用底稿不能包含其他买家的素材");
    const [work] = await this.inTenant(context, (tx) => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, input.workItemId)));
    if (!work?.encryptedDataKey || work.held || work.pushedRevisionId !== input.revisionId || work.artwork !== "starting" || work.expiresAt <= new Date()) throw new ConflictException("订单尚未推送或任务已变化");
    const id = createEntityId(), versionId = createEntityId(), key = randomBytes(32);
    const document: ProductionEditorDocument = { ...structuredClone(input.template.version.document), name: input.name, layers: [],
      confirmations: { ...input.template.version.document.confirmations, visualReview: false } };
    try {
      await this.inTenant(context, async (tx) => {
        await tx.insert(projects).values({ id, tenantId: context.tenantId, name: document.productType, encryptedDataKey: this.vault.encrypt(key.toString("base64")), sourceWorkItemId: input.workItemId, sourceWorkRevisionId: input.revisionId, expiresAt: work.expiresAt, createdBy: context.userId });
        await tx.insert(versions).values({ id: versionId, tenantId: context.tenantId, projectId: id, versionNumber: 1, encryptedDocument: sealJson(key, document), checksum: sha(JSON.stringify(document)), createdBy: context.userId });
        await tx.update(projects).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(projects.id, id));
      });
      const mapped = new Map<string, string>();
      const templateLayers = input.copyTemplateLayers === false ? [] : input.template.version.document.layers;
      for (const layer of templateLayers) {
        const assetId = layer.kind === "image" ? layer.assetId : layer.fontId;
        if (assetId === "geist_regular" || mapped.has(assetId)) continue;
        const source = layer.kind === "image" ? await this.image(context, input.template.project.id, assetId, "original") : await this.font(context, input.template.project.id, assetId);
        const asset = await this.upload(context, id, source.name, source.body, layer.kind === "image" ? "image" : "font"); mapped.set(assetId, asset.id);
      }
      document.layers = templateLayers.map((layer) => layer.kind === "image" ? { ...layer, assetId: mapped.get(layer.assetId)! } : { ...layer, fontId: mapped.get(layer.fontId) ?? layer.fontId });
      for (const print of input.printArtworks ?? []) {
        const image = await this.upload(context, id, print.name, print.bytes) as ProductionEditorImageView;
        document.layers.push(printCompositionLayer(document, print.binding, image, print.name));
      }
      if(input.artworkOverride) {
        const png=await sharp(input.artworkOverride.bytes,{limitInputPixels:64_000_000}).rotate().png().toBuffer();
        const replacement=await this.upload(context,id,input.artworkOverride.name+".png",png) as ProductionEditorImageView;
        if(document.layers.some(l=>l.kind==="image" && l.id==="catalog_artwork")) document.layers=document.layers.map(l=>l.kind==="image" && l.id==="catalog_artwork" ? {...l,assetId:replacement.id,assetVersion:replacement.version,name:input.artworkOverride!.name} : l);
        else {
          const width=document.productType==="tire_cover"?document.spec.diameterMm:document.spec.widthMm, height=document.productType==="tire_cover"?document.spec.diameterMm:document.spec.heightMm;
          const scale=Math.min(width/replacement.width,height/replacement.height);
          document.layers=[{id:"catalog_artwork",kind:"image",name:input.artworkOverride.name,assetId:replacement.id,assetVersion:replacement.version,widthMm:replacement.width*scale,heightMm:replacement.height*scale,xMm:(width-replacement.width*scale)/2,yMm:(height-replacement.height*scale)/2,rotationDeg:0,opacity:1,visible:true,locked:false,flipX:false,flipY:false}];
        }
      }
      for (const material of input.artworkMaterials ?? []) await this.upload(context,id,material.name,material.bytes,material.kind);
      const selectedImages: Array<{usage:string;id:string;version:number;width:number;height:number}> = [];
      for (const [index, original] of input.originals.entries()) {
        const image = await this.upload(context, id, original.name, original.bytes, "image", undefined, undefined, true) as ProductionEditorImageView;
        selectedImages.push({usage:input.automaticLayout?.draft.images[index]?.usage ?? original.name,id:image.id,version:image.version,width:image.width,height:image.height});
      }
      // Order images stay explicitly named by intended usage; the designer chooses
      // their placement instead of silently treating the first attachment as artwork.
      const saved = await this.save(context, id, { expectedVersionId: versionId, document:input.automaticLayout ? await composeOrderArtwork(document,input.automaticLayout.layout,input.automaticLayout.customization,input.automaticLayout.draft,selectedImages,input.automaticLayout.photoOnlyPillow) : document });
      if (selectedImages.length && !input.suppressAutomaticEnhancement && document.automation?.imagePolicy !== "preserve") await this.enhanceOrderImages(context, id, saved.version.id, createEntityId());
      return await this.get(context, id);
    } catch (error) { await this.erase(context, id, "deleted"); throw error; }
    finally { key.fill(0); }
  }

  /** Catalog handoff copies geometry and the approved master into its own project. */
  async createFromSalesRecipe(context: TenantContext, input: { skuId:string; recipeId:string; name:string; template:ProductionEditorDetailView; artwork:{name:string;bytes:Uint8Array}; printArtworks?: Array<{ binding: PrintBinding; name: string; bytes: Uint8Array }> }) {
    authorize(context,Permission.DesignWrite);
    await this.inTenant(context, tx => assertCatalogEditorSource(tx, context, { sourceSalesSkuId: input.skuId, sourceSalesRecipeId: input.recipeId, createdBy: context.userId }, { operation: "edit" }));
    const [prior]=await this.inTenant(context,tx=>tx.select().from(projects).where(and(eq(projects.sourceSalesRecipeId,input.recipeId),eq(projects.status,"active"))));
    if(prior) {
      const detail=await this.get(context,prior.id);
      if(detail.version.document.layers.some(l=>l.id==="catalog_artwork" || l.id.startsWith("print_"))) return detail;
      await this.erase(context,prior.id,"deleted");
    }
    if(input.template.project.source || input.template.project.workSource || input.template.project.catalogSource) throw new ConflictException("工艺底稿必须是独立通用模板");
    const document:ProductionEditorDocument={...structuredClone(input.template.version.document),name:input.name,layers:[],confirmations:{...input.template.version.document.confirmations,visualReview:false}};
    const created=await this.create(context,{name:input.name,document});
    try {
      await this.inTenant(context,tx=>tx.update(projects).set({sourceSalesSkuId:input.skuId,sourceSalesRecipeId:input.recipeId}).where(eq(projects.id,created.project.id)));
      if (input.printArtworks) {
        for (const print of input.printArtworks) {
          const part = await this.upload(context, created.project.id, print.name, print.bytes) as ProductionEditorImageView;
          document.layers.push(printCompositionLayer(document, print.binding, part, print.name));
        }
      } else {
        const image=await this.upload(context,created.project.id,input.artwork.name,input.artwork.bytes) as ProductionEditorImageView;
        const width=document.productType==="tire_cover"?document.spec.diameterMm:document.spec.widthMm;
        const height=document.productType==="tire_cover"?document.spec.diameterMm:document.spec.heightMm;
        const scale=Math.min(width/image.width,height/image.height);
        document.layers=[{id:"catalog_artwork",kind:"image",name:input.artwork.name,assetId:image.id,assetVersion:1,widthMm:image.width*scale,heightMm:image.height*scale,xMm:(width-image.width*scale)/2,yMm:(height-image.height*scale)/2,rotationDeg:0,opacity:1,visible:true,locked:false,flipX:false,flipY:false}];
      }
      return await this.save(context,created.project.id,{expectedVersionId:created.version.id,document});
    } catch(error) { await this.erase(context,created.project.id,"deleted"); throw error; }
  }

  async confirmSalesVersion(tx:TenantTransaction,context:TenantContext,recipeId:string,projectId:string,versionId:string) {
    authorize(context,Permission.DesignReview);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sales-recipe-edit:${recipeId}`},0))`);
    const [project]=await tx.select().from(projects).where(eq(projects.id,projectId)).for("update");
    if(!project?.encryptedDataKey || project.status!=="active" || project.sourceSalesRecipeId!==recipeId || project.currentVersionId!==versionId || project.reviewedVersionId!==versionId) throw new ConflictException("请先在制作编辑器核对并审核当前版本");
    await assertCatalogEditorSource(tx, context, project, { operation: "review" });
  }

  private async assertWorkEditable(context: TenantContext, project: Project, transaction?: TenantTransaction) {
    if (project.sourceSalesRecipeId) {
      const checkSales = async (tx: TenantTransaction) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sales-recipe-edit:${project.sourceSalesRecipeId}`},0))`);
        await assertCatalogEditorSource(tx, context, project, { operation: "edit" });
      };
      if (transaction) await checkSales(transaction); else await this.inTenant(context,checkSales);
    }
    if (!project.sourceWorkItemId) return;
    const check = async (tx: TenantTransaction) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`order-work:${project.sourceWorkItemId}`}, 0))`);
      const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, project.sourceWorkItemId!));
      if (!work?.encryptedDataKey || work.expiresAt <= new Date() || work.held || work.pushedRevisionId !== project.sourceWorkRevisionId || !["starting", "in_progress", "changes_requested"].includes(work.artwork)) throw new ConflictException("该任务已提交审核、撤回或暂停，请先在制图中心处理变更");
      const [agent] = await tx.select({status:orderDesignAgentRuns.status}).from(orderDesignAgentRuns)
        .where(and(eq(orderDesignAgentRuns.workItemId,work.id),eq(orderDesignAgentRuns.workRevisionId,work.pushedRevisionId!))).limit(1);
      if(agent && ["queued","running","needs_attention"].includes(agent.status))throw new ConflictException("请先在无人设计进度中停止自动制作并接管，再修改稿件或素材");
    };
    if (transaction) await check(transaction); else await this.inTenant(context, check);
  }

  private async project(context: TenantContext, id: string): Promise<Project> {
    authorize(context, Permission.DesignRead);
    const [project] = await this.inTenant(context, (tx) => tx.select().from(projects).where(eq(projects.id, id)));
    if (!project || project.status !== "active" || !project.encryptedDataKey) throw new NotFoundException("生产项目不存在或资料已清理");
    if (project.expiresAt && project.expiresAt <= new Date()) { await this.erase(context, id, "expired"); throw new NotFoundException("订单生产资料已到保存期限"); }
    if (project.sourceWorkItemId) {
      authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
      const [source] = await this.inTenant(context, (tx) => tx.select({ work: orderWorkItems, address: orders.addressStatus }).from(orderWorkItems)
        .innerJoin(orderLines, eq(orderLines.id, orderWorkItems.id)).innerJoin(orders, eq(orders.id, orderLines.orderId)).where(eq(orderWorkItems.id, project.sourceWorkItemId!)));
      if (!source?.work.encryptedDataKey || source.address === "anonymized" || source.work.expiresAt <= new Date()) { await this.erase(context, id, "expired"); throw new NotFoundException("订单资料已清理"); }
    }
    if (project.sourceReportLineId) {
      const source = await this.reports.detail(context, project.sourceReportLineId);
      if (source.line.state === "expired") { await this.erase(context, id, "expired"); throw new NotFoundException("订单生产资料已清理"); }
      if (!source.line.reviewed || source.versionId !== project.sourceReportVersionId) throw new ConflictException("来源定制版本已变更或待核对，请重新创建关联项目");
    }
    if(project.sourceSalesRecipeId || project.sourceSalesSkuId) {
      const source = await this.inTenant(context, tx => assertCatalogEditorSource(tx, context, project, { operation: "read" }));
      return {...project,salesRecipeApproved:source?.recipe.status==="approved",catalogActive:source?.lifecycle.active===true};
    }
    return project;
  }
  private async erase(context: TenantContext, id: string, status: "expired" | "deleted") { await this.inTenant(context, (tx) => tx.update(projects).set({ encryptedDataKey: null, name: "", status, updatedAt: new Date() }).where(eq(projects.id, id))); }
  private key(project: Project) { if (!project.encryptedDataKey) throw new NotFoundException("项目资料已清理"); return this.vault.withSecret(project.encryptedDataKey, (value) => Buffer.from(value, "base64")); }
  private domain(project: Project): AssetDomain { return project.sourceReportLineId || project.sourceWorkItemId ? "order" : "authorized"; }
  private async asset(context: TenantContext, projectId: string, imageId: string): Promise<Image> {
    const [row] = await this.inTenant(context, (tx) => tx.select().from(images).where(and(eq(images.projectId, projectId), eq(images.id, imageId))));
    if (!row) throw new NotFoundException("项目素材不存在"); return row;
  }
  private async readBlob(context: TenantContext, project: Project, objectKey: string) {
    const domain = this.domain(project), bytes = await this.storage.readPrivate(context, { id: project.id, tenantId: context.tenantId, assetDomain: domain, objectKey }, { requiredDomain: domain });
    return decryptProductionBytes(this.key(project), bytes);
  }
  private async document(context: TenantContext, project: Project, id: string) {
    const [row] = await this.inTenant(context, (tx) => tx.select().from(versions).where(and(eq(versions.projectId, project.id), eq(versions.id, id))));
    if (!row) throw new NotFoundException("生产版本不存在"); return ProductionEditorDocumentSchema.parse(openJson(this.key(project), row.encryptedDocument));
  }
  private async checkAssets(context: TenantContext, project: Project, document: ProductionEditorDocument) {
    for (const layer of document.layers) {
      const id = layer.kind === "image" ? layer.assetId : layer.fontId;
      if (layer.kind === "text" && id === "geist_regular") continue;
      if (layer.kind === "image" && layer.assetVersion !== 1) throw new ConflictException("素材版本无效");
      const row = await this.asset(context, project.id, id), metadata = openJson<AssetMetadata>(this.key(project), row.encryptedMetadata);
      if (metadata.kind !== (layer.kind === "image" ? "image" : "font")) throw new UnprocessableEntityException("素材种类不匹配");
    }
  }
  private resolvers(context: TenantContext, project: Project) {
    return { resolveAsset: async (id: string, version: number) => { if (version !== 1) throw new Error("asset_version_invalid"); const row = await this.asset(context, project.id, id); if (openJson<AssetMetadata>(this.key(project), row.encryptedMetadata).kind !== "image") throw new Error("asset_type_invalid"); return { bytes: await this.readBlob(context, project, row.originalObjectKey) }; }, resolveFont: async (id: string) => { if (id === "geist_regular") return getBuiltinFont(id); const row = await this.asset(context, project.id, id); if (openJson<AssetMetadata>(this.key(project), row.encryptedMetadata).kind !== "font") throw new Error("font_type_invalid"); return { bytes: await this.readBlob(context, project, row.originalObjectKey) }; } };
  }
  private projectView(row: Project, document: ProductionEditorDocument): ProductionEditorProjectView { return { id: row.id, name: document.name, productType: document.productType, currentVersionId: row.currentVersionId!, versionNumber: row.versionNumber, source: row.sourceReportLineId ? { reportLineId: row.sourceReportLineId, reportVersionId: row.sourceReportVersionId! } : null, workSource: row.sourceWorkItemId ? { workItemId: row.sourceWorkItemId, revisionId: row.sourceWorkRevisionId! } : null, catalogSource: row.sourceSalesRecipeId ? { skuId: row.sourceSalesSkuId!, recipeId: row.sourceSalesRecipeId, locked: !!row.salesRecipeApproved, active: row.catalogActive === true } : null, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
  private imageView(row: Image, metadata: AssetMetadata): ProductionEditorImageView { return { id: row.id, version: 1, name: metadata.name, mediaType: metadata.mediaType, width: metadata.width, height: metadata.height, hasAlpha: metadata.hasAlpha, actualAlpha: metadata.actualAlpha, checksumSha256: row.checksum, byteSize: row.byteSize, previewPath: `/v1/production-editor/projects/${row.projectId}/images/${row.id}?kind=preview`, originalPath: `/v1/production-editor/projects/${row.projectId}/images/${row.id}?kind=original` }; }
  private builtinFont(id: string): ProductionEditorFontView { return { id: "geist_regular", name: "Geist Regular", builtin: true, originalPath: `/v1/production-editor/projects/${id}/fonts/geist_regular` }; }
  private fontView(row: Image, metadata: AssetMetadata): ProductionEditorFontView { return { id: row.id, name: metadata.name, builtin: false, originalPath: `/v1/production-editor/projects/${row.projectId}/fonts/${row.id}` }; }
  private renderView(row: typeof renders.$inferSelect, key: Uint8Array): ProductionEditorRenderView { const manifest = row.encryptedManifest ? openJson<Manifest>(key, row.encryptedManifest) : null; return { id: row.id, versionId: row.versionId, purpose: openJson<ProductionEditorExportOptions | ProductionImageEditOptions>(key, row.encryptedOptions).purpose, status: row.status as ProductionEditorRenderView["status"], errorCode: row.errorCode, createdAt: row.createdAt.toISOString(), files: manifest?.files.map(({ key, name, mediaType, byteSize }) => ({ key, name, mediaType, byteSize })) ?? [], preflight: manifest?.preflight ?? null }; }
}

function sha(bytes: string | Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function sealJson(key: Uint8Array, value: unknown) { return encryptProductionBytes(key, Buffer.from(JSON.stringify(value))).toString("base64"); }
function openJson<T>(key: Uint8Array, value: string): T { return JSON.parse(decryptProductionBytes(key, Buffer.from(value, "base64")).toString("utf8")) as T; }
function options(input: ProductionEditorExportOptions): ProductionEditorExportOptions { return { format: input.format, background: input.background, purpose: input.purpose, ...(input.previewFullResolution !== undefined ? { previewFullResolution: input.previewFullResolution } : {}) }; }
