import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { GenerateOrderDocumentsSchema, PreviewOrderDocumentsSchema, SaveFactoryDocumentProfileSchema,
  type DocumentOptions, type DocumentExportView, type PreviewOrderDocuments, type OrderDocumentsPreview } from "@yummyai/contracts/logistics/documents";
import { logisticsDocumentProfiles as profiles, logisticsDocumentExports as exports, logisticsDocumentOrders as links,
  fulfillmentFactories as factories, fulfillmentFactoryVersions as factoryVersions, productSpecifications as specifications,
  productSpecificationVersions as specificationVersions, spus, orders, orderLines, orderPrivateSourceAvailable,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { logisticsLock, planOrderDocument, purgeDocumentExports } from "@yummyai/logistics";
import { OrderDocumentSourceReader, withOrderAuthority } from "@yummyai/order-core";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { OrderProductionDeliveryService } from "../orders/order-production-delivery.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { createDocumentWorkbook, documentTemplateChecksum } from "./document-workbook.js";

const read: PermissionValue[] = [Permission.OrderRead, Permission.OrderPiiRead];
const querySchema = z.object({ orderId: z.uuidv7().optional(), q: z.string().trim().max(100).optional() }).strict();
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type StoredFile = { input: PreviewOrderDocuments; base64: string; version: 1 };
type Receipt = typeof exports.$inferSelect;

/** File preparation owns no marketplace, factory production, payment or shipment transitions. */
@Injectable()
export class LogisticsDocumentsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService) {}

  async options(context: TenantContext, raw: unknown): Promise<DocumentOptions> {
    const query = querySchema.parse(raw);
    return this.transaction(context, read, async tx => {
      const factoryRows = await tx.select({ factory: factories, version: factoryVersions }).from(factories)
        .innerJoin(factoryVersions, and(eq(factoryVersions.factoryId, factories.id), eq(factoryVersions.versionNumber, factories.currentVersionNumber)))
        .orderBy(asc(factories.name)).limit(201);
      const profileRows = await tx.select().from(profiles).orderBy(desc(profiles.versionNumber), desc(profiles.createdAt));
      const latest = profileRows.filter((row, index) => profileRows.findIndex(other => other.factoryId === row.factoryId) === index);
      const specRows = await tx.select({ id: specificationVersions.id, name: specificationVersions.name,
        code: specifications.code, spuName: spus.name, version: specificationVersions.versionNumber }).from(specifications)
        .innerJoin(specificationVersions, and(eq(specificationVersions.specificationId, specifications.id), eq(specificationVersions.versionNumber, specifications.versionNumber)))
        .innerJoin(spus, eq(spus.id, specifications.spuId)).orderBy(asc(spus.name), asc(specifications.code)).limit(501);
      const orderRows = await tx.select({ id: orders.id, number: orders.externalOrderId, state: orders.workflowState }).from(orders)
        .where(and(query.orderId ? eq(orders.id, query.orderId) : undefined,
          query.q ? ilike(orders.externalOrderId, `%${query.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`) : undefined,
          orderPrivateSourceAvailable(sql`${orders.id}`)))
        .orderBy(desc(orders.createdAt), desc(orders.id)).limit(101);
      const quantities = orderRows.length ? await tx.select({ id: orderLines.id, orderId: orderLines.orderId, quantity: orderLines.quantity })
        .from(orderLines).where(inArray(orderLines.orderId, orderRows.map(row => row.id))) : [];
      await this.audit.recordInTransaction(tx, context, { action: "logistics.documents.options", resourceType: "logistics_document", result: "success", metadata: { count: Math.min(100, orderRows.length) } });
      return { canConfigure: context.permissions.includes(Permission.IntegrationManage), canGenerate: context.permissions.includes(Permission.OrderWrite),
        canReadProduction: [Permission.DesignRead, Permission.AssetRead].every(permission => context.permissions.includes(permission)),
        truncated: factoryRows.length > 200 || specRows.length > 500 || orderRows.length > 100,
        factories: factoryRows.slice(0, 200).map(row => ({ id: row.factory.id, name: row.factory.name, status: row.factory.status,
          countryCode: (row.version.profile.pickupAddress ?? row.version.profile.productionAddress)?.countryCode ?? null })),
        specifications: specRows.slice(0, 500), profiles: latest.map(row => ({ id: row.id, factoryId: row.factoryId, factoryVersionId: row.factoryVersionId, version: row.versionNumber, profile: row.profile })),
        orders: orderRows.slice(0, 100).map(row => ({ ...row, lineId: quantities.find(line => line.orderId === row.id)?.id ?? null, quantity: quantities.filter(line => line.orderId === row.id).reduce((sum, line) => sum + line.quantity, 0) })) };
    });
  }

  async saveProfile(context: TenantContext, raw: unknown) {
    const input = SaveFactoryDocumentProfileSchema.parse(raw), digest = hash(input);
    return this.transaction(context, [...read, Permission.IntegrationManage], async tx => {
      await logisticsLock(tx, context, `document-profile:${input.factoryId}`);
      const [replay] = await tx.select().from(profiles).where(eq(profiles.requestKey, input.idempotencyKey));
      if (replay) {
        if (replay.requestHash !== digest || replay.createdBy !== context.userId) throw new ConflictException("请求编号已用于其他配置 请刷新");
        return { id: replay.id, version: replay.versionNumber };
      }
      const [current] = await tx.select().from(profiles).where(eq(profiles.factoryId, input.factoryId)).orderBy(desc(profiles.versionNumber)).limit(1);
      if ((current?.versionNumber ?? 0) !== input.expectedVersion) throw new ConflictException("工厂导单配置已更新 请刷新后再保存");
      const factory = await this.factory(tx, input.factoryId);
      const ids = input.profile.specifications.map(spec => spec.specificationVersionId);
      const specRows = await tx.select({ id: specificationVersions.id }).from(specificationVersions).where(inArray(specificationVersions.id, ids));
      if (specRows.length !== ids.length) throw new ConflictException("请选择本租户产品档案中的真实规格版本");
      const origin = factory.version.profile.pickupAddress ?? factory.version.profile.productionAddress;
      if (origin && origin.countryCode !== input.profile.originCountryCode) throw new ConflictException("导单发货国须与工厂档案中的实际发货地一致");
      const id = createEntityId(), version = input.expectedVersion + 1;
      await tx.insert(profiles).values({ id, tenantId: context.tenantId, createdBy: context.userId,
        factoryId: input.factoryId, factoryVersionId: factory.version.id, versionNumber: version, profile: input.profile,
        requestKey: input.idempotencyKey, requestHash: digest });
      await this.audit.recordInTransaction(tx, context, { action: "logistics.documents.profile_saved", resourceType: "logistics_document_profile", resourceId: id, result: "success", metadata: { factoryId: input.factoryId, version } });
      return { id, version };
    });
  }

  async preview(context: TenantContext, raw: unknown): Promise<OrderDocumentsPreview> {
    const input = PreviewOrderDocumentsSchema.parse(raw);
    return this.transaction(context, read, async tx => {
      const result = await this.prepare(tx, context, input);
      await this.audit.recordInTransaction(tx, context, { action: "logistics.documents.previewed", resourceType: "logistics_document", result: "success", metadata: { profileVersionId: input.profileVersionId, orderIds: input.orderIds, adapter: input.adapter, fingerprint: result.preview.fingerprint } });
      return result.preview;
    });
  }

  async generate(context: TenantContext, raw: unknown) {
    const input = GenerateOrderDocumentsSchema.parse(raw), selection = PreviewOrderDocumentsSchema.parse({
      profileVersionId: input.profileVersionId, adapter: input.adapter, orderIds: input.orderIds, overrides: input.overrides, deliveryPackageIds: input.deliveryPackageIds,
    }), digest = hash(input);
    const basis = await this.transaction(context, [...read, Permission.OrderWrite], tx => this.prepare(tx, context, selection));
    this.assertReady(basis.preview, input.expectedFingerprint);
    if (input.adapter === "printeque_factory") await this.delivery.verifyDocumentFiles(context, basis.productionPins);
    return this.transaction(context, [...read, Permission.OrderWrite], async tx => {
      await logisticsLock(tx, context, "document-exports");
      const current = await this.prepare(tx, context, selection);
      this.assertReady(current.preview, input.expectedFingerprint);
      const [replay] = await tx.select().from(exports).where(eq(exports.requestKey, input.idempotencyKey));
      if (replay && (replay.requestHash !== digest || replay.createdBy !== context.userId)) throw new ConflictException("请求编号已用于其他导出");
      const [same] = replay ? [replay] : await tx.select().from(exports).where(and(eq(exports.profileVersionId, input.profileVersionId), eq(exports.adapter, input.adapter), eq(exports.sourceFingerprint, current.preview.fingerprint)));
      if (same) {
        if (!same.encryptedSnapshot || same.expiresAt <= new Date()) throw new ConflictException("相同单据的私有资料已清理 不可恢复 请重新核对订单来源");
        await this.recordDownloadIntent(tx, context, same.id, true);
        return { id: same.id, reused: true };
      }
      const createdAt = new Date(), bytes = await createDocumentWorkbook(input.adapter, current.preview.orders.flatMap(order => order.rows), createdAt);
      try {
        const id = createEntityId();
        await tx.insert(exports).values({ id, tenantId: context.tenantId, createdBy: context.userId, createdAt,
          profileVersionId: input.profileVersionId, adapter: input.adapter, requestKey: input.idempotencyKey, requestHash: digest,
          sourceFingerprint: current.preview.fingerprint, encryptedSnapshot: this.vault.encrypt(JSON.stringify({ version: 1, input: selection, base64: bytes.toString("base64") } satisfies StoredFile)),
          fileChecksum: sha(bytes), byteSize: bytes.byteLength, rowCount: current.preview.rowCount, expiresAt: current.expiresAt });
        await tx.insert(links).values(current.sources.map(source => ({ id: createEntityId(), tenantId: context.tenantId,
          exportId: id, orderId: source.source.id, sourceFingerprint: source.fingerprint })));
        await this.recordDownloadIntent(tx, context, id, false);
        return { id, reused: false };
      } finally { bytes.fill(0); }
    });
  }

  async history(context: TenantContext, raw: unknown): Promise<{ exports: DocumentExportView[] }> {
    const query = z.object({ orderId: z.uuidv7().optional() }).strict().parse(raw);
    return this.transaction(context, read, async tx => {
      await purgeDocumentExports(tx);
      const rows = await tx.selectDistinct({ receipt: exports, factoryName: factories.name }).from(exports)
        .innerJoin(profiles, eq(profiles.id, exports.profileVersionId)).innerJoin(factories, eq(factories.id, profiles.factoryId))
        .innerJoin(links, eq(links.exportId, exports.id)).where(query.orderId ? eq(links.orderId, query.orderId) : undefined)
        .orderBy(desc(exports.createdAt), desc(exports.id)).limit(50);
      const result: DocumentExportView[] = [];
      for (const row of rows) {
        let reason: string | null = null;
        if (!row.receipt.encryptedSnapshot || row.receipt.expiresAt <= new Date()) reason = "私有资料已到期或清理";
        else {
          try {
            const stored = this.stored(row.receipt);
            const current = await this.prepare(tx, context, stored.input);
            if (!current.preview.ready || current.preview.fingerprint !== row.receipt.sourceFingerprint) reason = "订单、地址、规格或工厂版本已变化 请重新生成";
          } catch { reason = "原订单或正式生产来源当前不可用"; }
        }
        result.push({ id: row.receipt.id, adapter: row.receipt.adapter, factoryName: row.factoryName,
          createdAt: row.receipt.createdAt.toISOString(), rowCount: row.receipt.rowCount, byteSize: row.receipt.byteSize,
          checksum: row.receipt.fileChecksum, available: reason === null, reason });
      }
      return { exports: result };
    });
  }

  async download(context: TenantContext, id: string) {
    // Purge in a separate committed transaction so a denied read cannot roll back erasure.
    await this.transaction(context, read, tx => purgeDocumentExports(tx));
    const basis = await this.transaction(context, read, async tx => {
      const row = await this.receipt(tx, id), stored = this.stored(row);
      const current = await this.prepare(tx, context, stored.input);
      this.assertReady(current.preview, row.sourceFingerprint);
      return current;
    });
    if (basis.preview.adapter === "printeque_factory") await this.delivery.verifyDocumentFiles(context, basis.productionPins);
    return this.transaction(context, read, async tx => {
      const row = await this.receipt(tx, id), stored = this.stored(row);
      const current = await this.prepare(tx, context, stored.input);
      this.assertReady(current.preview, row.sourceFingerprint);
      const body = Buffer.from(stored.base64, "base64");
      if (body.byteLength !== row.byteSize || sha(body) !== row.fileChecksum) { body.fill(0); throw new ConflictException("导出文件完整性校验失败"); }
      await this.audit.recordInTransaction(tx, context, { action: "logistics.documents.downloaded", resourceType: "logistics_document_export", resourceId: id, result: "success", metadata: { checksum: row.fileChecksum } });
      return { body, name: `${row.adapter}-${id}.xlsx` };
    });
  }

  /** Internal manual-label adapter port; sources still pass this module's current export gates. */
  async currentExportInTransaction(tx: TenantTransaction, context: TenantContext, id: string, orderId: string) {
    const receipt = await this.receipt(tx, id), stored = this.stored(receipt);
    if (!stored.input.orderIds.includes(orderId) || stored.input.adapter !== "yunexpress") throw new ConflictException("请选择包含此订单的云途导出记录");
    const batch = await this.prepare(tx, context, stored.input);
    this.assertReady(batch.preview, receipt.sourceFingerprint);
    const input = { ...stored.input, orderIds: [orderId], overrides: stored.input.overrides.filter(value => value.orderId === orderId) };
    return { receipt, input, ...await this.prepare(tx, context, input) };
  }
  currentSelectionInTransaction(tx: TenantTransaction, context: TenantContext, input: PreviewOrderDocuments) { return this.prepare(tx, context, input); }

  private async prepare(tx: TenantTransaction, context: TenantContext, input: PreviewOrderDocuments) {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.id, input.profileVersionId));
    if (!profile) throw new NotFoundException("工厂导单配置不存在");
    await logisticsLock(tx, context, `document-profile:${profile.factoryId}`);
    const [latest] = await tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.factoryId, profile.factoryId)).orderBy(desc(profiles.versionNumber)).limit(1);
    if (latest?.id !== profile.id) throw new ConflictException("工厂包裹配置已更新 请使用最新版本");
    const factory = await this.factory(tx, profile.factoryId);
    if (factory.factory.status !== "active" || factory.version.id !== profile.factoryVersionId)
      throw new ConflictException("工厂档案未启用或版本已变化 请先核对并保存导单配置");
    const origin = factory.version.profile.pickupAddress ?? factory.version.profile.productionAddress;
    if (!origin || origin.countryCode !== profile.profile.originCountryCode) throw new ConflictException("实际发货地与导单配置不一致");
    if (input.adapter !== "printeque_factory" && input.deliveryPackageIds.length) throw new ConflictException("物流表无需选择生产交付包");
    if (input.adapter === "printeque_factory" && !input.deliveryPackageIds.length) throw new ConflictException("请先在生产中心建立正式交付包 再选择生成工厂生产表");
    const productionPins = input.adapter === "printeque_factory" ? await this.delivery.documentItemsInTransaction(tx, context, input.deliveryPackageIds) : [];
    const sources: Array<Awaited<ReturnType<OrderDocumentSourceReader["read"]>>> = [];
    for (const orderId of [...input.orderIds].sort()) sources.push(await new OrderDocumentSourceReader(this.vault).read(tx, context, orderId));
    if (productionPins.some(pin => !sources.some(source => source.source.lines.some(line => line.id === pin.orderLineId))))
      throw new ConflictException("交付包包含本次未选择订单的商品 请按交付包选择完整订单");
    const planned = sources.map(source => {
      const blockers = [...source.blockers];
      if (source.production.some(item => !["cancelled", "failed"].includes(item.status) && item.factoryId !== profile.factoryId)) blockers.push("本单已有其他工厂的生产安排 请先到生产中心核对整单工厂");
      for (const line of source.source.lines) {
        const pin = productionPins.find(item => item.orderLineId === line.id);
        if (!pin) continue;
        if (pin.factory?.factoryId !== profile.factoryId || pin.quantity !== line.quantity) blockers.push(`商品 ${line.externalLineId} 的正式生产工厂或数量与本次导单不符`);
        else line.productionFileSku = posix.basename(pin.file.path, posix.extname(pin.file.path));
      }
      const plan = planOrderDocument(input.adapter, source.source, profile.profile, input.overrides.find(item => item.orderId === source.source.id));
      return { ...plan, blockers: [...new Set([...blockers, ...plan.blockers])] };
    });
    const fingerprint = hash({ version: 1, profileVersionId: profile.id, factoryVersionId: factory.version.id, adapter: input.adapter,
      template: await documentTemplateChecksum(input.adapter), sources: sources.map(source => ({ id: source.source.id, fingerprint: source.fingerprint })),
      overrides: [...input.overrides].sort((a, b) => a.orderId.localeCompare(b.orderId)), deliveryPackageIds: [...input.deliveryPackageIds].sort(),
      productionPins: productionPins.map(pin => ({ line: pin.orderLineId, version: pin.productionVersionId, file: pin.file.checksum, path: pin.file.path })), rows: planned.map(plan => plan.rows) });
    const preview: OrderDocumentsPreview = { fingerprint, adapter: input.adapter, factoryName: factory.factory.name,
      profileVersionId: profile.id, orders: planned, ready: planned.every(order => order.blockers.length === 0), rowCount: planned.reduce((total, order) => total + order.rows.length, 0) };
    return { preview, sources, productionPins, profile, expiresAt: new Date(Math.min(...sources.map(source => source.expiresAt.getTime()))) };
  }

  private async factory(tx: TenantTransaction, id: string) {
    const [result] = await tx.select({ factory: factories, version: factoryVersions }).from(factories)
      .innerJoin(factoryVersions, and(eq(factoryVersions.factoryId, factories.id), eq(factoryVersions.versionNumber, factories.currentVersionNumber)))
      .where(eq(factories.id, id)).for("share", { of: factories });
    if (!result) throw new NotFoundException("工厂不存在或无权访问");
    return result;
  }
  private async receipt(tx: TenantTransaction, id: string) {
    const [row] = await tx.select().from(exports).where(eq(exports.id, id)).for("share");
    if (!row) throw new NotFoundException("导出记录不存在或无权访问");
    return row;
  }
  private stored(row: Receipt): StoredFile {
    if (!row.encryptedSnapshot || row.expiresAt <= new Date()) throw new ConflictException("导出资料已到期或清理");
    const value = this.vault.withSecret(row.encryptedSnapshot, secret => JSON.parse(secret) as StoredFile);
    if (value.version !== 1 || typeof value.base64 !== "string" || value.base64.length > 14_000_000) throw new ConflictException("导出资料格式错误");
    return { ...value, input: PreviewOrderDocumentsSchema.parse(value.input) };
  }
  private assertReady(preview: OrderDocumentsPreview, expected: string) {
    if (preview.fingerprint !== expected) throw new ConflictException("订单、地址、规格或工厂版本已变化 请重新预览后生成");
    if (!preview.ready || !preview.rowCount) throw new ConflictException("存在待核对项目 请先处理预览中的提示");
  }
  private recordDownloadIntent(tx: TenantTransaction, context: TenantContext, id: string, reused: boolean) {
    return this.audit.recordInTransaction(tx, context, { action: "logistics.documents.generated", resourceType: "logistics_document_export", resourceId: id, result: "success", metadata: { reused } });
  }
  private transaction<T>(context: TenantContext, permissions: typeof read, work: (tx: TenantTransaction) => Promise<T>) {
    return originalOwnerOperation(() => withOrderAuthority(this.database.db, context, permissions, work));
  }
}
