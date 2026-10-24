import "reflect-metadata";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEnvironmentSecretVault, OpenAiCompatibleProvider } from "@yummyai/ai-core";
import { TenantContextSchema, createEntityId } from "@yummyai/contracts";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3TurnInputSchema, AgentNativeV3DecisionSchema, agentNativeV3DefinitionSelection } from "@yummyai/contracts/ai/agent-native-v3";
import { connectDatabase, roles, agentPlanRuns, withTenant } from "@yummyai/database";
import { createQueue, JobEnvelopeSchema, QueueName } from "@yummyai/jobs";
import { AgentNativeRuntime, AgentNativeV2Runtime, AgentNativeV3Runtime, AgentPlanRuntime, SharedAgentReadGateway } from "@yummyai/workflow-core";
import { requirePublicationNodePreviewEnvironment } from "../../../../tools/testing/publication-node-preview-environment.mjs";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";
import { createWorkerAgentTools } from "../../../worker/src/agent-native-owners.js";
import { createWorkerAgentResources } from "../../../worker/src/agent-resources-owners.js";
import { createWorkerAgentFulfillment } from "../../../worker/src/agent-fulfillment-owners.js";
import { publicationNodePreviewFixture, lane, nodeExecutionPermissions, nodeExecutionSha, type PreviewSource } from "./publication-node-preview.test-fixture.js";

const Id = z.uuidv7(), Actor = z.object({ userId: Id, tenantId: Id, roleId: Id, membershipId: Id, subject: z.string().optional() }).passthrough();
const Input = z.discriminatedUnion("operation", [z.object({ operation: z.literal("seed") }).strict(),
  z.object({ operation: z.enum(["work", "snapshot", "close"]), groupId: Id }).strict(),
  z.object({ operation: z.literal("native"), groupId: Id, runId: Id }).strict(),
  z.object({ operation: z.literal("rights"), groupId: Id, enabled: z.boolean() }).strict()]);

/** Real AppModule, actual OIDC member, actual node child and standard four-protocol Worker router.
 * Only the external model HTTP response and external marketplace HTTPS are synthetic. */
