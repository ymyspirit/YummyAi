import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_MCP_TOOL_NAMES as names } from "@yummyai/contracts/ai/agent-mcp";
import { AGENT_NATIVE_VERSION, AgentNativeWorkspaceSchema } from "@yummyai/contracts/ai/agent-native";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3ViewSchema, AgentNativeV3ReceiptSchema, AgentNativeV3ItemReceiptSchema, AgentNativeV3BindingSchema,
  type CreateAgentNativeV3 } from "@yummyai/contracts/ai/agent-native-v3";
import { verifyAgentNativeV3Transport } from "@yummyai/contracts/ai/agent-native-v3-transport";
import { AGENT_FULFILLMENT_TOOL, AgentFulfillmentResultSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import { AgentCommandViewSchema, AgentCommandOriginalSchema } from "@yummyai/contracts/ai/agent-command";
import { AGENT_RESOURCES_VERSION, AgentResourceCandidatesSchema, AgentResourceCallSchema, AgentResourceResultSchema, AgentResourceDefinitionSchema } from "@yummyai/contracts/ai/agent-resources";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { verifyAgentResourceResult, verifyAgentResourceDefinition } from "@yummyai/contracts/ai/agent-resource-transport";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { connectDatabase } from "@yummyai/database";
import { createPersonalAgentMcpSession } from "../../../agent-mcp/src/auth/session.js";
import { AgentMcpCredentialStore } from "../../../agent-mcp/src/auth/credential-store.js";
import { agentMcpAuthProfileDigest } from "../../../agent-mcp/src/auth/config.js";
import { WindowsAgentMcpDataProtection } from "../../../agent-mcp/src/auth/windows-dpapi.js";
import { openAgentMcpCodexHost } from "../../../../tools/testing/agent-mcp-codex-host.mjs";
import { bounded, deferred } from "./agent-read.test-fixture.js";
import { nativeV3Scopes } from "./agent-native-v3.test-fixture.js";
import { agentMcpV2Fixture, discoverMcpV2Request, requireAgentMcpV2Environment, mcpV2OwnedPath, type McpV2Client } from "./agent-mcp-v2.test-fixture.js";

const environment = requireAgentMcpV2Environment(), database = connectDatabase(environment.url), f = agentMcpV2Fixture(database), native = f.native;
const paid = ["--allow-native-v3", "--allow-model-run", "--max-cost-usd=1", "--allow-prepare", "--allow-command=procurement/requisition_create", "--allow-command=finance/bill_record",
  ...["research.evidence", "catalog.sku", "listing.version", "orders.order", "finance.profit_run", "advertising.analysis"].map(key => "--allow-resource=" + key), "--allow-fulfillment"];
let source: Awaited<ReturnType<typeof f.seed>>, login: Awaited<ReturnType<typeof f.login>>;
const current = () => f.context(), posts = (path: string) => f.requests.filter(row => row.method === "POST" && row.path === path).length;
const one = () => source.bindings.filter(binding => binding.tool === "inventory.balances.page");
async function saved(sdk: McpV2Client, id: string) {
  const response = await sdk.call(names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "run", id }); expect(response.isError).toBe(false);
  const view = AgentNativeV3ViewSchema.parse(response.packet.data); expect(view.id).toBe(id); await verifyAgentNativeV3Transport(view); return view;
}
async function start(sdk: McpV2Client, changes: Partial<CreateAgentNativeV3> = {}) {
  const discovered = await discoverMcpV2Request(sdk, one(), changes), response = await sdk.call(names.execute, { version: AGENT_NATIVE_V3_VERSION,
    operation: "start", requestJson: JSON.stringify(discovered.input) }); expect(response.isError, JSON.stringify(response.packet.data)).toBe(false);
  return { ...discovered, view: AgentNativeV3ViewSchema.parse(response.packet.data) };
}
async function usage(sdk: McpV2Client, id: string) { const result = await sdk.call(names.usage, { version: AGENT_NATIVE_V3_VERSION, id }); expect(result.isError).toBe(false); return result.packet.data; }

