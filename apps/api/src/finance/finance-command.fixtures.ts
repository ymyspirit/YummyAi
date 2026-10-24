/** Actual owners and synthetic evidence only. The disposable runner owns all resources. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { PrepareFinanceCommandSchema, type FinanceCommandKind, type FinanceCommandResult, type PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { memberships, roles, withTenant, type DatabaseConnection } from "@yummyai/database";
import { financeCostAllocationFixture, costTables } from "./finance-cost-allocation.fixtures.js";
import { monetaryFact, monetaryRate, monetaryStatement, monetaryTables } from "./finance-monetary.fixtures.js";
import { financePayablesAdjustmentsFixture, existingPayablesTables, protectedAdjustmentFacts } from "./finance-payables-adjustments.fixtures.js";
import { FinanceCommandOwnerAdapter } from "./finance-command-owner.js";
import { FinanceCommandService } from "./finance-command.service.js";
import { FinanceCommandResultReader } from "./finance-command-result.reader.js";
import { createFinanceCommandVault } from "./finance-command-vault.js";

export function requireFinanceCommandFixture(environment: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try { url = new URL(environment.DATABASE_URL ?? "postgres://invalid/invalid"); }
  catch { throw new Error("Finance command acceptance requires its dedicated disposable database before connection"); }
  if (environment.E2E_ISOLATED_DAILY !== "1" || environment.E2E_FINANCE_COMMAND_ISOLATED !== "1"
    || !["postgres:", "postgresql:"].includes(url.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error("Finance command acceptance requires its dedicated disposable database before connection");
}
export const financeCommandKey = () => `synthetic-finance-command-${randomUUID()}`;
export const financeCommandKinds = ["statement_record", "fx_rate_record", "metric_upsert", "profit_calculate", "bill_record", "payment_record",
  "payment_allocate", "allocation_release", "bill_adjustment_record", "payment_adjustment_record", "cost_version_approve", "allocated_profit_calculate"] as const satisfies readonly FinanceCommandKind[];
export const financeCommandBusinessTables = [...new Set([...monetaryTables, ...costTables, ...existingPayablesTables,
  "finance_bill_adjustments", "finance_payment_adjustments", "finance_statement_source_lines", ...protectedAdjustmentFacts])];
export const financeCommandTables = ["finance_commands", "finance_original_write_proofs"];
export const financeCommandPermission = (kind: FinanceCommandKind) => ["statement_record", "fx_rate_record", "bill_record", "payment_record"].includes(kind)
  ? Permission.FinanceWrite : Permission.FinanceReview;
const financialRights = [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
const monetaryKinds = new Set<FinanceCommandKind>(["statement_record", "fx_rate_record", "metric_upsert", "profit_calculate", "cost_version_approve", "allocated_profit_calculate"]);
export type FinanceCommandScenario = { original: PrepareFinanceCommand; context: TenantContext; coworker: TenantContext; outsider: TenantContext;
  costBasis?: Awaited<ReturnType<ReturnType<typeof financeCostAllocationFixture>["basis"]>> };

export function financeCommandFixture(database: DatabaseConnection) {
  requireFinanceCommandFixture();
  const cost = financeCostAllocationFixture(database), payable = financePayablesAdjustmentsFixture(database), key = randomBytes(32);
  const vaultEnvironment = { NODE_ENV: "production", FINANCE_COMMAND_ENCRYPTION_KEY: key.toString("base64url") };
  const vault = createFinanceCommandVault(vaultEnvironment), audit = cost.audit;
  const adapter = new FinanceCommandOwnerAdapter(cost.finance, payable.payables, payable.adjustments, cost.allocations);
  const service = () => new FinanceCommandService(database, createFinanceCommandVault(vaultEnvironment), adapter, audit, new FinanceCommandResultReader());
  const commands = service();
  const actors = [cost.context, cost.coworker, cost.outsider, payable.context, payable.coworker, payable.outsider];
  const owns = [cost.context, payable.context];
  const groups = (kind: FinanceCommandKind) => monetaryKinds.has(kind) ? cost : payable;
  async function initialize() { await cost.initialize(); await payable.initialize(); }
  async function rights(actor: TenantContext, permissions: string[], scope: "tenant" | "self" | "team" = "tenant") {
    const roleId = cost.roleIds.get(actor.userId) ?? payable.procurement.roleIds.get(actor.userId);
    if (!roleId) throw new Error("Synthetic finance command role missing");
    await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions, dataScope: scope }).where(eq(roles.id, roleId)));
  }
  async function membership(actor: TenantContext, status: "active" | "disabled") {
    await withTenant(database.db, actor, tx => tx.update(memberships).set({ status }).where(eq(memberships.userId, actor.userId)));
  }
  async function restoreRights() { await cost.restoreRights(); await payable.restoreRights(); }
  async function state(context: TenantContext, selected = [...financeCommandBusinessTables, ...financeCommandTables, "audit_events"]) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; checksum: string }> = {};
      for (const table of [...new Set(selected)]) {
        const rows = await tx.execute(sql`select to_jsonb(t) as row from ${sql.identifier(table)} t order by to_jsonb(t)::text`);
        result[table] = { count: rows.length, checksum: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return result;
    });
  }
  async function scenario(kind: FinanceCommandKind): Promise<FinanceCommandScenario> {
    const group = groups(kind), common = { context: group.context, coworker: group.coworker, outsider: group.outsider };
    let original: PrepareFinanceCommand;
    switch (kind) {
      case "statement_record": original = { kind, targetId: null, input: monetaryStatement("USD", [monetaryFact("USD", 29)]) }; break;
      case "fx_rate_record": original = { kind, targetId: null, input: monetaryRate("JPY", "USD", 1, 150) }; break;
      case "metric_upsert": original = { kind, targetId: null, input: { metricId: null, name: `Synthetic command metric ${randomUUID()}`,
        reportingCurrency: "USD", revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"],
        reasonCode: "SYNTHETIC", idempotencyKey: financeCommandKey() } }; break;
      case "profit_calculate": {
        const basis = await cost.basis();
        return { ...common, costBasis: basis, original: PrepareFinanceCommandSchema.parse({ kind, targetId: basis.metric.id,
          input: { ...basis.input, idempotencyKey: financeCommandKey() } }) };
      }
      case "bill_record": original = { kind, targetId: null, input: payable.billInput(100) }; break;
      case "payment_record": original = { kind, targetId: null, input: payable.paymentInput(100) }; break;
      case "payment_allocate": {
        const first = await payable.bill(80), second = await payable.bill(40), paid = await payable.payment(100);
        original = { kind, targetId: paid.id, input: { paymentId: paid.id, allocations: [{ billId: first.id, amountMinor: 50 }, { billId: second.id, amountMinor: 20 }], idempotencyKey: financeCommandKey() } }; break;
      }
      case "allocation_release": {
        const due = await payable.bill(100), paid = await payable.payment(100), batch = await payable.allocate(paid.id, due.id, 50);
        original = { kind, targetId: batch.allocations[0]!.id, input: { reasonCode: "SOURCE_CHANGED", idempotencyKey: financeCommandKey() } }; break;
      }
      case "bill_adjustment_record": {
        const due = await payable.bill(100);
        original = { kind, targetId: due.id, input: { kind: "credit", expectedNetAmountMinor: 100, amountMinor: 20,
          externalDocumentId: `SYNTHETIC-CREDIT-${randomUUID()}`, evidenceReference: "Synthetic actual supplier credit",
          occurredAt: "2026-07-03T00:00:00.000Z", reasonCode: "SYNTHETIC", idempotencyKey: financeCommandKey() } }; break;
      }
      case "payment_adjustment_record": {
        const paid = await payable.payment(100);
        original = { kind, targetId: paid.id, input: { kind: "refund", expectedNetAmountMinor: 100, amountMinor: 20,
          externalDocumentId: `SYNTHETIC-REFUND-${randomUUID()}`, evidenceReference: "Synthetic actual refund evidence no bank operation",
          occurredAt: "2026-07-03T00:00:00.000Z", reasonCode: "SYNTHETIC", idempotencyKey: financeCommandKey() } }; break;
      }
      case "cost_version_approve": {
        const basis = await cost.basis(), input = cost.previewInput(basis), preview = await cost.allocations.preview(cost.context, input);
        return { ...common, costBasis: basis, original: PrepareFinanceCommandSchema.parse({ kind, targetId: null,
          input: { ...input, previewChecksum: preview.previewChecksum, idempotencyKey: financeCommandKey() } }) };
      }
      case "allocated_profit_calculate": {
        const basis = await cost.basis(), { version } = await cost.approve(cost.previewInput(basis));
        return { ...common, costBasis: basis, original: PrepareFinanceCommandSchema.parse({ kind, targetId: basis.base.id,
          input: { baseRunId: basis.base.id, baseInputChecksum: basis.base.inputChecksum, dimension: "order_line", versionIds: [version.id], idempotencyKey: financeCommandKey() } }) };
      }
    }
    return { ...common, original: PrepareFinanceCommandSchema.parse(original) };
  }
  async function raw(original: PrepareFinanceCommand, context: TenantContext): Promise<FinanceCommandResult> {
    const simple = (id: string): FinanceCommandResult => ({ kind: original.kind, id, parentId: null, version: null });
    switch (original.kind) {
      case "statement_record": return simple((await cost.finance.recordStatement(context, original.input)).id);
      case "fx_rate_record": return simple((await cost.finance.recordFxRate(context, original.input)).id);
      case "metric_upsert": { const row = await cost.finance.upsertProfitMetric(context, original.input); return { kind: original.kind, id: row.version.id, parentId: row.id, version: row.version.versionNumber }; }
      case "profit_calculate": return simple((await cost.finance.calculateProfit(context, original.input)).id);
      case "bill_record": return simple((await payable.payables.recordBill(context, original.input)).id);
      case "payment_record": return simple((await payable.payables.recordPayment(context, original.input)).id);
      case "payment_allocate": return simple((await payable.payables.allocate(context, original.input)).id);
      case "allocation_release": return simple((await payable.payables.release(context, original.targetId, original.input)).id);
      case "bill_adjustment_record": return simple((await payable.adjustments.recordBillAdjustment(context, original.targetId, original.input)).id);
      case "payment_adjustment_record": return simple((await payable.adjustments.recordPaymentAdjustment(context, original.targetId, original.input)).id);
      case "cost_version_approve": { const row = await cost.allocations.approve(context, original.input); return { kind: original.kind, id: row.id, parentId: row.allocationId, version: row.versionNumber }; }
      case "allocated_profit_calculate": return simple((await cost.allocations.calculate(context, original.input)).id);
    }
  }
  async function row(context: TenantContext, id: string) {
    return withTenant(database.db, context, async tx => {
      const [value] = await tx.execute<{ id: string; kind: FinanceCommandKind; target_id: string | null; created_by: string; request_key: string;
        request_checksum: string; owner_input_checksum: string; encrypted_input: string | null; authority_snapshot: TenantContext;
        status: string; result_id: string | null; acknowledged_at: Date | null; expires_at: Date; completed_at: Date | null }>(sql`select * from finance_commands where id=${id}::uuid`);
      if (!value) throw new Error("Synthetic original finance command missing"); return value;
    });
  }
  async function proof(context: TenantContext, result: FinanceCommandResult) {
    return withTenant(database.db, context, async tx => {
      const [value] = await tx.execute<{ command_id: string | null; request_key: string; actor_id: string; target_id: string | null;
        owner_input_checksum: string; creation_transaction_id: string; parent_id: string | null; version: number | null }>(sql`
        select * from finance_original_write_proofs where kind=${result.kind} and result_id=${result.id}::uuid`);
      if (!value) throw new Error("Actual finance write proof missing"); return value;
    });
  }
  async function cleanupCommands() {
    for (const context of owns) {
      const rows = await withTenant(database.db, context, tx => tx.execute<{ id: string; status: string }>(sql`
        select id,status from finance_commands where created_by=${context.userId}::uuid and acknowledged_at is null order by id`));
      for (const item of rows) {
        if (item.status === "prepared") await commands.cancel(context, item.id);
        await commands.acknowledge(context, item.id);
      }
    }
  }
  return { database, cost, payable, key, vaultEnvironment, vault, adapter, audit, commands, service, actors, owns,
    initialize, scenario, raw, rights, membership, restoreRights, state, row, proof, cleanupCommands,
    financialRights, destroy() { key.fill(0); payable.destroy(); } };
}
export type FinanceCommandFixture = ReturnType<typeof financeCommandFixture>;
