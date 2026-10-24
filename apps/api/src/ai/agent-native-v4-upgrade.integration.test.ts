import "reflect-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { AgentNativeV3ViewSchema, AgentNativeV3ReceiptSchema, AgentNativeV3ItemReceiptSchema,
  CreateAgentNativeV3Schema, PrepareAgentNativeV3ItemSchema } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_NATIVE_V4_VERSION, AgentNativeV4ItemReceiptSchema } from "@yummyai/contracts/ai/agent-native-v4";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AgentFulfillmentCommandViewSchema, AgentFulfillmentCommandReceiptSchema,
  PrepareAgentFulfillmentCommandSchema, canonicalAgentFulfillmentOriginal } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { assertAgentNativeV4Original186Graph, requireAgentNativeV4LegacyEnvironment,
  projectAgentNativeV4LegacyFulfillment, projectAgentNativeV4LegacyV3,
  type AgentNativeV4LegacyReferences, type AgentNativeV4LegacyReadRequest } from "../../../../tools/testing/agent-native-v4-legacy.mjs";

const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), entry = fileURLToPath(import.meta.url);
const childMode = process.env.E2E_AGENT_NATIVE_V4_UPGRADE_CURRENT_CHILD;
if (childMode !== undefined && !["read187", "prove187"].includes(childMode)) throw new Error("native4_upgrade_child_mode_invalid");
// Only a child may switch to current. The parent retains its pre-0187 admission
// throughout seed, migration and both generations of original readers.
const isolated = requireAgentNativeV4LegacyEnvironment(process.env, childMode ? "current" : "pre-0187");
const { connectDatabase, withTenant, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent,
  agentPlanItems, orderFulfillmentCommandIntents } = await import("@yummyai/database");
