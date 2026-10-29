import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { ModelTokenUsage } from "@yummyai/contracts/ai/model-usage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aiAssistExecutions, aiAssistRuns, aiBudgetLedger, connectDatabase, designTasks,
  marketplaceAccounts, migrateDatabase, orderDesignAgentRuns, orderDesignAgentSteps,
  orderDesignModelCalls, orderLines, orders, orderSourceSnapshots, orderWorkItems,
  orderWorkRevisions, organizations, podArtworkInvocations, podArtworkTasks,
  productPlans, skus, spus, users, withTenant, type TenantTransaction,
} from "./index.js";
import { isolatedDatabaseForTests } from "./testing/disposable-database.js";

const usage: ModelTokenUsage = {
  version: "model-token-usage-v1", inputTokens: 120, outputTokens: 7_200,
  cachedInputTokens: 20, totalTokens: 7_320, totalTokensBasis: "provider",
};
const changedUsage: ModelTokenUsage = { ...usage, outputTokens: 7_201, totalTokens: 7_321 };
const checksum = "a".repeat(64);
const receiptTables = ["ai_assist_runs", "order_design_model_calls", "pod_artwork_invocations"] as const;
type ReceiptTable = typeof receiptTables[number];
type EvidenceTable = ReceiptTable | "ai_assist_executions";
type Evidence = Record<string, unknown>;
type Fixture = { context: TenantContext; lineId: string; podTaskId: string; revision: number; attempt: number };

function context(): TenantContext {
  return { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };
}

