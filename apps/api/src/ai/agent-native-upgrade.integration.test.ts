import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { TenantContextSchema } from "@yummyai/contracts";
import { AGENT_NATIVE_VERSION } from "@yummyai/contracts/ai/agent-native";
import { AgentPlanViewSchema, CreateAgentPlanSchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentCommandViewSchema, AgentCommandReceiptSchema, PrepareAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { agentPlanRuns, agentPlanSteps, agentPlanItems, aiBudgetLedger, connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent,
  readMigrationEvidence, withTenant } from "@yummyai/database";
import { createQueue, QueueName, JobEnvelopeSchema } from "@yummyai/jobs";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { requireAgentNativeLegacyEnvironment, assertAgentNativeOriginal174Graph } from "../../../../tools/testing/agent-native-legacy-upgrade.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { agentPlanFixture } from "./agent-plan.test-fixture.js";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";

const target = requireAgentNativeLegacyEnvironment(process.env, "pre-0175"), database = connectDatabase(target.url);
const Original = z.object({ type: z.literal("agent.native.seeded174"), context: TenantContextSchema,
  plans: z.array(z.object({ state: z.enum(["completed", "queued", "response_ready", "uncertain"]), input: CreateAgentPlanSchema, view: AgentPlanViewSchema,
    queueJobId: z.string().nullable() }).strict()).length(4), commandContext: TenantContextSchema, preparedInput: PrepareAgentCommandSchema,
  prepared: AgentCommandViewSchema, preparedReceipt: AgentCommandReceiptSchema, originalModelCalls: z.int().positive() }).strict();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const withoutEphemeralConfirmation = (value: z.infer<typeof AgentCommandViewSchema>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["confirmationToken", "confirmationExpiresAt"].includes(key)));

