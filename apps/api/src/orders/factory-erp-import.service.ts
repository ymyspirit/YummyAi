import { FactoryErpSourceReadOwner } from "@yummyai/order-core";
import { originalOwnerOperation, rethrowOriginalOwnerError } from "../shared/original-owner-error.js";
import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  ApplyFactoryErpImportSchema, FACTORY_ERP_MAX_BYTES, FACTORY_ERP_TEMPLATE, FactoryErpApplyResultSchema,
  FactoryErpCandidatePageSchema, FactoryErpCandidatesQuerySchema, FactoryErpImportListQuerySchema, FactoryErpImportListSchema,
  FactoryErpImportViewSchema, FactoryErpPageQuerySchema, FactoryErpParsedSchema, UploadFactoryErpImportSchema,
  type FactoryErpOptions, type FactoryErpParsed, type FactoryErpApplyResult, type FactoryErpItemSelection, type ApplyFactoryErpImport,
  FactoryErpSourceLifecyclePageSchema, FactoryErpApplicationListQuerySchema, FactoryErpApplicationPageSchema,
} from "@yummyai/contracts/order/factory-erp-import";
import {
  ChangeFactoryErpBindingSchema, FactoryErpBindingChangeResultSchema, FactoryErpBindingChangePageQuerySchema, FactoryErpBindingChangePageSchema,
  FactoryErpBindingPageQuerySchema, FactoryErpBindingPageSchema, FactoryErpBindingViewSchema,
  type ChangeFactoryErpBinding, type FactoryErpBindingChangeResult,
} from "@yummyai/contracts/order/factory-erp-binding";
import { currentOrderAuthority } from "@yummyai/order-core";
import {
  ReviewFactoryErpVoidSchema, FactoryErpVoidReviewResultSchema, FactoryErpVoidObservationViewSchema, FactoryErpVoidBasisSchema,
  FactoryErpVoidObservationPageQuerySchema, FactoryErpVoidObservationPageSchema, FactoryErpVoidObservationDetailSchema,
  FactoryErpVoidReviewPageQuerySchema, FactoryErpVoidReviewPageSchema,
  type FactoryErpVoidObservationView, type ReviewFactoryErpVoid,
} from "@yummyai/contracts/order/factory-erp-void-review";
import {
  factoryErpImports as imports, factoryErpApplications as applications, factoryErpBindings as bindings,
  factoryErpBindingItems as bindingItems, factoryErpObservations as observations, factoryErpApplicationRows as applicationRows,
  fulfillmentFactories, fulfillmentSuppliers, productionDeliveryItems, productionDeliveryPackages, productionOrders, orders,
  factoryErpSourcePurges, factoryErpBindingChanges as bindingChanges, factoryErpVoidReviews as voidReviews,
  withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, lt, ilike, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { FactoryErpSourceGateway } from "./factory-erp-source.gateway.js";
import { FactoryErpExportParseError, parseFactoryErpExport } from "./factory-erp-export-parser.js";
import { assertFactoryErpProof, assertFactoryErpProofDigest, factoryErpSourceClaims, factoryErpExternalKey as externalKey, factoryErpRowChecksum, sealFactoryErpProof, type FactoryErpDigestProofSource } from "./factory-erp-evidence.js";
import { factoryErpVoidProofRowsSql, factoryErpVoidSummarySql } from "./factory-erp-void-read.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const FACTORY_ERP_READ = [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead] as const;
export const FACTORY_ERP_WRITE = [...FACTORY_ERP_READ, Permission.OrderWrite] as const;
type Import = typeof imports.$inferSelect;
type ItemSource = Awaited<ReturnType<OrderProductionDeliveryService["factoryErpItemsInTransaction"]>>[number];
type VoidReadRow = { value: unknown; sourceProof: FactoryErpDigestProofSource; sourceClaim: Import["sourceClaims"][number] | null; sourceClaimCount: number;
  bindingKey: string; bindingQuantity: number; bindingFactoryId: string };
type Payload = { tenantId: string; importId: string; fileName: string; options: FactoryErpOptions; parsed: FactoryErpParsed; scan: unknown };
const selections = (items: FactoryErpItemSelection[]) => [...items].sort((a, b) => a.deliveryItemId.localeCompare(b.deliveryItemId));
async function parseSource(fileName: string, bytes: Uint8Array, options: FactoryErpOptions) {
  try { return await parseFactoryErpExport(fileName, bytes, options); }
  catch (error) {
    if (error instanceof FactoryErpExportParseError) throw new UnprocessableEntityException({ code: error.code, rowNumber: error.rowNumber, message: "工厂导出格式未通过读取检查 请核对原表" });
    throw error;
  }
}

@Injectable()
export class FactoryErpImportService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(FactoryErpSourceGateway) private readonly source: FactoryErpSourceGateway,
    @Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  private async transaction<T>(context: TenantContext, write: boolean, use: (tx: TenantTransaction) => Promise<T>, snapshot = false): Promise<T> {
    return withTenant(this.database.db, context, async tx => {
      const permissions = write ? FACTORY_ERP_WRITE : FACTORY_ERP_READ;
      const current = await currentOrderAuthority(tx, context, permissions, { requireMembership: true, lock: true });
      for (const permission of permissions) if (permissionScope(current, permission) !== "tenant") throw new ForbiddenError(permission, "outside_data_scope");
      return use(tx);
    }, snapshot ? { isolationLevel: "repeatable read", accessMode: "read write" } : undefined);
  }
  private async authority(context: TenantContext, factoryId: string, write: boolean) {
    return this.transaction(context, write, async tx => {
      await this.factory(tx, factoryId);
      return currentOrderAuthority(tx, context, write ? FACTORY_ERP_WRITE : FACTORY_ERP_READ, { requireMembership: true });
    });
  }
  private async factory(tx: TenantTransaction, id: string, active = true, lock = true) {
    const query = tx.select({ factory: fulfillmentFactories }).from(fulfillmentFactories)
      .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, fulfillmentFactories.supplierId))
      .where(and(eq(fulfillmentFactories.id, id), active ? eq(fulfillmentFactories.status, "active") : undefined, active ? eq(fulfillmentSuppliers.status, "active") : undefined));
    const [row] = lock ? await query.for("share") : await query;
    if (!row) throw new NotFoundException("工厂不可用"); return row.factory;
  }
  private async lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`); }
  private async xid(tx: TenantTransaction) { return (await tx.execute<{ id: string }>(sql`select pg_current_xact_id()::text as id`))[0]!.id; }
  private async record(tx: TenantTransaction, id: string, privateSource = true, lockFactory = true) {
    const [row] = await tx.select().from(imports).where(and(eq(imports.id, id), privateSource ? sql`${imports.expiresAt}>factory_erp_source_now() and ${imports.encryptedPayload} is not null` : undefined));
    if (!row) throw new NotFoundException("导入记录不存在或私有资料已到期"); await this.factory(tx, row.factoryId, privateSource, lockFactory); return row;
  }
  private checkedItems(selected: FactoryErpItemSelection[], byId: Map<string, ItemSource>, factoryId: string, quantity: number) {
    const actual = selected.map(item => byId.get(item.deliveryItemId)!);
    if (actual.some((item, index) => !item || item.factoryId !== factoryId || canonicalJson(item.selection) !== canonicalJson(selected[index])))
      throw new ConflictException("工厂、原生产版本或文件已变化，请刷新核对");
    if (actual.reduce((sum, item) => sum + item.quantity, 0) !== quantity)
      throw new ConflictException("整组原生产数量与工厂商品总数不同，请人工核对");
    return actual;
  }
  private payload(row: Import): Payload {
    assertFactoryErpProof(this.vault, row);
    if (row.encryptedPayload === null) throw new NotFoundException("导入私有原文已到期清除");
    return this.vault.withSecret(row.encryptedPayload, value => {
      const payload = JSON.parse(value) as Payload;
      if (payload.tenantId !== row.tenantId || payload.importId !== row.id) throw new ConflictException("导入私有来源校验失败");
      payload.parsed = FactoryErpParsedSchema.parse(payload.parsed);
      if (this.previewChecksum(row.factoryId, row.fileChecksum, payload.options, payload.parsed) !== row.previewChecksum)
        throw new ConflictException("导入预览校验失败");
      return payload;
    });
  }
  private previewChecksum(factoryId: string, fileChecksum: string, options: FactoryErpOptions, parsed: FactoryErpParsed) {
    return sha(canonicalJson({ templateVersion: FACTORY_ERP_TEMPLATE, factoryId, fileChecksum, options, parsed }));
  }
  private async replayUpload(tx: TenantTransaction, key: string, checksum: string, actor: string) {
    const [row] = await tx.select().from(imports).where(eq(imports.idempotencyKey, key));
    if (row && (row.requestChecksum !== checksum || row.createdBy !== actor)) throw new ConflictException("原上传请求的文件、选项或操作员不能改变");
    return row?.id;
  }

  async upload(context: TenantContext, raw: unknown) {
    const input = UploadFactoryErpImportSchema.parse(raw), bytes = Buffer.from(input.contentBase64, "base64");
    try {
      if (!bytes.length || bytes.length > FACTORY_ERP_MAX_BYTES || bytes.toString("base64") !== input.contentBase64 || sha(bytes) !== input.checksumSha256)
        throw new UnprocessableEntityException("文件大小、编码或原字节校验失败");
      await this.authority(context, input.factoryId, true);
      const requestChecksum = sha(canonicalJson({ version: 1, factoryId: input.factoryId, fileName: input.fileName, checksum: input.checksumSha256, options: input.options }));
      const replay = await this.transaction(context, true, tx => this.replayUpload(tx, input.idempotencyKey, requestChecksum, context.userId));
      if (replay) return this.get(context, replay, {});
      const parsed = await parseSource(input.fileName, bytes, input.options);
      const id = createEntityId(), previewChecksum = this.previewChecksum(input.factoryId, input.checksumSha256, input.options, parsed);
      const sourceClaims = factoryErpSourceClaims(context.tenantId, input.factoryId, parsed), sourceProof = sealFactoryErpProof(this.vault, {
        id, tenantId: context.tenantId, factoryId: input.factoryId, fileChecksum: input.checksumSha256, previewChecksum, sourceClaims,
      });
      const receipt = await this.source.store(context, id, input.fileName, bytes, () => this.authority(context, input.factoryId, true));
      let savedId: string;
      try {
        savedId = await this.transaction(context, true, async tx => {
          await this.factory(tx, input.factoryId); await this.lock(tx, `factory-erp-upload:${context.tenantId}:${input.idempotencyKey}`);
          const existing = await this.replayUpload(tx, input.idempotencyKey, requestChecksum, context.userId); if (existing) return existing;
          await tx.insert(imports).values({ id, tenantId: context.tenantId, factoryId: input.factoryId, fileChecksum: input.checksumSha256, byteSize: bytes.length,
            objectKey: receipt.objectKey, storedChecksum: receipt.checksumSha256, previewChecksum, idempotencyKey: input.idempotencyKey, requestChecksum,
            sourceClaims, sourceProof,
            encryptedPayload: this.vault.encrypt(JSON.stringify({ tenantId: context.tenantId, importId: id, fileName: input.fileName, options: input.options, parsed, scan: receipt.scan } satisfies Payload)),
            createdBy: context.userId, creationTransactionId: await this.xid(tx), expiresAt: new Date(Date.now() + 30 * 86400000) });
          await this.audit.recordInTransaction(tx, context, { action: "factory_erp.import_uploaded", resourceType: "factory_erp_import", resourceId: id, result: "success",
            metadata: { rows: parsed.rows.length, format: parsed.format, checksum: input.checksumSha256 } }); return id;
        });
      } finally {
        // Recheck after a possibly lost commit response. An uncertain read must
        // retain the exact receipt, never delete an object a commit might own.
        const referenced = await withTenant(this.database.db, context, tx => tx.select({ id: imports.id }).from(imports).where(eq(imports.objectKey, receipt.objectKey)).limit(1));
        if (!referenced.length) await this.source.discard(context, id, receipt.objectKey);
      }
      return this.get(context, savedId, {});
    } finally { bytes.fill(0); }
  }

  async get(context: TenantContext, id: string, raw: unknown) {
    const query = FactoryErpPageQuerySchema.parse(raw);
    return this.transaction(context, false, async tx => {
      const row = await this.record(tx, id), payload = this.payload(row), rows = [];
      for (const original of payload.parsed.rows.slice(query.offset, query.offset + query.limit)) {
        const [tip] = await tx.select().from(bindings).where(and(eq(bindings.factoryId, row.factoryId), eq(bindings.externalKey, externalKey(context.tenantId, row.factoryId, original.externalId)))).orderBy(desc(bindings.revision)).limit(1);
        const binding = tip?.releasedBy === null ? tip : undefined;
        const links = binding ? await tx.select().from(bindingItems).where(and(eq(bindingItems.bindingId, binding.id), isNull(bindingItems.releasedBy))) : [];
        rows.push({ ...original, diagnostics: payload.parsed.diagnostics.filter(d => d.rowNumber === original.rowNumber),
          association: { activeBindingId: binding?.id ?? null, revision: tip?.revision ?? 0, releaseId: tip?.releasedBy ?? null },
          binding: binding ? { id: binding.id, items: links.map(i => ({ deliveryItemId: i.deliveryItemId, productionOrderId: i.productionOrderId, productionVersionId: i.productionVersionId, fileChecksum: i.fileChecksum, manufacturingChecksum: i.manufacturingChecksum })) } : null });
      }
      return FactoryErpImportViewSchema.parse({ id, factoryId: row.factoryId, fileName: payload.fileName, fileChecksum: row.fileChecksum, byteSize: row.byteSize,
        templateVersion: FACTORY_ERP_TEMPLATE, previewChecksum: row.previewChecksum, format: payload.parsed.format, options: payload.options,
        sheetName: payload.parsed.sheetName, headers: payload.parsed.headers, coverage: payload.parsed.coverage, rowCount: payload.parsed.rows.length,
        diagnostics: payload.parsed.diagnostics, rows, offset: query.offset, limit: query.limit, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() });
    });
  }
  async list(context: TenantContext, raw: unknown) {
    const input = FactoryErpImportListQuerySchema.parse(raw), cursor = input.cursor ? z.uuidv7().parse(input.cursor) : undefined;
    return this.transaction(context, false, async tx => {
      await this.factory(tx, input.factoryId);
      const records = await tx.select().from(imports).where(and(eq(imports.factoryId, input.factoryId), sql`${imports.expiresAt}>factory_erp_source_now() and ${imports.encryptedPayload} is not null`, cursor ? lt(imports.id, cursor) : undefined)).orderBy(desc(imports.id)).limit(input.limit + 1);
      const items = records.slice(0, input.limit).map(row => { const payload = this.payload(row); return { id: row.id, factoryId: row.factoryId, fileName: payload.fileName, fileChecksum: row.fileChecksum, byteSize: row.byteSize,
        templateVersion: FACTORY_ERP_TEMPLATE, previewChecksum: row.previewChecksum, format: payload.parsed.format, options: payload.options, sheetName: payload.parsed.sheetName,
        coverage: payload.parsed.coverage, rowCount: payload.parsed.rows.length, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() }; });
      return FactoryErpImportListSchema.parse({ items, nextCursor: records.length > input.limit ? records[input.limit - 1]!.id : null });
    });
  }
  private lifecycleView(row: Import, purge: typeof factoryErpSourcePurges.$inferSelect | null, lastApplicationId: string | null, checkedAt: Date) { try { return new FactoryErpSourceReadOwner(this.database, this.vault).lifecycleView(row, purge, lastApplicationId, checkedAt); } catch (error) { rethrowOriginalOwnerError(error); } }
  private async sourceNow(tx: TenantTransaction) { return originalOwnerOperation(() => new FactoryErpSourceReadOwner(this.database, this.vault).sourceNow(tx)); }
  async lifecycle(context: TenantContext, id: string) { return originalOwnerOperation(() => new FactoryErpSourceReadOwner(this.database, this.vault).lifecycle(context, id)); }
  async listLifecycle(context: TenantContext, raw: unknown) {
    const input = FactoryErpImportListQuerySchema.parse(raw), cursor = input.cursor ? z.uuidv7().parse(input.cursor) : undefined;
    return this.transaction(context, false, async tx => {
      await this.factory(tx, input.factoryId, false); const now = await this.sourceNow(tx);
      const rows = await tx.select({ source: imports, purge: factoryErpSourcePurges,
        applicationId: sql<string | null>`(select a.id from factory_erp_applications a where a.tenant_id=${imports.tenantId} and a.import_id=${imports.id} order by a.id desc limit 1)` })
        .from(imports).leftJoin(factoryErpSourcePurges, eq(factoryErpSourcePurges.importId, imports.id))
        .where(and(eq(imports.factoryId, input.factoryId), cursor ? lt(imports.id, cursor) : undefined)).orderBy(desc(imports.id)).limit(input.limit + 1);
      return FactoryErpSourceLifecyclePageSchema.parse({ items: rows.slice(0, input.limit).map(row => this.lifecycleView(row.source, row.purge, row.applicationId, now)),
        nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.source.id : null });
    });
  }
  async listApplications(context: TenantContext, id: string, raw: unknown) {
    const input = FactoryErpApplicationListQuerySchema.parse(raw);
    return this.transaction(context, false, async tx => {
      await this.record(tx, id, false);
      const rows = await tx.select({ id: applications.id, importId: applications.importId, createdAt: applications.createdAt,
        appliedRows: sql<number>`(${applications.result}->>'appliedRows')::integer` }).from(applications)
        .where(and(eq(applications.importId, id), input.cursor ? lt(applications.id, input.cursor) : undefined)).orderBy(desc(applications.id)).limit(input.limit + 1);
      return FactoryErpApplicationPageSchema.parse({ items: rows.slice(0, input.limit).map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null });
    });
  }
  async application(context: TenantContext, id: string, applicationId: string) {
    return this.transaction(context, false, async tx => {
      const source = await this.record(tx, id, false);
      const [row] = await tx.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.importId, id)));
      if (!row) throw new NotFoundException("原应用回执不存在");
      const result = FactoryErpApplyResultSchema.parse(row.result);
      if (result.id !== row.id || result.importId !== id || result.fileChecksum !== source.fileChecksum || result.previewChecksum !== source.previewChecksum ||
        result.requestChecksum !== row.requestChecksum || sha(row.requestCanonical) !== row.requestChecksum) throw new ConflictException("原应用回执校验失败");
      return result;
    });
  }
  async candidates(context: TenantContext, raw: unknown) {
    const input = FactoryErpCandidatesQuerySchema.parse(raw), cursor = input.cursor ? z.uuidv7().parse(input.cursor) : undefined;
    return this.transaction(context, false, async tx => {
      await this.factory(tx, input.factoryId);
      const records = await tx.select({ id: productionDeliveryItems.id }).from(productionDeliveryItems)
        .innerJoin(productionDeliveryPackages, eq(productionDeliveryPackages.id, productionDeliveryItems.packageId))
        .innerJoin(productionOrders, eq(productionOrders.id, productionDeliveryItems.productionOrderId))
        .innerJoin(orders, eq(orders.id, productionOrders.orderId))
        .where(and(eq(productionDeliveryPackages.factoryId, input.factoryId), cursor ? lt(productionDeliveryItems.id, cursor) : undefined,
          input.q ? ilike(orders.externalOrderId, `%${input.q.replace(/[\\%_]/g, "\\$&")}%`) : undefined))
        .orderBy(desc(productionDeliveryItems.id)).limit(input.limit + 1);
      const items = [];
      for (const record of records.slice(0, input.limit)) {
        try {
          const [candidate] = await this.delivery.factoryErpItemsInTransaction(tx, context, [record.id]);
          const [link] = await tx.select({ id: bindings.id }).from(bindingItems).innerJoin(bindings, eq(bindings.id, bindingItems.bindingId)).where(and(eq(bindingItems.deliveryItemId, record.id), isNull(bindingItems.releasedBy), isNull(bindings.releasedBy)));
          items.push({ ...candidate!.selection, packageId: candidate!.packageId, orderLineId: candidate!.snapshot.orderLineId, orderNumber: candidate!.snapshot.orderNumber,
            quantity: candidate!.quantity, submittedFeedbackId: candidate!.submittedFeedbackId, submittedAt: candidate!.submittedAt, bindingId: link?.id ?? null, externalId: null });
        } catch (error) { if (!(error instanceof ConflictException || error instanceof NotFoundException)) throw error; }
      }
      return FactoryErpCandidatePageSchema.parse({ items, nextCursor: records.length > input.limit ? records[input.limit - 1]!.id : null });
    });
  }

  async apply(context: TenantContext, id: string, raw: unknown) {
    const input = ApplyFactoryErpImportSchema.parse(raw), canonical = canonicalJson({ version: 1, operation: "factory-erp-apply", importId: id, input }), checksum = sha(canonical);
    const admitted = await this.transaction(context, true, async tx => {
      const row = await this.record(tx, id, false);
      if (row.fileChecksum !== input.fileChecksum || row.previewChecksum !== input.previewChecksum) throw new ConflictException("原文件或预览已变化");
      const saved = await this.replayApplication(tx, context, id, input, canonical, checksum);
      // Original non-private receipts survive expiry; this path never re-executes.
      if (saved) return { row, replay: saved };
      return { row: await this.record(tx, id), replay: undefined };
    });
    if (admitted.replay) return FactoryErpApplyResultSchema.parse(admitted.replay.result);
    await this.verifySource(context, admitted.row, input.previewChecksum);
    return this.transaction(context, true, tx => this.applyLocked(tx, context, id, input));
  }
  private async verifySource(context: TenantContext, row: Import, expectedPreview: string) {
    const bytes = await this.source.read(context, row.id, row.objectKey, row.storedChecksum, row.fileChecksum);
    try {
      const verified = this.payload(row);
      const parsed = await parseSource(verified.fileName, bytes, verified.options);
      if (this.previewChecksum(row.factoryId, row.fileChecksum, verified.options, parsed) !== expectedPreview)
        throw new ConflictException("原私有文件与预览不同，请重新上传核对");
    } finally { bytes.fill(0); }
  }
  private async replayApplication(tx: TenantTransaction, context: TenantContext, id: string, input: ApplyFactoryErpImport, canonical: string, checksum: string) {
    const [row] = await tx.select().from(applications).where(eq(applications.idempotencyKey, input.idempotencyKey));
    if (row && (row.importId !== id || row.createdBy !== context.userId || row.requestChecksum !== checksum || row.requestCanonical !== canonical))
      throw new ConflictException("同一次应用必须保留原文件、绑定集合、预览和操作员");
    return row;
  }
  private async applyLocked(tx: TenantTransaction, context: TenantContext, id: string, input: ApplyFactoryErpImport,
    ids?: { applicationId: string; bindingId: string; observationId: string; createdAt: Date }) {
      const canonical = canonicalJson({ version: 1, operation: "factory-erp-apply", importId: id, input }), checksum = sha(canonical);
      // Do not call record()/factory() before the slot: their supplier SHARE
      // would block a correction that owns this slot and needs lockPins UPDATE.
      // Retention also takes the source before any binding mutation.
      const [originalSource] = await tx.select({ factoryId: imports.factoryId }).from(imports).where(eq(imports.id, id)).for("share");
      if (!originalSource) throw new NotFoundException("导入记录不存在");
      await this.lock(tx, `factory-erp-apply:${context.tenantId}:${originalSource.factoryId}`);
      await this.lock(tx, `factory-erp-application:${context.tenantId}:${input.idempotencyKey}`);
      const previous = await this.replayApplication(tx, context, id, input, canonical, checksum);
      if (previous) {
        if (ids && previous.id !== ids.applicationId) throw new ConflictException("更正必须建立本次明确的新应用 请保留原请求核对");
        return FactoryErpApplyResultSchema.parse(previous.result);
      }
      // The delivery owner takes work/directory locks and supplier UPDATE.
      // An earlier supplier SHARE would deadlock two factories of that supplier.
      const row = await this.record(tx, id, true, false);
      if (row.fileChecksum !== input.fileChecksum || row.previewChecksum !== input.previewChecksum) throw new ConflictException("原文件或预览已变化");
      const payload = this.payload(row), appId = ids?.applicationId ?? createEntityId(), xid = await this.xid(tx), now = ids?.createdAt ?? new Date();
      const allIds = input.rows.flatMap(r => r.items.map(i => i.deliveryItemId));
      const sources = await this.delivery.factoryErpItemsInTransaction(tx, context, allIds, true), byId = new Map(sources.map(s => [s.selection.deliveryItemId, s]));
      const planned = [];
      for (const request of input.rows) {
        const original = payload.parsed.rows.find(r => r.rowNumber === request.rowNumber);
        if (!original || payload.parsed.diagnostics.some(d => d.rowNumber === request.rowNumber) || !["已审核", "已出库", "已作废"].includes(original.rawStatus))
          throw new ConflictException(`第 ${request.rowNumber} 行未通过原状态或唯一编号核对`);
        const selected = selections(request.items), selectedSources = this.checkedItems(selected, byId, row.factoryId, original.itemQuantity!);
        const key = externalKey(context.tenantId, row.factoryId, original.externalId), itemsChecksum = sha(canonicalJson(selected));
        const [tip] = await tx.select().from(bindings).where(and(eq(bindings.factoryId, row.factoryId), eq(bindings.externalKey, key))).orderBy(desc(bindings.revision)).limit(1);
        const binding = tip?.releasedBy === null ? tip : undefined;
        const expected = { expectedActiveBindingId: binding?.id ?? null, expectedRevision: tip?.revision ?? 0, expectedReleaseId: tip?.releasedBy ?? null, confirmed: true };
        if (request.association ? canonicalJson(request.association) !== canonicalJson(expected) : tip && (tip.revision > 1 || tip.releasedBy !== null))
          throw new ConflictException("该工厂编号的关联已经变化 请重新核对当前修订或解除事件");
        if (binding && (binding.itemsChecksum !== itemsChecksum || binding.quantity !== original.itemQuantity)) throw new ConflictException("该工厂编号已绑定另一组原文件，不能自动选最新版本");
        const other = await tx.select({ bindingId: bindingItems.bindingId }).from(bindingItems).innerJoin(bindings, eq(bindings.id, bindingItems.bindingId))
          .where(and(inArray(bindingItems.deliveryItemId, selected.map(s => s.deliveryItemId)), isNull(bindingItems.releasedBy), isNull(bindings.releasedBy)));
        if (other.some(i => i.bindingId !== binding?.id)) throw new ConflictException("原交付文件已归属另一工厂单，请核对原绑定");
        const bindingId = binding?.id ?? ids?.bindingId ?? createEntityId(), rowChecksum = factoryErpRowChecksum(original);
        const [duplicate] = await tx.select().from(observations).where(and(eq(observations.bindingId, bindingId), eq(observations.rowChecksum, rowChecksum)));
        const [prior] = await tx.select({ rawStatus: observations.rawStatus }).from(observations).where(and(eq(observations.bindingId, bindingId), eq(observations.rawStatus, "已出库"))).limit(1);
        const [anyScheduled] = await tx.select({ id: observations.id }).from(observations).where(and(eq(observations.bindingId, bindingId), eq(observations.rawStatus, "已审核"))).limit(1);
        const status = prior || original.rawStatus === "已出库" ? "shipped" as const : original.rawStatus === "已审核" || anyScheduled ? "scheduled" as const : null;
        const disposition = duplicate ? "unchanged" as const : original.rawStatus === "已作废" ? "exception" as const : prior || original.rawStatus === "已审核" && anyScheduled ? "unchanged" as const : "advanced" as const;
        planned.push({ request, original, selected, selectedSources, binding, tip, bindingId, key, itemsChecksum, rowChecksum, duplicate,
          observationId: duplicate?.id ?? ids?.observationId ?? createEntityId(), status, disposition });
      }
      const result: FactoryErpApplyResult = { id: appId, importId: id, fileChecksum: row.fileChecksum, previewChecksum: row.previewChecksum, requestChecksum: checksum,
        createdAt: now.toISOString(), appliedRows: planned.length, observations: planned.map(p => ({ rowNumber: p.original.rowNumber, bindingId: p.bindingId, observationId: p.observationId, disposition: p.disposition, status: p.status })) };
      await tx.insert(applications).values({ id: appId, tenantId: context.tenantId, importId: id, idempotencyKey: input.idempotencyKey, requestCanonical: canonical, requestChecksum: checksum, input, result,
        createdBy: context.userId, creationTransactionId: xid, createdAt: now });
      for (const p of planned) {
        if (!p.binding) {
          await tx.insert(bindings).values({ id: p.bindingId, tenantId: context.tenantId, factoryId: row.factoryId, externalKey: p.key, itemsChecksum: p.itemsChecksum,
            encryptedPayload: this.vault.encrypt(JSON.stringify({ externalId: p.original.externalId, items: p.selected })), quantity: p.original.itemQuantity, applicationId: appId,
            revision: (p.tip?.revision ?? 0) + 1, previousBindingId: p.tip?.id ?? null, createdBy: context.userId, creationTransactionId: xid, createdAt: now });
          await tx.insert(bindingItems).values(p.selectedSources.map(s => ({ id: createEntityId(), tenantId: context.tenantId, bindingId: p.bindingId, ...s.selection, quantity: s.quantity })));
        }
        if (!p.duplicate) await tx.insert(observations).values({ id: p.observationId, tenantId: context.tenantId, bindingId: p.bindingId, applicationId: appId, importId: id,
          rowNumber: p.original.rowNumber, rowChecksum: p.rowChecksum, rawStatus: p.original.rawStatus, encryptedPayload: this.vault.encrypt(JSON.stringify(p.original)), createdBy: context.userId, creationTransactionId: xid });
        await tx.insert(applicationRows).values({ id: createEntityId(), tenantId: context.tenantId, applicationId: appId, rowNumber: p.original.rowNumber, bindingId: p.bindingId, observationId: p.observationId, disposition: p.disposition });
      }
      await this.audit.recordInTransaction(tx, context, { action: "factory_erp.import_applied", resourceType: "factory_erp_application", resourceId: appId, result: "success", metadata: { importId: id, rows: planned.length } });
      return FactoryErpApplyResultSchema.parse(result);
  }

  /** Each binding view uses one READ COMMITTED snapshot for its root, full
   * original group, observation sequence, successor and immutable release. */
  private async bindingSnapshots(tx: TenantTransaction, where: SQL, limit = 1) {
    return tx.select({ binding: bindings, source: imports,
      items: sql<Array<FactoryErpItemSelection & { quantity: number }>>`(select coalesce(jsonb_agg(jsonb_build_object('deliveryItemId',i.delivery_item_id,'productionOrderId',i.production_order_id,'productionVersionId',i.production_version_id,'fileChecksum',i.file_checksum,'manufacturingChecksum',i.manufacturing_checksum,'quantity',i.quantity) order by i.delivery_item_id),'[]'::jsonb) from factory_erp_binding_items i where i.tenant_id=${bindings.tenantId} and i.binding_id=${bindings.id})`,
      nextId: sql<string | null>`(select n.id from factory_erp_bindings n where n.tenant_id=${bindings.tenantId} and n.previous_binding_id=${bindings.id})`,
      sequence: sql<number>`(select coalesce(max(o.sequence),0)::double precision from factory_erp_observations o where o.tenant_id=${bindings.tenantId} and o.binding_id=${bindings.id})`,
      voidSummary: factoryErpVoidSummarySql(sql`${bindings.tenantId}`, sql`${bindings.id}`),
      status: sql<"scheduled" | "shipped" | null>`(select case when o.raw_status='已出库' then 'shipped' else 'scheduled' end from factory_erp_observations o where o.tenant_id=${bindings.tenantId} and o.binding_id=${bindings.id} and o.raw_status<>'已作废' order by (o.raw_status='已出库') desc,o.sequence desc limit 1)`,
      exception: sql<"voided_requires_review" | null>`(select 'voided_requires_review' from factory_erp_observations o where o.tenant_id=${bindings.tenantId} and o.binding_id=${bindings.id} and o.raw_status='已作废' limit 1)`,
      release: sql<FactoryErpBindingChangeResult | null>`(select c.result from factory_erp_binding_changes c where c.tenant_id=${bindings.tenantId} and c.id=${bindings.releasedBy})`,
    }).from(bindings).innerJoin(applications, eq(applications.id, bindings.applicationId)).innerJoin(imports, eq(imports.id, applications.importId))
      .where(where).orderBy(desc(bindings.id)).limit(limit);
  }
  private bindingView(row: Awaited<ReturnType<FactoryErpImportService["bindingSnapshots"]>>[number]) {
    assertFactoryErpProof(this.vault, row.source);
    return FactoryErpBindingViewSchema.parse({ id: row.binding.id, factoryId: row.binding.factoryId, revision: row.binding.revision,
      previousBindingId: row.binding.previousBindingId, nextBindingId: row.nextId, releasedBy: row.binding.releasedBy,
      state: row.binding.releasedBy === null ? "active" : "released", itemsChecksum: row.binding.itemsChecksum, quantity: row.binding.quantity,
      sourceImportId: row.source.id, observationSequence: row.sequence, recordedStatus: row.status, recordedException: row.exception,
      items: row.items, createdAt: row.binding.createdAt.toISOString(), release: row.release, voidSummary: row.voidSummary });
  }
  async binding(context: TenantContext, id: string) {
    return this.transaction(context, false, async tx => {
      const [row] = await this.bindingSnapshots(tx, eq(bindings.id, id));
      if (!row) throw new NotFoundException("原工厂关联不存在");
      await this.factory(tx, row.binding.factoryId, false); return this.bindingView(row);
    });
  }
  async listBindings(context: TenantContext, raw: unknown) {
    const input = FactoryErpBindingPageQuerySchema.parse(raw);
    return this.transaction(context, false, async tx => {
      await this.factory(tx, input.factoryId, false);
      const rows = await this.bindingSnapshots(tx, and(eq(bindings.factoryId, input.factoryId), input.cursor ? lt(bindings.id, input.cursor) : undefined)!, input.limit + 1);
      return FactoryErpBindingPageSchema.parse({ items: rows.slice(0, input.limit).map(row => {
        const view = this.bindingView(row); return Object.fromEntries(Object.entries(view).filter(([key]) => key !== "items" && key !== "release"));
      }), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.binding.id : null });
    });
  }
  private changeResult(row: typeof bindingChanges.$inferSelect) {
    const result = FactoryErpBindingChangeResultSchema.parse(row.result);
    if (result.id !== row.id || result.bindingId !== row.bindingId || result.factoryId !== row.factoryId || result.requestChecksum !== row.requestChecksum || sha(row.requestCanonical) !== row.requestChecksum)
      throw new ConflictException("原更正回执校验失败");
    return result;
  }
  async listBindingChanges(context: TenantContext, id: string, raw: unknown) {
    const input = FactoryErpBindingChangePageQuerySchema.parse(raw);
    return this.transaction(context, false, async tx => {
      const [binding] = await tx.select().from(bindings).where(eq(bindings.id, id));
      if (!binding) throw new NotFoundException("原工厂关联不存在"); await this.factory(tx, binding.factoryId, false);
      const rows = await tx.select().from(bindingChanges).where(and(eq(bindingChanges.bindingId, id), input.cursor ? lt(bindingChanges.id, input.cursor) : undefined)).orderBy(desc(bindingChanges.id)).limit(input.limit + 1);
      return FactoryErpBindingChangePageSchema.parse({ items: rows.slice(0, input.limit).map(row => this.changeResult(row)), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null });
    });
  }
  async bindingChange(context: TenantContext, id: string, changeId: string) {
    return this.transaction(context, false, async tx => {
      const [row] = await tx.select().from(bindingChanges).where(and(eq(bindingChanges.id, changeId), eq(bindingChanges.bindingId, id)));
      if (!row) throw new NotFoundException("原更正回执不存在"); await this.factory(tx, row.factoryId, false); return this.changeResult(row);
    });
  }
  private async replayBindingChange(tx: TenantTransaction, context: TenantContext, id: string, input: ChangeFactoryErpBinding, canonical: string, checksum: string) {
    const [row] = await tx.select().from(bindingChanges).where(eq(bindingChanges.idempotencyKey, input.idempotencyKey));
    if (row && (row.bindingId !== id || row.createdBy !== context.userId || row.requestCanonical !== canonical || row.requestChecksum !== checksum))
      throw new ConflictException("同一次解除或更正必须保留原对象、完整正文、操作员与请求键");
    if (!row) return null; await this.factory(tx, row.factoryId, false); return this.changeResult(row);
  }
  private async voidBasis(tx: TenantTransaction, id: string) {
    const [row] = await this.bindingSnapshots(tx, eq(bindings.id, id));
    if (!row) throw new NotFoundException("原工厂关联不存在");
    await this.factory(tx, row.binding.factoryId, false);
    const binding = this.bindingView(row);
    return FactoryErpVoidBasisSchema.parse({ bindingId: id, factoryId: binding.factoryId, bindingRevision: binding.revision,
      itemsChecksum: binding.itemsChecksum, state: binding.state, observationSequence: binding.observationSequence, summary: binding.voidSummary });
  }
  private async voidObservationInTransaction(tx: TenantTransaction, context: TenantContext, id: string, observationId: string) {
    const [entry] = await tx.execute<VoidReadRow>(factoryErpVoidProofRowsSql(sql`${context.tenantId}::uuid`, sql`${id}::uuid`, { observationId, limit: 1 }));
    if (!entry) throw new NotFoundException("原工厂作废观察不存在");
    return this.voidObservationView(entry);
  }
  private voidObservationView(entry: VoidReadRow): FactoryErpVoidObservationView {
    const view = FactoryErpVoidObservationViewSchema.parse(entry.value), source = entry.sourceProof;
    assertFactoryErpProofDigest(this.vault, source);
    const claim = entry.sourceClaim;
    if (entry.sourceClaimCount !== 1 || !claim || claim.rowNumber !== view.rowNumber || source.factoryId !== entry.bindingFactoryId || source.id !== view.importId || claim.rawStatus !== "已作废" || claim.rowChecksum !== view.rowChecksum || claim.externalKey !== entry.bindingKey ||
      claim.quantity !== entry.bindingQuantity || source.fileChecksum !== view.fileChecksum || source.previewChecksum !== view.previewChecksum)
      throw new ConflictException("原作废观察与其真实来源不符 请保留证据核对");
    return view;
  }
  async voidObservations(context: TenantContext, id: string, raw: unknown = {}) {
    const input = FactoryErpVoidObservationPageQuerySchema.parse(raw);
    return this.transaction(context, false, async tx => {
      const basis = await this.voidBasis(tx, id);
      const rows = await tx.execute<VoidReadRow>(factoryErpVoidProofRowsSql(sql`${context.tenantId}::uuid`, sql`${id}::uuid`, { cursor: input.cursor, limit: input.limit + 1 }));
      const items = rows.slice(0, input.limit).map(row => this.voidObservationView(row));
      return FactoryErpVoidObservationPageSchema.parse({ basis, items, nextCursor: rows.length > input.limit ? items.at(-1)!.sequence : null });
    }, true);
  }
  async voidObservation(context: TenantContext, id: string, observationId: string) {
    return this.transaction(context, false, async tx => FactoryErpVoidObservationDetailSchema.parse({ basis: await this.voidBasis(tx, id),
      observation: await this.voidObservationInTransaction(tx, context, id, observationId) }), true);
  }
  private voidReviewResult(row: typeof voidReviews.$inferSelect) {
    const result = FactoryErpVoidReviewResultSchema.parse(row.result), input = ReviewFactoryErpVoidSchema.parse(row.input);
    const canonical = canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: row.bindingId, input });
    if (canonical !== row.requestCanonical || sha(canonical) !== row.requestChecksum || result.requestChecksum !== row.requestChecksum || result.id !== row.id ||
      result.bindingId !== row.bindingId || result.factoryId !== row.factoryId || result.observation.id !== row.observationId ||
      result.reviewRevision !== row.reviewRevision || result.previousReviewId !== row.previousReviewId || result.outcome !== row.outcome || result.reasonCode !== row.reasonCode)
      throw new ConflictException("原作废核对回执校验失败");
    return result;
  }
  async listVoidReviews(context: TenantContext, id: string, raw: unknown = {}) {
    const input = FactoryErpVoidReviewPageQuerySchema.parse(raw);
    return this.transaction(context, false, async tx => {
      await this.voidBasis(tx, id);
      if (input.observationId) await this.voidObservationInTransaction(tx, context, id, input.observationId);
      const rows = await tx.select().from(voidReviews).where(and(eq(voidReviews.bindingId, id), input.cursor ? lt(voidReviews.id, input.cursor) : undefined,
        input.observationId ? eq(voidReviews.observationId, input.observationId) : undefined)).orderBy(desc(voidReviews.id)).limit(input.limit + 1);
      return FactoryErpVoidReviewPageSchema.parse({ items: rows.slice(0, input.limit).map(row => this.voidReviewResult(row)), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null });
    }, true);
  }
  async voidReview(context: TenantContext, id: string, reviewId: string) {
    return this.transaction(context, false, async tx => {
      await this.voidBasis(tx, id);
      const [row] = await tx.select().from(voidReviews).where(and(eq(voidReviews.bindingId, id), eq(voidReviews.id, reviewId)));
      if (!row) throw new NotFoundException("原作废核对回执不存在"); return this.voidReviewResult(row);
    }, true);
  }
  private async replayVoidReview(tx: TenantTransaction, context: TenantContext, id: string, input: ReviewFactoryErpVoid, canonical: string, checksum: string) {
    const [row] = await tx.select().from(voidReviews).where(eq(voidReviews.idempotencyKey, input.idempotencyKey));
    if (!row) return null;
    if (row.bindingId !== id || row.createdBy !== context.userId || row.requestCanonical !== canonical || row.requestChecksum !== checksum)
      throw new ConflictException("同一次作废核对必须保留原对象、本人、完整正文与请求键");
    await this.factory(tx, row.factoryId, false); return this.voidReviewResult(row);
  }
  async reviewVoid(context: TenantContext, rawId: string, raw: unknown) {
    const id = z.uuidv7().parse(rawId).toLowerCase(), input = ReviewFactoryErpVoidSchema.parse(raw);
    const canonical = canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: id, input }), checksum = sha(canonical);
    const admission = await this.transaction(context, true, async tx => {
      const replay = await this.replayVoidReview(tx, context, id, input, canonical, checksum); if (replay) return { replay, source: null };
      const basis = await this.voidBasis(tx, id), source = await this.record(tx, input.source.importId);
      if (basis.factoryId !== source.factoryId || source.fileChecksum !== input.source.fileChecksum || source.previewChecksum !== input.source.previewChecksum)
        throw new ConflictException("核对来源与原工厂或固定文件不符");
      this.payload(source); return { replay: null, source };
    });
    if (admission.replay) return admission.replay;
    const currentContext = await this.authority(context, admission.source!.factoryId, true);
    await this.verifySource(currentContext, admission.source!, input.source.previewChecksum);
    return this.transaction(context, true, async tx => {
      const [before] = await tx.select({ binding: bindings, sourceId: applications.importId }).from(bindings)
        .innerJoin(applications, eq(applications.id, bindings.applicationId)).where(eq(bindings.id, id));
      if (!before) throw new NotFoundException("原工厂关联不存在");
      await tx.select({ id: imports.id }).from(imports).where(inArray(imports.id, [...new Set([before.sourceId, input.observation.importId, input.source.importId])])).orderBy(asc(imports.id)).for("share");
      await this.lock(tx, `factory-erp-apply:${context.tenantId}:${before.binding.factoryId}`);
      await this.lock(tx, `factory-erp-void-review:${context.tenantId}:${input.idempotencyKey}`);
      const replay = await this.replayVoidReview(tx, context, id, input, canonical, checksum); if (replay) return replay;
      const [binding] = await tx.select().from(bindings).where(eq(bindings.id, id)).for("update");
      if (!binding) throw new NotFoundException("原工厂关联不存在"); await this.factory(tx, binding.factoryId);
      const basis = await this.voidBasis(tx, id), observation = await this.voidObservationInTransaction(tx, context, id, input.observation.id);
      const identity = { id: observation.id, sequence: observation.sequence, importId: observation.importId, rowNumber: observation.rowNumber,
        rowChecksum: observation.rowChecksum, fileChecksum: observation.fileChecksum, previewChecksum: observation.previewChecksum, recordedAt: observation.recordedAt };
      if (basis.state !== "active" || basis.bindingRevision !== input.expectedBindingRevision || basis.itemsChecksum !== input.expectedItemsChecksum ||
        basis.observationSequence !== input.expectedObservationSequence || canonicalJson(identity) !== canonicalJson(input.observation) ||
        (observation.latestReview?.id ?? null) !== input.expectedPreviousReviewId)
        throw new ConflictException("原组、作废观察或核对历史已变化 请重新核对");
      const source = await this.record(tx, input.source.importId), payload = this.payload(source), original = payload.parsed.rows.find(row => row.rowNumber === input.source.rowNumber);
      if (source.factoryId !== binding.factoryId || source.fileChecksum !== input.source.fileChecksum || source.previewChecksum !== input.source.previewChecksum || !original ||
        payload.parsed.diagnostics.some(row => row.rowNumber === input.source.rowNumber) || !["已审核", "已出库", "已作废"].includes(original.rawStatus) ||
        externalKey(context.tenantId, binding.factoryId, original.externalId) !== binding.externalKey || original.itemQuantity !== binding.quantity ||
        input.reasonCode === "corrected_export" && (input.outcome === "confirmed_voided" ? original.rawStatus !== "已作废" : original.rawStatus === "已作废"))
        throw new ConflictException("有效来源不能证明本工厂编号、数量或所选更正导出结论");
      const reviewRevision = (observation.latestReview?.reviewRevision ?? 0) + 1;
      if (reviewRevision > 1_000_000) throw new ConflictException("原观察核对修订已达上限");
      const reviewId = createEntityId(), now = new Date(), xid = await this.xid(tx);
      const result = FactoryErpVoidReviewResultSchema.parse({ id: reviewId, bindingId: id, factoryId: binding.factoryId, observation: identity, source: input.source,
        originalBindingRevision: binding.revision, originalItemsChecksum: binding.itemsChecksum, originalObservationSequence: basis.observationSequence,
        reviewRevision, previousReviewId: input.expectedPreviousReviewId, outcome: input.outcome, reasonCode: input.reasonCode, provenance: input.provenance,
        requestChecksum: checksum, createdAt: now.toISOString() });
      await tx.insert(voidReviews).values({ id: reviewId, tenantId: context.tenantId, factoryId: binding.factoryId, bindingId: id, observationId: observation.id,
        reviewRevision, previousReviewId: input.expectedPreviousReviewId, sourceImportId: source.id, sourceRowNumber: original.rowNumber, outcome: input.outcome,
        reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey, requestCanonical: canonical, requestChecksum: checksum, input, result,
        createdBy: context.userId, creationTransactionId: xid, createdAt: now });
      await this.audit.recordInTransaction(tx, context, { action: "factory_erp.void_reviewed", resourceType: "factory_erp_void_review", resourceId: reviewId, result: "success",
        metadata: { bindingId: id, observationId: observation.id, reviewRevision, outcome: input.outcome } });
      return result;
    });
  }
  async changeBinding(context: TenantContext, rawId: string, raw: unknown) {
    const id = z.uuidv7().parse(rawId).toLowerCase(), input = ChangeFactoryErpBindingSchema.parse(raw);
    const canonical = canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: id, input }), checksum = sha(canonical);
    const admission = await this.transaction(context, true, async tx => {
      const replay = await this.replayBindingChange(tx, context, id, input, canonical, checksum); if (replay) return { replay, source: null };
      const [old] = await tx.select({ binding: bindings, sourceId: applications.importId }).from(bindings).innerJoin(applications, eq(applications.id, bindings.applicationId)).where(eq(bindings.id, id));
      if (!old) throw new NotFoundException("原工厂关联不存在");
      await this.factory(tx, old.binding.factoryId); const source = await this.record(tx, input.source.importId);
      if (source.factoryId !== old.binding.factoryId || source.fileChecksum !== input.source.fileChecksum || source.previewChecksum !== input.source.previewChecksum)
        throw new ConflictException("新来源与原工厂或固定文件不符");
      this.payload(source); return { replay: null, source };
    });
    if (admission.replay) return admission.replay;
    await this.verifySource(context, admission.source!, input.source.previewChecksum);
    return this.transaction(context, true, async tx => {
      const [before] = await tx.select({ binding: bindings, sourceId: applications.importId }).from(bindings).innerJoin(applications, eq(applications.id, bindings.applicationId)).where(eq(bindings.id, id));
      if (!before) throw new NotFoundException("原工厂关联不存在");
      // Maintenance takes the same source rows before touching any binding.
      // Pin sources first in UUID order so correction cannot invert its locks.
      await tx.select({ id: imports.id }).from(imports).where(inArray(imports.id, [...new Set([before.sourceId, input.source.importId])])).orderBy(asc(imports.id)).for("share");
      await this.lock(tx, `factory-erp-apply:${context.tenantId}:${before.binding.factoryId}`);
      await this.lock(tx, `factory-erp-binding-change:${context.tenantId}:${input.idempotencyKey}`);
      const replay = await this.replayBindingChange(tx, context, id, input, canonical, checksum); if (replay) return replay;
      const [binding] = await tx.select().from(bindings).where(eq(bindings.id, id)).for("update");
      if (!binding) throw new NotFoundException("原工厂关联不存在");
      await this.factory(tx, binding.factoryId, true, input.action === "release");
      const [sequence] = await tx.select({ value: sql<number>`coalesce(max(${observations.sequence}),0)::integer` }).from(observations).where(eq(observations.bindingId, id));
      if (binding.releasedBy !== null || binding.revision !== input.expectedRevision || binding.itemsChecksum !== input.expectedItemsChecksum || sequence!.value !== input.expectedObservationSequence)
        throw new ConflictException("原关联或观察已经变化 请重新核对完整原组");
      const source = await this.record(tx, input.source.importId, true, input.action === "release"), payload = this.payload(source);
      const original = payload.parsed.rows.find(row => row.rowNumber === input.source.rowNumber);
      if (source.factoryId !== binding.factoryId || source.fileChecksum !== input.source.fileChecksum || source.previewChecksum !== input.source.previewChecksum || !original ||
        payload.parsed.diagnostics.some(d => d.rowNumber === input.source.rowNumber) || !["已审核", "已出库", "已作废"].includes(original.rawStatus) ||
        externalKey(context.tenantId, binding.factoryId, original.externalId) !== binding.externalKey)
        throw new ConflictException("当前来源不能证明要解除的工厂编号 请重新核对");
      if (input.action === "correct" && sha(canonicalJson(selections(input.items))) === binding.itemsChecksum)
        throw new ConflictException("完整原组没有改变 请使用原关联应用状态");
      if (input.action === "correct") {
        // Validate and lock the full new group before the SQL change header
        // acquires factory/supplier SHARE, and before releasing any old item.
        const selected = selections(input.items), sources = await this.delivery.factoryErpItemsInTransaction(tx, context, selected.map(item => item.deliveryItemId), true);
        this.checkedItems(selected, new Map(sources.map(item => [item.selection.deliveryItemId, item])), binding.factoryId, original.itemQuantity!);
      }
      const changeId = createEntityId(), appId = input.action === "correct" ? createEntityId() : null, newBindingId = input.action === "correct" ? createEntityId() : null;
      const observationId = createEntityId(), now = new Date(), xid = await this.xid(tx);
      const appInput = input.action === "correct" ? ApplyFactoryErpImportSchema.parse({ fileChecksum: source.fileChecksum, previewChecksum: source.previewChecksum, idempotencyKey: input.idempotencyKey, confirmed: true,
        rows: [{ rowNumber: original.rowNumber, items: input.items, wholeGroupConfirmed: true,
          association: { expectedActiveBindingId: null, expectedRevision: binding.revision, expectedReleaseId: changeId, confirmed: true } }] }) : null;
      const appResult = appInput ? FactoryErpApplyResultSchema.parse({ id: appId, importId: source.id, fileChecksum: source.fileChecksum, previewChecksum: source.previewChecksum,
        requestChecksum: sha(canonicalJson({ version: 1, operation: "factory-erp-apply", importId: source.id, input: appInput })), createdAt: now.toISOString(), appliedRows: 1,
        observations: [{ rowNumber: original.rowNumber, bindingId: newBindingId, observationId, disposition: original.rawStatus === "已作废" ? "exception" : "advanced", status: original.rawStatus === "已作废" ? null : original.rawStatus === "已出库" ? "shipped" : "scheduled" }] }) : null;
      const result = FactoryErpBindingChangeResultSchema.parse({ id: changeId, bindingId: id, factoryId: binding.factoryId, action: input.action, reasonCode: input.reasonCode, source: input.source,
        originalRevision: binding.revision, originalItemsChecksum: binding.itemsChecksum, originalObservationSequence: sequence!.value,
        replacementBindingId: newBindingId, replacementRevision: appInput ? binding.revision + 1 : null, application: appResult, requestChecksum: checksum, createdAt: now.toISOString() });
      await tx.insert(bindingChanges).values({ id: changeId, tenantId: context.tenantId, factoryId: binding.factoryId, bindingId: id, sourceImportId: source.id, sourceRowNumber: original.rowNumber,
        action: input.action, replacementBindingId: newBindingId, replacementApplicationId: appId, idempotencyKey: input.idempotencyKey, requestCanonical: canonical, requestChecksum: checksum, input, result,
        createdBy: context.userId, creationTransactionId: xid, createdAt: now });
      await tx.update(bindings).set({ releasedBy: changeId }).where(eq(bindings.id, id));
      await tx.update(bindingItems).set({ releasedBy: changeId }).where(eq(bindingItems.bindingId, id));
      if (appInput) {
        const applied = await this.applyLocked(tx, context, source.id, appInput, { applicationId: appId!, bindingId: newBindingId!, observationId, createdAt: now });
        if (canonicalJson(applied) !== canonicalJson(appResult)) throw new ConflictException("更正与本次明确应用的完整结果不一致");
      }
      await this.audit.recordInTransaction(tx, context, { action: "factory_erp.binding_changed", resourceType: "factory_erp_binding_change", resourceId: changeId, result: "success",
        metadata: { bindingId: id, action: input.action, revision: binding.revision, replacementBindingId: newBindingId } });
      return result;
    });
  }
}
