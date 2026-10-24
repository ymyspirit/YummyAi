import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { AGENT_MCP_TOOL_NAMES as names } from "@yummyai/contracts/ai/agent-mcp";
import { AgentToolCallSchema, AgentToolDefinitionSchema, AgentToolResultSchema } from "@yummyai/contracts/ai/agent-tools";
import { verifyAgentToolTransport, verifyAgentToolDefinitionTransport } from "@yummyai/contracts/ai/agent-transport";
import { AGENT_RESOURCES_VERSION, AgentResourceKeySchema, AgentResourceCallSchema, AgentResourceWorkspaceSchema,
  AgentResourceDefinitionSchema, AgentResourceResultSchema, AgentResourceCandidatesQuerySchema, AgentResourceCandidatesSchema,
  AgentResourceMcpCandidatesRequestSchema, agentResourceDataPayload, type AgentResourceKey, type AgentResourceCall } from "@yummyai/contracts/ai/agent-resources";
import { verifyAgentResourceDefinition, verifyAgentResourceResult, verifyAgentResourceCandidates } from "@yummyai/contracts/ai/agent-resource-transport";
import { ResearchStudyContentSchema } from "@yummyai/contracts/research/creative";
import { connectDatabase } from "@yummyai/database";
import { agentResourcesFixture, requireAgentResourcesEnvironment, openResourceMcpClient, resourceScopes } from "./agent-resources.test-fixture.js";
import { bounded, deferred } from "./agent-read.test-fixture.js";

const environment = requireAgentResourcesEnvironment(), database = connectDatabase(environment.url), f = agentResourcesFixture(database);
const keys = AgentResourceKeySchema.options, flags = keys.map(key => `--allow-resource=${key}`);
type Client = Awaited<ReturnType<typeof openResourceMcpClient>>;
const clients: Client[] = [];
let source: Awaited<ReturnType<typeof f.seed>>, sourceTeam: Awaited<ReturnType<typeof f.base.team>>;
let journalChecksum: string;
const journalPath = new URL("../../../../packages/database/migrations/meta/_journal.json", import.meta.url);
async function client(allowed: readonly string[] = flags, actor = f.base.a) {
  const value = await openResourceMcpClient(await f.startHttp(), await f.token(actor), allowed); clients.push(value); return value;
}
async function readCall(tool: AgentResourceKey, input: unknown, context?: TenantContext) {
  context ??= await f.current(f.base.a);
  const workspace = AgentResourceWorkspaceSchema.parse(await f.service.workspace(context));
  const definition = AgentResourceDefinitionSchema.parse(await f.service.definition(context, { version: AGENT_RESOURCES_VERSION, tool }));
  await verifyAgentResourceDefinition(definition, tool);
  return AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, executionContract: workspace.executionContract,
    definitionChecksum: definition.definitionChecksum, tool, input });
}
async function read(call: AgentResourceCall, context?: TenantContext) {
  const value = AgentResourceResultSchema.parse(await f.service.call(context ?? await f.current(f.base.a), call));
  await verifyAgentResourceResult(value, call); return value;
}
async function sdkRead(sdk: Client, tool: AgentResourceKey, input: unknown) {
  const selected = await sdk.call(names.schema, { key: `resource/${tool}` }); expect(selected.isError).toBe(false);
  const definition = AgentResourceDefinitionSchema.parse(selected.packet.data.definition);
  await verifyAgentResourceDefinition(definition, tool);
  const executionContract = HarnessExecutionContractSchema.parse(selected.packet.data.executionContract);
  const call = AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, tool, input,
    definitionChecksum: definition.definitionChecksum, executionContract });
  const response = await sdk.call(names.execute, { operation: "read", requestJson: JSON.stringify(call) });
  // Safe code/status avoids a generic DTO parse hiding the actual owner gate.
  expect({ isError: response.isError, kind: response.packet.kind, code: response.packet.data.code ?? null, status: response.packet.data.status ?? null })
    .toMatchObject({ isError: false, kind: "read" });
  const result = AgentResourceResultSchema.parse(response.packet.data); await verifyAgentResourceResult(result, call);
  return { result, call };
}

