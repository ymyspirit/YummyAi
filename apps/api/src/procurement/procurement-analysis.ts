import { BadRequestException, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
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
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

export function readProcurementAnalysis(
  database: DatabaseConnection,
  context: TenantContext,
  stockItemId: string,
  locationId: string,
) {
  authorize(context, Permission.ProcurementRead);
  authorize(context, Permission.InventoryRead);
  return withTenant(
    database.db,
    context,
    async (tx) => {
      const [stock] = await tx
        .select({
          id: inventoryStockItems.id,
          code: inventoryStockItems.code,
          name: inventoryStockItems.name,
          unit: inventoryStockItems.baseUnit,
          status: inventoryStockItems.status,
        })
        .from(inventoryStockItems)
        .where(eq(inventoryStockItems.id, stockItemId));
      const [location] = await tx
        .select({
          id: inventoryLocations.id,
          code: inventoryLocations.code,
          name: inventoryLocations.name,
          status: inventoryLocations.status,
        })
        .from(inventoryLocations)
        .where(eq(inventoryLocations.id, locationId));
      if (!stock || !location) throw new NotFoundException("货品或库位不存在");
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
              received: sql<number>`sum(${inventoryProcurementReceiptLines.receivedQuantity})::bigint`,
              rejected: sql<number>`sum(${inventoryProcurementReceiptLines.rejectedQuantity})::bigint`,
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
            .groupBy(inventoryProcurementReceipts.purchaseOrderId)
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
        .where(
          and(
            eq(inventoryProcurementRfqs.status, "open"),
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
      const latest = new Map<string, (typeof quotes)[number]>();
      for (const q of quotes) {
        const key = `${q.quote.rfqId}:${q.supplier.id}`;
        if (!latest.has(key) || latest.get(key)!.quote.versionNumber < q.quote.versionNumber)
          latest.set(key, q);
      }
      return {
        stock,
        location,
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
          const receipt = receipts.find((r) => r.orderId === order.id);
          const lines = version.lineSnapshot.filter(
            (l) => l.stockItemId === stockItemId && l.destinationLocationId === locationId,
          );
          const quantity = lines.reduce((n, l) => n + l.quantity, 0),
            received = Number(receipt?.received ?? 0),
            rejected = Number(receipt?.rejected ?? 0);
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
            remaining: Math.max(0, quantity - received - rejected),
            units: [...new Set(lines.map((l) => l.unit))],
          };
        }),
        quotes: [...latest.values()].flatMap(({ quote, request, supplier }) =>
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
