import { ConflictException } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

type TimeConstraint = "incoming_commands_time" | "procurement_commands_time" | "finance_commands_time" | "advertising_commands_time" | "factory_access_grants_closure_check" | "factory_task_assignments_closure_check";

/** The callback must own one complete SQL transaction with no external effects.
 * A named 23514 proves that transaction failed; transport errors and unknown
 * commits must never enter this retry path. Database clocks and facts are not
 * rewritten. Every attempt must reload the owner's current authorization. */
export async function retryDatabaseTimeRollback<T>(transaction: () => Promise<T>, constraint: TimeConstraint): Promise<T> {
  const deadline = performance.now() + 2_000;
  let wait = 25;
  for (;;) {
    try { return await transaction(); }
    catch (error) {
      if (!isTimeConstraint(error, constraint)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConflictException({ code: "database_clock_not_ready",
        message: "数据库时间暂未追上原记录 本次操作已回滚 请稍后核对并重试" });
      await delay(Math.min(wait, remaining));
      wait = Math.min(wait * 2, 250);
    }
  }
}

function isTimeConstraint(error: unknown, constraint: TimeConstraint) {
  const seen = new Set<unknown>();
  for (let cursor: unknown = error; cursor && typeof cursor === "object" && !seen.has(cursor);) {
    seen.add(cursor);
    const item = cursor as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (item.code === "23514" && (item.constraint_name === constraint || item.constraint === constraint)) return true;
    cursor = item.cause;
  }
  return false;
}
