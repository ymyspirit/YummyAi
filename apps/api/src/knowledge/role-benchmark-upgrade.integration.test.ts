import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBenchmarkValue, runBusinessBenchmarkBaseline, type AssistContext } from "@yummyai/ai-core";
import { type TenantContext } from "@yummyai/contracts";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import { type BenchmarkVersion, type BenchmarkAttempt, type BenchmarkReport } from "@yummyai/contracts/knowledge/benchmark";
import { type KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { roleBenchmarkFixture, roleBenchmarkSha, roleEnvelope, requireRoleBenchmarkEnvironment } from "../../../../tools/testing/role-benchmark-fixture.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

requireRoleBenchmarkEnvironment("pre-0170");
type Receipt = { id: string; revision: number };
type StartInput = { itemId: string; expectedLatestAttemptId: string | null; confirmNewPaidAttempt: true; requestId: string };
type OriginalAttempt = { receipt: Receipt; input: StartInput; attempt: BenchmarkAttempt };
type OriginalFamily = { context: TenantContext; modelId: string; created: Receipt; createInput: unknown; version: BenchmarkVersion; providerCalls: number;
  reportReceipt: Receipt; reportInput: { reason: string; requestId: string }; report: BenchmarkReport };
type Original169 = {
  knowledge: OriginalFamily & { completed: OriginalAttempt; pending: OriginalAttempt & { native: KnowledgeEvaluationReport } };
  business: OriginalFamily & { completed: OriginalAttempt[]; pending: Array<OriginalAttempt & { native: Awaited<ReturnType<ReturnType<typeof roleBenchmarkFixture>["assists"]["get"]>> }> };
};

describe.sequential("genuine169 knowledge and two-role manifests survive the six-role benchmark migration", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined, current: ReturnType<typeof roleBenchmarkFixture> | undefined;
  afterAll(async () => { vi.useRealTimers(); try { if (child?.child.exitCode === null) await child.stop(true); }
    finally { try { current?.close(); } finally { await database.client.end(); } } });

  it("preserves every original169 column and both immutable report families and resumes their genuine knowledge, procurement and finance pending native Workers", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_ROLE_BENCHMARK_LEGACY_SOURCE;
    const expected = resolve(workspace, "tmp/role-benchmark-20261021-b84f6d29/old169-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expected) throw new Error("Actual frozen169 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-role-benchmark-b84f6d29");
    const materialized = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialized).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 3053, dependencyLinks: 309,
      sourceSha256: "5e828e740b9b94a9fbb4926974b5752b728e5e0330c18922796c2cae18900c3f" });
    expect(resolve(materialized.target)).toBe(expected); expect(source.sha256).toBe(materialized.sourceSha256); expect(source.files).toHaveLength(3053);
    const verifySource = async () => { for (const file of source.files) expect(roleBenchmarkSha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256); };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/role-benchmark-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_ROLE_BENCHMARK_LEGACY_CHILD: "169" },
    }));
    let seeded: unknown;
    try { seeded = await child.wait("role.benchmark.seeded169", undefined, 150_000); }
    catch (error) {
      const events = child.events.filter(event => event.type === "role.benchmark.failed").slice(-3).map(event => {
        const value: Record<string, unknown> = event;
        return { phase: /^[a-z0-9][a-z0-9-]{0,63}$/.test(event.phase ?? "") ? event.phase : "unknown",
          errorName: typeof value.errorName === "string" && /^[A-Za-z]{1,40}Error$/.test(value.errorName) ? value.errorName : "Error",
          codes: Array.isArray(value.codes) ? value.codes.filter((code): code is string => typeof code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(code)).slice(0, 6) : [] };
      });
      const diagnostic = { exitCode: child.child.exitCode, signal: child.child.signalCode, events };
      const owned = resolve(workspace, "tmp/role-benchmark-20261021-b84f6d29/qa"); await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, "legacy169-child-failure.json"), JSON.stringify(diagnostic, null, 2) + "\n");
      throw new Error(`Actual169 benchmark seed did not finish: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const old = seeded as Original169; expect(await child.closed).toBe(0);
    expect(old.knowledge.providerCalls).toBe(1); expect(old.business.providerCalls).toBe(2);
    expect(old.knowledge.version.items).toHaveLength(2); expect(old.business.version.items).toHaveLength(4);
    expect(old.knowledge.version.items.every(row => row.fields.role === "knowledge_answer" && row.caseId !== null)).toBe(true);
    expect(old.business.version.items.map(row => row.fields.role)).toEqual(["procurement_review", "procurement_review", "business_review", "business_review"]);
    expect(old.knowledge.completed.attempt).toMatchObject({ state: "completed", assessment: { hardPass: true, graderVersion: "knowledge-benchmark-checks-v1" }, review: { decision: "pass" } });
    for (const completed of old.business.completed) expect(completed.attempt).toMatchObject({ state: "completed", assessment: { hardPass: true, graderVersion: "business-benchmark-checks-v1" }, review: { decision: "pass" } });
    expect(old.knowledge.pending.native.answer.status).toBe("queued"); expect(old.business.pending.map(row => row.native.status)).toEqual(["queued", "queued"]);
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(169);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const evidence = await readMigrationEvidence(database); expect(evidence.actualRows.length).toBe(evidence.canonicalRows.length);
    expect(evidence.actualRows.slice(0, 169)).toEqual(journal); expect(await checkpoint.snapshot()).toEqual(before);
    const originalTarget = process.env.E2E_LEGACY_SCHEMA_TARGET;
    try { process.env.E2E_LEGACY_SCHEMA_TARGET = "current"; current = roleBenchmarkFixture(database); }
    finally { process.env.E2E_LEGACY_SCHEMA_TARGET = originalTarget; }
    const owner = current;
    const newRoleCount = async (context: TenantContext) => (await withTenant(database.db, context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count
      from knowledge_benchmark_items where fields->>'role' in ('creative','order_review','artwork_preflight','template_config','sku_package','after_sales_review')`)))[0]!.count;
    for (const family of [old.knowledge, old.business]) {
      expect(await newRoleCount(family.context)).toBe(0);
      expect(await owner.datasets.version(family.context, family.version.id)).toEqual(family.version);
      expect(await owner.experiments.create(family.context, family.createInput)).toEqual(family.created);
      expect(await owner.costs.readReport(family.context, family.reportReceipt.id)).toEqual(family.report);
      expect(await owner.costs.report(family.context, family.created.id, family.reportInput)).toEqual(family.reportReceipt);
      const completed = family === old.knowledge ? [old.knowledge.completed] : old.business.completed;
      for (const row of completed) {
        expect(await owner.experiments.attempt(family.context, row.receipt.id)).toEqual(row.attempt);
        expect(await owner.experiments.start(family.context, family.created.id, row.input)).toEqual(row.receipt);
      }
    }
    expect(await checkpoint.snapshot()).toEqual(before);
    const nativeIdentity = async (context: TenantContext, id: string) => (await withTenant(database.db, context, tx => tx.execute<{ input: string; prompt: string; policy: string }>(sql`select
      n.input_fingerprint as input,n.prompt_version as prompt,e.policy_checksum as policy
      from ai_assist_runs n join ai_assist_executions e on e.run_id=n.id where n.id=${id}::uuid`)))[0]!;
    const resumedProof: Array<{ kind: string; nativeId: string; inputFingerprint: string; toolChecksum: string; methodChecksum: string; assessmentChecksum: string }> = [];
    const pending = [{ family: old.knowledge, row: old.knowledge.pending, native: old.knowledge.pending.native.answer },
      ...old.business.pending.map(row => ({ family: old.business, row, native: row.native }))];
    for (const entry of pending) {
      const { family, row, native } = entry, admitted = await nativeIdentity(family.context, native.id), item = family.version.items.find(value => value.id === row.attempt.itemId)!;
      if (item.fields.role === "knowledge_answer") {
        const reference = native.knowledge.find(value => item.fields.role === "knowledge_answer" && item.fields.evaluation.requiredEntryIds.includes(value.entryId));
        if (!reference) throw new Error("Actual169 fixed knowledge reference required");
        owner.setOutput(AssistResultSchema.parse({ summary: "Synthetic fixed fact", findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact", kind: "fact", severity: "info", location: null,
          evidence: [{ sourceId: reference.sourceId, detail: "Actual169 original immutable reference" }] }], directions: [], matches: [], missingInformation: [],
          typedAnswers: [{ key: "total", value: "37.02", unit: "money", currency: "USD", evidence: [{ sourceId: reference.sourceId, detail: "Original three units at twelve point thirty-four" }] }] }));
      } else {
        const [body] = await withTenant(database.db, family.context, tx => tx.execute<{ encrypted: string }>(sql`select encrypted_basis as encrypted from knowledge_benchmark_items where id=${item.id}::uuid`));
        const prepared = openBenchmarkValue<{ prepared: AssistContext }>(owner.vault, "basis", body!.encrypted).prepared;
        expect(prepared.benchmarkResources).toBeUndefined(); expect(prepared.request.kind).toBe(item.fields.role);
        owner.setOutput(runBusinessBenchmarkBaseline(prepared));
      }
      const processOriginal = (operation: "analyze" | "expire") => owner.processor.process(roleEnvelope(family.context, { runId: native.id, operation }));
      const requests = owner.requests.length; await processOriginal("analyze");
      const resumed = await owner.experiments.attempt(family.context, row.receipt.id);
      expect(resumed).toMatchObject({ state: "completed", evaluationRunId: row.attempt.evaluationRunId,
        assessment: { hardPass: true, graderVersion: item.fields.role === "knowledge_answer" ? "knowledge-benchmark-checks-v1" : "business-benchmark-checks-v1" } });
      expect(resumed.nativeRunId ?? null).toBe(row.attempt.nativeRunId ?? null);
      const restored = await owner.assists.get(family.context, native.id);
      expect(restored.executionContract).toEqual(native.executionContract); expect(restored.methodSelection).toEqual(native.methodSelection);
      expect(await nativeIdentity(family.context, native.id)).toEqual(admitted); expect(owner.requests).toHaveLength(requests + 1);
      expect(JSON.stringify(owner.requests.at(-1)!.body)).not.toMatch(/expectedFacts|expectedValue|forbiddenClaims/);
      await processOriginal("analyze"); expect(owner.requests).toHaveLength(requests + 1);
      expect((await owner.experiments.attempt(family.context, row.receipt.id)).assessment).toEqual(resumed.assessment);
      expect(await owner.costs.readReport(family.context, family.reportReceipt.id)).toEqual(family.report);
      try {
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
        await processOriginal("expire"); expect(await owner.experiments.start(family.context, family.created.id, row.input)).toEqual(row.receipt);
        const retired = await owner.experiments.attempt(family.context, row.receipt.id);
        expect(retired.result).toBeNull(); expect(retired.assessment).toEqual(resumed.assessment);
        expect(await owner.costs.readReport(family.context, family.reportReceipt.id)).toEqual(family.report);
      } finally { vi.useRealTimers(); }
      resumedProof.push({ kind: item.fields.role, nativeId: native.id, inputFingerprint: admitted.input, toolChecksum: roleBenchmarkSha(JSON.stringify(native.executionContract)),
        methodChecksum: roleBenchmarkSha(JSON.stringify(native.methodSelection)), assessmentChecksum: roleBenchmarkSha(JSON.stringify(resumed.assessment)) });
    }
    expect(owner.requests).toHaveLength(3); for (const family of [old.knowledge, old.business]) expect(await newRoleCount(family.context)).toBe(0);
    const owned = resolve(workspace, "tmp/role-benchmark-20261021-b84f6d29/qa"); await mkdir(owned, { recursive: true });
    await writeFile(resolve(owned, "actual169-original-family-recovery.json"), JSON.stringify({ sourceSha256: source.sha256, sourceFiles: source.files.length,
      originalManifests: [old.knowledge.version.checksum, old.business.version.checksum], originalReports: [old.knowledge.report.manifestChecksum, old.business.report.manifestChecksum],
      resumed: resumedProof, actualProviderRequests: owner.requests.length, newRoleBackfilled: 0 }, null, 2) + "\n");
    await verifySource();
  });
});