const { sql, eq } = await import("drizzle-orm");
const Hash = z.string().regex(/^[a-f0-9]{64}$/), sha = (value: string) => createHash("sha256").update(value).digest("hex");
function checksum(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new Error("native4_upgrade_snapshot_missing");
  const wire: unknown = JSON.parse(text);
  return sha(canonicalJson(wire));
}
async function bounded<T>(promise: Promise<T>, code: string, milliseconds = 180_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

const PendingSources = z.object({ orderId: EntityIdSchema, productionId: EntityIdSchema, packageId: EntityIdSchema,
  shipmentId: EntityIdSchema, versionId: EntityIdSchema }).strict();
const SucceededSources = z.object({ orderId: EntityIdSchema, productionId: EntityIdSchema, packageId: EntityIdSchema }).strict();
const NativeReference = z.object({ input: CreateAgentNativeV3Schema, runId: EntityIdSchema, itemId: EntityIdSchema,
  prepareLookup: PrepareAgentNativeV3ItemSchema }).strict();
const References = z.object({ context: TenantContextSchema, nativeV3: z.object({ stopped: NativeReference, expired: NativeReference }).strict(),
  fulfillment: z.object({
    pending: z.object({ id: EntityIdSchema, input: PrepareAgentFulfillmentCommandSchema, sourceIds: PendingSources }).strict(),
    succeeded: z.object({ id: EntityIdSchema, input: PrepareAgentFulfillmentCommandSchema, sourceIds: SucceededSources }).strict(),
  }).strict(),
}).strict();
// This is the helper's comparison projection, never a reconstructed executable
// Agent DTO. Reuse each original field schema without inventing a null token.
const shape = AgentFulfillmentCommandViewSchema.shape;
const FulfillmentStable = z.object({ version: shape.version, contextAuthority: shape.contextAuthority, native: shape.native,
  original: shape.original, privateAvailable: shape.privateAvailable, originalChecksum: shape.originalChecksum,
  confirmationDecision: shape.confirmationDecision, canConfirm: shape.canConfirm, canCancel: shape.canCancel, canAcknowledge: shape.canAcknowledge }).strict();
const FulfillmentProjection = z.object({ stable: FulfillmentStable,
  confirmation: z.object({ canConfirm: z.boolean(), hasToken: z.boolean(), decision: shape.confirmationDecision }).strict(),
  receipt: AgentFulfillmentCommandReceiptSchema }).strict();
const NativeProjection = z.object({ view: AgentNativeV3ViewSchema, receipt: AgentNativeV3ReceiptSchema,
  itemReceipt: AgentNativeV3ItemReceiptSchema, prepareReplay: AgentNativeV3ItemReceiptSchema }).strict();
const Snapshot = z.object({ references: References, nativeV3: z.object({ stopped: NativeProjection, expired: NativeProjection }).strict(),
  fulfillment: z.object({ pending: FulfillmentProjection, succeeded: FulfillmentProjection }).strict(),
  counts: z.object({ syntheticModelCalls: z.int().nonnegative(), workerProcesses: z.literal(0), paidProviderCalls: z.literal(0) }).strict(),
  resourcesClosed: z.literal(true) }).strict();
const Seed = Snapshot.extend({ type: z.literal("agent.native_v4.seeded186") }).strict();
const LegacyRead = Snapshot.extend({ type: z.literal("agent.native_v4.read186") }).strict();
const CurrentRead = Snapshot.extend({ type: z.literal("agent.native_v4.read187"), originalPrepareCalls: z.literal(0), originalExecuteCalls: z.literal(0) }).strict();
const CurrentProof = z.object({ type: z.literal("agent.native_v4.proved187"), nonce: z.literal(isolated.nonce),
  runId: EntityIdSchema, itemId: EntityIdSchema, intentId: EntityIdSchema, contractVersion: z.literal(AGENT_FULFILLMENT_COMMAND_VERSION),
  proposalChecksum: Hash, originalChecksum: Hash, completionChecksum: Hash, preparationRequestChecksum: Hash,
  modelRequests: z.literal(4), paidProviderCalls: z.literal(0), workerProcesses: z.literal(0),
  originalPrepareCalls: z.literal(1), originalExecutions: z.literal(0), businessUnchanged: z.literal(true),
  originalSourceBeforeStop: z.literal(true), originalSourceAfterStop: z.literal(false),
  parentStopRefusedConfirm: z.literal(true), originalPrivateCleared: z.literal(true),
  fixtureClosed: z.literal(true), resourcesClosed: z.literal(true) }).strict();
type SnapshotValue = z.infer<typeof Snapshot>;

function finiteFailure(error: unknown, phase: string) {
  let code: string | null = null, current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64})$/.test(current.code)) code ??= current.code;
    if ("message" in current && typeof current.message === "string" && /^native4_upgrade_[a-z0-9_]{1,96}$/.test(current.message)) code ??= current.message;
    if ("getResponse" in current && typeof current.getResponse === "function") {
      try {
        const response: unknown = current.getResponse();
        if (response && typeof response === "object" && "code" in response && typeof response.code === "string"
          && /^agent_[a-z0-9_]{1,96}$/.test(response.code)) code ??= response.code;
      } catch { /* Diagnostics never interrupt the original failure's teardown. */ }
    }
    current = "cause" in current ? current.cause : null;
  }
  return { type: "agent.native_v4.failed187", phase, code,
    errorName: error instanceof Error && /^[A-Za-z]{1,48}$/.test(error.name) ? error.name : "Error" };
}
function ensure(condition: boolean, code: string): asserts condition { if (!condition) throw new Error(code); }
const send = (value: object) => new Promise<void>((done, reject) => {
  if (!process.connected || !process.send) { reject(new Error("native4_upgrade_ipc_closed")); return; }
  process.send(value, error => error ? reject(error) : done());
});
function receiveReferences() {
  let cancel = () => {};
  const result = new Promise<AgentNativeV4LegacyReferences>((done, reject) => {
    const clear = () => { clearTimeout(timer); process.off("message", received); process.off("disconnect", disconnected); };
    cancel = clear;
    const disconnected = () => { clear(); reject(new Error("native4_upgrade_ipc_closed")); };
    const received = (raw: unknown) => {
      const parsed = z.object({ type: z.literal("agent.native_v4.read187.request"), references: References }).strict().safeParse(raw);
      clear();
      if (!parsed.success) { reject(new Error("native4_upgrade_read_input_invalid")); return; }
      done(parsed.data.references);
    };
    const timer = setTimeout(() => { clear(); reject(new Error("native4_upgrade_read_timeout")); }, 180_000);
    process.once("message", received); process.once("disconnect", disconnected);
  });
  void result.catch(() => {});
  return { result, cancel: () => cancel() };
}

