import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { normalizeModelTokenUsage } from "@yummyai/ai-core";
import { orderDesignAgentRuns as runs, orderDesignModelCalls as calls, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type * as DatabaseModule from "@yummyai/database";
import { recordOrderModelResponse } from "./model-costs.js";
import type { DesignRun, DesignStep } from "./repository.js";

vi.mock("@yummyai/database", async original => ({ ...await original<typeof DatabaseModule>(), withTenant: vi.fn() }));
vi.mock("./repository.js", () => ({ lockWork: vi.fn() }));

type Query = { from: () => Query; where: () => Query; for: () => Query; innerJoin: () => Query; leftJoin: () => Query; then: Promise<unknown[]>["then"] };
function query(rows: unknown[]): Query {
  const promise = Promise.resolve(rows);
  const value: Query = { from: () => value, where: () => value, for: () => value, innerJoin: () => value, leftJoin: () => value, then: promise.then.bind(promise) };
  return value;
}

describe("original order design usage receipt", () => {
  beforeEach(() => { vi.mocked(withTenant).mockReset(); });
  const usage = normalizeModelTokenUsage({ input_tokens: 12, output_tokens: 4, total_tokens: 16 })!;
  function fixture(status: DesignRun["status"] = "running") {
    const context = { tenantId: createEntityId(), userId: createEntityId() } as TenantContext;
    const run = { id: createEntityId(), workItemId: createEntityId(), requestedBy: context.userId, status } as DesignRun;
    const step = { id: createEntityId(), requestId: createEntityId() } as DesignStep;
    const token = createEntityId();
    const original = { id: createEntityId(), receivedAt: null, costReportState: "pending", reportedCostUsd: null, tokenUsage: null } as typeof calls.$inferSelect;
    const patches: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const selects = vi.fn();
    const tx = {
      select: selects, execute: vi.fn(async () => undefined),
      update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
        patches.push({ table, values });
        if (table === calls) Object.assign(original, values, { receivedAt: new Date() });
      } }) }),
    };
    vi.mocked(withTenant).mockImplementation(async (_db, _context, operation) => operation(tx as unknown as TenantTransaction));
    const receipt = { requestId: step.requestId, actualCostUsd: 0.04, tokenUsage: usage };
    const record = async (next: Parameters<typeof recordOrderModelResponse>[5] = receipt) => {
      const rows = [() => [run], () => [original], () => [{ id: step.id }], () => [{ state: "committed", amount: "0.040000", callId: original.id, reportState: original.costReportState, reported: original.reportedCostUsd }]];
      selects.mockImplementation(() => query(rows.shift()?.() ?? []));
      return recordOrderModelResponse({ db: {} } as DatabaseConnection, context, run, step, token, next);
    };
    return { context, run, original, receipt, record, patches };
  }
  it("records a late original response after cancellation without changing execution state", async () => {
    const f = fixture("cancelled");
    expect(await f.record()).toEqual({ recorded: true, state: "reported" });
    expect(f.original).toMatchObject({ tokenUsage: usage, costReportState: "reported", reportedCostUsd: "0.04000000" });
    expect(f.patches.filter(patch => patch.table === runs).every(patch => !("status" in patch.values) && !("processingToken" in patch.values) && !("leaseUntil" in patch.values))).toBe(true);
    expect(f.run.status).toBe("cancelled");
  });
  it("does not add or mutate an identical provider or bytes receipt twice", async () => {
    const f = fixture(); await f.record(); f.patches.length = 0;
    expect(await f.record()).toEqual({ recorded: true, state: "reported" });
    expect(f.patches).toEqual([]); expect(f.original.tokenUsage).toEqual(usage);
  });
  it("rejects changed or explicitly erased usage while preserving the original receipt", async () => {
    const f = fixture(); await f.record(); f.patches.length = 0;
    await expect(f.record({ ...f.receipt, tokenUsage: { ...usage, inputTokens: 13, totalTokens: 17 } })).rejects.toMatchObject({ code: "agent_model_usage_conflict" });
    await expect(f.record({ ...f.receipt, tokenUsage: null })).rejects.toMatchObject({ code: "agent_model_usage_conflict" });
    expect(f.original.tokenUsage).toEqual(usage); expect(f.patches).toEqual([]);
  });
  it("does not overwrite known billing with a legacy local checkpoint that omits usage", async () => {
    const f = fixture(); await f.record(); f.patches.length = 0;
    expect(await f.record({ requestId: f.receipt.requestId })).toEqual({ recorded: true, state: "reported" });
    expect(f.original.tokenUsage).toEqual(usage); expect(f.original.reportedCostUsd).toBe("0.04000000"); expect(f.patches).toEqual([]);
  });
  it("keeps absent usage unknown and refuses a different original actor", async () => {
    const f = fixture(); await f.record({ requestId: f.receipt.requestId });
    expect(f.original).toMatchObject({ tokenUsage: null, costReportState: "unknown", reportedCostUsd: null });
    f.patches.length = 0; f.run.requestedBy = createEntityId();
    await expect(f.record()).rejects.toMatchObject({ code: "agent_model_call_identity_invalid" });
    expect(f.patches).toEqual([]);
  });
});
