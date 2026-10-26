import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import type { KnowledgeSearch } from "@yummyai/contracts/knowledge";
import { assertDatabaseMigrationsCurrent, connectDatabase, withTenant, loadCurrentMembershipContext,
  productPlans, organizationTeams, organizationTeamMembers } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { knowledgeEvaluationFixture, evaluationAllPermissions, evaluationTextId, requireKnowledgeEvaluationEnvironment } from "../../../../tools/testing/knowledge-evaluation-fixture.mjs";

requireKnowledgeEvaluationEnvironment("current");

describe.sequential("knowledge answers and evaluations recheck original product scope without changing permission rank", () => {
  const database = connectDatabase(), f = knowledgeEvaluationFixture(database);
  const catalog = new ProductDevelopmentService(database, createStorageFromEnvironment());
  const cards: string[] = [], teamIds: string[] = [], teamMemberIds: string[] = [];
  const originalPlans: Array<{ id: string; createdBy: string | null; teamId: string | null }> = [];
  beforeAll(async () => { await assertDatabaseMigrationsCurrent(database); await f.initialize(); });
  afterAll(async () => { await database.client.end(); });

  const current = (actor = f.a) => withTenant(database.db, f.seed(actor), tx => loadCurrentMembershipContext(tx, actor));
  async function missing(read: Promise<unknown>) {
    await expect(read).rejects.toBeInstanceOf(NotFoundException);
    // A missing current object is 404; a random failure or missing permission is not acceptable.
  }
  afterEach(async () => {
    vi.useRealTimers();
    const failures: unknown[] = [];
    try { await f.grant(); f.a.context = await current(); } catch (error) { failures.push(error); }
    // These SQL edits are disposable fixture ownership/team simulation only.
    // Every exact original tuple is restored; no success run or approval is fabricated.
    try { await withTenant(database.db, f.seed(f.a), async tx => {
      for (const row of originalPlans) {
        const restored = await tx.update(productPlans).set({ createdBy: row.createdBy, teamId: row.teamId }).where(eq(productPlans.id, row.id))
          .returning({ id: productPlans.id, createdBy: productPlans.createdBy, teamId: productPlans.teamId });
        expect(restored).toEqual([row]);
      }
    }); } catch (error) { failures.push(error); }
    for (const id of cards) try {
      const row = (await f.knowledge.workspace(f.a.context)).entries.find(entry => entry.id === id);
      if (row) await f.knowledge.change(f.a.context, id, "archive", { expectedRevision: row.revision,
        version: row.latestVersion, reason: "Synthetic answer scope fixture teardown", requestId: randomUUID() });
    } catch (error) { failures.push(error); }
    try { await withTenant(database.db, f.seed(f.a), async tx => {
      if (teamMemberIds.length) await tx.delete(organizationTeamMembers).where(inArray(organizationTeamMembers.id, teamMemberIds));
      if (teamIds.length) await tx.delete(organizationTeams).where(inArray(organizationTeams.id, teamIds));
    }); } catch (error) { failures.push(error); }
    try {
      // Team insert/delete changes teamAuthority even though the role permissions do not change.
      // Refresh only fixture lifecycle snapshots, never the saved context across the SPU transfer.
      f.a.context = await current(); f.second.context = await current(f.second);
      expect(f.a.context.teamIds).toEqual([]); expect(f.second.context.teamIds).toEqual([]);
      expect(new Set(f.a.context.permissions)).toEqual(new Set(evaluationAllPermissions));
      for (const permission of evaluationAllPermissions) expect(permissionScope(f.a.context, permission)).toBe("tenant");
    } catch (error) { failures.push(error); }
    originalPlans.length = 0; cards.length = 0; teamMemberIds.length = 0; teamIds.length = 0;
    try {
      const pending = await f.pending();
      // Reuse the original expiry owner for incomplete synthetic work after a failed assertion.
      try {
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
        for (const row of pending) await f.processRun(row.id, f.a, "expire");
      } finally { vi.useRealTimers(); }
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "knowledge_answer_scope_fixture_cleanup_failed");
  });

  async function sources(scope: "self" | "team") {
    const lost = (await catalog.createSpu(f.a.context, { code: "KS-" + createEntityId(), name: "Synthetic lost scoped product", idempotencyKey: randomUUID() })).spu;
    const kept = (await catalog.createSpu(f.a.context, { code: "KS-" + createEntityId(), name: "Synthetic retained scoped product", idempotencyKey: randomUUID() })).spu;
    const ids = [lost.productPlanId, kept.productPlanId];
    const rows = await withTenant(database.db, f.seed(f.a), tx => tx.select({ id: productPlans.id, createdBy: productPlans.createdBy,
      teamId: productPlans.teamId }).from(productPlans).where(inArray(productPlans.id, ids)));
    expect(rows).toHaveLength(2); originalPlans.push(...rows);
    let teamA: string | null = null, teamB: string | null = null;
    if (scope === "team") {
      teamA = createEntityId(); teamB = createEntityId(); teamIds.push(teamA, teamB);
      const memberA = createEntityId(), memberB = createEntityId(); teamMemberIds.push(memberA, memberB);
      await withTenant(database.db, f.seed(f.a), async tx => {
        await tx.insert(organizationTeams).values([teamA!, teamB!].map(id => ({ id, tenantId: f.a.tenantId, name: "Synthetic scope " + id, createdBy: f.a.userId })));
        await tx.insert(organizationTeamMembers).values([
          { id: memberA, tenantId: f.a.tenantId, teamId: teamA!, membershipId: f.a.membershipId, createdBy: f.a.userId },
          { id: memberB, tenantId: f.a.tenantId, teamId: teamB!, membershipId: f.second.membershipId, createdBy: f.a.userId },
        ]);
        // Both products are genuinely team-readable rather than passing the owner fallback.
        await tx.update(productPlans).set({ createdBy: f.second.userId, teamId: teamA }).where(inArray(productPlans.id, ids));
      });
    }
    // The original owner helpers use these actor snapshots for card.save/publish.
    // Adding actual fixture team memberships invalidates the pre-team snapshot.
    f.a.context = await current(); f.second.context = await current(f.second);
    return { lost, kept, teamA, teamB };
  }

  async function card(spuId: string | null, label: string) {
    const fields = { ...f.fields("Synthetic " + label + " " + evaluationTextId()), spuId };
    const created = await f.knowledge.save(f.a.context, null, { fields, expectedRevision: 0,
      reason: "Synthetic product-scoped source", requestId: randomUUID() });
    cards.push(created.id); await f.publish(created.id);
    const search: KnowledgeSearch = { query: fields.title, topic: "operations", platform: "amazon", market: "US", spuIds: spuId ? [spuId] : [] };
    return { id: created.id, fields, search };
  }

  async function complete(runId: string) {
    const initial = await f.assists.get(await current(), runId), reference = initial.knowledge[0];
    expect(reference).toBeDefined();
    f.setOutput(AssistResultSchema.parse({ summary: "Synthetic fixed fact", findings: [{ title: "Synthetic fixed fact",
      detail: "Synthetic fixed fact", kind: "fact", severity: "info", evidence: [{ sourceId: reference!.sourceId,
        detail: "Synthetic original product-scoped source" }], location: null }], directions: [], matches: [], missingInformation: [] }));
    await f.processRun(runId);
    const done = await f.assists.get(await current(), runId);
    expect(done.status).toBe("completed"); expect(done.stale).toBe(false); expect(done.result?.summary).toBe("Synthetic fixed fact");
    return done;
  }

  async function dialogue(context: TenantContext, search: KnowledgeSearch) {
    const scopeId = randomUUID();
    const run = await f.assists.create(context, { kind: "knowledge_answer", purpose: "dialogue", scopeId, search,
      evidenceStoreId: null, previousRunId: null, modelId: f.modelId, requestId: randomUUID() });
    return { run: await complete(run.id), scopeId };
  }

  for (const scope of ["self", "team"] as const) it("hides completed answers conversations and evaluation snapshots when an original SPU leaves unchanged " + scope + " scope", async () => {
    const products = await sources(scope);
    const lostCard = await card(products.lost.id, "lost scope"), keptCard = await card(products.kept.id, "kept scope"), generalCard = await card(null, "general scope");
    const caseFields = { label: "Synthetic original private case " + evaluationTextId(), search: lostCard.search,
      expectedFacts: ["Synthetic fixed fact"], forbiddenClaims: ["Synthetic forbidden claim"], requiredEntryIds: [lostCard.id], expectRefusal: false };
    const savedCase = await f.governance.saveEvaluation(f.a.context, null, { fields: caseFields, expectedRevision: 0, requestId: randomUUID() });
    // The search is genuinely general; only the fixed required bibliography carries the private SPU.
    // This must not become readable merely because search.spuIds is empty.
    const referenceOnlyFields = { ...caseFields, label: "Synthetic reference-only private case " + evaluationTextId(),
      search: generalCard.search, expectedFacts: ["Synthetic private reference-only expectation"], requiredEntryIds: [lostCard.id] };
    expect(referenceOnlyFields.search.spuIds).toEqual([]);
    const referenceOnlyCase = await f.governance.saveEvaluation(f.a.context, null, { fields: referenceOnlyFields,
      expectedRevision: 0, requestId: randomUUID() });
    await f.grant(f.a, evaluationAllPermissions, scope);
    const context = await current(); f.a.context = context;
    expect(permissionScope(context, Permission.ProductRead)).toBe(scope);
    const lost = await dialogue(context, lostCard.search), kept = await dialogue(context, keptCard.search), general = await dialogue(context, generalCard.search);
    const evaluation = await f.evaluations.start(context, savedCase.id, { modelId: f.modelId, requestId: randomUUID() });
    const pending = await f.evaluations.report(context, evaluation.id); await complete(pending.answer.id);
    const report = await f.evaluations.report(context, evaluation.id);
    expect(report.caseSnapshot).toEqual(caseFields); expect(report.answer.status).toBe("completed"); expect(report.answer.stale).toBe(false);
    expect(report.assessmentState).toBe("recorded");
    const referenceOnlyInput = { modelId: f.modelId, requestId: randomUUID() };
    const referenceOnly = await f.evaluations.start(context, referenceOnlyCase.id, referenceOnlyInput);
    const referencePending = await f.evaluations.report(context, referenceOnly.id); await complete(referencePending.answer.id);
    const referenceReport = await f.evaluations.report(context, referenceOnly.id);
    expect(referenceReport.caseSnapshot).toEqual(referenceOnlyFields);
    expect(referenceReport.answer.status).toBe("completed"); expect(referenceReport.answer.stale).toBe(false);
    expect(referenceReport.assessmentState).toBe("recorded");
    expect(await f.evaluations.start(context, referenceOnlyCase.id, referenceOnlyInput)).toEqual(referenceOnly);
    expect((await f.answers.conversations(context)).map(row => row.scopeId)).toEqual(expect.arrayContaining([lost.scopeId, kept.scopeId, general.scopeId]));
    // Actual tenant and original-owner protections remain independent of catalog visibility.
    await missing(f.assists.get(f.second.context, lost.run.id)); await missing(f.assists.get(f.foreign.context, lost.run.id));
    await missing(f.evaluations.report(f.second.context, evaluation.id)); await missing(f.evaluations.report(f.foreign.context, evaluation.id));
    const unchanged = await f.state(), modelCalls = f.requests.length, dispatches = f.dispatches.length;
    await withTenant(database.db, f.seed(f.a), tx => tx.update(productPlans)
      .set({ createdBy: f.second.userId, teamId: products.teamB }).where(eq(productPlans.id, products.lost.productPlanId)));
    const after = await current();
    expect(permissionScope(after, Permission.ProductRead)).toBe(scope);
    expect(after.permissions).toEqual(context.permissions); expect(after.permissionScopes).toEqual(context.permissionScopes);
    expect(after.teamIds).toEqual(context.teamIds); expect(after.teamAuthority).toBe(context.teamAuthority);
    await missing(f.assists.get(context, lost.run.id));
    const conversations = await f.answers.conversations(context);
    expect(conversations.some(row => row.scopeId === lost.scopeId)).toBe(false);
    expect(conversations.map(row => row.scopeId)).toEqual(expect.arrayContaining([kept.scopeId, general.scopeId]));
    await missing(f.evaluations.report(context, evaluation.id));
    await missing(f.evaluations.page(context, savedCase.id));
    await missing(f.evaluations.review(context, evaluation.id, { result: "pass", reason: "Synthetic review must be rejected after product leaves scope" }));
    await missing(f.evaluations.start(context, referenceOnlyCase.id, { modelId: f.modelId, requestId: randomUUID() }));
    await missing(f.evaluations.start(context, referenceOnlyCase.id, referenceOnlyInput));
    await missing(f.evaluations.report(context, referenceOnly.id));
    await missing(f.assists.get(context, referenceReport.answer.id));
    await missing(f.evaluations.page(context, referenceOnlyCase.id));
    await missing(f.evaluations.review(context, referenceOnly.id, { result: "pass", reason: "Synthetic required-entry-only private case must not survive lost SPU scope" }));
    for (const accessible of [kept.run, general.run]) {
      const still = await f.assists.get(context, accessible.id);
      expect(still.status).toBe("completed"); expect(still.stale).toBe(false); expect(still.result).toEqual(accessible.result);
      expect(still.knowledge).toEqual(accessible.knowledge); expect(still.costUsd).toBe(accessible.costUsd);
    }
    expect(await f.state()).toEqual(unchanged); expect(f.requests).toHaveLength(modelCalls); expect(f.dispatches).toHaveLength(dispatches);
  });
});