describe.sequential("independent original ERP resources through personal HTTP and official MCP", () => {
  beforeAll(async () => {
    journalChecksum = f.sha(await readFile(journalPath));
    await f.initialize(); sourceTeam = await f.base.team(f.base.a); source = await f.seed(await f.current(f.base.a), sourceTeam.teamId);
    await f.startHttp();
  }, 120_000);
  afterEach(async () => {
    f.controls.afterRead = undefined;
    for (const actor of [f.base.a, f.base.second, f.base.foreign]) { await f.base.memberActive(actor, true); await f.base.scopes(actor, resourceScopes()); }
    const errors: unknown[] = [];
    for (const sdk of clients.splice(0)) try { await sdk.close(); expect(sdk.evidence.processExited).toBe(true); expect(sdk.evidence.credentialLeaked).toBe(false); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Resource MCP subprocess teardown failed");
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try { expect(f.sha(await readFile(journalPath))).toBe(journalChecksum); } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Exact disposable resource fixture teardown failed");
  });

  it("reads all six actual original owners using only official MCP discovery and preserves independently specified quantities currency and unapproved states", async () => {
    const sdk = await client(), context = await f.current(f.base.a), before = await f.state(context), tools = await sdk.client.listTools();
    expect(tools.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(names).sort());
    for (const tool of keys) {
      const { result } = await sdkRead(sdk, tool, source.inputs[tool]);
      expect(result.coverage).toMatchObject({ kind: "single_object_projection", complete: false }); expect(result.sources.length).toBeGreaterThan(0);
      if (result.tool === "research.evidence") {
        expect(result.data.snapshot.price).toEqual({ raw: "$20.00", amount: 20, currency: "USD" });
        expect(result.data.source.studyRevisionId).toBe(source.source.revision.id); expect(result.data.source.content?.theme).toBe("Synthetic geometric print");
      } else if (result.tool === "catalog.sku") {
        expect(result.data.recipe?.status).toBe("pending_adaptation");
        expect(result.data.recipe?.specification.facts.physicalDimensions).toEqual({ basis: "flat_piece", unit: "mm", length: 60, width: 40, height: null });
        expect(result.data.recipe?.specification.facts.packageQuantity).toBe(1); expect(result.data.recipe?.specification.facts.material).toBe("Synthetic QA fabric");
        expect(result.data.recipe?.specification.processProfileVersionId).not.toBeNull(); expect(result.data.packages).toHaveLength(0);
      } else if (result.tool === "listing.version") {
        expect(result.data.listing.status).toBe("draft"); expect(result.data.version.status).toBe("draft"); expect(result.data.version.validation.blockers.length).toBeGreaterThan(0);
        expect(result.data.version.content.mediaAssetIds).toEqual([]); expect(result.data.version.id).toBe(source.listing.version.id);
      } else if (result.tool === "orders.order") {
        expect(result.data.lines[0]?.quantity).toBe(3); expect(result.data.lines[0]?.unitPrice).toEqual({ amountMinor: 4115, currency: "USD" });
        expect(result.data.orderTotal).toEqual({ amountMinor: 12345, currency: "USD" });
        expect(result.data.externalOrderId).toBe(source.order.value.externalOrderId);
        expect(result.data.lines[0]?.externalLineId).toBe(source.order.value.lines[0]?.externalLineId);
        expect(result.data.lines[0]?.externalListingId).toBeNull();
        for (const privateText of ["SYNTHETIC_PRIVATE_CODE", "recipientName", "addressLine1", "protectedDetails", "customerEmail"])
          expect(JSON.stringify(result.data).includes(privateText)).toBe(false);
      } else if (result.tool === "finance.profit_run") {
        expect(result.data).toMatchObject({ status: "complete", reportingCurrency: "USD", revenueMinor: 10000, costMinor: 4700, profitMinor: 5300, marginBps: 5300 });
        expect(result.data.statementIds).toEqual([source.profit.statement.id]);
        expect(result.data.contributions.map(row => row.reportingAmountMinor).sort((a, b) => a === null ? -1 : b === null ? 1 : a - b)).toEqual([4700, 10000]);
      } else {
        const totals = result.data.result.totals; expect(totals).toHaveLength(1);
        expect(totals[0]).toMatchObject({ currency: "USD", marketplace: "US", metrics: { impressions: 1000, clicks: 40, purchases: 4, spendMinor: 1000, salesMinor: 4000 } });
        expect(result.data.result.evidenceImportIds.sort()).toEqual(source.ad.imported.imports.map(row => row.id).sort());
        expect(result.data.result.measurementPins?.every(pin => pin.measurement?.monetaryBasis?.currency === "USD")).toBe(true);
      }
      expect(JSON.stringify(result).includes("X-Amz-Signature")).toBe(false); expect(JSON.stringify(result).includes("contentBase64")).toBe(false);
    }
    expect(await f.state(context)).toEqual(before); expect(before.providerRequests).toBe(0); expect(before.paidDispatches).toBe(0);
    expect(sdk.evidence.environmentKeys.some(key => /DATABASE|S3|MODEL|REDIS|COOKIE/i.test(key))).toBe(false);
  }, 120_000);

  it("discovers real bounded candidates including two-stage advertising account choices without claiming a complete cross-domain collection", async () => {
    const context = await f.current(f.base.a), sdk = await client(), before = await f.state(context);
    const queries = [
      { tool: "research.evidence", q: source.id }, { tool: "catalog.sku", q: source.id, page: 1, pageSize: 25 },
      { tool: "listing.version", q: source.id, page: 1, pageSize: 25 }, { tool: "orders.order", filters: { limit: 100 } },
      { tool: "finance.profit_run" }, { tool: "advertising.analysis", accountId: null, cursor: null, pageSize: 25 },
      { tool: "advertising.analysis", accountId: source.ad.shop.id, cursor: null, pageSize: 25 },
    ];
    for (const raw of queries) {
      const query = AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, ...raw });
      const response = await sdk.call(names.execute, { operation: "read", requestJson: JSON.stringify(AgentResourceMcpCandidatesRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, kind: "candidates", query })) });
      expect(response.isError).toBe(false);
      const value = AgentResourceCandidatesSchema.parse(response.packet.data); await verifyAgentResourceCandidates(value, query);
      expect(value.coverage.complete).toBe(false); expect(value.coverage.returned).toBe(value.items.length); expect(value.items.length).toBeGreaterThan(0);
      if (query.tool === "advertising.analysis") expect(value.items.some(row => row.id === (query.accountId === null ? source.ad.shop.id : source.ad.run.id))).toBe(true);
      else expect(value.items.some(row => row.id === (query.tool === "research.evidence" ? source.source.capture.researchItemId : query.tool === "catalog.sku" ? source.sku.recipe.skuId :
        query.tool === "listing.version" ? source.listing.listing.id : query.tool === "orders.order" ? source.order.value.id : source.profit.run.id))).toBe(true);
    }
    expect(await f.state(context)).toEqual(before);
  });

  it("reads immutable research Listing and monetary histories while refusing a stale current-order sequence", async () => {
    const context = await f.current(f.base.a), oldResearch = await readCall("research.evidence", source.inputs["research.evidence"]),
      oldListing = await readCall("listing.version", source.inputs["listing.version"]), oldProfit = await read(await readCall("finance.profit_run", source.inputs["finance.profit_run"])),
      oldAd = await read(await readCall("advertising.analysis", source.inputs["advertising.analysis"]));
    await f.research.save(context, source.source.capture.researchItemId, { requestId: randomUUID(), snapshotId: source.source.capture.snapshotId, expectedVersion: 1,
      content: ResearchStudyContentSchema.parse({ ...source.source.revision.content, theme: "A later independent study", differentiation: "A later proposal cannot replace an explicitly pinned old revision" }) });
    await f.facts.captures.createSnapshot(context, { ...source.source.draft, title: "A newer captured title", capturedAt: new Date().toISOString() });
    await f.listings.saveVersion(context, source.listing.listing.id, { ...source.listing.version.content, title: "A newer unapproved Listing draft" }, "human", source.listing.version.id);
    const original = await read(oldResearch); if (original.tool !== "research.evidence") throw new Error("Original research branch missing");
    expect(original.data.snapshot.title).toBe(source.source.draft.title); expect(original.data.source.content).toEqual(source.source.revision.content);
    const noStudy = await read(await readCall("research.evidence", { ...source.inputs["research.evidence"], studyRevisionId: null }));
    if (noStudy.tool !== "research.evidence") throw new Error("Original no-study branch missing");
    expect(noStudy.data.source.content).toBeNull(); expect(noStudy.data.source.studyVersion).toBe(0);
    const listing = await read(oldListing); if (listing.tool !== "listing.version") throw new Error("Original Listing branch missing");
    expect(listing.data.version.id).toBe(source.listing.version.id); expect(listing.data.version.content.title).toBe(source.listing.version.content.title);
    const before = await f.state(context);
    expect(await read(await readCall("finance.profit_run", source.inputs["finance.profit_run"]))).toMatchObject({ data: oldProfit.data, dataChecksum: oldProfit.dataChecksum });
    expect(await read(await readCall("advertising.analysis", source.inputs["advertising.analysis"]))).toMatchObject({ data: oldAd.data, dataChecksum: oldAd.dataChecksum });
    expect(await f.state(context)).toEqual(before);
    const seed = createEntityId(), changed = await f.orderSource(context, seed), stale = await readCall("orders.order", { orderId: changed.value.id, expectedSequence: changed.value.latestEventSequence });
    await f.base.orders.ingestNormalized(context, { accountId: changed.shop.id, platform: "etsy", externalEventId: `${seed}:2`, externalOrderId: seed,
      providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 12345, currency: "USD" }, lines: [{ externalLineId: `${seed}-line`,
        externalListingId: null, skuCode: null, title: "Synthetic current order evidence", quantity: 3, unitPrice: { amountMinor: 4115, currency: "USD" }, customizationCount: 0 }],
      redactedSource: { fixture: seed, version: 2 }, protectedDetails: null });
    await expect(read(stale)).rejects.toMatchObject({ status: 409, response: { code: "agent_resources_source_changed" } });
  });

  it("enforces original tenant object self and actual team boundaries instead of borrowing an unrelated tenant-scoped permission", async () => {
    const owner = await f.current(f.base.a), foreign = await f.current(f.base.foreign), before = await f.state(owner);
    for (const tool of keys) await expect(read(await readCall(tool, source.inputs[tool], foreign), foreign)).rejects.toMatchObject({ status: 404 });
    const ownSelf = await f.base.scopes(f.base.a, Object.fromEntries(Object.values(Permission).map(bit => [bit, "self"])));
    for (const tool of ["research.evidence", "catalog.sku", "listing.version", "advertising.analysis"] as const)
      expect((await read(await readCall(tool, source.inputs[tool], ownSelf), ownSelf)).tool).toBe(tool);
    const peer = await f.base.scopes(f.base.second, { ...resourceScopes(), [Permission.ResearchRead]: "self", [Permission.ProductRead]: "self",
      [Permission.DesignRead]: "self", [Permission.AssetRead]: "self", [Permission.ListingRead]: "self", [Permission.CustomerIntelligenceRead]: "self" });
    for (const tool of ["research.evidence", "catalog.sku", "listing.version", "advertising.analysis"] as const)
      await expect(read(await readCall(tool, source.inputs[tool], peer), peer)).rejects.toMatchObject({ status: 404 });
    await f.base.scopes(f.base.a, resourceScopes());
    const memberId = await f.joinTeam(f.base.second, sourceTeam.teamId);
    const team = await f.base.scopes(f.base.second, { ...resourceScopes(), [Permission.ProductRead]: "team", [Permission.ListingRead]: "self" });
    const shared = await read(await readCall("catalog.sku", source.inputs["catalog.sku"], team), team);
    if (shared.tool !== "catalog.sku") throw new Error("Actual team SKU branch missing");
    // The native capability flag requires the three permissions to exist;
    // package rows still use their own original object/scope filter.
    expect(shared.data.skuId).toBe(source.sku.recipe.skuId); expect(shared.data.packageRead).toBe(true); expect(shared.data.packages).toEqual([]);
    const withoutListing = Object.fromEntries(Object.entries(resourceScopes()).filter(([bit]) => bit !== Permission.ListingRead));
    const noPackageRead = await f.base.scopes(f.base.second, { ...withoutListing, [Permission.ProductRead]: "team" });
    expect(noPackageRead.permissions.includes(Permission.ListingRead)).toBe(false);
    const unavailablePackages = await read(await readCall("catalog.sku", source.inputs["catalog.sku"], noPackageRead), noPackageRead);
    if (unavailablePackages.tool !== "catalog.sku") throw new Error("Actual no-package-permission SKU branch missing");
    expect(unavailablePackages.data.skuId).toBe(source.sku.recipe.skuId);
    expect(unavailablePackages.data.packageRead).toBe(false); expect(unavailablePackages.data.packages).toEqual([]);
    await f.base.teamActive(f.base.second, memberId, false);
    const revoked = await f.current(f.base.second);
    await expect(read(await readCall("catalog.sku", source.inputs["catalog.sku"], revoked), revoked)).rejects.toMatchObject({ status: 404 });
    const narrow = await f.base.scopes(f.base.a, { ...resourceScopes(), [Permission.OrderRead]: "self", [Permission.FinanceRead]: "self" });
    for (const tool of ["orders.order", "finance.profit_run"] as const)
      await expect(read(await readCall(tool, source.inputs[tool], narrow), narrow)).rejects.toMatchObject({ status: 403 });
    expect(await f.state(await f.current(f.base.a))).toEqual(before);

    // Object ownership can change without changing this reader's membership
    // stamp. Both the admission and the withdrawal use their genuine owners.
    await f.base.scopes(f.base.a, resourceScopes()); await f.base.teamActive(f.base.second, memberId, true);
    const stableTeam = await f.base.scopes(f.base.second, { ...resourceScopes(), [Permission.ProductRead]: "team", [Permission.ListingRead]: "self" });
    const teamAuthority = (await f.service.workspace(stableTeam)).contextAuthority;
    const entered = deferred(), release = deferred(); let gated = false;
    const own = await f.current(f.base.a), currentSpu = (await f.facts.development.options(own)).spus.find(row => row.id === source.sku.spu.id);
    if (!currentSpu) throw new Error("Original SPU owner did not return its current revision");
    const input = { code: currentSpu.code, name: currentSpu.name, description: currentSpu.description,
      ...(currentSpu.capabilities ? { capabilities: currentSpu.capabilities } : {}) };
    let moved: Awaited<ReturnType<typeof f.facts.development.updateSpu>> | undefined;
    const paidBefore = await f.state(own);
    f.controls.afterRead = async (context, call) => {
      if (!gated && context.userId === stableTeam.userId && call.tool === "catalog.sku") { gated = true; entered.resolve(); await release.promise; }
    };
    const pending = read(await readCall("catalog.sku", source.inputs["catalog.sku"], stableTeam), stableTeam);
    try {
      await bounded(entered.promise, "Actual team SKU read did not reach its completed-owner gate");
      moved = await f.facts.development.updateSpu(own, currentSpu.id, { ...input, teamId: null, expectedRevision: currentSpu.revision, idempotencyKey: randomUUID() });
      expect((await f.service.workspace(stableTeam)).contextAuthority).toBe(teamAuthority);
      expect((await f.service.workspace(await f.current(f.base.second))).contextAuthority).toBe(teamAuthority);
      release.resolve(); await expect(pending).rejects.toMatchObject({ status: 404 });
      const after = await f.state(own);
      for (const table of ["ai_budget_ledger", "ai_assist_runs", "agent_plan_runs", "agent_command_requests"])
        expect(after.tables[table]).toEqual(paidBefore.tables[table]);
      expect(after.providerRequests).toBe(paidBefore.providerRequests); expect(after.paidDispatches).toBe(paidBefore.paidDispatches);
    } finally {
      release.resolve(); f.controls.afterRead = undefined; await pending.catch(() => undefined);
      if (moved) await f.facts.development.updateSpu(own, currentSpu.id, { ...input, teamId: sourceTeam.teamId,
        expectedRevision: moved.spu.revision, idempotencyKey: randomUUID() });
      await f.base.teamActive(f.base.second, memberId, false);
      await f.base.scopes(f.base.a, resourceScopes()); await f.base.scopes(f.base.second, resourceScopes());
    }
  });

  it("discards an actual completed owner read after current membership narrows before its personal HTTP response", async () => {
    const context = await f.current(f.base.a), call = await readCall("orders.order", source.inputs["orders.order"]), entered = deferred(), release = deferred();
    const before = await f.state(context), count = f.readCalls.length;
    f.controls.afterRead = async (_context, value) => { if (value.tool === "orders.order") { entered.resolve(); await release.promise; } };
    const origin = await f.startHttp(), token = await f.token(), pending = fetch(origin + "/v1/agent-resources/call", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(call) });
    try {
      await bounded(entered.promise, "Actual resource owner did not reach its late response gate");
      await f.base.scopes(f.base.a, { ...resourceScopes(), [Permission.OrderRead]: "self" }); release.resolve();
      const response = await pending, body = await response.json() as { code?: string };
      expect(response.status).toBe(409); expect(body.code).toBe("authority_changed"); expect(JSON.stringify(body).includes(source.order.value.id)).toBe(false);
      expect(f.readCalls.length - count).toBe(1); expect(await f.state(await f.current(f.base.a))).toEqual(before);
    } finally { release.resolve(); f.controls.afterRead = undefined; await pending; }
  });

  it("rejects altered definitions pins source associations strict HTTP bodies and API-client admission without creating a task or paying", async () => {
    const context = await f.current(f.base.a), call = await readCall("research.evidence", source.inputs["research.evidence"]), before = await f.state(context);
    await expect(read({ ...call, definitionChecksum: "0".repeat(64) })).rejects.toMatchObject({ status: 409, response: { code: "agent_resources_definition_changed" } });
    await expect(read({ ...call, executionContract: { ...call.executionContract, checksum: "0".repeat(64) } })).rejects.toMatchObject({ status: 409, response: { code: "agent_resources_contract_changed" } });
    const result = await read(call), tampered = structuredClone(result);
    if (tampered.tool !== "research.evidence") throw new Error("Actual research branch missing");
    tampered.data.source.snapshotId = createEntityId(); tampered.dataChecksum = await f.checksum(agentResourceDataPayload(tampered));
    await expect(verifyAgentResourceResult(tampered, call)).rejects.toThrow();
    const origin = await f.startHttp(), token = await f.token(), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const invalid = await fetch(origin + "/v1/agent-resources/call", { method: "POST", headers, body: JSON.stringify({ ...call, tenantId: f.base.foreign.tenantId }) });
    expect(invalid.status).toBe(400); expect((await invalid.json() as { code?: string }).code).toBe("agent_resources_input_invalid");
    expect((await fetch(origin + "/v1/agent-resources/workspace?extra=1", { headers })).status).toBe(400);
    expect((await fetch(origin + "/v1/agent-resources/workspace", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    const signed = await f.base.integration.createApiClient(context, { label: `Synthetic resource API client ${createEntityId()}`, scopes: ["inventory:read"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: randomUUID() });
    if (signed.bearerToken === null) throw new Error("Original API-client owner did not issue its one-time test credential");
    const denied = await fetch(origin + "/v1/agent-resources/definition", { method: "POST", headers: { ...headers, authorization: `Bearer ${signed.bearerToken}` },
      body: JSON.stringify({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence" }) });
    expect(denied.status).toBe(403); expect(await f.state(context)).toMatchObject({ providerRequests: before.providerRequests, paidDispatches: before.paidDispatches });
    await f.base.integration.revokeApiClient(context, signed.client.id, { expectedStatus: "active", reasonCode: "SYNTHETIC_COMPLETED", idempotencyKey: randomUUID() });
  });

  it("keeps the default49 catalog and five MCP entrances unchanged and makes every resource an explicit startup opt-in while old reads become self-contained", async () => {
    const sdk = await client([]), context = await f.current(f.base.a), before = await f.state(context), deniedCount = f.readCalls.length;
    const catalog = await sdk.call(names.search, {}); expect(catalog.isError).toBe(false); expect(catalog.packet.data.registrySize).toBe(49);
    expect((catalog.packet.data.entries as Array<{ key: string }>).some(row => row.key.startsWith("resource/"))).toBe(false);
    // Without resource opt-in the official SDK rejects this key against its
    // advertised strict input before the ERP packet handler is entered.
    const denied = await sdk.client.callTool({ name: names.schema, arguments: { key: "resource/research.evidence" } });
    expect(denied.isError === true).toBe(true); expect(denied.structuredContent === undefined).toBe(true);
    expect(f.readCalls.length).toBe(deniedCount); expect(await f.state(context)).toEqual(before);
    const scoped = await client(["--allow-resource=research.evidence"]), scopedCatalog = await scoped.call(names.search, {});
    expect(scopedCatalog.isError).toBe(false); expect(scopedCatalog.packet.data.registrySize).toBe(55);
    const selectedResources = (scopedCatalog.packet.data.entries as Array<{ key: string; available: boolean; blockReason: string | null }>).filter(row => row.key.startsWith("resource/"));
    expect(selectedResources).toHaveLength(6); expect(selectedResources.filter(row => row.available).map(row => row.key)).toEqual(["resource/research.evidence"]);
    expect(selectedResources.filter(row => row.key !== "resource/research.evidence").every(row => row.blockReason === "startup_policy_denied")).toBe(true);
    expect((await scoped.call(names.schema, { key: "resource/finance.profit_run" })).isError).toBe(true);
    const old = await sdk.call(names.schema, { key: "read/orders.exceptions.page" }); expect(old.isError).toBe(false);
    const definition = AgentToolDefinitionSchema.parse(old.packet.data.definition); await verifyAgentToolDefinitionTransport(definition, { kind: "read", tool: "orders.exceptions.page" });
    const oldCall = AgentToolCallSchema.parse({ version: "erp-agent-tools-v1", definitionChecksum: definition.definitionChecksum,
      executionContract: HarnessExecutionContractSchema.parse(old.packet.data.executionContract), tool: "orders.exceptions.page", input: { status: "all", orderId: source.order.value.id, pageSize: 25, cursor: null } });
    const response = await sdk.call(names.execute, { operation: "read", requestJson: JSON.stringify(oldCall) }); expect(response.isError).toBe(false);
    await verifyAgentToolTransport(AgentToolResultSchema.parse(response.packet.data), oldCall);
    expect((await sdk.call(names.schema, { key: "native/start" })).packet.data.startupEnabled).toBe(false);
    expect(await f.state(context)).toEqual(before);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.at(-1)?.tag).toBe("0175_agent_native"); expect(f.sha(await readFile(journalPath))).toBe(journalChecksum);
  });

  it("preserves an actually incomplete profit run and old ad measurement cutoffs without converting unknown costs into zero or recalculating on GET", async () => {
    const context = await f.current(f.base.a), incomplete = await f.financeSource(context, createEntityId(), false), before = await f.state(context);
    const value = await read(await readCall("finance.profit_run", { runId: incomplete.run.id }));
    if (value.tool !== "finance.profit_run") throw new Error("Actual incomplete finance branch missing");
    expect(value.data.status).toBe("incomplete"); expect(value.data.profitMinor).toBeNull(); expect(value.data.costMinor).toBeNull();
    expect(value.data.reportingCurrency).toBe("USD"); expect(value.data.diagnostics.missingFactTypes).toContain("production_cost");
    const original = await read(await readCall("advertising.analysis", source.inputs["advertising.analysis"]));
    if (original.tool !== "advertising.analysis") throw new Error("Actual saved advertising branch missing");
    expect(original.data.evidenceCutoffAt).toBe(source.ad.run.evidenceCutoffAt);
    expect(original.data.result.measurementPins).toEqual(source.ad.run.result.measurementPins);
    expect(original.data.result.goalVersionIds).toEqual([source.ad.goal.id]);
    expect(await f.state(context)).toEqual(before);
  });
});
