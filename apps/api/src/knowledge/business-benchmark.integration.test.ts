import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { BenchmarkDatasetFieldsSchema, BUSINESS_BENCHMARK_RULE_VERSION } from "@yummyai/contracts/knowledge/benchmark";
import { businessBenchmarkBasisFingerprint, businessBenchmarkSourcePins } from "@yummyai/ai-core";
import { assertDatabaseMigrationsCurrent, connectDatabase, aiAssistRuns, knowledgeBenchmarkAssessments,
  knowledgeBenchmarkCommands, knowledgeBenchmarkReviews, loadCurrentMembershipContext, withTenant, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as importOwner from "./knowledge-import.service.js";
import { benchmarkAssessmentView, KnowledgeBenchmarkExperimentService } from "./knowledge-benchmark-experiment.service.js";
import { recordBenchmarkCommand } from "./knowledge-benchmark-dataset.service.js";
import { ModelConfigurationService } from "../ai/model-configuration.service.js";
import { expireKnowledgeBenchmarkBodiesInTenant } from "../../../worker/src/knowledge-benchmark-retention.js";
import { businessBenchmarkFixture, businessBenchmarkSha, requireBusinessBenchmarkEnvironment } from "../../../../tools/testing/business-benchmark-fixture.mjs";

requireBusinessBenchmarkEnvironment("current");
const rollback = new Error("Synthetic business benchmark raw control rollback");
function pg(error: unknown): { code?: string; message?: string } {
  for (let depth = 0; depth < 7 && error && typeof error === "object"; depth++) {
    if ("code" in error && typeof error.code === "string") return { code: error.code, message: "message" in error ? String(error.message) : undefined };
    error = "cause" in error ? error.cause : undefined;
  }
  return {};
}

describe.sequential("fixed original procurement and finance native benchmark execution", () => {
  const database = connectDatabase(), f = businessBenchmarkFixture(database);
  beforeAll(async () => { await assertDatabaseMigrationsCurrent(database); await f.initialize(); });
  afterAll(async () => { try { f.close(); } finally { await database.client.end(); } });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers(); f.controls.failQueue = false; delete f.controls.beforeQueue; delete f.controls.beforeResponse;
    await f.grant(); await f.grant(f.second);
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      for (const row of await f.pending()) await f.processRun(row.id, row.ownerId === f.second.userId ? f.second : f.a, "expire");
    } finally { vi.useRealTimers(); }
  });
  type Scene = Awaited<ReturnType<typeof f.experiment>>;
  async function start(s: Scene, index = 0) {
    const item = s.version.items[index]!, cell = (await f.experiments.get(f.a.context, s.created.id)).cells.find(row => row.itemId === item.id)!;
    const input = { itemId: item.id, expectedLatestAttemptId: cell.latestAttemptId, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    return { input, receipt: await f.experiments.start(f.a.context, s.created.id, input) };
  }
  async function review(id: string, options: { decision?: "pass" | "needs_review"; minutes?: string; hourlyUsd?: string | null } = {}) {
    const attempt = await f.experiments.attempt(f.a.context, id), input = { expectedReviewId: attempt.review?.id ?? null, decision: "pass" as const,
      minutes: "1.500", hourlyUsd: "120.00000000", reason: "Synthetic human checks original quantities and minor units; phrase matching is not semantic monetary proof",
      requestId: randomUUID(), ...options };
    return { input, receipt: await f.experiments.review(f.a.context, id, input) };
  }
  async function nativeCount(requestId: string) {
    return (await withTenant(database.db, f.a.context, tx => tx.execute<{ attempts: number; natives: number; budgets: number; executions: number; protocols: number; starts: number }>(sql`select
      (select count(*)::int from knowledge_benchmark_attempts where request_id=${requestId}::uuid) as attempts,
      (select count(*)::int from ai_assist_runs where request_id=${requestId}::uuid) as natives,
      (select count(*)::int from ai_budget_ledger where request_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as budgets,
      (select count(*)::int from ai_assist_executions where run_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as executions,
      (select count(*)::int from knowledge_evaluation_protocols where run_id in(select id from knowledge_evaluation_runs where request_id=${requestId}::uuid)) as protocols,
      (select count(*)::int from knowledge_governance_events where action='benchmark.attempt.start' and resource_id in(select id from knowledge_benchmark_attempts where request_id=${requestId}::uuid)) as starts`)))[0]!;
  }
  const oneNative = { attempts: 1, natives: 1, budgets: 1, executions: 1, protocols: 0, starts: 1 };
  async function expense(s: Scene, arm: "baseline" | "candidate", values: { storageUsd?: string | null; maintenanceUsd?: string | null } = {}) {
    const summary = await f.costs.summary(f.a.context, s.created.id), input = { arm,
      expectedExpenseId: summary.latestExpenses.find(row => row.arm === arm)?.id ?? null,
      storageUsd: "0.01000000", maintenanceUsd: "0.02000000", expectedActivityFingerprint: summary[arm].activityFingerprint,
      periodStart: s.experiment.createdAt, periodEnd: new Date().toISOString(), allocationBasis: "Synthetic cumulative actual period allocation",
      confirmedActual: true as const, requestId: randomUUID(), ...values };
    return { input, receipt: await f.costs.expense(f.a.context, s.created.id, input) };
  }

  it("publishes four real two-role owner packets and free baselines with immutable source pins, missing evidence and no gold in native input", async () => {
    const calls = f.requests.length, source = await f.dataset(), before = await f.businessState(f.a.context);
    expect(source.version.items.map(row => row.fields.role)).toEqual(["procurement_review", "procurement_review", "business_review", "business_review"]);
    for (const item of source.version.items) {
      if (item.fields.role === "knowledge_answer") throw new Error("This dataset must contain only the two actual business roles");
      const prepared = await f.originalPrepared(item);
      expect(item.caseId).toBeNull(); expect(item.sourcePins.length).toBeGreaterThan(0);
      expect(item.sourcePins).toEqual(businessBenchmarkSourcePins(prepared));
      expect(item.basisFingerprint).toBe(businessBenchmarkBasisFingerprint(item.fields, prepared));
      for (const key of ["expectedFacts", "forbiddenClaims", "expectedValue", "expectRefusal"]) expect(JSON.stringify(prepared)).not.toContain(`"${key}"`);
      expect(prepared.benchmarkExecutionVersion).toBeUndefined();
    }
    const created = await f.experiments.create(f.a.context, { datasetVersionId: source.version.id, baselineVersion: BUSINESS_BENCHMARK_RULE_VERSION,
      modelId: f.modelId, label: "Synthetic original mixed-role baseline", maxAttemptsPerItem: 2, reason: "Synthetic free fixed facts extraction", requestId: randomUUID() });
    const baselines = await f.experiments.attempts(f.a.context, created.id, { arm: "baseline" }); expect(baselines.total).toBe(4);
    for (const row of baselines.items) {
      const actual = await f.experiments.attempt(f.a.context, row.id), item = source.version.items.find(value => value.id === actual.itemId)!;
      expect(actual).toMatchObject({ nativeRunId: null, evaluationRunId: null, state: "completed", assessment: { hardPass: true, graderVersion: "business-benchmark-checks-v1" },
        modelCost: { amountUsd: "0.00000000", source: "not_submitted", confirmedProviderCalls: 0 } });
      expect(actual.result?.actions).toEqual([]); expect(actual.result?.typedAnswers).toBeUndefined();
      if (item.ordinal % 2 === 1) expect(actual.result?.missingInformation.length).toBeGreaterThan(0);
      if (item.ordinal === 2) expect(actual.result?.findings.filter(value => value.location === "current").map(value => value.detail).join("")).toContain('"profitMinor":5300');
    }
    const original = await f.datasets.version(f.a.context, source.version.id), later = structuredClone(source.fields); later.name += " later draft";
    await f.datasets.save(f.a.context, source.saved.id, { fields: later, expectedRevision: 1, reason: "Synthetic separate draft does not replace published task", requestId: randomUUID() });
    expect(await f.datasets.version(f.a.context, source.version.id)).toEqual(original);
    expect(await f.businessState(f.a.context)).toEqual(before); expect(f.requests).toHaveLength(calls);
  });

  it("executes both original native kinds with one birth transaction and the unchanged production harness while never adopting business actions", async () => {
    const s = await f.experiment(), before = await f.businessState(f.a.context), calls = f.requests.length;
    for (const index of [0, 2]) {
      let born: Record<string, string> | undefined, queueCalls = 0;
      f.controls.beforeQueue = async ({ id }) => {
        queueCalls++;
        born = (await withTenant(database.db, f.a.context, tx => tx.execute<Record<string, string>>(sql`select n.creation_transaction_id::text as native,
          a.creation_transaction_id as attempt,x.xmin::text as execution,b.xmin::text as budget,g.xmin::text as event
          from ai_assist_runs n join knowledge_benchmark_attempts a on a.native_run_id=n.id
          join ai_assist_executions x on x.run_id=n.id join ai_budget_ledger b on b.request_id=n.id
          join knowledge_governance_events g on g.resource_id=a.id and g.action='benchmark.attempt.start' where n.id=${id}::uuid`)))[0];
      };
      const current = await start(s, index); delete f.controls.beforeQueue;
      expect(queueCalls).toBe(1); expect(born).toBeDefined(); expect(new Set(Object.values(born!)).size).toBe(1);
      expect(await nativeCount(current.input.requestId)).toEqual(oneNative);
      const done = await f.complete(current.receipt.id, s.version);
      expect(done.attempt).toMatchObject({ nativeRunId: done.native.id, evaluationRunId: null, state: "completed", assessment: { hardPass: true } });
      expect(done.native.kind).toBe(s.version.items[index]!.fields.role); expect(done.native.promptVersion).toBe("erp-assist-2026-10-06-v6");
      expect(done.native.result).toEqual(done.attempt.result); expect(done.native.result?.typedAnswers).toBeUndefined(); expect(done.native.result?.actions).toEqual([]);
      await expect(f.assists.assertBusinessAdoptionAllowed(f.a.context, done.native.id)).rejects.toThrow("benchmark_adoption_forbidden");
      expect(done.attempt.modelCost).toMatchObject({ amountUsd: "0.00021000", source: "usage_estimate", confirmedProviderCalls: 1 });
      const [proof] = await withTenant(database.db, f.a.context, tx => tx.execute<{ native: string; assessment: string; event: string }>(sql`select n.xmin::text as native,
        a.creation_transaction_id as assessment,g.xmin::text as event from ai_assist_runs n join knowledge_benchmark_attempts t on t.native_run_id=n.id
        join knowledge_benchmark_assessments a on a.attempt_id=t.id join knowledge_governance_events g on g.resource_id=t.id and g.action='benchmark.assessment'
        where n.id=${done.native.id}::uuid`));
      expect(new Set(Object.values(proof!)).size).toBe(1);
      const sealed = done.attempt.assessment; expect((await f.experiments.attempt(f.a.context, current.receipt.id)).assessment).toEqual(sealed);
      const request = JSON.stringify(f.requests.at(-1)!.body);
      expect(request).not.toContain("expectedFacts"); expect(request).not.toContain("expectedValue"); expect(request).not.toContain("benchmarkCalculations");
    }
    expect(f.requests).toHaveLength(calls + 2); expect(await f.businessState(f.a.context)).toEqual(before);
  });

  it("serializes simultaneous original business attempts and only restores the same actor, experiment, item and body after response loss", async () => {
    const s = await f.experiment(), input = { itemId: s.version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    let release: (() => void) | undefined, ready: ((pid: number) => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<number>(resolve => { ready = resolve; });
    const blocker = withTenant(database.db, f.a.context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-benchmark-request:${f.a.tenantId}:${input.requestId}`},0))`);
      const [pid] = await tx.execute<{ id: number }>(sql`select pg_backend_pid() as id`); ready?.(pid!.id); await gate;
    });
    const pending: Array<Promise<{ id: string; revision: number }>> = [];
    try {
      const pid = await held;
      for (let i = 0; i < 3; i++) { const promise = f.experiments.start(f.a.context, s.created.id, input); void promise.catch(() => {}); pending.push(promise); }
      await expect.poll(async () => Number((await database.client.unsafe("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='advisory' and $1::int=any(pg_blocking_pids(pid))", [pid]))[0]!.n), { timeout: 15_000 }).toBe(3);
      release?.(); await blocker; const results = await Promise.all(pending);
      expect(new Set(results.map(row => row.id)).size).toBe(1); expect(await nativeCount(input.requestId)).toEqual(oneNative);
      const rebuilt = new KnowledgeBenchmarkExperimentService(database, f.evaluations, f.vault, f.businessAdapter);
      expect(await rebuilt.start(f.a.context, s.created.id, input)).toEqual(results[0]);
      expect(await f.datasets.request(f.a.context, input.requestId)).toMatchObject({ operation: "attempt.start", parentId: s.created.id, receipt: results[0] });
      for (const actor of [f.second, f.foreign]) await expect(rebuilt.start(actor.context, s.created.id, input)).rejects.toBeInstanceOf(NotFoundException);
      await expect(rebuilt.start(f.a.context, s.created.id, { ...input, itemId: s.version.items[2]!.id })).rejects.toBeInstanceOf(ConflictException);
      await expect(rebuilt.start(f.a.context, s.created.id, { ...input, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      expect(await nativeCount(input.requestId)).toEqual(oneNative); await f.complete(results[0]!.id, s.version);
    } finally { release?.(); await blocker; await Promise.allSettled(pending); }
  });

  it("rejects stale task fingerprints and source changes for new paid calls without rewriting original published packets or successful receipts", async () => {
    const source = await f.sources(), changed = structuredClone(source.fields), first = changed.items[0]!;
    if (first.role === "knowledge_answer") throw new Error("Synthetic business task required");
    first.task.expectedTaskFingerprint = "0".repeat(64);
    const saved = await f.datasets.save(f.a.context, null, { fields: changed, expectedRevision: 0, reason: "Synthetic deliberately stale task pin", requestId: randomUUID() });
    let state = await f.state();
    await expect(f.datasets.publish(f.a.context, saved.id, { expectedRevision: 1, retentionDays: 7, reason: "Synthetic stale fingerprint must not be silently repinned", requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(state);
    const s = await f.experiment(), original = await f.datasets.version(f.a.context, s.version.id), current = await start(s);
    await f.complete(current.receipt.id, s.version); const row = s.rows[0]!;
    if (row.role !== "procurement_review") throw new Error("Synthetic real stock source required");
    await f.inventory.recordMovement(f.a.context, { stockItemId: row.stockId, locationId: row.locationId, lotId: null, bucket: "physical", type: "adjustment",
      quantityDelta: 1, unit: "each", sourceType: "manual", sourceId: `synthetic-later-benchmark:${randomUUID()}`, reasonCode: "SYNTHETIC", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    state = await f.state(); const calls = f.requests.length;
    await expect(start(s)).rejects.toBeInstanceOf(ConflictException); expect(await f.state()).toEqual(state);
    expect(await f.experiments.start(f.a.context, s.created.id, current.input)).toEqual(current.receipt);
    expect(await f.datasets.version(f.a.context, s.version.id)).toEqual(original); expect(f.requests).toHaveLength(calls);
  });

  it("keeps hard failure independent from human pass and charges all attempts rather than selecting an older qualified answer", async () => {
    const s = await f.experiment(), first = await start(s), before = await f.businessState(f.a.context);
    await f.complete(first.receipt.id, s.version); await review(first.receipt.id);
    expect((await f.experiments.get(f.a.context, s.created.id)).cells[0]).toMatchObject({ latestAttemptId: first.receipt.id, hardPass: true, qualified: true });
    const second = await start(s), failed = await f.complete(second.receipt.id, s.version, { forbidden: true });
    expect(failed.attempt.assessment?.checks.find(row => row.key === "forbidden_claims")?.status).toBe("fail");
    const grade = failed.attempt.assessment; await review(second.receipt.id, { decision: "pass", minutes: "2.250" });
    expect((await f.experiments.attempt(f.a.context, second.receipt.id)).assessment).toEqual(grade);
    expect((await f.experiments.get(f.a.context, s.created.id)).cells[0]).toMatchObject({ latestAttemptId: second.receipt.id, hardPass: false, qualified: false });
    const pending = await start(s); expect((await f.experiments.get(f.a.context, s.created.id)).cells[0]).toMatchObject({ latestAttemptId: pending.receipt.id, state: "queued", qualified: false });
    await f.complete(pending.receipt.id, s.version);
    const attempts = await f.experiments.attempts(f.a.context, s.created.id, { itemId: s.version.items[0]!.id, arm: "candidate" });
    expect(attempts.total).toBe(3); expect(attempts.items.map(row => row.ordinal).sort()).toEqual([1, 2, 3]);
    expect(attempts.items.every(row => row.modelCost.amountUsd === "0.00021000")).toBe(true);
    expect((await f.costs.summary(f.a.context, s.created.id)).candidate).toMatchObject({ allAttempts: 3, modelKnownUsd: "0.00063000", qualifiedItems: 0, state: "incomplete" });
    expect(await f.businessState(f.a.context)).toEqual(before);
  });

  it("accumulates human minutes and original cost reports while unknown prices, pending review and later activity keep qualification cost incomplete", async () => {
    const s = await f.experiment(), ids: string[] = [];
    for (let index = 0; index < 4; index++) { const current = await start(s, index); ids.push(current.receipt.id); await f.complete(current.receipt.id, s.version); await review(current.receipt.id); }
    const first = await expense(s, "candidate"), summary = await f.costs.summary(f.a.context, s.created.id);
    expect(summary.candidate).toMatchObject({ allAttempts: 4, qualifiedItems: 4, modelKnownUsd: "0.00084000", humanKnownUsd: "12.00000000", reviewMinutes: "6.000",
      state: "estimated", totalUsd: "12.03084000", unitQualifiedCostUsd: null, estimatedUnitQualifiedCostUsd: "3.00771000" });
    const reportInput = { reason: "Synthetic sealed original business cost and human conclusions", requestId: randomUUID() }, receipt = await f.costs.report(f.a.context, s.created.id, reportInput);
    const report = await f.costs.readReport(f.a.context, receipt.id), hash = businessBenchmarkSha(canonicalJson(report));
    await review(ids[0]!, { decision: "needs_review", minutes: "0.500" });
    const later = await f.costs.summary(f.a.context, s.created.id);
    expect(later.candidate).toMatchObject({ qualifiedItems: 3, humanKnownUsd: "13.00000000", reviewMinutes: "6.500", state: "incomplete", totalUsd: null });
    expect(later.candidate.activityFingerprint).not.toBe(first.input.expectedActivityFingerprint);
    expect(businessBenchmarkSha(canonicalJson(await f.costs.readReport(f.a.context, receipt.id)))).toBe(hash);
    expect(await f.costs.report(f.a.context, s.created.id, reportInput)).toEqual(receipt);
    const configuration = new ModelConfigurationService(database, f.modelVault), name = `Synthetic unpriced business ${randomUUID()}`;
    const configured = await configuration.invoke(f.a.context, { operation: "channel.save", name, baseUrl: "https://synthetic-evaluation.invalid/v1", apiKey: "synthetic-no-provider-credential",
      textProtocol: "chat_completions", models: [{ name: `synthetic-unpriced-business-${randomUUID()}`, capability: "text" }] });
    if (!("channels" in configured)) throw new Error("Actual channel configuration required");
    const modelId = configured.channels.find(row => row.name === name)?.models.find(row => row.capability === "text")?.id;
    if (!modelId) throw new Error("Actual unpriced text route required");
    const unknown = await f.experiment({ modelId }), current = await start(unknown); await f.complete(current.receipt.id, unknown.version);
    await review(current.receipt.id, { decision: "needs_review", minutes: "2", hourlyUsd: null }); await expense(unknown, "candidate", { storageUsd: null, maintenanceUsd: "0" });
    expect((await f.experiments.attempt(f.a.context, current.receipt.id)).modelCost).toMatchObject({ amountUsd: null, source: "unknown", confirmedProviderCalls: 1 });
    const missing = (await f.costs.summary(f.a.context, unknown.created.id)).candidate;
    expect(missing).toMatchObject({ state: "incomplete", pendingReviewItems: 1, notRunItems: 3, qualifiedItems: 0, totalUsd: null, unitQualifiedCostUsd: null });
    expect(missing.missing.join(" ")).toContain("模型费用未知"); expect(missing.missing.join(" ")).toContain("人工费率未知");
  });

  it("requires domain tenant scopes even with self Workflow and fences current revocation, original ceilings and late provider results", async () => {
    const all = Object.values(Permission), domain: Permission[] = [Permission.ProcurementRead, Permission.InventoryRead, Permission.FinanceRead, Permission.OrderRead];
    const source = await f.sources();
    await f.grant(f.a, all.filter(bit => !domain.includes(bit)), "self", domain);
    const ceiling = await withTenant(database.db, f.seed(f.a), tx => loadCurrentMembershipContext(tx, f.seed(f.a)));
    const saved = await f.datasets.save(ceiling, null, { fields: source.fields, expectedRevision: 0, reason: "Synthetic Workflow self with domain tenant pins", requestId: randomUUID() });
    const published = await f.datasets.publish(ceiling, saved.id, { expectedRevision: 1, retentionDays: 7, reason: "Synthetic explicit narrow workflow scope", requestId: randomUUID() });
    const version = await f.datasets.version(ceiling, published.id); expect(version.dataScope).toBe("self");
    const createInput = { datasetVersionId: version.id, baselineVersion: BUSINESS_BENCHMARK_RULE_VERSION, modelId: f.modelId, label: "Synthetic self workflow business experiment",
      maxAttemptsPerItem: 2, reason: "Synthetic domain scopes remain separate", requestId: randomUUID() }, created = await f.experiments.create(ceiling, createInput);
    const input = { itemId: version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() }, started = await f.experiments.start(ceiling, created.id, input);
    for (const bit of domain) {
      await f.grant(f.a, all, "self", domain.filter(value => value !== bit));
      for (const read of [() => f.datasets.version(ceiling, version.id), () => f.experiments.get(ceiling, created.id), () => f.experiments.attempt(ceiling, started.id),
        () => f.costs.summary(ceiling, created.id), () => f.datasets.request(ceiling, input.requestId), () => f.experiments.start(ceiling, created.id, input)])
        await expect(read()).rejects.toBeInstanceOf(ForbiddenError);
    }
    await f.grant();
    const limited = { ...f.a.context, permissionScopes: { ...f.a.context.permissionScopes, [Permission.InventoryRead]: "self" as const } };
    await expect(f.datasets.version(limited, version.id)).rejects.toBeInstanceOf(ForbiddenError);
    const completed = await f.complete(started.id, version);
    const assertCurrent = f.contexts.assertExecutionCurrent.bind(f.contexts);
    let releaseRead: (() => void) | undefined, readEntered = false;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const readSpy = vi.spyOn(f.contexts, "assertExecutionCurrent").mockImplementation(async (...args) => {
      await assertCurrent(...args); readEntered = true; await readGate;
    });
    const reading = f.assists.get(ceiling, completed.native.id); void reading.catch(() => {});
    try {
      await expect.poll(() => readEntered, { timeout: 15_000 }).toBe(true);
      await f.grant(f.a, all, "self", domain.filter(value => value !== Permission.ProcurementRead));
      releaseRead?.(); await expect(reading).rejects.toBeInstanceOf(ForbiddenError);
    } finally { releaseRead?.(); await Promise.allSettled([reading]); readSpy.mockRestore(); await f.grant(); }
    const lateInput = { ...input, expectedLatestAttemptId: started.id, requestId: randomUUID() };
    const late = await f.experiments.start(ceiling, created.id, lateInput);
    const attempt = await f.experiments.attempt(ceiling, late.id); if (!attempt.nativeRunId) throw new Error("Original business native required");
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    f.controls.beforeResponse = async () => { entered?.(); await gate; };
    f.setOutput(await f.output(version.items[0]!)); const before = await f.businessState(f.a.context), calls = f.requests.length;
    const processing = f.processRun(attempt.nativeRunId); void processing.catch(() => {});
    try {
      await ready; await f.grant(f.a, all, "self", domain.filter(value => value !== Permission.ProcurementRead));
      release?.(); await processing;
      const [actual] = await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ state: string; grades: number }>(sql`select n.status as state,
        (select count(*)::int from knowledge_benchmark_assessments where attempt_id=${late.id}::uuid) as grades from ai_assist_runs n where id=${attempt.nativeRunId}::uuid`));
      expect(actual?.state).not.toBe("completed"); expect(actual?.grades).toBe(0); expect(f.requests).toHaveLength(calls + 1);
      expect(await nativeCount(input.requestId)).toEqual(oneNative); expect(await nativeCount(lateInput.requestId)).toEqual(oneNative);
      expect(await f.businessState(f.seed(f.a))).toEqual(before);
    } finally { release?.(); await Promise.allSettled([processing]); delete f.controls.beforeResponse; await f.grant(); }
  });

  it("rolls back original publication and native-start audit failure and restores postcommit queue failure only through its original request", async () => {
    const source = await f.sources(), saved = await f.datasets.save(f.a.context, null, { fields: source.fields, expectedRevision: 0, reason: "Synthetic business audit rollback", requestId: randomUUID() });
    const original = importOwner.recordKnowledgeGovernanceEvent;
    const spy = vi.spyOn(importOwner, "recordKnowledgeGovernanceEvent").mockImplementation(async (...args) => {
      if (args[3] === "benchmark.dataset.publish" || args[3] === "benchmark.attempt.start") throw new Error("Synthetic business governance audit unavailable");
      return original(...args);
    });
    let before = await f.state(), dispatches = f.dispatches.length;
    await expect(f.datasets.publish(f.a.context, saved.id, { expectedRevision: 1, retentionDays: 7, reason: "Synthetic real rollback", requestId: randomUUID() })).rejects.toThrow("Synthetic business governance audit unavailable");
    expect(await f.state()).toEqual(before); expect(f.dispatches).toHaveLength(dispatches); spy.mockRestore();
    const s = await f.experiment(); before = await f.state(); dispatches = f.dispatches.length;
    const input = { itemId: s.version.items[2]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    vi.spyOn(importOwner, "recordKnowledgeGovernanceEvent").mockImplementation(async (...args) => {
      if (args[3] === "benchmark.attempt.start") throw new Error("Synthetic business governance audit unavailable"); return original(...args);
    });
    await expect(f.experiments.start(f.a.context, s.created.id, input)).rejects.toThrow("Synthetic business governance audit unavailable");
    expect(await f.state()).toEqual(before); expect(f.dispatches).toHaveLength(dispatches); vi.restoreAllMocks();
    f.controls.failQueue = true; const receipt = await f.experiments.start(f.a.context, s.created.id, input); f.controls.failQueue = false;
    expect(await f.experiments.start(f.a.context, s.created.id, input)).toEqual(receipt); expect(await nativeCount(input.requestId)).toEqual(oneNative);
    await f.complete(receipt.id, s.version); expect(await f.experiments.start(f.a.context, s.created.id, input)).toEqual(receipt);
  });

  it("raw business closure requires a real native parent, authentic fixed grade, full transaction birth and audit and remains closed after early flush", async () => {
    const s = await f.experiment(), baseline = s.experiment.cells[0]!.baselineAttemptId, started = await start(s); await f.complete(started.receipt.id, s.version);
    const [grade] = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeBenchmarkAssessments).where(eq(knowledgeBenchmarkAssessments.attemptId, baseline)));
    expect(grade).toBeDefined(); expect(benchmarkAssessmentView(f.vault, grade!).hardPass).toBe(true);
    expect(() => benchmarkAssessmentView(f.vault, { ...grade!, attemptId: s.experiment.cells[2]!.baselineAttemptId })).toThrow("benchmark_assessment_unavailable");
    expect(() => benchmarkAssessmentView(f.vault, { ...grade!, proof: grade!.proof.slice(0, -3) + "xyz" })).toThrow("benchmark_assessment_unavailable");
    for (const actor of [f.second, f.foreign]) await withTenant(database.db, actor.context, async tx => {
      const [role] = await tx.execute<{ app: boolean }>(sql`select current_user='yummyai_app' as app`); expect(role!.app).toBe(true);
      for (const table of ["knowledge_benchmark_items", "knowledge_benchmark_attempts", "knowledge_benchmark_assessments", "knowledge_benchmark_commands"])
        expect(await tx.execute(sql`select id from ${sql.identifier(table)}`)).toEqual([]);
    });
    const before = await f.state();
    async function rawReview(tx: TenantTransaction, audit: boolean) {
      const id = createEntityId(), createdAt = new Date(), input = { expectedReviewId: null, decision: "pass", minutes: "0.250", hourlyUsd: "120.00000000",
        reason: "Synthetic genuine business raw closure control", requestId: randomUUID() };
      await tx.insert(knowledgeBenchmarkReviews).values({ id, tenantId: f.a.tenantId, createdBy: f.a.userId, createdAt, creationTransactionId: "forged-marker",
        attemptId: baseline, assessmentId: grade!.id, previousId: null, sequence: 1, decision: "pass", minutes: input.minutes, hourlyUsd: input.hourlyUsd, reason: input.reason });
      await recordBenchmarkCommand(tx, f.a.context, "attempt.review", baseline, input, { id, revision: 1 }, "tenant", createdAt);
      if (audit) await importOwner.recordKnowledgeGovernanceEvent(tx, f.a.context, id, "benchmark.attempt.review", input.reason, { attemptId: baseline, assessmentId: grade!.id, sequence: 1 });
      const [born] = await tx.execute<{ saved: string; actual: string }>(sql`select creation_transaction_id as saved,pg_current_xact_id()::text as actual from knowledge_benchmark_reviews where id=${id}::uuid`);
      expect(born!.saved).toBe(born!.actual); return id;
    }
    await expect(withTenant(database.db, f.a.context, async tx => { await rawReview(tx, true); await tx.execute(sql`set constraints all immediate`); throw rollback; })).rejects.toBe(rollback);
    expect(await f.state()).toEqual(before);
    await expect(withTenant(database.db, f.a.context, async tx => { await rawReview(tx, false); await tx.execute(sql`set constraints all immediate`); })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_audit_required");
    expect(await f.state()).toEqual(before);
    const actual = await f.experiments.attempt(f.a.context, started.receipt.id); if (!actual.nativeRunId) throw new Error("Actual business native required");
    await expect(withTenant(database.db, f.a.context, async tx => {
      await rawReview(tx, true); await tx.execute(sql`set constraints all immediate`);
      await tx.update(aiAssistRuns).set({ benchmarkItemId: s.version.items[2]!.id }).where(eq(aiAssistRuns.id, actual.nativeRunId!));
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_native_marker_immutable");
    expect(await f.state()).toEqual(before);
  });

  it("clears expired business basis and baseline bodies through original durable jobs without changing fixed grades, reports, native or business facts", async () => {
    const s = await f.experiment(), started = await start(s); const done = await f.complete(started.receipt.id, s.version);
    const receipt = await f.costs.report(f.a.context, s.created.id, { reason: "Synthetic original business receipt before retention", requestId: randomUUID() });
    const report = await f.costs.readReport(f.a.context, receipt.id), facts = await f.businessState(f.a.context);
    const immutable = async () => (await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ versions: string; grades: string; native: string; reports: string }>(sql`select
      (select md5(to_jsonb(v)::text) from knowledge_benchmark_versions v where id=${s.version.id}::uuid) as versions,
      (select md5(jsonb_agg(to_jsonb(a)-'encrypted_output' order by a.id)::text) from knowledge_benchmark_assessments a join knowledge_benchmark_attempts t on t.id=a.attempt_id where t.experiment_id=${s.created.id}::uuid) as grades,
      (select md5(to_jsonb(n)::text) from ai_assist_runs n where id=${done.native.id}::uuid) as native,
      (select md5(to_jsonb(r)::text) from knowledge_benchmark_reports r where id=${receipt.id}::uuid) as reports`)))[0]!;
    const original = await immutable(), { nonce, workspace } = requireBusinessBenchmarkEnvironment("current");
    const [clock] = await database.client.unsafe<{ database: string; definition: string }[]>("select current_database() as database,pg_get_functiondef('knowledge_benchmark_now()'::regprocedure) as definition");
    expect(clock?.database).toBe(`order_daily_e2e_${nonce}`); if (!clock?.definition) throw new Error("Original benchmark clock missing");
    let operationError: unknown, restoreError: unknown, restored = false;
    try {
      await database.client.unsafe("create or replace function knowledge_benchmark_now() returns timestamptz language sql volatile set search_path=pg_catalog,public as $$ select clock_timestamp()+interval '31 days' $$");
      await f.grant(f.a, []); const actual = await expireKnowledgeBenchmarkBodiesInTenant(database, f.a.tenantId);
      expect(actual.failed).toBe(0); expect(actual.expired).toBeGreaterThanOrEqual(8);
      const [retained] = await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ basis: number; baseline: number; completed: number }>(sql`select
        (select count(*)::int from knowledge_benchmark_items where version_id=${s.version.id}::uuid and encrypted_basis is not null) as basis,
        (select count(*)::int from knowledge_benchmark_assessments a join knowledge_benchmark_attempts t on t.id=a.attempt_id where t.experiment_id=${s.created.id}::uuid and t.arm='baseline' and a.encrypted_output is not null) as baseline,
        (select count(*)::int from knowledge_benchmark_retention_jobs j where j.state='completed' and (j.resource_id in(select id from knowledge_benchmark_items where version_id=${s.version.id}::uuid)
          or j.resource_id in(select a.id from knowledge_benchmark_assessments a join knowledge_benchmark_attempts t on t.id=a.attempt_id where t.experiment_id=${s.created.id}::uuid and t.arm='baseline'))) as completed`));
      expect(retained).toEqual({ basis: 0, baseline: 0, completed: 8 }); expect(await immutable()).toEqual(original);
      expect(await expireKnowledgeBenchmarkBodiesInTenant(database, f.a.tenantId)).toEqual({ expired: 0, failed: 0 });
    } catch (error) { operationError = error; }
    finally {
      try { await database.client.unsafe(clock.definition); restored = (await database.client.unsafe<{ definition: string }[]>("select pg_get_functiondef('knowledge_benchmark_now()'::regprocedure) as definition"))[0]?.definition === clock.definition;
        if (!restored) restoreError = new Error("Original benchmark clock restoration differs"); } catch (error) { restoreError = error; }
      try { await f.grant(); } catch (error) { restoreError = restoreError ? new AggregateError([restoreError, error], "Synthetic clock and role restoration failed") : error; }
      try { const owned = resolve(workspace, "tmp/business-benchmark-20261021-c9e82d4a/qa"); await mkdir(owned, { recursive: true });
        await writeFile(resolve(owned, `business-retention-clock-${nonce}.json`), JSON.stringify({ nonce, restored, originalDefinitionSha256: businessBenchmarkSha(clock.definition), oldAiClockChanged: false, tenantRowsTimeChanged: false }, null, 2) + "\n");
      } catch (error) { restoreError = restoreError ? new AggregateError([restoreError, error], "Synthetic restoration evidence failed") : error; }
    }
    if (operationError && restoreError) throw new AggregateError([operationError, restoreError], "Synthetic business retention and restoration failed");
    if (restoreError) throw restoreError; if (operationError) throw operationError;
    expect((await f.datasets.version(f.a.context, s.version.id)).items.every(row => !row.usable)).toBe(true);
    expect((await f.experiments.attempt(f.a.context, s.experiment.cells[0]!.baselineAttemptId)).result).toBeNull();
    expect((await f.experiments.attempt(f.a.context, started.receipt.id)).assessment).toEqual(done.attempt.assessment);
    expect(await f.costs.readReport(f.a.context, receipt.id)).toEqual(report); expect(await f.businessState(f.a.context)).toEqual(facts);
    expect(await f.experiments.start(f.a.context, s.created.id, started.input)).toEqual(started.receipt);
  });

  it("restores each original command domain after its knowledge draft becomes business without reinterpreting the older receipt from today's draft", async () => {
    const fields = BenchmarkDatasetFieldsSchema.parse({ name: "Synthetic original knowledge draft lineage", description: "No publication or knowledge source is fabricated",
      items: [1, 2].map(index => ({ key: `original_${index}`, role: "knowledge_answer", evaluation: { label: `Synthetic original draft ${index}`,
        search: { query: "Synthetic unpublished requirement", topic: "operations", platform: "amazon", market: "US", spuIds: [] },
        expectedFacts: [], forbiddenClaims: [], requiredEntryIds: [], expectRefusal: true }, calculations: [] })) });
    const original = { fields, expectedRevision: 0, reason: "Synthetic original knowledge-only draft", requestId: randomUUID() }, created = await f.datasets.save(f.a.context, null, original);
    const business = await f.sources(), changed = { fields: business.fields, expectedRevision: created.revision, reason: "Synthetic later two-role business draft", requestId: randomUUID() },
      saved = await f.datasets.save(f.a.context, created.id, changed);
    const commands = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeBenchmarkCommands).where(sql`${knowledgeBenchmarkCommands.requestId} in (${original.requestId}::uuid,${changed.requestId}::uuid)`));
    expect(commands.find(row => row.requestId === original.requestId)?.businessRoles).toEqual([]);
    expect(commands.find(row => row.requestId === changed.requestId)?.businessRoles).toEqual(["business_review", "procurement_review"]);
    const command = commands.find(row => row.requestId === changed.requestId); if (!command) throw new Error("Actual business command required");
    const before = await f.state();
    await expect(withTenant(database.db, f.a.context, async tx => {
      const id = createEntityId();
      await tx.insert(knowledgeBenchmarkCommands).values({ ...command, id, requestId: randomUUID(), creationTransactionId: "forged-marker", businessRoles: [] });
      const [actual] = await tx.select().from(knowledgeBenchmarkCommands).where(eq(knowledgeBenchmarkCommands.id, id));
      expect(actual?.businessRoles).toEqual(["business_review", "procurement_review"]);
      // This is a rollback-only capture probe, not a forged successful command.
      throw rollback;
    })).rejects.toBe(rollback); expect(await f.state()).toEqual(before);
    const domains: Permission[] = [Permission.InventoryRead, Permission.ProcurementRead, Permission.FinanceRead, Permission.OrderRead];
    await f.grant(f.a, Object.values(Permission), "self", Object.values(Permission).filter(bit => !domains.includes(bit)));
    const calls = f.requests.length;
    expect(await f.datasets.request(f.a.context, original.requestId)).toMatchObject({ operation: "dataset.create", receipt: created });
    expect(await f.datasets.save(f.a.context, null, original)).toEqual(created);
    await expect(f.datasets.request(f.a.context, changed.requestId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.datasets.save(f.a.context, created.id, changed)).rejects.toBeInstanceOf(ForbiddenError);
    expect(saved.revision).toBe(2); expect(f.requests).toHaveLength(calls);
  });
});
