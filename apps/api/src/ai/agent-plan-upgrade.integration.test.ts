import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { TenantContextSchema } from "@yummyai/contracts";
import { AgentCommandViewSchema, AgentCommandReceiptSchema, PrepareAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { AgentLoopRunViewSchema, CreateAgentLoopSchema } from "@yummyai/contracts/ai/agent-loop";
import { agentPlanRuns, agentPlanSteps, agentPlanItems, aiBudgetLedger, connectDatabase, migrateDatabase,
  assertDatabaseMigrationsCurrent, readMigrationEvidence, withTenant } from "@yummyai/database";
import { createQueue, QueueName, JobEnvelopeSchema } from "@yummyai/jobs";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { assertAgentPlanOriginal173Graph, requireAgentPlanLegacyEnvironment } from "../../../../tools/testing/agent-plan-legacy.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { agentLoopFixture } from "./agent-loop.test-fixture.js";
import { agentCommandOwners } from "./agent-command.test-fixture.js";

const target = requireAgentPlanLegacyEnvironment(process.env, "pre-0174"), database = connectDatabase(target.url);
const Original = z.object({ type: z.literal("agent.plan.seeded173"), loopContext: TenantContextSchema, completedInput: CreateAgentLoopSchema,
  unknownInput: CreateAgentLoopSchema, completedView: AgentLoopRunViewSchema, unknownView: AgentLoopRunViewSchema,
  commandContext: TenantContextSchema, pendingInput: PrepareAgentCommandSchema, succeededInput: PrepareAgentCommandSchema,
  pending: AgentCommandViewSchema, succeeded: AgentCommandViewSchema, pendingReceipt: AgentCommandReceiptSchema, succeededReceipt: AgentCommandReceiptSchema,
  unknownQueueJobId: z.string().min(1), originalModelCalls: z.int().positive() }).strict();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const withoutEphemeralConfirmation = (value: z.infer<typeof AgentCommandViewSchema>) => {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["confirmationToken", "confirmationExpiresAt"].includes(key)));
};

describe.sequential("genuine173 read loop and original command history remain independent from planning", () => {
  let child: InvoiceProcess | undefined, queue: ReturnType<typeof createQueue> | undefined, loop: ReturnType<typeof agentLoopFixture> | undefined;
  afterAll(async () => {
    const errors: unknown[] = [];
    try { if (child && child.child.exitCode === null) await child.stop(true); } catch (error) { errors.push(error); }
    try { await queue?.close(); } catch (error) { errors.push(error); }
    try { loop?.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Agent planning genuine173 teardown failed");
  });

  it("preserves every original173 column read-only-v1 checkpoint native command and unknown budget with zero plan backfill or repeated paid submission", async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url)), prefix = resolve(root, "docs/project-control/checkpoints/2026-10-22-agent-plan-b41e0c72");
    const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(source.sha256).toBe("b815000651e107b04305b2bd996e0aa0714ab1924565d577e16d5d963a2e9cbf"); expect(source.files).toHaveLength(3194);
    const manifest = JSON.parse(await readFile(prefix + "-old173-source.json", "utf8")) as { operation: string; sourceSha256: string; files: number; links: unknown[];
      allBaselineBytesVerified: boolean; workspaceDependenciesPinned: boolean; newAgentPlanExportReachable: boolean };
    expect(manifest).toMatchObject({ operation: "b41e0c72", sourceSha256: source.sha256, files: 3194,
      allBaselineBytesVerified: true, workspaceDependenciesPinned: true, newAgentPlanExportReachable: false }); expect(manifest.links).toHaveLength(350);
    const verify = async () => { await assertAgentPlanOriginal173Graph(target.root);
      for (const file of source.files) expect(sha(await readFile(resolve(target.root, file.path))), file.path).toBe(file.sha256); };
    await verify();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(root, "tools/testing/agent-plan-legacy.mts")], {
      cwd: resolve(target.root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(target.root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_PLAN_LEGACY_CHILD: "173" } }));
    const old = Original.parse(await child.wait("agent.plan.seeded173", undefined, 100_000)); expect(await child.closed).toBe(0);
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(173);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const after = (await readMigrationEvidence(database)).actualRows; expect(after).toHaveLength(174); expect(after.slice(0, 173)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before);
    for (const context of [old.loopContext, old.commandContext]) await withTenant(database.db, context, async tx => {
      expect(await tx.select().from(agentPlanRuns)).toEqual([]); expect(await tx.select().from(agentPlanSteps)).toEqual([]); expect(await tx.select().from(agentPlanItems)).toEqual([]);
    });
    const priorTarget = process.env.E2E_LEGACY_SCHEMA_TARGET; process.env.E2E_LEGACY_SCHEMA_TARGET = "current";
    const vault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist");
    let owners: ReturnType<typeof agentCommandOwners>;
    try { loop = agentLoopFixture(database, { contentVault: vault }); owners = agentCommandOwners(database, { contentVault: vault }); }
    finally { if (priorTarget === undefined) delete process.env.E2E_LEGACY_SCHEMA_TARGET; else process.env.E2E_LEGACY_SCHEMA_TARGET = priorTarget; }
    expect(await loop.service().get(old.loopContext, old.completedView.id)).toEqual(old.completedView);
    expect(await loop.service().get(old.loopContext, old.unknownView.id)).toEqual(old.unknownView);
    const pending = await owners.service().get(old.commandContext, old.pending.id);
    expect(withoutEphemeralConfirmation(pending)).toEqual(withoutEphemeralConfirmation(old.pending));
    expect(Boolean(pending.confirmationToken)).toBe(true);
    expect(await owners.service().get(old.commandContext, old.succeeded.id)).toEqual(old.succeeded);
    expect(await owners.service().receipt(old.commandContext, { requestId: old.pendingInput.requestId, requestChecksum: old.pendingReceipt.requestChecksum })).toEqual(old.pendingReceipt);
    expect(await owners.service().receipt(old.commandContext, { requestId: old.succeededInput.requestId, requestChecksum: old.succeededReceipt.requestChecksum })).toEqual(old.succeededReceipt);
    expect(await checkpoint.snapshot()).toEqual(before);
    const ledger = await withTenant(database.db, old.loopContext, tx => tx.select().from(aiBudgetLedger));
    queue = createQueue(QueueName.AgentLoop, process.env.E2E_DISPOSABLE_REDIS_URL);
    const job = await queue.getJob(old.unknownQueueJobId); if (!job) throw new Error("Actual original173 Redis unknown intent missing");
    expect(JobEnvelopeSchema.parse(job.data).payload).toMatchObject({ runId: old.unknownView.id, operation: "execute" });
    await loop.runtime().process(old.loopContext, old.unknownView.id);
    expect(loop.modelCalls).toHaveLength(0); expect(loop.readCalls).toHaveLength(0);
    expect(await loop.service().get(old.loopContext, old.unknownView.id)).toEqual(old.unknownView);
    expect(await withTenant(database.db, old.loopContext, tx => tx.select().from(aiBudgetLedger))).toEqual(ledger);
    expect(await checkpoint.snapshot()).toEqual(before); await verify();
  });
});
