import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import { type BenchmarkVersion, type BenchmarkAttempt, type BenchmarkReport } from "@yummyai/contracts/knowledge/benchmark";
import { type KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { businessBenchmarkSha, requireBusinessBenchmarkEnvironment } from "../../../../tools/testing/business-benchmark-fixture.mjs";
import { knowledgeEvaluationOwner } from "../../../../tools/testing/knowledge-evaluation-fixture.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { KnowledgeBenchmarkDatasetService } from "./knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService } from "./knowledge-benchmark-experiment.service.js";
import { KnowledgeBenchmarkCostService } from "./knowledge-benchmark-cost.service.js";

requireBusinessBenchmarkEnvironment("pre-0169");
type Receipt = { id: string; revision: number };
type StartInput = { itemId: string; expectedLatestAttemptId: string | null; confirmNewPaidAttempt: true; requestId: string };
type Original168 = { context: TenantContext; modelId: string; created: Receipt; createInput: unknown; version: BenchmarkVersion; providerCalls: number;
  completed: { receipt: Receipt; input: StartInput; attempt: BenchmarkAttempt };
  queued: { receipt: Receipt; input: StartInput; attempt: BenchmarkAttempt; native: KnowledgeEvaluationReport };
  reportReceipt: Receipt; reportInput: { reason: string; requestId: string }; report: BenchmarkReport };

