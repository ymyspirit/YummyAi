import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { assertStudioDocument, StudioRpcSchema, type StudioRpc } from "@yummyai/contracts/pod/creative-studio";
import { assetFiles, creativeStudioEntries, creativeStudioRevisions, withTenant, type DatabaseConnection } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, eq, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { ProductionEditorScanner } from "./production-editor.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";

type Address = { scope: string; namespace: string; key: string };
@Injectable()
export class CreativeStudioService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(ProductionEditorScanner) private readonly scanner: ProductionEditorScanner,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StudioGenerationService) private readonly generations: StudioGenerationService,
  ) {}

  async invoke(context: TenantContext, raw: unknown): Promise<unknown> {
    authorize(context, Permission.DesignRead); authorize(context, Permission.AssetRead);
    const parsed = StudioRpcSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("创作请求格式无效");
    const input = parsed.data;
    if (input.scope !== "unassigned") await this.bridge.get(context, input.scope);
    switch (input.operation) {
      case "state.get": return this.get(context, input);
      case "state.keys": return withTenant(this.database.db, context, async tx => (await tx.select({ key: creativeStudioEntries.key }).from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, input.scope), eq(creativeStudioEntries.namespace, input.namespace), isNull(creativeStudioEntries.deletedAt)))).map(row => row.key));
      case "state.set": case "state.remove": return this.save(context, input);
      case "models": return this.generations.models(context);
      case "generate": return this.generations.create(context, input.scope, input.input);
      case "generation.get": return this.generations.get(context, input.scope, input.id);
      case "generations": return this.generations.list(context, input.scope);
      case "assets": return this.assets(context, input.scope);
      case "asset.preview": return this.preview(context, input);
      case "reference.attach": return this.attach(context, input.scope, input.assetId);
      case "asset.review": return this.review(context, input);
      case "result.submit": return this.submit(context, input);
    }
  }

  private address(context: TenantContext, input: Address) {
    return and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, input.scope), eq(creativeStudioEntries.namespace, input.namespace), eq(creativeStudioEntries.key, input.key));
  }
  private async get(context: TenantContext, input: Address) {
    const [row] = await withTenant(this.database.db, context, tx => tx.select().from(creativeStudioEntries).where(this.address(context, input)));
    if (!row || row.deletedAt) return { revision: row?.revision ?? 0, value: null };
    if (!row.assetId) {
      const stored = row.value as { studioDocument?: boolean; data?: unknown } | null;
      return { revision: row.revision, value: stored?.studioDocument === true ? stored.data : row.value };
    }
    const asset = await this.asset(context, row.assetId);
    const bytes = await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    return { revision: row.revision, media: { contentBase64: Buffer.from(bytes).toString("base64"), mediaType: asset.mediaType }, assetId: asset.id };
  }

  private async save(context: TenantContext, input: Extract<StudioRpc, { operation: "state.set" | "state.remove" }>) {
    authorize(context, Permission.DesignWrite);
    const mediaNamespace = ["image_files", "media_files"].includes(input.namespace);
    if (input.operation === "state.set" && mediaNamespace !== !!input.media) throw new BadRequestException("文件与文档存储类型不匹配");
    if (input.operation === "state.set" && !input.media) {
      try { assertStudioDocument(input.value); } catch { throw new BadRequestException("创作记录格式不受支持，或包含凭据"); }
      if (input.namespace === "app_state" && !["infinite-canvas:canvas_store", "infinite-canvas:asset_store", "studio:prompts"].includes(input.key)) throw new BadRequestException("此配置不属于创作记录");
    }
    let upload: { bytes: Buffer; mediaType: string; checksum: string } | undefined;
    if (input.operation === "state.set" && input.media) {
      authorize(context, Permission.AssetWrite);
      const bytes = Buffer.from(input.media.contentBase64, "base64"), mediaType = input.media.mediaType;
      if (bytes.byteLength > CANVAS_BRIDGE.maxImageBytes) throw new BadRequestException("单个素材不能超过 20 MiB");
      if (input.namespace === "image_files" && !mediaType.startsWith("image/")) throw new BadRequestException("图片类型不匹配");
      await inspectStudioMedia(bytes, mediaType);
      const scan = await this.scanner.scan(bytes, "studio-upload", mediaType);
      if (scan.result !== "clean") throw new UnprocessableEntityException("素材未通过安全扫描");
      upload = { bytes, mediaType, checksum: createHash("sha256").update(bytes).digest("hex") };
    }
    const result = await withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:${input.scope}:${input.namespace}:${input.key}`}, 0))`);
      const [current] = await tx.select().from(creativeStudioEntries).where(this.address(context, input));
      if ((current?.revision ?? 0) !== input.revision) throw new ConflictException("另一页面已保存此项目。请保留当前内容，重新打开后再编辑。");
      let assetId: string | null = null;
      if (upload) {
        // Share immutable bytes within this member's workspace; never acquire another asset's rights through a hash match.
        const [existing] = await tx.select().from(assetFiles).where(and(eq(assetFiles.ownerUserId, context.userId), eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.checksumSha256, upload.checksum), isNull(assetFiles.deletedAt), sql`${assetFiles.rightsMetadata}->'source'->>'kind' in ('owned','ai_generated')`)).limit(1);
        if (existing) assetId = existing.id;
        else {
          assetId = createEntityId();
          const fileName = `studio-${assetId}.${extension(upload.mediaType)}`;
          const stored = await this.storage.putPrivate(context, { body: upload.bytes, domain: "authorized", fileName, mediaType: upload.mediaType });
          await tx.insert(assetFiles).values({ id: assetId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey, fileName, mediaType: upload.mediaType, assetDomain: "authorized", byteSize: upload.bytes.length, checksumSha256: upload.checksum, rightsStatus: "unverified", rightsMetadata: { source: { kind: "owned" }, studioScope: input.scope } });
        }
      }
      const revision = input.revision + 1, id = current?.id ?? createEntityId();
      // JSONB drivers may parse top-level string values a second time. An envelope preserves the editor's exact storage type.
      const value = input.operation === "state.set" && !upload ? { studioDocument: true, data: input.value } : null;
      const update = { revision, value, assetId, updatedAt: new Date(), deletedAt: input.operation === "state.remove" ? new Date() : null };
      if (current) await tx.update(creativeStudioEntries).set(update).where(eq(creativeStudioEntries.id, id));
      else await tx.insert(creativeStudioEntries).values({ id, tenantId: context.tenantId, ownerId: context.userId, scope: input.scope, namespace: input.namespace, key: input.key, ...update });
      await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId, entryId: id, revision, value, assetId });
      return { revision, assetId };
    });
    return result;
  }

  private async preview(context: TenantContext, input: Address) {
    const [row] = await withTenant(this.database.db, context, tx => tx.select({ assetId: creativeStudioEntries.assetId }).from(creativeStudioEntries).where(and(this.address(context, input), isNull(creativeStudioEntries.deletedAt))));
    if (!row?.assetId) throw new NotFoundException("素材不存在");
    const asset = await this.asset(context, row.assetId);
    if (!asset.mediaType.startsWith("image/")) throw new BadRequestException("此素材不支持图片预览");
    const bytes = await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    const thumbnail = await sharp(bytes, { limitInputPixels: 64_000_000 }).rotate().resize(320, 240, { fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    return { contentBase64: thumbnail.toString("base64"), mediaType: "image/webp" };
  }

  private async asset(context: TenantContext, id: string) {
    const [asset] = await withTenant(this.database.db, context, tx => tx.select().from(assetFiles).where(and(eq(assetFiles.id, id), eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt))));
    const source = asset?.rightsMetadata.source as { kind?: string } | undefined;
    if (!asset || !["owned", "licensed", "ai_generated"].includes(source?.kind ?? "")) throw new NotFoundException("素材不存在");
    return asset;
  }
  private async attach(context: TenantContext, scope: string, assetId: string) {
    authorize(context, Permission.DesignWrite);
    const asset = await this.asset(context, assetId);
    if (asset.rightsStatus !== "approved" || !asset.mediaType.startsWith("image/")) throw new BadRequestException("只能添加已审核的授权参考图");
    const key = `image:asset-${asset.id}`;
    return withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:${scope}:image_files:${key}`}, 0))`);
      const [current] = await tx.select().from(creativeStudioEntries).where(this.address(context, { scope, namespace: "image_files", key }));
      if (current && !current.deletedAt) return { key };
      const id = current?.id ?? createEntityId(), revision = (current?.revision ?? 0) + 1;
      if (current) await tx.update(creativeStudioEntries).set({ assetId, revision, value: null, deletedAt: null, updatedAt: new Date() }).where(eq(creativeStudioEntries.id, id));
      else await tx.insert(creativeStudioEntries).values({ id, tenantId: context.tenantId, ownerId: context.userId, scope, namespace: "image_files", key, assetId, revision });
      await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId, entryId: id, revision, assetId });
      return { key };
    });
  }
  private async entry(context: TenantContext, scope: string, key: string) {
    const [row] = await withTenant(this.database.db, context, tx => tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.key, key), isNull(creativeStudioEntries.deletedAt))).limit(1));
    if (!row?.assetId) throw new NotFoundException("素材不存在");
    return row;
  }
  private async assets(context: TenantContext, scope: string) {
    return withTenant(this.database.db, context, tx => tx.select({ key: creativeStudioEntries.key, namespace: creativeStudioEntries.namespace, assetId: assetFiles.id, fileName: assetFiles.fileName, mediaType: assetFiles.mediaType, rightsStatus: assetFiles.rightsStatus, aiGenerated: assetFiles.aiGenerated }).from(creativeStudioEntries).innerJoin(assetFiles, eq(assetFiles.id, creativeStudioEntries.assetId)).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope), eq(assetFiles.assetDomain, "authorized"), isNull(creativeStudioEntries.deletedAt), isNull(assetFiles.deletedAt))).limit(500));
  }
  private async review(context: TenantContext, input: Extract<StudioRpc, { operation: "asset.review" }>) {
    authorize(context, Permission.DesignReview);
    const row = await this.entry(context, input.scope, input.key), asset = await this.asset(context, row.assetId!);
    if (asset.rightsStatus !== "unverified") throw new ConflictException("素材已审核，请刷新状态");
    if (asset.aiGenerated && input.scope !== "unassigned" && asset.mediaType.startsWith("image/")) throw new ConflictException("生成方案请在创意项目中审核");
    await withTenant(this.database.db, context, async tx => {
      const changed = await tx.update(assetFiles).set({ rightsStatus: input.decision === "approve" ? "approved" : "rejected", rightsMetadata: { ...asset.rightsMetadata, reviewedBy: context.userId, reviewedAt: new Date().toISOString(), source: { kind: asset.aiGenerated ? "ai_generated" : "owned", reference: input.sourceReference } } }).where(and(eq(assetFiles.id, asset.id), eq(assetFiles.rightsStatus, "unverified"))).returning({ id: assetFiles.id });
      if (!changed.length) throw new ConflictException("素材审核状态已变化");
      await this.audit.recordInTransaction(tx, context, { action: "studio.asset.review", resourceType: "asset", resourceId: asset.id, result: "success", metadata: { decision: input.decision } });
    });
    return { ok: true };
  }
  private async submit(context: TenantContext, input: Extract<StudioRpc, { operation: "result.submit" }>) {
    if (input.scope === "unassigned") throw new BadRequestException("请先选择创意项目");
    const entry = await this.entry(context, input.scope, input.key), asset = await this.asset(context, entry.assetId!);
    if (!asset.mediaType.startsWith("image/")) throw new BadRequestException("生产方案审核目前只接收图片；视频保留在项目素材中");
    const bytes = await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    return this.bridge.submit(context, input.scope, { submissionId: input.submissionId, title: input.title, sourceNodeId: input.key, protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, contentBase64: Buffer.from(bytes).toString("base64"), rightsAttested: true, sourceKind: asset.aiGenerated ? "ai_generated" : "owned", sourceReference: input.sourceReference }, asset.id);
  }
}

export function extension(type: string) { return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav" })[type] ?? "bin"; }
export async function inspectStudioMedia(bytes: Buffer, mediaType: string) {
  if (mediaType.startsWith("image/")) {
    try { const image = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" }); const meta = await image.metadata(); if (`image/${meta.format}` !== mediaType || (meta.pages ?? 1) !== 1) throw new Error(); await image.stats(); }
    catch { throw new BadRequestException("素材必须是完整的静态 PNG、JPG 或 WebP"); }
  } else {
    const valid = mediaType === "video/mp4" ? bytes.subarray(4, 8).toString() === "ftyp" : mediaType === "video/webm" ? bytes.subarray(0, 4).toString("hex") === "1a45dfa3" : mediaType === "audio/wav" ? bytes.subarray(0, 4).toString() === "RIFF" : bytes.subarray(0, 3).toString() === "ID3" || bytes[0] === 255;
    if (!valid || bytes.length < 16) throw new BadRequestException("媒体文件与声明格式不匹配");
  }
}
