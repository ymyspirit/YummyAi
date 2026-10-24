import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { AGENT_MCP_TOOL_NAMES as names } from "@yummyai/contracts/ai/agent-mcp";
import { AGENT_NATIVE_VERSION, AgentNativeItemReceiptSchema, AgentNativeReceiptSchema, AgentNativeViewSchema, type AgentNativeView } from "@yummyai/contracts/ai/agent-native";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolDefinitionSchema, AgentToolResultSchema, type AgentToolCall, type AgentToolKey } from "@yummyai/contracts/ai/agent-tools";
import { verifyAgentNativeTransport, verifyAgentToolDefinitionTransport, verifyAgentToolTransport } from "@yummyai/contracts/ai/agent-transport";
import { connectDatabase, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { bounded, deferred } from "./agent-read.test-fixture.js";
import { agentMcpFixture, openMcpClient, requireAgentMcpEnvironment } from "./agent-mcp.test-fixture.js";

const environment = requireAgentMcpEnvironment(), database = connectDatabase(environment.url), f = agentMcpFixture(database), native = f.native;
const allScopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
type Client = Awaited<ReturnType<typeof openMcpClient>>;
const clients: Client[] = [];
const paid = ["--allow-model-run", "--max-cost-usd=1", "--allow-prepare", "--allow-command=procurement/requisition_create", "--allow-command=finance/bill_record"];
let source: Awaited<ReturnType<typeof f.seed>>;
async function client(flags: readonly string[] = [], actor = native.base.a, seconds = 300) {
  const value = await openMcpClient(f.origin, await f.token(actor, seconds), flags); clients.push(value); return value;
}
async function readCall(tool: AgentToolKey, input: unknown, sdk: Client): Promise<AgentToolCall> {
  const definition = await sdk.call(names.schema, { key: "read/" + tool }); expect(definition.isError).toBe(false);
  const parsed = AgentToolDefinitionSchema.parse(definition.packet.data.definition);
  await verifyAgentToolDefinitionTransport(parsed, { kind: "read", tool });
  const workspace = await native.gateway.workspace(await native.base.current(native.base.a));
  return AgentToolCallSchema.parse({ version: AGENT_TOOLS_VERSION, executionContract: workspace.executionContract, definitionChecksum: parsed.definitionChecksum, tool, input });
}
async function actualRead(sdk: Client, call: AgentToolCall) {
  const response = await sdk.call(names.execute, { operation: "read", requestJson: JSON.stringify(call) });
  expect(response.isError).toBe(false); expect(response.packet.kind).toBe("read");
  const result = AgentToolResultSchema.parse(response.packet.data); await verifyAgentToolTransport(result, call); return result;
}
const requestPosts = (path: string) => f.requests.filter(row => row.method === "POST" && row.path === path).length;
async function start(sdk: Client, full = false) {
  const input = await native.request(native.base.a, { bindings: full ? source.bindings : [{ tool: "inventory.balances.page", scope: { stockItemId: source.stockItemId } }],
    contextText: source.contextText, allowedCommands: full ? [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }] : [] });
  const response = await sdk.call(names.execute, { operation: "start", requestJson: JSON.stringify(input) });
  expect(response.isError).toBe(false); return { input, view: AgentNativeViewSchema.parse(response.packet.data) };
}
async function saved(sdk: Client, id: string): Promise<AgentNativeView> {
  const response = await sdk.call(names.savedResult, { kind: "run", id }); expect(response.isError).toBe(false);
  const value = AgentNativeViewSchema.parse(response.packet.data); await verifyAgentNativeTransport(value); return value;
}

