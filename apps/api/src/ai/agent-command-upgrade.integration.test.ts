import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { TenantContextSchema } from "@yummyai/contracts";
import { AgentLoopRunViewSchema, CreateAgentLoopSchema } from "@yummyai/contracts/ai/agent-loop";
import { ProcurementCommandViewSchema } from "@yummyai/contracts/procurement/procurement-command";
import { agentCommandRequests, aiBudgetLedger, connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence, withTenant } from "@yummyai/database";
import { createQueue, QueueName, JobEnvelopeSchema } from "@yummyai/jobs";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { assertAgentCommandOriginal172Graph, requireAgentCommandLegacyEnvironment } from "../../../../tools/testing/agent-command-legacy.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { agentLoopFixture } from "./agent-loop.test-fixture.js";
import { ProcurementCommandService } from "../procurement/procurement-command.service.js";
import { procurementCommandFixture } from "../procurement/procurement-command.fixtures.js";
import { createProcurementCommandVault } from "../procurement/procurement-command-vault.js";

const target = requireAgentCommandLegacyEnvironment(process.env, "pre-0173"), database = connectDatabase(target.url);
const Original = z.object({ type: z.literal("agent.command.seeded172"), loopContext: TenantContextSchema, completedInput: CreateAgentLoopSchema,
  unknownInput: CreateAgentLoopSchema, completedView: AgentLoopRunViewSchema, unknownView: AgentLoopRunViewSchema,
  commandContext: TenantContextSchema, pending: ProcurementCommandViewSchema, succeeded: ProcurementCommandViewSchema,
  unknownQueueJobId: z.string().min(1), originalModelCalls: z.int().positive() }).strict();
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.sequential("genuine172 originals remain outside future173 Agent write coordination", () => {
  let child: InvoiceProcess | undefined, queue: ReturnType<typeof createQueue> | undefined, loop: ReturnType<typeof agentLoopFixture> | undefined;
  afterAll(async () => {
    const failures: unknown[] = [];
    try { if (child && child.child.exitCode === null) await child.stop(true); } catch (error) { failures.push(error); }
    try { await queue?.close(); } catch (error) { failures.push(error); }
    try { loop?.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Agent command genuine172 teardown failed");
  });
  it("preserves all original172 columns receipts and unknown budgets with zero confirmation backfill and no repeated paid submission", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-22-agent-command-6f2d9a84");
    const beforeSource = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(beforeSource.sha256).toBe("931537fff79db1198b478f7d10ccf5a83146a78db6c538ffcfc49a0c57685a5c"); expect(beforeSource.files).toHaveLength(3169);
    const verify = async () => { await assertAgentCommandOriginal172Graph(target.root);
      for (const file of beforeSource.files) expect(sha(await readFile(resolve(target.root, file.path))), file.path).toBe(file.sha256); };
    await verify();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/agent-command-legacy.mts")], {
      cwd: resolve(target.root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(target.root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_COMMAND_LEGACY_CHILD: "172" } }));
    const old = Original.parse(await child.wait("agent.command.seeded172", undefined, 100_000)); expect(await child.closed).toBe(0);
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(172);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const after = (await readMigrationEvidence(database)).actualRows; expect(after).toHaveLength(173); expect(after.slice(0, 172)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before);
    for (const context of [old.loopContext, old.commandContext]) expect(await withTenant(database.db, context, tx => tx.select().from(agentCommandRequests))).toEqual([]);
    // The fixture factory is not initialized: it supplies current real readers,
    // with the same fixed content key, without creating any replacement identity.
    const environment = { ...process.env, E2E_LEGACY_SCHEMA_TARGET: "current" };
    const prior = process.env.E2E_LEGACY_SCHEMA_TARGET; process.env.E2E_LEGACY_SCHEMA_TARGET = environment.E2E_LEGACY_SCHEMA_TARGET;
    let commands: ProcurementCommandService;
    try {
      loop = agentLoopFixture(database, { contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist") });
      const source = procurementCommandFixture(database);
      commands = new ProcurementCommandService(database, createProcurementCommandVault(), source.owner, source.audit);
    } finally { if (prior === undefined) delete process.env.E2E_LEGACY_SCHEMA_TARGET; else process.env.E2E_LEGACY_SCHEMA_TARGET = prior; }
    expect(await loop.service().get(old.loopContext, old.completedView.id)).toEqual(old.completedView);
    expect(await loop.service().get(old.loopContext, old.unknownView.id)).toEqual(old.unknownView);
    expect(await commands.get(old.commandContext, old.pending.id)).toEqual(old.pending);
    expect(await commands.get(old.commandContext, old.succeeded.id)).toEqual(old.succeeded);
    expect(await checkpoint.snapshot()).toEqual(before);
    const ledger = await withTenant(database.db, old.loopContext, tx => tx.select().from(aiBudgetLedger));
    queue = createQueue(QueueName.AgentLoop, process.env.E2E_DISPOSABLE_REDIS_URL);
    const job = await queue.getJob(old.unknownQueueJobId); if (!job) throw new Error("Original172 real Redis unknown intent missing");
    expect(JobEnvelopeSchema.parse(job.data).payload).toMatchObject({ runId: old.unknownView.id, operation: "execute" });
    await loop.runtime().process(old.loopContext, old.unknownView.id);
    expect(loop.modelCalls).toHaveLength(0); expect(loop.readCalls).toHaveLength(0);
    expect(await loop.service().get(old.loopContext, old.unknownView.id)).toEqual(old.unknownView);
    expect(await withTenant(database.db, old.loopContext, tx => tx.select().from(aiBudgetLedger))).toEqual(ledger);
    expect(await checkpoint.snapshot()).toEqual(before); await verify();
  });
});
