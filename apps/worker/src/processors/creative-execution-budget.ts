import { modelBillingBudgetAmount } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import { aiBudgetLedger, aiBudgetPolicies, creativeExecutions, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";

type Execution = typeof creativeExecutions.$inferSelect;
export type CreativeBillingIdentity = { taskType: string; modelKey: string; provider: string; ceilingUsd?: string };
const amount = (value: string) => {
  if (!/^(0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(value)) throw new Error("CREATIVE_BUDGET_INVALID");
  const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const decimal = (value: bigint) => `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;

/** The original persistent AI budget ledger is the only reservation authority. */
export async function reserveCreativeBudget(tx: TenantTransaction, execution: Execution, billing: CreativeBillingIdentity) {
  if (execution.effect !== "external_request") throw new Error("CREATIVE_LOCAL_STEP_HAS_NO_PAID_SUBMISSION");
  for (const value of [billing.taskType, billing.modelKey, billing.provider]) if (!/^[\p{L}\p{N}_.:/ -]{1,160}$/u.test(value)) throw new Error("CREATIVE_BILLING_IDENTITY_INVALID");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${execution.tenantId}:ai-assist-budget`},0))`);
  const requestId = execution.kind === "studio_generation" ? execution.studioGenerationId! : execution.id;
  const existing = await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, requestId)).for("update");
  if (existing.length > 1) throw new Error("CREATIVE_BUDGET_AMBIGUOUS");
  const [policy] = await tx.select().from(aiBudgetPolicies).for("share");
  const configuredCap = policy ? policy.taskCapsUsd[billing.taskType] === undefined ? policy.defaultTaskCapUsd
    : policy.taskCapsUsd[billing.taskType]!.toFixed(6) : null;
  const limit = existing[0]?.amountUsd ?? billing.ceilingUsd ?? configuredCap;
  if (!limit || amount(limit) <= 0n) throw new Error("CREATIVE_BUDGET_REQUIRED");
  if (configuredCap && amount(limit) > amount(configuredCap)) throw new Error("CREATIVE_TASK_BUDGET_EXCEEDED");
  if (billing.ceilingUsd && amount(limit) !== amount(billing.ceilingUsd)) throw new Error("CREATIVE_ORIGINAL_BUDGET_CHANGED");
  const [overrun] = await tx.select({ id: creativeExecutions.id }).from(creativeExecutions)
    .innerJoin(aiBudgetLedger, eq(aiBudgetLedger.id, creativeExecutions.budgetLedgerId))
    .where(and(eq(aiBudgetLedger.modelKey, billing.modelKey), eq(aiBudgetLedger.provider, billing.provider),
      sql`(${creativeExecutions.receipt}->>'costUsd')::numeric>${creativeExecutions.budgetLimitUsd}`)).limit(1);
  if (overrun) throw new Error("CREATIVE_PRIOR_BUDGET_OVERRUN");
  const record = existing[0];
  if (record && (record.state !== "reserved" || record.modelKey !== billing.modelKey || record.provider !== billing.provider || record.taskType !== billing.taskType))
    throw new Error("CREATIVE_ORIGINAL_BUDGET_CHANGED");
  if (policy) {
    const [total] = await tx.select({ value: sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}),0)` }).from(aiBudgetLedger)
      .where(and(inArray(aiBudgetLedger.state, ["reserved", "committed"]), sql`${aiBudgetLedger.createdAt}>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`));
    if (amount(total!.value) + (record ? 0n : amount(limit)) > amount(policy.monthlyCapUsd)) throw new Error("CREATIVE_MONTHLY_BUDGET_EXCEEDED");
  }
  if (record) return { id: record.id, limit: decimal(amount(limit)) };
  const id = createEntityId();
  await tx.insert(aiBudgetLedger).values({ id, tenantId: execution.tenantId, requestId, taskType: billing.taskType,
    modelKey: billing.modelKey, provider: billing.provider, amountUsd: decimal(amount(limit)), state: "reserved" });
  return { id, limit: decimal(amount(limit)) };
}

/** A late response still records spent money, even after authority or lease loss. */
export async function settleCreativeBudget(tx: TenantTransaction, execution: Execution, receipt: PodInvocationReceipt) {
  if (!execution.budgetLedgerId || !execution.submittedAt) throw new Error("CREATIVE_SUBMISSION_MISSING");
  if (receipt.costUsd === null) return;
  const billed = modelBillingBudgetAmount(receipt.costUsd);
  const [ledger] = await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, execution.budgetLedgerId)).for("update");
  if (!ledger || ledger.state === "released" || (ledger.state === "committed" && amount(ledger.amountUsd) !== amount(billed))) throw new Error("CREATIVE_BUDGET_RECEIPT_CHANGED");
  if (ledger.state === "reserved") await tx.update(aiBudgetLedger).set({ state: "committed", amountUsd: billed }).where(eq(aiBudgetLedger.id, ledger.id));
}