describe.sequential("official MCP stdio through personal OIDC native owners and original receipts", () => {
  beforeAll(async () => { await f.initialize(); source = await f.seed(await native.base.current(native.base.a)); await f.startHttp(); }, 120_000);
  afterEach(async () => {
    f.controls.afterHttp = undefined; f.controls.dropNext = null; native.clear(); await native.base.scopes(native.base.a, allScopes());
    const context = await native.base.current(native.base.a);
    for (const run of (await native.rows(context)).runs.filter(row => row.version === AGENT_NATIVE_VERSION && ["queued", "running", "stopping"].includes(row.status))) {
      await native.service().stop(context, run.id, { version: AGENT_NATIVE_VERSION, requestId: run.requestId }); await native.runtime().process(context, run.id);
    }
    await native.settlePrepared();
    const errors: unknown[] = [];
    for (const sdk of clients.splice(0)) { try { await sdk.close(); expect(sdk.evidence.processExited).toBe(true); expect(sdk.evidence.credentialLeaked).toBe(false); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Official MCP client teardown failed");
  });
  afterAll(async () => { const errors: unknown[] = []; try { await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "MCP real resource teardown failed"); });

  it("handshakes with the official SDK lists exactly five entrances and reads one unchanged original definition without paying or exposing business execution", async () => {
    const before = await native.rows(), business = await native.business(), sdk = await client(), tools = await sdk.client.listTools();
    expect(tools.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(names).sort());
    const catalog = await sdk.call(names.search, {}); expect(catalog.isError).toBe(false); expect(catalog.packet.kind).toBe("capabilities");
    expect(catalog.packet.data).toMatchObject({ registrySize: 49, totalMatched: 49, complete: true, apiClientCredentials: "not_supported", businessExecution: "separate_original_confirmation" });
    const entries = catalog.packet.data.entries as Array<{ kind: string; key: string; available: boolean }>;
    expect(entries.filter(row => row.kind === "read")).toHaveLength(5); expect(entries.filter(row => row.kind === "command")).toHaveLength(37);
    expect(entries.filter(row => row.kind === "command" && row.available)).toHaveLength(0); expect(entries.find(row => row.key === "native/start")?.available).toBe(false);
    const definition = await sdk.call(names.schema, { key: "command/finance/bill_record" }), original = AgentToolDefinitionSchema.parse(definition.packet.data.definition);
    await verifyAgentToolDefinitionTransport(original, { kind: "command", command: { domain: "finance", kind: "bill_record" } });
    expect(definition.packet.data.startupEnabled).toBe(false); expect(original.selection).toEqual({ kind: "command", command: { domain: "finance", kind: "bill_record" } });
    expect(await native.rows()).toEqual(before); expect(await native.business()).toEqual(business); expect(native.modelCalls).toHaveLength(0);
    expect(sdk.evidence.injectedEnvironmentKeys.some(key => /DATABASE|S3|MODEL|REDIS|COOKIE/i.test(key))).toBe(false);
  });

  it("calls all five real readers preserves topK and source checksums and rejects changed query data and definitions without preparing or executing anything", async () => {
    const sdk = await client(), before = await native.rows(), business = await native.business();
    const inputs: Array<[AgentToolKey, unknown]> = [
      ["orders.exceptions.page", { status: "all", orderId: source.order.id, pageSize: 100, cursor: null }],
      ["inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 100, cursor: null }],
      ["knowledge.search", { query: source.query, topic: "operations", platform: "all", market: "ALL", spuIds: [] }],
      ["creative.history", { scope: "inspection", ownerId: source.compiled.id }],
      ["factory.capacity", { factoryId: source.site.factory.id.toUpperCase(), query: { from: source.pool.localDate, days: 2 } }],
    ];
    for (const [tool, input] of inputs) {
      const call = await readCall(tool, input, sdk), result = await actualRead(sdk, call);
      await expect(verifyAgentToolTransport({ ...result, inputChecksum: "0".repeat(64) }, call)).rejects.toThrow();
      await expect(verifyAgentToolTransport({ ...result, dataChecksum: "0".repeat(64) }, call)).rejects.toThrow();
      if (result.tool === "knowledge.search") {
        expect(result.coverage).toMatchObject({ kind: "ranked_subset", complete: false, returned: 6 });
        for (const reference of result.data.references) {
          expect(source.published).toContain(reference.entryId); expect(reference.entryId).not.toBe(source.draftId);
          const [version] = await withTenant(database.db, native.base.a.context, tx => tx.execute<{ checksum: string }>(sql`select checksum from knowledge_versions where id=${reference.versionId}::uuid`));
          expect(reference.checksum).toBe(version?.checksum);
        }
        const other = AgentToolCallSchema.parse({ ...call, input: { ...call.input, query: source.query + " different" } });
        await expect(verifyAgentToolTransport(result, other)).rejects.toThrow();
      } else if (result.tool === "creative.history") expect(result.data.entries.some(row => row.phase === "completed" && row.artifacts.length > 0)).toBe(true);
      else if (result.tool === "factory.capacity") expect(result.data.factoryId.toLowerCase()).toBe(source.site.factory.id.toLowerCase());
      else if (result.tool === "orders.exceptions.page") expect(JSON.stringify(result.data).includes("SYNTHETIC_PRIVATE_CODE")).toBe(false);
    }
    const definition = await sdk.call(names.schema, { key: "read/knowledge.search" }), original = AgentToolDefinitionSchema.parse(definition.packet.data.definition);
    await expect(verifyAgentToolDefinitionTransport({ ...original, outputSchema: {} }, original.selection)).rejects.toThrow();
    expect(await native.rows()).toEqual(before); expect(await native.business()).toEqual(business); expect(native.modelCalls).toHaveLength(0);
  });

  it("reads all501 real inventory dimensions without a limit500 prefix and rejects a cursor after an original movement changes its entire collection", async () => {
    const sdk = await client(), stock = await native.base.stock(native.base.a, 501), before = await native.rows(), business = await native.business();
    let cursor: string | null = null, count = 0; const ids = new Set<string>();
    do {
      const call = await readCall("inventory.balances.page", { stockItemId: stock.stockItemId, pageSize: 100, cursor }, sdk), result = await actualRead(sdk, call);
      if (result.tool !== "inventory.balances.page") throw new Error("Original inventory result missing");
      for (const row of result.data.items) { ids.add(row.dimensionKey); expect(row.physicalQuantity).toBe("1.000000001"); }
      count += result.data.items.length; expect(result.data.total).toBe(501); expect(result.data.readCount).toBe(count); cursor = result.data.nextCursor;
      expect(result.data.complete).toBe(cursor === null);
    } while (cursor);
    expect(count).toBe(501); expect(ids.size).toBe(501);
    const firstCall = await readCall("inventory.balances.page", { stockItemId: stock.stockItemId, pageSize: 100 }, sdk), first = await actualRead(sdk, firstCall);
    if (first.tool !== "inventory.balances.page" || !first.data.nextCursor) throw new Error("Original page cursor missing");
    await native.base.inventory.recordMovement(native.base.a.context, { stockItemId: stock.stockItemId, locationId: stock.locations[0]!, lotId: null, bucket: "physical", type: "adjustment",
      quantityDelta: "1", unit: "meter", sourceType: "manual", sourceId: "mcp:" + randomUUID(), reasonCode: "COUNT_CORRECTION", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    const changedCall = AgentToolCallSchema.parse({ ...firstCall, input: { ...firstCall.input, cursor: first.data.nextCursor } });
    const changed = await sdk.call(names.execute, { operation: "read", requestJson: JSON.stringify(changedCall) });
    expect(changed.isError).toBe(true); expect(changed.packet.data).toMatchObject({ code: "mcp_http_failed", status: 409 });
    expect(await native.rows()).toEqual(before); expect((await native.business()).finance_payable_bills).toEqual(business.finance_payable_bills);
  }, 120_000);

  it("authenticates actual membership rejects foreign objects narrow per-bit scopes disabled members and genuinely expired short JWTs", async () => {
    const sdk = await client(), before = await native.rows(), call = await readCall("creative.history", { scope: "inspection", ownerId: source.compiled.id }, sdk);
    const foreign = await client([], native.base.foreign), denied = await foreign.call(names.execute, { operation: "read", requestJson: JSON.stringify(call) });
    expect(denied.isError).toBe(true); expect(denied.packet.kind).toBe("error");
    await native.base.scopes(native.base.a, { ...allScopes(), [Permission.InventoryRead]: "self" });
    const inventory = await readCall("inventory.balances.page", { stockItemId: source.stockItemId }, sdk), narrow = await sdk.call(names.execute, { operation: "read", requestJson: JSON.stringify(inventory) });
    expect(narrow.isError).toBe(true); expect(narrow.packet.data.status).toBe(403);
    await native.base.scopes(native.base.a, allScopes());
    await native.base.memberActive(native.base.a, false);
    try { expect((await sdk.call(names.search, {})).isError).toBe(true); } finally { await native.base.memberActive(native.base.a, true); }
    const expiring = await client([], native.base.a, 1); await expiring.call(names.search, {}); await delay(2_100);
    const expired = await expiring.call(names.search, {}); expect(expired.isError).toBe(true); expect(expired.packet.data).toMatchObject({ code: "mcp_identity_required", status: 401 });
    expect(await native.rows()).toEqual(before);
  });

  it("uses the actual Redis routed model decisions then prepares two original commands only under explicit policy without exposing any confirmation or execution tool", async () => {
    const readOnly = await client(), input = await native.request(native.base.a), posts = requestPosts("/v1/agent-native/runs");
    const denied = await readOnly.call(names.execute, { operation: "start", requestJson: JSON.stringify(input) }); expect(denied.packet.data.code).toBe("mcp_policy_denied");
    expect(requestPosts("/v1/agent-native/runs")).toBe(posts);
    const sdk = await client(paid), before = await native.business(), created = await start(sdk, true);
    const queue = await f.queued(created.view.id); expect(queue).toMatchObject({ id: created.view.id, tenantId: native.base.a.tenantId, requestedBy: native.base.a.userId, operation: "execute" });
    await f.process(await native.base.current(native.base.a), created.view.id, source.originals, source.query);
    const view = await saved(sdk, created.view.id); expect(view.status).toBe("completed"); expect(view.cost).toMatchObject({ knownCostUsd: "0.002730", modelTurns: 13, coverage: "known" });
    expect(view.observations).toHaveLength(5); expect(view.items).toHaveLength(2); expect(await native.business()).toEqual(before);
    const altered = structuredClone(view); altered.result!.proposals[0]!.proposalChecksum = "0".repeat(64);
    await expect(verifyAgentNativeTransport(altered)).rejects.toThrow();
    const alteredData = structuredClone(view); alteredData.observations[0]!.basisChecksum = "0".repeat(64);
    await expect(verifyAgentNativeTransport(alteredData)).rejects.toThrow();
    const modelCalls = native.modelCalls.length;
    for (const item of view.items) {
      const prepared = await sdk.call(names.execute, { operation: "prepare", id: view.id, itemId: item.id, requestJson: JSON.stringify(native.prepareInput(view, item)) });
      expect(prepared.isError).toBe(false); const receipt = AgentNativeItemReceiptSchema.parse(prepared.packet.data); expect(receipt.disposition).toBe("known");
      const command = await sdk.call(names.savedResult, { kind: "command", id: receipt.agentCommandId!, originalChecksum: item.originalChecksum });
      expect(command.isError).toBe(false); expect(command.packet.kind).toBe("command_receipt");
      expect(Object.keys(command.packet.data).sort()).toEqual(["id", "requestId", "requestChecksum", "originalChecksum", "domain", "kind", "state", "ownerCommandId", "createdAt", "expiresAt", "reviewPath", "businessExecution"].sort());
      expect(command.packet.data.ownerCommandId).toBe(receipt.ownerCommandId); expect(command.packet.data.state).toBe("prepared");
    }
    const stable = await native.rows(), usage = await sdk.call(names.usage, { id: view.id });
    expect(usage.packet.data).toEqual({ scope: "run", id: view.id, requestId: view.requestId, status: view.status, cost: view.cost, organizationBalance: "not_provided" });
    expect(await native.rows()).toEqual(stable); expect(native.modelCalls.length).toBe(modelCalls); expect(await native.business()).toEqual(before);
    expect(f.requests.filter(row => /\/(confirm|execute|publish|pay)$/.test(row.path))).toHaveLength(0);
  });

  it("recovers committed but lost parent and preparation HTTP responses with a fresh official client and never dispatches another POST or pays on lookup", async () => {
    const sdk = await client(paid), input = await native.request(native.base.a, { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: source.stockItemId } }],
      allowedCommands: [{ domain: "finance", kind: "bill_record" }] });
    const posts = requestPosts("/v1/agent-native/runs"); f.controls.dropNext = "/v1/agent-native/runs";
    const lost = await sdk.call(names.execute, { operation: "start", requestJson: JSON.stringify(input) });
    expect(lost.isError).toBe(true); expect(lost.packet.data).toMatchObject({ code: "mcp_submission_unknown", retrySubmittedWrite: false, nextAction: "read_original_receipt_only" });
    const rows = await native.rows(), born = rows.runs.find(row => row.requestId === input.requestId)!; expect(Boolean(born)).toBe(true); expect(requestPosts("/v1/agent-native/runs")).toBe(posts + 1);
    const recovery = await client(paid), lookup = await recovery.call(names.savedResult, { kind: "request_receipt", requestId: input.requestId, requestChecksum: native.checksum(input) });
    const receipt = AgentNativeReceiptSchema.parse(lookup.packet.data); expect(receipt).toMatchObject({ disposition: "known", runId: born.id });
    expect(await native.rows()).toEqual(rows); expect(requestPosts("/v1/agent-native/runs")).toBe(posts + 1);
    await f.process(await native.base.current(native.base.a), born.id, source.originals.filter(original => original.domain === "finance"), source.query);
    const view = await saved(recovery, born.id), item = view.items[0]!, path = `/v1/agent-native/runs/${view.id}/items/${item.id}/prepare`, prepares = requestPosts(path);
    f.controls.dropNext = path;
    const prepared = await recovery.call(names.execute, { operation: "prepare", id: view.id, itemId: item.id, requestJson: JSON.stringify(native.prepareInput(view, item)) });
    expect(prepared.isError).toBe(true); expect(prepared.packet.data.code).toBe("mcp_submission_unknown");
    const state = await native.rows(), business = await native.business(), restarted = await client(paid);
    const original = { kind: "item_receipt", id: view.id, itemId: item.id, requestId: view.requestId, proposalChecksum: item.proposalChecksum };
    const found = await restarted.call(names.savedResult, original); expect(found.isError).toBe(false);
    const actual = AgentNativeItemReceiptSchema.parse(found.packet.data); expect(actual.disposition).toBe("known"); expect(Boolean(actual.ownerCommandId)).toBe(true);
    for (const wrong of [{ ...original, requestId: randomUUID() }, { ...original, proposalChecksum: "0".repeat(64) }]) {
      const rejected = await restarted.call(names.savedResult, wrong); expect(rejected.isError).toBe(true); expect(rejected.packet.kind).toBe("error");
    }
    expect(requestPosts(path)).toBe(prepares + 1); expect(await native.rows()).toEqual(state); expect(await native.business()).toEqual(business);
  });

  it("discards a completed owner response after genuine permission withdrawal and preserves a minimal owner stop after domain loss", async () => {
    const sdk = await client(paid), call = await readCall("inventory.balances.page", { stockItemId: source.stockItemId }, sdk), entered = deferred(), release = deferred(); let once = false;
    const business = await native.business(), models = native.modelCalls.length;
    f.controls.afterHttp = async request => { if (request.path === "/v1/agent-tools/call" && !once) { once = true; entered.resolve(); await release.promise; } };
    const pending = sdk.call(names.execute, { operation: "read", requestJson: JSON.stringify(call) });
    try {
      await bounded(entered.promise, "Actual owner HTTP body did not reach the late gate");
      await native.base.scopes(native.base.a, { ...allScopes(), [Permission.InventoryRead]: "self" }); release.resolve();
      const denied = await bounded(pending, "Official MCP late read did not settle"); expect(denied.isError).toBe(true); expect(denied.packet.data.code).toBe("mcp_authority_changed");
      expect(Object.keys(denied.packet.data).sort()).toEqual(["code", "status"]); expect(native.modelCalls.length).toBe(models); expect(await native.business()).toEqual(business);
    } finally { release.resolve(); f.controls.afterHttp = undefined; await native.base.scopes(native.base.a, allScopes()); }
    const created = await start(sdk); await native.base.scopes(native.base.a, { [Permission.WorkflowRead]: "self", [Permission.WorkflowRun]: "self", [Permission.InventoryRead]: "self" });
    const hidden = await saved(sdk, created.view.id); expect(hidden).toMatchObject({ privateAvailable: false, goal: null, result: null, steps: [], definitions: [], observations: [] });
    const stopped = await sdk.call(names.execute, { operation: "stop", id: created.view.id, requestJson: JSON.stringify({ version: AGENT_NATIVE_VERSION, requestId: created.input.requestId }) });
    expect(stopped.isError).toBe(false); expect(AgentNativeReceiptSchema.parse(stopped.packet.data).privateAvailable).toBe(false);
  });

  it("reports an unknown original model fee as the retained full cap and refuses invented parent item or command references without extra paid attempts", async () => {
    const sdk = await client(paid), business = await native.business(), created = await start(sdk); native.controls.unknownUsage = true;
    await f.process(await native.base.current(native.base.a), created.view.id);
    const view = await saved(sdk, created.view.id); expect(view.status).toBe("uncertain"); expect(view.cost).toMatchObject({ coverage: "unknown", reservedUsd: "1.000000", modelTurns: 1 });
    const before = await native.rows(), calls = native.modelCalls.length, usage = await sdk.call(names.usage, { id: view.id });
    expect(usage.packet.data.cost).toEqual(view.cost); expect(usage.packet.data.scope).toBe("run"); expect(usage.packet.data.organizationBalance).toBe("not_provided");
    const lookup = await sdk.call(names.savedResult, { kind: "request_receipt", requestId: created.input.requestId, requestChecksum: native.checksum(created.input) });
    expect(AgentNativeReceiptSchema.parse(lookup.packet.data).runId).toBe(view.id);
    const replay = await sdk.call(names.execute, { operation: "start", requestJson: JSON.stringify(created.input) }); expect(replay.isError).toBe(false); expect(replay.packet.data.id).toBe(view.id);
    expect(native.modelCalls.length).toBe(calls); expect(await native.rows()).toEqual(before); expect(await native.business()).toEqual(business);
  });
});
