import { eq } from "drizzle-orm";
import type { TenantContext } from "@yummyai/contracts";
import { FinanceCommandDetailSchema, type PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { FinanceCommandRecordedResultSchema, type FinanceCommandRecordedResult } from "@yummyai/contracts/finance/finance-command-result";
import { expireFinanceCommandInputs, financeProfitRuns, withTenant, type DatabaseConnection } from "@yummyai/database";
import { financeCommandFixture, financeCommandKey, requireFinanceCommandFixture, type FinanceCommandScenario } from "./finance-command.fixtures.js";

/** Validate the fresh runner namespace before importing code that connects. */
export function requireFinanceCommandResultFixture(environment: NodeJS.ProcessEnv = process.env) {
  requireFinanceCommandFixture(environment);
  if (environment.E2E_FINANCE_COMMAND_RESULT_ISOLATED !== "1")
    throw new Error("Recorded finance result acceptance requires its own disposable runner before connection");
}
export function immutableFinanceExecution(value: FinanceCommandRecordedResult) {
  const { currentVerification, contextAuthority, ...execution } = value;
  void currentVerification; void contextAuthority;
  return execution;
}
export function financeCommandResultFixture(database: DatabaseConnection) {
  requireFinanceCommandResultFixture();
  const f = financeCommandFixture(database);
  async function complete(s: Pick<FinanceCommandScenario, "context" | "original">) {
    const prepared = FinanceCommandDetailSchema.parse(await f.commands.prepare(s.context, s.original));
    const done = FinanceCommandDetailSchema.parse(await f.commands.execute(s.context, prepared.id));
    if (done.status !== "succeeded" || !done.result) throw new Error("Synthetic actual finance command did not commit");
    return { done, result: FinanceCommandRecordedResultSchema.parse(await f.commands.recordedResult(s.context, done.id)) };
  }
  async function largeApproval() {
    const basis = await f.cost.basis({ amountMinor: 1 });
    const keys = Array.from({ length: 101 }, (_, index) => `${2018 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`);
    const input = f.cost.previewInput(basis, "period", keys), preview = await f.cost.allocations.preview(f.cost.context, input);
    const original: PrepareFinanceCommand = { kind: "cost_version_approve", targetId: null,
      input: { ...input, previewChecksum: preview.previewChecksum, idempotencyKey: financeCommandKey() } };
    return { basis, keys, original, preview, ...await complete({ context: f.cost.context, original }) };
  }
  async function expireOwnedInput(context: TenantContext, commandId: string) {
    requireFinanceCommandResultFixture();
    const owned = await f.row(context, commandId);
    if (owned.created_by !== context.userId || !owned.request_key.startsWith("synthetic-")) throw new Error("Only an owned synthetic command may become due");
    // Only the exact disposable command privacy clock moves. Actual facts,
    // original business witnesses, proofs and execution timestamps stay intact.
    await database.client.begin(async synthetic => {
      await synthetic.unsafe("set local session_replication_role=replica");
      await synthetic.unsafe("with t as(select date_trunc('milliseconds',clock_timestamp()) as at) update finance_commands set created_at=t.at-interval '8 days',expires_at=t.at-interval '1 day' from t where tenant_id=$1 and created_by=$2 and id=$3",
        [context.tenantId, context.userId, commandId]);
    });
    return withTenant(database.db, context, tx => expireFinanceCommandInputs(tx, { actorId: context.userId, commandId }));
  }
  async function savedProfit(context: TenantContext, id: string) {
    return withTenant(database.db, context, async tx => {
      const [row] = await tx.select({ revenueMinor: financeProfitRuns.revenueMinor, costMinor: financeProfitRuns.costMinor,
        profitMinor: financeProfitRuns.profitMinor, marginBps: financeProfitRuns.marginBps, inputChecksum: financeProfitRuns.inputChecksum,
        diagnostics: financeProfitRuns.diagnostics, status: financeProfitRuns.status }).from(financeProfitRuns).where(eq(financeProfitRuns.id, id));
      if (!row) throw new Error("Synthetic saved profit row missing");
      return row;
    });
  }
  return { f, complete, largeApproval, expireOwnedInput, savedProfit };
}
