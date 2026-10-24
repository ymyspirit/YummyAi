import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { TenantContextSchema } from "@yummyai/contracts";
import { AgentNativeViewSchema, CreateAgentNativeSchema } from "@yummyai/contracts/ai/agent-native";
import { AGENT_NATIVE_V2_VERSION } from "@yummyai/contracts/ai/agent-native-v2";
import { AgentCommandViewSchema, AgentCommandReceiptSchema, PrepareAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence, withTenant } from "@yummyai/database";
import { createQueue, QueueName, JobEnvelopeSchema } from "@yummyai/jobs";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { requireAgentNativeV2LegacyEnvironment, assertAgentNativeV2Original175Graph } from "../../../../tools/testing/agent-native-v2-legacy-upgrade.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { agentNativeFixture, finishNative } from "./agent-native.test-fixture.js";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";

const target = requireAgentNativeV2LegacyEnvironment(process.env, "pre-0176"), database = connectDatabase(target.url);
const Original = z.object({ type: z.literal("agent.native.v2.seeded175"), context: TenantContextSchema,
  natives: z.array(z.object({ state: z.enum(["completed", "queued", "response_ready", "uncertain"]), input: CreateAgentNativeSchema, view: AgentNativeViewSchema,
    queueJobId: z.string() }).strict()).length(4), commandContext: TenantContextSchema, preparedInput: PrepareAgentCommandSchema,
  prepared: AgentCommandViewSchema, preparedReceipt: AgentCommandReceiptSchema, originalModelCalls: z.int().positive() }).strict();
const stableCommand = (value: z.infer<typeof AgentCommandViewSchema>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["confirmationToken", "confirmationExpiresAt"].includes(key)));
const SeedFailure = z.object({ type: z.literal("agent.native.v2.failed"),
  phase: z.enum(["original175_entry", "original175_environment", "original175_parent", "original175_graph", "original175_imports", "original175_schema",
    "original175_initialize", "original175_sources", "original175_real_read_model_preparation", "original175_completed_receipt", "original175_submitted_unknown",
    "original175_received_before_adoption", "original175_seeded_receipt", "original175_cleanup", "original175_unhandled"]),
  code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/).nullable(),
  errorName: z.enum(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError", "ConflictException",
    "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException", "UnauthorizedException"]),
  location: z.object({ file: z.string().regex(/^(?:(?:apps|packages|tools)\/|tmp\/agent-native-v2-20261022-5c82e6b4\/old175-source\/(?:apps|packages|tools)\/)[A-Za-z0-9_./-]+\.[cm]?[jt]sx?$/)
    .refine(value => !value.split("/").includes("..")), line: z.int().positive() }).strict().nullable(),
}).strict();
async function original175Seed(child: InvoiceProcess) {
  try {
    const packet = await child.wait("agent.native.v2.seeded175", undefined, 120_000);
    if (await child.closed !== 0) throw new Error("Original175 child did not finish successfully");
    return packet;
  } catch {
    const parsed = SeedFailure.safeParse(child.events.findLast(event => event.type === "agent.native.v2.failed"));
    const failure = parsed.success ? parsed.data : { phase: "original175_unhandled", code: null, errorName: "Error", location: null };
    throw new Error("Original175 seed failed " + JSON.stringify({ phase: failure.phase, code: failure.code, errorName: failure.errorName,
      location: failure.location, exitCode: child.child.exitCode }));
  }
}

