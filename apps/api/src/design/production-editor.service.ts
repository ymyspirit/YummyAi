import { createHash, randomBytes } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException, ServiceUnavailableException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import {
  createEntityId, CreateProductionEditorProjectInputSchema, SaveProductionEditorVersionInputSchema,
  CreateProductionEditorRenderInputSchema, ProductionEditorDocumentSchema,
  type TenantContext, type ProductionEditorDocument, type ProductionEditorDetailView,
  type ProductionEditorProjectView, type ProductionEditorImageView, type ProductionEditorFontView,
  type ProductionEditorRenderView, type ProductionEditorPreflight, type ProductionEditorExportOptions,
  type RecordCustomizationFileScanInput,
} from "@yummyai/contracts";
import {
  productionEditorProjects as projects, productionEditorVersions as versions, productionEditorImages as images,
  productionEditorRenders as renders, amazonOrderReportLines, withTenant, type DatabaseConnection,
} from "@yummyai/database";
import { decryptProductionBytes, encryptProductionBytes, getBuiltinFont, inspectProductionFont, preflightProductionDocument } from "@yummyai/production-editor";
import { ClamAvScanner, type Storage, type AssetDomain } from "@yummyai/storage";
import { and, desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { ApplyProductionCutoutInputSchema, SegmentProductionImageInputSchema, RefineProductionImageInputSchema, type ProductionCutoutRecipe } from "@yummyai/contracts/pod/production-cutout";
import { renderProductionCutout, prepareProductionMatting } from "@yummyai/production-editor";
import { localSegmentationAvailable, runLocalSegmentation } from "./local-image-segmentation.js";
import { localMattingAvailable, runLocalMatting } from "./local-image-matting.js";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT, PRIVATE_STORAGE } from "../platform.tokens.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";

export const PRODUCTION_IMAGE_LIMIT = 64 * 1024 * 1024;
type Project = typeof projects.$inferSelect;
type Image = typeof images.$inferSelect;
type CutoutMetadata = { sourceAssetId: string; recipe: ProductionCutoutRecipe };
type AssetMetadata = { kind: "image" | "font"; name: string; mediaType: string; width: number; height: number; hasAlpha: boolean; actualAlpha: boolean; scan: RecordCustomizationFileScanInput; cutout?: CutoutMetadata };
type Manifest = { files: Array<{ key: string; name: string; mediaType: string; byteSize: number; objectKey: string }>; preflight: ProductionEditorPreflight };
export abstract class ProductionEditorRenderEnqueuer { abstract enqueue(input: { renderId: string; tenantId: string; requestedBy: string; maxAttempts: number }): Promise<void>; }
export abstract class ProductionEditorScanner { abstract scan(bytes: Uint8Array, name: string, mediaType: string): Promise<RecordCustomizationFileScanInput>; }
@Injectable()
export class ClamAvProductionEditorScanner extends ProductionEditorScanner {
  private readonly scanner = new ClamAvScanner();
  scan(body: Uint8Array, fileName: string, mediaType: string) { return this.scanner.scan({ body, fileName, mediaType }); }
}

