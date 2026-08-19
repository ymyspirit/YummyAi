import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  financeFacts,
  financeProfitRuns,
  connectDatabase,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { FinanceService } from "./finance.service.js";

const orderId = createEntityId();
const orderLineId = createEntityId();
const skuId = createEntityId();
const listingId = createEntityId();
const supplierId = createEntityId();

describe.sequential("finance evidence and profit", () => {
  const database = connectDatabase();
  const tenantA = createEntityId();
  const tenantB = createEntityId();
  const userA = createEntityId();
  const userB = createEntityId();
  const accountA = createEntityId();
  const accountB = createEntityId();
  const contextA = tenantContext(tenantA, userA);
  const contextB = tenantContext(tenantB, userB);
  const service = new FinanceService(database, new AuditService(database));

  let marketplaceStatementId: string;
  let supplierStatementId: string;
  let carrierStatementId: string;
  let metricId: string;
  let fxRateId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1,$2,$3),($4,$5,$6)`,
      [
        tenantA, "Finance A", `finance-a-${tenantA}`,
        tenantB, "Finance B", `finance-b-${tenantB}`,
      ],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)`,
      [
        userA, `finance-a-${userA}`, `finance-a-${userA}@example.test`, "Finance A",
        userB, `finance-b-${userB}`, `finance-b-${userB}@example.test`, "Finance B",
      ],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode, status)
       values
       ($1,$2,'etsy','Finance store','finance-store','GLOBAL',$3::jsonb,'etsy_oauth','active'),
       ($4,$5,'etsy','Other store','other-store','GLOBAL',$3::jsonb,'etsy_oauth','active')`,
      [accountA, tenantA, JSON.stringify(["US"]), accountB, tenantB],
    );
    const productPlanId = createEntityId();
    const spuId = createEntityId();
    const sourceSnapshotId = createEntityId();
    const customization = JSON.stringify({ version: 1, fields: [] });
    await database.client.unsafe(
      `insert into product_plans (id, tenant_id, name, customization)
       values ($1,$2,'Finance product',$3::jsonb)`,
      [productPlanId, tenantA, customization],
    );
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, customization)
       values ($1,$2,$3,'FINANCE-SPU','Finance product',$4::jsonb)`,
      [spuId, tenantA, productPlanId, customization],
    );
    await database.client.unsafe(
      `insert into skus (id, tenant_id, spu_id, code, status)
       values ($1,$2,$3,'FINANCE-SKU','active')`,
      [skuId, tenantA, spuId],
    );
    await database.client.unsafe(
      `insert into listings (id, tenant_id, spu_id, platform, marketplace_id, locale, status)
       values ($1,$2,$3,'etsy','US','en-US','approved')`,
      [listingId, tenantA, spuId],
    );
    await database.client.unsafe(
      `insert into fulfillment_suppliers
       (id, tenant_id, name, kind, region_code, settlement_currency)
       values ($1,$2,'Finance supplier','manual','EU','EUR')`,
      [supplierId, tenantA],
    );
    await database.client.unsafe(
      `insert into order_source_snapshots
       (id, tenant_id, account_id, platform, external_event_id, external_order_id,
        normalized_order_id, redacted_payload, payload_checksum)
       values ($1,$2,$3,'etsy','finance-event','finance-order',$4,'{}'::jsonb,$5)`,
      [sourceSnapshotId, tenantA, accountA, orderId, "a".repeat(64)],
    );
    await database.client.unsafe(
      `insert into orders
       (id, tenant_id, account_id, source_snapshot_id, platform, external_order_id,
        provider_status, order_total_minor, order_currency, line_count, placed_at)
       values ($1,$2,$3,$4,'etsy','finance-order','paid',10000,'USD',1,$5)`,
      [orderId, tenantA, accountA, sourceSnapshotId, "2026-07-01T00:00:00.000Z"],
    );
    await database.client.unsafe(
      `insert into order_lines
       (id, tenant_id, order_id, external_line_id, external_listing_id, sku_code,
        title, quantity, unit_price_minor, unit_price_currency)
       values ($1,$2,$3,'finance-line','finance-listing','FINANCE-SKU',
        'Finance product',1,10000,'USD')`,
      [orderLineId, tenantA, orderId],
    );
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("records immutable statements with replay and changed-payload conflict", async () => {
    const marketplace = await service.recordStatement(contextA, statementInput({
      accountId: accountA,
      provider: "etsy",
      statementKind: "marketplace_settlement",
      externalStatementId: "etsy-settlement-001",
      idempotencyKey: "finance-statement-marketplace-001",
      lines: [
        fact("sale", "sale_revenue", "credit", 10_000, "USD"),
        fact("commission", "marketplace_commission", "debit", 1_000, "USD"),
      ],
    }));
    marketplaceStatementId = marketplace.id;
    const replay = await service.recordStatement(contextA, statementInput({
      accountId: accountA,
      provider: "etsy",
      statementKind: "marketplace_settlement",
      externalStatementId: "etsy-settlement-001",
      idempotencyKey: "finance-statement-marketplace-001",
      lines: [
        fact("sale", "sale_revenue", "credit", 10_000, "USD"),
        fact("commission", "marketplace_commission", "debit", 1_000, "USD"),
      ],
    }));
    expect(replay.id).toBe(marketplace.id);
    await expect(service.recordStatement(contextA, statementInput({
      accountId: accountA,
      provider: "etsy",
      statementKind: "marketplace_settlement",
      externalStatementId: "etsy-settlement-001",
      idempotencyKey: "finance-statement-marketplace-001",
      lines: [
        fact("sale", "sale_revenue", "credit", 10_001, "USD"),
      ],
    }))).rejects.toBeInstanceOf(ConflictException);
  });

  it("records exact FX evidence and reproduces complete profit across dimensions", async () => {
    supplierStatementId = (await service.recordStatement(contextA, statementInput({
      accountId: null,
      provider: "supplier",
      statementKind: "supplier_invoice",
      externalStatementId: "supplier-invoice-001",
      sourceCurrency: "EUR",
      idempotencyKey: "finance-statement-supplier-001",
      lines: [fact("production", "production_cost", "debit", 2_000, "EUR")],
    }))).id;
    carrierStatementId = (await service.recordStatement(contextA, statementInput({
      accountId: null,
      provider: "carrier",
      statementKind: "carrier_invoice",
      externalStatementId: "carrier-invoice-001",
      idempotencyKey: "finance-statement-carrier-001",
      lines: [fact("carrier", "carrier_cost", "debit", 500, "USD")],
    }))).id;
    const fxRate = await service.recordFxRate(contextA, {
      source: "ECB",
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateNumerator: 11,
      rateDenominator: 10,
      effectiveAt: "2026-07-01T00:00:00.000Z",
      retrievedAt: "2026-07-02T00:00:00.000Z",
      idempotencyKey: "finance-fx-eur-usd-001",
    });
    fxRateId = fxRate.id;
    const metric = await service.upsertProfitMetric(contextA, {
      metricId: null,
      name: "Contribution margin",
      reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue", "shipping_revenue"],
      costFactTypes: ["marketplace_commission", "production_cost", "carrier_cost"],
      requiredFactTypes: [
        "sale_revenue",
        "marketplace_commission",
        "production_cost",
        "carrier_cost",
      ],
      reasonCode: "P3_BASELINE",
      idempotencyKey: "finance-profit-metric-001",
    });
    metricId = metric.id;
    const run = await service.calculateProfit(contextA, {
      metricId,
      expectedMetricVersion: 1,
      statementIds: [marketplaceStatementId, supplierStatementId, carrierStatementId],
      fxRateIds: [fxRateId],
      idempotencyKey: "finance-profit-run-complete-001",
    });
    expect(run).toMatchObject({
      status: "complete",
      revenueMinor: 10_000,
      costMinor: 3_700,
      profitMinor: 6_300,
      marginBps: 6_300,
      diagnostics: {
        missingFactTypes: [],
        missingFxPairs: [],
        unclassifiedFactTypes: [],
      },
    });
    for (const dimension of [
      "order", "order_line", "sku", "listing", "store", "platform", "supplier", "period",
    ]) {
      expect(run.breakdowns.some((breakdown) => breakdown.dimension === dimension)).toBe(true);
    }
    expect(run.contributions.find((entry) => entry.factType === "production_cost"))
      .toMatchObject({ sourceAmountMinor: 2_000, reportingAmountMinor: 2_200, fxRateId });
    const replay = await service.calculateProfit(contextA, {
      metricId,
      expectedMetricVersion: 1,
      statementIds: [marketplaceStatementId, supplierStatementId, carrierStatementId],
      fxRateIds: [fxRateId],
      idempotencyKey: "finance-profit-run-complete-001",
    });
    expect(replay.id).toBe(run.id);
  });

  it("keeps totals null for missing required facts, FX, and unclassified facts", async () => {
    const missingRequired = await service.calculateProfit(contextA, {
      metricId,
      expectedMetricVersion: 1,
      statementIds: [marketplaceStatementId],
      fxRateIds: [],
      idempotencyKey: "finance-profit-run-missing-required-001",
    });
    expect(missingRequired.status).toBe("incomplete");
    expect(missingRequired.profitMinor).toBeNull();
    expect(missingRequired.diagnostics.missingFactTypes).toEqual(
      expect.arrayContaining(["production_cost", "carrier_cost"]),
    );

    const missingFx = await service.calculateProfit(contextA, {
      metricId,
      expectedMetricVersion: 1,
      statementIds: [marketplaceStatementId, supplierStatementId, carrierStatementId],
      fxRateIds: [],
      idempotencyKey: "finance-profit-run-missing-fx-001",
    });
    expect(missingFx.status).toBe("incomplete");
    expect(missingFx.revenueMinor).toBeNull();
    expect(missingFx.diagnostics.missingFxPairs).toEqual(["EUR/USD"]);

    const unclassifiedStatement = await service.recordStatement(contextA, statementInput({
      accountId: null,
      provider: "manual",
      statementKind: "manual_adjustment",
      externalStatementId: "manual-unclassified-001",
      idempotencyKey: "finance-statement-unclassified-001",
      lines: [fact("tax", "tax", "debit", 100, "USD")],
    }));
    const unclassified = await service.calculateProfit(contextA, {
      metricId,
      expectedMetricVersion: 1,
      statementIds: [
        marketplaceStatementId,
        supplierStatementId,
        carrierStatementId,
        unclassifiedStatement.id,
      ],
      fxRateIds: [fxRateId],
      idempotencyKey: "finance-profit-run-unclassified-001",
    });
    expect(unclassified.status).toBe("incomplete");
    expect(unclassified.diagnostics.unclassifiedFactTypes).toEqual(["tax"]);
  });

  it("requires exact reversals before compatible replacement facts", async () => {
    const original = await service.recordStatement(contextA, statementInput({
      accountId: null,
      provider: "manual",
      statementKind: "manual_adjustment",
      externalStatementId: "manual-original-001",
      idempotencyKey: "finance-correction-original-001",
      lines: [fact("other", "other_fee", "debit", 100, "USD")],
    }));
    const originalFactId = original.lines[0]!.id;
    await expect(service.recordStatement(contextA, statementInput({
      accountId: null,
      provider: "manual",
      statementKind: "manual_adjustment",
      externalStatementId: "manual-bad-reversal-001",
      idempotencyKey: "finance-correction-bad-reversal-001",
      lines: [{
        ...fact("reversal", "other_fee", "debit", 99, "USD"),
        correctionKind: "reversal",
        correctsFactId: originalFactId,
      }],
    }))).rejects.toBeInstanceOf(UnprocessableEntityException);
    await service.recordStatement(contextA, statementInput({
      accountId: null,
      provider: "manual",
      statementKind: "manual_adjustment",
      externalStatementId: "manual-reversal-001",
      idempotencyKey: "finance-correction-reversal-001",
      lines: [{
        ...fact("reversal", "other_fee", "debit", 100, "USD"),
        correctionKind: "reversal",
        correctsFactId: originalFactId,
      }],
    }));
    const replacement = await service.recordStatement(contextA, statementInput({
      accountId: null,
      provider: "manual",
      statementKind: "manual_adjustment",
      externalStatementId: "manual-replacement-001",
      idempotencyKey: "finance-correction-replacement-001",
      lines: [{
        ...fact("replacement", "other_fee", "debit", 80, "USD"),
        correctionKind: "replacement",
        correctsFactId: originalFactId,
      }],
    }));
    expect(replacement.lines[0]).toMatchObject({
      correctionKind: "replacement",
      correctsFactId: originalFactId,
      amountMinor: 80,
    });
  });

  it("isolates tenants and denies mutation of append-only financial evidence", async () => {
    await expect(service.getStatement(contextB, marketplaceStatementId))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.recordStatement(contextA, statementInput({
      accountId: accountB,
      provider: "etsy",
      statementKind: "marketplace_settlement",
      externalStatementId: "cross-tenant-001",
      idempotencyKey: "finance-cross-tenant-001",
      lines: [fact("sale", "sale_revenue", "credit", 100, "USD")],
    }))).rejects.toBeInstanceOf(NotFoundException);
    const privileges = await withTenant(database.db, contextA, async (tx) => {
      const result = await tx.execute(sql`
        select
          has_table_privilege(current_user, 'finance_statements', 'UPDATE') as statement_update,
          has_table_privilege(current_user, 'finance_facts', 'DELETE') as fact_delete,
          has_table_privilege(current_user, 'finance_fx_rates', 'UPDATE') as fx_update,
          has_table_privilege(current_user, 'finance_profit_metric_versions', 'UPDATE') as version_update,
          has_table_privilege(current_user, 'finance_profit_runs', 'DELETE') as run_delete,
          has_table_privilege(current_user, 'finance_profit_contributions', 'UPDATE') as contribution_update,
          has_table_privilege(current_user, 'finance_profit_metrics', 'UPDATE') as metric_update
      `);
      return result[0] as Record<string, boolean>;
    });
    expect(privileges).toEqual({
      statement_update: false,
      fact_delete: false,
      fx_update: false,
      version_update: false,
      run_delete: false,
      contribution_update: false,
      metric_update: true,
    });
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(financeFacts).set({ amountMinor: 0 }),
    )).rejects.toThrow();
    expect(await withTenant(database.db, contextB, (tx) =>
      tx.select().from(financeProfitRuns),
    )).toHaveLength(0);
  });
});

function statementInput(overrides: Record<string, unknown>) {
  return {
    accountId: null,
    provider: "manual" as const,
    statementKind: "manual_adjustment" as const,
    externalStatementId: "statement",
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-07-31T23:59:59.000Z",
    sourceCurrency: "USD",
    observedAt: "2026-08-01T00:00:00.000Z",
    idempotencyKey: "finance-statement-default",
    lines: [fact("default", "other_fee", "debit", 1, "USD")],
    ...overrides,
  };
}

function fact(
  lineKey: string,
  factType: "sale_revenue" | "marketplace_commission" | "production_cost" | "carrier_cost" | "tax" | "other_fee",
  direction: "credit" | "debit",
  amountMinor: number,
  currency: string,
) {
  return {
    lineKey,
    factType,
    direction,
    amountMinor,
    currency,
    occurredAt: "2026-07-15T00:00:00.000Z",
    externalReference: null,
    orderId,
    orderLineId,
    skuId,
    listingId,
    supplierId,
    correctionKind: "original" as const,
    correctsFactId: null,
  };
}

function tenantContext(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    userId,
    permissions: ["finance:read", "finance:write", "finance:review"],
    dataScope: "tenant",
  };
}
