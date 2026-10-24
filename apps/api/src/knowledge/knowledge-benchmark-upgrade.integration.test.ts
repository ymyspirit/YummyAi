import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type TenantContext } from "@yummyai/contracts";
import { type KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import { BenchmarkDatasetFieldsSchema } from "@yummyai/contracts/knowledge/benchmark";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { benchmarkSha, benchmarkTables, knowledgeEvaluationOwner, requireKnowledgeBenchmarkEnvironment } from "../../../../tools/testing/knowledge-benchmark-fixture.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { KnowledgeBenchmarkDatasetService } from "./knowledge-benchmark-dataset.service.js";

requireKnowledgeBenchmarkEnvironment("pre-0168");
type Original167 = { context: TenantContext; modelId: string; scenario: { cardId: string; caseId: string }; modelCalls: number;
  completed: { input: { modelId: string; requestId: string }; result: { id: string }; report: KnowledgeEvaluationReport };
  queued: { input: { modelId: string; requestId: string }; result: { id: string }; report: KnowledgeEvaluationReport } };

describe.sequential("genuine167 knowledge protocols to published benchmark experiments", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  afterAll(async () => { vi.useRealTimers(); try { if (child?.child.exitCode === null) await child.stop(true); } finally { await database.client.end(); } });

  it("preserves actual167 columns, original sealed scores, absent typed answers and expired-key receipts without dataset or experiment backfill", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_KNOWLEDGE_BENCHMARK_LEGACY_SOURCE;
    const expectedRoot = resolve(workspace, "tmp/knowledge-benchmark-20261021-a7d9e6c2/old167-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Pinned actual167 benchmark source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-knowledge-benchmark-a7d9e6c2");
    const materialized = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialized).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 3007, dependencyLinks: 309,
      sourceSha256: "d9109f8d62d97f5da6ec3a3cb38f1ec637f6774fde8943a8e0d3813a330f1eb9" });
    expect(resolve(materialized.target)).toBe(expectedRoot); expect(source.sha256).toBe(materialized.sourceSha256); expect(source.files).toHaveLength(3007);
    const verifySource = async () => { for (const file of source.files) expect(benchmarkSha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256); };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/knowledge-benchmark-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_KNOWLEDGE_BENCHMARK_LEGACY_CHILD: "167" },
    }));
    let seeded: unknown;
    try { seeded = await child.wait("knowledge.benchmark.seeded167", undefined, 120_000); }
    catch (error) {
      const safeCode = /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/;
      const events = child.events.filter(event => event.type === "knowledge.benchmark.failed").slice(-3).map(event => {
        const value: Record<string, unknown> = event;
        return { phase: /^[a-z][a-z0-9-]{0,63}$/.test(event.phase ?? "") ? event.phase : "unknown",
          errorName: typeof value.errorName === "string" && /^[A-Za-z]{1,40}Error$/.test(value.errorName) ? value.errorName : "Error",
          codes: Array.isArray(value.codes) ? value.codes.filter((code): code is string => typeof code === "string" && safeCode.test(code)).slice(0, 6) : [] };
      });
      const diagnostic = { exitCode: child.child.exitCode, signal: child.child.signalCode, events };
      const owned = resolve(workspace, "tmp/knowledge-benchmark-20261021-a7d9e6c2/qa"); await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, "legacy167-child-failure.json"), JSON.stringify(diagnostic, null, 2) + "\n");
      throw new Error(`Actual167 benchmark seed did not complete: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const old = seeded as Original167; expect(await child.closed).toBe(0); expect(old.modelCalls).toBe(1);
    expect(old.completed.report).toMatchObject({ assessmentState: "recorded", answer: { status: "completed" } });
    expect(Object.hasOwn(old.completed.report.answer.result!, "typedAnswers")).toBe(false);
    expect(old.completed.report.manualReviews[0]?.result).toBe("pass"); expect(old.queued.report.answer.status).toBe("queued");
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(167);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const currentJournal = await readMigrationEvidence(database), migrated = currentJournal.actualRows;
    expect(migrated).toHaveLength(currentJournal.canonicalRows.length); expect(migrated.slice(0, 167)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before);
    await withTenant(database.db, old.context, async tx => {
      for (const table of benchmarkTables) {
        const [shape] = await tx.execute<{ count: number; forced: boolean; app: boolean }>(sql`select count(*)::int as count,
          (select relforcerowsecurity from pg_class where oid=${table}::regclass) as forced,current_user='yummyai_app' as app from ${sql.identifier(table)}`);
        expect(shape, table).toEqual({ count: 0, forced: true, app: true });
      }
    });
    const reference = old.queued.report.answer.knowledge[0]; if (!reference) throw new Error("Actual167 pending task must retain its original knowledge reference");
    const resumedRequests: Array<{ model: string; body: Record<string, unknown> }> = [];
    const current = knowledgeEvaluationOwner(database, { requests: resumedRequests, output: () => AssistResultSchema.parse({ summary: "Synthetic fixed fact",
      findings: [{ title: "Synthetic original167 reference", detail: "Synthetic fixed fact", kind: "fact", severity: "info", location: null,
        evidence: [{ sourceId: reference.sourceId, detail: "Actual frozen167 source version, completed by the new Worker" }] }], directions: [], matches: [], missingInformation: [] }) });
    const first = await current.evaluations.report(old.context, old.completed.result.id);
    expect(first.caseSnapshot).toEqual(old.completed.report.caseSnapshot); expect(first.protocol).toEqual(old.completed.report.protocol);
    expect(first.assessment).toEqual(old.completed.report.assessment); expect(first.answer.result).toEqual(old.completed.report.answer.result);
    expect(Object.hasOwn(first.answer.result!, "typedAnswers")).toBe(false);
    expect(await current.evaluations.start(old.context, old.scenario.caseId, old.completed.input)).toEqual(old.completed.result);
    expect(await current.evaluations.start(old.context, old.scenario.caseId, old.queued.input)).toEqual(old.queued.result);
    expect(await checkpoint.snapshot()).toEqual(before);
    const nativeIdentity = async () => (await withTenant(database.db, old.context, tx => tx.execute<{ inputFingerprint: string; promptVersion: string; policyChecksum: string }>(sql`select
      n.input_fingerprint as "inputFingerprint",n.prompt_version as "promptVersion",e.policy_checksum as "policyChecksum"
      from ai_assist_runs n join ai_assist_executions e on e.run_id=n.id where n.id=${old.queued.report.answer.id}::uuid`)))[0]!;
    const admitted167 = await nativeIdentity();
    const processOriginal = () => current.processor.process(JobEnvelopeSchema.parse({ jobId: old.queued.report.answer.id, tenantId: old.context.tenantId,
      requestedBy: old.context.userId, correlationId: old.queued.report.answer.id, idempotencyKey: old.queued.report.answer.id,
      payload: { runId: old.queued.report.answer.id, operation: "analyze" } }));
    await processOriginal();
    const resumed = await current.evaluations.report(old.context, old.queued.result.id);
    expect(resumed.answer.status).toBe("completed"); expect(resumed.assessmentState).toBe("recorded");
    expect(resumed.assessment?.checks.every(row => row.status === "pass")).toBe(true); expect(resumed.protocol).toEqual(old.queued.report.protocol);
    expect(Object.hasOwn(resumed.answer.result!, "typedAnswers")).toBe(false); expect(resumed.answer.executionContract).toEqual(old.queued.report.answer.executionContract);
    expect(resumed.answer.methodSelection).toEqual(old.queued.report.answer.methodSelection); expect(await nativeIdentity()).toEqual(admitted167);
    expect(resumedRequests).toHaveLength(1); expect(JSON.stringify(resumedRequests[0]!.body)).not.toContain("typedAnswers");
    await processOriginal(); expect(resumedRequests).toHaveLength(1);
    expect((await current.evaluations.report(old.context, old.queued.result.id)).assessment).toEqual(resumed.assessment);
    for (const table of benchmarkTables) {
      const [count] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier(table)}`));
      expect(count!.count, table).toBe(0);
    }
    const evidence = resolve(workspace, "tmp/knowledge-benchmark-20261021-a7d9e6c2/qa"); await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, "actual167-worker-resumption.json"), JSON.stringify({ sourceSha256: source.sha256, originalRunId: old.queued.result.id,
      originalNativeId: old.queued.report.answer.id, workerProviderCalls: resumedRequests.length, originalNativeIdentity: admitted167,
      originalContractSha256: benchmarkSha(JSON.stringify(old.queued.report.answer.executionContract ?? null)),
      originalMethodSha256: benchmarkSha(JSON.stringify(old.queued.report.answer.methodSelection ?? null)),
      publishedMethodExercised: old.queued.report.answer.methodSelection?.mode === "published", absentTypedAnswersPreserved: true, benchmarkBackfilledRows: 0 }, null, 2) + "\n");
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      for (const entry of [old.completed, old.queued]) await current.processor.process(JobEnvelopeSchema.parse({ jobId: entry.report.answer.id,
        tenantId: old.context.tenantId, requestedBy: old.context.userId, correlationId: entry.report.answer.id, idempotencyKey: entry.report.answer.id,
        payload: { runId: entry.report.answer.id, operation: "expire" } }));
      expect(await current.evaluations.start(old.context, old.scenario.caseId, old.completed.input)).toEqual(old.completed.result);
      const retired = await current.evaluations.report(old.context, old.completed.result.id);
      expect(retired.answer.result).toBeNull(); expect(retired.protocol).toEqual(first.protocol); expect(retired.assessment).toEqual(first.assessment);
      expect(retired.checks).toEqual(first.checks); expect(retired.manualReviews).toEqual(first.manualReviews);
    } finally { vi.useRealTimers(); }
    const datasets = new KnowledgeBenchmarkDatasetService(database, current.evaluations, current.vault);
    const fields = BenchmarkDatasetFieldsSchema.parse({ name: "Synthetic after168 dataset", description: "Explicit new publication never adopts old runs",
      items: [1, 2].map(index => ({ key: `new_${index}`, role: "knowledge_answer", evaluation: { ...first.caseSnapshot, label: `Explicit sample ${index}` }, calculations: [] })) });
    const saved = await datasets.save(old.context, null, { fields, expectedRevision: 0, reason: "Synthetic after168 create", requestId: randomUUID() });
    const published = await datasets.publish(old.context, saved.id, { expectedRevision: saved.revision, retentionDays: 30, reason: "Synthetic after168 explicit publish", requestId: randomUUID() });
    const version = await datasets.version(old.context, published.id); expect(version.items).toHaveLength(2);
    expect(version.items.every(row => row.caseId!==old.scenario.caseId)).toBe(true);
    const [counts] = await withTenant(database.db, old.context, tx => tx.execute<{ experiments: number; attempts: number; reports: number }>(sql`select
      (select count(*)::int from knowledge_benchmark_experiments) as experiments,(select count(*)::int from knowledge_benchmark_attempts) as attempts,
      (select count(*)::int from knowledge_benchmark_reports) as reports`));
    expect(counts).toEqual({ experiments: 0, attempts: 0, reports: 0 });
    expect((await current.evaluations.report(old.context, old.completed.result.id)).assessment).toEqual(first.assessment);
    await verifySource();
  });
});
