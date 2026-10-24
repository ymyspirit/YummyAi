import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { authorize, Permission, permissionScope } from "@yummyai/authz";
import { assertCatalogSpuAccess, catalogContextAuthority, currentCatalogContext } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import { NativeProductionDetailSchema, NativeProductionFactoryQuerySchema, NativeProductionQuerySchema, NativeProductionSourceQuerySchema,
  NativeProductionWorkspaceSchema, type NativeProductionLine } from "@yummyai/contracts/order/native-production";
import { orderLineCatalogLinks, orderLines, orderProtectedDetails, orderRoutingDecisions, orders, orderWorkItems, productionOrders,
  productionOrderVersions, productSpecifications, productSpecificationVersions, purchaseOrders, purchaseOrderVersions,
  fulfillmentSuppliers, skus, spus, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { currentOrderAuthority, withOrderAuthority } from "@yummyai/order-core";
import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { productionFactorySource } from "../catalog/manufacturing-production.js";
import { approvedDesignProductionChoices } from "../design/production-design-source.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { initialProductionAllocatedQuantity } from "./initial-production-quantity.js";
import { nativeProductionOrderSourceAvailable as protectedSource } from "./native-production-source.js";
import { parseRequestSchema } from "../request-schema.js";

const orderRead = [Permission.OrderRead, Permission.OrderPiiRead];
const noWork = sql`not exists (select 1 from ${orderWorkItems} where ${orderWorkItems.id}=${orderLines.id})`;

/** Normalized orders without a reviewed customer work item. No source is provisioned or approved here. */
@Injectable()
export class NativeProductionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(FactoryDirectoryService) private readonly factories: FactoryDirectoryService) {}

  workspace(context: TenantContext, raw: unknown) {
    const query = parseRequestSchema(NativeProductionQuerySchema, raw);
    return withOrderAuthority(this.database.db, context, orderRead, async tx => {
      const current = await currentOrderAuthority(tx, context, orderRead);
      const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await tx.select({ order: orders, line: orderLines }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId))
        .leftJoin(orderProtectedDetails, eq(orderProtectedDetails.orderId, orders.id))
        .where(and(protectedSource, noWork, query.after ? lt(orderLines.id, query.after) : undefined,
          query.q ? or(ilike(orders.externalOrderId, pattern), ilike(orderLines.title, pattern), ilike(orderLines.skuCode, pattern)) : undefined))
        .orderBy(desc(orderLines.id)).limit(26);
      const items = await Promise.all(rows.slice(0, 25).map(row => lineView(tx, row)));
      return NativeProductionWorkspaceSchema.parse({ items, nextCursor: rows.length > 25 ? items.at(-1)!.id : null,
        canCreate: canCreate(current), contextAuthority: catalogContextAuthority(current) });
    });
  }

  detail(context: TenantContext, lineId: string, raw: unknown) {
    const query = parseRequestSchema(NativeProductionSourceQuerySchema, raw);
    return withOrderAuthority(this.database.db, context, orderRead, async tx => {
      const current = await currentOrderAuthority(tx, context, orderRead), row = await nativeLine(tx, lineId);
      const line = await lineView(tx, row), sku = await nativeSku(tx, current, lineId), diagnostics = [...line.blockers];
      const specifications = sku ? await tx.select({ versionId: productSpecificationVersions.id, name: productSpecificationVersions.name,
        versionNumber: productSpecificationVersions.versionNumber }).from(productSpecifications)
        .innerJoin(productSpecificationVersions, and(eq(productSpecificationVersions.specificationId, productSpecifications.id),
          eq(productSpecificationVersions.versionNumber, productSpecifications.versionNumber))).where(eq(productSpecifications.spuId, sku.spuId))
        .orderBy(desc(productSpecificationVersions.id)) : [];
      let source: { specificationVersionId: string; productType: string } | null = null;
      let designs: Awaited<ReturnType<typeof approvedDesignProductionChoices>> = { items: [], truncated: false };
      if (!sku) diagnostics.push("本商品尚未关联实际产品 SKU 请先在订单模块完成关联");
      if (query.specificationVersionId) {
        if (!sku || !specifications.some(spec => spec.versionId === query.specificationVersionId)) throw new ConflictException("请选择本商品当前的完整产品规格");
        const basis = await productionFactorySource(tx, current, { kind: "approved_product_confirmation", specificationVersionId: query.specificationVersionId }, sku.id);
        source = { specificationVersionId: query.specificationVersionId, productType: basis.factoryBasis.productType };
        if (source.productType !== "rectangular_print") diagnostics.push("该产品须沿用已审核生产稿及其几何 不能从直接设计文件入口下达");
        else {
          const [spec] = await tx.select({ canvasPrintSpecVersionId: productSpecificationVersions.canvasPrintSpecVersionId }).from(productSpecificationVersions)
            .where(eq(productSpecificationVersions.id, query.specificationVersionId));
          designs = await approvedDesignProductionChoices(tx, current, { skuId: sku.id, spuId: sku.spuId, canvasPrintSpecVersionId: spec.canvasPrintSpecVersionId });
          if (!designs.items.length) diagnostics.push("尚无当前可读取且符合本规格的已审核设计及授权生产文件 请先完成设计审核");
        }
      }
      const routing = await nativeRoutes(tx, row.line);
      if (!routing.items.length) diagnostics.push("缺少本商品的已批准采购路由与当前采购单版本 请先完成采购审核");
      const productions = await tx.select({ id: productionOrders.id, status: productionOrders.status, quantity: productionOrderVersions.quantity,
        createdAt: productionOrders.createdAt }).from(productionOrders).innerJoin(productionOrderVersions,
        and(eq(productionOrderVersions.productionOrderId, productionOrders.id), eq(productionOrderVersions.versionNumber, productionOrders.currentVersionNumber)))
        .where(eq(productionOrders.orderLineId, lineId)).orderBy(desc(productionOrders.id));
      return NativeProductionDetailSchema.parse({ line, sku, specifications, source, designs: designs.items, designsTruncated: designs.truncated,
        routes: routing.items, routesTruncated: routing.truncated, productions: productions.map(item => ({ ...item, createdAt: item.createdAt.toISOString() })),
        canCreate: canCreate(current), contextAuthority: catalogContextAuthority(current), diagnostics });
    });
  }

  factoryChoices(context: TenantContext, lineId: string, raw: unknown) {
    const query = parseRequestSchema(NativeProductionFactoryQuerySchema, raw);
    return withOrderAuthority(this.database.db, context, orderRead, async tx => {
      const current = await currentOrderAuthority(tx, context, orderRead), row = await nativeLine(tx, lineId), sku = await nativeSku(tx, current, lineId);
      if (!sku) throw new ConflictException("请先关联实际产品 SKU");
      const requestedQuantity = query.quantity ?? row.line.quantity;
      if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1) throw new UnprocessableEntityException("请核对本次商品数量");
      const allocatedQuantity = await initialProductionAllocatedQuantity(tx, row.line.id);
      if (requestedQuantity > row.line.quantity - allocatedQuantity) throw new ConflictException("下达数量超过订单剩余数量");
      const routing = await nativeRoutes(tx, row.line), route = routing.items.find(item => item.routingDecisionId === query.routingDecisionId && item.purchaseOrderVersionId === query.purchaseOrderVersionId);
      if (!route) throw new ConflictException("原采购路由或当前采购单版本已不可用 请重新核对");
      const basis = await productionFactorySource(tx, current, { kind: "approved_product_confirmation", specificationVersionId: query.specificationVersionId }, sku.id);
      if (basis.factoryBasis.productType !== "rectangular_print") throw new ConflictException("该产品须从已审核生产稿安排生产");
      const choices = await this.factories.choices(current, { ...basis.factoryBasis, skuId: sku.id, quantity: requestedQuantity });
      return choices.filter(choice => choice.pin.supplierId === route.supplierId);
    });
  }
}

