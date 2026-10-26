/** P6 personal support: native owners/processors, bounded synthetic Responses,
 * no ordinary Worker, external model, supplier send or production. */
import "../../apps/api/node_modules/reflect-metadata/Reflect.js";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "../../apps/api/node_modules/zod/index.js";
import { intersectPermissionContexts } from "../../packages/authz/src/index.js";
import { createEnvironmentSecretVault } from "../../packages/ai-core/src/index.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/index.js";
import { AgentCommandOriginalSchema } from "../../packages/contracts/src/ai/agent-command.js";
import {
  AgentNativeV4DecisionSchema, agentNativeV4DefinitionSelection,
  type AgentNativeV4TurnInput,
} from "../../packages/contracts/src/ai/agent-native-v4.js";
import type { AgentNativeV3Claim } from "../../packages/contracts/src/ai/agent-native-v3.js";
import {
  connectDatabase, withTenant, loadCurrentMembershipContext, memberships, users,
  assertDatabaseMigrationsCurrent, type DatabaseConnection,
} from "../../packages/database/src/index.js";
import { and, eq } from "../../apps/api/node_modules/drizzle-orm/index.js";
import { createStorageFromEnvironment } from "../../packages/storage/src/index.js";
import { createOrderPiiVault } from "../../apps/api/src/orders/order-pii-vault.js";
import { createIntegrationSecretVault } from "../../apps/api/src/integrations/integration-secret-vault.js";
import { ModelConfigurationService } from "../../apps/api/src/ai/model-configuration.service.js";
import { ProductDevelopmentService } from "../../apps/api/src/catalog/product-development.service.js";
import { agentNativeV4Fixture } from "../../apps/api/src/ai/agent-native-v4.test-fixture.js";
import type { AgentActor } from "../../apps/api/src/ai/agent-read.test-fixture.js";
import { requireAgentNativeV4Environment } from "./require-agent-native-v4-environment.mjs";
import { evaluationTextId } from "./knowledge-evaluation-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Native = ReturnType<typeof agentNativeV4Fixture>;
export type P6Seed = {
  spuId: string; stockItemId: string; modelId: string; query: string;
  requisitionCode: string; journalSha256: string; currentMigrations: number;
};
export type P6Plan = {
  runId: string; requestId: string; itemId: string; proposalChecksum: string;
  knowledgeEntryId: string; knowledgeVersion: number; knowledgeChecksum: string;
  modelCalls: number; knownCostUsd: string;
};
export type P6State = {
  requisitions: number; modelCalls: number; providerFailures: number;
  parentChecksum: string | null; commandState: string | null;
};
const envelope = { nonce: z.string().regex(/^[a-f0-9]{32}$/), id: z.int().positive() };
const InputSchema = z.discriminatedUnion("operation", [
  z.object({ ...envelope, operation: z.literal("seed"), context: TenantContextSchema }).strict(),
  z.object({ ...envelope, operation: z.literal("plan"), entryId: z.uuidv7(), version: z.int().positive() }).strict(),
  z.object({ ...envelope, operation: z.literal("state"), commandId: z.uuidv7().optional() }).strict(),
  z.object({ ...envelope, operation: z.literal("close") }).strict(),
]);

function environment() {
  if (process.env.E2E_P6_KNOWLEDGE_AGENT_ISOLATED !== "1")
    throw new Error("p6_explicit_isolation_required");
  return requireAgentNativeV4Environment(process.env, "current", true);
}

/** Only fixed reads/definitions and one internal, separately confirmed draft. */
function decision(packet: AgentNativeV4TurnInput, original: ReturnType<typeof AgentCommandOriginalSchema.parse>, query: string) {
  for (const [index, binding] of packet.bindings.entries()) {
    if (!packet.definitions.some(row => {
      const selected = agentNativeV4DefinitionSelection(row.definition);
      return selected.kind === "read" && selected.tool === binding.tool;
    })) return AgentNativeV4DecisionSchema.parse({
      action: "definition", label: "Read this fixed P6 definition",
      definition: { kind: "read", tool: binding.tool }, read: null, result: null,
    });
    if (!packet.observations.some(row => row.request.bindingIndex === index))
      return AgentNativeV4DecisionSchema.parse({
        action: "read", label: "Read this fixed P6 source", definition: null,
        read: { bindingIndex: index, keyword: binding.tool === "knowledge.search" ? query : null }, result: null,
      });
  }
  if (!packet.definitions.some(row => {
    const selected = agentNativeV4DefinitionSelection(row.definition);
    return selected.kind === "command" && selected.command.domain === "procurement"
      && selected.command.kind === "requisition_create";
  })) return AgentNativeV4DecisionSchema.parse({
    action: "definition", label: "Load the original internal requisition",
    definition: { kind: "command", command: { domain: "procurement", kind: "requisition_create" } },
    read: null, result: null,
  });
  const claims: AgentNativeV3Claim[] = [];
  for (const observation of packet.observations) for (const [resultIndex, result] of observation.results.entries()) {
    if (result.tool === "knowledge.search" && result.data.references[0])
      claims.push({ stepId: observation.stepId, resultIndex, dataChecksum: result.dataChecksum,
        path: ["references", 0, "checksum"], value: result.data.references[0].checksum });
    if (result.tool === "inventory.balances.page" && result.data.items[0])
      claims.push({ stepId: observation.stepId, resultIndex, dataChecksum: result.dataChecksum,
        path: ["items", 0, "physicalQuantity"], value: result.data.items[0].physicalQuantity });
  }
  if (claims.length !== 2 || !packet.slots[0]) throw new Error("p6_original_source_missing");
  const fixed = AgentCommandOriginalSchema.parse({ ...original, command: { ...original.command,
    input: { ...original.command.input, idempotencyKey: packet.slots[0].idempotencyKey } } });
  return AgentNativeV4DecisionSchema.parse({
    action: "finish", label: "Suggest an internal requisition for actual operator review",
    definition: null, read: null,
    result: { summary: "Synthetic P6 stock and knowledge evidence; no business action has been executed",
      claims, missingInformation: [], proposals: [{
        position: 0, capability: { domain: "procurement", kind: "requisition_create" },
        label: "P6 internal requisition only", reason: "Inspect and confirm the actual original draft",
        draftJson: JSON.stringify(fixed), claimIndexes: [0, 1], missingInformation: [],
      }] },
  });
}

