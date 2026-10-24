import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TenantContextSchema } from "@yummyai/contracts";
import { AgentNativeV2ViewSchema, CreateAgentNativeV2Schema } from "@yummyai/contracts/ai/agent-native-v2";
import { AGENT_FULFILLMENT_TOOL } from "@yummyai/contracts/ai/agent-fulfillment";
import { AgentCommandViewSchema, AgentCommandReceiptSchema, PrepareAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence } from "@yummyai/database";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { requireAgentNativeV3LegacyEnvironment, assertAgentNativeV3Original176Graph } from "../../../../tools/testing/agent-native-v3-legacy-upgrade.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

const target = requireAgentNativeV3LegacyEnvironment(process.env, "pre-0177"), database = connectDatabase(target.url), root = fileURLToPath(new URL("../../../../", import.meta.url));
const Original = z.object({ type: z.literal("agent.native.v3.seeded176"), context: TenantContextSchema,
  natives: z.array(z.object({ state: z.enum(["completed", "queued", "response_ready", "uncertain"]), input: CreateAgentNativeV2Schema, view: AgentNativeV2ViewSchema,
    queueJobId: z.string().min(1) }).strict()).length(4), commandContext: TenantContextSchema, preparedInput: PrepareAgentCommandSchema,
  prepared: AgentCommandViewSchema, preparedReceipt: AgentCommandReceiptSchema, originalModelCalls: z.int().positive() }).strict();
const Recovered = z.object({ type: z.literal("agent.native.v3.recovered176"), completedView: AgentNativeV2ViewSchema, uncertainView: AgentNativeV2ViewSchema,
  receivedView: AgentNativeV2ViewSchema, queuedView: AgentNativeV2ViewSchema, command: AgentCommandViewSchema, commandReceipt: AgentCommandReceiptSchema,
  modelCalls: z.object({ afterUnknown: z.int().nonnegative(), afterReceived: z.int().nonnegative(), afterQueued: z.int().nonnegative(), afterReplays: z.int().nonnegative() }).strict(),
  unknownRows: z.object({ before: z.string().length(64), after: z.string().length(64) }).strict(), replayRows: z.object({ before: z.string().length(64), after: z.string().length(64) }).strict(),
  responseChecksum: z.object({ before: z.string().length(64), after: z.string().length(64) }).strict(), unknownLedger: z.object({ state: z.string(), amountUsd: z.string() }).strict(),
  versions: z.array(z.string()), originalJobs: z.array(z.object({ id: z.string(), runId: z.uuidv7(), tenantId: z.uuidv7(), requestedBy: z.uuidv7() }).strict()).length(5),
}).strict();
const SeedFailure = z.object({ type: z.literal("agent.native.v3.failed"), phase: z.string().regex(/^original176_[a-z_]+$/),
  code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/).nullable(),
  errorName: z.enum(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError", "ConflictException",
    "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException", "UnauthorizedException"]),
  location: z.object({ file: z.string().regex(/^(?:(?:apps|packages|tools)\/|tmp\/agent-native-v3-20261022-3f7a21d8\/old176-source\/(?:apps|packages|tools)\/)[A-Za-z0-9_./-]+\.[cm]?[jt]sx?$/)
    .refine(value => !value.split("/").includes("..")), line: z.int().positive() }).strict().nullable(),
}).strict();
const stableCommand = (value: z.infer<typeof AgentCommandViewSchema>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["confirmationToken", "confirmationExpiresAt"].includes(key)));
type StartupDiagnostic = Pick<z.infer<typeof SeedFailure>, "code" | "location">;
const startupDiagnostics = new WeakMap<InvoiceProcess, StartupDiagnostic>();
/** Retain only whitelisted startup codes and workspace file/line locations.
 * Raw stderr, source excerpts, messages, SQL and environment are not retained. */
