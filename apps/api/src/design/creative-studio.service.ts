import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { authorize, Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, RightsSourceSchema, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { assertStudioDocument, StudioRpcSchema, type StudioRpc } from "@yummyai/contracts/pod/creative-studio";
import { STUDIO_ORIGINAL_MEDIA_LIMIT, STUDIO_RESULT_INTENT_PREFIX, studioResultIntentKey,
  type StudioOriginalInspection, type StudioPinnedResultRequest, type StudioResultIntent, type StudioTechnicalInfo } from "@yummyai/contracts/pod/studio-original";
import { assetFiles, creativeStudioEntries, creativeStudioRevisions, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type { Storage, PutPrivateResult } from "@yummyai/storage";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { inspectPillowSuperResolutionRuntime } from "@yummyai/order-design";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { ProductionEditorScanner } from "./production-editor.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";
import { creativeOwnerFilter, currentCreativeWorkspaceAuthority, requireReferenceAuthority } from "./canvas-workflow-access.js";
import { inspectStudioOriginalBytes } from "./studio-media-inspection.js";
import { StudioDocumentTransferService } from "./studio-document-transfer.service.js";
import { StudioVideoDirectoryService } from "./studio-video-directory.service.js";
import { lockStudioScopes } from "./studio-document-scope.js";
import { assertSameStudioAsset, assertStudioAssetPin, assertStudioIntentTransition, normalizeStudioPinnedRequest, parseStudioIntent,
  sameStudioAsset, sameStudioReceipt, sameStudioRequest, storedStudioValue, studioCanvasInput, studioOriginalPin,
  type StudioAssetRow, type StudioEntryRow } from "./studio-media-inspection-owner.js";

type Address = { scope: string; namespace: string; key: string };
function assertStudioPaidExecutionAllowed(input: StudioRpc) {
  if (input.operation === "generate")
    throw new ConflictException({ code: "studio_paid_execution_paused", message: "当前已暂停付费创作生成 请核对后再启用" });
}
@Injectable()
export class CreativeStudioService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(ProductionEditorScanner) private readonly scanner: ProductionEditorScanner,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StudioGenerationService) private readonly generations: StudioGenerationService,
    @Inject(StudioDocumentTransferService) private readonly transfers: StudioDocumentTransferService = new StudioDocumentTransferService(database, storage, audit),
    @Inject(StudioVideoDirectoryService) private readonly videoDirectory: StudioVideoDirectoryService = new StudioVideoDirectoryService(database),
  ) {}

  async invoke(context: TenantContext, raw: unknown): Promise<unknown> {
    const parsed = StudioRpcSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("创作请求格式无效");
    const input = parsed.data;
    assertStudioPaidExecutionAllowed(input);
    const { authority } = await withTenant(this.database.db, context, tx => this.authority(tx, context, input.scope,
      input.operation === "generate" ? [Permission.DesignWrite, Permission.AssetWrite] : []));
    switch (input.operation) {
      case "video.directory": return this.videoDirectory.directory(context, input.scope);
      case "video.preflight": return this.videoDirectory.preflight(context, input.scope, input.snapshotHash);
      case "document.preview": return this.transfers.preview(context, input);
      case "document.requests": return this.transfers.requests(context, input);
      case "document.prepare": case "document.commit": case "document.lookup": case "document.cancel": {
        const { operation, ...request } = input;
        if (operation === "document.prepare") return this.transfers.prepare(context, request);
        if (operation === "document.commit") return this.transfers.commit(context, request);
        if (operation === "document.cancel") return this.transfers.cancel(context, request);
        return this.transfers.lookup(context, request);
      }
      case "state.get": return this.get(context, input);
      case "state.keys": return withTenant(this.database.db, context, async tx => {
        const { authority: current } = await this.authority(tx, context, input.scope);
        return (await tx.select({ key: creativeStudioEntries.key }).from(creativeStudioEntries)
          .leftJoin(assetFiles, eq(assetFiles.id, creativeStudioEntries.assetId))
          .where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, input.scope),
            eq(creativeStudioEntries.namespace, input.namespace), isNull(creativeStudioEntries.deletedAt),
            or(isNull(creativeStudioEntries.assetId), and(eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt), creativeOwnerFilter(current, Permission.AssetRead, assetFiles.ownerUserId))))))
          .map(row => row.key);
      });
      case "state.set": case "state.remove": return this.save(context, input);
      case "models": return this.generations.models(authority);
      case "pillow-runtime": return inspectPillowSuperResolutionRuntime();
      case "generate": return this.generations.create(authority, input.scope, input.input);
      case "generation.get": return this.generations.get(authority, input.scope, input.id);
      case "generations": return this.generations.list(authority, input.scope);
      case "assets": return this.assets(context, input.scope);
      case "asset.preview": return this.preview(context, input);
      case "asset.inspect": return this.inspect(context, input);
      case "reference.attach": return this.attach(context, input.scope, input.assetId);
      case "asset.review": return this.review(context, input);
      case "result.submit": return this.submit(context, input);
      case "result.submit.pinned": return this.submitPinned(context, input);
      case "result.lookup": return this.lookupResult(context, normalizeStudioPinnedRequest(input));
    }
  }

  private async authority(tx: TenantTransaction, context: TenantContext, scope: string, extra: readonly PermissionValue[] = []) {
    return currentCreativeWorkspaceAuthority(tx, context, scope, extra);
  }
  private address(context: TenantContext, input: Address) {
    return and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, input.scope), eq(creativeStudioEntries.namespace, input.namespace), eq(creativeStudioEntries.key, input.key));
  }
  private async asset(tx: TenantTransaction, authority: TenantContext, id: string, checkedAt: number, lock: "share" | "update" = "share") {
    const [asset] = await tx.select().from(assetFiles).where(and(eq(assetFiles.id, id), eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt))).for(lock);
    const source = asset?.rightsMetadata.source as { kind?: string } | undefined;
    if (!asset || !["owned", "licensed", "ai_generated"].includes(source?.kind ?? "")) throw new NotFoundException("素材不存在");
    requireReferenceAuthority(authority, [asset], checkedAt);
    return asset;
  }
  private readEntry(context: TenantContext, input: Address) {
    return withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await this.authority(tx, context, input.scope);
      const [row] = await tx.select().from(creativeStudioEntries).where(this.address(context, input)).for("share");
      const asset = row?.assetId && !row.deletedAt ? await this.asset(tx, authority, row.assetId, checkedAt) : undefined;
      if (row && !row.deletedAt && input.namespace === "app_state" && input.key.startsWith(STUDIO_RESULT_INTENT_PREFIX)) {
        const intent = parseStudioIntent(storedStudioValue(row.value), input.scope, input.key);
        await this.pinnedSource(tx, context, intent.request, false);
      }
      return { row, asset };
    });
  }
  private async verifyRead(context: TenantContext, input: Address, original: Awaited<ReturnType<CreativeStudioService["readEntry"]>>) {
    const current = await this.readEntry(context, input);
    if (!current.row || current.row.deletedAt || current.row.id !== original.row?.id || current.row.revision !== original.row?.revision || current.row.assetId !== original.row.assetId ||
      current.asset?.id !== original.asset?.id || Boolean(current.asset && original.asset && !sameStudioAsset(current.asset, original.asset)))
      throw new ConflictException("创作记录或素材已变化 请重新读取");
  }
  private async get(context: TenantContext, input: Address) {
    const original = await this.readEntry(context, input), { row, asset } = original;
    if (!row || row.deletedAt) return { revision: row?.revision ?? 0, value: null };
    if (!asset) {
      const stored = row.value as { studioDocument?: boolean; data?: unknown } | null;
      return { revision: row.revision, value: stored?.studioDocument === true ? stored.data : row.value };
    }
    let bytes: Uint8Array;
    try { bytes = await this.originalBytes(context, asset); }
    finally { await this.verifyRead(context, input, original); }
    return { revision: row.revision, media: { contentBase64: Buffer.from(bytes).toString("base64"), mediaType: asset.mediaType }, assetId: asset.id };
  }

  private async save(context: TenantContext, input: Extract<StudioRpc, { operation: "state.set" | "state.remove" }>) {
    const mediaNamespace = ["image_files", "media_files"].includes(input.namespace);
    const intentKey = input.key.startsWith(STUDIO_RESULT_INTENT_PREFIX);
    if (intentKey && (input.namespace !== "app_state" || input.operation === "state.set" && input.media)) throw new BadRequestException("送审意图只能存入原项目状态");
    if (input.operation === "state.set" && mediaNamespace !== !!input.media) throw new BadRequestException("文件与文档存储类型不匹配");
    if (input.operation === "state.set" && !input.media) {
      try { assertStudioDocument(input.value); } catch { throw new BadRequestException("创作记录格式不受支持，或包含凭据"); }
      if (input.namespace === "app_state" && !intentKey && !["infinite-canvas:canvas_store", "infinite-canvas:asset_store", "studio:prompts", "infinite-canvas:image_draft", "infinite-canvas:video_draft"].includes(input.key)) throw new BadRequestException("此配置不属于创作记录");
    }
    const extra = [Permission.DesignWrite, ...(input.operation === "state.set" && input.media ? [Permission.AssetWrite] : [])];
    const preflight = () => withTenant(this.database.db, context, async tx => {
      const current = await this.authority(tx, context, input.scope, extra);
      const [row] = await tx.select().from(creativeStudioEntries).where(this.address(context, input)).for("share");
      if ((row?.revision ?? 0) !== input.revision) throw new ConflictException("另一页面已保存此项目。请保留当前内容，重新打开后再编辑。");
      if (intentKey) await this.validateIntentChange(tx, context, input, row);
      if (row?.assetId && !row.deletedAt) await this.asset(tx, current.authority, row.assetId, current.checkedAt);
      return current;
    });
    await preflight();
    let upload: { bytes: Buffer; mediaType: string; checksum: string; assetId: string; fileName: string; stored?: PutPrivateResult } | undefined;
    if (input.operation === "state.set" && input.media) {
      const bytes = Buffer.from(input.media.contentBase64, "base64"), mediaType = input.media.mediaType;
      if (bytes.toString("base64") !== input.media.contentBase64) throw new BadRequestException("素材编码无效");
      if (bytes.byteLength > CANVAS_BRIDGE.maxImageBytes) throw new BadRequestException("单个素材不能超过 20 MiB");
      if (input.namespace === "image_files" && !mediaType.startsWith("image/")) throw new BadRequestException("图片类型不匹配");
      let technical: StudioTechnicalInfo;
      try { technical = await this.checkedMedia(bytes, mediaType); }
      finally { await preflight(); }
      this.requireCheckedMedia(technical);
      const checksum = createHash("sha256").update(bytes).digest("hex"), assetId = createEntityId(), fileName = `studio-${assetId}.${extension(mediaType)}`;
      const existing = await withTenant(this.database.db, context, async tx => {
        const { authority, checkedAt } = await this.authority(tx, context, input.scope, extra);
        const row = await this.reusableAsset(tx, context, checksum);
        if (row) {
          requireReferenceAuthority(authority, [row], checkedAt);
          if (row.mediaType !== mediaType || row.byteSize !== bytes.length) throw new ConflictException("原素材媒体记录不一致 请核对原文件");
        }
        return row;
      });
      const stored = existing ? undefined : await this.storage.putPrivate(context, { body: bytes, domain: "authorized", fileName, mediaType });
      upload = { bytes, mediaType, checksum, assetId, fileName, stored };
    }
    const result = await withTenant(this.database.db, context, async tx => {
      await lockStudioScopes(tx, context, [input.scope]);
      const { authority, checkedAt } = await this.authority(tx, context, input.scope, extra);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:${input.scope}:${input.namespace}:${input.key}`}, 0))`);
      const [current] = await tx.select().from(creativeStudioEntries).where(this.address(context, input)).for("update");
      if ((current?.revision ?? 0) !== input.revision) throw new ConflictException("另一页面已保存此项目。请保留当前内容，重新打开后再编辑。");
      if (intentKey) await this.validateIntentChange(tx, context, input, current);
      if (current?.assetId && !current.deletedAt) await this.asset(tx, authority, current.assetId, checkedAt);
      let assetId: string | null = null;
      if (upload) {
        const existing = await this.reusableAsset(tx, context, upload.checksum);
        if (existing) {
          requireReferenceAuthority(authority, [existing], checkedAt);
          if (existing.mediaType !== upload.mediaType || existing.byteSize !== upload.bytes.length) throw new ConflictException("原素材媒体记录不一致 请核对原文件");
          assetId = existing.id;
        }
        else {
          if (!upload.stored) throw new ConflictException("素材已变化 请保留文件并重新保存");
          assetId = upload.assetId;
          await tx.insert(assetFiles).values({ id: assetId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: upload.stored.objectKey, fileName: upload.fileName, mediaType: upload.mediaType, assetDomain: "authorized", byteSize: upload.bytes.length, checksumSha256: upload.checksum, rightsStatus: "unverified", rightsMetadata: { source: { kind: "owned" }, studioScope: input.scope } });
        }
      }
      const revision = input.revision + 1, id = current?.id ?? createEntityId();
      // Preserve the editor's exact JSON storage type through the driver.
      const value = input.operation === "state.set" && !upload ? { studioDocument: true, data: input.value } : null;
      const update = { revision, value, assetId, updatedAt: new Date(checkedAt), deletedAt: input.operation === "state.remove" ? new Date(checkedAt) : null };
      if (current) await tx.update(creativeStudioEntries).set(update).where(eq(creativeStudioEntries.id, id));
      else await tx.insert(creativeStudioEntries).values({ id, tenantId: context.tenantId, ownerId: context.userId, scope: input.scope, namespace: input.namespace, key: input.key, ...update });
      await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId, entryId: id, revision, value, assetId });
      return { revision, assetId };
    });
    await withTenant(this.database.db, context, tx => this.authority(tx, context, input.scope, extra));
    return result;
  }
  private async reusableAsset(tx: TenantTransaction, context: TenantContext, checksum: string) {
    // Immutable-byte deduplication never transfers ownership or adopts rejected rights.
    const [asset] = await tx.select().from(assetFiles).where(and(eq(assetFiles.ownerUserId, context.userId),
      eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.checksumSha256, checksum), isNull(assetFiles.deletedAt),
      sql`${assetFiles.rightsStatus} <> 'rejected' and ${assetFiles.rightsMetadata}->'source'->>'kind' in ('owned','ai_generated')`)).limit(1).for("share");
    return asset;
  }

  private async preview(context: TenantContext, input: Address) {
    const original = await this.readEntry(context, input), { asset } = original;
    if (!asset) throw new NotFoundException("素材不存在");
    if (!asset.mediaType.startsWith("image/")) throw new BadRequestException("此素材不支持图片预览");
    let thumbnail: Buffer;
    try {
      const bytes = await this.originalBytes(context, asset);
      thumbnail = await sharp(bytes, { limitInputPixels: 64_000_000 }).timeout({ seconds: 3 }).rotate().resize(320, 240, { fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    } finally { await this.verifyRead(context, input, original); }
    return { contentBase64: thumbnail.toString("base64"), mediaType: "image/webp" };
  }
  private async originalBytes(context: TenantContext, asset: StudioAssetRow): Promise<Uint8Array> {
    if (asset.byteSize > STUDIO_ORIGINAL_MEDIA_LIMIT) throw new BadRequestException("单个素材不能超过 20 MiB");
    const bytes = await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized", maxBytes: STUDIO_ORIGINAL_MEDIA_LIMIT, signal: AbortSignal.timeout(5_000) });
    if (bytes.byteLength !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.checksumSha256) throw new ConflictException("素材校验失败");
    return bytes;
  }
  private async checkedMedia(bytes: Uint8Array, mediaType: string): Promise<StudioTechnicalInfo> {
    try {
      if ((await this.scanner.scan(bytes, "studio-original", mediaType)).result !== "clean") return { status: "failed", code: "scan_failed" };
    } catch { return { status: "failed", code: "scan_failed" }; }
    return inspectStudioOriginalBytes(bytes, mediaType);
  }
  private requireCheckedMedia(technical: StudioTechnicalInfo) {
    if (technical.status !== "verified") throw new UnprocessableEntityException({ code: `studio_original_${technical.code}`, message: "素材原件检查未通过 请保留文件并核对" });
  }
  private async inspect(context: TenantContext, input: Extract<StudioRpc, { operation: "asset.inspect" }>): Promise<StudioOriginalInspection> {
    const original = await this.readEntry(context, input), { row, asset } = original;
    if (!row || row.deletedAt || !asset) throw new NotFoundException("素材不存在");
    let technical: StudioTechnicalInfo;
    try { technical = await this.checkedMedia(await this.originalBytes(context, asset), asset.mediaType); }
    catch (error) {
      technical = error instanceof ConflictException ? { status: "failed", code: "integrity_mismatch" }
        : error instanceof BadRequestException ? { status: "failed", code: "size_limit" } : { status: "unknown", code: "unreadable" };
    }
    // Failure diagnostics are private results too. A revoke during I/O must not
    // reveal the original source pin, dimensions, MIME or even its check status.
    await this.verifyRead(context, input, original);
    return { source: studioOriginalPin(row, asset), technical };
  }
  private async attach(context: TenantContext, scope: string, assetId: string) {
    const read = () => withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await this.authority(tx, context, scope, [Permission.DesignWrite]);
      const asset = await this.asset(tx, authority, assetId, checkedAt);
      if (asset.rightsStatus !== "approved" || !asset.mediaType.startsWith("image/")) throw new BadRequestException("只能添加已审核的授权参考图");
      return asset;
    });
    const original = await read();
    let technical: StudioTechnicalInfo;
    try { technical = await this.checkedMedia(await this.originalBytes(context, original), original.mediaType); }
    finally {
      assertSameStudioAsset(await read(), original);
    }
    this.requireCheckedMedia(technical);
    if (technical.status !== "verified" || technical.kind !== "image") throw new BadRequestException("参考素材必须是完整静态图片");
    return withTenant(this.database.db, context, async tx => {
      await lockStudioScopes(tx, context, [scope]);
      const { authority, checkedAt } = await this.authority(tx, context, scope, [Permission.DesignWrite]);
      const asset = await this.asset(tx, authority, assetId, checkedAt);
      if (!sameStudioAsset(asset, original) || asset.rightsStatus !== "approved") throw new ConflictException("原参考素材已变化 请重新核对");
      const key = `image:asset-${assetId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:${scope}:image_files:${key}`}, 0))`);
      const [current] = await tx.select().from(creativeStudioEntries).where(this.address(context, { scope, namespace: "image_files", key })).for("update");
      if (current && !current.deletedAt) {
        if (current.assetId !== assetId) throw new ConflictException("参考素材关联已变化 请重新核对");
        return { key };
      }
      const id = current?.id ?? createEntityId(), revision = (current?.revision ?? 0) + 1;
      if (current) await tx.update(creativeStudioEntries).set({ assetId, revision, value: null, deletedAt: null, updatedAt: new Date(checkedAt) }).where(eq(creativeStudioEntries.id, id));
      else await tx.insert(creativeStudioEntries).values({ id, tenantId: context.tenantId, ownerId: context.userId, scope, namespace: "image_files", key, assetId, revision });
      await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId, entryId: id, revision, assetId });
      return { key };
    });
  }
  private async entry(tx: TenantTransaction, context: TenantContext, scope: string, key: string) {
    const rows = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.key, key), isNull(creativeStudioEntries.deletedAt))).limit(2).for("share");
    if (rows.length > 1) throw new ConflictException("素材键对应多个记录 请重新选择素材");
    if (!rows[0]?.assetId) throw new NotFoundException("素材不存在");
    return rows[0];
  }
  private async assets(context: TenantContext, scope: string) {
    return withTenant(this.database.db, context, async tx => {
      const { authority } = await this.authority(tx, context, scope);
      return tx.select({ key: creativeStudioEntries.key, namespace: creativeStudioEntries.namespace, assetId: assetFiles.id, fileName: assetFiles.fileName, mediaType: assetFiles.mediaType, rightsStatus: assetFiles.rightsStatus, aiGenerated: assetFiles.aiGenerated }).from(creativeStudioEntries).innerJoin(assetFiles, eq(assetFiles.id, creativeStudioEntries.assetId)).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope), eq(assetFiles.assetDomain, "authorized"), isNull(creativeStudioEntries.deletedAt), isNull(assetFiles.deletedAt), creativeOwnerFilter(authority, Permission.AssetRead, assetFiles.ownerUserId), sql`${assetFiles.rightsMetadata}->'source'->>'kind' in ('owned','licensed','ai_generated')`)).limit(500);
    });
  }
  private async review(context: TenantContext, input: Extract<StudioRpc, { operation: "asset.review" }>) {
    await withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await this.authority(tx, context, input.scope, [Permission.DesignReview]);
      const row = await this.entry(tx, context, input.scope, input.key);
      const asset = await this.asset(tx, authority, row.assetId!, checkedAt, "update");
      authorize(authority, Permission.DesignReview, { ownerId: asset.ownerUserId });
      if (asset.rightsStatus !== "unverified") throw new ConflictException("素材已审核，请刷新状态");
      if (asset.aiGenerated && input.scope !== "unassigned" && asset.mediaType.startsWith("image/")) throw new ConflictException("生成方案请在创意项目中审核");
      const source = RightsSourceSchema.safeParse({ ...(asset.rightsMetadata.source as object), reference: input.sourceReference });
      if (!source.success) throw new BadRequestException("素材来源依据无效");
      const date = new Date(checkedAt).toISOString();
      const changed = await tx.update(assetFiles).set({ rightsStatus: input.decision === "approve" ? "approved" : "rejected",
        rightsMetadata: { ...asset.rightsMetadata, reviewedBy: context.userId, reviewedAt: date, source: source.data,
          ...(input.decision === "approve" ? { approvedAt: date, approvedBy: context.userId } : {}) },
      }).where(and(eq(assetFiles.id, asset.id), eq(assetFiles.rightsStatus, "unverified"))).returning({ id: assetFiles.id });
      if (!changed.length) throw new ConflictException("素材审核状态已变化");
      await this.audit.recordInTransaction(tx, context, { action: "studio.asset.review", resourceType: "asset", resourceId: asset.id, result: "success", metadata: { decision: input.decision } });
    });
    return { ok: true };
  }
  private async pinnedSource(tx: TenantTransaction, context: TenantContext, request: StudioPinnedResultRequest, current: boolean) {
    const { authority, checkedAt } = await this.authority(tx, context, request.scope);
    const source = request.source;
    const [entry] = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.id, source.entryId),
      eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, request.scope),
      eq(creativeStudioEntries.namespace, source.namespace), eq(creativeStudioEntries.key, request.key))).for("share");
    if (!entry) throw new NotFoundException("原素材所属记录不存在");
    if (current) {
      if (entry.deletedAt || entry.revision !== source.revision || entry.assetId !== source.assetId) throw new ConflictException("原素材记录已变化 请重新核对");
    } else {
      // Immutable history proves this source belonged to this person and scope.
      // A later replacement of the current editor key does not erase a receipt.
      const [revision] = await tx.select({ id: creativeStudioRevisions.id }).from(creativeStudioRevisions).where(and(
        eq(creativeStudioRevisions.entryId, source.entryId), eq(creativeStudioRevisions.revision, source.revision), eq(creativeStudioRevisions.assetId, source.assetId)));
      if (!revision) throw new NotFoundException("原素材历史版本不存在");
    }
    const asset = await this.asset(tx, authority, source.assetId, checkedAt);
    assertStudioAssetPin(asset, source);
    return { entry, asset };
  }
  private async checkedIntentReceipt(tx: TenantTransaction, context: TenantContext, intent: Extract<StudioResultIntent, { status: "confirmed" }>) {
    const found = await this.bridge.lookupStudioResultInTransaction(tx, context, intent.request);
    if (found.status !== "found" || !sameStudioReceipt(found.receipt, intent.receipt)) throw new ConflictException("送审回执尚未由原项目确证");
  }
  private async validateIntentChange(tx: TenantTransaction, context: TenantContext,
    input: Extract<StudioRpc, { operation: "state.set" | "state.remove" }>, current: StudioEntryRow | undefined) {
    const previous = current && !current.deletedAt ? parseStudioIntent(storedStudioValue(current.value), input.scope, input.key) : undefined;
    const next = input.operation === "state.set" ? parseStudioIntent(input.value, input.scope, input.key) : undefined;
    assertStudioIntentTransition(previous, next);
    if (previous?.status === "confirmed") await this.checkedIntentReceipt(tx, context, previous);
    if (next) {
      await this.pinnedSource(tx, context, next.request, !previous || !sameStudioRequest(previous.request, next.request));
      if (next.status === "confirmed") await this.checkedIntentReceipt(tx, context, next);
    }
  }
  private async requireIntent(tx: TenantTransaction, context: TenantContext, request: StudioPinnedResultRequest) {
    const key = studioResultIntentKey(request.source);
    const [entry] = await tx.select().from(creativeStudioEntries).where(this.address(context, { scope: request.scope, namespace: "app_state", key })).for("share");
    if (!entry || entry.deletedAt || entry.assetId) throw new ConflictException("请先保存并确证本次原送审请求");
    const intent = parseStudioIntent(storedStudioValue(entry.value), request.scope, key);
    if (!sameStudioRequest(intent.request, request)) throw new ConflictException("已保存的送审请求不同 请核对原请求");
    return intent;
  }
  private async lookupResult(context: TenantContext, request: StudioPinnedResultRequest) {
    const read = () => withTenant(this.database.db, context, tx => this.pinnedSource(tx, context, request, false));
    const original = await read();
    const result = await this.bridge.lookupStudioResult(context, request);
    if (!sameStudioAsset((await read()).asset, original.asset)) throw new ConflictException("原素材已变化 请重新核对");
    return result;
  }
  private async submitPinned(context: TenantContext, request: StudioPinnedResultRequest) {
    const verify = async (tx: TenantTransaction) => {
      await this.authority(tx, context, request.scope, [Permission.DesignWrite, Permission.AssetWrite]);
      const source = await this.pinnedSource(tx, context, request, true);
      await this.requireIntent(tx, context, request);
      return source;
    };
    const original = await withTenant(this.database.db, context, verify);
    if (!["image/png", "image/jpeg", "image/webp"].includes(original.asset.mediaType)) throw new BadRequestException("项目方案送审只接受完整静态图片 视频和音频继续保留在素材中");
    let bytes: Uint8Array;
    try { bytes = await this.originalBytes(context, original.asset); }
    finally {
      const current = await withTenant(this.database.db, context, verify);
      assertSameStudioAsset(original.asset, current.asset);
    }
    return this.bridge.submit(context, request.scope, studioCanvasInput(request, Buffer.from(bytes).toString("base64")), original.asset.id,
      { request, verify: async tx => { const current = await verify(tx); if (!sameStudioAsset(current.asset, original.asset)) throw new ConflictException("待审素材已变化 请重新核对"); } });
  }
  private async submit(context: TenantContext, input: Extract<StudioRpc, { operation: "result.submit" }>) {
    if (input.scope === "unassigned") throw new BadRequestException("请先选择创意项目");
    const read = () => withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await this.authority(tx, context, input.scope, [Permission.DesignWrite, Permission.AssetWrite]);
      const entry = await this.entry(tx, context, input.scope, input.key);
      return { entry, asset: await this.asset(tx, authority, entry.assetId!, checkedAt) };
    });
    const original = await read(), { asset } = original;
    if (!asset.mediaType.startsWith("image/")) throw new BadRequestException("生产方案审核目前只接收图片；视频保留在项目素材中");
    let bytes: Uint8Array;
    try { bytes = await this.originalBytes(context, asset); }
    finally { await read(); }
    const current = await read();
    if (current.entry.revision !== original.entry.revision || current.asset.id !== asset.id || current.asset.version !== asset.version || current.asset.objectKey !== asset.objectKey)
      throw new ConflictException("待审素材已变化 请重新选择");
    const source = asset.rightsMetadata.source as { kind: "owned" | "licensed" | "ai_generated" };
    return this.bridge.submit(context, input.scope, { submissionId: input.submissionId, title: input.title, sourceNodeId: input.key, protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, contentBase64: Buffer.from(bytes).toString("base64"), rightsAttested: true, sourceKind: source.kind, sourceReference: input.sourceReference }, asset.id);
  }
}

export function extension(type: string) { return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav" })[type] ?? "bin"; }
export async function inspectStudioMedia(bytes: Buffer, mediaType: string) {
  const technical = await inspectStudioOriginalBytes(bytes, mediaType);
  if (technical.status !== "verified") throw new BadRequestException("素材原件无法按声明的完整媒体格式读取");
  return technical;
}