@Injectable()
export class ProductionEditorService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(AmazonOrderReportService) private readonly reports: AmazonOrderReportService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProductionEditorRenderEnqueuer) private readonly enqueuer: ProductionEditorRenderEnqueuer,
    @Inject(ProductionEditorScanner) private readonly scanner: ProductionEditorScanner,
  ) {}

  async list(context: TenantContext) {
    authorize(context, Permission.DesignRead);
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(projects).where(eq(projects.status, "active")).orderBy(desc(projects.updatedAt)).limit(100));
    const result: ProductionEditorProjectView[] = [];
    for (const row of rows) {
      if (row.sourceReportLineId && (!context.permissions.includes(Permission.OrderRead) || !context.permissions.includes(Permission.OrderPiiRead))) continue;
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
      const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, source.reportLineId)));
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
    await withTenant(this.database.db, context, async (tx) => {
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
    const data = await withTenant(this.database.db, context, async (tx) => ({
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
    await this.checkAssets(context, project, input.document);
    if (input.document.productType !== project.name) throw new ConflictException("项目产品类型不可更改");
    await withTenant(this.database.db, context, async (tx) => {
      const [locked] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!locked?.encryptedDataKey || locked.status !== "active" || locked.currentVersionId !== input.expectedVersionId) throw new ConflictException("项目版本已更新，请刷新后保存");
      const versionId = createEntityId();
      await tx.insert(versions).values({ id: versionId, tenantId: context.tenantId, projectId: id, versionNumber: locked.versionNumber + 1, encryptedDocument: sealJson(this.key(locked), input.document), checksum: sha(JSON.stringify(input.document)), createdBy: context.userId });
      await tx.update(projects).set({ currentVersionId: versionId, versionNumber: locked.versionNumber + 1, reviewedVersionId: null, reviewedBy: null, reviewedAt: null, updatedAt: new Date() }).where(eq(projects.id, id));
    });
    return this.get(context, id);
  }

  async review(context: TenantContext, id: string, expectedVersionId: string) {
    authorize(context, Permission.DesignReview);
    await this.project(context, id);
    await withTenant(this.database.db, context, async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!project?.encryptedDataKey || project.status !== "active" || project.currentVersionId !== expectedVersionId) throw new ConflictException("只能审核当前生产版本");
      await tx.update(projects).set({ reviewedVersionId: expectedVersionId, reviewedBy: context.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(projects.id, id));
      await this.audit.recordInTransaction(tx, context, { action: "production_editor.review", resourceType: "production_editor_version", resourceId: expectedVersionId, result: "success", metadata: { projectId: id } });
    });
    return this.get(context, id);
  }

  async upload(context: TenantContext, id: string, name: string, bytes: Uint8Array, kind: "image" | "font" = "image", cutout?: CutoutMetadata): Promise<ProductionEditorImageView | ProductionEditorFontView> {
    authorize(context, Permission.DesignWrite);
    const project = await this.project(context, id);
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
    const imageId = createEntityId(), key = this.key(project), domain = this.domain(project);
    const original = await this.storage.putPrivate(context, { body: encryptProductionBytes(key, bytes), domain, fileName: `${imageId}-source.pe`, mediaType: "application/octet-stream" });
    const thumbnail = kind === "font" ? original : await this.storage.putPrivate(context, { body: encryptProductionBytes(key, preview), domain, fileName: `${imageId}-preview.pe`, mediaType: "application/octet-stream" });
    await this.project(context, id);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.insert(images).values({ id: imageId, tenantId: context.tenantId, projectId: id, encryptedMetadata: sealJson(key, metadata), originalObjectKey: original.objectKey, previewObjectKey: thumbnail.objectKey, checksum: sha(bytes), byteSize: bytes.byteLength }).returning());
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
    return preflightProductionDocument(document, options(input), this.resolvers(context, project));
  }

  async render(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.DesignWrite);
    const input = CreateProductionEditorRenderInputSchema.parse(body), project = await this.project(context, id);
    const preflight = await this.preflight(context, id, input);
    if (input.purpose === "production" && (!preflight.productionReady || project.reviewedVersionId !== input.expectedVersionId)) throw new UnprocessableEntityException("正式出图需要当前版本人工审核及生产参数检查全部通过");
    const renderId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      const [locked] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!locked?.encryptedDataKey || locked.status !== "active" || locked.currentVersionId !== input.expectedVersionId || input.purpose === "production" && locked.reviewedVersionId !== input.expectedVersionId) throw new ConflictException("生产版本或审核状态已更新");
      await tx.insert(renders).values({ id: renderId, tenantId: context.tenantId, projectId: id, versionId: input.expectedVersionId, encryptedOptions: sealJson(this.key(locked), options(input)), requestedBy: context.userId });
    });
    try { await this.enqueuer.enqueue({ renderId, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: 3 }); }
    catch { await withTenant(this.database.db, context, (tx) => tx.update(renders).set({ status: "failed", errorCode: "queue_unavailable", updatedAt: new Date() }).where(eq(renders.id, renderId))); }
    return this.getRender(context, id, renderId);
  }

  async getRender(context: TenantContext, id: string, renderId: string): Promise<ProductionEditorRenderView> {
    const project = await this.project(context, id);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(renders).where(and(eq(renders.projectId, id), eq(renders.id, renderId))));
    if (!row) throw new NotFoundException("出图任务不存在");
    return this.renderView(row, this.key(project));
  }

  async renderFile(context: TenantContext, id: string, renderId: string, fileKey: string) {
    authorize(context, Permission.AssetRead);
    const project = await this.project(context, id);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(renders).where(and(eq(renders.projectId, id), eq(renders.id, renderId))));
    if (row?.status !== "completed" || !row.encryptedManifest) throw new NotFoundException("出图文件尚不可用");
    const manifest = openJson<Manifest>(this.key(project), row.encryptedManifest), file = manifest.files.find((file) => file.key === fileKey);
    if (!file) throw new NotFoundException("出图文件不存在");
    const body = await this.readBlob(context, project, file.objectKey);
    await this.project(context, id);
    return { body, name: file.name, mediaType: file.mediaType, inline: false };
  }

  async remove(context: TenantContext, id: string) { authorize(context, Permission.DesignWrite); await this.project(context, id); await this.erase(context, id, "deleted"); return { deleted: true }; }

  private async project(context: TenantContext, id: string): Promise<Project> {
    authorize(context, Permission.DesignRead);
    const [project] = await withTenant(this.database.db, context, (tx) => tx.select().from(projects).where(eq(projects.id, id)));
    if (!project || project.status !== "active" || !project.encryptedDataKey) throw new NotFoundException("生产项目不存在或资料已清理");
    if (project.expiresAt && project.expiresAt <= new Date()) { await this.erase(context, id, "expired"); throw new NotFoundException("订单生产资料已到保存期限"); }
    if (project.sourceReportLineId) {
      const source = await this.reports.detail(context, project.sourceReportLineId);
      if (source.line.state === "expired") { await this.erase(context, id, "expired"); throw new NotFoundException("订单生产资料已清理"); }
      if (!source.line.reviewed || source.versionId !== project.sourceReportVersionId) throw new ConflictException("来源定制版本已变更或待核对，请重新创建关联项目");
    }
    return project;
  }
  private async erase(context: TenantContext, id: string, status: "expired" | "deleted") { await withTenant(this.database.db, context, (tx) => tx.update(projects).set({ encryptedDataKey: null, name: "", status, updatedAt: new Date() }).where(eq(projects.id, id))); }
  private key(project: Project) { if (!project.encryptedDataKey) throw new NotFoundException("项目资料已清理"); return this.vault.withSecret(project.encryptedDataKey, (value) => Buffer.from(value, "base64")); }
  private domain(project: Project): AssetDomain { return project.sourceReportLineId ? "order" : "authorized"; }
  private async asset(context: TenantContext, projectId: string, imageId: string): Promise<Image> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(images).where(and(eq(images.projectId, projectId), eq(images.id, imageId))));
    if (!row) throw new NotFoundException("项目素材不存在"); return row;
  }
  private async readBlob(context: TenantContext, project: Project, objectKey: string) {
    const domain = this.domain(project), bytes = await this.storage.readPrivate(context, { id: project.id, tenantId: context.tenantId, assetDomain: domain, objectKey }, { requiredDomain: domain });
    return decryptProductionBytes(this.key(project), bytes);
  }
  private async document(context: TenantContext, project: Project, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(versions).where(and(eq(versions.projectId, project.id), eq(versions.id, id))));
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
  private projectView(row: Project, document: ProductionEditorDocument): ProductionEditorProjectView { return { id: row.id, name: document.name, productType: document.productType, currentVersionId: row.currentVersionId!, versionNumber: row.versionNumber, source: row.sourceReportLineId ? { reportLineId: row.sourceReportLineId, reportVersionId: row.sourceReportVersionId! } : null, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
  private imageView(row: Image, metadata: AssetMetadata): ProductionEditorImageView { return { id: row.id, version: 1, name: metadata.name, mediaType: metadata.mediaType, width: metadata.width, height: metadata.height, hasAlpha: metadata.hasAlpha, actualAlpha: metadata.actualAlpha, checksumSha256: row.checksum, byteSize: row.byteSize, previewPath: `/v1/production-editor/projects/${row.projectId}/images/${row.id}?kind=preview`, originalPath: `/v1/production-editor/projects/${row.projectId}/images/${row.id}?kind=original` }; }
  private builtinFont(id: string): ProductionEditorFontView { return { id: "geist_regular", name: "Geist Regular", builtin: true, originalPath: `/v1/production-editor/projects/${id}/fonts/geist_regular` }; }
  private fontView(row: Image, metadata: AssetMetadata): ProductionEditorFontView { return { id: row.id, name: metadata.name, builtin: false, originalPath: `/v1/production-editor/projects/${row.projectId}/fonts/${row.id}` }; }
  private renderView(row: typeof renders.$inferSelect, key: Uint8Array): ProductionEditorRenderView { const manifest = row.encryptedManifest ? openJson<Manifest>(key, row.encryptedManifest) : null; return { id: row.id, versionId: row.versionId, purpose: openJson<ProductionEditorExportOptions>(key, row.encryptedOptions).purpose, status: row.status as ProductionEditorRenderView["status"], errorCode: row.errorCode, createdAt: row.createdAt.toISOString(), files: manifest?.files.map(({ key, name, mediaType, byteSize }) => ({ key, name, mediaType, byteSize })) ?? [], preflight: manifest?.preflight ?? null }; }
}

function sha(bytes: string | Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function sealJson(key: Uint8Array, value: unknown) { return encryptProductionBytes(key, Buffer.from(JSON.stringify(value))).toString("base64"); }
function openJson<T>(key: Uint8Array, value: string): T { return JSON.parse(decryptProductionBytes(key, Buffer.from(value, "base64")).toString("utf8")) as T; }
function options(input: ProductionEditorExportOptions): ProductionEditorExportOptions { return { format: input.format, background: input.background, purpose: input.purpose }; }