describe.sequential("genuine175 native-v1 data and paid recovery after v2 migration", () => {
  let child: InvoiceProcess | undefined, queue: ReturnType<typeof createQueue> | undefined, fixture: ReturnType<typeof agentNativeFixture> | undefined;
  afterAll(async () => { const errors: unknown[] = [];
    try { if (child && child.child.exitCode === null) await child.stop(true); } catch (error) { errors.push(error); }
    try { await queue?.close(); } catch (error) { errors.push(error); }
    try { fixture?.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV2 real175 upgrade teardown failed");
  });

  it("preserves actual175 columns original five-reader pins four paid states and prepared command then restores original Redis jobs without v2 backfill", async () => {
    await assertAgentNativeV2Original175Graph(target.root);
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(root, "tools/testing/agent-native-v2-legacy-upgrade.mts")], {
      cwd: resolve(target.root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1",
        TSX_TSCONFIG_PATH: resolve(target.root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_NATIVE_V2_LEGACY_CHILD: "175" } }));
    const old = Original.parse(await original175Seed(child));
    expect(new Set(old.natives.map(value => value.state))).toEqual(new Set(["completed", "queued", "response_ready", "uncertain"]));
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(175);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const migrated = (await readMigrationEvidence(database)).actualRows; expect(migrated).toHaveLength(176); expect(migrated.slice(0, 175)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before); await assertAgentNativeV2Original175Graph(target.root);
    const prior = process.env.E2E_LEGACY_SCHEMA_TARGET;
    try { process.env.E2E_LEGACY_SCHEMA_TARGET = "current";
      fixture = agentNativeFixture(database, { contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist") });
    } finally { if (prior === undefined) delete process.env.E2E_LEGACY_SCHEMA_TARGET; else process.env.E2E_LEGACY_SCHEMA_TARGET = prior; }
    const f = fixture; f.controls.decision = packet => finishNative(packet);
    for (const original of old.natives.filter(value => ["completed", "uncertain"].includes(value.state))) {
      expect(await f.service().get(old.context, original.view.id)).toEqual(original.view);
      expect(await f.service().receipt(old.context, { requestId: original.input.requestId, requestChecksum: original.view.requestChecksum }))
        .toMatchObject({ disposition: "known", runId: original.view.id, status: original.view.status });
    }
    expect(stableCommand(await f.owners.service().get(old.commandContext, old.prepared.id))).toEqual(stableCommand(old.prepared));
    expect(await f.owners.service().receipt(old.commandContext, { requestId: old.preparedInput.requestId, requestChecksum: old.preparedReceipt.requestChecksum })).toEqual(old.preparedReceipt);
    expect(await checkpoint.snapshot()).toEqual(before);
    queue = createQueue(QueueName.AgentPlan, process.env.E2E_DISPOSABLE_REDIS_URL);
    const processor = new AgentPlanProcessor(agentPlanRuntimeRouter(database, f.prior.runtime(), f.runtime(), { async process() { throw new Error("native_v2_router_misrouted_genuine_v1"); } }));
    const originalJob = async (value: (typeof old.natives)[number]) => {
      const job = await queue!.getJob(value.queueJobId); if (!job) throw new Error("Actual original175 Redis job missing");
      const envelope = JobEnvelopeSchema.parse(job.data); expect(envelope).toMatchObject({ tenantId: old.context.tenantId, requestedBy: old.context.userId, payload: { runId: value.view.id, operation: "execute" } });
      return processor.process(envelope);
    };
    const unknown = old.natives.find(value => value.state === "uncertain")!, received = old.natives.find(value => value.state === "response_ready")!, queued = old.natives.find(value => value.state === "queued")!;
    const stable = await f.rows(old.context); await originalJob(unknown); expect(f.modelCalls).toHaveLength(0); expect(await f.rows(old.context)).toEqual(stable);
    await withTenant(database.db, old.context, tx => tx.execute(sql`update agent_plan_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${received.view.id}::uuid`));
    await originalJob(received); expect(f.modelCalls).toHaveLength(0);
    expect(await f.service().get(old.context, received.view.id)).toMatchObject({ version: "erp-agent-native-v1", status: "completed", cost: { modelTurns: 1, knownCostUsd: "0.000210" } });
    await originalJob(queued); expect(f.modelCalls).toHaveLength(1);
    expect(await f.service().get(old.context, queued.view.id)).toMatchObject({ version: "erp-agent-native-v1", status: "completed", items: [] });
    const after = await f.rows(old.context); await originalJob(received); await originalJob(queued); expect(await f.rows(old.context)).toEqual(after); expect(f.modelCalls).toHaveLength(1);
    expect(after.runs.filter(value => value.version === AGENT_NATIVE_V2_VERSION)).toEqual([]);
    expect(after.runs.find(value => value.id === unknown.view.id)?.capUsd).toBe("1.000000");
    expect(after.ledgers.find(value => value.requestId === unknown.view.id)).toMatchObject({ state: "reserved", amountUsd: "1.000000" });
  }, 180_000);
});