function startupDiagnostic(chunk: string, diagnostic: StartupDiagnostic) {
  const code = /\b(ERR_[A-Z0-9_]{1,64}|MODULE_NOT_FOUND|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b/.exec(chunk)?.[1];
  if (code) diagnostic.code ??= code;
  if (diagnostic.location) return;
  for (const match of chunk.matchAll(/((?:file:\/\/\/)?[A-Za-z]:[\\/][^()\r\n]*?\.[cm]?[jt]sx?):([1-9][0-9]*)(?::[0-9]+)?(?=\)?(?:\r?\n|$))/g)) {
    try {
      const absolute = match[1]!.startsWith("file:") ? fileURLToPath(match[1]!) : match[1]!, file = relative(root, absolute).replaceAll("\\", "/"), line = Number(match[2]);
      if (!isAbsolute(file) && !file.startsWith("../") && /^(?:(?:apps|packages|tools)\/|tmp\/agent-native-v3-20261022-3f7a21d8\/old176-source\/(?:apps|packages|tools)\/)[A-Za-z0-9_./-]+\.[cm]?[jt]sx?$/.test(file)
        && Number.isSafeInteger(line) && line > 0) { diagnostic.location = { file, line }; break; }
    } catch { /* Unrecognized locations never become retained diagnostics. */ }
  }
}
async function message(child: InvoiceProcess, type: "agent.native.v3.seeded176" | "agent.native.v3.recovered176") {
  try { const result = await child.wait(type, undefined, 180_000); if (await child.closed !== 0) throw new Error("Original176 child exit was not zero"); return result; }
  catch { const parsed = SeedFailure.safeParse(child.events.findLast(event => event.type === "agent.native.v3.failed"));
    const startup = startupDiagnostics.get(child);
    const failure = parsed.success ? parsed.data : { phase: startup?.code || startup?.location ? "original176_startup" : "original176_unhandled",
      code: startup?.code ?? null, errorName: "Error", location: startup?.location ?? null };
    throw new Error("Original176 child failed " + JSON.stringify({ phase: failure.phase, code: failure.code, errorName: failure.errorName, location: failure.location, exitCode: child.child.exitCode })); }
}
function spawnChild(kind: "176" | "recover176", cwd: string) {
  const processChild = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href, resolve(root, "tools/testing/agent-native-v3-legacy-upgrade.mts")], {
    cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(cwd, "tsconfig.json"),
      E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_NATIVE_V3_LEGACY_CHILD: kind },
  }), child = observeInvoiceProcess(processChild), diagnostic: StartupDiagnostic = { code: null, location: null };
  startupDiagnostics.set(child, diagnostic); processChild.stderr?.on("data", (value: Buffer) => { startupDiagnostic(value.toString("utf8"), diagnostic); });
  return child;
}

describe.sequential("genuine176 eleven-reader history and paid recovery after independent v3 migration", () => {
  let seed: InvoiceProcess | undefined, recovery: InvoiceProcess | undefined;
  afterAll(async () => { const errors: unknown[] = [];
    for (const child of [seed, recovery]) try { if (child && child.child.exitCode === null) await child.stop(true); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV3 genuine176 upgrade cleanup failed");
  });

  it("preserves exact176 columns four real V2 paid states prepared original and Redis jobs then restores only their historical protocol", async () => {
    await assertAgentNativeV3Original176Graph(target.root);
    seed = spawnChild("176", resolve(target.root, "apps/api")); const original = Original.parse(await message(seed, "agent.native.v3.seeded176"));
    expect(new Set(original.natives.map(value => value.state))).toEqual(new Set(["completed", "queued", "response_ready", "uncertain"]));
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(176);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const current = (await readMigrationEvidence(database)).actualRows; expect(current).toHaveLength(177); expect(current.slice(0, 176)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before); await assertAgentNativeV3Original176Graph(target.root);
    recovery = spawnChild("recover176", resolve(root, "apps/api"));
    await recovery.wait("agent.native.v3.recovery.ready", undefined, 30_000);
    const { context, natives, commandContext, prepared, preparedReceipt } = original;
    recovery.child.send({ context, natives, commandContext, prepared, preparedReceipt });
    const result = Recovered.parse(await message(recovery, "agent.native.v3.recovered176"));
    expect(result.completedView).toEqual(original.natives.find(value => value.state === "completed")!.view);
    expect(result.uncertainView).toEqual(original.natives.find(value => value.state === "uncertain")!.view);
    expect(stableCommand(result.command)).toEqual(stableCommand(original.prepared)); expect(result.commandReceipt).toEqual(original.preparedReceipt);
    expect(result.modelCalls).toEqual({ afterUnknown: 0, afterReceived: 0, afterQueued: 1, afterReplays: 1 });
    expect(result.unknownRows.after).toBe(result.unknownRows.before); expect(result.replayRows.after).toBe(result.replayRows.before);
    expect(result.responseChecksum.after).toBe(result.responseChecksum.before); expect(result.unknownLedger).toEqual({ state: "reserved", amountUsd: "1.000000" });
    expect(result.receivedView).toMatchObject({ version: "erp-agent-native-v2", status: "completed", cost: { modelTurns: 1, knownCostUsd: "0.000210" } });
    expect(result.queuedView).toMatchObject({ version: "erp-agent-native-v2", status: "completed", items: [] });
    expect(result.versions.every(version => version === "erp-agent-native-v2")).toBe(true);
    for (const job of result.originalJobs) { expect(job.tenantId).toBe(context.tenantId); expect(job.requestedBy).toBe(context.userId);
      expect(natives.some(value => value.view.id === job.runId && value.queueJobId === job.id)).toBe(true); }
    for (const view of [result.completedView, result.receivedView, result.queuedView]) {
      expect(view.bindings.map(binding => String(binding.tool)).includes(AGENT_FULFILLMENT_TOOL)).toBe(false);
      expect(Object.keys(view.readContracts!)).toEqual(["legacy", "resources"]);
    }
  }, 300_000);
});
