import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { createEntityId, type InventoryUnit, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { RecordProductionMaterialSchema, ProductionMaterialEntrySchema, ProductionMaterialsQuerySchema,
  ProductionMaterialsWorkspaceSchema, measuredQuantityExceedsPlan } from "@yummyai/contracts/order/material-execution";
import { ProductionMaterialStockQuerySchema, ProductionMaterialStockOptionsSchema, ProductionMaterialReservationQuerySchema,
  ProductionMaterialReservationOptionsSchema } from "@yummyai/contracts/order/material-execution";
import { addStockQuantity, compareStockQuantity, stockQuantityMatchesUnit, stockQuantityValue, subtractStockQuantity, type StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { currentOrderAuthority, hasTenantOrderPermissions } from "@yummyai/order-core";
import { orders, productionOrders, productionOrderVersions, productionManufacturingBindings, productionMaterialEntries, productionMaterialCommands,
  inventoryReservations, inventoryLocations, inventoryWarehouses, inventoryStockItems, inventoryLots,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { readVerifiedManufacturingBasis } from "./production-manufacturing-delivery.js";

type Entry = typeof productionMaterialEntries.$inferSelect;
const readPermissions = [Permission.OrderRead, Permission.InventoryRead];
const writePermissions = [...readPermissions, Permission.OrderWrite, Permission.InventoryWrite];
const reversible = ["release", "return", "factory_correction"];
const closed = ["completed", "cancel_requested", "cancelled", "failed"];

@Injectable()
export class ProductionMaterialService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  workspace(context: TenantContext, productionOrderId: string, raw: unknown = {}) {
    const query = ProductionMaterialsQuerySchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, readPermissions, { lock: false, requireMembership: true });
      const { production, version } = await source(tx, productionOrderId);
      const binding = query.bindingId ? await this.binding(tx, productionOrderId, query.bindingId) :
        await readVerifiedManufacturingBasis(tx, version.id);
      const canWrite = hasTenantOrderPermissions(authority, writePermissions), contextAuthority = catalogContextAuthority(authority);
      if (!binding) return ProductionMaterialsWorkspaceSchema.parse({ contextAuthority, productionOrderId, productionRevision: production.projectionVersion,
        productionStatus: production.status, bindingId: null, sourceContentChecksum: null, currentBinding: false, canWrite: false,
        diagnostics: ["原生产没有固定制造依据 不使用今天的BOM补填历史"], nextCursor: null, lines: [], entries: [] });
      const [totals, rows] = await Promise.all([materialTotals(tx, binding.binding.id),
        tx.select().from(productionMaterialEntries).where(and(eq(productionMaterialEntries.productionOrderId, productionOrderId),
          eq(productionMaterialEntries.bindingId, binding.binding.id), query.beforeId ? lt(productionMaterialEntries.id, query.beforeId) : undefined))
          .orderBy(desc(productionMaterialEntries.id)).limit(51)]);
      return ProductionMaterialsWorkspaceSchema.parse({ contextAuthority, productionOrderId, productionRevision: production.projectionVersion,
        productionStatus: production.status, bindingId: binding.binding.id, sourceContentChecksum: binding.binding.contentChecksum,
        currentBinding: binding.binding.productionVersionId === version.id, canWrite, diagnostics: [],
        lines: binding.demand.lines.map(line => ({ code: line.code, name: line.name, stockItemId: line.stockItemId, unit: line.unit,
          responsibility: line.responsibility, plannedNumerator: line.exactNumerator, plannedDenominator: line.exactDenominator,
          actualNetQuantity: totals.actual.get(line.code) ?? 0, outstandingReservedQuantity: totals.reserved.get(line.code) ?? 0,
          actualSource: line.responsibility === "merchant" ? "merchant_inventory" : "manual_factory_report" })),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
        entries: await Promise.all(rows.slice(0, 50).map(row => this.view(tx, context, row))) });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  receipt(context: TenantContext, productionOrderId: string, idempotencyKey: string) {
    return withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, readPermissions, { lock: false, requireMembership: true });
      await source(tx, productionOrderId);
      const [row] = await tx.select().from(productionMaterialEntries).where(and(eq(productionMaterialEntries.productionOrderId, productionOrderId),
        eq(productionMaterialEntries.idempotencyKey, idempotencyKey), eq(productionMaterialEntries.createdBy, context.userId)));
      if (!row) throw new NotFoundException("尚未找到原提交回执 请保留原请求编号核对");
      return { ...await this.view(tx, authority, row), contextAuthority: catalogContextAuthority(authority) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  stockOptions(context: TenantContext, productionOrderId: string, raw: unknown) {
    const query = ProductionMaterialStockQuerySchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, readPermissions, { lock: false, requireMembership: true });
      const basis = await this.binding(tx, productionOrderId, query.bindingId), line = basis.demand.lines.find(value => value.code === query.materialCode);
      if (!line || line.responsibility !== "merchant") throw new ConflictException("请核对原商家供料BOM行");
      if ([query.after, query.selected].some(value => value && !value.startsWith(line.stockItemId + ":"))) throw new ConflictException("库存游标与原物料不一致");
      return ProductionMaterialStockOptionsSchema.parse({ ...await this.inventory.materialStockOptionsInTransaction(tx, line.stockItemId, query.after, query.selected),
        productionOrderId, bindingId: query.bindingId, materialCode: query.materialCode, stockItemId: line.stockItemId, unit: line.unit, contextAuthority: catalogContextAuthority(authority) });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  entry(context: TenantContext, productionOrderId: string, entryId: string) {
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, readPermissions, { lock: false, requireMembership: true });
      await source(tx, productionOrderId);
      const entry = await this.entryInTransaction(tx, current, entryId);
      if (entry.productionOrderId !== productionOrderId) throw new NotFoundException("原生产物料记录不存在");
      return { ...entry, contextAuthority: catalogContextAuthority(current) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  reservationOptions(context: TenantContext, productionOrderId: string, raw: unknown) {
    const query = ProductionMaterialReservationQuerySchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, readPermissions, { lock: false, requireMembership: true });
      const basis = await this.binding(tx, productionOrderId, query.bindingId), line = basis.demand.lines.find(value => value.code === query.materialCode);
      if (!line || line.responsibility !== "merchant") throw new ConflictException("请核对原商家供料BOM行");
      const remaining = sql`(${inventoryReservations.quantity}+coalesce((select sum(re.quantity_delta) from inventory_reservation_events re
        where re.tenant_id=${inventoryReservations.tenantId} and re.reservation_id=${inventoryReservations.id} and re.action='consumed'),0))`;
      const select = () => tx.select({ entryId: productionMaterialEntries.id, reservationId: inventoryReservations.id, locationId: inventoryLocations.id,
        locationName: inventoryLocations.name, warehouseName: inventoryWarehouses.name, lotId: inventoryReservations.lotId, lotCode: inventoryLots.code,
        remainingQuantity: sql<string>`${remaining}::text`, unit: inventoryReservations.unit,
        dimensionActive: sql<boolean>`${inventoryLocations.status}='active' and ${inventoryWarehouses.status}='active' and ${inventoryStockItems.status}='active'` })
        .from(productionMaterialEntries).innerJoin(inventoryReservations, eq(inventoryReservations.id, productionMaterialEntries.reservationId))
        .innerJoin(inventoryLocations, eq(inventoryLocations.id, inventoryReservations.locationId)).innerJoin(inventoryWarehouses, eq(inventoryWarehouses.id, inventoryLocations.warehouseId))
        .innerJoin(inventoryStockItems, eq(inventoryStockItems.id, inventoryReservations.stockItemId)).leftJoin(inventoryLots, eq(inventoryLots.id, inventoryReservations.lotId));
      const filter = and(eq(productionMaterialEntries.bindingId, query.bindingId), eq(productionMaterialEntries.materialCode, query.materialCode), eq(productionMaterialEntries.kind, "reserve"), eq(inventoryReservations.status, "active"), gt(remaining, 0));
      const rows = await select().where(and(filter, query.after ? gt(productionMaterialEntries.id, query.after) : undefined)).orderBy(asc(productionMaterialEntries.id)).limit(26);
      const selected = query.selected ? await select().where(and(filter, eq(productionMaterialEntries.id, query.selected))).limit(1) : [];
      return ProductionMaterialReservationOptionsSchema.parse({ productionOrderId, bindingId: query.bindingId, materialCode: query.materialCode, stockItemId: line.stockItemId, unit: line.unit,
        contextAuthority: catalogContextAuthority(authority), items: rows.slice(0, 25), selected, nextCursor: rows.length > 25 ? rows[24]!.entryId : null });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async record(context: TenantContext, productionOrderId: string, raw: unknown) {
    const input = RecordProductionMaterialSchema.parse(raw);
    return withTenant(this.database.db, context, tx => this.recordInTransaction(tx, context, productionOrderId, input));
  }

  /** Called by the admitted material command in its existing tenant transaction. */
  async recordInTransaction(tx: TenantTransaction, context: TenantContext, productionOrderId: string, raw: unknown, commandId?: string) {
    const input = RecordProductionMaterialSchema.parse(raw), requestChecksum = hash(canonicalJson(input));
    const authority = await currentOrderAuthority(tx, context, writePermissions, { requireMembership: true });
    const [owner] = await tx.select({ orderId: productionOrders.orderId }).from(productionOrders).where(eq(productionOrders.id, productionOrderId));
    if (!owner) throw new NotFoundException("Production order not found");
    await lock(tx, owner.orderId);
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, owner.orderId)).for("update");
    await lock(tx, "production-order:" + productionOrderId);
    const [previous] = await tx.select().from(productionMaterialEntries).where(and(eq(productionMaterialEntries.productionOrderId, productionOrderId), eq(productionMaterialEntries.idempotencyKey, input.idempotencyKey)));
    if (previous) {
      if (previous.createdBy !== context.userId || previous.requestChecksum !== requestChecksum) throw new ConflictException("原耗用请求编号的操作员或正文发生变化 请先核对原回执");
      return { entry: await this.view(tx, authority, previous), replayed: true, contextAuthority: catalogContextAuthority(authority) };
    }
    const [admission] = await tx.select({ command: productionMaterialCommands, expired: sql<boolean>`expires_at<=clock_timestamp()` }).from(productionMaterialCommands)
      .where(and(eq(productionMaterialCommands.productionOrderId, productionOrderId), eq(productionMaterialCommands.requestKey, input.idempotencyKey))).for("update");
    if (admission) {
      const row = admission.command;
      if (!commandId || row.id !== commandId || row.status !== "prepared" || admission.expired || row.createdBy !== authority.userId || row.requestChecksum !== requestChecksum)
        throw new ConflictException("请从原待确认物料提交恢复 已取消或过期的编号不能重新执行");
      await tx.execute(sql`select set_config('app.material_command_id', ${commandId}, true)`);
    } else if (commandId) throw new ConflictException("原物料提交的执行依据不存在");
    const [pending] = await tx.select({ id: productionMaterialCommands.id }).from(productionMaterialCommands).where(and(
      eq(productionMaterialCommands.productionOrderId, productionOrderId), eq(productionMaterialCommands.createdBy, authority.userId), isNull(productionMaterialCommands.acknowledgedAt)));
    if (pending && pending.id !== commandId) throw new ConflictException("请先核对原待确认物料提交");
    const { basis, line } = await this.validateCommandInTransaction(tx, authority, productionOrderId, input);
    let original: Entry | undefined;
    const originalId = "originalEntryId" in input ? input.originalEntryId : input.kind === "consume" ? input.reservationEntryId : null;
    if (originalId) {
      [original] = await tx.select().from(productionMaterialEntries).where(eq(productionMaterialEntries.id, originalId));
      const kind = input.kind === "return" ? "consume" : input.kind === "factory_correction" ? "factory_report" : "reserve";
      if (!original || original.productionOrderId !== productionOrderId || original.bindingId !== input.bindingId || original.materialCode !== input.materialCode || original.kind !== kind)
        throw new ConflictException("请使用同一原生产BOM行的实际记录");
    }
    let quantity: StockQuantity = "quantity" in input ? input.quantity : 0;
    let reservationId: string | null = null, movementId: string | null = null;
    let locationId: string | null = "locationId" in input ? input.locationId : original?.locationId ?? null;
    let lotId: string | null = "lotId" in input ? input.lotId : original?.lotId ?? null;
    if (input.kind === "release") {
      const state = await this.inventory.reservationStateInTransaction(tx, authority, original!.reservationId!);
      quantity = state.remainingQuantity; reservationId = state.reservation.id;
      if (compareStockQuantity(quantity, 0) <= 0) throw new ConflictException("原预留没有待释放余量 请核对已有释放或耗用回执");
      await this.inventory.releaseReservationInTransaction(tx, authority, reservationId, { expectedVersion: state.reservation.version, outcome: "released", reasonCode: "PRODUCTION_UNUSED", idempotencyKey: input.idempotencyKey });
    }
    if (!stockQuantityMatchesUnit(quantity, line.unit)) throw new ConflictException("原计数单位只能登记整件 整对或整套");
    if (input.kind === "return" || input.kind === "factory_correction") {
      const [sum] = await tx.select({ quantity: sql<string>`coalesce(sum(${productionMaterialEntries.quantity}),0)::text` }).from(productionMaterialEntries)
        .where(and(eq(productionMaterialEntries.originalEntryId, original!.id), eq(productionMaterialEntries.kind, input.kind)));
      if (compareStockQuantity(addStockQuantity(sum!.quantity, quantity), original!.quantity) > 0) throw new ConflictException("累计更正不能超过原实际数量");
    }
    if (["reserve", "consume", "factory_report"].includes(input.kind)) {
      const totals = await materialTotals(tx, input.bindingId);
      const claimed = addStockQuantity(addStockQuantity(totals.actual.get(line.code) ?? 0, input.kind === "reserve" ? totals.reserved.get(line.code) ?? 0 : 0), quantity);
      if (measuredQuantityExceedsPlan(claimed, line.exactNumerator, line.exactDenominator) && !input.reason) throw new ConflictException("累计数量超过原BOM精确计划 请填写偏差原因");
    }
    const id = createEntityId(), stockKey = `production-material:${id}`;
    if (input.kind === "reserve") {
      reservationId = await this.inventory.createReservationInTransaction(tx, authority, { stockItemId: line.stockItemId, locationId: locationId!, lotId,
        quantity, unit: line.unit, sourceType: "order_line", sourceId: basis.binding.orderLineId, expiresAt: null, idempotencyKey: stockKey });
    } else if (input.kind === "consume" || input.kind === "return") {
      reservationId = input.kind === "consume" ? original?.reservationId ?? null : null;
      if (original && input.kind === "consume" && (locationId !== original.locationId || lotId !== original.lotId)) throw new ConflictException("耗用必须使用原预留的库位与批次");
      if (input.kind === "return") { locationId = original!.locationId; lotId = original!.lotId; }
      const stock = await this.inventory.productionMaterialStockInTransaction(tx, authority, { kind: input.kind, stockItemId: line.stockItemId,
        locationId: locationId!, lotId, quantity, unit: line.unit as InventoryUnit, reservationId,
        sourceLineId: basis.binding.orderLineId, occurredAt: input.occurredAt, idempotencyKey: stockKey });
      movementId = stock.movement.id;
    }
    const [entry] = await tx.insert(productionMaterialEntries).values({ id, tenantId: authority.tenantId, productionOrderId, bindingId: input.bindingId,
      materialCode: line.code, stockItemId: line.stockItemId, unit: line.unit, kind: input.kind, quantity, locationId, lotId, reservationId, movementId,
      originalEntryId: original?.id ?? null, reportReference: input.kind === "factory_report" ? input.reportReference : null,
      encryptedReason: input.reason ? this.vault.encrypt(input.reason) : null, idempotencyKey: input.idempotencyKey, requestChecksum,
      createdBy: authority.userId, occurredAt: new Date(input.occurredAt) }).returning();
    await this.audit.recordInTransaction(tx, authority, { action: `production_material.${input.kind}`, resourceType: "production_material_entry", resourceId: id,
      result: "success", metadata: { productionOrderId, bindingId: input.bindingId, movementId, reservationId } });
    return { entry: await this.view(tx, authority, entry!), replayed: false, contextAuthority: catalogContextAuthority(authority) };
  }

  async validateCommandInTransaction(tx: TenantTransaction, context: TenantContext, productionOrderId: string, raw: unknown) {
    const input = RecordProductionMaterialSchema.parse(raw);
    const authority = await currentOrderAuthority(tx, context, writePermissions, { requireMembership: true });
    if (input.contextAuthority !== catalogContextAuthority(authority)) throw new ConflictException({ code: "authority_changed", message: "当前账号或权限已经变化 请重新核对原生产资料" });
    const { production, version } = await source(tx, productionOrderId);
    if (production.projectionVersion !== input.expectedProductionRevision) throw new ConflictException("生产状态已变化 请重新核对后提交");
    const basis = await this.binding(tx, productionOrderId, input.bindingId);
    const line = basis.demand.lines.find(value => value.code === input.materialCode);
    if (!line) throw new ConflictException("物料不属于原生产BOM");
    if ("quantity" in input && !stockQuantityMatchesUnit(input.quantity, line.unit)) throw new ConflictException("原计数单位只能登记整件 整对或整套");
    if (!reversible.includes(input.kind) && basis.binding.productionVersionId !== version.id) throw new ConflictException("新增备料及耗用必须核对当前生产版本 已有事实请从原记录更正");
    if (input.kind === "reserve" && closed.includes(production.status)) throw new ConflictException("当前生产状态不接受新增备料预留");
    if (closed.includes(production.status) && !reversible.includes(input.kind) && !input.reason) throw new ConflictException("已完工或停止生产的实际补记须说明原因");
    if (Date.parse(input.occurredAt) > Date.now() + 300_000) throw new ConflictException("实际发生时间不能晚于当前时间");
    const merchant = ["reserve", "consume", "release", "return"].includes(input.kind);
    if (line.responsibility !== (merchant ? "merchant" : "factory")) throw new ConflictException("供料责任与原BOM不一致 工厂自备材料只登记工厂报告");
    if ((input.kind === "return" || input.kind === "factory_correction") && !input.reason) throw new ConflictException("更正必须说明原事实及更正原因");
    return { production, version, basis, line };
  }

  async entryInTransaction(tx: TenantTransaction, context: TenantContext, entryId: string) {
    await currentOrderAuthority(tx, context, readPermissions, { lock: false, requireMembership: true });
    const [entry] = await tx.select().from(productionMaterialEntries).where(eq(productionMaterialEntries.id, entryId));
    if (!entry) throw new NotFoundException("原物料回执不存在");
    return this.view(tx, context, entry);
  }

  private async binding(tx: TenantTransaction, productionOrderId: string, bindingId: string) {
    const [row] = await tx.select().from(productionManufacturingBindings).where(and(eq(productionManufacturingBindings.id, bindingId), eq(productionManufacturingBindings.productionOrderId, productionOrderId)));
    if (!row) throw new NotFoundException("原生产制造依据不存在");
    const basis = await readVerifiedManufacturingBasis(tx, row.productionVersionId);
    if (!basis || basis.binding.id !== bindingId) throw new ConflictException("原生产制造依据不一致");
    return basis;
  }
  private async view(tx: TenantTransaction, context: TenantContext, row: Entry) {
    const remaining = row.kind === "reserve" && row.reservationId ?
      (await this.inventory.reservationStateInTransaction(tx, context, row.reservationId, false)).remainingQuantity : null;
    const [place] = row.locationId ? await tx.select({ locationName: inventoryLocations.name, warehouseName: inventoryWarehouses.name })
      .from(inventoryLocations).innerJoin(inventoryWarehouses, eq(inventoryWarehouses.id, inventoryLocations.warehouseId)).where(eq(inventoryLocations.id, row.locationId)) : [];
    const [lot] = row.lotId ? await tx.select({ code: inventoryLots.code }).from(inventoryLots).where(eq(inventoryLots.id, row.lotId)) : [];
    let correctable: StockQuantity | null = null;
    if (row.kind === "consume" || row.kind === "factory_report") {
      const [total] = await tx.select({ quantity: sql<string>`coalesce(sum(${productionMaterialEntries.quantity}),0)::text` }).from(productionMaterialEntries)
        .where(and(eq(productionMaterialEntries.originalEntryId, row.id), eq(productionMaterialEntries.kind, row.kind === "consume" ? "return" : "factory_correction")));
      correctable = subtractStockQuantity(row.quantity, total!.quantity);
    }
    return ProductionMaterialEntrySchema.parse({ id: row.id, bindingId: row.bindingId, productionOrderId: row.productionOrderId,
      materialCode: row.materialCode, kind: row.kind, quantity: row.quantity, unit: row.unit, locationId: row.locationId, lotId: row.lotId,
      reservationId: row.reservationId, movementId: row.movementId, originalEntryId: row.originalEntryId, remainingReservedQuantity: remaining,
      locationName: place?.locationName ?? null, warehouseName: place?.warehouseName ?? null, lotCode: lot?.code ?? null, correctableQuantity: correctable,
      reportReference: row.reportReference, reason: row.encryptedReason ? this.vault.withSecret(row.encryptedReason, value => value) : null,
      idempotencyKey: row.idempotencyKey, createdBy: row.createdBy, occurredAt: row.occurredAt.toISOString(), recordedAt: row.recordedAt.toISOString() });
  }
}

async function source(tx: TenantTransaction, productionOrderId: string) {
  const [row] = await tx.select({ production: productionOrders, version: productionOrderVersions }).from(productionOrders)
    .innerJoin(productionOrderVersions, and(eq(productionOrderVersions.productionOrderId, productionOrders.id), eq(productionOrderVersions.versionNumber, productionOrders.currentVersionNumber)))
    .where(eq(productionOrders.id, productionOrderId));
  if (!row) throw new NotFoundException("Production order not found");
  return row;
}
async function materialTotals(tx: TenantTransaction, bindingId: string) {
  const actualRows = await tx.select({ code: productionMaterialEntries.materialCode,
    quantity: sql<string>`coalesce(sum(case when kind in ('consume','factory_report') then quantity when kind in ('return','factory_correction') then -quantity else 0 end),0)::text` })
    .from(productionMaterialEntries).where(eq(productionMaterialEntries.bindingId, bindingId)).groupBy(productionMaterialEntries.materialCode);
  const reservedRows = await tx.execute<{ code: string; quantity: string }>(sql`select e.material_code as code,
    sum(r.quantity+coalesce((select sum(re.quantity_delta) from inventory_reservation_events re where re.tenant_id=r.tenant_id and re.reservation_id=r.id and re.action='consumed'),0))::text as quantity
    from production_material_entries e join inventory_reservations r on r.tenant_id=e.tenant_id and r.id=e.reservation_id
    where e.binding_id=${bindingId} and e.kind='reserve' and r.status='active' group by e.material_code`);
  return { actual: new Map(actualRows.map(row => [row.code, stockQuantityValue(row.quantity)])), reserved: new Map(reservedRows.map(row => [row.code, stockQuantityValue(row.quantity)])) };
}
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
