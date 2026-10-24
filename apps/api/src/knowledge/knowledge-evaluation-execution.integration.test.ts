import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import type { KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import { KnowledgeEvaluationProtocolSchema } from "@yummyai/contracts/knowledge/evaluation-protocol";
import { KnowledgeEvaluationRunPageSchema, KnowledgeEvaluationComparisonSchema } from "@yummyai/contracts/knowledge/evaluation-read";
import { assistFingerprint, assistExecutionPolicy, knowledgeEvaluationBasis, knowledgeEvaluationChecksum,
  knowledgeEvaluationRequestChecksum, sealKnowledgeEvaluationProtocol, assertKnowledgeEvaluationProtocol,
  assertKnowledgeEvaluationAssessment, type AssistContext } from "@yummyai/ai-core";
import { assertDatabaseMigrationsCurrent, connectDatabase, withTenant, memberships,
  aiAssistRuns, aiAssistExecutions, aiBudgetLedger, knowledgeEvaluationRuns, knowledgeEvaluationProtocols,
  knowledgeEvaluationAssessments, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as importOwner from "./knowledge-import.service.js";
import { knowledgeEvaluationFixture, evaluationAllPermissions, evaluationSha, requireKnowledgeEvaluationEnvironment } from "../../../../tools/testing/knowledge-evaluation-fixture.mjs";

requireKnowledgeEvaluationEnvironment("current");
const rollback = new Error("Synthetic evaluation SQL control rollback");
const checkKeys = ["answer_completed", "retrieval", "citation", "expected_facts", "forbidden", "refusal", "evidence"];
function pg(error: unknown): { code?: string; message?: string } {
  for (let depth = 0; depth < 7 && error && typeof error === "object"; depth++) {
    if ("code" in error && typeof error.code === "string") return { code: error.code, message: "message" in error ? String(error.message) : undefined };
    error = "cause" in error ? error.cause : undefined;
  }
  return {};
}

describe.sequential("native knowledge evaluation execution on actual membership, budget and DurableAssistExecution", () => {
  const database = connectDatabase(), f = knowledgeEvaluationFixture(database);
  beforeAll(async () => { await assertDatabaseMigrationsCurrent(database); await f.initialize(); });
  afterAll(async () => { await database.client.end(); });
  afterEach(async () => {
    vi.restoreAllMocks(); f.controls.failQueue = false; delete f.controls.beforeQueue; delete f.controls.beforeResponse;
    vi.useRealTimers(); await f.grant(); await f.grant(f.second);
    // The real expiry owner frees unsubmitted reservations. No immutable history
    // or source clock is rewritten just to reset the four-active-task limit.
    const pending = await f.pending();
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      for (const row of pending) await f.processRun(row.id, row.ownerId === f.second.userId ? f.second : f.a, "expire");
    } finally { vi.useRealTimers(); }
  });

  async function start(s: Awaited<ReturnType<typeof f.scenario>>, input = s.input) {
    return f.evaluations.start(f.a.context, s.caseId, input);
  }
  async function complete(id: string) {
    const before = await f.evaluations.report(f.a.context, id), reference = before.answer.knowledge[0];
    expect(reference).toBeDefined();
    f.setOutput(AssistResultSchema.parse({ summary: "Synthetic fixed fact", findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact",
      kind: "fact", severity: "info", evidence: [{ sourceId: reference!.sourceId, detail: "Synthetic actual pinned reference" }], location: null }], directions: [], matches: [], missingInformation: [] }));
    await f.processRun(before.answer.id);
    const report = await f.evaluations.report(f.a.context, id);
    expect(report.answer.status).toBe("completed"); expect(report.assessmentState).toBe("recorded");
    expect(report.assessment?.checks.map(row => row.key)).toEqual(checkKeys);
    return report;
  }
  async function expire(id: string) {
    const row = await f.evaluations.report(f.a.context, id);
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      await f.processRun(row.answer.id, f.a, "expire");
    } finally { vi.useRealTimers(); }
  }
  async function count(requestId: string) {
    return withTenant(database.db, f.a.context, async tx => {
      const [row] = await tx.execute<{ evaluations: number; assists: number; executions: number; budgets: number; protocols: number; starts: number }>(sql`select
        (select count(*)::int from knowledge_evaluation_runs where request_id=${requestId}::uuid) as evaluations,
        (select count(*)::int from ai_assist_runs where request_id=${requestId}::uuid) as assists,
        (select count(*)::int from ai_assist_executions where run_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as executions,
        (select count(*)::int from ai_budget_ledger where request_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as budgets,
        (select count(*)::int from knowledge_evaluation_protocols where run_id in(select id from knowledge_evaluation_runs where request_id=${requestId}::uuid)) as protocols,
        (select count(*)::int from knowledge_governance_events where action='evaluation.start' and detail->>'runId' in(select id::text from knowledge_evaluation_runs where request_id=${requestId}::uuid)) as starts`);
      return row!;
    });
  }
  const oneIntent = { evaluations: 1, assists: 1, executions: 1, budgets: 1, protocols: 1, starts: 1 };

  it("commits one native intent, budget, protocol and start receipt before dispatch and seals the original worker assertions before any GET", async () => {
    const s = await f.scenario(), requests = f.requests.length;
    let birth: { ai: string; protocol: string; run: string; budget: string; execution: string; event: string } | undefined;
    f.controls.beforeQueue = async () => {
      expect(await count(s.input.requestId)).toEqual(oneIntent);
      [birth] = await withTenant(database.db, f.a.context, tx => tx.execute<NonNullable<typeof birth>>(sql`select
        a.creation_transaction_id::text as ai,p.creation_transaction_id as protocol,e.xmin::text as run,b.xmin::text as budget,x.xmin::text as execution,g.xmin::text as event
        from knowledge_evaluation_runs e join ai_assist_runs a on a.id=e.assist_run_id join ai_assist_executions x on x.run_id=a.id
        join ai_budget_ledger b on b.request_id=a.id join knowledge_evaluation_protocols p on p.run_id=e.id
        join knowledge_governance_events g on g.action='evaluation.start' and g.detail->>'runId'=e.id::text where e.request_id=${s.input.requestId}::uuid`));
      expect(birth).toBeDefined();
      expect(birth!.ai).toBe(birth!.protocol); const xid32 = String(BigInt(birth!.ai) % 4_294_967_296n);
      for (const key of ["run", "budget", "execution", "event"] as const) expect(birth![key]).toBe(xid32);
    };
    const created = await start(s); delete f.controls.beforeQueue;
    expect(f.requests).toHaveLength(requests);
    const report = await f.evaluations.report(f.a.context, created.id);
    expect(report).toMatchObject({ caseId: s.caseId, caseSnapshot: s.caseFields, assessment: null, assessmentState: "awaiting_result" });
    expect(report.protocol).toMatchObject({ version: "knowledge-evaluation-v1", runId: created.id, caseRevision: 1, modelId: s.input.modelId,
      caseChecksum: evaluationSha(canonicalJson(s.caseFields)), requestChecksum: evaluationSha(canonicalJson({ version: 1, operation: "knowledge-evaluation-start", caseId: s.caseId, input: s.input })),
      inputFingerprint: report.answer.inputFingerprint, dataScope: "tenant", promptVersion: report.answer.promptVersion });
    if (!birth) throw new Error("Synthetic native birth evidence was not captured before dispatch");
    const [dispatched] = await withTenant(database.db, f.a.context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, report.answer.id)));
    expect(dispatched).toMatchObject({ dispatchCount: 1 }); expect(dispatched!.lastDispatchedAt).not.toBeNull();
    const done = await complete(created.id);
    expect(done.checks.every(value => value.status === "pass")).toBe(true); expect(done.manualReviews).toEqual([]);
    const [sealed] = await withTenant(database.db, f.a.context, tx => tx.execute<{ assessment: string; ai: string; event: string }>(sql`select s.creation_transaction_id as assessment,a.xmin::text as ai,g.xmin::text as event
      from knowledge_evaluation_assessments s join knowledge_evaluation_runs e on e.id=s.run_id join ai_assist_runs a on a.id=e.assist_run_id
      join knowledge_governance_events g on g.resource_id=e.id and g.action='evaluation.assessed' where e.id=${created.id}::uuid`));
    expect(sealed!.ai).toBe(String(BigInt(sealed!.assessment) % 4_294_967_296n)); expect(sealed!.event).toBe(sealed!.ai);
    const state = await f.state(); expect(await f.evaluations.report(f.a.context, created.id)).toEqual(done); expect(await f.state()).toEqual(state);
    expect(f.requests).toHaveLength(requests + 1); expect(done.answer.costUsd).toBeGreaterThan(0);
  });

  it("serializes two actual actors at the tenant request lock before any second native budget or execution can be born", async () => {
    const s = await f.scenario(), other = await f.scenario(), key = `knowledge-eval-run:${f.a.tenantId}:${s.input.requestId}`;
    let release!: () => void, locked!: (pid: number) => void;
    const ready = new Promise<number>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = withTenant(database.db, f.a.context, async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
      const [pid] = await tx.execute<{ id: number }>(sql`select pg_backend_pid() as id`); locked(pid!.id); await gate; });
    const pending: Array<Promise<{ id: string }>> = []; let settled: Promise<PromiseSettledResult<{ id: string }>[]> | undefined;
    try {
      const pid = await ready;
      const waiters = async () => Number((await database.client.unsafe("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='advisory' and $1::int=any(pg_blocking_pids(pid))", [pid]))[0]!.n);
      pending.push(f.evaluations.start(f.a.context, s.caseId, s.input)); void pending[0]!.catch(() => {});
      await expect.poll(waiters, { timeout: 15_000 }).toBe(1);
      pending.push(f.evaluations.start(f.second.context, s.caseId, s.input)); settled = Promise.allSettled(pending);
      await expect.poll(waiters, { timeout: 15_000 }).toBe(2); release(); await blocker;
      const results = await settled;
      expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
      const failure = results.find(row => row.status === "rejected"); expect(failure?.status).toBe("rejected");
      if (failure?.status === "rejected") expect(failure.reason).toBeInstanceOf(ConflictException);
      expect(await count(s.input.requestId)).toEqual(oneIntent);
      await expect(start(other, s.input)).rejects.toBeInstanceOf(ConflictException);
      await expect(start(s, { ...s.input, modelId: f.alternateModelId })).rejects.toBeInstanceOf(ConflictException);
      expect(await count(s.input.requestId)).toEqual(oneIntent);
    } finally { release(); await blocker; await Promise.allSettled(pending); }
  });

  it("replays simultaneous requests from the same actor as exactly one original result and one provider call", async () => {
    const s = await f.scenario(), requests = f.requests.length;
    const results = await Promise.all(Array.from({ length: 3 }, () => start(s)));
    expect(new Set(results.map(row => row.id)).size).toBe(1); expect(await count(s.input.requestId)).toEqual(oneIntent);
    const done = await complete(results[0]!.id); await f.processRun(done.answer.id);
    expect(f.requests).toHaveLength(requests + 1); expect(await start(s)).toEqual(results[0]);
    expect(await count(s.input.requestId)).toEqual(oneIntent);
  });

  it("rolls back the complete native intent and budget if the original start governance audit fails, with no dispatch", async () => {
    const s = await f.scenario(), state = await f.state(), dispatches = f.dispatches.length;
    const original = importOwner.recordKnowledgeGovernanceEvent;
    vi.spyOn(importOwner, "recordKnowledgeGovernanceEvent").mockImplementation(async (...args) => {
      if (args[3] === "evaluation.start") throw new Error("Synthetic start audit unavailable");
      return original(...args);
    });
    await expect(start(s)).rejects.toThrow("Synthetic start audit unavailable");
    expect(await f.state()).toEqual(state); expect(f.dispatches).toHaveLength(dispatches);
    expect(await count(s.input.requestId)).toEqual({ evaluations: 0, assists: 0, executions: 0, budgets: 0, protocols: 0, starts: 0 });
  });

  it("keeps the committed original intent when postcommit queue delivery fails and restores only that run by its original key", async () => {
    const s = await f.scenario(); f.controls.failQueue = true;
    const first = await start(s); expect(await count(s.input.requestId)).toEqual(oneIntent);
    f.controls.failQueue = false; const replay = await start(s);
    expect(replay).toEqual(first); expect(await count(s.input.requestId)).toEqual(oneIntent);
    const done = await complete(first.id);
    expect(f.dispatches.filter(row => row.id === done.answer.id).every(row => row.tenantId === f.a.tenantId && row.userId === f.a.userId)).toBe(true);
    expect(f.requests.filter(row => row.body.model === done.answer.model)).not.toHaveLength(0);
  });

  it("restores original keys after case edits, archive and real content expiry without replacing the pinned model or case", async () => {
    const s = await f.scenario(), first = await start(s), original = await complete(first.id);
    await f.governance.saveEvaluation(f.a.context, s.caseId, { fields: { ...s.caseFields, label: "Synthetic later edited case", expectedFacts: ["Synthetic later fact"] }, expectedRevision: 1, requestId: randomUUID() });
    expect(await start(s)).toEqual(first);
    await f.governance.archive(f.a.context, "evaluation", s.caseId, { expectedRevision: 2, reason: "Synthetic later archive" });
    await expire(first.id); const requests = f.requests.length;
    expect(await start(s)).toEqual(first);
    const retired = await f.evaluations.report(f.a.context, first.id);
    expect(retired.caseSnapshot).toEqual(original.caseSnapshot); expect(retired.protocol).toEqual(original.protocol);
    expect(retired.assessment).toEqual(original.assessment); expect(retired.answer.result).toBeNull(); expect(retired.answer.request).toBeNull();
    await expect(start(s, { ...s.input, modelId: f.alternateModelId })).rejects.toBeInstanceOf(ConflictException);
    expect(f.requests).toHaveLength(requests); expect(await count(s.input.requestId)).toEqual(oneIntent);
  });

  it("preserves sealed failing assertions and a separate needs-review decision after private answer expiry, without GET rescoring", async () => {
    const s = await f.scenario(), created = await start(s), pending = await f.evaluations.report(f.a.context, created.id);
    f.setOutput(AssistResultSchema.parse({ summary: "Synthetic forbidden claim", findings: [], directions: [], matches: [], missingInformation: [] }));
    await f.processRun(pending.answer.id); const failed = await f.evaluations.report(f.a.context, created.id);
    expect(failed.answer.status).toBe("completed"); expect(failed.assessmentState).toBe("recorded");
    expect(failed.checks.filter(row => row.status === "fail").map(row => row.key)).toEqual(expect.arrayContaining(["citation", "expected_facts", "forbidden"]));
    expect(failed.checks.some(row => row.status === "pending")).toBe(false);
    await f.evaluations.review(f.a.context, created.id, { result: "needs_review", reason: "Synthetic human judgement remains independent of phrase checks" });
    const reviewed = await f.evaluations.report(f.a.context, created.id); expect(reviewed.manualReviews[0]?.result).toBe("needs_review");
    await expire(created.id); const state = await f.state(), retired = await f.evaluations.report(f.a.context, created.id);
    expect(retired.assessment).toEqual(failed.assessment); expect(retired.checks).toEqual(failed.checks); expect(retired.manualReviews).toEqual(reviewed.manualReviews);
    expect(retired.answer.result).toBeNull(); expect(await f.state()).toEqual(state);
    const pair = await f.evaluations.compare(f.a.context, { baselineRunId: created.id, candidateRunId: created.id });
    expect(pair.comparable).toBe(false); expect(pair.reasons.length).toBeGreaterThan(0);
  });

  it("TTL race: rejects the whole comparison when the original baseline expires during the candidate read and preserves its sealed assessment", async () => {
    const s = await f.scenario(), baseline = await start(s), a = await complete(baseline.id);
    const candidate = await start(s, { ...s.input, requestId: randomUUID() }), b = await complete(candidate.id);
    expect(a.assessment).not.toBeNull(); expect(b.assessment).not.toBeNull();
    expect((await f.evaluations.compare(f.a.context, { baselineRunId: a.id, candidateRunId: b.id })).comparable).toBe(true);
    const native = await withTenant(database.db, f.a.context, tx => tx.select({ id: aiAssistRuns.id, expiresAt: aiAssistRuns.expiresAt })
      .from(aiAssistRuns).where(sql`${aiAssistRuns.id}=any(array[${a.answer.id}::uuid,${b.answer.id}::uuid])`));
    const baselineExpiry = native.find(row => row.id === a.answer.id)!.expiresAt.getTime(), candidateExpiry = native.find(row => row.id === b.answer.id)!.expiresAt.getTime();
    expect(candidateExpiry - baselineExpiry).toBeGreaterThan(1);
    const between = new Date(baselineExpiry + Math.floor((candidateExpiry - baselineExpiry) / 2));
    let release!: () => void, reached!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    const entered = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const actual = f.assists.get.bind(f.assists), observed: string[] = [];
    const spy = vi.spyOn(f.assists, "get").mockImplementation(async (context, id) => {
      const value = await actual(context, id); observed.push(id);
      if (id === b.answer.id) { reached(); await gate; }
      return value;
    });
    const state = await f.state(), requests = f.requests.length, dispatches = f.dispatches.length;
    const comparing = f.evaluations.compare(f.a.context, { baselineRunId: a.id, candidateRunId: b.id }); void comparing.catch(() => {});
    try {
      await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic comparison expiry gate timeout")), 15_000); })]);
      expect(observed).toEqual([a.answer.id, b.answer.id]);
      // Read the genuine deadlines first, then advance only the caller's Date
      // across the first one. No row timestamp, business fact or DB clock changes.
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(between); release();
      await expect(comparing).rejects.toBeInstanceOf(ConflictException);
      expect(await f.state()).toEqual(state);
      spy.mockRestore();
      const retired = await f.evaluations.report(f.a.context, a.id);
      expect(retired.answer).toMatchObject({ id: a.answer.id, request: null, result: null, knowledge: [] });
      expect(retired.protocol).toEqual(a.protocol); expect(retired.assessment).toEqual(a.assessment); expect(retired.checks).toEqual(a.checks);
      expect(retired.assessmentState).toBe("recorded");
      const currentCandidate = await f.evaluations.report(f.a.context, b.id);
      expect(currentCandidate.answer.result).toEqual(b.answer.result); expect(currentCandidate.assessment).toEqual(b.assessment);
      const after = await f.state();
      for (const table of ["ai_budget_ledger", "ai_assist_executions", "knowledge_evaluation_runs", "knowledge_evaluation_protocols", "knowledge_evaluation_assessments", "knowledge_governance_events"])
        expect(after[table]).toEqual(state[table]);
      expect(after.ai_assist_runs.count).toBe(state.ai_assist_runs.count);
    } finally {
      if (timer) clearTimeout(timer); release(); await Promise.allSettled([comparing]); spy.mockRestore(); vi.useRealTimers();
    }
    expect(f.requests).toHaveLength(requests); expect(f.dispatches).toHaveLength(dispatches);
    // Once cleared by the original owner, a clock restoration does not recreate
    // the private answer or turn the historical assessment back into pending.
    const restoredClock = await f.evaluations.report(f.a.context, a.id);
    expect(restoredClock.answer.result).toBeNull(); expect(restoredClock.assessment).toEqual(a.assessment);
  });

  it("compares two actual model routes only with the same sealed source basis and rejects a later source revision as a candidate basis", async () => {
    const s = await f.scenario(), baseline = await start(s), a = await complete(baseline.id);
    const candidate = await start(s, { modelId: f.alternateModelId, requestId: randomUUID() }), b = await complete(candidate.id);
    expect(a.answer.model).not.toBe(b.answer.model); expect(a.protocol?.basisFingerprint).toBe(b.protocol?.basisFingerprint);
    const comparison = KnowledgeEvaluationComparisonSchema.parse(await f.evaluations.compare(f.a.context, { baselineRunId: a.id, candidateRunId: b.id }));
    expect(comparison.comparable).toBe(true); expect(comparison.reasons).toEqual([]);
    const entry = (await f.knowledge.workspace(f.a.context)).entries.find(row => row.id === s.cardId)!;
    await f.knowledge.save(f.a.context, s.cardId, { fields: { ...s.cardFields, body: s.cardFields.body + " Synthetic new conditions" }, expectedRevision: entry.revision, reason: "Synthetic changed reference", requestId: randomUUID() });
    await f.publish(s.cardId);
    const newer = await start(s, { ...s.input, requestId: randomUUID() }), c = await complete(newer.id);
    expect(c.answer.knowledge[0]?.versionId).not.toBe(a.answer.knowledge[0]?.versionId);
    expect(c.protocol?.basisFingerprint).not.toBe(a.protocol?.basisFingerprint);
    const state = await f.state(), incompatible = await f.evaluations.compare(f.a.context, { baselineRunId: a.id, candidateRunId: c.id });
    expect(incompatible.comparable).toBe(false); expect(incompatible.reasons.length).toBeGreaterThan(0); expect(await f.state()).toEqual(state);
  });

  it("requires every current execution permission and the original request ceiling, and hides other actors and tenants", async () => {
    const s = await f.scenario(), created = await start(s);
    for (const permission of [Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun]) {
      await f.grant(f.a, evaluationAllPermissions.filter(value => value !== permission));
      const before = await f.state(); await expect(start(s, { ...s.input, requestId: randomUUID() })).rejects.toThrow(); expect(await f.state()).toEqual(before);
      await f.grant(); const ceiling: TenantContext = { ...f.a.context, permissions: f.a.context.permissions.filter(value => value !== permission) };
      await expect(f.evaluations.start(ceiling, s.caseId, { ...s.input, requestId: randomUUID() })).rejects.toThrow();
    }
    await expect(f.evaluations.report(f.second.context, created.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.evaluations.report(f.foreign.context, created.id)).rejects.toBeInstanceOf(NotFoundException);
    await withTenant(database.db, f.seed(f.a), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.a.membershipId)));
    await expect(start(s)).rejects.toThrow(); await expect(f.evaluations.report(f.a.context, created.id)).rejects.toThrow();
    await f.grant(); expect(await start(s)).toEqual(created);
    await expire(created.id);
    for (const permission of [Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun]) {
      // The unrelated tenant permissions keep the global scope broad. They
      // cannot widen the original protocol's individual required permission.
      await f.grant(f.a, evaluationAllPermissions, "self", evaluationAllPermissions.filter(value => value !== permission));
      if (permission === Permission.WorkflowRead) await expect(f.evaluations.report(f.a.context, created.id)).rejects.toThrow();
      else {
        expect((await f.evaluations.report(f.a.context, created.id)).id).toBe(created.id);
        await expect(start(s)).rejects.toThrow();
      }
    }
    await f.grant(); expect((await f.evaluations.report(f.a.context, created.id)).protocol?.dataScope).toBe("tenant");

    const race = await f.scenario(), tenantFirst = await start(race), firstTenantReport = await complete(tenantFirst.id);
    await f.grant(f.a, evaluationAllPermissions, "self");
    const self = await start(race, { ...race.input, requestId: randomUUID() }), selfReport = await complete(self.id);
    expect(selfReport.protocol?.dataScope).toBe("self");
    await f.grant();
    const tenantNewest = await start(race, { ...race.input, requestId: randomUUID() }), tenantReport = await complete(tenantNewest.id);
    expect(tenantReport.protocol?.dataScope).toBe("tenant");
    for (const operation of ["compare", "page"] as const) {
      let release!: () => void, reached!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
      const entered = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const actual = f.assists.get.bind(f.assists), observed: string[] = [];
      // Real private input/output reads complete before this timing-only gate.
      // No report, score, authority, membership or query result is substituted.
      const spy = vi.spyOn(f.assists, "get").mockImplementation(async (context, id) => {
        const value = await actual(context, id); observed.push(id);
        if (id === selfReport.answer.id) { reached(); await gate; }
        return value;
      });
      const state = await f.state(), calls = f.requests.length, dispatches = f.dispatches.length;
      const read = operation === "compare"
        ? f.evaluations.compare(f.a.context, { baselineRunId: tenantFirst.id, candidateRunId: self.id })
        : f.evaluations.page(f.a.context, race.caseId, { limit: 2 });
      void read.catch(() => {});
      try {
        await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic aggregate read gate timeout")), 15_000); })]);
        expect(observed).toHaveLength(2);
        expect(observed[0]).toBe(operation === "compare" ? firstTenantReport.answer.id : tenantReport.answer.id);
        await f.grant(f.a, evaluationAllPermissions, "self", evaluationAllPermissions.filter(value => value !== Permission.WorkflowRead));
        release();
        await expect(read).rejects.toMatchObject({ code: "FORBIDDEN", permission: Permission.WorkflowRead, reason: "outside_data_scope" });
      } finally {
        if (timer) clearTimeout(timer); release(); await Promise.allSettled([read]); spy.mockRestore(); await f.grant();
      }
      expect(await f.state()).toEqual(state); expect(f.requests).toHaveLength(calls); expect(f.dispatches).toHaveLength(dispatches);
    }
  });

  it("does not adopt a provider response after actual membership revocation and preserves the known paid-response ledger", async () => {
    const s = await f.scenario(), created = await start(s), report = await f.evaluations.report(f.a.context, created.id);
    const reference = report.answer.knowledge[0]; expect(reference).toBeDefined();
    f.setOutput(AssistResultSchema.parse({ summary: "Synthetic fixed fact", findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact", kind: "fact", severity: "info",
      evidence: [{ sourceId: reference!.sourceId, detail: "Synthetic original valid source before revocation" }], location: null }], directions: [], matches: [], missingInformation: [] }));
    let release!: () => void, observed!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<void>(resolve => { observed = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.controls.beforeResponse = async () => { observed(); await gate; };
    const processing = f.processRun(report.answer.id); void processing.catch(() => {});
    try {
      await Promise.race([response, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic provider response gate timeout")), 15_000); })]);
      await f.grant(f.a, evaluationAllPermissions.filter(value => value !== Permission.WorkflowRun)); release(); await processing;
    } finally { if (timer) clearTimeout(timer); release(); delete f.controls.beforeResponse; await Promise.allSettled([processing]); await f.grant(); }
    const [stored] = await withTenant(database.db, f.a.context, tx => tx.execute<{ status: string; error: string; output: string | null; cost: string | null; assessments: number; submission: string }>(sql`select
      a.status,a.error_code as error,a.encrypted_output as output,a.cost_usd as cost,x.submission_state as submission,
      (select count(*)::int from knowledge_evaluation_assessments where run_id=${created.id}::uuid) as assessments
      from ai_assist_runs a join ai_assist_executions x on x.run_id=a.id where a.id=${report.answer.id}::uuid`));
    expect(stored).toMatchObject({ status: "failed", error: "assist_access_changed", output: null, assessments: 0 }); expect(Number(stored!.cost)).toBeGreaterThan(0);
    expect(stored!.submission).not.toBe("not_submitted");
  });

  it("reads all twenty-one original runs through stable bounded pages and direct IDs without rescoring or dispatching", async () => {
    const s = await f.scenario(), ids: string[] = [];
    for (let index = 0; index < 21; index++) { const created = await start(s, { ...s.input, requestId: randomUUID() }); ids.push(created.id); await complete(created.id); }
    const state = await f.state(), calls = f.requests.length, dispatches = f.dispatches.length;
    expect(await f.evaluations.list(f.a.context, s.caseId)).toHaveLength(20);
    const all: KnowledgeEvaluationReport[] = []; let cursor: string | undefined;
    do { const page = KnowledgeEvaluationRunPageSchema.parse(await f.evaluations.page(f.a.context, s.caseId, { limit: 7, ...(cursor ? { cursor } : {}) }));
      expect(page.items.length).toBeLessThanOrEqual(7); all.push(...page.items); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toHaveLength(21); expect(new Set(all.map(row => row.id))).toEqual(new Set(ids));
    expect(all.map(row => row.id)).toEqual([...ids].sort().reverse());
    expect((await f.evaluations.report(f.a.context, ids[0]!)).id).toBe(ids[0]);
    expect(await f.state()).toEqual(state);
    const other = await f.scenario(), otherRun = await start(other);
    await expect(f.evaluations.page(f.a.context, s.caseId, { cursor: otherRun.id, limit: 7 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.evaluations.page(f.a.context, s.caseId, { cursor: createEntityId(), limit: 7 })).rejects.toBeInstanceOf(NotFoundException);
    // Compare only the read interval; the separately created foreign-anchor
    // control above legitimately adds one new intent after that interval.
    expect(f.requests).toHaveLength(calls); expect(f.dispatches.length).toBe(dispatches + 1);
    expect(state.knowledge_evaluation_assessments).toEqual((await f.state()).knowledge_evaluation_assessments);
  });

  /** Native SQL controls copy a real encrypted, method-pinned input but create
   * fresh IDs and full transaction births. Every such control rolls back. */
  async function rawIntent(tx: TenantTransaction, templateId: string, mode: "valid" | "missing_protocol" | "old_native" | "bad_checksum" | "missing_event" = "valid", nativeId?: string) {
    const [template] = await tx.select().from(knowledgeEvaluationRuns).where(eq(knowledgeEvaluationRuns.id, templateId));
    const [native] = await tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, nativeId ?? template!.assistRunId));
    const [protocol] = await tx.select().from(knowledgeEvaluationProtocols).where(eq(knowledgeEvaluationProtocols.runId, templateId));
    const id = createEntityId(), assistId = mode === "old_native" ? native!.id : createEntityId(), requestId = mode === "old_native" ? native!.requestId : randomUUID();
    const prepared = f.vault.withSecret(native!.encryptedInput!, text => JSON.parse(text) as AssistContext);
    prepared.request = { ...prepared.request, requestId };
    const inputFingerprint = assistFingerprint(prepared), modelId = native!.modelSnapshot.id;
    if (mode !== "old_native") {
      await tx.insert(aiAssistRuns).values({ ...native!, id: assistId, requestId, encryptedInput: f.vault.encrypt(JSON.stringify(prepared)), inputFingerprint,
        requestFingerprint: assistFingerprint(prepared.request), status: "queued", startedAt: null, completedAt: null, errorCode: null,
        encryptedOutput: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: new Date() });
      await tx.insert(aiAssistExecutions).values({ tenantId: f.a.tenantId, runId: assistId, inputFingerprint, policyChecksum: assistExecutionPolicy(false).checksum });
      await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: f.a.tenantId, requestId: assistId, taskType: "knowledge_answer", provider: "openai-compatible", modelKey: native!.modelSnapshot.model,
        amountUsd: native!.reservedCostUsd, state: "reserved" });
    }
    await tx.insert(knowledgeEvaluationRuns).values({ id, tenantId: f.a.tenantId, caseId: template!.caseId, assistRunId: assistId, caseSnapshot: template!.caseSnapshot, requestId, createdBy: f.a.userId });
    if (mode === "missing_protocol") return { id, assistId, requestId };
    const value = KnowledgeEvaluationProtocolSchema.parse({ version: "knowledge-evaluation-v1", runId: id, caseRevision: protocol!.caseRevision,
      caseChecksum: mode === "bad_checksum" ? "0".repeat(64) : knowledgeEvaluationChecksum(template!.caseSnapshot), requestChecksum: knowledgeEvaluationRequestChecksum(template!.caseId, { modelId, requestId }),
      basisFingerprint: knowledgeEvaluationBasis(template!.caseSnapshot, prepared, native!.promptVersion), inputFingerprint, modelId, dataScope: protocol!.dataScope, promptVersion: native!.promptVersion,
      assertionVersion: "knowledge-answer-assertions-v1", createdAt: new Date().toISOString() });
    await tx.insert(knowledgeEvaluationProtocols).values({ ...value, tenantId: f.a.tenantId, proof: sealKnowledgeEvaluationProtocol(f.vault, { tenantId: f.a.tenantId, createdBy: f.a.userId, assistRunId: assistId, protocol: value }),
      createdBy: f.a.userId, creationTransactionId: "1", createdAt: new Date(value.createdAt) });
    if (mode !== "missing_event") await importOwner.recordKnowledgeGovernanceEvent(tx, f.a.context, template!.caseId, "evaluation.start", "Synthetic raw birth control", { runId: id, assistRunId: assistId, caseRevision: value.caseRevision });
    return { id, assistId, requestId };
  }
  async function rejectRaw(templateId: string, mode: Parameters<typeof rawIntent>[2], message: string, nativeId?: string) {
    const before = await f.state();
    try { await withTenant(database.db, f.a.context, async tx => { await rawIntent(tx, templateId, mode, nativeId); await tx.execute(sql`set constraints all immediate`); }); throw new Error("Synthetic raw SQL unexpectedly committed"); }
    catch (error) { expect(pg(error)).toEqual({ code: "23514", message }); }
    expect(await f.state()).toEqual(before);
  }

  it("raw closure rejects an evaluation without its protocol, a committed native parent, wrong checksums and a missing original start event", async () => {
    const s = await f.scenario(), created = await start(s), before = await f.state();
    await expect(withTenant(database.db, f.a.context, async tx => { await rawIntent(tx, created.id); await tx.execute(sql`set constraints all immediate`); throw rollback; })).rejects.toBe(rollback);
    expect(await f.state()).toEqual(before);
    await rejectRaw(created.id, "missing_protocol", "knowledge_evaluation_protocol_required");
    await rejectRaw(created.id, "bad_checksum", "knowledge_evaluation_protocol_invalid");
    await rejectRaw(created.id, "missing_event", "knowledge_evaluation_start_event_required");
    const beforeGeneric = await f.state();
    await expect(f.assists.create(f.a.context, { kind: "knowledge_answer", purpose: "evaluation", scopeId: s.caseId, search: s.caseFields.search,
      evidenceStoreId: null, previousRunId: null, requestId: randomUUID(), modelId: s.input.modelId })).rejects.toBeInstanceOf(BadRequestException);
    expect(await f.state()).toEqual(beforeGeneric);
    const standalone = await f.assists.create(f.a.context, { kind: "knowledge_answer", purpose: "dialogue", scopeId: s.caseId, search: s.caseFields.search,
      evidenceStoreId: null, previousRunId: null, requestId: randomUUID(), modelId: s.input.modelId });
    await rejectRaw(created.id, "old_native", "knowledge_evaluation_native_owner_invalid", standalone.id);
  });

  it("raw early constraint flush cannot mutate the admitted case or native intent and cannot rewrite a real full-xid birth", async () => {
    const s = await f.scenario(), created = await start(s);
    for (const target of ["case", "native", "execution"] as const) {
      const before = await f.state();
      await expect(withTenant(database.db, f.a.context, async tx => { const born = await rawIntent(tx, created.id); await tx.execute(sql`set constraints all immediate`);
        if (target === "case") await tx.execute(sql`update knowledge_evaluation_cases set revision=revision+1 where id=${s.caseId}::uuid`);
        if (target === "native") await tx.execute(sql`update ai_assist_runs set status='running' where id=${born.assistId}::uuid`);
        if (target === "execution") await tx.execute(sql`update ai_assist_executions set dispatch_count=dispatch_count+1 where run_id=${born.assistId}::uuid`);
      })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === (target === "case" ? "knowledge_evaluation_case_sealed" : "knowledge_evaluation_native_sealed"));
      expect(await f.state()).toEqual(before);
    }
    const report = await f.evaluations.report(f.a.context, created.id), before = await f.state();
    await expect(withTenant(database.db, f.a.context, tx => tx.execute(sql`update ai_assist_runs set creation_transaction_id=pg_current_xact_id() where id=${report.answer.id}::uuid`))).rejects.toSatisfy((error: unknown) => pg(error).message === "ai_assist_birth_immutable");
    expect(await f.state()).toEqual(before);
  });

  it("authenticates actual protocol and assessment envelopes, rejects forged copies and enforces private immutable storage and actual completion", async () => {
    const s = await f.scenario(), created = await start(s), report = await complete(created.id);
    const [protocol] = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeEvaluationProtocols).where(eq(knowledgeEvaluationProtocols.runId, created.id)));
    const [assessment] = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeEvaluationAssessments).where(eq(knowledgeEvaluationAssessments.runId, created.id)));
    const identity = { tenantId: f.a.tenantId, createdBy: f.a.userId, assistRunId: report.answer.id, protocol: report.protocol! };
    expect(() => assertKnowledgeEvaluationProtocol(f.vault, identity, protocol!.proof)).not.toThrow();
    expect(() => assertKnowledgeEvaluationProtocol(f.vault, { ...identity, assistRunId: createEntityId() }, protocol!.proof)).toThrow("knowledge_evaluation_proof_invalid");
    expect(() => assertKnowledgeEvaluationProtocol(f.vault, identity, protocol!.proof.slice(0, -3) + "xyz")).toThrow("knowledge_evaluation_proof_invalid");
    const result = { tenantId: f.a.tenantId, createdBy: f.a.userId, resultChecksum: assessment!.resultChecksum, assessment: report.assessment! };
    expect(() => assertKnowledgeEvaluationAssessment(f.vault, result, assessment!.proof)).not.toThrow();
    expect(() => assertKnowledgeEvaluationAssessment(f.vault, { ...result, assessment: { ...report.assessment!, outputChecksum: "0".repeat(64) } }, assessment!.proof)).toThrow("knowledge_evaluation_proof_invalid");
    const queued = await start(s, { ...s.input, requestId: randomUUID() }), before = await f.state();
    await expect(withTenant(database.db, f.a.context, tx => tx.insert(knowledgeEvaluationAssessments).values({ ...assessment!, id: createEntityId(), runId: queued.id }))).rejects.toSatisfy((error: unknown) => pg(error).message === "knowledge_evaluation_birth_required");
    for (const context of [f.second.context, f.foreign.context]) expect(await withTenant(database.db, context, tx => tx.select().from(knowledgeEvaluationProtocols).where(eq(knowledgeEvaluationProtocols.runId, created.id)))).toEqual([]);
    await expect(withTenant(database.db, f.a.context, tx => tx.update(knowledgeEvaluationProtocols).set({ proof: "forged" }).where(eq(knowledgeEvaluationProtocols.runId, created.id)))).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    expect(knowledgeEvaluationChecksum({ basisFingerprint: assessment!.basisFingerprint, outputChecksum: assessment!.outputChecksum, assertionVersion: assessment!.assertionVersion,
      retrievalRecall: assessment!.retrievalRecall, citedRecall: assessment!.citedRecall, checks: assessment!.checks })).toBe(assessment!.resultChecksum);
  });
});
