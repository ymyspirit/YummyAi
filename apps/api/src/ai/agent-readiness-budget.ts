import type { TenantContext } from "@yummyai/contracts";
import type { AgentReadiness, AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import {
  aiAssistExecutions,
  aiAssistRuns,
  aiBudgetLedger,
  aiBudgetPolicies,
  modelBillingReconciliations,
  type TenantTransaction,
} from "@yummyai/database";
import { agentLoopMicros } from "@yummyai/workflow-core";
import { and, inArray, sql } from "drizzle-orm";

export type AgentReadinessBudgetChecks = Pick<AgentReadiness["checks"], "taskBudget" | "monthlyBudget" | "concurrency">;

export interface AgentReadinessBudgetFacts {
  taskCapUsd: string;
  monthlyCapUsd: string | null;
  monthUsedUsd: string;
  legacyCostUnknown: boolean;
  activeTasks: string;
}

/** Only the minimum legal reservation is considered; no organization amounts escape. */
export function evaluateAgentReadinessBudget(facts: AgentReadinessBudgetFacts): AgentReadinessBudgetChecks {
  const minimum = 1n;
  if (!/^(?:0|[1-9]\d*)$/.test(facts.activeTasks)) throw new Error("agent_readiness_metadata_invalid");
  const monthlyBudget: AgentReadinessBudgetChecks["monthlyBudget"] = facts.monthlyCapUsd === null
    ? "not_configured"
    : facts.legacyCostUnknown
      ? "cost_unknown"
      : agentLoopMicros(facts.monthUsedUsd) + minimum > agentLoopMicros(facts.monthlyCapUsd)
        ? "exhausted"
        : "available";
  return {
    taskBudget: agentLoopMicros(facts.taskCapUsd) < minimum ? "below_minimum" : "positive",
    monthlyBudget,
    concurrency: BigInt(facts.activeTasks) >= 4n ? "at_limit" : "available",
  };
}

/** Call only inside the caller's non-owner tenant transaction, after WorkflowRun. */
export async function readAgentReadinessBudget(
  tx: TenantTransaction,
  context: TenantContext,
  family: AgentReadinessFamily,
): Promise<AgentReadinessBudgetChecks> {
  const loopCap = sql`coalesce((${aiBudgetPolicies.taskCapsUsd}->>'erp_agent')::numeric,${aiBudgetPolicies.defaultTaskCapUsd})`;
  const familyCap = family === "loop" ? loopCap
    : sql`least(coalesce((${aiBudgetPolicies.taskCapsUsd}->>'erp_agent_plan')::numeric,${loopCap}),${loopCap})`;
  const [policy] = await tx.select({
    monthlyCapUsd: aiBudgetPolicies.monthlyCapUsd,
    // Floor sub-micro JSON caps, never round them up into an admissible reservation.
    taskCapUsd: sql<string>`greatest(trunc(${familyCap},6),0)::text`,
  }).from(aiBudgetPolicies);

  let monthUsedUsd = "0", legacyCostUnknown = false;
  if (policy) {
    // Exact legacy Assist predicate from all five original admission owners.
    const [unpriced] = await tx.select({ id: aiAssistRuns.id }).from(aiAssistRuns).where(and(
      sql`${aiAssistRuns.createdAt}>=date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC'`,
      sql`${aiAssistRuns.modelSnapshot}->>'maxTaskCostUsd' is null`,
      sql`${aiAssistRuns.startedAt} is not null`,
      sql`${aiAssistRuns.costUsd} is null`,
      sql`not exists(select 1 from ${aiAssistExecutions} e where e.run_id=${aiAssistRuns.id} and e.submission_state='not_submitted')`,
      sql`not exists(select 1 from ${modelBillingReconciliations} b where b.owner='assist' and b.assist_run_id=${aiAssistRuns.id})`,
    )).limit(1);
    legacyCostUnknown = !!unpriced;
    if (!legacyCostUnknown) {
      const [total] = await tx.select({ value: sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}),0)::text` })
        .from(aiBudgetLedger).where(and(
          sql`${aiBudgetLedger.createdAt}>=date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC'`,
          inArray(aiBudgetLedger.state, ["reserved", "committed"]),
        ));
      monthUsedUsd = total?.value ?? "0";
    }
  }

  const [active] = await tx.execute<{ count: string }>(sql`select (
    (select count(*) from agent_plan_runs where tenant_id=${context.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
    (select count(*) from agent_loop_runs where tenant_id=${context.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
    (select count(*) from ai_assist_runs where tenant_id=${context.tenantId}::uuid and status in('queued','running') and expires_at>clock_timestamp())
  )::text as count`);
  if (!active) throw new Error("agent_readiness_metadata_invalid");
  return evaluateAgentReadinessBudget({
    taskCapUsd: policy?.taskCapUsd ?? "100",
    monthlyCapUsd: policy?.monthlyCapUsd ?? null,
    monthUsedUsd,
    legacyCostUnknown,
    activeTasks: active.count,
  });
}
