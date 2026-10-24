import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission, erpPermissionContext } from "@yummyai/authz";
import { type TenantContext, createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_NATIVE_V2_VERSION, AgentNativeV2ViewSchema, AgentNativeV2PinnedInputSchema, AgentNativeV2ReadKeySchema,
  agentNativeV2SourceBasis, type AgentNativeV2View, type CreateAgentNativeV2 } from "@yummyai/contracts/ai/agent-native-v2";
import { verifyAgentNativeV2Transport } from "@yummyai/contracts/ai/agent-native-v2-transport";
import { aiBudgetLedger, aiBudgetPolicies, agentPlanRuns, agentPlanItems, connectDatabase, withTenant, type TenantTransaction } from "@yummyai/database";
import * as persistence from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { agentNativeV2Protocol } from "@yummyai/workflow-core";
import { createWorkerAgentTools } from "../../../worker/src/agent-native-owners.js";
import { createWorkerAgentResources } from "../../../worker/src/agent-resources-owners.js";
import { bounded, deferred } from "./agent-read.test-fixture.js";
import { agentNativeV2Fixture, finishNativeV2, nativeV2Sequence, nativeV2Scopes, nativeV2Hash, requireAgentNativeV2Environment } from "./agent-native-v2.test-fixture.js";

const environment = requireAgentNativeV2Environment(), database = connectDatabase(environment.url), f = agentNativeV2Fixture(database);
let source: Awaited<ReturnType<typeof f.seed>>;
const one = () => [source.bindings[1]!];
const current = () => f.base.current(f.base.a);
const stamp = (value: TenantContext) => erpSessionAuthority(erpPermissionContext(value));
const nativeHash = (value: unknown) => nativeV2Hash(canonicalJson(value));
async function read(id: string, context?: TenantContext) {
  const value = AgentNativeV2ViewSchema.parse(await f.service().get(context ?? await current(), id)); await verifyAgentNativeV2Transport(value); return value;
}
async function simple(originals: typeof source.originals = [], retention?: number, changes: Partial<CreateAgentNativeV2> = {}) {
  const context = await current(); f.controls.decision = packet => nativeV2Sequence(packet, originals, source.query);
  const input = await f.request(f.base.a, { bindings: one(), allowedCommands: originals.map(original => AgentPlanCommandKeySchema.parse({ domain: original.domain, kind: original.command.kind })),
    ...(retention ? { limits: { ...((await f.request()).limits), deadlineSeconds: 30 } } : {}), ...changes });
  const created = await f.service(retention).start(context, input); await f.process(created.id); return { input, view: await read(created.id) };
}
function pgCode(error: unknown): string | null { for (let count = 0; count < 7 && error && typeof error === "object"; count++) {
  if ("code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
  error = "cause" in error ? error.cause : null;
} return null; }
async function rejected(work: (tx: TenantTransaction) => Promise<unknown>) {
  try { await withTenant(database.db, await current(), async tx => { await work(tx); await tx.execute(sql`set constraints all immediate`); }); }
  catch (error) { return pgCode(error); } throw new Error("Actual nativeV2 SQL mutation unexpectedly committed");
}

describe.sequential("native v2 real eleven-owner model execution and original confirmation", () => {
  beforeAll(async () => { await f.initialize(); source = await f.seed(); }, 120_000);
  afterEach(async () => {
    f.clear(); for (const actor of [f.base.a, f.base.second, f.base.foreign]) { await f.base.memberActive(actor, true); await f.base.scopes(actor, nativeV2Scopes()); }
    const context = await current(), rows = await f.rows(context);
    for (const run of rows.runs.filter(row => row.ownerId === context.userId && row.version === AGENT_NATIVE_V2_VERSION && ["queued", "running", "stopping"].includes(row.status))) {
      await f.service().stop(context, run.id, { version: AGENT_NATIVE_V2_VERSION, requestId: run.requestId }); await f.process(run.id);
    }
    await f.settlePrepared(context);
  });
  afterAll(async () => { const errors: unknown[] = []; try { await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV2 disposable integration teardown failed"); });

  it("executes all eleven real readers within one original Redis-routed task then separately confirms authentic procurement and finance writes", async () => {
    const context = await current(), business = await f.business(context), calls = f.modelCalls.length, definitions = f.definitionCalls.length, reads = f.readCalls.length;
    f.controls.decision = packet => nativeV2Sequence(packet, source.originals, source.query);
    const input = await f.request(f.base.a, { bindings: source.bindings, allowedCommands: [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }] });
    const run = await f.service().start(context, input); await f.process(run.id); const view = await read(run.id);
    expect(view.status).toBe("completed"); expect(view.observations.map(row => row.tool)).toEqual(AgentNativeV2ReadKeySchema.options);
    expect(view.cost).toMatchObject({ modelTurns: 25, knownCostUsd: "0.005250", reservedUsd: "0.000000", coverage: "known" });
    expect(view.steps).toHaveLength(49); expect(view.toolCalls).toBe(48); expect(f.modelCalls.length - calls).toBe(25);
    const definitionTransportCalls = f.definitionCalls.length - definitions, readTransportCalls = f.readCalls.length - reads;
    expect(definitionTransportCalls).toBe(121); expect(readTransportCalls).toBe(117);
    // The 26 definition and 22 read evidence actions include finish rechecks.
    // The additional calls only recheck access before later model submissions.
    expect({ definitions: definitionTransportCalls - 26, reads: readTransportCalls - 22 }).toEqual({ definitions: 95, reads: 95 });
    expect(view.definitions).toHaveLength(13); expect(view.observations).toHaveLength(11); expect(view.items).toHaveLength(2);
    const resource = (key: string) => view.observations.find(row => row.tool === key)!.results[0]!;
    const profit = resource("finance.profit_run"), order = resource("orders.order"), sku = resource("catalog.sku"), ad = resource("advertising.analysis");
    if (profit.tool !== "finance.profit_run" || order.tool !== "orders.order" || sku.tool !== "catalog.sku" || ad.tool !== "advertising.analysis") throw new Error("Actual six-resource branches missing");
    expect(profit.data.profitMinor).toBe(5300); expect(profit.data.reportingCurrency).toBe("USD"); expect(order.data.lines[0]!.quantity).toBe(3);
    expect(order.data.externalOrderId).toBe(source.fresh.order.value.externalOrderId);
    expect(sku.data.recipe?.status).toBe("pending_adaptation"); expect(sku.data.recipe?.specification.facts.physicalDimensions).toEqual({ basis: "flat_piece", unit: "mm", length: 60, width: 40, height: null });
    expect(ad.data.id).toBe(source.fresh.ad.run.id); expect(await f.business(context)).toEqual(business);
    expect(f.wire.slice(calls).every(row => row.schemaBytes > 0 && row.bodyBytes > row.schemaBytes)).toBe(true);
    const sealed = await f.rows(context), original = sealed.runs.find(row => row.id === view.id)!;
    expect(sealed.ledgers.find(row => row.id === original.budgetLedgerId)).toMatchObject({ state: "committed", amountUsd: "0.005250" });
    for (const item of view.items) {
      const body = f.prepareInput(view, item), receipt = await f.service().prepareItem(context, view.id, item.id, body);
      expect(receipt.disposition).toBe("known"); if (!receipt.agentCommandId || !receipt.ownerCommandId) throw new Error("Original prepared IDs missing");
      const command = await f.legacy.owners.service().get(context, receipt.agentCommandId); expect(command.snapshot?.native.view.status).toBe("prepared");
      const before = await f.business(context); await f.service().itemReceipt(context, view.id, item.id, body); expect(await f.business(context)).toEqual(before);
      const confirmed = await f.legacy.owners.service().confirm(context, command.id, f.confirmation(command)); expect(confirmed.snapshot?.native.view.status).toBe("succeeded");
      const success = await f.business(context); await f.legacy.owners.service().get(context, command.id); await f.legacy.owners.service().confirm(context, command.id, f.confirmation(command));
      expect(await f.business(context)).toEqual(success);
    }
    const after = await f.business(context);
    expect(after.inventory_procurement_requisitions!.count - business.inventory_procurement_requisitions!.count).toBe(1);
    expect(after.finance_payable_bills!.count - business.finance_payable_bills!.count).toBe(1);
    expect(f.modelCalls.length - calls).toBe(25);
  }, 120_000);

  it("rejects changed source scalars currency unit hashes paths definitions and execution decisions while retaining every incurred model fee", async () => {
    const business = await f.business(await current());
    for (const variant of ["value", "amount", "currency", "unit", "hash", "path", "execute"] as const) {
      f.controls.decision = packet => {
        if (variant === "execute") return { action: "execute", label: "A model cannot execute", definition: null, read: null, result: null };
        const decision = nativeV2Sequence(packet, [], source.query); if (decision.action !== "finish") return decision;
        const claim = decision.result!.claims[0]; if (!claim) throw new Error("Actual scalar source required for negative case");
        if (variant === "value") claim.value = "invented amount";
        if (variant === "amount") { expect(claim.path).toEqual(["profitMinor"]); expect(claim.value).toBe(5300); claim.value = 5301; }
        if (variant === "currency") { const currency = decision.result!.claims.find(value => value.path[0] === "reportingCurrency");
          if (!currency) throw new Error("Actual original profit currency missing"); expect(currency.value).toBe("USD"); currency.value = "EUR"; }
        if (variant === "unit") { claim.path = ["items", 0, "unit"]; claim.value = "kilogram"; }
        if (variant === "hash") claim.dataChecksum = "f".repeat(64);
        if (variant === "path") claim.path = ["contextAuthority"];
        return decision;
      };
      const input = await f.request(f.base.a, { bindings: variant === "amount" || variant === "currency" ? [source.bindings[9]!] : one() }), start = await f.service().start(await current(), input), count = f.modelCalls.length;
      await f.process(start.id); const failed = await read(start.id);
      expect(failed.status).toBe("failed"); expect(failed.result).toBeNull(); expect(failed.items).toEqual([]);
      expect(failed.cost.knownCostUsd).toBe(((f.modelCalls.length - count) * 210 / 1_000_000).toFixed(6)); expect(failed.cost.reservedUsd).toBe("0.000000");
      expect(await f.business(await current())).toEqual(business);
    }
    f.clear(); f.controls.decision = () => ({ action: "read", label: "Read without loading a schema", definition: null, read: { bindingIndex: 0, keyword: null }, result: null });
    const input = await f.request(f.base.a, { bindings: one() }), run = await f.service().start(await current(), input); await f.process(run.id);
    expect(await read(run.id)).toMatchObject({ status: "failed", observations: [], result: null });
  });

  it("uses genuine OIDC current membership RLS per-bit self and original ceilings instead of borrowing new grants or another tenant", async () => {
    const context = await current(), input = await f.request(f.base.a, { bindings: one() }), origin = await f.startHttp(), token = await f.token();
    const response = await fetch(origin + "/v1/agent-native-v2/runs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(201); const run = AgentNativeV2ViewSchema.parse(await response.json()); await f.process(run.id);
    for (const actor of [f.base.second, f.base.foreign]) { await expect(f.service().get(await f.base.current(actor), run.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await f.service().receipt(await f.base.current(actor), f.proof(input))).toMatchObject({ disposition: "not_found", runId: null }); }
    expect((await fetch(origin + "/v1/agent-native-v2/workspace", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    const narrow = await f.base.scopes(f.base.a, { ...nativeV2Scopes(), [Permission.WorkflowRead]: "self", [Permission.WorkflowRun]: "self" });
    const privateRun = await simple([], undefined, { bindings: one() }); expect(privateRun.view.status).toBe("completed");
    const born = (await f.rows(narrow)).runs.find(row => row.id === privateRun.view.id)!; expect(born.originCeiling.permissionScopes?.[Permission.WorkflowRun]).toBe("self");
    const originalCeiling = (await f.rows(context)).runs.find(row => row.id === run.id)!.originCeiling;
    const hidden = await f.base.scopes(f.base.a, { ...nativeV2Scopes(), [Permission.InventoryRead]: "self" });
    expect(await f.service().get(hidden, run.id)).toMatchObject({ privateAvailable: false, readContracts: null, steps: [], definitions: [], observations: [], result: null });
    expect(await f.service().stop(hidden, run.id, { version: AGENT_NATIVE_V2_VERSION, requestId: input.requestId })).toMatchObject({ runId: run.id, contextAuthority: stamp(hidden) });
    await expect(f.service().start(hidden, await f.request(f.base.a, { bindings: one() }))).rejects.toBeInstanceOf(ConflictException);
    expect((await f.rows(context)).runs.find(row => row.id === run.id)!.originCeiling).toEqual(originalCeiling);
  });

  it("fences withdrawn knowledge source changes and completed object reads before finish preparation or a late personal response", async () => {
    let context = await current(); const before = await f.business(context), entered = deferred(), release = deferred(); let held = false;
    f.controls.afterRead = async (_context, _input, result) => { if (!held && result && typeof result === "object" && "tool" in result && result.tool === "research.evidence") { held = true; entered.resolve(); await release.promise; } };
    f.controls.decision = packet => nativeV2Sequence(packet, [], source.query);
    const input = await f.request(f.base.a, { bindings: [source.bindings[5]!] }), run = await f.service().start(context, input), pending = f.process(run.id);
    try { await bounded(entered.promise, "Real research owner did not finish its response");
      await f.base.scopes(f.base.a, { ...nativeV2Scopes(), [Permission.ResearchRead]: "self" });
      await f.base.memberActive(f.base.a, false); release.resolve(); await bounded(pending, "NativeV2 late read did not settle");
    } finally { release.resolve(); await pending; await f.base.memberActive(f.base.a, true); await f.base.scopes(f.base.a, nativeV2Scopes()); f.clear(); }
    expect(await read(run.id)).toMatchObject({ status: "failed", items: [], observations: [], result: null });
    const team = await f.base.team(f.base.a), memberId = await f.resources.joinTeam(f.base.second, team.teamId);
    context = await current(); const otherSource = await f.resources.seed(context, team.teamId);
    const peer = await f.base.scopes(f.base.second, { ...nativeV2Scopes(), [Permission.ProductRead]: "team" });
    const peerInput = await f.request(f.base.second, { bindings: [{ tool: "catalog.sku", scope: otherSource.inputs["catalog.sku"] }] });
    f.controls.decision = packet => nativeV2Sequence(packet); const peerRun = await f.service().start(peer, peerInput); await f.process(peerRun.id, f.base.second);
    const original = await read(peerRun.id, peer), originalChecksum = original.result;
    const spu = (await f.resources.facts.development.options(context)).spus.find(row => row.id === otherSource.sku.spu.id)!;
    const update = { code: spu.code, name: spu.name, description: spu.description, ...(spu.capabilities ? { capabilities: spu.capabilities } : {}) };
    const objectRead = deferred(), releaseObject = deferred(); let objectHeld = false;
    f.controls.afterRead = async (reader, _input, result) => { if (!objectHeld && reader.userId === peer.userId && result && typeof result === "object" && "tool" in result && result.tool === "catalog.sku") {
      objectHeld = true; objectRead.resolve(); await releaseObject.promise;
    } };
    const latePeer = await f.service().start(peer, await f.request(f.base.second, { bindings: peerInput.bindings })), latePeerWork = f.process(latePeer.id, f.base.second);
    let moved: Awaited<ReturnType<typeof f.resources.facts.development.updateSpu>> | undefined;
    try { await bounded(objectRead.promise, "Actual team SKU owner result did not reach its completed-read gate");
      moved = await f.resources.facts.development.updateSpu(context, spu.id, { ...update, teamId: null, expectedRevision: spu.revision, idempotencyKey: randomUUID() });
      const callsAtWithdrawal = f.modelCalls.length, paidAtWithdrawal = (await f.rows(peer)).runs.find(row => row.id === latePeer.id)!.knownCostUsd;
      expect(stamp(await f.base.current(f.base.second))).toBe(stamp(peer)); releaseObject.resolve(); await bounded(latePeerWork, "Late peer object read did not settle");
      const failedAfterWithdrawal = await read(latePeer.id, peer);
      expect(f.modelCalls.length - callsAtWithdrawal).toBe(0);
      expect(failedAfterWithdrawal).toMatchObject({ status: "failed", result: null, items: [], cost: { knownCostUsd: paidAtWithdrawal, reservedUsd: "0.000000" } });
      expect(await f.service().get(peer, peerRun.id)).toMatchObject({ privateAvailable: false, readContracts: null, steps: [], observations: [], result: null });
      expect((await f.rows(context)).runs.find(row => row.id === peerRun.id)!.resultChecksum).toBe(nativeHash(originalChecksum));
    } finally { releaseObject.resolve(); await latePeerWork; f.controls.afterRead = undefined;
      if (moved) await f.resources.facts.development.updateSpu(context, spu.id, { ...update, teamId: team.teamId, expectedRevision: moved.spu.revision, idempotencyKey: randomUUID() });
      await f.base.teamActive(f.base.second, memberId, false); }
    f.clear();
    const keyword = "Synthetic vtwo withdrawn " + createEntityId().replace(/[0-9-]/g, "a"), card = await f.legacy.card(context, keyword, true);
    const knowledge = [{ tool: "knowledge.search" as const, scope: { topic: "operations" as const, platform: "all" as const, market: "ALL", spuIds: [] } }];
    f.controls.decision = packet => nativeV2Sequence(packet, [], keyword); let withdrawn = false;
    f.controls.afterRead = async (_context, _input, result) => { if (!withdrawn && result && typeof result === "object" && "tool" in result && result.tool === "knowledge.search") {
      withdrawn = true; await f.base.knowledge.change(context, card, "disable", { expectedRevision: 3, version: 1, reason: "Original knowledge withdrawn after read", requestId: randomUUID() });
    } };
    const knowledgeInput = await f.request(f.base.a, { bindings: knowledge }), knowledgeRun = await f.service().start(context, knowledgeInput); await f.process(knowledgeRun.id);
    expect(await read(knowledgeRun.id)).toMatchObject({ status: "failed", items: [], result: null });
    f.clear();
    const freshOrder = await f.resources.orderSource(context, createEntityId());
    const historic = await simple([source.old.requisition], undefined, { bindings: [{ tool: "orders.order", scope: { orderId: freshOrder.value.id, expectedSequence: freshOrder.value.latestEventSequence } }] });
    const originalRun = (await f.rows(context)).runs.find(row => row.id === historic.view.id)!;
    await f.base.orders.ingestNormalized(context, { accountId: freshOrder.shop.id, platform: "etsy", externalEventId: createEntityId(), externalOrderId: freshOrder.value.externalOrderId,
      providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 12345, currency: "USD" },
      lines: [{ externalLineId: freshOrder.value.lines[0]!.externalLineId, externalListingId: null, skuCode: null, title: "Synthetic updated current order", quantity: 3,
        unitPrice: { amountMinor: 4115, currency: "USD" }, customizationCount: 0 }], redactedSource: { fixture: freshOrder.value.id, changed: true }, protectedDetails: null });
    const historicAfter = await read(historic.view.id); expect(historicAfter.privateAvailable).toBe(true); expect(historicAfter.observations).toEqual(historic.view.observations);
    expect(historicAfter.result).toEqual(historic.view.result);
    const item = historic.view.items[0]!;
    await expect(f.service().prepareItem(context, historic.view.id, item.id, f.prepareInput(historic.view, item))).rejects.toBeInstanceOf(ConflictException);
    const retained = (await f.rows(context)).runs.find(row => row.id === historic.view.id)!;
    expect(retained.encryptedResult).toBe(originalRun.encryptedResult); expect(retained.resultChecksum).toBe(originalRun.resultChecksum); expect(retained.knownCostUsd).toBe(originalRun.knownCostUsd);
    expect((await f.business(context)).inventory_movements).toEqual(before.inventory_movements);
  }, 120_000);

  it("collects all501 genuine dimensions rejects changed cursor collections and keeps bounded resource coverage distinct from totals", async () => {
    const stock = await f.base.stock(f.base.a, 501), before = await f.business(await current());
    const result = await simple([], undefined, { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: stock.stockItemId } }] });
    const observation = result.view.observations[0]!; expect(result.view.status).toBe("completed"); expect(observation.collectionComplete).toBe(true);
    expect(observation.observedRows).toBe(501); const pages = observation.results.filter(row => row.tool === "inventory.balances.page");
    expect(new Set(pages.flatMap(page => page.data.items.map(row => row.id))).size).toBe(501); expect(pages.at(-1)!.data.readCount).toBe(501);
    const prefix = await simple([], undefined, { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: stock.stockItemId } }],
      limits: { ...(await f.request()).limits, maxRows: 1 } });
    expect(prefix.view.status).toBe("partial"); expect(prefix.view.observations[0]!.collectionComplete).toBe(false);
    expect(prefix.view.result?.claims.some(claim => claim.path[0] === "total")).toBe(false);
    const boundedResult = await simple([], undefined, { bindings: [source.bindings[9]!] });
    expect(boundedResult.view.status).toBe("completed"); expect(boundedResult.view.observations[0]!.collectionComplete).toBeNull();
    expect(boundedResult.view.observations[0]!.results[0]!.coverage.complete).toBe(false); expect(await f.business(await current())).toEqual(before);
    f.controls.decision = packet => { const decision = nativeV2Sequence(packet); if (decision.action === "finish") {
      const observation = packet.observations[0]!, page = observation.results[0]!; if (page.tool !== "inventory.balances.page") throw new Error("Actual inventory prefix missing");
      decision.result!.claims.push({ stepId: observation.stepId, resultIndex: 0, dataChecksum: page.dataChecksum, path: ["total"], value: page.data.total });
    } return decision; };
    const forgedInput = await f.request(f.base.a, { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: stock.stockItemId } }], limits: { ...(await f.request()).limits, maxRows: 1 } });
    const forged = await f.service().start(await current(), forgedInput); await f.process(forged.id); expect(await read(forged.id)).toMatchObject({ status: "failed", result: null, items: [] });
    f.clear(); let changed = false;
    f.controls.afterRead = async (_context, _input, output) => { if (!changed && output && typeof output === "object" && "tool" in output && output.tool === "inventory.balances.page") {
      changed = true; await f.base.inventory.recordMovement(await current(), { stockItemId: stock.stockItemId, locationId: stock.locations[0]!, lotId: null, bucket: "physical", type: "adjustment",
        quantityDelta: "1", unit: "meter", sourceType: "manual", sourceId: createEntityId(), reasonCode: "SYNTHETIC_RECOUNT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    } };
    const changedInput = await f.request(f.base.a, { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: stock.stockItemId } }] }), changedRun = await f.service().start(await current(), changedInput);
    await f.process(changedRun.id); expect(changed).toBe(true); expect(await read(changedRun.id)).toMatchObject({ status: "failed", result: null, items: [] });
  }, 120_000);

  it("retains submitted unknown and unknown fees on the original cap and adopts a real response-ready checkpoint once after lease handoff", async () => {
    for (const kind of ["submission", "usage"] as const) {
      f.controls.unknownUsage = kind === "usage"; f.controls.beforeModel = kind === "submission" ? async () => { throw new TypeError("Synthetic submitted V2 response lost"); } : undefined;
      const input = await f.request(f.base.a, { bindings: one() }), run = await f.service().start(await current(), input), calls = f.modelCalls.length;
      await f.process(run.id); const unknown = await read(run.id);
      expect(unknown).toMatchObject({ status: "uncertain", items: [], cost: { knownCostUsd: "0.000000", reservedUsd: "1.000000", coverage: "unknown" } });
      const saved = await f.rows(await current()); await f.process(run.id); await f.service().receipt(await current(), f.proof(input));
      expect(f.modelCalls.length - calls).toBe(1); expect(await f.rows(await current())).toEqual(saved); f.clear();
    }
    const saved = deferred(), release = deferred(); f.controls.decision = packet => finishNativeV2(packet);
    f.controls.afterCheckpoint = async () => { saved.resolve(); await release.promise; };
    const input = await f.request(f.base.a, { bindings: one() }), run = await f.service().start(await current(), input), calls = f.modelCalls.length, pending = f.process(run.id);
    try { await bounded(saved.promise, "Real V2 response checkpoint was not saved"); const checkpoint = (await f.rows(await current())).steps.find(row => row.runId === run.id)!;
      expect(checkpoint).toMatchObject({ phase: "response_ready", submissionState: "received", costUsd: "0.000210" });
      await withTenant(database.db, await current(), tx => tx.update(agentPlanRuns).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(agentPlanRuns.id, run.id)));
      f.controls.afterCheckpoint = undefined; await f.process(run.id); release.resolve(); await bounded(pending, "First V2 checkpoint worker remained active");
      expect(await read(run.id)).toMatchObject({ status: "completed", cost: { modelTurns: 1, knownCostUsd: "0.000210" } }); expect(f.modelCalls.length - calls).toBe(1);
      expect((await f.rows(await current())).steps.find(row => row.id === checkpoint.id)!.responseChecksum).toBe(checkpoint.responseChecksum);
    } finally { release.resolve(); await pending; }
  });

  it("recovers original parent and child receipts without requeueing re-paying or treating a born coordinator as prepared", async () => {
    const context = await current(); f.controls.failQueue = true;
    const input = await f.request(f.base.a, { bindings: one() }), count = f.dispatches.length, created = await Promise.all([f.service().start(context, input), f.service().start(context, input)]);
    expect(new Set(created.map(row => row.id)).size).toBe(1); expect(f.dispatches.length - count).toBe(1);
    const before = await f.rows(context), calls = f.modelCalls.length;
    await f.service().get(context, created[0]!.id); await f.service().receipt(context, f.proof(input)); expect(await f.rows(context)).toEqual(before); expect(f.modelCalls.length).toBe(calls);
    await expect(f.service().start(context, { ...input, goal: "Changed original request" })).rejects.toBeInstanceOf(ConflictException);
    f.clear(); await f.process(created[0]!.id);
    const result = await simple([source.old.requisition]), item = result.view.items[0]!, body = f.prepareInput(result.view, item);
    const interrupted = vi.spyOn(f.legacy.owners.adapter, "prepare").mockRejectedValueOnce(new Error("Synthetic original preparation interrupted before owner result"));
    try { await expect(f.service().prepareItem(context, result.view.id, item.id, body)).rejects.toThrow("Synthetic original preparation interrupted"); } finally { interrupted.mockRestore(); }
    expect(await f.service().itemReceipt(context, result.view.id, item.id, body)).toMatchObject({ disposition: "unknown", agentCommandId: null, ownerCommandId: null });
    const unknown = await f.rows(context); await f.service().itemReceipt(context, result.view.id, item.id, body); expect(await f.rows(context)).toEqual(unknown);
    const known = await f.service().prepareItem(context, result.view.id, item.id, body); expect(known.disposition).toBe("known");
    const fixed = await f.rows(context); await f.service().prepareItem(context, result.view.id, item.id, body); expect(await f.rows(context)).toEqual(fixed);
    await expect(f.service().itemReceipt(context, result.view.id, item.id, { ...body, proposalChecksum: "f".repeat(64) })).rejects.toBeInstanceOf(ConflictException);
  });

  it("shares original active and monthly admission and preserves owner-only minimal stop after domain authority is removed", async () => {
    const context = await current(), oldInput = await f.legacy.request(f.base.a), old = await f.legacy.service().start(context, oldInput), added: AgentNativeV2View[] = [];
    try { for (let index = 0; index < 3; index++) added.push(await f.service().start(context, await f.request(f.base.a, { bindings: one() })));
      const before = await f.rows(context); await expect(f.service().start(context, await f.request(f.base.a, { bindings: one() }))).rejects.toBeInstanceOf(ConflictException);
      await expect(f.legacy.service().start(context, await f.legacy.request(f.base.a))).rejects.toBeInstanceOf(ConflictException); expect(await f.rows(context)).toEqual(before);
      const narrow = await f.base.scopes(f.base.a, { ...nativeV2Scopes(), [Permission.WorkflowRead]: "self", [Permission.WorkflowRun]: "self", [Permission.InventoryRead]: "self" });
      const receipt = await f.service().stop(narrow, added[0]!.id, { version: AGENT_NATIVE_V2_VERSION, requestId: added[0]!.requestId });
      expect(receipt).toMatchObject({ runId: added[0]!.id, privateAvailable: false, contextAuthority: stamp(narrow) });
      await expect(f.service().stop(await f.base.current(f.base.second), added[0]!.id, { version: AGENT_NATIVE_V2_VERSION, requestId: added[0]!.requestId })).rejects.toBeInstanceOf(NotFoundException);
    } finally { await f.base.scopes(f.base.a, nativeV2Scopes()); await f.legacy.service().stop(context, old.id, { version: "erp-agent-native-v1", requestId: old.requestId }); await f.legacy.process(old.id);
      for (const run of added) { await f.service().stop(await current(), run.id, { version: AGENT_NATIVE_V2_VERSION, requestId: run.requestId }); await f.process(run.id); } }
    const [policy] = await withTenant(database.db, await current(), tx => tx.select().from(aiBudgetPolicies)); if (!policy) throw new Error("Original initialized policy missing");
    try { await withTenant(database.db, await current(), tx => tx.update(aiBudgetPolicies).set({ monthlyCapUsd: "0.5" }).where(eq(aiBudgetPolicies.tenantId, policy.tenantId)));
      const before = await f.rows(await current()); await expect(f.service().start(await current(), await f.request(f.base.a, { bindings: one() }))).rejects.toBeInstanceOf(ConflictException);
      expect(await f.rows(await current())).toEqual(before);
    } finally { await withTenant(database.db, await current(), tx => tx.update(aiBudgetPolicies).set({ monthlyCapUsd: policy.monthlyCapUsd }).where(eq(aiBudgetPolicies.tenantId, policy.tenantId))); }
  });

  it("requires authentic176 closure and real35second physical retention without rewriting old pins trace fees or metadata receipts", async () => {
    const context = await current(), input = await f.request(f.base.a, { bindings: one() }), initial = await f.rows(context), dispatches = f.dispatches.length;
    const failedAudit = vi.spyOn(persistence, "recordAuditInTransaction").mockRejectedValueOnce(new Error("synthetic_native_v2_audit_failure"));
    try { await expect(f.service().start(context, input)).rejects.toThrow("synthetic_native_v2_audit_failure"); } finally { failedAudit.mockRestore(); }
    expect(await f.rows(context)).toEqual(initial); expect(f.dispatches.length).toBe(dispatches);
    const run = await f.service().start(context, input), parent = (await f.rows(context)).runs.find(row => row.id === run.id)!;
    const pinned = f.base.vault.withSecret(parent.encryptedInput!, raw => AgentNativeV2PinnedInputSchema.parse(JSON.parse(raw)));
    expect(pinned.request.bindings).toEqual(input.bindings); expect(nativeHash(pinned)).toBe(parent.inputChecksum);
    expect(await rejected(tx => tx.update(agentPlanRuns).set({ version: "erp-agent-native-v1" }).where(eq(agentPlanRuns.id, run.id)))).toBe("23514");
    expect(await rejected(async tx => { await tx.execute(sql`set constraints all immediate`); await tx.update(agentPlanRuns).set({ originCeiling: f.base.second.context }).where(eq(agentPlanRuns.id, run.id)); })).toBe("23514");
    const before = await f.rows(context);
    expect(await rejected(async tx => { await tx.update(agentPlanRuns).set({ status: "completed", completedAt: new Date() }).where(eq(agentPlanRuns.id, run.id));
      await tx.update(aiBudgetLedger).set({ state: "released" }).where(eq(aiBudgetLedger.id, parent.budgetLedgerId)); })).toBe("23514");
    expect(await rejected(tx => persistence.recordAuditInTransaction(tx, context, { action: "agent.plan.create", resourceType: "agent_plan_run", resourceId: createEntityId(), result: "success",
      metadata: { requestChecksum: parent.requestChecksum, inputChecksum: parent.inputChecksum, budgetLedgerId: parent.budgetLedgerId } }))).toBe("23514");
    expect(await rejected(tx => tx.insert(agentPlanItems).values({ id: createEntityId(), tenantId: context.tenantId, runId: run.id, modelStepId: createEntityId(), position: 0, proposalChecksum: "a".repeat(64) }))).toBe("23514");
    expect(await f.rows(context)).toEqual(before); await f.service().stop(context, run.id, { version: AGENT_NATIVE_V2_VERSION, requestId: input.requestId }); await f.process(run.id);
    f.clear(); const retained = await simple([], 35), born = (await f.rows(context)).runs.find(row => row.id === retained.view.id)!;
    expect(born.expiresAt.getTime() - born.createdAt.getTime()).toBeGreaterThanOrEqual(35000); expect(born.expiresAt.getTime() - born.createdAt.getTime()).toBeLessThan(36000);
    const original = await f.rows(context), trace = original.steps.filter(row => row.runId === born.id).sort((a, b) => a.sequence - b.sequence), calls = f.modelCalls.length, business = await f.business(context);
    const deadline = Date.now() + 45000;
    for (;;) { const [clock] = await withTenant(database.db, context, tx => tx.execute<{ expired: boolean }>(sql`select clock_timestamp()>${born.expiresAt.toISOString()}::timestamptz as expired`));
      if (clock?.expired) break; if (Date.now() > deadline) throw new Error("Actual immutable nativeV2 retention did not elapse"); await delay(500); }
    await f.runtime().process(context, born.id, "expire"); const cleaned = await f.rows(context), actual = cleaned.runs.find(row => row.id === born.id)!;
    expect(actual).toMatchObject({ encryptedInput: null, encryptedResult: null, resultChecksum: null });
    const clear = (row: (typeof trace)[number]) => Object.fromEntries(Object.entries(row).filter(([key]) => !["encryptedInput", "encryptedOutput", "encryptedResponse"].includes(key)));
    const afterTrace = cleaned.steps.filter(row => row.runId === born.id).sort((a, b) => a.sequence - b.sequence);
    expect(afterTrace.every(row => row.encryptedInput === null && row.encryptedOutput === null && row.encryptedResponse === null)).toBe(true); expect(afterTrace.map(clear)).toEqual(trace.map(clear));
    expect(cleaned.ledgers).toEqual(original.ledgers); expect(cleaned.audits).toEqual(original.audits); expect(f.modelCalls.length).toBe(calls); expect(await f.business(context)).toEqual(business);
    expect(await read(born.id)).toMatchObject({ privateAvailable: false, readContracts: null, steps: [], definitions: [], observations: [], result: null });
    expect(await f.service().receipt(context, f.proof(retained.input))).toMatchObject({ disposition: "known", runId: born.id, privateAvailable: false });
  }, 70_000);

  it("reads all eleven original bindings through the actual production Worker owner factories with identical definition and source hashes", async () => {
    const context = await current(), business = await f.business(context), models = f.modelCalls.length;
    const request = await f.request(f.base.a, { bindings: source.bindings }), queued = await f.service().start(context, request);
    const original = await f.rows(context), parent = original.runs.find(row => row.id === queued.id)!;
    const pinned = f.base.vault.withSecret(parent.encryptedInput!, raw => AgentNativeV2PinnedInputSchema.parse(JSON.parse(raw)));
    expect(nativeHash(pinned)).toBe(parent.inputChecksum); expect(pinned.request.bindings).toEqual(source.bindings);
    const api = { tools: f.legacy.gateway, resources: f.resources.service }, worker = {
      tools: createWorkerAgentTools(database, f.base.integrationVault), resources: createWorkerAgentResources(database),
    };
    const checked: string[] = []; let foreignCall: ReturnType<typeof agentNativeV2Protocol.readCall> | undefined;
    for (const [bindingIndex, binding] of pinned.request.bindings.entries()) {
      const selection = { kind: "read" as const, tool: binding.tool };
      const apiDefinition = agentNativeV2Protocol.validateDefinition(pinned, await agentNativeV2Protocol.definition(context, selection, api), selection);
      const workerDefinition = agentNativeV2Protocol.validateDefinition(pinned, await agentNativeV2Protocol.definition(context, selection, worker), selection);
      expect(workerDefinition.definitionChecksum).toBe(apiDefinition.definitionChecksum);
      const call = agentNativeV2Protocol.readCall(pinned, { bindingIndex, keyword: binding.tool === "knowledge.search" ? source.query : null }, apiDefinition.definitionChecksum, { pageSize: 1 });
      const apiResult = await agentNativeV2Protocol.call(context, call, api), workerResult = await agentNativeV2Protocol.call(context, call, worker);
      agentNativeV2Protocol.verifyReadResult(apiResult, call); agentNativeV2Protocol.verifyReadResult(workerResult, call);
      expect(workerResult.tool).toBe(binding.tool); expect(workerResult.contextAuthority).toBe(stamp(context));
      expect(nativeHash(agentNativeV2SourceBasis(workerResult))).toBe(nativeHash(agentNativeV2SourceBasis(apiResult)));
      checked.push(workerResult.tool); if (binding.tool === "catalog.sku") foreignCall = call;
    }
    expect(checked).toEqual(AgentNativeV2ReadKeySchema.options);
    if (!foreignCall) throw new Error("Actual original SKU call missing for foreign-tenant Worker rejection");
    await expect(worker.resources.call(await f.base.current(f.base.foreign), foreignCall)).rejects.toMatchObject({ status: 404 });
    const after = await f.rows(context);
    expect(after.runs).toEqual(original.runs); expect(after.steps).toEqual(original.steps); expect(after.ledgers).toEqual(original.ledgers);
    expect(f.modelCalls.length).toBe(models); expect(await f.business(context)).toEqual(business);
  }, 120_000);
});
