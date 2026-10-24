import { subtractStockQuantity, sumStockQuantities, compareStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { convertProcurementQuantity, ProcurementUnitSchema } from "@yummyai/contracts/procurement/measurement";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { authorize, intersectPermissionContexts, permissionScope, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  fulfillmentSuppliers,
  inventoryBalances,
  inventoryLocations,
  inventoryStockItems,
  inventoryReplenishmentPolicies,
  inventoryReplenishmentPolicyVersions,
  inventoryPurchaseOrders,
  inventoryPurchaseOrderVersions,
  inventoryProcurementReceipts,
  inventoryProcurementReceiptLines,
  inventorySupplierQuoteVersions,
  inventoryProcurementRfqs,
  inventoryProcurementRequisitionVersions,
  inventoryProcurementRequisitions,
  loadCurrentMembershipContext,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export function readProcurementAnalysis(
  database: DatabaseConnection,
  context: TenantContext,
  stockItemId: string,
  locationId: string,
) {
  stockItemId = stockItemId.toLowerCase();
  locationId = locationId.toLowerCase();
  return withTenant(
    database.db,
    context,
    async (tx) => {
      // One read-only snapshot includes current membership and all cited facts.
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context));
      authorize(current, Permission.ProcurementRead);
      authorize(current, Permission.InventoryRead);
      const [clock] = await tx.execute<{ observedAt: string }>(sql`select clock_timestamp()::text as "observedAt"`);
      const [stock] = await tx
        .select({
          id: inventoryStockItems.id,
          code: inventoryStockItems.code,
          name: inventoryStockItems.name,
          unit: inventoryStockItems.baseUnit,
          status: inventoryStockItems.status,
          createdBy: inventoryStockItems.createdBy,
        })
        .from(inventoryStockItems)
        .where(eq(inventoryStockItems.id, stockItemId));
      const [location] = await tx
        .select({
          id: inventoryLocations.id,
          code: inventoryLocations.code,
          name: inventoryLocations.name,
          status: inventoryLocations.status,
          createdBy: inventoryLocations.createdBy,
        })
        .from(inventoryLocations)
        .where(eq(inventoryLocations.id, locationId));
      if (!stock || !location) throw new NotFoundException("货品或库位不存在");
      authorize(current, Permission.InventoryRead, { ownerId: stock.createdBy });
      authorize(current, Permission.InventoryRead, { ownerId: location.createdBy });
      const balances = await tx
        .select({
          id: inventoryBalances.id,
          physical: inventoryBalances.physicalQuantity,
          reserved: inventoryBalances.reservedQuantity,
          inTransit: inventoryBalances.inTransitQuantity,
          updatedAt: inventoryBalances.updatedAt,
        })
        .from(inventoryBalances)
        .where(
          and(
            eq(inventoryBalances.stockItemId, stockItemId),
            eq(inventoryBalances.locationId, locationId),
          ),
        )
        .orderBy(asc(inventoryBalances.id));
      const [policyRow] = await tx
        .select({
          policy: inventoryReplenishmentPolicies,
          version: inventoryReplenishmentPolicyVersions,
        })
        .from(inventoryReplenishmentPolicies)
        .innerJoin(
          inventoryReplenishmentPolicyVersions,
          and(
            eq(inventoryReplenishmentPolicyVersions.policyId, inventoryReplenishmentPolicies.id),
            eq(
              inventoryReplenishmentPolicyVersions.versionNumber,
              inventoryReplenishmentPolicies.currentVersion,
            ),
          ),
        )
        .where(
          and(
            eq(inventoryReplenishmentPolicies.stockItemId, stockItemId),
            eq(inventoryReplenishmentPolicies.locationId, locationId),
            eq(inventoryReplenishmentPolicies.status, "active"),
            procurementReadScope(current, Permission.ProcurementRead, inventoryReplenishmentPolicies.createdBy),
          ),
        );
      const purchaseRows = await tx
        .select({ order: inventoryPurchaseOrders, version: inventoryPurchaseOrderVersions })
        .from(inventoryPurchaseOrders)
        .innerJoin(
          inventoryPurchaseOrderVersions,
          and(
            eq(inventoryPurchaseOrderVersions.purchaseOrderId, inventoryPurchaseOrders.id),
            eq(
              inventoryPurchaseOrderVersions.versionNumber,
              inventoryPurchaseOrders.currentVersion,
            ),
          ),
        )
        .where(
          and(
            procurementReadScope(current, Permission.ProcurementRead, inventoryPurchaseOrders.createdBy),
            inArray(inventoryPurchaseOrders.status, [
              "draft",
              "approved",
              "partially_received",
              "reconciliation_required",
            ]),
            sql`exists (select 1 from jsonb_array_elements(${inventoryPurchaseOrderVersions.lineSnapshot}) l where l->>'stockItemId' = ${stockItemId} and l->>'destinationLocationId' = ${locationId})`,
          ),
        )
        .orderBy(asc(inventoryPurchaseOrders.id))
        .limit(101);
      if (purchaseRows.length > 100)
        throw new BadRequestException("该货品未完成采购超过 100 单，请先处理积压后分析");
      const receipts = purchaseRows.length
        ? await tx
            .select({
              orderId: inventoryProcurementReceipts.purchaseOrderId,
              received: inventoryProcurementReceiptLines.receivedQuantity,
              rejected: inventoryProcurementReceiptLines.rejectedQuantity,
              unit: inventoryProcurementReceiptLines.unit,
              stockUnit: inventoryProcurementReceiptLines.stockUnit,
              stockReceived: inventoryProcurementReceiptLines.stockReceivedQuantity,
              stockRejected: inventoryProcurementReceiptLines.stockRejectedQuantity,
            })
            .from(inventoryProcurementReceipts)
            .innerJoin(
              inventoryProcurementReceiptLines,
              eq(inventoryProcurementReceiptLines.receiptId, inventoryProcurementReceipts.id),
            )
            .where(
              and(
                inArray(
                  inventoryProcurementReceipts.purchaseOrderId,
                  purchaseRows.map((r) => r.order.id),
                ),
                eq(inventoryProcurementReceiptLines.stockItemId, stockItemId),
                eq(inventoryProcurementReceiptLines.destinationLocationId, locationId),
              ),
            )
        : [];
      // Match quote line keys against the immutable requisition version fixed by the RFQ.
      const quotes = await tx
        .select({
          quote: inventorySupplierQuoteVersions,
          request: inventoryProcurementRequisitionVersions,
          supplier: {
            id: fulfillmentSuppliers.id,
            name: fulfillmentSuppliers.name,
            status: fulfillmentSuppliers.status,
          },
        })
        .from(inventorySupplierQuoteVersions)
        .innerJoin(
          inventoryProcurementRfqs,
          eq(inventoryProcurementRfqs.id, inventorySupplierQuoteVersions.rfqId),
        )
        .innerJoin(
          inventoryProcurementRequisitionVersions,
          eq(
            inventoryProcurementRequisitionVersions.id,
            inventoryProcurementRfqs.requisitionVersionId,
          ),
        )
        .innerJoin(
          fulfillmentSuppliers,
          eq(fulfillmentSuppliers.id, inventorySupplierQuoteVersions.supplierId),
        )
        .innerJoin(inventoryProcurementRequisitions, eq(inventoryProcurementRequisitions.id, inventoryProcurementRfqs.requisitionId))
        .where(
          and(
            eq(inventoryProcurementRfqs.status, "open"),
            procurementReadScope(current, Permission.ProcurementRead, inventorySupplierQuoteVersions.createdBy),
            procurementReadScope(current, Permission.ProcurementRead, inventoryProcurementRfqs.createdBy),
            procurementReadScope(current, Permission.ProcurementRead, inventoryProcurementRequisitions.createdBy),
            procurementReadScope(current, Permission.ProcurementRead, fulfillmentSuppliers.createdBy),
            // An unreadable newer head must not make an old readable quote current.
            sql`not exists(select 1 from inventory_supplier_quote_versions head
              where head.tenant_id=${inventorySupplierQuoteVersions.tenantId}
              and head.rfq_id=${inventorySupplierQuoteVersions.rfqId} and head.supplier_id=${inventorySupplierQuoteVersions.supplierId}
              and head.version_number>${inventorySupplierQuoteVersions.versionNumber})`,
            sql`exists (select 1 from jsonb_array_elements(${inventoryProcurementRequisitionVersions.lineSnapshot}) l where l->>'stockItemId' = ${stockItemId} and l->>'destinationLocationId' = ${locationId})`,
          ),
        )
        .orderBy(
          desc(inventorySupplierQuoteVersions.createdAt),
          desc(inventorySupplierQuoteVersions.versionNumber),
          asc(inventorySupplierQuoteVersions.id),
        )
        .limit(101);
      if (quotes.length > 100)
        throw new BadRequestException("该货品询价版本超过本次上限，请先关闭过期询价");
      return {
        observedAt: new Date(clock!.observedAt).toISOString(),
        stock: { id: stock.id, code: stock.code, name: stock.name, unit: stock.unit, status: stock.status },
        location: { id: location.id, code: location.code, name: location.name, status: location.status },
        balances,
        policy: policyRow
          ? {
              id: policyRow.policy.id,
              versionId: policyRow.version.id,
              version: policyRow.version.versionNumber,
              reorderPoint: policyRow.version.reorderPoint,
              safetyStock: policyRow.version.safetyStock,
              minimumOrderQuantity: policyRow.version.minimumOrderQuantity,
              leadTimeDays: policyRow.version.leadTimeDays,
            }
          : null,
        purchases: purchaseRows.map(({ order, version }) => {
          const orderReceipts = receipts.filter((r) => r.orderId === order.id);
          const lines = version.lineSnapshot.filter(
            (l) => l.stockItemId === stockItemId && l.destinationLocationId === locationId,
          );
          const stockUnit = ProcurementUnitSchema.parse(stock.unit);
          let quantity, received, rejected;
          try {
            quantity = sumStockQuantities(lines.map(line => {
              if (line.stockBasis && line.stockBasis.stockUnit !== stockUnit) throw new RangeError("procurement_stock_basis_changed");
              return line.stockBasis?.stockQuantity ?? convertProcurementQuantity(line.quantity, line.unit, stockUnit);
            }));
            received = sumStockQuantities(orderReceipts.map(receipt => {
              if (receipt.stockUnit === stockUnit && receipt.stockReceived !== null) return receipt.stockReceived;
              return convertProcurementQuantity(receipt.received, ProcurementUnitSchema.parse(receipt.unit), stockUnit);
            }));
            rejected = sumStockQuantities(orderReceipts.map(receipt => {
              if (receipt.stockUnit === stockUnit && receipt.stockRejected !== null) return receipt.stockRejected;
              return convertProcurementQuantity(receipt.rejected, ProcurementUnitSchema.parse(receipt.unit), stockUnit);
            }));
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            throw new ConflictException({ code: "procurement_analysis_unit_basis_unavailable", message: "原采购或收货单位依据不完整 请先核对原版本" });
          }
          const remaining = subtractStockQuantity(quantity, sumStockQuantities([received, rejected]));
          return {
            id: order.id,
            code: order.code,
            status: order.status,
            purpose: order.purpose,
            versionId: version.id,
            version: version.versionNumber,
            expectedAt: version.expectedAt.toISOString(),
            quantity,
            received,
            rejected,
            remaining: compareStockQuantity(remaining, 0) < 0 ? 0 : remaining,
            units: [stockUnit],
          };
        }),
        quotes: quotes.flatMap(({ quote, request, supplier }) =>
          request.lineSnapshot
            .filter((l) => l.stockItemId === stockItemId && l.destinationLocationId === locationId)
            .flatMap((line) => {
              const price = quote.lineSnapshot.find((q) => q.lineKey === line.lineKey);
              return price
                ? [
                    {
                      id: quote.id,
                      requestVersionId: request.id,
                      supplierId: supplier.id,
                      supplierName: supplier.name,
                      supplierStatus: supplier.status,
                      version: quote.versionNumber,
                      currency: quote.currency,
                      validUntil: quote.validUntil.toISOString(),
                      requestedQuantity: line.quantity,
                      unit: line.unit,
                      ...price,
                    },
                  ]
                : [];
            }),
        ),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function procurementReadScope(context: TenantContext, permission: Permission, owner: AnyPgColumn) {
  if (!context.permissions.includes(permission)) return sql`false`;
  // These objects have no team binding; a team grant cannot invent one.
  return permissionScope(context, permission) === "tenant" ? undefined : eq(owner, context.userId);
}
