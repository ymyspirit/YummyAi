import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import type { KnowledgeSearch } from "@yummyai/contracts/knowledge";
import {
  aiAssistRuns, assertDatabaseMigrationsCurrent, connectDatabase, loadCurrentMembershipContext,
  marketplaceAccounts, withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  evaluationAllPermissions, evaluationTextId, knowledgeEvaluationFixture, requireKnowledgeEvaluationEnvironment,
} from "../../../../tools/testing/knowledge-evaluation-fixture.mjs";

requireKnowledgeEvaluationEnvironment("current");

describe.sequential("original account answer object scope independent of aggregate permission rank", () => {
  const database = connectDatabase(), f = knowledgeEvaluationFixture(database);
  const documents: string[] = [], cards: string[] = [];
  const stores: Array<{ id: string; createdBy: string | null }> = [];
  beforeAll(async () => { await assertDatabaseMigrationsCurrent(database); await f.initialize(); });
  afterAll(async () => { await database.client.end(); });
  const current = (actor = f.a) => withTenant(database.db, f.seed(actor), tx => loadCurrentMembershipContext(tx, actor));

  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers(); const failures: unknown[] = [];
    try { await f.grant(); f.a.context = await current(); } catch (error) { failures.push(error); }
    try {
      await withTenant(database.db, f.seed(f.a), async tx => {
        for (const row of stores)
          expect(await tx.update(marketplaceAccounts).set({ createdBy: row.createdBy }).where(eq(marketplaceAccounts.id, row.id))
            .returning({ id: marketplaceAccounts.id, createdBy: marketplaceAccounts.createdBy })).toEqual([row]);
      });
    } catch (error) { failures.push(error); }
    for (const id of documents) try { await f.imports.dispose(f.a.context, id, "archive"); } catch (error) { failures.push(error); }
    for (const id of cards) try {
      const entry = (await f.knowledge.workspace(f.a.context)).entries.find(row => row.id === id);
      if (entry) await f.knowledge.change(f.a.context, id, "archive", { expectedRevision: entry.revision, version: entry.latestVersion,
        reason: "Synthetic account-answer fixture teardown", requestId: randomUUID() });
    } catch (error) { failures.push(error); }
    try {
      const pending = await f.pending();
      try {
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
        for (const row of pending) await f.processRun(row.id, f.a, "expire");
      } finally { vi.useRealTimers(); }
    } catch (error) { failures.push(error); }
    documents.length = 0; cards.length = 0; stores.length = 0;
    if (failures.length) throw new AggregateError(failures, "knowledge_account_answer_fixture_cleanup_failed");
  }); // The acceptance runner subsequently removes and verifies the complete disposable database/bucket/Redis.

  async function account(documentActor = f.a) {
    const id = createEntityId(), label = `Synthetic account ${evaluationTextId(id)}`;
    await withTenant(database.db, f.seed(f.a), tx => tx.insert(marketplaceAccounts).values({
      id, tenantId: f.a.tenantId, platform: "amazon", region: "NA", authorizationMode: "amazon_private", displayName: label, createdBy: f.a.userId,
    }));
    stores.push({ id, createdBy: f.a.userId });
    const created = await f.imports.upload(documentActor.context, { requestId: randomUUID(), fileName: "synthetic-account.txt",
      base64: Buffer.from("Synthetic account fixed fact for an isolated governance test.").toString("base64"),
      fields: f.fields(label), account: { storeId: id, currency: "USD", periodFrom: "2026-01-01", periodUntil: "2026-01-31", attribution: "Synthetic fixed period" }, retentionDays: 7 });
    documents.push(created.id);
    await f.imports.confirmAccount(documentActor.context, created.id, { expectedRevision: 1, text: "Synthetic account fixed fact",
      identitiesRemoved: true, credentialsRemoved: true, minimumNecessary: true, reason: "Synthetic explicit redaction checks" });
    const search: KnowledgeSearch = { query: label, topic: "operations", platform: "amazon", market: "US", spuIds: [] };
    return { storeId: id, documentId: created.id, search };
  }
  async function completed(context: TenantContext, search: KnowledgeSearch, evidenceStoreId: string | null) {
    const scopeId = randomUUID();
    const created = await f.assists.create(context, { kind: "knowledge_answer", purpose: "dialogue", scopeId,
      search, evidenceStoreId, previousRunId: null, modelId: f.modelId, requestId: randomUUID() });
    const reference = created.knowledge[0]; expect(reference).toBeDefined();
    f.setOutput(AssistResultSchema.parse({ summary: "Synthetic account fixed fact", findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact",
      kind: "fact", severity: "info", evidence: [{ sourceId: reference!.sourceId, detail: "Synthetic approved account evidence" }], location: null }],
      directions: [], matches: [], missingInformation: [] }));
    await f.processRun(created.id);
    const done = await f.assists.get(context, created.id);
    expect(done.status).toBe("completed"); expect(done.stale).toBe(false); expect(done.result).not.toBeNull();
    return { run: done, scopeId };
  }
  async function original(id: string) {
    return withTenant(database.db, f.seed(f.a), tx => tx.select({ encryptedInput: aiAssistRuns.encryptedInput,
      encryptedOutput: aiAssistRuns.encryptedOutput, inputFingerprint: aiAssistRuns.inputFingerprint,
      modelSnapshot: aiAssistRuns.modelSnapshot, promptVersion: aiAssistRuns.promptVersion,
    }).from(aiAssistRuns).where(eq(aiAssistRuns.id, id)));
  }

  it("hides original account questions and answers after store ownership changes while every self permission rank stays fixed", async () => {
    const source = await account(); await f.grant(f.a, evaluationAllPermissions, "self");
    const context = await current(); f.a.context = context;
    const { run, scopeId } = await completed(context, source.search, source.storeId);
    expect(run.knowledge.some(ref => ref.entryId === source.documentId)).toBe(true);
    expect((await f.answers.conversations(context)).some(row => row.scopeId === scopeId)).toBe(true);
    const pin = await original(run.id), state = await f.state(), calls = f.requests.length, dispatches = f.dispatches.length;
    await withTenant(database.db, f.seed(f.a), tx => tx.update(marketplaceAccounts).set({ createdBy: f.second.userId }).where(eq(marketplaceAccounts.id, source.storeId)));
    const unchanged = await current();
    expect(unchanged.permissions).toEqual(context.permissions);
    for (const permission of [Permission.WorkflowRead, Permission.StoreRead, Permission.FinanceRead]) expect(permissionScope(unchanged, permission)).toBe("self");
    const decrypt = vi.spyOn(f.vault, "withSecret");
    await expect(f.assists.get(context, run.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(decrypt.mock.calls.some(([cipher]) => cipher === pin[0]!.encryptedOutput)).toBe(false);
    expect((await f.answers.conversations(context)).some(row => row.scopeId === scopeId)).toBe(false);
    expect(await original(run.id)).toEqual(pin); expect(await f.state()).toEqual(state);
    expect(f.requests).toHaveLength(calls); expect(f.dispatches).toHaveLength(dispatches);
  });

  it("checks the original account document owner even when the store stays owned and aggregate Workflow authority remains tenant", async () => {
    const source = await account(f.second), { run, scopeId } = await completed(f.a.context, source.search, source.storeId);
    const pin = await original(run.id), state = await f.state(), calls = f.requests.length, dispatches = f.dispatches.length;
    const accountBits = [Permission.StoreRead, Permission.FinanceRead];
    await f.grant(f.a, accountBits, "self", evaluationAllPermissions.filter(bit => !accountBits.some(accountBit => accountBit === bit)));
    const context = await current(); f.a.context = context;
    expect(context.dataScope).toBe("tenant"); expect(permissionScope(context, Permission.WorkflowRead)).toBe("tenant");
    expect(permissionScope(context, Permission.StoreRead)).toBe("self"); expect(permissionScope(context, Permission.FinanceRead)).toBe("self");
    await expect(f.assists.get(context, run.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await f.answers.conversations(context)).some(row => row.scopeId === scopeId)).toBe(false);
    expect(await original(run.id)).toEqual(pin); expect(await f.state()).toEqual(state);
    expect(f.requests).toHaveLength(calls); expect(f.dispatches).toHaveLength(dispatches);
  });

  it("keeps genuinely general historical questions readable without Store or Finance authority", async () => {
    const cardFields = f.fields(), card = await f.knowledge.save(f.a.context, null, { fields: cardFields, expectedRevision: 0,
      reason: "Synthetic general account-scope control", requestId: randomUUID() }); cards.push(card.id); await f.publish(card.id);
    const search: KnowledgeSearch = { query: cardFields.title, topic: "operations", platform: "amazon", market: "US", spuIds: [] };
    const { run, scopeId } = await completed(f.a.context, search, null), pin = await original(run.id);
    await f.grant(f.a, evaluationAllPermissions.filter(bit => bit !== Permission.StoreRead && bit !== Permission.FinanceRead));
    const context = await current(); f.a.context = context;
    expect((await f.assists.get(context, run.id)).result).not.toBeNull();
    expect((await f.answers.conversations(context)).some(row => row.scopeId === scopeId)).toBe(true);
    expect(await original(run.id)).toEqual(pin);
  });
});