async function browserApi() {
  const isolated = requirePublicationNodePreviewEnvironment(process.env, "current", true), actor = Actor.parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator);
  const database = connectDatabase(isolated.url), ceiling = TenantContextSchema.parse({ tenantId: actor.tenantId, userId: actor.userId,
    permissions: [...nodeExecutionPermissions, Permission.ModelConfigure], dataScope: "tenant" });
  const originalRole = await withTenant(database.db, ceiling, async tx => (await tx.select().from(roles).where(and(eq(roles.id, actor.roleId), eq(roles.tenantId, actor.tenantId))))[0]);
  if (!originalRole) { await database.client.end(); throw new Error("publication_preview_browser_member_missing"); }
  const permissions = [...new Set([...originalRole.permissions, ...ceiling.permissions])];
  const rights = (enabled: boolean) => withTenant(database.db, ceiling, tx => tx.update(roles).set({ dataScope: originalRole.dataScope,
    permissions: enabled ? permissions : permissions.filter(bit => bit !== Permission.ListingRead && bit !== Permission.ListingPublish) }).where(eq(roles.id, actor.roleId)));
  let ready = false, closed = false, control: ReturnType<typeof createServer> | undefined;
  const f = publicationNodePreviewFixture(database, { actor: { userId: actor.userId, tenantId: actor.tenantId, roleId: actor.roleId, membershipId: actor.membershipId,
    subject: actor.subject ?? "runner-owned-personal-operator" }, apiPort: 8130, readyPath: "/__publication_node_preview_fixture_ready", ready: () => ready });
  const queue = createQueue(QueueName.AgentPlan), contentVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    modelVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"), integrationVault = createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1"),
    piiVault = createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1");
  type Child = Awaited<ReturnType<typeof f.workNode>>;
  type Group = { scene: Awaited<ReturnType<typeof f.bootstrapStore>>; source: PreviewSource; child?: Child; modelId: string; providerId: string; runs: Set<string>; closed: boolean; modelCalls: number };
  const groups = new Map<string, Group>();
  async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const token = process.env.API_ACCESS_TOKEN; if (!token || !/^\/v1\/(?:identity\/session|ai\/model-configs|ai\/configuration|ai-assists\/models|agent-native-v3\/runs)/.test(path)) throw new Error("publication_preview_personal_fixture_path_invalid");
    const response = await fetch(f.origin + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("publication_preview_personal_fixture_http_failed:" + response.status);
    return await response.json() as unknown;
  }
  async function addModel(groupId: string) {
    const person = ErpSessionViewSchema.parse(await api("/v1/identity/session"));
    if (person.userId !== actor.userId || person.tenantId !== actor.tenantId) throw new Error("publication_preview_real_personal_identity_mismatch");
    const channel = z.object({ id: Id }).passthrough().parse(await api("/v1/ai/model-configs", { provider: "openai-compatible", label: "Synthetic preview model " + groupId,
      endpoint: "https://synthetic-publication-preview-model.invalid/v1", apiKey: "synthetic-no-paid-provider-credential" }));
    const model = z.object({ id: Id }).passthrough().parse(await api("/v1/ai-assists/models", { providerConfigId: channel.id,
      model: "synthetic-original-listing", label: "Synthetic preview source " + groupId, inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: 1 }));
    return { modelId: model.id, providerId: channel.id };
  }
  async function processNative(group: Group, runId: string) {
    const job = await queue.getJob(runId); if (!job) throw new Error("publication_preview_original_native_job_missing");
    const envelope = JobEnvelopeSchema.parse(job.data), row = await withTenant(database.db, ceiling, async tx => (await tx.select().from(agentPlanRuns).where(eq(agentPlanRuns.id, runId)))[0]);
    if (!row || row.ownerId !== actor.userId || row.version !== AGENT_NATIVE_V3_VERSION || envelope.tenantId !== actor.tenantId || envelope.requestedBy !== actor.userId ||
      row.modelSnapshot.id !== group.modelId) throw new Error("publication_preview_original_native_job_mismatch");
    group.runs.add(runId);
    const tools = createWorkerAgentTools(database, integrationVault), resources = createWorkerAgentResources(database), fulfillment = createWorkerAgentFulfillment(database, piiVault);
    const providerFactory: NonNullable<ConstructorParameters<typeof AgentNativeV3Runtime>[0]["providerFactory"]> = (provider, apiKey, model) =>
      new OpenAiCompatibleProvider({ providerId: provider.id, apiKey, endpoint: "https://synthetic-publication-preview-model.invalid/v1", pricing: {
        inputUsdPerMillion: model.inputUsdPerMillion!, outputUsdPerMillion: model.outputUsdPerMillion! }, fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: unknown }> };
        const framed = body.messages?.find(value => value.role === "user")?.content;
        const text = typeof framed === "string" ? /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(framed)?.[1] : undefined;
        const packet = AgentNativeV3TurnInputSchema.parse(JSON.parse(text ?? "null"));
        if (packet.bindings.length !== 1 || packet.bindings[0]?.tool !== "listing.version" || packet.bindings[0].scope.listingId !== group.source.listingId ||
          packet.bindings[0].scope.versionId !== group.source.versionId || packet.allowedCommands.length !== 0) throw new Error("publication_preview_model_scope_invalid");
        group.modelCalls++;
        let decision: unknown;
        if (!packet.definitions.some(value => { const selected = agentNativeV3DefinitionSelection(value.definition); return selected.kind === "read" && selected.tool === "listing.version"; }))
          decision = { action: "definition", label: "Read the original Listing contract", definition: { kind: "read", tool: "listing.version" }, read: null, result: null };
        else if (!packet.observations.length) decision = { action: "read", label: "Read the operator selected immutable Listing version", definition: null, read: { bindingIndex: 0, keyword: null }, result: null };
        else { const original = packet.observations[0]!, result = original.results[0];
          if (result?.tool !== "listing.version") throw new Error("publication_preview_original_listing_observation_missing");
          decision = { action: "finish", label: "Seal one original Listing source without preparing a platform action", definition: null, read: null,
            result: { summary: "Synthetic model read the original Listing title; a person must separately prepare node validation preview", claims: [{ stepId: original.stepId,
              resultIndex: 0, dataChecksum: result.dataChecksum, path: ["version", "content", "title"], value: result.data.version.content.title }],
              missingInformation: ["Validation preview does not establish marketplace publication"], proposals: [] } }; }
        return Response.json({ id: "synthetic-preview-model-" + createEntityId(), choices: [{ message: { content: JSON.stringify(AgentNativeV3DecisionSchema.parse(decision)) } }], usage: { prompt_tokens: 50, completion_tokens: 80 } });
      } });
    const shared = { database, contentVault, modelVault, providerFactory };
    return new AgentPlanProcessor(agentPlanRuntimeRouter(database,
      new AgentPlanRuntime({ ...shared, reads: new SharedAgentReadGateway(database, integrationVault) }), new AgentNativeRuntime({ ...shared, tools }),
      new AgentNativeV2Runtime({ ...shared, tools, resources }), new AgentNativeV3Runtime({ ...shared, tools, resources, fulfillment }))).process(envelope);
  }
  async function closeGroup(groupId: string) {
    const group = groups.get(groupId); if (!group || group.closed) throw new Error("publication_preview_browser_group_not_owned");
    const errors: unknown[] = []; await rights(true);
    try { await group.child?.close(); } catch (error) { errors.push(error); }
    const runs = await withTenant(database.db, ceiling, tx => tx.select().from(agentPlanRuns).where(eq(agentPlanRuns.ownerId, actor.userId)));
    for (const run of runs.filter(value => value.modelSnapshot.id === group.modelId)) {
      group.runs.add(run.id);
      try { if (["queued", "running", "stopping"].includes(run.status)) await api(`/v1/agent-native-v3/runs/${run.id}/stop`, { version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId });
        await (await queue.getJob(run.id))?.remove(); } catch (error) { errors.push(error); }
    }
    const rows = await f.previewRows();
    for (const intent of rows.intents.filter(value => value.target?.listingId === group.source.listingId && value.createdBy === actor.userId)) {
      const job = rows.executions.find(value => value.id === intent.nodeExecutionId);
      try { if (job?.state === "waiting_node") await f.publications.cancelPreview(await f.current(), intent.requestId, { reason: "Synthetic browser group cleanup before node claim" }); }
      catch (error) { errors.push(error); }
    }
    try { await f.retireStore(group.source.accountId); } catch (error) { errors.push(error); }
    try { await api("/v1/ai/model-configs/" + group.providerId, { status: "disabled" }, "PATCH"); } catch (error) { errors.push(error); }
    group.closed = true;
    if (errors.length) throw new AggregateError(errors, "Publication preview browser group cleanup failed");
    return { originalAuthorizationRevoked: true, childExited: group.child?.evidence.exited ?? true, noSecretOutput: !group.child?.evidence.leaked, ownedNativeRuns: group.runs.size };
  }
  async function close() {
    if (closed) return; closed = true; ready = false; const errors: unknown[] = [];
    for (const [id, group] of groups) if (!group.closed) try { await closeGroup(id); } catch (error) { errors.push(error); }
    if (control) { control.closeAllConnections(); await new Promise<void>(done => control!.close(() => done())); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try { await queue.close(); } catch (error) { errors.push(error); }
    try { await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: originalRole.permissions, dataScope: originalRole.dataScope }).where(eq(roles.id, originalRole.id))); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Publication preview browser API cleanup failed");
  }
  try {
    await rights(true); await f.initialize(); const key = randomBytes(32).toString("base64url");
    control = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json"); const presented = request.headers["x-fixture-control"];
      if (request.method !== "POST" || request.url !== "/" || typeof presented !== "string" || presented.length !== key.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(key))) { response.writeHead(404); response.end(); return; }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error("bounded_control_input"); chunks.push(Buffer.from(chunk)); }
        const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); let result: unknown;
        if (input.operation === "seed") {
          await rights(true); const groupId = createEntityId(), scene = await f.bootstrapStore(), source = await f.seedListing(scene.store.id), model = await addModel(groupId);
          const group: Group = { scene, source, ...model, runs: new Set(), closed: false, modelCalls: 0 }; groups.set(groupId, group);
          result = { groupId, source, modelId: model.modelId, actorId: actor.userId, tenantId: actor.tenantId, nodeId: scene.node.nodeId };
        } else {
          const group = groups.get(input.groupId); if (!group || group.closed) throw new Error("owned_preview_group_required");
          if (input.operation === "native") { await processNative(group, input.runId); result = { processed: true, runId: input.runId, modelCalls: group.modelCalls }; }
          else if (input.operation === "work") { await group.child?.close(); group.child = await f.workNode(group.scene.node.keys); result = { started: true, nodeId: group.scene.node.nodeId }; }
          else if (input.operation === "rights") { await rights(input.enabled); result = { updated: true }; }
          else if (input.operation === "close") result = await closeGroup(input.groupId);
          else { const rows = await f.previewRows(), account = await f.accountRows(group.source.accountId);
            const business = await withTenant(database.db, ceiling, async tx => (await tx.execute<{ paidUsd: string; submissions: number; listingSyncs: number }>(sql`select
              (select coalesce(sum(amount_usd),0)::text from ai_budget_ledger where state='committed') "paidUsd",
              (select count(*)::int from marketplace_publication_requests where action<>'amazon_validation_preview') submissions,
              (select count(*)::int from marketplace_listing_sync_requests) "listingSyncs"`))[0]!);
            result = { business, modelCalls: group.modelCalls, counts: f.provider.counts(), requests: rows.requests.filter(value => value.listingId === group.source.listingId).map(value => ({ id: value.id,
              listingVersionId: value.listingVersionId, payloadChecksum: value.payloadChecksum, action: value.action })),
              events: rows.events.filter(value => rows.requests.some(row => row.listingId === group.source.listingId && row.id === value.requestId)).map(value => ({ id: value.id, requestId: value.requestId, sequence: value.sequence, status: value.status })),
              child: group.child?.evidence ?? null, snapshots: account.snapshots.map(value => ({ id: value.id, version: value.version, sourceChecksum: value.sourceChecksum })),
              sourceFactsHash: nodeExecutionSha(JSON.stringify(rows.requests.filter(value => value.listingId === group.source.listingId))) };
          }
        }
        response.writeHead(200); response.end(JSON.stringify(result));
      } catch (error) {
        const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "publication_preview_browser_control_rejected";
        response.writeHead(409); response.end(JSON.stringify({ code }));
      }
    });
    await new Promise<void>((done, fail) => { control!.once("error", fail); control!.listen(0, "127.0.0.1", done); });
    const address = control.address(); if (!address || typeof address === "string") throw new Error("publication_preview_browser_control_address_invalid");
    await writeFile(resolve(lane, "browser-control-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid, origin: "http://127.0.0.1:" + address.port, key }), { flag: "wx", mode: 0o600 }); ready = true;
    let closing: Promise<void> | undefined;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
  } catch { await close().catch(() => {}); throw new Error("publication_preview_browser_startup_failed"); }
}
if (process.argv.includes("--publication-node-preview-api")) void browserApi().catch(() => { process.stderr.write("publication_preview_browser_startup_failed\n"); process.exitCode = 1; });