describe.sequential("genuine168 knowledge benchmark to original-role business benchmark migration", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  afterAll(async () => { vi.useRealTimers(); try { if (child?.child.exitCode === null) await child.stop(true); } finally { await database.client.end(); } });

  it("preserves every original168 column, fixed knowledge manifest and report and resumes its genuine pending native Worker without business backfill", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_BUSINESS_BENCHMARK_LEGACY_SOURCE;
    const expected = resolve(workspace, "tmp/business-benchmark-20261021-c9e82d4a/old168-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expected) throw new Error("Actual frozen168 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-business-benchmark-c9e82d4a");
    const materialized = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialized).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 3037, dependencyLinks: 309,
      sourceSha256: "d460e31220edcbf41b9427cc98d2edad3b7475c5de0435a8f7dee56c03098186" });
    expect(resolve(materialized.target)).toBe(expected); expect(source.sha256).toBe(materialized.sourceSha256); expect(source.files).toHaveLength(3037);
    const verifySource = async () => { for (const file of source.files) expect(businessBenchmarkSha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256); };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/business-benchmark-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_BUSINESS_BENCHMARK_LEGACY_CHILD: "168" },
    }));
    let seeded: unknown;
    try { seeded = await child.wait("business.benchmark.seeded168", undefined, 120_000); }
    catch (error) {
      const events = child.events.filter(event => event.type === "business.benchmark.failed").slice(-3).map(event => {
        const value: Record<string, unknown> = event;
        return { phase: /^[a-z0-9][a-z0-9-]{0,63}$/.test(event.phase ?? "") ? event.phase : "unknown",
          errorName: typeof value.errorName === "string" && /^[A-Za-z]{1,40}Error$/.test(value.errorName) ? value.errorName : "Error",
          codes: Array.isArray(value.codes) ? value.codes.filter((code): code is string => typeof code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(code)).slice(0, 6) : [] };
      });
      const diagnostic = { exitCode: child.child.exitCode, signal: child.child.signalCode, events };
      const owned = resolve(workspace, "tmp/business-benchmark-20261021-c9e82d4a/qa"); await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, "legacy168-child-failure.json"), JSON.stringify(diagnostic, null, 2) + "\n");
      throw new Error(`Actual168 benchmark seed did not finish: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const old = seeded as Original168; expect(await child.closed).toBe(0); expect(old.providerCalls).toBe(1);
    expect(old.version.items).toHaveLength(2); expect(old.version.items.every(row => row.fields.role === "knowledge_answer" && row.caseId !== null)).toBe(true);
    expect(old.completed.attempt).toMatchObject({ state: "completed", assessment: { hardPass: true, graderVersion: "knowledge-benchmark-checks-v1" }, review: { decision: "pass" } });
    expect(old.queued.attempt.state).toBe("queued"); expect(old.queued.native.answer.status).toBe("queued");
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(168);
    const [originalVersion] = await withTenant(database.db, old.context, tx => tx.execute<{ manifest: { fields: { description: string } } }>(
      sql`select manifest from knowledge_benchmark_versions where id=${old.version.id}::uuid`));
    expect(originalVersion?.manifest.fields.description).toBe("Original168 knowledge-only manifest and native pending task");
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const evidence = await readMigrationEvidence(database); expect(evidence.actualRows.length).toBe(evidence.canonicalRows.length);
    expect(evidence.actualRows.slice(0, 168)).toEqual(journal); expect(await checkpoint.snapshot()).toEqual(before);
    const shape = async () => (await withTenant(database.db, old.context, tx => tx.execute<{ businessCases: number; businessNative: number; nativeLinks: number; oldCases: number }>(sql`select
      (select count(*)::int from knowledge_benchmark_items where fields->>'role'<>'knowledge_answer' or case_id is null) as "businessCases",
      (select count(*)::int from ai_assist_runs where benchmark_item_id is not null) as "businessNative",
      (select count(*)::int from knowledge_benchmark_attempts where native_run_id is not null) as "nativeLinks",
      (select count(*)::int from knowledge_benchmark_items where case_id is not null) as "oldCases"`)))[0]!;
    expect(await shape()).toEqual({ businessCases: 0, businessNative: 0, nativeLinks: 0, oldCases: 2 });
    const item = old.version.items.find(row => row.id === old.queued.attempt.itemId);
    if (!item || item.fields.role !== "knowledge_answer") throw new Error("Actual168 queued knowledge sample required");
    const requiredIds = item.fields.evaluation.requiredEntryIds, reference = old.queued.native.answer.knowledge.find(row => requiredIds.includes(row.entryId));
    if (!reference) throw new Error("Actual168 pending task must retain its fixed required reference");
    const requests: Array<{ model: string; body: Record<string, unknown> }> = [];
    const current = knowledgeEvaluationOwner(database, { requests, output: () => AssistResultSchema.parse({ summary: "Synthetic fixed fact",
      typedAnswers: [{ key: "total", value: "37.02", unit: "money", currency: "USD", evidence: [{ sourceId: reference.sourceId, detail: "Synthetic original168 three units at twelve point thirty-four" }] }],
      findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact", kind: "fact", severity: "info", location: null,
        evidence: [{ sourceId: reference.sourceId, detail: "Actual168 immutable source version" }] }], directions: [], matches: [], missingInformation: [] }) });
    const datasets = new KnowledgeBenchmarkDatasetService(database, current.evaluations, current.vault), experiments = new KnowledgeBenchmarkExperimentService(database, current.evaluations, current.vault),
      costs = new KnowledgeBenchmarkCostService(database, experiments, current.vault);
    const version = await datasets.version(old.context, old.version.id);
    const { description, ...originalProjection } = version;
    expect(description).toBe(originalVersion!.manifest.fields.description); expect(originalProjection).toEqual(old.version);
    expect(version.checksum).toBe(old.version.checksum);
    expect(await costs.readReport(old.context, old.reportReceipt.id)).toEqual(old.report);
    expect((await experiments.attempt(old.context, old.completed.receipt.id)).assessment).toEqual(old.completed.attempt.assessment);
    expect(await experiments.start(old.context, old.created.id, old.completed.input)).toEqual(old.completed.receipt);
    expect(await costs.report(old.context, old.created.id, old.reportInput)).toEqual(old.reportReceipt);
    expect(await checkpoint.snapshot()).toEqual(before);
    const nativeIdentity = async () => (await withTenant(database.db, old.context, tx => tx.execute<{ input: string; prompt: string; policy: string }>(sql`select
      n.input_fingerprint as input,n.prompt_version as prompt,e.policy_checksum as policy
      from ai_assist_runs n join ai_assist_executions e on e.run_id=n.id where n.id=${old.queued.native.answer.id}::uuid`)))[0]!;
    const admitted = await nativeIdentity(), processOriginal = (operation: "analyze" | "expire") => current.processor.process(JobEnvelopeSchema.parse({ jobId: old.queued.native.answer.id,
      tenantId: old.context.tenantId, requestedBy: old.context.userId, correlationId: old.queued.native.answer.id, idempotencyKey: old.queued.native.answer.id,
      payload: { runId: old.queued.native.answer.id, operation } }));
    await processOriginal("analyze"); const resumed = await experiments.attempt(old.context, old.queued.receipt.id);
    expect(resumed).toMatchObject({ state: "completed", evaluationRunId: old.queued.attempt.evaluationRunId, assessment: { hardPass: true, graderVersion: "knowledge-benchmark-checks-v1" } });
    expect(resumed.nativeRunId ?? null).toBeNull(); expect(resumed.result?.typedAnswers?.[0]?.value).toBe("37.02");
    const native = await current.assists.get(old.context, old.queued.native.answer.id);
    expect(native.executionContract).toEqual(old.queued.native.answer.executionContract); expect(native.methodSelection).toEqual(old.queued.native.answer.methodSelection);
    expect(await nativeIdentity()).toEqual(admitted); expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.body)).toContain("benchmarkCalculations"); expect(JSON.stringify(requests[0]!.body)).not.toContain("expectedValue");
    await processOriginal("analyze"); expect(requests).toHaveLength(1); expect((await experiments.attempt(old.context, old.queued.receipt.id)).assessment).toEqual(resumed.assessment);
    expect(await costs.readReport(old.context, old.reportReceipt.id)).toEqual(old.report); expect(await shape()).toEqual({ businessCases: 0, businessNative: 0, nativeLinks: 0, oldCases: 2 });
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      await processOriginal("expire"); expect(await experiments.start(old.context, old.created.id, old.queued.input)).toEqual(old.queued.receipt);
      expect((await experiments.attempt(old.context, old.queued.receipt.id)).assessment).toEqual(resumed.assessment);
      expect(await costs.readReport(old.context, old.reportReceipt.id)).toEqual(old.report);
    } finally { vi.useRealTimers(); }
    const owned = resolve(workspace, "tmp/business-benchmark-20261021-c9e82d4a/qa"); await mkdir(owned, { recursive: true });
    await writeFile(resolve(owned, "actual168-native-recovery.json"), JSON.stringify({ sourceSha256: source.sha256, sourceFiles: source.files.length,
      nativeId: old.queued.native.answer.id, originalContractSha256: businessBenchmarkSha(canonicalJson(native.executionContract ?? null)), originalMethodSha256: businessBenchmarkSha(canonicalJson(native.methodSelection ?? null)),
      originalInputFingerprint: admitted.input, originalPolicyChecksum: admitted.policy, providerCalls: requests.length, businessBackfilled: 0,
      originalManifestChecksum: old.version.checksum, originalReportChecksum: old.report.manifestChecksum }, null, 2) + "\n");
    await verifySource();
  });
});
