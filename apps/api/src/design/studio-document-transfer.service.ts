import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { CreativeConflictError } from "@yummyai/catalog-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioTransferReceiptSchema, StudioTransferRequestSchema,
  type StudioTransferLookup, type StudioTransferPage, type StudioTransferRequest } from "@yummyai/contracts/pod/studio-document-transfer";
import { assetFiles, creativeStudioEntries, creativeStudioRevisions, creativeStudioTransfers, withTenant,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { currentCreativeWorkspaceAuthority, requireReferenceAuthority } from "./canvas-workflow-access.js";
import { buildStudioDocumentPlan, type TransferEntry } from "./studio-document-manifest.js";
import { lockStudioScopes } from "./studio-document-scope.js";

type Asset = typeof assetFiles.$inferSelect;
type Transfer = typeof creativeStudioTransfers.$inferSelect;
type Manifest = { source: TransferEntry[]; target: TransferEntry[]; assets: Asset[] };
const changed = () => new ConflictException({ code: "studio_transfer_changed", message: "来源或目标已变化 请保留原请求并重新预览" });
const invalid = () => new BadRequestException({ code: "studio_transfer_invalid", message: "创作资料结构或引用不完整 请核对原工作区" });
const absent = () => new NotFoundException({ code: "studio_transfer_missing", message: "尚未找到原复制准备记录 请先核对结果" });
const cancelled = () => new ConflictException({ code: "studio_transfer_cancelled", message: "本次准备已取消 原请求不能再执行" });
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Original Studio owner: the only writer of a complete document copy and receipt. */
@Injectable()
export class StudioDocumentTransferService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage, @Inject(AuditService) private readonly audit: AuditService) {}

  private async lock(tx: TenantTransaction, context: TenantContext, request: StudioTransferRequest) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`studio-transfer:${context.tenantId}:${context.userId}:${request.requestId}`}, 0))`);
    await lockStudioScopes(tx, context, [request.scope, request.targetScope]);
  }

  private async access(tx: TenantTransaction, context: TenantContext, scope: string, targetScope: string, write: boolean) {
    if (scope === targetScope) throw invalid();
    await currentCreativeWorkspaceAuthority(tx, context, scope);
    return currentCreativeWorkspaceAuthority(tx, context, targetScope, write ? [Permission.DesignWrite] : []);
  }

  private async assets(tx: TenantTransaction, context: TenantContext, ids: string[], scope: string, targetScope: string) {
    const source = await currentCreativeWorkspaceAuthority(tx, context, scope);
    const target = await currentCreativeWorkspaceAuthority(tx, context, targetScope);
    const rows = ids.length ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, ids),
      eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt))).orderBy(asc(assetFiles.id)).for("share") : [];
    if (rows.length !== ids.length) throw invalid();
    for (const row of rows) {
      const kind = (row.rightsMetadata.source as { kind?: string } | undefined)?.kind;
      if (!["owned", "licensed", "ai_generated"].includes(kind ?? "")) throw invalid();
    }
    try {
      requireReferenceAuthority(source.authority, rows, source.checkedAt);
      requireReferenceAuthority(target.authority, rows, target.checkedAt);
    } catch (error) { if (error instanceof CreativeConflictError) throw changed(); throw error; }
    return rows;
  }

  private plan(manifest: Manifest, request: Pick<StudioTransferRequest, "scope" | "targetScope" | "requestId">) {
    try { return buildStudioDocumentPlan(manifest.source, manifest.target,
      { sourceScope: request.scope, targetScope: request.targetScope, requestId: request.requestId }); }
    catch { throw invalid(); }
  }

  private async snapshot(tx: TenantTransaction, context: TenantContext, scope: string, targetScope: string) {
    await lockStudioScopes(tx, context, [scope, targetScope]);
    const { checkedAt } = await this.access(tx, context, scope, targetScope, true);
    const read = async (address: string) => {
      const entries = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId),
        eq(creativeStudioEntries.scope, address))).orderBy(asc(creativeStudioEntries.namespace), asc(creativeStudioEntries.key)).limit(10_001).for("share");
      if (entries.length > 10_000) throw invalid();
      return entries.map(({ id, namespace, key, revision, value, assetId, deletedAt }) => ({ id, namespace, key, revision, value, assetId, deletedAt }));
    };
    const source = await read(scope), target = await read(targetScope);
    const ids = [...new Set([...source, ...target].flatMap(row => row.assetId && !row.deletedAt ? [row.assetId] : []))].sort();
    const assets = await this.assets(tx, context, ids, scope, targetScope);
    const manifest: Manifest = { source, target, assets };
    // Interactive metadata copying is bounded. There is never a truncated plan.
    if (Buffer.byteLength(canonical(manifest)) > 32 * 1024 * 1024) throw invalid();
    return { manifest, checkedAt, manifestHash: hash({ version: 1, scope, targetScope, ...manifest }) };
  }

  private async find(tx: TenantTransaction, context: TenantContext, request: StudioTransferRequest) {
    const [row] = await tx.select().from(creativeStudioTransfers).where(and(eq(creativeStudioTransfers.ownerId, context.userId),
      eq(creativeStudioTransfers.requestId, request.requestId))).for("update");
    if (row && canonical(row.request) !== canonical(request)) throw changed();
    return row;
  }

  private async originalResult(tx: TenantTransaction, context: TenantContext, request: StudioTransferRequest, row?: Transfer): Promise<StudioTransferLookup> {
    await this.access(tx, context, request.scope, request.targetScope, false);
    if (!row) return { status: "missing", request, receipt: null };
    if (row.cancelledAt) return { status: "cancelled", request, receipt: null };
    const manifest = row.manifest as Manifest;
    if (!Array.isArray(manifest.assets)) throw invalid();
    const current = await this.assets(tx, context, manifest.assets.map(asset => asset.id), request.scope, request.targetScope);
    for (const original of manifest.assets) {
      const asset = current.find(value => value.id === original.id);
      // Current rights are checked separately. Later approval does not erase an
      // old copy, but an original object's byte identity cannot silently change.
      if (!asset || ["version", "objectKey", "checksumSha256", "byteSize", "mediaType"].some(key =>
        asset[key as keyof Asset] !== original[key as keyof Asset])) throw changed();
    }
    return row.receipt ? { status: "committed", request, receipt: StudioTransferReceiptSchema.parse(row.receipt) }
      : { status: "prepared", request, receipt: null };
  }

  async preview(context: TenantContext, input: { scope: string; targetScope: string }) {
    return withTenant(this.database.db, context, async tx => {
      const { manifest, manifestHash } = await this.snapshot(tx, context, input.scope, input.targetScope);
      const plan = this.plan(manifest, { ...input, requestId: "00000000-0000-4000-8000-000000000000" });
      if (!plan.writes.length) throw invalid();
      return { version: 1 as const, sourceScope: input.scope, targetScope: input.targetScope, manifestHash, counts: plan.counts, excluded: plan.excluded };
    });
  }

  /** Rebuild the original request index after a tab closes or a new login.
   * This is a bounded read of owned records, never a task submission or HEAD. */
  async requests(context: TenantContext, input: { scope: string; cursor?: string; limit?: number }): Promise<StudioTransferPage> {
    const limit = input.limit ?? 25;
    return withTenant(this.database.db, context, async tx => {
      await currentCreativeWorkspaceAuthority(tx, context, input.scope);
      const rows = await tx.select().from(creativeStudioTransfers).where(and(eq(creativeStudioTransfers.ownerId, context.userId),
        eq(creativeStudioTransfers.scope, input.scope), input.cursor ? lt(creativeStudioTransfers.id, input.cursor) : undefined))
        .orderBy(desc(creativeStudioTransfers.id)).limit(limit + 1);
      const page = rows.slice(0, limit), items: StudioTransferLookup[] = [];
      let unavailableOnPage = 0;
      for (const row of page) {
        try { items.push(await this.originalResult(tx, context, StudioTransferRequestSchema.parse(row.request), row)); }
        catch (error) {
          if (!(error instanceof ForbiddenError || error instanceof NotFoundException || error instanceof ConflictException || error instanceof BadRequestException)) throw error;
          // Only the number of this member's unavailable page entries is shown.
          // No target ID, document value, filename or receipt escapes this gate.
          unavailableOnPage++;
        }
      }
      return { items, nextCursor: rows.length > limit ? page.at(-1)!.id : null, unavailableOnPage };
    });
  }

  async prepare(context: TenantContext, raw: unknown): Promise<StudioTransferLookup> {
    const request = StudioTransferRequestSchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      await this.lock(tx, context, request);
      const existing = await this.find(tx, context, request);
      if (existing) return this.originalResult(tx, context, request, existing);
      const { manifest, manifestHash } = await this.snapshot(tx, context, request.scope, request.targetScope);
      if (manifestHash !== request.manifestHash) throw changed();
      const plan = this.plan(manifest, request);
      if (!plan.writes.length) throw invalid();
      const id = createEntityId();
      await tx.insert(creativeStudioTransfers).values({ id, tenantId: context.tenantId, ownerId: context.userId,
        requestId: request.requestId, scope: request.scope, targetScope: request.targetScope, manifestHash, request, manifest: { ...manifest, plan } });
      await this.audit.recordInTransaction(tx, context, { action: "studio.document.prepare", resourceType: "studio_transfer", resourceId: id,
        result: "success", metadata: { requestId: request.requestId, manifestHash } });
      return { status: "prepared", request, receipt: null };
    });
  }

  async lookup(context: TenantContext, raw: unknown): Promise<StudioTransferLookup> {
    const request = StudioTransferRequestSchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      await this.lock(tx, context, request);
      return this.originalResult(tx, context, request, await this.find(tx, context, request));
    });
  }

  async cancel(context: TenantContext, raw: unknown): Promise<StudioTransferLookup> {
    const request = StudioTransferRequestSchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      await this.lock(tx, context, request);
      const row = await this.find(tx, context, request);
      if (!row) throw absent();
      const { checkedAt } = await this.access(tx, context, request.scope, request.targetScope, false);
      if (row.receipt || row.cancelledAt) return this.originalResult(tx, context, request, row);
      await tx.update(creativeStudioTransfers).set({ cancelledAt: new Date(checkedAt) }).where(eq(creativeStudioTransfers.id, row.id));
      await this.audit.recordInTransaction(tx, context, { action: "studio.document.cancel", resourceType: "studio_transfer", resourceId: row.id,
        result: "success", metadata: { requestId: request.requestId, manifestHash: request.manifestHash } });
      return { status: "cancelled", request, receipt: null };
    });
  }

  async commit(context: TenantContext, raw: unknown): Promise<StudioTransferLookup> {
    const request = StudioTransferRequestSchema.parse(raw);
    const preflight = await withTenant(this.database.db, context, async tx => {
      await this.lock(tx, context, request);
      const row = await this.find(tx, context, request);
      if (!row) throw absent();
      if (row.cancelledAt) throw cancelled();
      if (row.receipt) return { result: await this.originalResult(tx, context, request, row) };
      const snapshot = await this.snapshot(tx, context, request.scope, request.targetScope);
      if (snapshot.manifestHash !== request.manifestHash) throw changed();
      return { snapshot };
    });
    if (preflight.result) return preflight.result;
    const original = preflight.snapshot!;
    try {
      for (let offset = 0; offset < original.manifest.assets.length; offset += 4) {
        const results = await Promise.allSettled(original.manifest.assets.slice(offset, offset + 4).map(async asset => {
          const object = await this.storage.inspectPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
          if (object.byteSize !== asset.byteSize || object.mediaType !== asset.mediaType || object.checksumSha256 !== asset.checksumSha256
            || object.tenantId !== context.tenantId || object.assetDomain !== "authorized") throw invalid();
        }));
        if (results.some(result => result.status === "rejected"))
          throw new UnprocessableEntityException({ code: "studio_transfer_unavailable", message: "原件对象暂时无法核对 复制尚未执行" });
      }
    } finally {
      await withTenant(this.database.db, context, async tx => {
        await this.lock(tx, context, request);
        const current = await this.snapshot(tx, context, request.scope, request.targetScope);
        // A concurrent identical commit changes the target. Resolve its original
        // receipt below rather than mistaking that successful copy for a retry.
        const row = await this.find(tx, context, request);
        if (row?.cancelledAt) throw cancelled();
        if (!row?.receipt && current.manifestHash !== request.manifestHash) throw changed();
      });
    }
    return withTenant(this.database.db, context, async tx => {
      await this.lock(tx, context, request);
      const row = await this.find(tx, context, request);
      if (!row) throw absent();
      if (row.cancelledAt) throw cancelled();
      if (row.receipt) return this.originalResult(tx, context, request, row);
      const { manifest, manifestHash, checkedAt } = await this.snapshot(tx, context, request.scope, request.targetScope);
      if (manifestHash !== request.manifestHash) throw changed();
      const plan = this.plan(manifest, request), entries = [];
      for (const write of plan.writes) {
        const id = write.targetEntryId ?? createEntityId(), revision = write.targetRevision + 1;
        const values = { value: write.value, assetId: write.assetId, revision, deletedAt: null, updatedAt: new Date(checkedAt) };
        if (write.targetEntryId) {
          const updated = await tx.update(creativeStudioEntries).set(values).where(and(eq(creativeStudioEntries.id, id),
            eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, request.targetScope),
            eq(creativeStudioEntries.revision, write.targetRevision))).returning({ id: creativeStudioEntries.id });
          if (updated.length !== 1) throw changed();
        } else await tx.insert(creativeStudioEntries).values({ id, tenantId: context.tenantId, ownerId: context.userId,
          scope: request.targetScope, namespace: write.namespace, key: write.key, ...values });
        await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId,
          entryId: id, revision, value: write.value, assetId: write.assetId });
        entries.push({ sourceEntryIds: write.sourceEntryIds, targetEntryId: id, revision, namespace: write.namespace, key: write.key });
      }
      const copiedAt = new Date(checkedAt).toISOString();
      const receipt = StudioTransferReceiptSchema.parse({ id: row.id, sourceScope: request.scope, targetScope: request.targetScope,
        requestId: request.requestId, manifestHash, copiedAt, counts: plan.counts, entries });
      await tx.update(creativeStudioTransfers).set({ receipt, committedAt: new Date(copiedAt) }).where(eq(creativeStudioTransfers.id, row.id));
      await this.audit.recordInTransaction(tx, context, { action: "studio.document.commit", resourceType: "studio_transfer", resourceId: row.id,
        result: "success", metadata: { requestId: request.requestId, manifestHash, counts: plan.counts } });
      return { status: "committed", request, receipt };
    });
  }
}
