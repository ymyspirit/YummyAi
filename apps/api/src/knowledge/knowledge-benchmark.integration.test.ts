import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { BENCHMARK_RULE_VERSION } from "@yummyai/contracts/knowledge/benchmark";
import { openBenchmarkValue, type AssistContext } from "@yummyai/ai-core";
import { assertDatabaseMigrationsCurrent, connectDatabase, knowledgeBenchmarkItems, knowledgeBenchmarkAssessments, knowledgeBenchmarkReviews,
  knowledgeBenchmarkExperiments, knowledgeBenchmarkExpenses, memberships, withTenant, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as importOwner from "./knowledge-import.service.js";
import { KnowledgeBenchmarkDatasetService, recordBenchmarkCommand } from "./knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService, benchmarkAssessmentView } from "./knowledge-benchmark-experiment.service.js";
import { KnowledgeBenchmarkCostService } from "./knowledge-benchmark-cost.service.js";
import { ModelBillingService } from "../ai/model-billing.service.js";
import { ModelConfigurationService } from "../ai/model-configuration.service.js";
import { expireKnowledgeBenchmarkBodiesInTenant } from "../../../worker/src/knowledge-benchmark-retention.js";
import { knowledgeBenchmarkFixture, benchmarkSha, benchmarkTables, requireKnowledgeBenchmarkEnvironment } from "../../../../tools/testing/knowledge-benchmark-fixture.mjs";

requireKnowledgeBenchmarkEnvironment("current");
const rollback = new Error("Synthetic benchmark SQL control rollback");
function pg(error: unknown): { code?: string; message?: string } {
  for (let depth = 0; depth < 7 && error && typeof error === "object"; depth++) {
    if ("code" in error && typeof error.code === "string") return { code: error.code, message: "message" in error ? String(error.message) : undefined };
    error = "cause" in error ? error.cause : undefined;
  }
  return {};
}

describe.sequential("fixed published knowledge datasets and all-attempt benchmark execution", () => {
  const database = connectDatabase(), f = knowledgeBenchmarkFixture(database);
  beforeAll(async () => { await assertDatabaseMigrationsCurrent(database); await f.initialize(); });
  afterAll(async () => { await database.client.end(); });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); f.controls.failQueue = false; delete f.controls.beforeQueue; delete f.controls.beforeResponse;
    await f.grant(); await f.grant(f.second);
    const pending = await f.pending();
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      for (const row of pending) await f.processRun(row.id, row.ownerId === f.second.userId ? f.second : f.a, "expire");
    } finally { vi.useRealTimers(); }
  });
  type Scene = Awaited<ReturnType<typeof f.experiment>>;
  async function start(scene: Scene, index = 0, patch: { requestId?: string; expectedLatestAttemptId?: string | null } = {}) {
    const item = scene.version.items[index]!, cell = (await f.experiments.get(f.a.context, scene.created.id)).cells.find(row => row.itemId === item.id)!;
    const input = { itemId: item.id, expectedLatestAttemptId: cell.latestAttemptId, confirmNewPaidAttempt: true as const, requestId: randomUUID(), ...patch };
    return { input, receipt: await f.experiments.start(f.a.context, scene.created.id, input) };
  }
  async function review(id: string, patch: { decision?: "pass" | "fail" | "needs_review"; minutes?: string; hourlyUsd?: string | null } = {}) {
    const current = await f.experiments.attempt(f.a.context, id);
    const input = { expectedReviewId: current.review?.id ?? null, decision: "pass" as const, minutes: "1.500", hourlyUsd: "120.00000000",
      reason: "Synthetic original evidence and structured result independently checked", requestId: randomUUID(), ...patch };
    return { input, receipt: await f.experiments.review(f.a.context, id, input) };
  }
  async function nativeCount(requestId: string) {
    const [row] = await withTenant(database.db, f.a.context, tx => tx.execute<{ attempts: number; natives: number; budgets: number; executions: number; protocols: number; starts: number }>(sql`select
      (select count(*)::int from knowledge_benchmark_attempts where request_id=${requestId}::uuid) as attempts,
      (select count(*)::int from ai_assist_runs where request_id=${requestId}::uuid) as natives,
      (select count(*)::int from ai_budget_ledger where request_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as budgets,
      (select count(*)::int from ai_assist_executions where run_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as executions,
      (select count(*)::int from knowledge_evaluation_protocols where run_id in(select id from knowledge_evaluation_runs where request_id=${requestId}::uuid)) as protocols,
      (select count(*)::int from knowledge_governance_events where action='benchmark.attempt.start' and resource_id in(select id from knowledge_benchmark_attempts where request_id=${requestId}::uuid)) as starts`));
    return row!;
  }
  const oneNative = { attempts: 1, natives: 1, budgets: 1, executions: 1, protocols: 1, starts: 1 };
  async function expense(scene: Scene, arm: "baseline" | "candidate", patch: { storageUsd?: string | null; maintenanceUsd?: string | null } = {}) {
    const summary = await f.costs.summary(f.a.context, scene.created.id);
    const input = { arm, expectedExpenseId: summary.latestExpenses.find(row => row.arm === arm)?.id ?? null,
      storageUsd: "0.01000000", maintenanceUsd: "0.25000000", expectedActivityFingerprint: summary[arm].activityFingerprint,
      periodStart: scene.experiment.createdAt, periodEnd: new Date().toISOString(), allocationBasis: "Synthetic cumulative actual storage and maintenance allocation", confirmedActual: true as const, requestId: randomUUID(), ...patch };
    return { input, receipt: await f.costs.expense(f.a.context, scene.created.id, input) };
  }
  async function acknowledge(attemptId: string, amountUsd: string) {
    vi.stubEnv("MODEL_BILLING_TENANT_IDS", f.a.tenantId);
    const attempt = await f.experiments.attempt(f.a.context, attemptId);
    if (!attempt.evaluationRunId) throw new Error("Synthetic provider billing requires the actual candidate evaluation");
    const native = await f.evaluations.report(f.a.context, attempt.evaluationRunId), owner = new ModelBillingService(database);
    const basis = await owner.basis(f.a.context, "assist", native.answer.id); expect(basis.canConfirm).toBe(true);
    const input = { commandId: randomUUID(), expectedFingerprint: basis.fingerprint, amountUsd, currency: "USD", evidenceKind: "provider_invoice",
      invoiceReference: `synthetic-benchmark-${randomUUID()}`, providerRequestId: basis.providerRequestId ?? `synthetic-manual-${native.answer.id}`,
      proofChecksum: benchmarkSha(`synthetic-billing:${native.answer.id}:${amountUsd}`), matchesOriginalRequest: true };
    return owner.confirm(f.a.context, "assist", native.answer.id, input);
  }

  it("publishes immutable complete source versions and isolated cases without gold in execution or public evaluation bypass", async () => {
    const s = await f.dataset(), calls = f.requests.length, before = await f.datasets.version(f.a.context, s.version.id);
    expect(before.items).toHaveLength(2); expect(before.items.map(row => row.ordinal)).toEqual([0, 1]);
    for (const item of before.items) {
      if(item.fields.role!=="knowledge_answer"||!item.caseId)throw new Error("Knowledge fixture must remain its original native role");
      const [row] = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeBenchmarkItems).where(eq(knowledgeBenchmarkItems.id, item.id)));
      const basis = openBenchmarkValue<{ prepared: AssistContext }>(f.vault, "basis", row!.encryptedBasis!);
      expect(item.sourcePins).toEqual((basis.prepared.knowledge ?? []).map(source => ({ sourceId: source.sourceId, entryId: source.entryId,
        versionId: source.versionId, version: source.version, checksum: source.checksum, title: source.title })));
      expect(item.fields.evaluation.requiredEntryIds).toEqual([s.sources[item.ordinal]!.cardId]);
      expect(item.sourcePins.map(source => "entryId" in source?source.entryId:null)).toContain(s.sources[item.ordinal]!.cardId);
      expect(JSON.stringify(basis.prepared)).not.toContain("expectedFacts"); expect(JSON.stringify(basis.prepared)).not.toContain("expectedValue");
      expect(basis.prepared.data.benchmarkCalculations).toEqual([{ key: "total", operator: "product", operands: ["3", "12.34"], scale: 2, unit: "money", currency: "USD" }]);
      const state = await f.state();
      await expect(f.evaluations.start(f.a.context, item.caseId, { modelId: f.modelId, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      await expect(f.governance.saveEvaluation(f.a.context, item.caseId, { fields: { ...item.fields.evaluation, label: "Cannot mutate published sample" }, expectedRevision: 1, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      expect(await f.state()).toEqual(state);
    }
    const changed = structuredClone(s.fields), firstChanged=changed.items[0]!;
    if(firstChanged.role!=="knowledge_answer")throw new Error("Knowledge fixture must remain its original native role");
    firstChanged.calculations[0]!.expectedValue = "999"; changed.name = "Synthetic later draft";
    await f.datasets.save(f.a.context, s.saved.id, { fields: changed, expectedRevision: 1, reason: "Synthetic separate later revision", requestId: randomUUID() });
    expect(await f.datasets.version(f.a.context, s.version.id)).toEqual(before);
    const originalCard = s.sources[0]!, card = (await f.knowledge.workspace(f.a.context)).entries.find(row => row.id === originalCard.cardId)!;
    await f.knowledge.save(f.a.context, card.id, { fields: { ...originalCard.cardFields, body: originalCard.cardFields.body + " Synthetic explicitly reviewed source revision two" },
      expectedRevision: card.revision, reason: "Synthetic new immutable source revision", requestId: randomUUID() }); await f.publish(card.id);
    const next = await f.datasets.publish(f.a.context, s.saved.id, { expectedRevision: 2, retentionDays: 30, reason: "Synthetic new dataset version with changed source and independent expectation", requestId: randomUUID() });
    const nextVersion = await f.datasets.version(f.a.context, next.id);
    expect(nextVersion.id).not.toBe(before.id); expect(nextVersion.checksum).not.toBe(before.checksum);
    const nextSource = nextVersion.items[0]!.sourcePins.find(source => "entryId" in source && source.entryId === originalCard.cardId), originalSource = before.items[0]!.sourcePins.find(source => "entryId" in source && source.entryId === originalCard.cardId);
    expect(nextSource&&"version" in nextSource?nextSource.version:null).toBe(2); expect(nextSource?.checksum).not.toBe(originalSource?.checksum);
    expect(nextVersion.items[0]!.basisFingerprint).not.toBe(before.items[0]!.basisFingerprint); expect(await f.datasets.version(f.a.context, s.version.id)).toEqual(before);
    const separate = await f.experiments.create(f.a.context, { datasetVersionId: nextVersion.id, baselineVersion: BENCHMARK_RULE_VERSION, label: "Synthetic separate later fixed basis",
      modelId: f.modelId, maxAttemptsPerItem: 1, reason: "Synthetic same-rule new-basis independent experiment", requestId: randomUUID() });
    expect((await f.experiments.get(f.a.context, separate.id)).cells[0]!.baselineHardPass).toBe(false);
    const general = await f.governance.workspace(f.a.context);
    expect(general.evaluations.some(row => before.items.some(item => item.caseId === row.id))).toBe(false);
    expect(f.requests).toHaveLength(calls);
  });

  it("runs two free rule arms and commits each explicit candidate native birth, budget and benchmark attempt before dispatch", async () => {
    const calls = f.requests.length, s = await f.experiment();
    expect(s.experiment.baselineVersion).toBe(BENCHMARK_RULE_VERSION);
    expect(f.requests).toHaveLength(calls); expect(s.experiment.cells.every(row => row.baselineHardPass && row.state === "not_started")).toBe(true);
    const baseline = await f.experiments.attempts(f.a.context, s.created.id, { arm: "baseline" });
    expect(baseline.total).toBe(2);
    for (const row of baseline.items) {
      const actual = await f.experiments.attempt(f.a.context, row.id);
      expect(actual).toMatchObject({ evaluationRunId: null, state: "completed", assessment: { hardPass: true }, modelCost: { amountUsd: "0.00000000", source: "not_submitted", confirmedProviderCalls: 0 } });
      expect(actual.result?.typedAnswers?.[0]?.value).toBe("37.02");
    }
    let births: Record<string, string> | undefined, beforeQueue = 0;
    f.controls.beforeQueue = async ({ id }) => {
      beforeQueue++;
      const [row] = await withTenant(database.db, f.a.context, tx => tx.execute<Record<string, string>>(sql`select n.creation_transaction_id::text as native,
        a.creation_transaction_id as attempt,p.creation_transaction_id as protocol,e.xmin::text as evaluation,x.xmin::text as execution,b.xmin::text as budget,g.xmin::text as event
        from ai_assist_runs n join knowledge_evaluation_runs e on e.assist_run_id=n.id join knowledge_evaluation_protocols p on p.run_id=e.id
        join knowledge_benchmark_attempts a on a.evaluation_run_id=e.id join ai_assist_executions x on x.run_id=n.id join ai_budget_ledger b on b.request_id=n.id
        join knowledge_governance_events g on g.resource_id=a.id and g.action='benchmark.attempt.start' where n.id=${id}::uuid`));
      births = row;
    };
    const first = await start(s); expect(beforeQueue).toBe(1); expect(births).toBeDefined(); expect(new Set(Object.values(births!)).size).toBe(1);
    delete f.controls.beforeQueue; expect(await nativeCount(first.input.requestId)).toEqual(oneNative);
    const done = await f.complete(first.receipt.id, s.version); expect(done.attempt.assessment?.hardPass).toBe(true);
    expect(done.attempt.modelCost).toMatchObject({ amountUsd: "0.00021000", source: "usage_estimate", confirmedProviderCalls: 1, possibleProviderCalls: 0 });
    expect(f.requests).toHaveLength(calls + 1);
    const body = JSON.stringify(f.requests.at(-1)!.body);
    expect(body).not.toContain("expectedValue"); expect(body).not.toContain("expectedFacts"); expect(body).not.toContain("37.02");
    expect(body).toContain("benchmarkCalculations");
    const original = done.attempt.assessment;
    expect((await f.experiments.attempt(f.a.context, first.receipt.id)).assessment).toEqual(original);
    expect(f.requests).toHaveLength(calls + 1);
  });

  it("serializes exact simultaneous paid intents and rejects reused actor, item and experiment pins without a second native run", async () => {
    const s = await f.experiment(), item = s.version.items[0]!, input = { itemId: item.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    const key = `knowledge-benchmark-request:${f.a.tenantId}:${input.requestId}`;
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<number>(resolve => { ready = resolve; });
    const blocker = withTenant(database.db, f.a.context, async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
      const [pid] = await tx.execute<{ id: number }>(sql`select pg_backend_pid() as id`); ready(pid!.id); await gate; });
    const pending: Array<Promise<{ id: string; revision: number }>> = [];
    try {
      const pid = await held;
      const waiters = async () => Number((await database.client.unsafe("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='advisory' and $1::int=any(pg_blocking_pids(pid))", [pid]))[0]!.n);
      for (let index = 0; index < 3; index++) { const promise = f.experiments.start(f.a.context, s.created.id, input); void promise.catch(() => {}); pending.push(promise); }
      await expect.poll(waiters, { timeout: 15_000 }).toBe(3); release(); await blocker;
      const results = await Promise.all(pending); expect(new Set(results.map(row => row.id)).size).toBe(1); expect(await nativeCount(input.requestId)).toEqual(oneNative);
      expect(await f.datasets.request(f.a.context, input.requestId)).toMatchObject({ operation: "attempt.start", parentId: s.created.id, receipt: results[0] });
      const rebuilt = new KnowledgeBenchmarkExperimentService(database, f.evaluations, f.vault);
      expect(await rebuilt.start(f.a.context, s.created.id, input)).toEqual(results[0]);
      await expect(f.experiments.start(f.second.context, s.created.id, input)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.experiments.start(f.a.context, s.created.id, { ...input, itemId: s.version.items[1]!.id })).rejects.toBeInstanceOf(ConflictException);
      await expect(f.experiments.start(f.a.context, s.created.id, { ...input, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      expect(await nativeCount(input.requestId)).toEqual(oneNative);
      await f.complete(results[0]!.id, s.version);
    } finally { release(); await blocker; await Promise.allSettled(pending); }
  });

  it("rolls back failed publication and paid-start audits and restores a committed queue failure only by the original request", async () => {
    const sources = await f.sources(), draft = await f.datasets.save(f.a.context, null, { fields: sources.fields, expectedRevision: 0, reason: "Synthetic atomic publication", requestId: randomUUID() });
    const original = importOwner.recordKnowledgeGovernanceEvent;
    const spy = vi.spyOn(importOwner, "recordKnowledgeGovernanceEvent").mockImplementation(async (...args) => {
      if (args[3] === "benchmark.dataset.publish" || args[3] === "benchmark.attempt.start") throw new Error("Synthetic benchmark governance audit unavailable");
      return original(...args);
    });
    let state = await f.state(), dispatches = f.dispatches.length;
    await expect(f.datasets.publish(f.a.context, draft.id, { expectedRevision: 1, retentionDays: 30, reason: "Synthetic publish rollback", requestId: randomUUID() })).rejects.toThrow("Synthetic benchmark governance audit unavailable");
    expect(await f.state()).toEqual(state); expect(f.dispatches).toHaveLength(dispatches); spy.mockRestore();
    const s = await f.experiment(); state = await f.state(); dispatches = f.dispatches.length;
    vi.spyOn(importOwner, "recordKnowledgeGovernanceEvent").mockImplementation(async (...args) => {
      if (args[3] === "benchmark.attempt.start") throw new Error("Synthetic benchmark governance audit unavailable"); return original(...args);
    });
    const input = { itemId: s.version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    await expect(f.experiments.start(f.a.context, s.created.id, input)).rejects.toThrow("Synthetic benchmark governance audit unavailable");
    expect(await f.state()).toEqual(state); expect(f.dispatches).toHaveLength(dispatches); vi.restoreAllMocks();
    f.controls.failQueue = true; const first = await f.experiments.start(f.a.context, s.created.id, input); f.controls.failQueue = false;
    expect(await f.experiments.start(f.a.context, s.created.id, input)).toEqual(first); expect(await nativeCount(input.requestId)).toEqual(oneNative);
    await f.complete(first.id, s.version);
    expect(await f.experiments.start(f.a.context, s.created.id, input)).toEqual(first);
  });

  it("hard fails incorrect numeric answers despite matching phrases and never falls back to an earlier qualified paid attempt", async () => {
    const s = await f.experiment(2, { maxAttemptsPerItem: 3 }), first = await start(s);
    await f.complete(first.receipt.id, s.version); await review(first.receipt.id);
    expect((await f.experiments.get(f.a.context, s.created.id)).cells[0]).toMatchObject({ latestAttemptId: first.receipt.id, hardPass: true, qualified: true });
    const second = await start(s); const failed = await f.complete(second.receipt.id, s.version, { value: "37.01", includeGoldInSummary: true });
    expect(failed.attempt.assessment?.checks.find(row => row.key === "expected_facts")?.status).toBe("pass");
    expect(failed.attempt.assessment?.checks.find(row => row.key === "numeric:total")?.status).toBe("fail");
    const sealed = failed.attempt.assessment; await review(second.receipt.id, { decision: "pass", minutes: "2.250" });
    expect((await f.experiments.attempt(f.a.context, second.receipt.id)).assessment).toEqual(sealed);
    expect((await f.experiments.get(f.a.context, s.created.id)).cells[0]).toMatchObject({ latestAttemptId: second.receipt.id, hardPass: false, qualified: false });
    const third = await start(s); expect((await f.experiments.get(f.a.context, s.created.id)).cells[0]).toMatchObject({ latestAttemptId: third.receipt.id, state: "queued", qualified: false });
    await f.complete(third.receipt.id, s.version); await review(third.receipt.id);
    const full = await f.experiments.attempts(f.a.context, s.created.id, { itemId: s.version.items[0]!.id, arm: "candidate" });
    expect(full.total).toBe(3); expect(full.items.map(row => row.ordinal).sort()).toEqual([1, 2, 3]);
    expect(full.items.every(row => row.modelCost.amountUsd === "0.00021000")).toBe(true);
    await expect(start(s)).rejects.toBeInstanceOf(ConflictException);
  });

  it("accumulates all human reviews, replaces cumulative expenses and invalidates expense coverage after new activity", async () => {
    const s = await f.experiment(), candidates: string[] = [];
    for (let index = 0; index < 2; index++) {
      const started = await start(s, index); candidates.push(started.receipt.id); await f.complete(started.receipt.id, s.version); await review(started.receipt.id);
    }
    const first = await expense(s, "candidate"), state = await f.state();
    expect(await f.costs.expense(f.a.context, s.created.id, first.input)).toEqual(first.receipt); expect(await f.state()).toEqual(state);
    expect((await f.costs.summary(f.a.context, s.created.id)).candidate).toMatchObject({ state: "estimated", totalItems: 2, qualifiedItems: 2,
      allAttempts: 2, modelKnownUsd: "0.00042000", humanKnownUsd: "6.00000000", reviewMinutes: "3.000", totalUsd: "6.26042000", unitQualifiedCostUsd: null, estimatedUnitQualifiedCostUsd: "3.13021000" });
    await review(candidates[0]!, { minutes: "0.500" });
    const stale = await f.costs.summary(f.a.context, s.created.id);
    expect(stale.candidate).toMatchObject({ state: "incomplete", qualifiedItems: 2, humanKnownUsd: "7.00000000", reviewMinutes: "3.500", totalUsd: null });
    expect(stale.candidate.activityFingerprint).not.toBe(first.input.expectedActivityFingerprint);
    const before = await f.state();
    await expect(f.costs.expense(f.a.context, s.created.id, { ...first.input, expectedExpenseId: first.receipt.id, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    const replacement = await expense(s, "candidate", { storageUsd: "0.10000000", maintenanceUsd: "0.50000000" });
    expect(replacement.receipt.revision).toBe(2);
    const replaced = await f.costs.summary(f.a.context, s.created.id);
    expect(replaced.candidate).toMatchObject({ state: "estimated", storageKnownUsd: "0.10000000", maintenanceKnownUsd: "0.50000000", knownSubtotalUsd: "7.60042000" });
    expect(replaced.latestExpenses.filter(row => row.arm === "candidate")).toHaveLength(1);
    const fourth = await start(s); expect((await f.costs.summary(f.a.context, s.created.id)).candidate).toMatchObject({ state: "incomplete", allAttempts: 3, qualifiedItems: 1, totalUsd: null });
    expect((await f.experiments.attempt(f.a.context, fourth.receipt.id)).state).toBe("queued");
  });

  it("uses actual eight-decimal provider acknowledgements and seals original report IDs instead of rewriting earlier cost conclusions", async () => {
    const s = await f.experiment(), candidates: string[] = [];
    for (let index = 0; index < 2; index++) { const next = await start(s, index); candidates.push(next.receipt.id); await f.complete(next.receipt.id, s.version); await review(next.receipt.id); }
    for (const row of (await f.experiments.attempts(f.a.context, s.created.id, { arm: "baseline" })).items) await review(row.id, { minutes: "0", hourlyUsd: null });
    await expense(s, "candidate"); await expense(s, "baseline", { storageUsd: "0", maintenanceUsd: "0" });
    const calls = f.requests.length, input = { reason: "Synthetic original estimated report", requestId: randomUUID() }, first = await f.costs.report(f.a.context, s.created.id, input);
    const original = await f.costs.readReport(f.a.context, first.id), firstHash = benchmarkSha(canonicalJson(original));
    expect(await new KnowledgeBenchmarkCostService(database, f.experiments, f.vault).readReport(f.a.context, first.id)).toEqual(original);
    expect(original.summary.candidate).toMatchObject({ state: "estimated", totalUsd: "6.26042000", unitQualifiedCostUsd: null });
    expect(original.attemptIds).toHaveLength(4); expect(original.assessmentIds).toHaveLength(4); expect(original.reviewIds).toHaveLength(4); expect(original.billingReceiptIds).toEqual([]);
    const firstBilling = await acknowledge(candidates[0]!, "0.00123456"), secondBilling = await acknowledge(candidates[1]!, "0.00234567");
    const acknowledged = await f.costs.summary(f.a.context, s.created.id);
    expect(acknowledged.candidate).toMatchObject({ state: "complete", modelKnownUsd: "0.00358023", totalUsd: "6.26358023", unitQualifiedCostUsd: "3.13179012" });
    const second = await f.costs.report(f.a.context, s.created.id, { reason: "Synthetic later acknowledged report", requestId: randomUUID() });
    const recorded = await f.costs.readReport(f.a.context, second.id);
    expect(recorded.sequence).toBe(original.sequence + 1); expect(new Set(recorded.billingReceiptIds)).toEqual(new Set([firstBilling.receipt.id, secondBilling.receipt.id]));
    expect(recorded.summary.candidate).toEqual(acknowledged.candidate);
    const before = await f.state(); expect(await f.costs.report(f.a.context, s.created.id, input)).toEqual(first); expect(await f.state()).toEqual(before);
    await acknowledge(candidates[0]!, "0.01000000");
    expect((await f.costs.summary(f.a.context, s.created.id)).candidate).toMatchObject({ state: "complete", modelKnownUsd: "0.01234567", totalUsd: "6.27234567" });
    expect(benchmarkSha(canonicalJson(await f.costs.readReport(f.a.context, first.id)))).toBe(firstHash);
    expect(await f.costs.readReport(f.a.context, second.id)).toEqual(recorded); expect(f.requests).toHaveLength(calls);
  });

  it("enforces current per-permission scope and original ceilings and withholds a late provider answer while retaining its paid attempt", async () => {
    const s = await f.experiment(), started = await start(s), all = Object.values(Permission);
    const readOnly = [Permission.WorkflowRead], before = await f.state();
    await f.grant(f.a, readOnly);
    expect((await f.experiments.get(f.a.context, s.created.id)).id).toBe(s.created.id);
    expect((await f.costs.summary(f.a.context, s.created.id)).experimentId).toBe(s.created.id);
    await expect(review(s.experiment.cells[0]!.baselineAttemptId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.experiments.start(f.a.context, s.created.id, started.input)).rejects.toBeInstanceOf(ForbiddenError);
    await f.grant(); expect(await f.state()).toEqual(before);
    const ceiling = { ...f.a.context, permissions: [Permission.WorkflowRead] };
    await expect(f.experiments.start(ceiling, s.created.id, started.input)).rejects.toBeInstanceOf(ForbiddenError);
    await f.grant(f.a, [Permission.WorkflowRead], "self", all.filter(value => value !== Permission.WorkflowRead));
    await expect(f.experiments.get(f.a.context, s.created.id)).rejects.toBeInstanceOf(ForbiddenError);
    await f.grant();
    for (const actor of [f.second, f.foreign]) {
      await expect(f.datasets.version(actor.context, s.version.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.experiments.get(actor.context, s.created.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.experiments.attempt(actor.context, started.receipt.id)).rejects.toBeInstanceOf(NotFoundException);
    }
    await withTenant(database.db, f.seed(f.a), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.a.membershipId)));
    await expect(f.datasets.version(f.a.context, s.version.id)).rejects.toThrow(); await f.grant();
    const queued = await f.experiments.attempt(f.a.context, started.receipt.id), native = await f.evaluations.report(f.a.context, queued.evaluationRunId!);
    f.setOutput(f.output(s.version.items[0]!));
    let release!: () => void, observed!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { observed = resolve; });
    f.controls.beforeResponse = async () => { observed(); await gate; };
    const processing = f.processRun(native.answer.id); void processing.catch(() => {});
    try {
      await Promise.race([arrived, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic benchmark provider gate timeout")), 15_000); })]);
      await f.grant(f.a, all.filter(value => value !== Permission.WorkflowRun)); release(); await processing;
    } finally { if (timer) clearTimeout(timer); release(); delete f.controls.beforeResponse; await Promise.allSettled([processing]); await f.grant(); }
    const denied = await f.experiments.attempt(f.a.context, started.receipt.id);
    expect(denied).toMatchObject({ state: "failed", assessment: null, result: null, resultAvailable: false });
    expect(denied.modelCost.amountUsd).toBe("0.00021000"); expect(denied.modelCost.source).toBe("usage_estimate");
    expect((await f.costs.summary(f.a.context, s.created.id)).candidate).toMatchObject({ qualifiedItems: 0, modelKnownUsd: "0.00021000", unitQualifiedCostUsd: null });
  });

  it("reads more than twenty fixed sample arms and complete report history through actual cursors and direct original IDs without dispatch", async () => {
    const s = await f.experiment(25), calls = f.requests.length, dispatches = f.dispatches.length;
    expect(s.experiment.itemCount).toBe(25); expect(s.experiment.cells).toHaveLength(25);
    const all: string[] = []; let cursor: string | undefined;
    do {
      const page = await f.experiments.attempts(f.a.context, s.created.id, { arm: "baseline", limit: 7, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(25); expect(page.items.length).toBeLessThanOrEqual(7);
      all.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toHaveLength(25); expect(new Set(all).size).toBe(25); expect(all).toEqual([...all].sort().reverse());
    expect(new Set(all)).toEqual(new Set(s.experiment.cells.map(row => row.baselineAttemptId)));
    expect((await f.experiments.attempt(f.a.context, all.at(-1)!)).assessment?.hardPass).toBe(true);
    const reports = [];
    for (let index = 0; index < 21; index++) reports.push(await f.costs.report(f.a.context, s.created.id, { reason: `Synthetic complete report history ${index}`, requestId: randomUUID() }));
    const before = await f.state(), history: string[] = []; cursor = undefined;
    do {
      const page = await f.costs.reports(f.a.context, s.created.id, { limit: 8, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(21); history.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(history).toEqual(reports.map(row => row.id).sort().reverse());
    expect((await f.costs.readReport(f.a.context, reports[0]!.id)).attemptIds).toHaveLength(25);
    await expect(f.experiments.attempts(f.a.context, s.created.id, { cursor: createEntityId() })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.costs.reports(f.a.context, s.created.id, { cursor: all[0] })).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.state()).toEqual(before); expect(f.requests).toHaveLength(calls); expect(f.dispatches).toHaveLength(dispatches);
  });

  it("restores expired original commands and sealed grades without paying again or allowing a fresh attempt on expired or withdrawn evidence", async () => {
    const s = await f.experiment(), started = await start(s); await f.complete(started.receipt.id, s.version); await review(started.receipt.id);
    const recorded = await f.experiments.attempt(f.a.context, started.receipt.id), calls = f.requests.length;
    const reportReceipt = await f.costs.report(f.a.context, s.created.id, { reason: "Synthetic before expiry original report", requestId: randomUUID() });
    const report = await f.costs.readReport(f.a.context, reportReceipt.id);
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      const native = await f.evaluations.report(f.a.context, recorded.evaluationRunId!); await f.processRun(native.answer.id, f.a, "expire");
      expect(await f.experiments.start(f.a.context, s.created.id, started.input)).toEqual(started.receipt);
      expect(await f.datasets.publish(f.a.context, s.saved.id, s.publishInput)).toEqual(s.published);
      expect(await f.datasets.request(f.a.context, started.input.requestId)).toMatchObject({ receipt: started.receipt });
      const retired = await f.experiments.attempt(f.a.context, started.receipt.id);
      expect(retired.resultAvailable).toBe(false); expect(retired.result).toBeNull(); expect(retired.assessment).toEqual(recorded.assessment); expect(retired.review).toEqual(recorded.review);
      expect((await f.datasets.version(f.a.context, s.version.id)).items.every(row => !row.usable)).toBe(true);
      const before = await f.state(); await expect(start(s)).rejects.toBeInstanceOf(ConflictException); expect(await f.state()).toEqual(before);
      expect(await f.costs.readReport(f.a.context, reportReceipt.id)).toEqual(report);
    } finally { vi.useRealTimers(); }
    const source = (await f.knowledge.workspace(f.a.context)).entries.find(row => row.id === s.sources[0]!.cardId)!;
    await f.knowledge.change(f.a.context, source.id, "disable", { expectedRevision: source.revision, version: source.activeVersion,
      reason: "Synthetic original source explicitly withdrawn", requestId: randomUUID() });
    const before = await f.state(); await expect(start(s)).rejects.toThrow(); expect(await f.state()).toEqual(before);
    const rebuilt = new KnowledgeBenchmarkDatasetService(database, f.evaluations, f.vault);
    expect((await rebuilt.request(f.a.context, started.input.requestId)).receipt).toEqual(started.receipt); expect(f.requests).toHaveLength(calls);
  });

  it("retains unknown provider prices and unfinished human verification as incomplete full costs instead of free qualified work", async () => {
    const name = `Synthetic unpriced ${randomUUID()}`, configuration = new ModelConfigurationService(database, f.modelVault);
    const configured = await configuration.invoke(f.a.context, { operation: "channel.save", name, baseUrl: "https://synthetic-evaluation.invalid/v1",
      apiKey: "synthetic-no-provider-credential", textProtocol: "chat_completions", models: [{ name: `synthetic-unpriced-${randomUUID()}`, capability: "text" }] });
    if (!("channels" in configured)) throw new Error("Synthetic channel save requires its actual configuration snapshot");
    const route = configured.channels.find(channel => channel.name === name)?.models.find(model => model.capability === "text");
    if (!route) throw new Error("Synthetic unpriced model requires its actual configured text route");
    const modelId = route.id;
    expect((await f.assists.models(f.a.context)).find(model => model.id === modelId)).toMatchObject({ inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null });
    const s = await f.experiment(2, { modelId }), first = await start(s); await f.complete(first.receipt.id, s.version);
    await review(first.receipt.id, { minutes: "2", hourlyUsd: null, decision: "needs_review" }); await expense(s, "candidate", { storageUsd: null, maintenanceUsd: "0" });
    const attempt = await f.experiments.attempt(f.a.context, first.receipt.id);
    expect(attempt.modelCost).toMatchObject({ amountUsd: null, source: "unknown", confirmedProviderCalls: 1 });
    const summary = (await f.costs.summary(f.a.context, s.created.id)).candidate;
    expect(summary).toMatchObject({ state: "incomplete", totalItems: 2, qualifiedItems: 0, notRunItems: 1, pendingReviewItems: 1, totalUsd: null, unitQualifiedCostUsd: null, estimatedUnitQualifiedCostUsd: null });
    expect(summary.missing.join(" ")).toContain("模型费用未知"); expect(summary.missing.join(" ")).toContain("人工费率未知"); expect(summary.missing.join(" ")).toContain("存储费用未知");
  });

  it("raw closure requires actual fixed parents, same-transaction command and audit, private authenticated grades and no activity after an early expense seal", async () => {
    const s = await f.experiment(), baseline = s.experiment.cells[0]!.baselineAttemptId;
    const [assessment] = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeBenchmarkAssessments).where(eq(knowledgeBenchmarkAssessments.attemptId, baseline)));
    expect(assessment).toBeDefined(); expect(benchmarkAssessmentView(f.vault, assessment!).hardPass).toBe(true);
    expect(() => benchmarkAssessmentView(f.vault, { ...assessment!, attemptId: s.experiment.cells[1]!.baselineAttemptId })).toThrow("benchmark_assessment_unavailable");
    expect(() => benchmarkAssessmentView(f.vault, { ...assessment!, proof: assessment!.proof.slice(0, -3) + "xyz" })).toThrow("benchmark_assessment_unavailable");
    for (const actor of [f.second, f.foreign]) await withTenant(database.db, actor.context, async tx => {
      const [role] = await tx.execute<{ app: boolean }>(sql`select current_user='yummyai_app' as app`); expect(role!.app).toBe(true);
      for (const table of benchmarkTables.filter(table => table !== "knowledge_benchmark_retention_jobs"))
        expect(await tx.execute(sql`select id from ${sql.identifier(table)}`), table).toEqual([]);
    });
    async function rawReview(tx: TenantTransaction, mode: "valid" | "missing_command" | "missing_audit" = "valid", previousId: string | null = null, sequence = 1) {
      const id = createEntityId(), createdAt = new Date(), input = { expectedReviewId: previousId, decision: "pass", minutes: "0.250", hourlyUsd: "120.00000000",
        reason: "Synthetic real raw review closure control", requestId: randomUUID() };
      await tx.insert(knowledgeBenchmarkReviews).values({ id, tenantId: f.a.tenantId, createdBy: f.a.userId, createdAt, creationTransactionId: "forged-marker",
        attemptId: baseline, assessmentId: assessment!.id, previousId, sequence, decision: "pass", minutes: input.minutes, hourlyUsd: input.hourlyUsd, reason: input.reason });
      if (mode !== "missing_audit") await importOwner.recordKnowledgeGovernanceEvent(tx, f.a.context, id, "benchmark.attempt.review", input.reason, { attemptId: baseline, assessmentId: assessment!.id, sequence });
      if (mode !== "missing_command") await recordBenchmarkCommand(tx, f.a.context, "attempt.review", baseline, input, { id, revision: sequence }, "tenant", createdAt);
      const [born] = await tx.execute<{ stored: string; actual: string }>(sql`select creation_transaction_id as stored,pg_current_xact_id()::text as actual from knowledge_benchmark_reviews where id=${id}::uuid`);
      expect(born!.stored).toBe(born!.actual); expect(born!.stored).not.toBe("forged-marker"); return { id, input };
    }
    const before = await f.state();
    await expect(withTenant(database.db, f.a.context, async tx => { await rawReview(tx); await tx.execute(sql`set constraints all immediate`); throw rollback; })).rejects.toBe(rollback);
    expect(await f.state()).toEqual(before);
    for (const action of ["benchmark.report.create", "benchmark.body.purged"] as const) {
      await expect(withTenant(database.db, f.a.context, async tx => {
        await importOwner.recordKnowledgeGovernanceEvent(tx, f.a.context, createEntityId(), action, "Synthetic false success audit without an actual result", {});
        await tx.execute(sql`set constraints all immediate`);
      })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_audit_result_required");
      expect(await f.state()).toEqual(before);
    }
    for (const [mode, message] of [["missing_command", "benchmark_command_required"], ["missing_audit", "benchmark_audit_required"]] as const) {
      await expect(withTenant(database.db, f.a.context, async tx => { await rawReview(tx, mode); await tx.execute(sql`set constraints all immediate`); })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === message);
      expect(await f.state()).toEqual(before);
    }
    const [existing] = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeBenchmarkExperiments).where(eq(knowledgeBenchmarkExperiments.id, s.created.id)));
    await expect(withTenant(database.db, f.a.context, async tx => {
      await tx.insert(knowledgeBenchmarkExperiments).values({ ...existing!, id: createEntityId(), createdAt: new Date() }); await tx.execute(sql`set constraints all immediate`);
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_baseline_incomplete");
    expect(await f.state()).toEqual(before);
    await expect(withTenant(database.db, f.a.context, async tx => {
      const first = await rawReview(tx); await tx.execute(sql`set constraints all immediate`);
      await tx.update(knowledgeBenchmarkReviews).set({ minutes: "0.001" }).where(eq(knowledgeBenchmarkReviews.id, first.id));
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "42501");
    expect(await f.state()).toEqual(before);
    await expect(withTenant(database.db, f.a.context, async tx => {
      const first = await rawReview(tx), [activity] = await tx.execute<{ fingerprint: string }>(sql`select knowledge_benchmark_activity(${s.created.id}::uuid,'baseline') as fingerprint`);
      const id = createEntityId(), createdAt = new Date(), input = { arm: "baseline", expectedExpenseId: null, storageUsd: "0.00000000", maintenanceUsd: "0.00000000",
        expectedActivityFingerprint: activity!.fingerprint, periodStart: s.experiment.createdAt, periodEnd: createdAt.toISOString(), allocationBasis: "Synthetic actual early-flush expense control", confirmedActual: true, requestId: randomUUID() };
      await tx.insert(knowledgeBenchmarkExpenses).values({ id, tenantId: f.a.tenantId, createdBy: f.a.userId, creationTransactionId: "0", createdAt,
        experimentId: s.created.id, arm: "baseline", previousId: null, sequence: 1, storageUsd: input.storageUsd, maintenanceUsd: input.maintenanceUsd,
        activityFingerprint: activity!.fingerprint, periodStart: new Date(input.periodStart), periodEnd: createdAt, allocationBasis: input.allocationBasis });
      await importOwner.recordKnowledgeGovernanceEvent(tx, f.a.context, id, "benchmark.expense.record", input.allocationBasis, { experimentId: s.created.id, arm: "baseline", sequence: 1 });
      await recordBenchmarkCommand(tx, f.a.context, "expense.record", s.created.id, input, { id, revision: 1 }, "tenant", createdAt);
      await tx.execute(sql`set constraints all immediate`); await rawReview(tx, "valid", first.id, 2);
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_expense_transaction_sealed");
    expect(await f.state()).toEqual(before);
  });

  it("actually clears expired published and baseline ciphertext through durable tenant jobs after revocation without clearing native evidence, grades or unexpired neighbours", async () => {
    const s = await f.experiment(2, { retentionDays: 1 }), neighbour = await f.experiment(2, { retentionDays: 30 }), started = await start(s);
    const done = await f.complete(started.receipt.id, s.version); await review(started.receipt.id);
    const receipt = await f.costs.report(f.a.context, s.created.id, { reason: "Synthetic original metadata and cost receipt before body expiry", requestId: randomUUID() });
    const report = await f.costs.readReport(f.a.context, receipt.id), recordedGrade = done.attempt.assessment;
    const eligibleIds = [...s.version.items.map(row => row.id), ...s.experiment.cells.map(row => row.baselineAttemptId)];
    async function retained() {
      return withTenant(database.db, f.seed(f.a), async tx => {
        const [row] = await tx.execute<{ basis: number; baseline: number; pending: number; completed: number; purgedEvents: number; versionHash: string; gradeHash: string; nativeHash: string; neighbourHash: string; reportHash: string }>(sql`select
          (select count(*)::int from knowledge_benchmark_items where version_id=${s.version.id}::uuid and encrypted_basis is not null) as basis,
          (select count(*)::int from knowledge_benchmark_assessments s join knowledge_benchmark_attempts a on a.id=s.attempt_id where a.experiment_id=${s.created.id}::uuid and a.arm='baseline' and s.encrypted_output is not null) as baseline,
          (select count(*)::int from knowledge_benchmark_retention_jobs where resource_id in(select id from knowledge_benchmark_items where version_id=${s.version.id}::uuid union select s.id from knowledge_benchmark_assessments s join knowledge_benchmark_attempts a on a.id=s.attempt_id where a.experiment_id=${s.created.id}::uuid and a.arm='baseline') and state='pending') as pending,
          (select count(*)::int from knowledge_benchmark_retention_jobs where resource_id in(select id from knowledge_benchmark_items where version_id=${s.version.id}::uuid union select s.id from knowledge_benchmark_assessments s join knowledge_benchmark_attempts a on a.id=s.attempt_id where a.experiment_id=${s.created.id}::uuid and a.arm='baseline') and state='completed') as completed,
          (select count(*)::int from knowledge_governance_events where action='benchmark.body.purged' and resource_id in(select id from knowledge_benchmark_items where version_id=${s.version.id}::uuid union select s.id from knowledge_benchmark_assessments s join knowledge_benchmark_attempts a on a.id=s.attempt_id where a.experiment_id=${s.created.id}::uuid and a.arm='baseline')) as "purgedEvents",
          (select md5(to_jsonb(v)::text) from knowledge_benchmark_versions v where id=${s.version.id}::uuid) as "versionHash",
          (select md5(jsonb_agg(to_jsonb(v)-'encrypted_output' order by v.id)::text) from knowledge_benchmark_assessments v join knowledge_benchmark_attempts a on a.id=v.attempt_id where a.experiment_id=${s.created.id}::uuid) as "gradeHash",
          (select md5(to_jsonb(n)::text) from ai_assist_runs n where id=${done.native.answer.id}::uuid) as "nativeHash",
          (select md5(jsonb_agg(to_jsonb(v) order by v.id)::text) from knowledge_benchmark_items v where version_id=${neighbour.version.id}::uuid) as "neighbourHash",
          (select md5(to_jsonb(v)::text) from knowledge_benchmark_reports v where id=${receipt.id}::uuid) as "reportHash"`);
        return row!;
      });
    }
    expect(eligibleIds).toHaveLength(4); const original = await retained();
    expect(original).toMatchObject({ basis: 2, baseline: 2, pending: 4, completed: 0, purgedEvents: 0 });
    expect(await expireKnowledgeBenchmarkBodiesInTenant(database, f.a.tenantId)).toEqual({ expired: 0, failed: 0 });
    const before = await f.state();
    await expect(withTenant(database.db, f.a.context, tx => tx.update(knowledgeBenchmarkItems).set({ encryptedBasis: null }).where(eq(knowledgeBenchmarkItems.id, s.version.items[0]!.id)))).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_history_immutable");
    expect(await f.state()).toEqual(before);
    const { nonce, workspace } = requireKnowledgeBenchmarkEnvironment("current");
    const [clock] = await database.client.unsafe<{ database: string; definition: string }[]>("select current_database() as database,pg_get_functiondef('knowledge_benchmark_now()'::regprocedure) as definition");
    expect(clock?.database).toBe(`order_daily_e2e_${nonce}`); if (!clock?.definition) throw new Error("Original benchmark clock definition missing");
    let operationError: unknown, restoreError: unknown, restored = false;
    try {
      await database.client.unsafe("create or replace function knowledge_benchmark_now() returns timestamptz language sql volatile set search_path=pg_catalog,public as $$ select clock_timestamp()+interval '2 days' $$");
      await expect(withTenant(database.db, f.a.context, async tx => {
        await tx.update(knowledgeBenchmarkItems).set({ encryptedBasis: null }).where(eq(knowledgeBenchmarkItems.id, s.version.items[0]!.id));
        await tx.execute(sql`set constraints all immediate`);
      })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_retention_receipt_required");
      expect(await retained()).toEqual(original);
      await f.grant(f.a, []);
      const expired = await expireKnowledgeBenchmarkBodiesInTenant(database, f.a.tenantId); expect(expired).toEqual({ expired: 4, failed: 0 });
      const after = await retained(); expect(after).toMatchObject({ basis: 0, baseline: 0, pending: 0, completed: 4, purgedEvents: 4 });
      for (const field of ["versionHash", "gradeHash", "nativeHash", "neighbourHash", "reportHash"] as const) expect(after[field], field).toBe(original[field]);
      expect(await expireKnowledgeBenchmarkBodiesInTenant(database, f.a.tenantId)).toEqual({ expired: 0, failed: 0 });
      expect(await retained()).toEqual(after);
    } catch (error) { operationError = error; }
    finally {
      try {
        await database.client.unsafe(clock.definition);
        const [actual] = await database.client.unsafe<{ definition: string }[]>("select pg_get_functiondef('knowledge_benchmark_now()'::regprocedure) as definition");
        restored = actual?.definition === clock.definition; if (!restored) restoreError = new Error("Original benchmark clock definition was not restored byte for byte");
      } catch (error) { restoreError = error; }
      try { await f.grant(); } catch (error) { restoreError = restoreError ? new AggregateError([restoreError, error], "Benchmark clock and role restoration failed") : error; }
      try {
        const path = resolve(workspace, "tmp/knowledge-benchmark-20261021-a7d9e6c2/qa"); await mkdir(path, { recursive: true });
        await writeFile(resolve(path, `retention-clock-${nonce}.json`), JSON.stringify({ nonce, sourceClockOnly: true, originalDefinitionSha256: benchmarkSha(clock.definition), restored,
          tenantRowsTimeChanged: false, oldAiClockChanged: false, operationSucceeded: operationError === undefined }, null, 2) + "\n");
      } catch (error) { restoreError = restoreError ? new AggregateError([restoreError, error], "Benchmark restoration evidence could not be saved") : error; }
    }
    if (operationError && restoreError) throw new AggregateError([operationError, restoreError], "Benchmark retention operation and clock restoration failed");
    if (restoreError) throw restoreError; if (operationError) throw operationError;
    expect((await f.datasets.version(f.a.context, s.version.id)).items.every(row => !row.usable)).toBe(true);
    const baseline = await f.experiments.attempt(f.a.context, s.experiment.cells[0]!.baselineAttemptId); expect(baseline.resultAvailable).toBe(false); expect(baseline.result).toBeNull();
    expect((await f.experiments.attempt(f.a.context, started.receipt.id)).assessment).toEqual(recordedGrade);
    expect(await f.costs.readReport(f.a.context, receipt.id)).toEqual(report);
    expect((await retained()).purgedEvents).toBe(4);
  });
});
