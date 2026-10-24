import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type NormalizeOrderInput, type OrderView, type TenantContext } from "@yummyai/contracts";
import {
  amazonOrderReportBatches, amazonOrderReportLines, connectDatabase, marketplaceAccounts,
  orderLines, orderSourceSnapshots, orders, withTenant,
} from "@yummyai/database";
import { normalizeAmazonOrder } from "@yummyai/marketplace-connectors";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";

describe("unknown order money database guards", () => {
  const database = connectDatabase();
  const contextA: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const accountId = createEntityId();
  const batchId = createEntityId();
  const expiresAt = new Date("2027-01-01T00:00:00Z");
  const service = new OrderService(database, new SecretVault(Buffer.alloc(32, 107)), new AuditService(database));

  beforeAll(async () => {
    // This suite deliberately relies on the acceptance runner's finally teardown
    // of the whole isolated database, including failed synthetic transactions.
    const [identity] = await database.client<{ name: string }[]>`select current_database() as name`;
    if (!identity || !/^order_daily_e2e_[a-f0-9]{32}$/.test(identity.name)) {
      throw new Error("Order money fixtures require an isolated order_daily_e2e database");
    }
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [
      contextA.tenantId, "Synthetic money A", `money-a-${contextA.tenantId}`,
      contextB.tenantId, "Synthetic money B", `money-b-${contextB.tenantId}`,
    ]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4)", [
      contextA.userId, `synthetic-money-${contextA.userId}`, `money-${contextA.userId}@example.test`, "Synthetic money operator",
    ]);
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(marketplaceAccounts).values({
        id: accountId, tenantId: contextA.tenantId, platform: "amazon", displayName: "Synthetic money account",
        region: "NA", authorizationMode: "amazon_private",
      });
      await tx.insert(amazonOrderReportBatches).values({
        id: batchId, tenantId: contextA.tenantId, accountId, marketplaceId: "ATVPDKIKX0DER",
        fileName: "synthetic-money.txt", reportChecksum: "a".repeat(64), rowCount: 100, orderCount: 100, expiresAt,
      });
    });
  });

  afterAll(async () => { await database.client.end(); });

  it("stores unknown monetary pairs as null under the non-owner application role", async () => {
    const fixture = await seedOrder();
    await withTenant(database.db, contextA, async (tx) => {
      const [role] = await tx.execute(sql`select current_user as name`);
      expect(role?.name).toBe("yummyai_app");
      const [order] = await tx.select().from(orders).where(eq(orders.id, fixture.orderId));
      const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, fixture.lineId));
      const [report] = await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.reportLineId));
      expect(order).toMatchObject({ orderTotalMinor: null, orderCurrency: null });
      expect(line).toMatchObject({ unitPriceMinor: null, unitPriceCurrency: null });
      expect(report).toMatchObject({ itemTotalMinor: null, currency: null });
    });
  });

  it("rejects either incomplete money pair in each persistence table", async () => {
    const fixture = await seedOrder();
    for (const amountOnly of [true, false]) {
      const amount = amountOnly ? 0 : null;
      const currency = amountOnly ? null : "USD";
      expect(await databaseFailure(withTenant(database.db, contextA, (tx) => tx.update(orders)
        .set({ orderTotalMinor: amount, orderCurrency: currency }).where(eq(orders.id, fixture.orderId)))))
        .toMatchObject({ code: "23514", constraint: "orders_money_pair_check" });
      expect(await databaseFailure(withTenant(database.db, contextA, (tx) => tx.update(orderLines)
        .set({ unitPriceMinor: amount, unitPriceCurrency: currency }).where(eq(orderLines.id, fixture.lineId)))))
        .toMatchObject({ code: "23514", constraint: "order_lines_money_pair_check" });
      expect(await databaseFailure(withTenant(database.db, contextA, (tx) => tx.update(amazonOrderReportLines)
        .set({ itemTotalMinor: amount, currency }).where(eq(amazonOrderReportLines.id, fixture.reportLineId)))))
        .toMatchObject({ code: "23514", constraint: "amazon_order_report_lines_money_pair_check" });
    }
    const [line] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, fixture.lineId)));
    expect(line).toMatchObject({ unitPriceMinor: null, unitPriceCurrency: null });
  });

  it("lets the application fill an unknown unit price, including a known zero", async () => {
    const fixture = await seedOrder();
    const result = await withTenant(database.db, contextA, (tx) => tx.update(orderLines)
      .set({ unitPriceMinor: 0, unitPriceCurrency: "USD" }).where(eq(orderLines.id, fixture.lineId)).returning());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unitPriceMinor: 0, unitPriceCurrency: "USD" });
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, fixture.lineId)));
    expect(stored).toMatchObject({ unitPriceMinor: 0, unitPriceCurrency: "USD" });
  });

  it("prevents replacement or removal of known unit-price evidence", async () => {
    const fixture = await seedOrder({ amount: 2500, currency: "USD" });
    for (const replacement of [
      { unitPriceMinor: 2600, unitPriceCurrency: "USD" },
      { unitPriceMinor: 2500, unitPriceCurrency: "EUR" },
      { unitPriceMinor: null, unitPriceCurrency: null },
    ]) {
      expect(await databaseFailure(withTenant(database.db, contextA, (tx) => tx.update(orderLines)
        .set(replacement).where(eq(orderLines.id, fixture.lineId)))))
        .toMatchObject({ code: "P0001", message: "Known order line money cannot be replaced" });
    }
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, fixture.lineId)));
    expect(stored).toMatchObject({ unitPriceMinor: 2500, unitPriceCurrency: "USD" });
  });

  it("keeps non-monetary order-line fields insert-only for the application", async () => {
    const fixture = await seedOrder();
    expect(await databaseFailure(withTenant(database.db, contextA, (tx) => tx.update(orderLines)
      .set({ skuCode: "SYNTHETIC-REPLACEMENT" }).where(eq(orderLines.id, fixture.lineId)))))
      .toMatchObject({ code: "42501" });
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, fixture.lineId)));
    expect(stored?.skuCode).toBe("SYNTHETIC-MONEY-SKU");
  });

  it("does not let another tenant read or fill an unknown unit price", async () => {
    const fixture = await seedOrder();
    const visible = await withTenant(database.db, contextB, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, fixture.lineId)));
    expect(visible).toEqual([]);
    const changed = await withTenant(database.db, contextB, (tx) => tx.update(orderLines)
      .set({ unitPriceMinor: 9999, unitPriceCurrency: "USD" }).where(eq(orderLines.id, fixture.lineId)).returning());
    expect(changed).toEqual([]);
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, fixture.lineId)));
    expect(stored).toMatchObject({ unitPriceMinor: null, unitPriceCurrency: null });
  });

  it("fills an unpriced report order from complete Amazon adapter evidence without replacing known money", async () => {
    const original = await seedUnpricedReportOrder();
    const input = providerInput(original);
    const filled = await service.ingestNormalized(contextA, input);
    expect(filled.orderTotal).toEqual({ amountMinor: 5500, currency: "USD" });
    expect(filled.lines.map((line) => line.unitPrice)).toEqual([
      { amountMinor: 2500, currency: "USD" }, { amountMinor: 2500, currency: "USD" },
    ]);
    expect((await service.ingestNormalized(contextA, input)).latestEventSequence).toBe(filled.latestEventSequence);
    const changed = providerInput(original);
    changed.orderTotal = { amountMinor: 6000, currency: "USD" };
    changed.lines[0]!.unitPrice = { amountMinor: 3000, currency: "USD" };
    const retained = await service.ingestNormalized(contextA, changed);
    expect(retained.orderTotal).toEqual(filled.orderTotal);
    expect(retained.lines.map((line) => line.unitPrice)).toEqual(filled.lines.map((line) => line.unitPrice));
  });

  it("fills a matching line from a partial provider payload while withholding the order total", async () => {
    const original = await seedUnpricedReportOrder();
    const partial = await service.ingestNormalized(contextA, providerInput({ ...original, lines: original.lines.slice(0, 1) }));
    expect(partial.orderTotal).toBeNull();
    expect(partial.lines.find((line) => line.id === original.lines[0]!.id)?.unitPrice).toEqual({ amountMinor: 2500, currency: "USD" });
    expect(partial.lines.find((line) => line.id === original.lines[1]!.id)?.unitPrice).toBeNull();
    const complete = await service.ingestNormalized(contextA, providerInput(original));
    expect(complete.orderTotal).toEqual({ amountMinor: 5500, currency: "USD" });
  });

  it("does not infer a total from a generic normalized payload or an inconsistent provider line inventory", async () => {
    const original = await seedUnpricedReportOrder();
    const generic = providerInput(original);
    generic.redactedSource = { source: "synthetic_partial_payload" };
    const filledLines = await service.ingestNormalized(contextA, generic);
    expect(filledLines.orderTotal).toBeNull();
    expect(filledLines.lines.every((line) => line.unitPrice?.amountMinor === 2500)).toBe(true);
    const inconsistent = providerInput(original);
    inconsistent.redactedSource.orderItemIds = [original.lines[0]!.externalLineId];
    expect((await service.ingestNormalized(contextA, inconsistent)).orderTotal).toBeNull();
  });

  it("leaves unknown prices and totals untouched when incoming or stored currencies conflict", async () => {
    const original = await seedUnpricedReportOrder();
    const conflicting = providerInput(original);
    conflicting.lines[1]!.unitPrice = { amountMinor: 2500, currency: "EUR" };
    const rejected = await service.ingestNormalized(contextA, conflicting);
    expect(rejected.orderTotal).toBeNull();
    expect(rejected.lines.every((line) => line.unitPrice === null)).toBe(true);
    await withTenant(database.db, contextA, (tx) => tx.update(orderLines)
      .set({ unitPriceMinor: 2500, unitPriceCurrency: "EUR" }).where(eq(orderLines.id, original.lines[0]!.id)));
    const storedConflict = await service.ingestNormalized(contextA, providerInput(original));
    expect(storedConflict.orderTotal).toBeNull();
    expect(storedConflict.lines.find((line) => line.id === original.lines[1]!.id)?.unitPrice).toBeNull();
    expect(storedConflict.lines.find((line) => line.id === original.lines[0]!.id)?.unitPrice).toEqual({ amountMinor: 2500, currency: "EUR" });
  });

  it("withholds a provider total when its known line prices disagree with preserved evidence", async () => {
    const original = await seedUnpricedReportOrder();
    await withTenant(database.db, contextA, (tx) => tx.update(orderLines)
      .set({ unitPriceMinor: 2400, unitPriceCurrency: "USD" }).where(eq(orderLines.id, original.lines[0]!.id)));
    const result = await service.ingestNormalized(contextA, providerInput(original));
    expect(result.orderTotal).toBeNull();
    expect(result.lines.find((line) => line.id === original.lines[0]!.id)?.unitPrice).toEqual({ amountMinor: 2400, currency: "USD" });
    expect(result.lines.find((line) => line.id === original.lines[1]!.id)?.unitPrice).toEqual({ amountMinor: 2500, currency: "USD" });
  });

  it("does not fill a price or total when a provider changes the line quantity or SKU", async () => {
    for (const mismatch of ["quantity", "skuCode"] as const) {
      const original = await seedUnpricedReportOrder();
      const input = providerInput(original);
      if (mismatch === "quantity") input.lines[0]!.quantity = 2;
      else input.lines[0]!.skuCode = "SYNTHETIC-DIFFERENT-SKU";
      const result = await service.ingestNormalized(contextA, input);
      expect(result.orderTotal).toBeNull();
      expect(result.lines.find((line) => line.id === original.lines[0]!.id)?.unitPrice).toBeNull();
      expect(result.lines.find((line) => line.id === original.lines[0]!.id)).toMatchObject({ quantity: 1, skuCode: "SYNTHETIC-MONEY-SKU" });
    }
  });

  async function seedUnpricedReportOrder() {
    const externalOrderId = `SYNTHETIC-${createEntityId()}`;
    const input: NormalizeOrderInput = {
      accountId, platform: "amazon", externalEventId: `SYNTHETIC-${createEntityId()}`, externalOrderId,
      providerStatus: "report_imported", placedAt: "2026-09-19T00:00:00Z", orderTotal: null,
      lines: [0, 1].map((index) => ({
        externalLineId: `${externalOrderId}-${index}`, externalListingId: null, skuCode: "SYNTHETIC-MONEY-SKU",
        title: "Synthetic money product", quantity: 1, unitPrice: null, customizationCount: 0,
      })),
      redactedSource: { source: "manual_report", synthetic: true }, protectedDetails: null,
    };
    return (await service.materializeNormalized(contextA, input, { manualReport: true })).order;
  }

  function providerInput(order: OrderView) {
    // Exercise the actual adapter's evidence shape, including orderItemIds.
    return normalizeAmazonOrder(accountId, `SYNTHETIC-API-${createEntityId()}`, {
      orderId: order.externalOrderId, createdTime: order.placedAt, lastUpdatedTime: "2026-09-19T01:00:00Z",
      fulfillmentStatus: "Unshipped", salesChannel: { marketplaceId: "ATVPDKIKX0DER" },
      orderTotal: { amount: "55.00", currencyCode: "USD" },
      orderItems: order.lines.map((line) => ({
        orderItemId: line.externalLineId, product: { sellerSku: line.skuCode ?? undefined, title: line.title },
        quantityOrdered: line.quantity, unitPrice: { amount: "25.00", currencyCode: "USD" },
      })),
    }).order;
  }

  async function seedOrder(money: { amount: number; currency: string } | null = null) {
    const orderId = createEntityId(), lineId = createEntityId(), reportLineId = createEntityId(), snapshotId = createEntityId();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(orderSourceSnapshots).values({
        id: snapshotId, tenantId: contextA.tenantId, accountId, platform: "amazon", externalEventId: `SYNTHETIC-${orderId}`,
        externalOrderId: `SYNTHETIC-${orderId}`, normalizedOrderId: orderId, redactedPayload: { synthetic: true }, payloadChecksum: "b".repeat(64),
      });
      await tx.insert(orders).values({
        id: orderId, tenantId: contextA.tenantId, accountId, sourceSnapshotId: snapshotId, platform: "amazon",
        externalOrderId: `SYNTHETIC-${orderId}`, providerStatus: "report_imported", orderTotalMinor: money?.amount ?? null,
        orderCurrency: money?.currency ?? null, lineCount: 1, placedAt: new Date("2026-09-19T00:00:00Z"),
      });
      await tx.insert(orderLines).values({
        id: lineId, tenantId: contextA.tenantId, orderId, externalLineId: `SYNTHETIC-${lineId}`, title: "Synthetic money product",
        skuCode: "SYNTHETIC-MONEY-SKU", quantity: 1, unitPriceMinor: money?.amount ?? null, unitPriceCurrency: money?.currency ?? null,
      });
      await tx.insert(amazonOrderReportLines).values({
        id: reportLineId, tenantId: contextA.tenantId, orderId, orderLineId: lineId, batchId, sourceChecksum: "c".repeat(64),
        itemTotalMinor: money?.amount ?? null, currency: money?.currency ?? null, expiresAt,
      });
    });
    return { orderId, lineId, reportLineId };
  }
});

async function databaseFailure(operation: Promise<unknown>) {
  try { await operation; } catch (error) {
    let current: unknown = error;
    while (current && typeof current === "object") {
      if ("code" in current && typeof current.code === "string") {
        return {
          code: current.code,
          constraint: "constraint_name" in current ? current.constraint_name : undefined,
          message: "message" in current ? current.message : undefined,
        };
      }
      current = "cause" in current ? current.cause : undefined;
    }
    throw error;
  }
  throw new Error("Expected a PostgreSQL invariant to reject the synthetic operation");
}
