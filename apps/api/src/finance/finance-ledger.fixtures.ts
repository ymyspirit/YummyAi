/** All evidence is synthetic and written by its actual owner in a disposable database. */
import { randomUUID } from "node:crypto";
import type { FinanceLedgerKind } from "@yummyai/contracts/finance/ledger";
import type { DatabaseConnection } from "@yummyai/database";
import { financePayablesAdjustmentsFixture, adjustmentCode, adjustmentKey } from "./finance-payables-adjustments.fixtures.js";
import { monetaryFact, monetaryRate, monetaryStatement } from "./finance-monetary.fixtures.js";
import { FinanceService } from "./finance.service.js";
import { FinanceLedgerService } from "./finance-ledger.service.js";

export function requireFinanceLedgerFixture() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_LEDGER_ISOLATED !== "1"
    || process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_ISOLATED !== "1" || process.env.E2E_INVOICE_RECONCILIATION_ISOLATED !== "1"
    || !["postgres:", "postgresql:"].includes(url.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error("Finance ledger requires its dedicated disposable acceptance runner before connection");
}

export function financeLedgerFixture(database: DatabaseConnection) {
  requireFinanceLedgerFixture();
  const f = financePayablesAdjustmentsFixture(database), finance = new FinanceService(database, f.procurement.audit), ledger = new FinanceLedgerService(database);
  const ids: Record<FinanceLedgerKind, string[]> = { statements: [], facts: [], fx_rates: [], metrics: [], metric_versions: [], profit_runs: [], contributions: [],
    bills: [], payments: [], allocation_batches: [], allocations: [], releases: [], bill_adjustments: [], payment_adjustments: [], procurement_adjustments: [] };
  const parents = new Map<string, string>(), at = "2026-07-03T00:00:00.000Z";
  const common = (expectedNetAmountMinor: number) => ({ expectedNetAmountMinor, evidenceReference: "Synthetic ledger supplier document",
    occurredAt: at, reasonCode: "SUPPLIER_CORRECTION", idempotencyKey: adjustmentKey(), externalDocumentId: adjustmentCode() });
  async function seed() {
    for (let index = 0; index < 3; index++) {
      const statement = await finance.recordStatement(f.context, monetaryStatement("USD", [
        monetaryFact("USD", 10_000 + index, { factType: "sale_revenue", direction: "credit" }), monetaryFact("USD", 1_000 + index),
      ]));
      ids.statements.push(statement.id);
      for (const fact of statement.lines) { ids.facts.push(fact.id); parents.set(fact.id, statement.id); }
      const fx = await finance.recordFxRate(f.context, monetaryRate("EUR", "USD", 11, 10)); ids.fx_rates.push(fx.id);
      const metricInput = { metricId: null, name: `Synthetic ledger metric ${randomUUID()}`, reportingCurrency: "USD", revenueFactTypes: ["sale_revenue" as const],
        costFactTypes: ["production_cost" as const], requiredFactTypes: ["sale_revenue" as const, "production_cost" as const], reasonCode: "SYNTHETIC", idempotencyKey: adjustmentKey() };
      const metric = await finance.upsertProfitMetric(f.context, metricInput); ids.metrics.push(metric.id); ids.metric_versions.push(metric.version.id); parents.set(metric.version.id, metric.id);
      const second = await finance.upsertProfitMetric(f.context, { ...metricInput, metricId: metric.id, expectedVersion: 1, idempotencyKey: adjustmentKey() });
      ids.metric_versions.push(second.version.id); parents.set(second.version.id, metric.id);
      const run = await finance.calculateProfit(f.context, { metricId: metric.id, expectedMetricVersion: 2, statementIds: [statement.id], fxRateIds: [],
        coverageDimension: "aggregate", idempotencyKey: adjustmentKey() });
      ids.profit_runs.push(run.id); parents.set(run.id, metric.id);
      for (const contribution of run.contributions) { ids.contributions.push(contribution.id); parents.set(contribution.id, run.id); }
      const bill = await f.bill(100), payment = await f.payment(100); ids.bills.push(bill.id); ids.payments.push(payment.id);
      parents.set(bill.id, f.supplierId); parents.set(payment.id, f.supplierId);
      const batch = await f.allocate(payment.id, bill.id, 50), allocation = batch.allocations[0]!;
      ids.allocation_batches.push(batch.id); parents.set(batch.id, payment.id); ids.allocations.push(allocation.id); parents.set(allocation.id, bill.id);
      const release = await f.payables.release(f.context, allocation.id, { reasonCode: "SOURCE_RECHECK", idempotencyKey: adjustmentKey() });
      ids.releases.push(release.id); parents.set(release.id, allocation.id);
      const credit = await f.adjustments.recordBillAdjustment(f.context, bill.id, { ...common(100), kind: "credit", amountMinor: 10 });
      const refund = await f.adjustments.recordPaymentAdjustment(f.context, payment.id, { ...common(100), kind: "refund", amountMinor: 10 });
      ids.bill_adjustments.push(credit.id); parents.set(credit.id, bill.id); ids.payment_adjustments.push(refund.id); parents.set(refund.id, payment.id);
    }
    const source = await f.procurement.basis(), due = await f.procurementBill(source); ids.bills.push(due.id); parents.set(due.id, f.supplierId);
    for (let index = 0; index < 3; index++) {
      const recorded = await f.record(source, { amountMinor: 5 }); await f.review(source.invoice.id, recorded.id);
      ids.procurement_adjustments.push(recorded.id); parents.set(recorded.id, due.id);
    }
    return { procurementBillId: due.id, source };
  }
  return { ...f, finance, ledger, ids, parents, seed, common, get supplierId() { return f.supplierId; } };
}
export type LedgerFixture = ReturnType<typeof financeLedgerFixture>;