describe.sequential("genuine174 planning rows remain independently authentic after native protocol175", () => {
  let child: InvoiceProcess | undefined, queue: ReturnType<typeof createQueue> | undefined, fixture: ReturnType<typeof agentPlanFixture> | undefined;
  afterAll(async () => {
    const errors: unknown[] = [];
    try { if (child && child.child.exitCode === null) await child.stop(true); } catch (error) { errors.push(error); }
    try { await queue?.close(); } catch (error) { errors.push(error); }
    try { fixture?.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native Agent original174 upgrade teardown failed");
  });

  it("preserves every actual174 column four native runtime states original preparation and v1 receipts with zero new-version backfill or repeated unknown submission", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-22-agent-native-a72d5e31");
    const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(source.files).toHaveLength(3245); expect(source.sha256).toBe("469e6224f1f8c73794e43fbb7ebb9bd228dacbcdec1afeeb1e3a550f0d7cbdcc");
    const verify = async () => {
      await assertAgentNativeOriginal174Graph(target.root);
      for (const file of source.files) expect(sha(await readFile(resolve(target.root, file.path))), file.path).toBe(file.sha256);
    };
    await verify();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/agent-native-legacy-upgrade.mts")], {
      cwd: resolve(target.root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1",
        TSX_TSCONFIG_PATH: resolve(target.root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_NATIVE_LEGACY_CHILD: "174" } }));
    const old = Original.parse(await child.wait("agent.native.seeded174", undefined, 120_000)); expect(await child.closed).toBe(0);
    expect(new Set(old.plans.map(run => run.state))).toEqual(new Set(["completed", "queued", "response_ready", "uncertain"]));
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(174);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const after = (await readMigrationEvidence(database)).actualRows; expect(after).toHaveLength(175); expect(after.slice(0, 174)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before);
    const existing = await withTenant(database.db, old.context, async tx => ({ runs: await tx.select().from(agentPlanRuns), steps: await tx.select().from(agentPlanSteps), items: await tx.select().from(agentPlanItems), ledgers: await tx.select().from(aiBudgetLedger) }));
    expect(existing.runs.filter(run => run.version === AGENT_NATIVE_VERSION)).toEqual([]);
    for (const original of old.plans) {
      const row = existing.runs.find(run => run.id === original.view.id); if (!row) throw new Error("Genuine old174 parent missing");
      expect(row.version).toBe("erp-agent-plan-v1"); expect(row.requestId).toBe(original.input.requestId); expect(row.requestChecksum).toBe(original.view.requestChecksum);
      if (original.state === "response_ready") expect(existing.steps.filter(step => step.runId === row.id).at(-1)).toMatchObject({ phase: "response_ready", submissionState: "received", costUsd: "0.000210" });
    }
    const priorTarget = process.env.E2E_LEGACY_SCHEMA_TARGET;
    try {
      // The actual database has now migrated successfully; only its descriptive
      // target changes. Every isolation/resource opt-in remains untouched.
      process.env.E2E_LEGACY_SCHEMA_TARGET = "current";
      fixture = agentPlanFixture(database, { contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist") });
    } finally { if (priorTarget === undefined) delete process.env.E2E_LEGACY_SCHEMA_TARGET; else process.env.E2E_LEGACY_SCHEMA_TARGET = priorTarget; }
    const f = fixture;
    for (const original of old.plans.filter(run => run.state === "completed" || run.state === "uncertain")) {
      expect(await f.service().get(old.context, original.view.id)).toEqual(original.view);
      expect(await f.service().receipt(old.context, { requestId: original.input.requestId, requestChecksum: original.view.requestChecksum }))
        .toMatchObject({ disposition: "known", runId: original.view.id, status: original.view.status, privateAvailable: original.view.privateAvailable });
    }
    const prepared = await f.owners.service().get(old.commandContext, old.prepared.id);
    expect(withoutEphemeralConfirmation(prepared)).toEqual(withoutEphemeralConfirmation(old.prepared)); expect(Boolean(prepared.confirmationToken)).toBe(true);
    expect(await f.owners.service().receipt(old.commandContext, { requestId: old.preparedInput.requestId, requestChecksum: old.preparedReceipt.requestChecksum })).toEqual(old.preparedReceipt);
    expect(await checkpoint.snapshot()).toEqual(before);
    queue = createQueue(QueueName.AgentPlan, process.env.E2E_DISPOSABLE_REDIS_URL);
    const unknown = old.plans.find(run => run.state === "uncertain")!, queued = old.plans.find(run => run.state === "queued")!, received = old.plans.find(run => run.state === "response_ready")!;
    for (const original of [queued, unknown]) {
      if (!original.queueJobId) throw new Error("Original174 Redis intent ID missing");
      const job = await queue.getJob(original.queueJobId); if (!job) throw new Error("Actual original174 Redis job absent");
      expect(JobEnvelopeSchema.parse(job.data)).toMatchObject({ tenantId: old.context.tenantId, requestedBy: old.context.userId, payload: { runId: original.view.id, operation: "execute" } });
    }
    const processor = new AgentPlanProcessor(agentPlanRuntimeRouter(database, f.runtime(), {
      async process() { throw new Error("agent_native_router_misrouted_legacy"); }
    })), runOriginal = async (value: typeof queued) => {
      if (!value.queueJobId) throw new Error("Actual old174 queued envelope ID missing");
      const job = await queue!.getJob(value.queueJobId); if (!job) throw new Error("Original174 queued envelope missing");
      return processor.process(JobEnvelopeSchema.parse(job.data));
    };
    const beforeUnknown = await f.rows(old.context); await runOriginal(unknown);
    expect(f.modelCalls).toHaveLength(0); expect(f.readCalls).toHaveLength(0); expect(await f.rows(old.context)).toEqual(beforeUnknown);
    const receivedRow = existing.runs.find(run => run.id === received.view.id)!;
    await withTenant(database.db, old.context, tx => tx.execute(sql`update agent_plan_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${receivedRow.id}::uuid`));
    await runOriginal(received);
    expect(f.modelCalls).toHaveLength(0); expect(await f.service().get(old.context, received.view.id)).toMatchObject({ version: "erp-agent-plan-v1", status: "completed", cost: { knownCostUsd: "0.000210" } });
    await runOriginal(queued); expect(f.modelCalls).toHaveLength(1);
    expect(await f.service().get(old.context, queued.view.id)).toMatchObject({ version: "erp-agent-plan-v1", status: "completed", items: [] });
    const stable = await f.rows(old.context); await f.runtime().process(old.context, queued.view.id); await f.runtime().process(old.context, received.view.id);
    expect(f.modelCalls).toHaveLength(1); expect(await f.rows(old.context)).toEqual(stable);
    expect(stable.runs.filter(run => run.version === AGENT_NATIVE_VERSION)).toEqual([]);
    for (const original of old.plans.filter(run => run.state === "completed" || run.state === "uncertain"))
      expect(stable.runs.find(row => row.id === original.view.id)).toEqual(existing.runs.find(row => row.id === original.view.id));
    await verify();
  }, 180_000);
});
