/** Synthetic financial evidence owned and removed by the disposable runner. */
import { randomUUID, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { FinanceFactInput, RecordFinanceStatementInput, RecordFinanceFxRateInput } from "@yummyai/contracts/finance";
import { withTenant, memberships, roles, membershipRoles, type DatabaseConnection } from "@yummyai/database";
import { AuditService } from "../audit/audit.service.js";
import { FinanceService } from "./finance.service.js";

export function requireFinanceMonetaryFixture() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_MONETARY_ISOLATED !== "1"
    || !["postgres:", "postgresql:"].includes(url.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error("Finance monetary acceptance requires its own disposable database before connection");
}
export const monetaryKey = () => `synthetic-finance-money-${randomUUID()}`;
export const monetaryTables = ["finance_statements", "finance_facts", "finance_fx_rates", "finance_profit_metrics",
  "finance_profit_metric_versions", "finance_profit_runs", "finance_profit_contributions"];
export const monetaryFact = (currency: string, amountMinor: number, overrides: Partial<FinanceFactInput> = {}): FinanceFactInput => ({
  sourceEntryId: `synthetic-event:${randomUUID()}`, lineKey: randomUUID(), factType: "production_cost", direction: "debit", amountMinor, currency,
  occurredAt: "2026-07-15T00:00:00.000Z", externalReference: null, orderId: null, orderLineId: null, skuId: null,
  listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null, ...overrides,
});
export const monetaryStatement = (currency: string, lines: FinanceFactInput[], overrides: Partial<RecordFinanceStatementInput> = {}): RecordFinanceStatementInput => ({
  sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-MONETARY-EVIDENCE" },
  accountId: null, provider: "manual", statementKind: "operational_cost", externalStatementId: monetaryKey(),
  periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.000Z", sourceCurrency: currency,
  observedAt: "2026-08-01T00:00:00.000Z", idempotencyKey: monetaryKey(), lines, ...overrides,
});
export const monetaryRate = (baseCurrency: string, quoteCurrency: string, rateNumerator: number, rateDenominator: number,
  overrides: Partial<RecordFinanceFxRateInput> = {}): RecordFinanceFxRateInput => ({
  source: `SYNTHETIC.${randomUUID().toUpperCase()}`, baseCurrency, quoteCurrency, rateNumerator, rateDenominator,
  effectiveAt: "2026-07-01T00:00:00.000Z", retrievedAt: "2026-07-02T00:00:00.000Z",
  idempotencyKey: monetaryKey(), rateUnit: "major_to_major", ...overrides,
});

export function financeMonetaryFixture(database: DatabaseConnection) {
  requireFinanceMonetaryFixture();
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(),
    permissions: ["finance:read", "finance:write", "finance:review"], dataScope: "tenant" };
  const outsider: TenantContext = { ...context, tenantId: createEntityId(), userId: createEntityId() };
  const audit = new AuditService(database), service = new FinanceService(database, audit);
  const roleIds = new Map<string, string>(), membershipIds = new Map<string, string>();
  async function initialize() {
    for (const current of [context, outsider]) {
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic monetary acceptance',$2)", [current.tenantId, `monetary-${current.tenantId}`]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic monetary operator')",
        [current.userId, `monetary-${current.userId}`, `${current.userId}@example.test`]);
      await withTenant(database.db, current, async tx => {
        const membershipId = createEntityId(), roleId = createEntityId();
        roleIds.set(current.userId, roleId); membershipIds.set(current.userId, membershipId);
        await tx.insert(memberships).values({ id: membershipId, tenantId: current.tenantId, userId: current.userId, status: "active" });
        await tx.insert(roles).values({ id: roleId, tenantId: current.tenantId, name: `Synthetic monetary ${roleId}`, permissions: [...current.permissions], dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: current.tenantId, membershipId, roleId });
      });
    }
  }
  const statement = (currency: string, facts: FinanceFactInput[]) => service.recordStatement(context, monetaryStatement(currency, facts));
  const metric = (currency: string) => service.upsertProfitMetric(context, { metricId: null, name: `Synthetic monetary ${monetaryKey()}`,
    reportingCurrency: currency, revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"],
    requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: monetaryKey() });
  async function state(tables = monetaryTables) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; digest: string }> = {};
      for (const table of tables) {
        const rows = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
        result[table] = { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return result;
    });
  }
  return { context, outsider, audit, service, initialize, statement, metric, state, roleIds, membershipIds };
}