async function currentChild(mode: "read187" | "prove187") {
  const connection = connectDatabase(isolated.url), incoming = mode === "read187" ? receiveReferences() : undefined;
  let phase = "environment", failure: unknown, outcome: object | undefined, bytes: Buffer | undefined, close: (() => Promise<void>) | undefined;
  try {
    ensure(process.connected === true && process.env.TSX_DISABLE_CACHE === "1" && process.env.NODE_OPTIONS === ""
      && resolve(process.cwd()) === resolve(workspace, "apps/api")
      && process.env.TSX_TSCONFIG_PATH === resolve(workspace, "apps/api/tsconfig.json"), "native4_upgrade_current_loader_invalid");
    phase = "schema";
    await assertDatabaseMigrationsCurrent(connection);
    ensure((await readMigrationEvidence(connection)).actualRows.length === 187, "native4_upgrade_current_schema_invalid");
    const key = process.env.E2E_AGENT_NATIVE_V4_CONTENT_KEY ?? "";
    bytes = Buffer.from(key, "base64url");
    ensure(/^[A-Za-z0-9_-]{43}$/.test(key) && bytes.length === 32 && bytes.toString("base64url") === key, "native4_upgrade_content_key_invalid");
    if (mode === "read187") {
      phase = "reader_imports";
      const { SecretVault } = await import("@yummyai/ai-core");
      const { agentNativeV3Fixture } = await import("./agent-native-v3.test-fixture.js");
      const { AgentNativeV3Service } = await import("./agent-native-v3.service.js");
      const { OrderFulfillmentCommandOwner } = await import("../orders/order-fulfillment-command-owner.js");
      const { OrderFulfillmentCommandService } = await import("../orders/order-fulfillment-command.service.js");
      const { AgentFulfillmentCommandOwner } = await import("./agent-fulfillment-command-owner.js");
      const { AgentFulfillmentCommandService } = await import("./agent-fulfillment-command.service.js");
      const vault = new SecretVault(bytes), native = agentNativeV3Fixture(connection, { contentVault: vault, orderVault: vault, integrationVault: vault });
      close = () => native.close();
      let originalPrepareCalls = 0, originalExecuteCalls = 0;
      const commands = native.prior.legacy.owners.service(), prepare = commands.prepare.bind(commands);
      commands.prepare = async (...args: Parameters<typeof commands.prepare>) => { originalPrepareCalls++; return prepare(...args); };
      const service = new AgentNativeV3Service(connection, vault, native.prior.legacy.gateway, native.prior.resources.service,
        commands, native.prior.legacy.owners.adapter, native.dispatcher, native.fulfillmentService);
      class ObservedOwner extends OrderFulfillmentCommandOwner {
        override async execute(...args: Parameters<InstanceType<typeof OrderFulfillmentCommandOwner>["execute"]>) { originalExecuteCalls++; await super.execute(...args); }
      }
      const owners = native.fulfillment, original = new OrderFulfillmentCommandService(connection, vault,
        new ObservedOwner(connection, vault, owners.production, owners.delivery, owners.shipping), owners.audit);
      const agent = new AgentFulfillmentCommandService(connection, vault, new AgentFulfillmentCommandOwner(original), owners.audit);
      phase = "reader_wait"; await send({ type: "agent.native_v4.reader187.ready" });
      if (!incoming) throw new Error("native4_upgrade_reader_not_registered");
      const references = await incoming.result, context = references.context;
      const readNative = async (reference: AgentNativeV4LegacyReferences["nativeV3"]["stopped"]) => {
        const view = await service.get(context, reference.runId), receipt = await service.receipt(context,
          { requestId: reference.input.requestId, requestChecksum: view.requestChecksum });
        const itemReceipt = await service.itemReceipt(context, reference.runId, reference.itemId, reference.prepareLookup);
        const prepareReplay = await service.prepareItem(context, reference.runId, reference.itemId, reference.prepareLookup);
        ensure(itemReceipt.disposition === "known" && prepareReplay.disposition === "known"
          && itemReceipt.agentCommandId === prepareReplay.agentCommandId && itemReceipt.ownerCommandId === prepareReplay.ownerCommandId,
        "native4_upgrade_current_replay_invalid");
        return projectAgentNativeV4LegacyV3(view, receipt, itemReceipt, prepareReplay);
      };
      const readFulfillment = async (reference: AgentNativeV4LegacyReferences["fulfillment"]["pending"] | AgentNativeV4LegacyReferences["fulfillment"]["succeeded"]) => {
        const query = { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: reference.input.orderId };
        const view = await agent.get(context, reference.id, query), receipt = await agent.receipt(context, { ...query,
          requestId: reference.input.original.requestId, requestChecksum: sha(canonicalAgentFulfillmentOriginal(reference.input.original)) });
        return { ...projectAgentNativeV4LegacyFulfillment(view), receipt };
      };
      phase = "reader_get";
      outcome = CurrentRead.parse({ type: "agent.native_v4.read187", references,
        nativeV3: { stopped: await readNative(references.nativeV3.stopped), expired: await readNative(references.nativeV3.expired) },
        fulfillment: { pending: await readFulfillment(references.fulfillment.pending), succeeded: await readFulfillment(references.fulfillment.succeeded) },
        counts: { syntheticModelCalls: native.modelCalls.length, workerProcesses: 0, paidProviderCalls: 0 }, resourcesClosed: true,
        originalPrepareCalls, originalExecuteCalls });
    } else {
      phase = "v4_imports";
      const { agentNativeV4Fixture } = await import("./agent-native-v4.test-fixture.js");
      const fixture = agentNativeV4Fixture(connection); close = () => fixture.close();
      await fixture.initialize();
      const context = await fixture.current(), scenario = await fixture.scenario("delivery_feedback"), before = checksum(await fixture.business());
      phase = "v4_proposal";
      const input = await fixture.request(scenario), run = await fixture.service().start(context, input);
      await fixture.process(run.id);
      const view = await fixture.service().get(context, run.id), item = view.items[0];
      ensure(view.status === "completed" && Boolean(item) && fixture.modelCalls.length === 4, "native4_upgrade_actual_proposal_missing");
      if (!item) throw new Error("native4_upgrade_actual_item_missing");
      phase = "v4_prepare";
      const receipt = AgentNativeV4ItemReceiptSchema.parse(await fixture.service().prepareItem(context, view.id, item.id, fixture.prepareInput(view, item, scenario)));
      ensure(receipt.disposition === "known" && receipt.fulfillmentIntentId !== null, "native4_upgrade_actual_original_missing");
      const intentId = receipt.fulfillmentIntentId;
      if (!intentId) throw new Error("native4_upgrade_actual_original_missing");
      const prepared = await fixture.fulfillmentCommands.get(context, intentId, { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: scenario.scene.order.id });
      ensure(prepared.canConfirm && prepared.original !== null && prepared.native.status === "prepared", "native4_upgrade_actual_prepared_missing");
      const [binding] = await withTenant(connection.db, context, tx => tx.select({ protocol: agentPlanItems.originalProtocol,
        orderId: agentPlanItems.originalOrderId, originalChecksum: agentPlanItems.originalChecksum, preparationRequestChecksum: agentPlanItems.preparationRequestChecksum,
        completionChecksum: agentPlanItems.completionChecksum, encryptedCompletion: agentPlanItems.encryptedCompletion,
        fulfillmentIntentId: agentPlanItems.fulfillmentIntentId, boundAt: agentPlanItems.completionBoundAt,
        transactionId: agentPlanItems.completionTransactionId }).from(agentPlanItems).where(eq(agentPlanItems.id, item.id)));
      const [intent] = await withTenant(connection.db, context, tx => tx.select({ version: orderFulfillmentCommandIntents.contractVersion })
        .from(orderFulfillmentCommandIntents).where(eq(orderFulfillmentCommandIntents.id, intentId)));
      ensure(Boolean(binding && binding.protocol === AGENT_FULFILLMENT_COMMAND_VERSION && binding.orderId === scenario.scene.order.id
        && binding.fulfillmentIntentId === intentId && binding.originalChecksum && binding.preparationRequestChecksum && binding.completionChecksum
        && binding.encryptedCompletion && binding.boundAt && binding.transactionId && intent?.version === AGENT_FULFILLMENT_COMMAND_VERSION)
        && new Set([view.id, item.id, intentId]).size === 3 && checksum(await fixture.business()) === before && fixture.calls.confirm === 0,
      "native4_upgrade_actual_binding_invalid");
      const sourceAvailable = async () => {
        const [source] = await withTenant(connection.db, context, tx => tx.execute<{ available: boolean }>(sql`
          select order_fulfillment_command_source_available(command) as available
          from order_fulfillment_command_intents command where command.id=${intentId}::uuid`));
        if (!source) throw new Error("native4_upgrade_original_source_missing");
        return source.available;
      };
      const originalSourceBeforeStop = await sourceAvailable();
      ensure(originalSourceBeforeStop === true, "native4_upgrade_original_source_initially_unavailable");
      phase = "v4_parent_stop";
      const confirmation = fixture.confirmation(prepared);
      await fixture.service().stop(context, view.id, { version: AGENT_NATIVE_V4_VERSION, requestId: view.requestId });
      const originalSourceAfterStop = await sourceAvailable();
      ensure(originalSourceAfterStop === false, "native4_upgrade_original_source_survived_stop");
      let rejected = false;
      try { await fixture.fulfillmentCommands.confirm(context, intentId, confirmation); } catch { rejected = true; }
      const cleared = await fixture.fulfillmentCommands.get(context, intentId, { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: scenario.scene.order.id });
      ensure(rejected && !cleared.privateAvailable && cleared.original === null && cleared.confirmationToken === null
        && cleared.native.summary === null && cleared.native.receipt === null && checksum(await fixture.business()) === before,
      "native4_upgrade_parent_source_not_cleared");
      outcome = CurrentProof.parse({ type: "agent.native_v4.proved187", nonce: isolated.nonce, runId: view.id, itemId: item.id, intentId,
        contractVersion: intent?.version, proposalChecksum: item.proposalChecksum, originalChecksum: binding?.originalChecksum,
        completionChecksum: binding?.completionChecksum, preparationRequestChecksum: binding?.preparationRequestChecksum,
        modelRequests: fixture.modelCalls.length, paidProviderCalls: 0, workerProcesses: 0, originalPrepareCalls: fixture.calls.prepare,
        originalExecutions: fixture.original.calls.execute, businessUnchanged: true, originalSourceBeforeStop, originalSourceAfterStop,
        parentStopRefusedConfirm: true, originalPrivateCleared: true, fixtureClosed: true, resourcesClosed: true });
    }
  } catch (error) { failure = error; await send(finiteFailure(error, phase)).catch(() => {}); }
  incoming?.cancel();
  for (const done of [close, () => connection.client.end()]) try { phase = "cleanup"; await done?.(); }
  catch (error) { failure ??= error; await send(finiteFailure(error, phase)).catch(() => {}); }
  bytes?.fill(0);
  if (failure !== undefined || !outcome) throw new Error("native4_upgrade_current_child_failed");
  await send(outcome);
}