async function rejectsWithCode(action: () => Promise<unknown>, code: string) {
  try { await action(); } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected PostgreSQL rejection ${code}`);
}

describe.sequential("model token usage original receipt persistence", () => {
  // The guard rejects regular databases before a connection is created. Immutable
  // synthetic history is removed by the disposable acceptance runner's finally.
  const database = connectDatabase(isolatedDatabaseForTests());
  const a = context(), b = context();
  let fixtureA: Fixture, fixtureB: Fixture;
  let legacy: Array<{ table: ReceiptTable; id: string; before: Evidence }>;

  async function evidence(owner: TenantContext, table: EvidenceTable, id: string): Promise<Evidence | null> {
    const key = table === "ai_assist_executions" ? "run_id" : "id";
    const [row] = await withTenant(database.db, owner, tx => tx.execute<{ value: Evidence }>(sql`
      select to_jsonb(r) as value from ${sql.identifier(table)} r where ${sql.identifier(key)}=${id}::uuid
    `));
    return row?.value ?? null;
  }

  async function seedBase(owner: TenantContext): Promise<Fixture> {
    const accountId = createEntityId(), snapshotId = createEntityId(), orderId = createEntityId(), lineId = createEntityId();
    const planId = createEntityId(), spuId = createEntityId(), skuId = createEntityId();
    const designTaskId = createEntityId(), podTaskId = createEntityId();
    await database.db.insert(organizations).values({ id: owner.tenantId, name: "Synthetic token receipt tenant", slug: `token-usage-${owner.tenantId}` });
    await database.db.insert(users).values({ id: owner.userId, oidcSubject: `token-usage-${owner.userId}`, email: `${owner.userId}@example.test`, displayName: "Synthetic receipt owner" });
    await withTenant(database.db, owner, async tx => {
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: owner.tenantId, platform: "amazon", displayName: "Synthetic unconnected account", region: "NA", authorizationMode: "amazon_private" });
      await tx.insert(orderSourceSnapshots).values({ id: snapshotId, tenantId: owner.tenantId, accountId, platform: "amazon", externalEventId: snapshotId, externalOrderId: orderId, normalizedOrderId: orderId, redactedPayload: {}, payloadChecksum: checksum });
      await tx.insert(orders).values({ id: orderId, tenantId: owner.tenantId, accountId, sourceSnapshotId: snapshotId, platform: "amazon", externalOrderId: orderId, providerStatus: "synthetic", lineCount: 1, placedAt: new Date() });
      await tx.insert(orderLines).values({ id: lineId, tenantId: owner.tenantId, orderId, externalLineId: lineId, title: "Synthetic receipt persistence only", quantity: 1 });
      await tx.insert(orderWorkItems).values({ id: lineId, tenantId: owner.tenantId, expiresAt: new Date("2099-01-01T00:00:00Z") });
      const customization = { version: 1 as const, fields: [] };
      await tx.insert(productPlans).values({ id: planId, tenantId: owner.tenantId, name: "Synthetic receipt fixture", customization });
      await tx.insert(spus).values({ id: spuId, tenantId: owner.tenantId, productPlanId: planId, code: spuId, name: "Synthetic receipt fixture", customization });
      await tx.insert(skus).values({ id: skuId, tenantId: owner.tenantId, spuId, code: skuId });
      await tx.insert(designTasks).values({ id: designTaskId, tenantId: owner.tenantId, skuId, title: "Synthetic receipt fixture", brief: "No artwork generation or approval" });
      await tx.insert(podArtworkTasks).values({ id: podTaskId, tenantId: owner.tenantId, designTaskId, toolKey: "background_remove", parameterSnapshot: {}, idempotencyKey: createEntityId(), requestedBy: owner.userId, maxAttempts: 20 });
    });
    return { context: owner, lineId, podTaskId, revision: 0, attempt: 0 };
  }

  async function assist(owner: TenantContext, phase: "pending" | "preparing" | "failed" | "uncertain" | "completed" = "preparing", submitted = true, options: { execution?: boolean } = {}) {
    const id = createEntityId(), terminal = phase === "failed" || phase === "uncertain" || phase === "completed", received = phase === "completed";
    await withTenant(database.db, owner, async tx => {
      await tx.insert(aiAssistRuns).values({
        id, tenantId: owner.tenantId, ownerId: owner.userId, requestId: createEntityId(), kind: "creative", scope: "synthetic-token-receipt",
        status: terminal ? received ? "completed" : "failed" : phase === "pending" ? "queued" : "running", inputFingerprint: checksum, requestFingerprint: "b".repeat(64),
        encryptedInput: "synthetic-sealed-input", encryptedOutput: received ? "synthetic-sealed-result" : null,
        modelSnapshot: { id: createEntityId(), providerConfigId: createEntityId(), model: "synthetic-model", label: "Synthetic model", providerLabel: "Synthetic provider", inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null },
        promptVersion: "synthetic-v1", reservedCostUsd: "0.1", inputTokens: terminal ? 3 : null, outputTokens: terminal ? 4 : null,
        costUsd: terminal ? "0.05" : null, errorCode: terminal && !received ? "synthetic_transport_failure" : null,
        startedAt: new Date(), completedAt: terminal ? new Date() : null, expiresAt: new Date("2099-01-01T00:00:00Z"),
      });
      if (options.execution !== false) await tx.insert(aiAssistExecutions).values({
        runId: id, tenantId: owner.tenantId, inputFingerprint: checksum, policyChecksum: "c".repeat(64), phase,
        submissionState: received ? "received" : submitted ? "submitted" : "not_submitted",
        submittedAt: submitted ? new Date() : null, receivedAt: received ? new Date() : null,
        responseChecksum: received ? checksum : null, encryptedResponse: received ? "synthetic-sealed-response" : null,
        leaseToken: createEntityId(), leaseExpiresAt: new Date("2099-01-01T00:00:00Z"), attemptCount: 1, dispatchCount: 1,
      });
    });
    return id;
  }

  async function receiveAssist(tx: TenantTransaction, id: string) {
    await tx.update(aiAssistExecutions).set({ submissionState: "received", receivedAt: new Date(), responseChecksum: checksum, encryptedResponse: "synthetic-sealed-response", providerRequestId: "synthetic-original-request" }).where(eq(aiAssistExecutions.runId, id));
  }

  async function call(fixture: Fixture) {
    const { context: owner } = fixture;
    const id = createEntityId(), revisionId = createEntityId(), runId = createEntityId(), stepId = createEntityId();
    const requestId = createEntityId(), claimToken = createEntityId(), budgetId = createEntityId();
    await withTenant(database.db, owner, async tx => {
      await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId: owner.tenantId, workItemId: fixture.lineId, revision: ++fixture.revision, encryptedDraft: "synthetic-sealed-draft", checksum, createdBy: owner.userId });
      await tx.insert(orderDesignAgentRuns).values({ id: runId, tenantId: owner.tenantId, workItemId: fixture.lineId, workRevisionId: revisionId, status: "running", executorKey: "strict-template", recipeVersion: "synthetic-v1", policyVersion: "synthetic-v1", encryptedSnapshot: "synthetic-sealed-snapshot", inputChecksum: checksum, processingToken: claimToken, requestedBy: owner.userId });
      await tx.insert(orderDesignAgentSteps).values({ id: stepId, tenantId: owner.tenantId, runId, key: "enhance_image_1", label: "Synthetic original submission", position: 0, status: "running", attempt: 1, requestId, encryptedInput: "synthetic-sealed-input", inputChecksum: checksum });
      await tx.insert(aiBudgetLedger).values({ id: budgetId, tenantId: owner.tenantId, requestId, taskType: "order_design", modelKey: "synthetic-model", provider: "synthetic", amountUsd: "0.1", state: "reserved" });
      await tx.insert(orderDesignModelCalls).values({ id, tenantId: owner.tenantId, runId, stepId, requestId, attempt: 1, claimToken, budgetLedgerId: budgetId, requestedBy: owner.userId });
    });
    return id;
  }

  async function invocation(fixture: Fixture) {
    const id = createEntityId();
    await withTenant(database.db, fixture.context, tx => tx.insert(podArtworkInvocations).values({ id, tenantId: fixture.context.tenantId, taskId: fixture.podTaskId, attemptNumber: ++fixture.attempt, phase: "submitted", submittedAt: new Date(), modelKey: "synthetic-model", modelVersion: "synthetic-v1" }));
    return id;
  }

  beforeAll(async () => {
    await migrateDatabase(database);
    fixtureA = await seedBase(a); fixtureB = await seedBase(b);
    const assistId = await assist(a, "completed"), callId = await call(fixtureA), invocationId = await invocation(fixtureA);
    await withTenant(database.db, a, async tx => {
      await tx.update(orderDesignModelCalls).set({ receivedAt: new Date(), costReportState: "unknown" }).where(eq(orderDesignModelCalls.id, callId));
      await tx.update(podArtworkInvocations).set({ phase: "received", receivedAt: new Date(), responseChecksum: checksum, metadataValid: true }).where(eq(podArtworkInvocations.id, invocationId));
      await tx.update(podArtworkInvocations).set({ phase: "failed", finishedAt: new Date() }).where(eq(podArtworkInvocations.id, invocationId));
    });
    legacy = [];
    for (const [table, id] of [["ai_assist_runs", assistId], ["order_design_model_calls", callId], ["pod_artwork_invocations", invocationId]] as const) {
      const before = await evidence(a, table, id); expect(before).not.toBeNull();
      legacy.push({ table, id, before: before! });
    }
  });
  afterAll(async () => database.client.end());

  it("adds nullable JSON usage without defaults and retains historical unknown receipts", async () => {
    const columns = await withTenant(database.db, a, tx => tx.execute(sql`
      select table_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema='public' and table_name in ('ai_assist_runs','order_design_model_calls','pod_artwork_invocations') and column_name='token_usage' order by table_name
    `));
    expect([...columns]).toEqual([...receiptTables].sort().map(table => ({ table_name: table, data_type: "jsonb", is_nullable: "YES", column_default: null })));
    await migrateDatabase(database);
    for (const row of legacy) {
      expect(row.before.token_usage).toBeNull();
      expect(await evidence(a, row.table, row.id)).toEqual(row.before);
      await rejectsWithCode(() => withTenant(database.db, a, tx => tx.execute(sql`update ${sql.identifier(row.table)} set token_usage=${JSON.stringify(usage)}::jsonb where id=${row.id}::uuid`)), "55000");
      expect(await evidence(a, row.table, row.id)).toEqual(row.before);
    }
  });

  it("writes Assist usage on the original response and preserves sealed inputs and already recorded units", async () => {
    const id = await assist(a), before = await evidence(a, "ai_assist_runs", id);
    await withTenant(database.db, a, async tx => { await receiveAssist(tx, id); await tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id)); });
    const saved = await evidence(a, "ai_assist_runs", id);
    expect(saved).toEqual({ ...before, token_usage: usage });
    await withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id)));
    for (const tokenUsage of [changedUsage, null]) await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ tokenUsage }).where(eq(aiAssistRuns.id, id))), "55000");
    await withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ status: "completed", completedAt: new Date() }).where(eq(aiAssistRuns.id, id)));
    const completed = await evidence(a, "ai_assist_runs", id);
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ tokenUsage: changedUsage }).where(eq(aiAssistRuns.id, id))), "55000");
    expect(await evidence(a, "ai_assist_runs", id)).toEqual(completed);
    expect(completed?.token_usage).toEqual(usage);
  });

  it.each(["failed", "uncertain"] as const)("accepts the first late Assist receipt after %s without changing phase, lease or settled finances", async phase => {
    const id = await assist(a, phase), before = await evidence(a, "ai_assist_runs", id), execution = await evidence(a, "ai_assist_executions", id);
    await rejectsWithCode(() => withTenant(database.db, a, async tx => {
      await receiveAssist(tx, id);
      await tx.update(aiAssistRuns).set({ tokenUsage: usage, costUsd: "0.09" }).where(eq(aiAssistRuns.id, id));
    }), "55000");
    expect(await evidence(a, "ai_assist_executions", id)).toEqual(execution);
    const receiptTransactionId = await withTenant(database.db, a, async tx => {
      await receiveAssist(tx, id); await tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id));
      const [transaction] = await tx.execute<{ id: string }>(sql`select pg_current_xact_id()::text as id`);
      return transaction!.id;
    });
    expect(await evidence(a, "ai_assist_runs", id)).toEqual({ ...before, token_usage: usage });
    const received = await evidence(a, "ai_assist_executions", id);
    expect(received).toEqual({ ...execution, submission_state: "received", received_at: expect.any(String), response_checksum: checksum, encrypted_response: "synthetic-sealed-response", provider_request_id: "synthetic-original-request", response_receipt_transaction_id: receiptTransactionId });
    await withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id)));
    expect(await evidence(a, "ai_assist_executions", id)).toEqual(received);
    // An identical usage write is harmless; changing original receipt evidence is not.
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(aiAssistExecutions).set({ responseChecksum: "d".repeat(64) }).where(eq(aiAssistExecutions.runId, id))), "55000");
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ tokenUsage: changedUsage }).where(eq(aiAssistRuns.id, id))), "55000");
    expect(await evidence(a, "ai_assist_runs", id)).toEqual({ ...before, token_usage: usage });
  });

  it("requires an original submitted Assist and a receipt from the same transaction for late usage", async () => {
    const id = await assist(a, "failed"), before = await evidence(a, "ai_assist_runs", id);
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id))), "55000");
    await withTenant(database.db, a, tx => receiveAssist(tx, id));
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id))), "55000");
    expect(await evidence(a, "ai_assist_runs", id)).toEqual(before);
    const notSubmitted = await assist(a, "failed", false), original = await evidence(a, "ai_assist_executions", notSubmitted);
    await rejectsWithCode(() => withTenant(database.db, a, tx => receiveAssist(tx, notSubmitted)), "55000");
    expect(await evidence(a, "ai_assist_executions", notSubmitted)).toEqual(original);
  });

  it("records a terminal Assist metadata-first receipt before local encryption without changing phase, lease or finances", async () => {
    const id = await assist(a, "failed"), before = await evidence(a, "ai_assist_runs", id);
    const execution = await evidence(a, "ai_assist_executions", id);
    const updatedAt = new Date(Date.parse(String(execution!.updated_at)) + 1_000);
    const receiptTransactionId = await withTenant(database.db, a, async tx => {
      await tx.update(aiAssistExecutions).set({
        submissionState: "received", receivedAt: new Date(), responseChecksum: checksum,
        providerRequestId: "synthetic-original-request", updatedAt,
      }).where(eq(aiAssistExecutions.runId, id));
      await tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id));
      const [transaction] = await tx.execute<{ id: string }>(sql`select pg_current_xact_id()::text as id`);
      return transaction!.id;
    });
    const metadata = await evidence(a, "ai_assist_executions", id);
    expect(metadata).toEqual({
      ...execution, submission_state: "received", received_at: expect.any(String), response_checksum: checksum,
      provider_request_id: "synthetic-original-request", updated_at: expect.any(String),
      encrypted_response: null, response_receipt_transaction_id: receiptTransactionId,
    });
    expect(Date.parse(String(metadata!.updated_at))).toBe(updatedAt.getTime());
    expect(await evidence(a, "ai_assist_runs", id)).toEqual({ ...before, token_usage: usage });
    await withTenant(database.db, a, tx => tx.update(aiAssistExecutions).set({ encryptedResponse: "synthetic-sealed-response" }).where(eq(aiAssistExecutions.runId, id)));
    const encrypted = await evidence(a, "ai_assist_executions", id);
    expect(encrypted).toEqual({ ...metadata, encrypted_response: "synthetic-sealed-response" });
    expect(await evidence(a, "ai_assist_runs", id)).toEqual({ ...before, token_usage: usage });
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.execute(sql`
      update ai_assist_executions set response_receipt_transaction_id=pg_current_xact_id() where run_id=${id}::uuid
    `)), "55000");
    expect(await evidence(a, "ai_assist_executions", id)).toEqual(encrypted);
  });

  it("does not turn a touched historical terminal execution into a first-response transaction", async () => {
    const [column] = await withTenant(database.db, a, tx => tx.execute(sql`
      select is_nullable, column_default, udt_name from information_schema.columns
      where table_schema='public' and table_name='ai_assist_executions' and column_name='response_receipt_transaction_id'
    `));
    expect(column).toEqual({ is_nullable: "YES", column_default: null, udt_name: "xid8" });
    const id = await assist(a, "completed"), before = await evidence(a, "ai_assist_runs", id);
    const original = await evidence(a, "ai_assist_executions", id);
    expect(before?.token_usage).toBeNull();
    expect(original).toMatchObject({ phase: "completed", submission_state: "received", response_receipt_transaction_id: null });
    const touchedAt = new Date(Date.parse(String(original!.updated_at)) + 1_000);
    await withTenant(database.db, a, tx => tx.update(aiAssistExecutions).set({ updatedAt: touchedAt }).where(eq(aiAssistExecutions.runId, id)));
    const touched = await evidence(a, "ai_assist_executions", id);
    expect(touched).toEqual({ ...original, updated_at: expect.any(String) });
    expect(Date.parse(String(touched!.updated_at))).toBe(touchedAt.getTime());
    expect(touched?.response_receipt_transaction_id).toBeNull();
    await rejectsWithCode(() => withTenant(database.db, a, async tx => {
      await tx.update(aiAssistExecutions).set({ updatedAt: new Date(touchedAt.getTime() + 1_000) }).where(eq(aiAssistExecutions.runId, id));
      const [transaction] = await tx.execute(sql`
        select xmin::text as row_xmin, (txid_current()%4294967296)::text as current_xmin,
          response_receipt_transaction_id::text as receipt_origin
        from ai_assist_executions where run_id=${id}::uuid
      `);
      // Touching a received row changes xmin, but cannot mint receipt provenance.
      expect(transaction).toMatchObject({ row_xmin: transaction!.current_xmin, receipt_origin: null });
      await tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id));
    }), "55000");
    expect(await evidence(a, "ai_assist_runs", id)).toEqual(before);
    expect(await evidence(a, "ai_assist_executions", id)).toEqual(touched);
  });

  it("rejects a fabricated execution added to a historical terminal Assist in a later transaction", async () => {
    const id = await assist(a, "failed", true, { execution: false });
    const before = await evidence(a, "ai_assist_runs", id);
    expect(before).toMatchObject({ status: "failed", token_usage: null, creation_transaction_id: expect.any(String) });
    expect(await evidence(a, "ai_assist_executions", id)).toBeNull();
    await rejectsWithCode(() => withTenant(database.db, a, async tx => {
      const [transaction] = await tx.execute<{ id: string }>(sql`select pg_current_xact_id()::text as id`);
      expect(before!.creation_transaction_id).not.toBe(transaction!.id);
      await tx.insert(aiAssistExecutions).values({
        runId: id, tenantId: a.tenantId, inputFingerprint: checksum, policyChecksum: "c".repeat(64),
        phase: "failed", submissionState: "submitted", submittedAt: new Date(), attemptCount: 1, dispatchCount: 1,
      });
      await receiveAssist(tx, id);
      await tx.update(aiAssistRuns).set({ tokenUsage: usage }).where(eq(aiAssistRuns.id, id));
    }), "55000");
    expect(await evidence(a, "ai_assist_runs", id)).toEqual(before);
    expect(await evidence(a, "ai_assist_executions", id)).toBeNull();
  });

  it("writes an order model call's first usage without a reported price and freezes the original call", async () => {
    const id = await call(fixtureA), before = await evidence(a, "order_design_model_calls", id);
    const [saved] = await withTenant(database.db, a, tx => tx.update(orderDesignModelCalls).set({ receivedAt: new Date(), costReportState: "unknown", tokenUsage: usage }).where(eq(orderDesignModelCalls.id, id)).returning());
    expect(saved?.tokenUsage).toEqual(usage); expect(saved?.reportedCostUsd).toBeNull();
    expect(await evidence(a, "order_design_model_calls", id)).toEqual({ ...before, received_at: expect.any(String), cost_report_state: "unknown", token_usage: usage });
    const received = await evidence(a, "order_design_model_calls", id);
    await withTenant(database.db, a, tx => tx.update(orderDesignModelCalls).set({ tokenUsage: usage }).where(eq(orderDesignModelCalls.id, id)));
    for (const tokenUsage of [changedUsage, null]) await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(orderDesignModelCalls).set({ tokenUsage }).where(eq(orderDesignModelCalls.id, id))), "55000");
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(orderDesignModelCalls).set({ requestId: createEntityId() }).where(eq(orderDesignModelCalls.id, id))), "55000");
    expect(await evidence(a, "order_design_model_calls", id)).toEqual(received);
    const [budget] = await withTenant(database.db, a, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, saved!.budgetLedgerId)));
    expect(budget).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
  });

  it("writes POD usage only with a response and preserves the existing terminal receipt boundary", async () => {
    const id = await invocation(fixtureA), before = await evidence(a, "pod_artwork_invocations", id);
    await withTenant(database.db, a, tx => tx.update(podArtworkInvocations).set({ phase: "received", receivedAt: new Date(), responseChecksum: checksum, providerRequestId: "synthetic-original-request", metadataValid: true, tokenUsage: usage }).where(eq(podArtworkInvocations.id, id)));
    const received = await evidence(a, "pod_artwork_invocations", id);
    expect(received).toEqual({ ...before, phase: "received", received_at: expect.any(String), response_checksum: checksum, provider_request_id: "synthetic-original-request", metadata_valid: true, token_usage: usage });
    await withTenant(database.db, a, tx => tx.update(podArtworkInvocations).set({ tokenUsage: usage }).where(eq(podArtworkInvocations.id, id)));
    for (const tokenUsage of [changedUsage, null]) await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(podArtworkInvocations).set({ tokenUsage }).where(eq(podArtworkInvocations.id, id))), "55000");
    await withTenant(database.db, a, tx => tx.update(podArtworkInvocations).set({ phase: "failed", finishedAt: new Date() }).where(eq(podArtworkInvocations.id, id)));
    const terminal = await evidence(a, "pod_artwork_invocations", id);
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.update(podArtworkInvocations).set({ phase: "received" }).where(eq(podArtworkInvocations.id, id))), "55000");
    expect(await evidence(a, "pod_artwork_invocations", id)).toEqual(terminal);
  });

  it("rejects usage before each original response boundary", async () => {
    const assistId = await assist(a, "pending", false), callId = await call(fixtureA), podId = await invocation(fixtureA);
    for (const [table, id] of [["ai_assist_runs", assistId], ["order_design_model_calls", callId], ["pod_artwork_invocations", podId]] as const) {
      const before = await evidence(a, table, id);
      await rejectsWithCode(() => withTenant(database.db, a, tx => tx.execute(sql`update ${sql.identifier(table)} set token_usage=${JSON.stringify(usage)}::jsonb where id=${id}::uuid`)), "23514");
      expect(await evidence(a, table, id)).toEqual(before);
    }
  });

  it("keeps forced RLS and restricts original receipt reads and writes to the tenant application role", async () => {
    const [role] = await withTenant(database.db, a, tx => tx.execute(sql`select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname=current_user`));
    expect(role).toEqual({ name: "yummyai_app", rolsuper: false, rolbypassrls: false });
    const policies = await withTenant(database.db, a, tx => tx.execute(sql`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace='public'::regnamespace and relname in ('ai_assist_runs','order_design_model_calls','pod_artwork_invocations') order by relname
    `));
    expect([...policies]).toEqual([...receiptTables].sort().map(table => ({ relname: table, relrowsecurity: true, relforcerowsecurity: true })));
    const own = [await assist(a), await call(fixtureA), await invocation(fixtureA)];
    const foreign = [await assist(b), await call(fixtureB), await invocation(fixtureB)];
    for (const [index, table] of receiptTables.entries()) {
      const before = await evidence(b, table, foreign[index]!);
      expect(before).not.toBeNull(); expect(await evidence(a, table, own[index]!)).not.toBeNull();
      expect(await evidence(a, table, foreign[index]!)).toBeNull();
      const changed = await withTenant(database.db, a, tx => tx.execute(sql`update ${sql.identifier(table)} set token_usage=${JSON.stringify(usage)}::jsonb where id=${foreign[index]!}::uuid returning id`));
      expect([...changed]).toEqual([]); expect(await evidence(b, table, foreign[index]!)).toEqual(before);
    }
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.insert(aiAssistRuns).values({
      id: createEntityId(), tenantId: b.tenantId, ownerId: b.userId, requestId: createEntityId(), kind: "creative", scope: "synthetic-cross-tenant",
      inputFingerprint: checksum, requestFingerprint: checksum, modelSnapshot: { id: createEntityId(), providerConfigId: createEntityId(), model: "synthetic-model", label: "Synthetic model", providerLabel: "Synthetic provider", inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null },
      promptVersion: "synthetic-v1", reservedCostUsd: "0.1", expiresAt: new Date("2099-01-01T00:00:00Z"),
    })), "42501");
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.insert(podArtworkInvocations).values({ id: createEntityId(), tenantId: b.tenantId, taskId: fixtureB.podTaskId, attemptNumber: ++fixtureB.attempt, phase: "pending" })), "42501");
    const originalForeignCall = await evidence(b, "order_design_model_calls", foreign[1]!);
    // Its active run, step and reservation exist for B. RLS hides that original
    // submission from A, so the call's existing submission guard also rejects it.
    await rejectsWithCode(() => withTenant(database.db, a, tx => tx.execute(sql`
      insert into order_design_model_calls select * from jsonb_populate_record(null::order_design_model_calls,
        ${JSON.stringify({ ...originalForeignCall, id: createEntityId() })}::jsonb)
    `)), "55000");
    expect(await evidence(b, "order_design_model_calls", foreign[1]!)).toEqual(originalForeignCall);
  });
});
