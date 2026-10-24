import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictException } from "@nestjs/common";
import { type TenantContext } from "@yummyai/contracts";
import { AssistResultSchema, type AssistView } from "@yummyai/contracts/ai/assist";
import type { KnowledgeEvaluationCase } from "@yummyai/contracts/knowledge/evaluation-case";
import type { KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { evaluationSha, knowledgeEvaluationOwner, requireKnowledgeEvaluationEnvironment } from "../../../../tools/testing/knowledge-evaluation-fixture.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

requireKnowledgeEvaluationEnvironment("pre-0167");
type Original166 = { context: TenantContext; roleId: string; membershipId: string; modelId: string; caseId: string;
  caseFields: KnowledgeEvaluationCase; cardId: string; modelCalls: number; queuedIds: string[]; isolated: AssistView;
  first: { input: { modelId: string; requestId: string }; result: { id: string }; report: KnowledgeEvaluationReport };
  queued: { input: { modelId: string; requestId: string }; result: { id: string }; report: KnowledgeEvaluationReport } };

describe.sequential("genuine166 native knowledge evaluation migration to original execution protocols", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  afterAll(async () => { vi.useRealTimers(); try { if (child?.child.exitCode === null) await child.stop(true); } finally { await database.client.end(); } });

  it("preserves real166 columns and original completed, queued and orphan receipts with zero protocol backfill, then restores expired keys without adopting a legacy native task", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_KNOWLEDGE_EVALUATION_LEGACY_SOURCE;
    const expectedRoot = resolve(workspace, "tmp/knowledge-evaluation-20261021-e4c8a571/old166-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Pinned actual166 knowledge source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-knowledge-evaluation-e4c8a571");
    const materialized = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialized).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 2988, dependencyLinks: 309,
      sourceSha256: "3a622e99b2ed8d952852fa88ec8f53af0ea23f4c4fa46f70a10036779151dc4f" });
    expect(resolve(materialized.target)).toBe(expectedRoot); expect(source.sha256).toBe(materialized.sourceSha256); expect(source.files).toHaveLength(2988);
    const verifySource = async () => { for (const file of source.files) expect(evaluationSha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256); };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/knowledge-evaluation-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"),
        E2E_LEGACY_SCHEMA_TARGET: "current", E2E_KNOWLEDGE_EVALUATION_LEGACY_CHILD: "166" },
    }));
    let seeded: unknown;
    try { seeded = await child.wait("knowledge.evaluation.seeded166", undefined, 120_000); }
    catch (error) {
      const safeCode = /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/;
      const events = child.events.filter(event => event.type === "knowledge.evaluation.failed").slice(-3).map(event => {
        const value: Record<string, unknown> = event;
        return { phase: /^[a-z][a-z0-9-]{0,63}$/.test(event.phase ?? "") ? event.phase : "unknown",
          errorName: typeof value.errorName === "string" && /^[A-Za-z]{1,40}Error$/.test(value.errorName) ? value.errorName : "Error",
          codes: Array.isArray(value.codes) ? value.codes.filter((code): code is string => typeof code === "string" && safeCode.test(code)).slice(0, 6) : [] };
      });
      const diagnostic = { exitCode: child.child.exitCode, signal: child.child.signalCode, events };
      const owned = resolve(workspace, "tmp/knowledge-evaluation-20261021-e4c8a571/qa"); await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, "legacy166-child-failure.json"), JSON.stringify(diagnostic, null, 2) + "\n");
      throw new Error(`Actual166 knowledge seed did not complete: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const old = seeded as Original166;
    expect(await child.closed).toBe(0); expect(old.modelCalls).toBe(1); expect(new Set(old.queuedIds).size).toBe(3);
    expect(old.first.report.answer.status).toBe("completed"); expect(old.first.report.checks.every(row => row.status === "pass")).toBe(true);
    expect(old.first.report.manualReviews[0]?.result).toBe("pass"); expect(old.queued.report.answer.status).toBe("queued");
    expect(old.isolated.request).toMatchObject({ purpose: "evaluation", scopeId: old.caseId });
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(166);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const migrated = (await readMigrationEvidence(database)).actualRows; expect(migrated).toHaveLength(167); expect(migrated.slice(0, 166)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before);
    const shape = await withTenant(database.db, old.context, tx => tx.execute<{ name: string; forced: boolean; count: number; app: boolean }>(sql`select c.relname as name,c.relforcerowsecurity as forced,
      case c.relname when 'knowledge_evaluation_protocols' then(select count(*)::int from knowledge_evaluation_protocols)
      else(select count(*)::int from knowledge_evaluation_assessments) end as count,current_user='yummyai_app' as app from pg_class c
      where c.relname in('knowledge_evaluation_protocols','knowledge_evaluation_assessments') order by c.relname`));
    expect(shape).toHaveLength(2); expect(shape.every(row => row.forced && row.count === 0 && row.app)).toBe(true);
    const [births] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number; pinned: number }>(sql`select count(*)::int as count,count(creation_transaction_id)::int as pinned from ai_assist_runs`));
    expect(births).toEqual({ count: 3, pinned: 0 });
    const dispatches: string[] = [], requests: Array<{ model: string; body: Record<string, unknown> }> = [];
    let output = AssistResultSchema.parse({ summary: "Synthetic original166 fixed fact", findings: [], directions: [], matches: [], missingInformation: [] });
    const current = knowledgeEvaluationOwner(database, { queue: { enqueue: async input => { dispatches.push(input.id); } }, requests, output: () => output });
    for (const entry of [old.first, old.queued]) {
      expect(await current.evaluations.start(old.context, old.caseId, entry.input)).toEqual(entry.result);
      const report = await current.evaluations.report(old.context, entry.result.id);
      expect(report.protocol ?? null).toBeNull(); expect(report.assessment ?? null).toBeNull(); expect(report.assessmentState).toBe("unrecorded");
      expect(report.caseSnapshot).toEqual(entry.report.caseSnapshot); expect(report.answer.id).toBe(entry.report.answer.id);
      expect(report.manualReviews).toEqual(entry.report.manualReviews);
    }
    expect(requests).toEqual([]); expect(dispatches.every(id => id === old.queued.report.answer.id)).toBe(true);
    const replayCheckpoint = await checkpoint.snapshot(); expect(replayCheckpoint).toEqual(before);
    const legacyPair = await current.evaluations.compare(old.context, { baselineRunId: old.first.result.id, candidateRunId: old.queued.result.id });
    expect(legacyPair.comparable).toBe(false); expect(legacyPair.reasons.length).toBeGreaterThan(0);
    expect((await current.evaluations.page(old.context, old.caseId, { limit: 1 })).nextCursor).not.toBeNull();
    // The raw native task has exactly the new start's body and model, but was
    // genuinely committed before167 without a linked evaluation. Do not adopt it.
    await expect(current.evaluations.start(old.context, old.caseId, { modelId: old.modelId, requestId: old.isolated.request!.requestId })).rejects.toBeInstanceOf(ConflictException);
    expect(await checkpoint.snapshot()).toEqual(before);
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      for (const id of [old.first.report.answer.id, old.queued.report.answer.id, old.isolated.id]) await current.processor.process(JobEnvelopeSchema.parse({
        jobId: id, tenantId: old.context.tenantId, requestedBy: old.context.userId, correlationId: id, idempotencyKey: id, payload: { runId: id, operation: "expire" } }));
      for (const entry of [old.first, old.queued]) {
        expect(await current.evaluations.start(old.context, old.caseId, entry.input)).toEqual(entry.result);
        const report = await current.evaluations.report(old.context, entry.result.id);
        expect(report.answer.request).toBeNull(); expect(report.answer.result).toBeNull(); expect(report.protocol ?? null).toBeNull();
        expect(report.assessment ?? null).toBeNull(); expect(report.assessmentState).toBe("unrecorded"); expect(report.manualReviews).toEqual(entry.report.manualReviews);
      }
    } finally { vi.useRealTimers(); }
    expect(requests).toEqual([]);
    const [legacy] = await withTenant(database.db, old.context, tx => tx.execute<{ evaluations: number; protocols: number; assessments: number; pinned: number }>(sql`select
      (select count(*)::int from knowledge_evaluation_runs) as evaluations,(select count(*)::int from knowledge_evaluation_protocols) as protocols,
      (select count(*)::int from knowledge_evaluation_assessments) as assessments,(select count(*)::int from ai_assist_runs where creation_transaction_id is not null) as pinned`));
    expect(legacy).toEqual({ evaluations: 2, protocols: 0, assessments: 0, pinned: 0 });
    const created = await current.evaluations.start(old.context, old.caseId, { modelId: old.modelId, requestId: randomUUID() });
    const pending = await current.evaluations.report(old.context, created.id), reference = pending.answer.knowledge.find(row => row.entryId === old.cardId);
    expect(reference).toBeDefined();
    output = AssistResultSchema.parse({ summary: "Synthetic original166 fixed fact", findings: [{ title: "Synthetic original166 fixed fact", detail: "Synthetic original166 fixed fact", kind: "fact", severity: "info",
      evidence: [{ sourceId: reference!.sourceId, detail: "Synthetic actual source after167" }], location: null }], directions: [], matches: [], missingInformation: [] });
    await current.processor.process(JobEnvelopeSchema.parse({ jobId: pending.answer.id, tenantId: old.context.tenantId, requestedBy: old.context.userId,
      correlationId: pending.answer.id, idempotencyKey: pending.answer.id, payload: { runId: pending.answer.id, operation: "analyze" } }));
    const sealed = await current.evaluations.report(old.context, created.id);
    expect(sealed).toMatchObject({ protocol: { version: "knowledge-evaluation-v1", runId: created.id }, assessmentState: "recorded" });
    expect(sealed.assessment?.checks.every(row => row.status === "pass")).toBe(true); expect(requests).toHaveLength(1);
    const incomparable = await current.evaluations.compare(old.context, { baselineRunId: old.first.result.id, candidateRunId: created.id });
    expect(incomparable.comparable).toBe(false); expect(incomparable.reasons.length).toBeGreaterThan(0);
    const [stillLegacy] = await withTenant(database.db, old.context, tx => tx.execute<{ oldPinned: number; protocols: number }>(sql`select
      (select count(*)::int from ai_assist_runs where id=any(array[${old.first.report.answer.id}::uuid,${old.queued.report.answer.id}::uuid,${old.isolated.id}::uuid]) and creation_transaction_id is not null) as "oldPinned",
      (select count(*)::int from knowledge_evaluation_protocols) as protocols`));
    expect(stillLegacy).toEqual({ oldPinned: 0, protocols: 1 });
    await verifySource();
  });
});