type Mode = "186" | "read186" | "read187" | "prove187";
type Child = { process: ChildProcess; mode: Mode; done: Promise<number>; forced: boolean; wait(type: string): Promise<unknown> };
async function parentSuite() {
  const { afterAll, describe, expect, it } = await import("vitest");
  const database = connectDatabase(isolated.url), contentBytes = randomBytes(32), children: Child[] = [];
  const proof = { nonce: isolated.nonce, operation: "native_v4_genuine186_to187", verified: false, databaseClosed: false,
    cleanupFailed: false, details: {} as Record<string, unknown> };
  function child(mode: Mode) {
    const legacy = mode === "186" || mode === "read186", root = legacy ? isolated.root : workspace;
    const loader = pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href;
    const processChild = spawn(process.execPath, ["--import", loader, legacy ? resolve(workspace, "tools/testing/agent-native-v4-legacy.mts") : entry], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env,
        NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"), E2E_LEGACY_SCHEMA_TARGET: "current",
        E2E_AGENT_NATIVE_V4_CONTENT_KEY: contentBytes.toString("base64url"),
        ...(legacy ? { E2E_AGENT_NATIVE_V4_LEGACY_CHILD: mode } : { E2E_AGENT_NATIVE_V4_UPGRADE_CURRENT_CHILD: mode }),
      },
    });
    const messages = new Map<string, unknown>(), waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
    let ended = false, failure: Error | undefined, startupCode: string | null = null, startupType: string | null = null;
    const reject = (error: Error) => { failure ??= error; for (const value of waiting.values()) value.reject(error); waiting.clear(); };
    processChild.stderr?.on("data", (bytes: Buffer) => { const text = bytes.toString("utf8");
      startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b/.exec(text)?.[1] ?? null;
      startupType ??= /\b(SyntaxError|TypeError|ReferenceError|TransformError)\b/.exec(text)?.[1] ?? null;
    });
    const allowed = new Set(["agent.native_v4.seeded186", "agent.native_v4.reader186.ready", "agent.native_v4.read186",
      "agent.native_v4.reader187.ready", "agent.native_v4.read187", "agent.native_v4.proved187"]);
    processChild.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") { reject(new Error("native4_upgrade_ipc_invalid")); return; }
      if (["agent.native_v4.failed186", "agent.native_v4.failed187"].includes(raw.type)) {
        const safe = z.object({ type: z.enum(["agent.native_v4.failed186", "agent.native_v4.failed187"]), phase: z.string().regex(/^[a-z0-9_]{1,64}$/),
          code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|native4_upgrade_[a-z0-9_]{1,96}|agent_[a-z0-9_]{1,96})$/).nullable(),
          errorName: z.string().regex(/^[A-Za-z]{1,48}$/) }).strict().safeParse(raw);
        reject(new Error(safe.success ? JSON.stringify(safe.data) : "native4_upgrade_finite_failure_invalid")); return;
      }
      if (!allowed.has(raw.type) || messages.has(raw.type) || Buffer.byteLength(JSON.stringify(raw)) > 2_097_152) {
        reject(new Error("native4_upgrade_ipc_invalid")); return;
      }
      messages.set(raw.type, raw); waiting.get(raw.type)?.resolve(raw); waiting.delete(raw.type);
    });
    const done = new Promise<number>(complete => {
      processChild.once("error", () => reject(new Error("native4_upgrade_spawn_failed")));
      processChild.once("close", (code, signal) => {
        ended = true;
        if (waiting.size || code !== 0) reject(new Error(JSON.stringify({ code: "native4_upgrade_child_exit", mode, exitCode: code, signal, startupCode, startupType })));
        complete(code ?? -1);
      });
    });
    const value: Child = { process: processChild, mode, done, forced: false, wait(type) {
      if (failure) return Promise.reject(failure);
      if (messages.has(type)) return Promise.resolve(messages.get(type));
      if (ended) return Promise.reject(new Error("native4_upgrade_child_already_closed"));
      return bounded(new Promise<unknown>((resolveMessage, rejectMessage) => waiting.set(type, { resolve: resolveMessage, reject: rejectMessage })), "native4_upgrade_ipc_timeout");
    } };
    children.push(value); return value;
  }
  async function sendTo(value: Child, message: AgentNativeV4LegacyReadRequest | { type: "agent.native_v4.read187.request"; references: AgentNativeV4LegacyReferences }) {
    await new Promise<void>((done, reject) => {
      if (!value.process.connected || !value.process.send) { reject(new Error("native4_upgrade_ipc_closed")); return; }
      value.process.send(message, error => error ? reject(error) : done());
    });
  }
  /** SQL serializes original timestamp microseconds before hashing. All original
   * columns visible to the actual RLS context remain fixed; no row text is saved. */
  async function originalProjection(context: TenantContext) {
    const columns = await withTenant(database.db, context, tx => tx.execute<{ table_name: string; column_name: string }>(sql`
      select c.table_name,c.column_name from information_schema.columns c
      join pg_class t on t.relname=c.table_name join pg_namespace n on n.oid=t.relnamespace and n.nspname=c.table_schema
      where c.table_schema='public' and t.relkind in ('r','p') and has_table_privilege(current_user,t.oid,'SELECT') order by c.table_name,c.ordinal_position`));
    const tables = new Map<string, string[]>();
    for (const row of columns) {
      ensure(/^[a-z_][a-z0-9_]*$/.test(row.table_name) && /^[a-z_][a-z0-9_]*$/.test(row.column_name), "native4_upgrade_projection_identifier_invalid");
      tables.set(row.table_name, [...tables.get(row.table_name) ?? [], row.column_name]);
    }
    return () => withTenant(database.db, context, async tx => {
      await tx.execute(sql.raw("set local time zone 'UTC'"));
      const result: Array<{ table: string; columns: string[]; count: number; sha256: string }> = [];
      for (const [name, fields] of tables) {
        const [row] = await tx.execute<{ count: number; canonical: string }>(sql`select count(*)::int as count,
          coalesce(string_agg(row_to_json(r)::text,E'\n' order by row_to_json(r)::text),'') as canonical
          from (select ${sql.join(fields.map(field => sql.identifier(field)), sql.raw(","))} from ${sql.identifier(name)}) r`);
        if (!row) throw new Error("native4_upgrade_projection_missing");
        result.push({ table: name, columns: fields, count: row.count, sha256: sha(row.canonical) });
      }
      return result;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  function stableProof(snapshot: SnapshotValue) {
    return { nativeV3: Object.fromEntries((["stopped", "expired"] as const).map(kind => {
      const value = snapshot.nativeV3[kind]; return [kind, { runId: value.view.id, itemId: snapshot.references.nativeV3[kind].itemId,
        viewSha256: checksum(value.view), receiptSha256: checksum(value.receipt), itemReceiptSha256: checksum(value.itemReceipt),
        prepareReplaySha256: checksum(value.prepareReplay), disposition: value.prepareReplay.disposition }];
    })), fulfillment: Object.fromEntries((["pending", "succeeded"] as const).map(kind => {
      const value = snapshot.fulfillment[kind]; return [kind, { id: value.stable.native.id, status: value.stable.native.status,
        stableSha256: checksum(value.stable), receiptSha256: checksum(value.receipt), confirmation: value.confirmation }];
    })), counts: snapshot.counts };
  }
  describe("genuine186 to187 independent native v4 completion", () => {
    afterAll(async () => {
      const failures: unknown[] = [];
      for (const value of children) {
        if (value.process.exitCode === null && value.process.signalCode === null) { value.forced = true; value.process.kill("SIGKILL"); }
        try { if (await bounded(value.done, "native4_upgrade_child_close_timeout", 15_000) !== 0 || value.forced) throw new Error("native4_upgrade_child_not_normally_closed"); }
        catch (error) { proof.cleanupFailed = true; failures.push(error); }
      }
      contentBytes.fill(0);
      try { await database.client.end(); proof.databaseClosed = true; } catch (error) { proof.cleanupFailed = true; failures.push(error); }
      await mkdir(isolated.lane, { recursive: true });
      await writeFile(resolve(isolated.lane, `${isolated.nonce}-upgrade-proof.json`), JSON.stringify({ ...proof,
        children: children.map(value => ({ mode: value.mode, pid: value.process.pid ?? null, forced: value.forced,
          exitCode: value.process.exitCode, signal: value.process.signalCode })) }, null, 2) + "\n", { flag: "wx" });
      if (failures.length) throw new AggregateError(failures, "native4_upgrade_close_failed");
    });
    it("genuine186_preserves_old37_V3_linked_replays_and_original_fulfillment_then_enforces_the_new187_completion_parent_gate", async () => {
      const flags = () => ({ target: process.env.E2E_LEGACY_SCHEMA_TARGET, family: process.env.E2E_AGENT_NATIVE_V4_ISOLATED,
        upgrade: process.env.E2E_AGENT_NATIVE_V4_UPGRADE_ISOLATED, source: process.env.E2E_AGENT_NATIVE_V4_LEGACY_SOURCE,
        original: process.env.E2E_FULFILLMENT_COMMAND_ISOLATED, agent: process.env.E2E_AGENT_FULFILLMENT_COMMAND_ISOLATED });
      const parentFlags = flags(); await assertAgentNativeV4Original186Graph(isolated.root);
      proof.details.originalGraph = { root: isolated.root, verified: true };
      const producer = child("186"), seed = Seed.parse(await producer.wait("agent.native_v4.seeded186"));
      expect(await bounded(producer.done, "native4_original186_seed_close_timeout", 15_000)).toBe(0);
      expect(seed.counts.syntheticModelCalls).toBeGreaterThan(0); expect(seed.fulfillment.pending.stable.native.status).toBe("prepared");
      expect(seed.fulfillment.pending.confirmation.canConfirm).toBe(true); expect(seed.fulfillment.pending.confirmation.hasToken).toBe(true);
      expect(seed.fulfillment.succeeded.stable.native.status).toBe("succeeded");
      expect(seed.fulfillment.succeeded.stable.native.receipt?.kind).toBe("production_milestone");
      expect(seed.nativeV3.stopped.view.stopRequestedAt !== null).toBe(true); expect(seed.nativeV3.expired.view.privateAvailable).toBe(false);
      for (const kind of ["stopped", "expired"] as const) {
        const reference = seed.references.nativeV3[kind], value = seed.nativeV3[kind];
        expect(reference.input.version).toBe("erp-agent-native-v3"); expect(reference.input.allowedCommands.length).toBe(1);
        expect(reference.input.allowedCommands[0]?.domain).toBe("procurement"); expect(reference.input.allowedCommands[0]?.kind).toBe("requisition_create");
        expect(value.prepareReplay.disposition).toBe("known"); expect(value.prepareReplay.agentCommandId).toBe(value.itemReceipt.agentCommandId);
        expect(value.prepareReplay.ownerCommandId).toBe(value.itemReceipt.ownerCommandId);
      }
      expect(flags()).toEqual(parentFlags);
      const project = await originalProjection(seed.references.context), before = await project(), ledger = (await readMigrationEvidence(database)).actualRows;
      expect(ledger.length).toBe(186);
      expect(before.some(row => row.table === "agent_plan_items" && row.count === 2)).toBe(true);
      expect(before.some(row => row.table === "order_fulfillment_command_intents" && row.count === 2)).toBe(true);
      await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
      const migratedLedger = (await readMigrationEvidence(database)).actualRows;
      expect(migratedLedger.length).toBe(187); expect(migratedLedger.slice(0, 186)).toEqual(ledger);
      expect(await project()).toEqual(before); expect(flags()).toEqual(parentFlags);
      const added = await withTenant(database.db, seed.references.context, tx => tx.select({ id: agentPlanItems.id,
        protocol: agentPlanItems.originalProtocol, orderId: agentPlanItems.originalOrderId, intentId: agentPlanItems.fulfillmentIntentId,
        encrypted: agentPlanItems.encryptedCompletion, completionChecksum: agentPlanItems.completionChecksum,
        boundAt: agentPlanItems.completionBoundAt, transactionId: agentPlanItems.completionTransactionId,
        redactedAt: agentPlanItems.completionRedactedAt }).from(agentPlanItems));
      expect(added.length).toBe(2);
      expect(added.map(({ id }) => id).sort()).toEqual([seed.references.nativeV3.stopped.itemId, seed.references.nativeV3.expired.itemId].sort());
      expect(added.every(row => row.protocol === null && row.orderId === null && row.intentId === null && row.encrypted === null
        && row.completionChecksum === null && row.boundAt === null && row.transactionId === null && row.redactedAt === null)).toBe(true);

      const currentReader = child("read187"); await currentReader.wait("agent.native_v4.reader187.ready");
      await sendTo(currentReader, { type: "agent.native_v4.read187.request", references: seed.references });
      const current = CurrentRead.parse(await currentReader.wait("agent.native_v4.read187"));
      expect(await bounded(currentReader.done, "native4_current187_reader_close_timeout", 15_000)).toBe(0);
      const oldReader = child("read186"); await oldReader.wait("agent.native_v4.reader186.ready");
      await sendTo(oldReader, { type: "agent.native_v4.read186.request", references: seed.references });
      const old = LegacyRead.parse(await oldReader.wait("agent.native_v4.read186"));
      expect(await bounded(oldReader.done, "native4_original186_reader_close_timeout", 15_000)).toBe(0);
      for (const value of [current, old]) {
        expect(checksum(value.references)).toBe(checksum(seed.references));
        expect(checksum(value.nativeV3)).toBe(checksum(seed.nativeV3)); expect(checksum(value.fulfillment)).toBe(checksum(seed.fulfillment));
        expect(value.counts.syntheticModelCalls).toBe(0); expect(value.counts.workerProcesses).toBe(0); expect(value.counts.paidProviderCalls).toBe(0);
      }
      expect(await project()).toEqual(before); expect(flags()).toEqual(parentFlags);
      proof.details.preservation = { originalColumns: before, migrationPrefixCount: 186, migrationCount: 187,
        migrationPrefixSha256: checksum(ledger), eightNewFieldsNullForOriginalItems: true, originalItemIds: added.map(({ id }) => id).sort(),
        seed: stableProof(seed), currentReader: stableProof(current), original186Reader: stableProof(old),
        currentOriginalPrepareCalls: current.originalPrepareCalls, currentOriginalExecuteCalls: current.originalExecuteCalls };

      // Complete preservation evidence before this explicit new187 admission:
      // legitimate new actors/model/parent/item/intent history is not zero-delta.
      const positive = child("prove187"), completed = CurrentProof.parse(await positive.wait("agent.native_v4.proved187"));
      expect(await bounded(positive.done, "native4_new187_gate_close_timeout", 15_000)).toBe(0);
      expect(new Set([completed.runId, completed.itemId, completed.intentId]).size).toBe(3);
      expect(completed.originalChecksum === completed.proposalChecksum).toBe(false);
      expect(completed.preparationRequestChecksum === completed.proposalChecksum).toBe(false);
      expect(completed.completionChecksum === completed.proposalChecksum).toBe(false);
      proof.details.new187 = { ...completed, admission: "independent_disposable_fixture_tenant" };
      expect(flags()).toEqual(parentFlags); proof.verified = true;
    });
  });
}

if (childMode === "read187" || childMode === "prove187") {
  try { await currentChild(childMode); }
  catch { process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
} else await parentSuite();
