import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence, withTenant, agentLoopRuns, agentLoopSteps, aiBudgetLedger } from "@yummyai/database";
import { TenantContextSchema } from "@yummyai/contracts";
import { CreateAssistSchema, AssistViewSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { JobEnvelopeSchema, createQueue, QueueName } from "@yummyai/jobs";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { requireAgentLoopLegacyEnvironment, assertAgentLoopOriginal171Graph } from "../../../../tools/testing/agent-loop-legacy.mjs";
import { knowledgeEvaluationOwner } from "../../../../tools/testing/knowledge-evaluation-fixture.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

const frozen = requireAgentLoopLegacyEnvironment(process.env, "pre-0172"), database = connectDatabase(frozen.url);
const Original = z.object({ type: z.literal("agent.loop.seeded171"), context: TenantContextSchema, modelId: z.uuidv7(),
  completedRequest: CreateAssistSchema, queuedRequest: CreateAssistSchema, unknownRequest: CreateAssistSchema,
  completedView: AssistViewSchema, queuedView: AssistViewSchema, unknownView: AssistViewSchema,
  queuedAnalyzeJobId: z.string().min(1), unknownAnalyzeJobId: z.string().min(1), realQueueJobIds: z.array(z.string().min(1)), originalProviderCalls: z.int().nonnegative() }).strict();
const sha = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");

describe.sequential("Genuine171 native Assist history remains outside the new172 Agent loop protocol", () => {
  let child: InvoiceProcess | undefined, queue: ReturnType<typeof createQueue> | undefined;
  afterAll(async () => {
    const errors: unknown[] = [];
    try { if (child && child.child.exitCode === null) await child.stop(true); } catch (error) { errors.push(error); }
    try { await queue?.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Agent loop upgrade teardown failed");
  });
  it("preserves every original171 column and receipt with zero loop backfill, then processes the original Redis job once and never rebuys the old submitted unknown", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-22-agent-loop-68018aa3");
    const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    const materialized = JSON.parse(await readFile(prefix + "-old171-source.json", "utf8"));
    expect(source.sha256).toBe("55c68111d257832e4efb34ac7c15ff369f7d8100acd65436e0955d4c87b20e43"); expect(source.files).toHaveLength(3136);
    expect(materialized).toMatchObject({ allBaselineBytesVerified: true, sourceSha256: source.sha256, workspaceDependenciesPinned: true });
    const verify = async () => { await assertAgentLoopOriginal171Graph(frozen.root); for (const file of source.files) expect(sha(await readFile(resolve(frozen.root, file.path))), file.path).toBe(file.sha256); };
    await verify();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/agent-loop-legacy.mts")], {
      cwd: resolve(frozen.root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(frozen.root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_LOOP_LEGACY_CHILD: "171" },
    }));
    const old = Original.parse(await child.wait("agent.loop.seeded171", undefined, 100_000));
    expect(await child.closed).toBe(0); expect(old.originalProviderCalls).toBe(2); expect(old.realQueueJobIds.length).toBeGreaterThanOrEqual(6);
    const beforeJournal = (await readMigrationEvidence(database)).actualRows; expect(beforeJournal).toHaveLength(171);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const afterJournal = await readMigrationEvidence(database); expect(afterJournal.actualRows).toHaveLength(172); expect(afterJournal.actualRows.slice(0, 171)).toEqual(beforeJournal);
    expect(await checkpoint.snapshot()).toEqual(before);
    await withTenant(database.db, old.context, async tx => {
      expect(await tx.select().from(agentLoopRuns)).toEqual([]); expect(await tx.select().from(agentLoopSteps)).toEqual([]);
      expect((await tx.execute<{ count: number }>(sql`select count(*)::int as count from audit_events where action like 'agent.loop.%'`))[0]?.count).toBe(0);
    });
    const requests: Array<{ model: string; body: Record<string, unknown> }> = [], current = knowledgeEvaluationOwner(database, { requests });
    const proof = (request: CreateAssist) => ({ requestId: request.requestId, requestChecksum: sha(assistRequestRecoveryText(request)) });
    expect(await current.assists.get(old.context, old.completedView.id)).toEqual(old.completedView);
    expect((await current.assists.receipt(old.context, proof(old.completedRequest))).run).toEqual(old.completedView);
    expect((await current.assists.receipt(old.context, proof(old.unknownRequest))).run).toEqual(old.unknownView);
    expect(await checkpoint.snapshot()).toEqual(before); expect(requests).toHaveLength(0);
    queue = createQueue(QueueName.AiAssist, process.env.E2E_DISPOSABLE_REDIS_URL);
    const job = await queue.getJob(old.queuedAnalyzeJobId); if (!job) throw new Error("Original171 Redis job disappeared");
    const envelope = JobEnvelopeSchema.parse(job.data); expect(envelope.payload).toMatchObject({ runId: old.queuedView.id, operation: "analyze" });
    const ledgers = await withTenant(database.db, old.context, tx => tx.select().from(aiBudgetLedger));
    await current.processor.process(envelope);
    expect((await current.assists.get(old.context, old.queuedView.id)).status).toBe("completed"); expect(requests).toHaveLength(1);
    await current.processor.process(envelope); expect(requests).toHaveLength(1);
    const unknownJob = await queue.getJob(old.unknownAnalyzeJobId); if (!unknownJob) throw new Error("Original171 unknown Redis intent disappeared");
    const unknownEnvelope = JobEnvelopeSchema.parse(unknownJob.data); expect(unknownEnvelope.payload).toMatchObject({ runId: old.unknownView.id, operation: "analyze" });
    await current.processor.process(unknownEnvelope); expect(requests).toHaveLength(1);
    expect((await current.assists.receipt(old.context, proof(old.unknownRequest))).run).toEqual(old.unknownView);
    const afterLedger = await withTenant(database.db, old.context, tx => tx.select().from(aiBudgetLedger));
    expect(afterLedger.map(row => row.id).sort()).toEqual(ledgers.map(row => row.id).sort());
    expect(afterLedger.find(row => row.requestId === old.unknownView.id)).toEqual(ledgers.find(row => row.requestId === old.unknownView.id));
    expect(afterLedger.find(row => row.requestId === old.queuedView.id)?.state).toBe("committed");
    expect(await withTenant(database.db, old.context, tx => tx.select().from(agentLoopRuns))).toEqual([]);
    expect(await withTenant(database.db, old.context, tx => tx.select().from(agentLoopSteps))).toEqual([]);
    const [originalUnknown] = await withTenant(database.db, old.context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, old.unknownView.id)));
    expect(originalUnknown?.state).toBe("reserved"); await verify();
  });
});