describe.sequential("MCP v2 official stdio personal PKCE and original native v3 owners", () => {
  beforeAll(async () => { await f.initialize(); source = await f.seed(); await f.startHttp(); login = await f.login(); }, 240_000);
  afterEach(async () => {
    native.clear(); f.controls.afterHttp = undefined; f.controls.dropNext = null;
    for (const actor of [native.base.a, native.base.second, native.base.foreign]) { await native.base.memberActive(actor, true); await native.base.scopes(actor, nativeV3Scopes()); }
    const context = await current(), rows = await native.rows(context);
    for (const run of rows.runs.filter(row => f.ownedRuns.has(row.id) && ["queued", "running", "stopping"].includes(row.status))) {
      await native.service().stop(context, run.id, { version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId }); await native.process(run.id);
    }
    await native.settlePrepared(context);
  });
  afterAll(async () => { const errors: unknown[] = [];
    try { await f.close(); } catch (error) { errors.push(error); } try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "MCP v2 disposable integration teardown failed"); });

  it("discovers all call pins models and strict schemas through exactly five MCP entrances while preserving unversioned v1 and startup denial", async () => {
    const sdk = await f.connect([], login), tools = await sdk.client.listTools(); expect(tools.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(names).sort());
    const registry = await sdk.call(names.search, {}); expect(registry.isError).toBe(false); expect(registry.packet.data.registrySize).toBe(49);
    expect((registry.packet.data.entries as Array<{ key: string }>).some(row => row.key.startsWith("native-v3/"))).toBe(false);
    const denied = await sdk.call(names.schema, { key: "native-v3/start" }); expect(denied.isError).toBe(true); expect(denied.packet.data.code).toBe("mcp_policy_denied");
    const opted = await f.connect(paid, login), discovered = await discoverMcpV2Request(opted, one());
    expect(discovered.metadata.originalVersion).toBe(AGENT_NATIVE_V3_VERSION); expect(discovered.metadata.readContracts.fulfillment).toBeDefined();
    const original = await opted.call(names.schema, { key: "native/start" }); expect(original.isError).toBe(false); expect(original.packet.data.originalVersion).toBe(AGENT_NATIVE_VERSION);
    expect(original.packet.data.executionContract).not.toEqual(discovered.metadata.executionContract);
    const before = await native.rows(await current()), count = posts("/v1/agent-native-v3/runs");
    for (const flags of [["--allow-native-v3"], ["--allow-native-v3", "--allow-model-run", "--max-cost-usd=0.5"],
      ["--allow-native-v3", "--allow-model-run", "--max-cost-usd=1", "--allow-read=knowledge.search"]]) {
      const limited = await f.connect(flags, login), result = await limited.call(names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "start", requestJson: JSON.stringify(discovered.input) });
      expect(result.isError).toBe(true); expect(result.packet.data.code).toBe("mcp_policy_denied");
    }
    expect(posts("/v1/agent-native-v3/runs")).toBe(count); expect(await native.rows(await current())).toEqual(before);
    const fractional = await start(opted, { maxCostUsd: 0.5 }); expect(fractional.view.cost.capUsd).toBe("0.500000");
    expect(fractional.view.requestChecksum).toBe(f.proof(fractional.input).requestChecksum);
    const stopped = await opted.call(names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "stop", id: fractional.view.id.toUpperCase(),
      requestJson: JSON.stringify({ version: AGENT_NATIVE_V3_VERSION, requestId: fractional.input.requestId }) }); expect(stopped.isError).toBe(false);
    expect(sdk.evidence.injectedEnvironmentKeys.some(key => /DATABASE|REDIS|S3|MODEL|ACCESS_TOKEN/.test(key))).toBe(false);
    const legacy = await f.connect([], login, true), old = await legacy.call(names.schema, { key: "native/start" }); expect(old.isError).toBe(false);
    expect(old.packet.version).toBe("erp-agent-mcp-v1"); expect(old.packet.data.originalVersion).toBe(AGENT_NATIVE_VERSION);
    expect(AgentNativeWorkspaceSchema.shape.version.parse(AGENT_NATIVE_VERSION)).toBe(AGENT_NATIVE_VERSION);
    // This is an actual installed Codex app-server process, distinct from the
    // official SDK acceptance client above. It owns a fresh isolated CODEX_HOME.
    const host = await openAgentMcpCodexHost({ apiUrl: f.origin, profilePath: login.profilePath, storeDir: login.storeDir });
    try {
      const catalog = await host.call(names.search, {}); expect(catalog.isError).toBe(false);
      expect((catalog.packet.data.entries as Array<{ key: string }>).some(row => row.key === "resource/catalog.sku")).toBe(true);
      const definition = await host.call(names.schema, { key: "resource/catalog.sku" }); expect(definition.isError).toBe(false);
      const original = AgentResourceDefinitionSchema.parse(definition.packet.data.definition); await verifyAgentResourceDefinition(original, "catalog.sku");
      const candidates = await host.call(names.execute, { operation: "read", requestJson: JSON.stringify({ version: AGENT_RESOURCES_VERSION, kind: "candidates",
        query: { version: AGENT_RESOURCES_VERSION, tool: "catalog.sku", q: "", page: 1, pageSize: 100 } }) }); expect(candidates.isError).toBe(false);
      const chosen = source.bindings.find(binding => binding.tool === "catalog.sku"); if (chosen?.tool !== "catalog.sku") throw new Error("mcp_v2_original_host_sku_missing");
      expect(AgentResourceCandidatesSchema.parse(candidates.packet.data).items.some(item => item.id === chosen.scope.skuId)).toBe(true);
      const call = AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "catalog.sku", definitionChecksum: original.definitionChecksum,
        executionContract: HarnessExecutionContractSchema.parse(definition.packet.data.executionContract), input: chosen.scope });
      const result = await host.call(names.execute, { operation: "read", requestJson: JSON.stringify(call) }); expect(result.isError).toBe(false);
      const actual = AgentResourceResultSchema.parse(result.packet.data); await verifyAgentResourceResult(actual, call);
      if (actual.tool !== "catalog.sku") throw new Error("mcp_v2_original_host_sku_mismatch"); expect(actual.data.skuId).toBe(chosen.scope.skuId);
    } finally { await host.close(); await writeFile(mcpV2OwnedPath(environment.nonce + "-codex-host.json"), JSON.stringify(host.evidence)); }
  });

  it("runs one real fourteen-binding Worker task from MCP discovery then prepares two originals without automatic business execution", async () => {
    const sdk = await f.connect(paid, login), before = await native.business(await current()), fulfillment = await native.fulfillmentBusiness(await current());
    const { input } = await discoverMcpV2Request(sdk, source.bindings, { allowedCommands: [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }] });
    const created = await sdk.call(names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "start", requestJson: JSON.stringify(input) }); expect(created.isError).toBe(false);
    const id = AgentNativeV3ViewSchema.parse(created.packet.data).id, calls = native.modelCalls.length;
    f.setDecision(source.originals, source.query); await native.process(id); const run = await saved(sdk, id);
    expect(run.status, JSON.stringify({ status: run.status, errorCode: run.errorCode })).toBe("completed"); expect(run.observations).toHaveLength(14);
    expect(run.cost).toMatchObject({ modelTurns: 29, knownCostUsd: "0.006090", reservedUsd: "0.000000", coverage: "known" }); expect(native.modelCalls.length - calls).toBe(29);
    expect(run.steps).toHaveLength(57); expect(run.toolCalls).toBe(73); expect(run.items).toHaveLength(2);
    const packets = run.observations.filter(row => row.tool === AGENT_FULFILLMENT_TOOL).map(row => AgentFulfillmentResultSchema.parse(row.results[0]));
    expect(packets).toHaveLength(3); expect(packets.every(packet => packet.data.coverage.complete === false)).toBe(true);
    const production = packets.find(row => row.data.kind === "production")!, logistics = packets.find(row => row.data.kind === "logistics")!;
    if (production.data.kind !== "production" || logistics.data.kind !== "logistics") throw new Error("mcp_v2_original_fulfillment_kinds_missing");
    expect(production.data.rows[0]!.factory.data?.voidSummary).toMatchObject({ pending: 0, requiresOrderHandling: 1 });
    expect(production.data.rows[0]!.quality.data?.groups.map(row => [row.quantity, row.result]).sort()).toEqual([[2, "failed"], [3, "passed"]]);
    expect(logistics.data.rows[0]).toMatchObject({ quotedCostMinor: 500, actualCostMinor: 600, quotedCurrency: "USD", actualCurrency: "USD", minorUnitDigits: 2 });
    expect(await native.business(await current())).toEqual(before); expect(await native.fulfillmentBusiness(await current())).toEqual(fulfillment);
    expect(f.requests.filter(row => /\/(confirm|execute|publish|pay)$/.test(row.path))).toHaveLength(0);
    for (const item of run.items) {
      const response = await sdk.call(names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "prepare", id: id.toUpperCase(), itemId: item.id.toUpperCase(), requestJson: JSON.stringify(native.prepareInput(run, item)) });
      expect(response.isError, JSON.stringify(response.packet.data)).toBe(false); const receipt = AgentNativeV3ItemReceiptSchema.parse(response.packet.data);
      expect(receipt.disposition).toBe("known"); expect(Boolean(receipt.agentCommandId && receipt.ownerCommandId)).toBe(true);
      const same = await sdk.call(names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "item_receipt", id: id.toUpperCase(), itemId: item.id.toUpperCase(),
        requestId: run.requestId, proposalChecksum: item.proposalChecksum }); expect(same.isError).toBe(false);
      expect(AgentNativeV3ItemReceiptSchema.parse(same.packet.data).ownerCommandId).toBe(receipt.ownerCommandId);
      const original = await sdk.call(names.savedResult, { kind: "command", id: receipt.agentCommandId!, originalChecksum: item.originalChecksum }); expect(original.isError).toBe(false);
      expect(original.packet.kind).toBe("command_receipt"); expect(original.packet.data).toMatchObject({ id: receipt.agentCommandId, ownerCommandId: receipt.ownerCommandId, state: "prepared" });
      // Confirmation belongs to the original ERP HTTP owner, never an MCP tool.
      const lease = await login.session.credentials.acquire(new AbortController().signal), headers = { authorization: "Bearer " + lease.accessToken, "content-type": "application/json" };
      const actual = await fetch(f.origin + "/v1/agent-commands/requests/" + receipt.agentCommandId, { headers }); expect(actual.status).toBe(200);
      const command = AgentCommandViewSchema.parse(await actual.json()), confirmed = await fetch(f.origin + "/v1/agent-commands/requests/" + command.id + "/confirm", {
        method: "POST", headers, body: JSON.stringify(native.confirmation(command)) }); expect(confirmed.status).toBe(200);
      expect(AgentCommandViewSchema.parse(await confirmed.json()).snapshot?.native.view.status).toBe("succeeded");
    }
    expect((await native.business(await current())).finance_payable_bills!.count - before.finance_payable_bills!.count).toBe(1);
    const state = await native.rows(await current()), modelCalls = native.modelCalls.length;
    expect(await usage(sdk, id)).toEqual({ version: AGENT_NATIVE_V3_VERSION, scope: "run", id, requestId: run.requestId, status: run.status, cost: run.cost, organizationBalance: "not_provided" });
    expect(await native.rows(await current())).toEqual(state); expect(native.modelCalls.length).toBe(modelCalls);
  }, 240_000);

  it("reads every original fulfillment page and refuses a last-page source review change before any new paid submission or preparation", async () => {
    const sdk = await f.connect(paid, login), context = await current(), scene = await native.fulfillment.seed(context, Array<number>(11).fill(1));
    const order = await native.fulfillment.orders.get(context, scene.order.id), binding = AgentNativeV3BindingSchema.parse({ tool: AGENT_FULFILLMENT_TOOL,
      scope: { orderId: order.id, expectedSequence: order.latestEventSequence, kind: "production" } });
    const made = await start(sdk, { bindings: [binding] }); f.setDecision(); await native.process(made.view.id); const complete = await saved(sdk, made.view.id);
    expect(complete.status).toBe("completed"); expect(complete.observations[0]).toMatchObject({ indexComplete: true, collectionComplete: null, observedRows: 11 });
    expect(complete.observations[0]!.results.map(row => row.version === "erp-agent-fulfillment-v1" ? row.data.rows.length : -1)).toEqual([10, 1]);
    const last = AgentFulfillmentResultSchema.parse(complete.observations[0]!.results[1]); if (last.data.kind !== "production") throw new Error("mcp_v2_original_second_page_missing");
    const selected = scene.items.find(row => row.productionOrderId === last.data.rows[0]!.id)!, production = scene.productions.find(row => row.order.id === selected.productionOrderId)!;
    const group = { ...scene, items: [selected], quantity: production.quantity }, observed = await native.fulfillment.observe(context, group, "已作废");
    let changed = false; const offset = native.modelCalls.length;
    native.controls.afterRead = async (_context, _input, result) => {
      if (!changed && result && typeof result === "object" && "version" in result && result.version === "erp-agent-fulfillment-v1") {
        const value = AgentFulfillmentResultSchema.parse(result); if (value.data.coverage.hasMore === false) { changed = true; await native.reviewVoid(context, group, observed); }
      }
    };
    const stale = await start(sdk, { bindings: [binding] }); await native.process(stale.view.id); const rejected = await saved(sdk, stale.view.id);
    expect(changed).toBe(true); expect(rejected.status).toBe("failed"); expect(rejected.result).toBeNull(); expect(rejected.items).toEqual([]);
    expect(native.modelCalls.length - offset).toBe(2); expect(rejected.cost.knownCostUsd).toBe("0.000420"); expect(rejected.cost.reservedUsd).toBe("0.000000");
    expect(posts(`/v1/agent-native-v3/runs/${stale.view.id}/items/prepare`)).toBe(0);
  }, 240_000);

  it("enforces the original personal actor birth ceiling and late authority fences while preserving a minimal owner stop after domain loss", async () => {
    const sdk = await f.connect(paid, login), created = await start(sdk), peer = await f.connect(paid, await f.login("peer")), foreign = await f.connect(paid, await f.login("foreign"));
    for (const other of [peer, foreign]) { const rejected = await other.call(names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "run", id: created.view.id });
      expect(rejected.isError).toBe(true); expect(rejected.packet.kind).toBe("error"); }
    const entered = deferred(), release = deferred(); let held = false;
    f.controls.afterHttp = async path => { if (!held && path === "/v1/agent-native-v3/runs/" + created.view.id) { held = true; entered.resolve(); await release.promise; } };
    const pending = sdk.call(names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "run", id: created.view.id });
    try { await bounded(entered.promise, "mcp_v2_real_owner_http_gate_missing"); await native.base.scopes(native.base.a, { ...nativeV3Scopes(), [Permission.InventoryRead]: "self" }); release.resolve();
      const denied = await bounded(pending, "mcp_v2_late_response_not_settled"); expect(denied.isError).toBe(true); expect(denied.packet.data.code).toBe("mcp_authority_changed");
      expect(Object.keys(denied.packet.data).sort()).toEqual(["code", "status"]);
    } finally { release.resolve(); await pending; f.controls.afterHttp = undefined; }
    const hidden = await saved(sdk, created.view.id); expect(hidden).toMatchObject({ privateAvailable: false, goal: null, contextText: null, bindings: [], steps: [], definitions: [], observations: [], result: null, readContracts: null });
    const stopped = await sdk.call(names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "stop", id: created.view.id,
      requestJson: JSON.stringify({ version: AGENT_NATIVE_V3_VERSION, requestId: created.input.requestId }) });
    expect(stopped.isError).toBe(false); expect(AgentNativeV3ReceiptSchema.parse(stopped.packet.data)).toMatchObject({ runId: created.view.id, privateAvailable: false });
  });

  it("recovers committed lost parent and item201 using only original references in new SDK processes without another submitted POST", async () => {
    const sdk = await f.connect(paid, login), { input } = await discoverMcpV2Request(sdk, one(), { allowedCommands: [{ domain: "finance", kind: "bill_record" }] });
    const originalPosts = posts("/v1/agent-native-v3/runs"); f.controls.dropNext = "/v1/agent-native-v3/runs";
    const lost = await sdk.call(names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "start", requestJson: JSON.stringify(input) });
    expect(lost.isError).toBe(true); expect(lost.packet.data).toMatchObject({ code: "mcp_submission_unknown", retrySubmittedWrite: false, nextAction: "read_original_receipt_only" });
    await sdk.close(); const restarted = await f.connect(paid, login), rows = await native.rows(await current());
    const receipt = await restarted.call(names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt_from_request", requestJson: JSON.stringify(input) }); expect(receipt.isError).toBe(false);
    const actual = AgentNativeV3ReceiptSchema.parse(receipt.packet.data); expect(actual.disposition).toBe("known"); expect(posts("/v1/agent-native-v3/runs")).toBe(originalPosts + 1);
    const sameReceipt = await restarted.call(names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt", requestId: actual.requestId, requestChecksum: actual.requestChecksum });
    expect(sameReceipt.isError).toBe(false); expect(AgentNativeV3ReceiptSchema.parse(sameReceipt.packet.data).runId).toBe(actual.runId);
    const freshOriginals = source.originals.filter(original => original.domain === "finance").map(original => AgentCommandOriginalSchema.parse({ ...original,
      command: { ...original.command, input: { ...original.command.input, externalBillId: "SYNTHETIC-MCP-RECOVERY-" + createEntityId().toUpperCase() } } }));
    expect(await native.rows(await current())).toEqual(rows); f.setDecision(freshOriginals, source.query); await native.process(actual.runId!);
    const run = await saved(restarted, actual.runId!), item = run.items[0]!, path = `/v1/agent-native-v3/runs/${run.id}/items/${item.id}/prepare`, originalPrepares = posts(path);
    f.controls.dropNext = path; const missing = await restarted.call(names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "prepare", id: run.id, itemId: item.id,
      requestJson: JSON.stringify(native.prepareInput(run, item)) }); expect(missing.isError).toBe(true); expect(missing.packet.data.code).toBe("mcp_submission_unknown"); await restarted.close();
    const fresh = await f.connect(paid, login), stable = await native.rows(await current()), business = await native.business(await current()), calls = native.modelCalls.length;
    const reference = { version: AGENT_NATIVE_V3_VERSION, kind: "item_receipt", id: run.id, itemId: item.id, requestId: run.requestId, proposalChecksum: item.proposalChecksum };
    const found = await fresh.call(names.savedResult, reference); expect(found.isError).toBe(false);
    expect(AgentNativeV3ItemReceiptSchema.parse(found.packet.data)).toMatchObject({ disposition: "known", itemId: item.id });
    for (const invalid of [{ ...reference, requestId: randomUUID() }, { ...reference, proposalChecksum: "0".repeat(64) }]) expect((await fresh.call(names.savedResult, invalid)).isError).toBe(true);
    expect(posts(path)).toBe(originalPrepares + 1); expect(await native.rows(await current())).toEqual(stable); expect(await native.business(await current())).toEqual(business); expect(native.modelCalls.length).toBe(calls);
  });

  it("keeps submitted unknown model fees at the full cap and serves usage and original receipts without another paid attempt", async () => {
    const sdk = await f.connect(paid, login), created = await start(sdk); native.controls.unknownUsage = true; f.setDecision(); await native.process(created.view.id);
    const run = await saved(sdk, created.view.id); expect(run.status).toBe("uncertain"); expect(run.cost).toMatchObject({ coverage: "unknown", reservedUsd: "1.000000", modelTurns: 1 });
    const before = await native.rows(await current()), calls = native.modelCalls.length, business = await native.business(await current());
    expect((await usage(sdk, run.id)).cost).toEqual(run.cost);
    const found = await sdk.call(names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt", ...f.proof(created.input) });
    expect(AgentNativeV3ReceiptSchema.parse(found.packet.data).runId).toBe(run.id);
    expect(await native.rows(await current())).toEqual(before); expect(native.modelCalls.length).toBe(calls); expect(await native.business(await current())).toEqual(business);
  });

  it("uses actual PKCE codes and a protected local vault then restarts without an environment bearer or any additional login", async () => {
    const before = { ...f.idp.proof }, auth = await f.login(), sdk = await f.connect(["--allow-native-v3"], auth);
    expect(f.idp.proof.codeExchanges - before.codeExchanges).toBe(1); expect(f.idp.proof.authorizations - before.authorizations).toBe(1);
    expect((await sdk.call(names.search, {})).isError).toBe(false); expect(f.idp.proof.codeExchanges - before.codeExchanges).toBe(1);
    expect(sdk.evidence.injectedEnvironmentKeys.includes("YUMMYAI_MCP_ERP_ACCESS_TOKEN")).toBe(false);
    expect(sdk.evidence.injectedEnvironmentKeys.includes("YUMMYAI_MCP_AUTH_STORE_DIR")).toBe(true);
    const lease = await auth.session.credentials.acquire(new AbortController().signal), ciphertext = await readFile(resolve(auth.storeDir, "credential.bin"));
    expect(ciphertext.includes(Buffer.from(lease.accessToken))).toBe(false);
    const status = await auth.session.status(); expect(JSON.stringify(status).includes(lease.accessToken)).toBe(false); expect(status).toMatchObject({ userId: native.base.a.userId, tenantId: native.base.a.tenantId });
    expect((await readdir(auth.storeDir)).some(name => /\.tmp$/.test(name))).toBe(false); await lease.assertCurrent();
    for (const mode of ["badNonce", "wrongCallbackIssuer"] as const) {
      f.idp.controls[mode] = true; let failure: unknown;
      try { await f.login(); } catch (error) { failure = error; } finally { f.idp.controls[mode] = false; }
      expect(failure).toMatchObject({ code: mode === "badNonce" ? "mcp_auth_identity_changed" : "mcp_auth_login_failed" });
      expect(String(failure).startsWith("AgentMcpAuthError: mcp_auth_")).toBe(true);
      const failed = f.lastAuth(); if (!failed) throw new Error("mcp_v2_rejected_auth_attempt_missing");
      const session = await createPersonalAgentMcpSession(failed.profile, { storeDir: failed.storeDir }); expect((await session.status()).state).toBe("reauthentication_required");
      const record = await new AgentMcpCredentialStore(failed.storeDir, agentMcpAuthProfileDigest(failed.profile), new WindowsAgentMcpDataProtection()).read();
      expect(record?.state === "ready").toBe(false); await expect(session.credentials.acquire(new AbortController().signal)).rejects.toMatchObject({ code: "mcp_auth_required" });
    }
  });

  it("rotates refresh once across concurrent original grants and refuses revocation without resurrecting a logged-out session or retrying ERP", async () => {
    const auth = await f.login(), store = new AgentMcpCredentialStore(auth.storeDir, agentMcpAuthProfileDigest(auth.profile), new WindowsAgentMcpDataProtection());
    const savedState = await store.read(); if (savedState?.state !== "ready") throw new Error("mcp_v2_real_ready_grant_missing");
    const shiftedNow = savedState.tokens.accessExpiresAt - 1000, first = await createPersonalAgentMcpSession(auth.profile, { storeDir: auth.storeDir, now: () => shiftedNow }),
      second = await createPersonalAgentMcpSession(auth.profile, { storeDir: auth.storeDir, now: () => shiftedNow });
    const before = f.idp.proof.refreshExchanges; f.idp.controls.accessSeconds = 600;
    let leases: Awaited<ReturnType<typeof first.credentials.acquire>>[];
    try { leases = await Promise.all([first.credentials.acquire(new AbortController().signal), second.credentials.acquire(new AbortController().signal)]); }
    finally { f.idp.controls.accessSeconds = 300; }
    expect(f.idp.proof.refreshExchanges - before).toBe(1); expect(leases[0].accessToken === leases[1].accessToken).toBe(true);
    const session = await fetch(f.origin + "/v1/identity/session", { headers: { authorization: "Bearer " + leases[0].accessToken } }); expect(session.status).toBe(200);
    expect(ErpSessionViewSchema.parse(await session.json()).userId).toBe(native.base.a.userId);
    const requestCount = f.requests.length; await first.logout();
    await expect(leases[0]!.assertCurrent()).rejects.toMatchObject({ code: "mcp_auth_session_changed" });
    await expect(second.credentials.acquire(new AbortController().signal)).rejects.toMatchObject({ code: "mcp_auth_session_changed" });
    expect(f.requests.length).toBe(requestCount); expect((await first.status()).state).toBe("signed_out");
    const inFlight = await f.login(), exactStore = new AgentMcpCredentialStore(inFlight.storeDir, agentMcpAuthProfileDigest(inFlight.profile), new WindowsAgentMcpDataProtection());
    const original = await exactStore.read(); if (original?.state !== "ready") throw new Error("mcp_v2_actual_refresh_original_missing");
    const entered = deferred(), release = deferred(), advanced = await createPersonalAgentMcpSession(inFlight.profile, { storeDir: inFlight.storeDir, now: () => original.tokens.accessExpiresAt - 1000 });
    f.idp.controls.accessSeconds = 600; f.idp.controls.beforeRefreshResponse = async () => { entered.resolve(); await release.promise; };
    const refreshes = f.idp.proof.refreshExchanges, originalPosts = f.requests.filter(row => row.method === "POST").length;
    const pending = advanced.credentials.acquire(new AbortController().signal).then(() => ({ ok: true, code: null }), error => ({ ok: false,
      code: error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^mcp_auth_[a-z_]+$/.test(error.code) ? error.code : "unsafe_error" }));
    try {
      await bounded(entered.promise, "mcp_v2_real_refresh_response_gate_missing"); expect((await exactStore.read())?.state).toBe("refreshing");
      await inFlight.session.logout(); const loggedOut = await exactStore.read(); expect(loggedOut?.state).toBe("signed_out");
      release.resolve(); expect(await bounded(pending, "mcp_v2_real_late_refresh_not_settled")).toEqual({ ok: false, code: "mcp_auth_session_changed" });
      expect((await exactStore.read())?.state).toBe("signed_out"); expect((await exactStore.read())?.grantId).toBe(loggedOut?.grantId);
      await expect(advanced.credentials.acquire(new AbortController().signal)).rejects.toMatchObject({ code: "mcp_auth_session_changed" });
      expect(f.idp.proof.refreshExchanges - refreshes).toBe(1); expect(f.requests.filter(row => row.method === "POST").length).toBe(originalPosts);
    } finally { release.resolve(); await pending; f.idp.controls.beforeRefreshResponse = undefined; f.idp.controls.accessSeconds = 300; }
    // An already issued JWT is not claimed to be instantly revoked at the API.
  });
});
