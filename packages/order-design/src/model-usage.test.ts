import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz";
import { normalizeModelTokenUsage, type SecretVault } from "@yummyai/ai-core";
import { withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type * as DatabaseModule from "@yummyai/database";
import { OrderDesignRepository, type DesignRun } from "./repository.js";

vi.mock("@yummyai/database", async original => ({ ...await original<typeof DatabaseModule>(), withTenant: vi.fn() }));

function query(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const value = { from: vi.fn(() => value), where: vi.fn(() => value), innerJoin: vi.fn(() => value), orderBy: vi.fn(() => value),
    limit: vi.fn(() => value), then: promise.then.bind(promise) };
  return value;
}
describe("complete order design usage ledger", () => {
  beforeEach(() => { vi.mocked(withTenant).mockReset(); });
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: [Permission.OrderRead, Permission.OrderPiiRead] };
  const database = { db: {} } as DatabaseConnection;
  it("totals every call separately from the 1000-row detail view and includes superseded runs", async () => {
    const workItemId = createEntityId(), runId = createEntityId(), priorRunId = createEntityId(), now = new Date();
    const usage = normalizeModelTokenUsage({ input_tokens: 12, output_tokens: 4, total_tokens: 16 })!;
    const work = { id: workItemId, encryptedDataKey: null, privateAvailable: false };
    const run = { id: runId, tenantId: context.tenantId, requestedBy: context.userId, workItemId, workRevisionId: createEntityId(), revision: 1, status: "needs_attention", executorKey: "strict-template",
      recipeVersion: "1", policyVersion: "order-design-v1", modelRouteId: null, projectId: null, currentEditorVersionId: null,
      methodSnapshot: null, encryptedSnapshot: "not-read", inputChecksum: "a".repeat(64), completionEvidence: null, completionChecksum: null, processingToken: null, leaseUntil: null,
      errorCode: null, estimatedCostUsd: null, actualCostUsd: null, costStatus: "unknown", qualityDiagnostics: [], createdAt: now, updatedAt: now } satisfies DesignRun;
    const allCalls = [...Array.from({ length: 1003 }, () => ({ runId, tokenUsage: usage })), { runId: priorRunId, tokenUsage: usage }, { runId: priorRunId, tokenUsage: null }];
    const details = Array.from({ length: 1001 }, () => ({ id: createEntityId(), stepId: createEntityId(), requestId: createEntityId(), attempt: 1,
      submittedAt: now, receivedAt: now, costReportState: "unknown", reportedCostUsd: null, tokenUsage: usage, budgetState: "reserved", budgetAmountUsd: "0.040000" }));
    const usageQuery = query(allCalls), detailsQuery = query(details);
    const queries = [query([work]), query([run]), usageQuery, detailsQuery, query([work])];
    const tx = { select: vi.fn(() => queries.shift()) };
    vi.mocked(withTenant).mockImplementation(async (_db, _context, operation) => operation(tx as unknown as TenantTransaction));
    const view = await new OrderDesignRepository(database, {} as SecretVault).view(context, workItemId, { includePrivate: false });
    expect(view.usageSummary).toMatchObject({ scope: "order_design_work_item", state: "partial", callCount: 1005, reportedCalls: 1004, unknownCalls: 1, inputTokens: 12048, outputTokens: 4016, totalTokens: 16064 });
    expect(view.run?.usageSummary).toMatchObject({ scope: "order_design_run", state: "complete", callCount: 1003, totalTokens: 16048 });
    expect(view.run?.modelCalls).toHaveLength(1000); expect(view.run?.modelCallsTruncated).toBe(true);
    expect(usageQuery.limit).not.toHaveBeenCalled(); expect(detailsQuery.limit).toHaveBeenCalledWith(1001);
  });
  it("keeps financial summaries behind the existing order permission and tenant scope", async () => {
    const repository = new OrderDesignRepository(database, {} as SecretVault);
    await expect(repository.view({ ...context, dataScope: "self" }, createEntityId(), { includePrivate: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(repository.view({ ...context, permissions: [Permission.OrderRead] }, createEntityId(), { includePrivate: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(withTenant).not.toHaveBeenCalled();
  });
});
