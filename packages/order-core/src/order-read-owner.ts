import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { ListOrdersInputSchema,OrderViewSchema,type ListOrdersInput,type OrderView } from "@yummyai/contracts/order/order";
import { orderLines,orders,withTenant,type DatabaseConnection } from "@yummyai/database";
import { and,asc,desc,eq,inArray,isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { withOrderAuthority } from "./order-authority.js";
export class OrderReadOwner {constructor(private readonly database:DatabaseConnection){}
/** Narrow metadata ABI: zero-event legacy rows never enter the positive OrderView ABI. */
async fulfillmentCandidates(context: TenantContext, rawInput: ListOrdersInput) {
    const input = ListOrdersInputSchema.parse(rawInput);
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const rows = await tx.select({ id: orders.id, label: orders.externalOrderId, expectedSequence: orders.latestEventSequence,
        lineId: sql<string | null>`(select l.id from order_lines l where l.order_id = ${orders.id} order by l.created_at, l.id limit 1)` })
        .from(orders).where(and(input.accountId ? eq(orders.accountId, input.accountId) : undefined,
          input.workflowState ? eq(orders.workflowState, input.workflowState) : undefined,
          input.sideState === "none" ? isNull(orders.sideState) : input.sideState ? eq(orders.sideState, input.sideState) : undefined,
          input.platform ? eq(orders.platform, input.platform) : undefined)).orderBy(desc(orders.placedAt), desc(orders.id)).limit(input.limit);
      return { items: rows.filter(row => row.expectedSequence > 0), unavailableCount: rows.filter(row => row.expectedSequence <= 0).length, atLimit: rows.length >= input.limit };
    });
  }
async list(context: TenantContext, rawInput: ListOrdersInput): Promise<OrderView[]> {
    const input = ListOrdersInputSchema.parse(rawInput);
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(orders).where(and(
      input.accountId ? eq(orders.accountId, input.accountId) : undefined,
      input.workflowState ? eq(orders.workflowState, input.workflowState) : undefined,
      input.sideState === "none" ? isNull(orders.sideState) : input.sideState ? eq(orders.sideState, input.sideState) : undefined,
      input.platform ? eq(orders.platform, input.platform) : undefined,
    )).orderBy(desc(orders.placedAt), desc(orders.id)).limit(input.limit));
    return this.withLines(context, rows);
  }
async get(context: TenantContext, orderId: string): Promise<OrderView> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(orders).where(eq(orders.id, orderId)).limit(1));
    if (!row) throw new OriginalOwnerError(404, "Order not found");
    return (await this.withLines(context, [row]))[0]!;
  }
private async withLines(context: TenantContext, rows: Array<typeof orders.$inferSelect>): Promise<OrderView[]> {
    if (!rows.length) return [];
    const lines = await withTenant(this.database.db, context, (tx) => tx.select().from(orderLines).where(inArray(orderLines.orderId, rows.map((row) => row.id))).orderBy(asc(orderLines.createdAt), asc(orderLines.id)));
    const byOrder = new Map<string, Array<typeof orderLines.$inferSelect>>();
    for (const line of lines) byOrder.set(line.orderId, [...(byOrder.get(line.orderId) ?? []), line]);
    return rows.map((row) => toOrderView(row, byOrder.get(row.id) ?? []));
  }
}
function toOrderView(row: typeof orders.$inferSelect, lines: Array<typeof orderLines.$inferSelect>): OrderView {
  return OrderViewSchema.parse({
    id: row.id, accountId: row.accountId, platform: row.platform, externalOrderId: row.externalOrderId,
    providerStatus: row.providerStatus, workflowState: row.workflowState, sideState: row.sideState,
    orderTotal: row.orderTotalMinor === null ? null : { amountMinor: row.orderTotalMinor, currency: row.orderCurrency }, lineCount: row.lineCount,
    address: { status: row.addressStatus, countryCode: row.addressCountryCode }, latestEventSequence: row.latestEventSequence,
    placedAt: row.placedAt.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lines: lines.map((line) => ({ id: line.id, externalLineId: line.externalLineId, externalListingId: line.externalListingId, skuCode: line.skuCode, title: line.title, quantity: line.quantity, unitPrice: line.unitPriceMinor === null ? null : { amountMinor: line.unitPriceMinor, currency: line.unitPriceCurrency }, customizationCount: line.customizationCount })),
  });
}