async function nativeLine(tx: TenantTransaction, lineId: string) {
  const [row] = await tx.select({ order: orders, line: orderLines }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId))
    .leftJoin(orderProtectedDetails, eq(orderProtectedDetails.orderId, orders.id)).where(and(eq(orderLines.id, lineId), protectedSource, noWork));
  if (!row) throw new NotFoundException("直接生产商品不存在 已进入审单 或资料已不可用");
  return row;
}
async function nativeSku(tx: TenantTransaction, input: TenantContext, lineId: string) {
  const current = await currentCatalogContext(tx, input); authorize(current, Permission.ProductRead);
  const [sku] = await tx.select({ id: skus.id, code: skus.code, spuId: spus.id, spuName: spus.name }).from(orderLineCatalogLinks)
    .innerJoin(skus, eq(skus.id, orderLineCatalogLinks.skuId)).innerJoin(spus, eq(spus.id, skus.spuId)).where(eq(orderLineCatalogLinks.orderLineId, lineId));
  if (sku) await assertCatalogSpuAccess(tx, current, sku.spuId, [Permission.ProductRead]);
  return sku ?? null;
}
async function lineView(tx: TenantTransaction, row: { order: typeof orders.$inferSelect; line: typeof orderLines.$inferSelect }): Promise<NativeProductionLine> {
  const allocatedQuantity = await initialProductionAllocatedQuantity(tx, row.line.id), blockers: string[] = [];
  if (row.order.workflowState !== "in_production") blockers.push("订单尚未进入可下达生产的阶段");
  if (row.order.sideState) blockers.push("订单已暂停或取消 请先核对处理状态");
  if (allocatedQuantity >= row.line.quantity) blockers.push(`已有 ${allocatedQuantity} 份原生产安排 不能重复下达整份订购数量`);
  return { id: row.line.id, orderId: row.order.id, orderNumber: row.order.externalOrderId, title: row.line.title, skuCode: row.line.skuCode,
    quantity: row.line.quantity, allocatedQuantity, workflowState: row.order.workflowState, blockers };
}
async function nativeRoutes(tx: TenantTransaction, line: typeof orderLines.$inferSelect) {
  const rows = await tx.select({ routingDecisionId: orderRoutingDecisions.id, purchaseOrderId: purchaseOrders.id,
    purchaseOrderVersionId: purchaseOrderVersions.id, purchaseVersionNumber: purchaseOrderVersions.versionNumber,
    supplierId: fulfillmentSuppliers.id, supplierName: fulfillmentSuppliers.name }).from(orderRoutingDecisions)
    .innerJoin(purchaseOrders, and(eq(purchaseOrders.orderId, orderRoutingDecisions.orderId), eq(purchaseOrders.supplierId, orderRoutingDecisions.selectedSupplierId)))
    .innerJoin(purchaseOrderVersions, and(eq(purchaseOrderVersions.purchaseOrderId, purchaseOrders.id), eq(purchaseOrderVersions.versionNumber, purchaseOrders.currentVersionNumber)))
    .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, purchaseOrders.supplierId))
    .where(and(eq(orderRoutingDecisions.orderLineId, line.id), eq(orderRoutingDecisions.orderId, line.orderId), eq(orderRoutingDecisions.status, "approved"), eq(purchaseOrders.status, "approved"),
      sql`${purchaseOrderVersions.routingDecisionIds} @> jsonb_build_array(${orderRoutingDecisions.id}::text)`,
      sql`${purchaseOrderVersions.lineSnapshot} @> jsonb_build_array(jsonb_build_object('orderLineId',${line.id}::text,'quantity',${line.quantity}::int))`))
    .orderBy(desc(purchaseOrderVersions.id), desc(orderRoutingDecisions.id)).limit(26);
  return { items: rows.slice(0, 25), truncated: rows.length > 25 };
}
function canCreate(current: TenantContext) { return current.permissions.includes(Permission.OrderWrite) && permissionScope(current, Permission.OrderWrite) === "tenant"; }