async function child() {
  const env = environment();
  if (!process.connected) throw new Error("p6_ipc_required");
  let database: DatabaseConnection | undefined, fixture: Native | undefined, ceiling: TenantContext | undefined;
  let seed: P6Seed | undefined, plan: P6Plan | undefined;
  let original: ReturnType<typeof AgentCommandOriginalSchema.parse> | undefined;
  let journal = "", closed = false, planning = false, phase = "ready", serial = Promise.resolve();
  const send = (value: unknown) => new Promise<void>((resolve, reject) =>
    process.send!(value, error => error ? reject(error) : resolve()));
  const current = async () => {
    if (!database || !ceiling) throw new Error("p6_personal_context_missing");
    return withTenant(database.db, ceiling, async tx => TenantContextSchema.parse(
      intersectPermissionContexts(ceiling!, await loadCurrentMembershipContext(tx, ceiling!, { lock: true }))));
  };
  async function close() {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    try { await fixture?.close(); } catch (error) { errors.push(error); }
    try {
      if (journal && await readFile(root + "/packages/database/migrations/meta/_journal.json", "utf8") !== journal)
        throw new Error("p6_journal_changed");
    } catch (error) { errors.push(error); }
    try { await database?.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "p6_child_cleanup_failed");
  }
  async function initialize(caller: TenantContext): Promise<P6Seed> {
    if (seed || fixture || database || closed) throw new Error("p6_seed_once_required");
    phase = "actual_personal_membership";
    const configured = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null")?.operator;
    if (caller.userId !== configured?.userId || caller.tenantId !== configured?.tenantId)
      throw new Error("p6_personal_actor_mismatch");
    database = connectDatabase(env.url);
    const readiness = await assertDatabaseMigrationsCurrent(database);
    journal = await readFile(root + "/packages/database/migrations/meta/_journal.json", "utf8");
    if (readiness.migrations !== JSON.parse(journal).entries.length)
      throw new Error("p6_current_journal_mismatch");
    const person = await withTenant(database.db, caller, async tx => {
      const context = TenantContextSchema.parse(intersectPermissionContexts(
        caller, await loadCurrentMembershipContext(tx, caller, { lock: true })));
      const [member] = await tx.select({ id: memberships.id, subject: users.oidcSubject })
        .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.userId, context.userId),
          eq(memberships.status, "active")));
      if (!member) throw new Error("p6_current_membership_missing");
      return { context, member };
    });
    ceiling = person.context;
    const actor: AgentActor = { tenantId: ceiling.tenantId, userId: ceiling.userId, context: ceiling,
      subject: person.member.subject, membershipId: person.member.id, roleIds: new Map() };
    const modelVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config");
    fixture = agentNativeV4Fixture(database, { actor, modelVault,
      contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
      orderVault: createOrderPiiVault(), integrationVault: createIntegrationSecretVault() });
    phase = "fixture_initialize"; await fixture.initialize();
    const models = new ModelConfigurationService(database, modelVault);
    const name = "Synthetic P6 " + env.nonce + "-" + randomUUID().slice(0, 8);
    const channels = await models.invoke(await current(), {
      operation: "channel.save", name, baseUrl: "https://synthetic-p6.invalid/v1",
      apiKey: "synthetic-no-provider-credential", textProtocol: "responses", models: [],
    });
    if (!("channels" in channels)) throw new Error("p6_model_channel_missing");
    const provider = channels.channels.find(row => row.name === name);
    if (!provider) throw new Error("p6_model_channel_missing");
    const model = await fixture.base.assists.addModel(await current(), {
      providerConfigId: provider.id, model: "synthetic-p6-native", label: name,
      inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1,
    });
    phase = "native_internal_sources";
    // Only the small internal stock/requisition seed, never the 14-owner source().
    const source = await fixture.prior.prior.legacy.prior.sourceContext(await current());
    original = source.requisition;
    if (original.domain !== "procurement" || original.command.kind !== "requisition_create")
      throw new Error("p6_internal_requisition_missing");
    const product = await new ProductDevelopmentService(database, createStorageFromEnvironment()).createSpu(await current(), {
      code: "P6-" + randomUUID(), name: "Synthetic P6 product " + env.nonce.slice(0, 8), idempotencyKey: randomUUID(),
    });
    return seed = { spuId: product.spu.id, stockItemId: source.stockItemId, modelId: model.id,
      query: "P6 governed requisition " + evaluationTextId(source.stockItemId), requisitionCode: original.command.input.code,
      journalSha256: sha(journal), currentMigrations: readiness.migrations };
  }
  async function runPlan(entryId: string, version: number): Promise<P6Plan> {
    if (!fixture || !seed || !original || planning || plan) throw new Error("p6_plan_once_required");
    planning = true; phase = "native_parent_start";
    fixture.controls.decision = packet => decision(packet, original!, seed!.query);
    const request = await fixture.request(null, {
      modelId: seed.modelId, goal: seed.query,
      contextText: "Synthetic internal requisition draft for separate actual operator confirmation",
      bindings: [
        { tool: "knowledge.search", scope: { topic: "operations", platform: "all", market: "ALL", spuIds: [seed.spuId] } },
        { tool: "inventory.balances.page", scope: { stockItemId: seed.stockItemId } },
      ],
      allowedCommands: [{ domain: "procurement", kind: "requisition_create" }],
    });
    const started = await fixture.service().start(await current(), request);
    phase = "original_processor"; await fixture.process(started.id);
    const result = await fixture.service().get(await current(), started.id);
    const item = result.items[0], proposal = result.result?.proposals[0];
    const references = result.observations.flatMap(observation => observation.results.flatMap(value =>
      value.tool === "knowledge.search" ? value.data.references : []));
    const ref = references.find(value => value.entryId === entryId && value.version === version);
    if (result.status !== "completed" || result.items.length !== 1 || !item || !proposal || !ref ||
      proposal.draft.original?.domain !== "procurement" ||
      proposal.draft.original.command.kind !== "requisition_create" || fixture.providerFailures.length)
      throw new Error("p6_original_parent_not_sealed");
    return plan = { runId: result.id, requestId: result.requestId, itemId: item.id,
      proposalChecksum: item.proposalChecksum, knowledgeEntryId: ref.entryId,
      knowledgeVersion: ref.version, knowledgeChecksum: ref.checksum,
      modelCalls: fixture.modelCalls.length, knownCostUsd: result.cost.knownCostUsd };
  }
  async function state(commandId?: string): Promise<P6State> {
    if (!database || !fixture || !seed) throw new Error("p6_seed_missing");
    const context = await current(), business = await fixture.prior.prior.legacy.prior.business(context);
    const requisitions = business.inventory_procurement_requisitions;
    if (!requisitions) throw new Error("p6_business_projection_missing");
    const parent = plan ? await fixture.service().get(context, plan.runId) : null;
    const command = commandId ? await fixture.prior.prior.legacy.owners.service().get(context, commandId) : null;
    return { requisitions: requisitions.count, modelCalls: fixture.modelCalls.length,
      providerFailures: fixture.providerFailures.length, parentChecksum: parent?.result ? sha(JSON.stringify(parent.result)) : null,
      commandState: command?.state ?? null };
  }
  process.once("disconnect", () => { void serial.finally(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", (raw: unknown) => {
    serial = serial.then(async () => {
      let id: number | undefined;
      try {
        if (!raw || typeof raw !== "object") throw new Error("p6_message_invalid");
        const message = InputSchema.parse(raw); id = message.id;
        if (message.nonce !== env.nonce) throw new Error("p6_message_invalid");
        let value: unknown;
        if (message.operation === "seed") value = await initialize(TenantContextSchema.parse(message.context));
        else if (message.operation === "plan") value = await runPlan(message.entryId, message.version);
        else if (message.operation === "state") value = await state(message.commandId);
        else { phase = "close"; await close(); value = { closed: true }; }
        await send({ type: "result", nonce: env.nonce, id, value });
        if (message.operation === "close" && process.connected) process.disconnect();
      } catch (error) {
        const code = error instanceof Error && /^p6_[a-z0-9_]+$/.test(error.message) ? error.message : null;
        await send({ type: "failure", nonce: env.nonce, id, phase, code });
      }
    }).catch(async () => { process.exitCode = 1; await close().catch(() => {}); if (process.connected) process.disconnect(); });
  });
  await send({ type: "ready", nonce: env.nonce });
}
if (process.argv.includes("--p6-knowledge-agent-child"))
  void child().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
