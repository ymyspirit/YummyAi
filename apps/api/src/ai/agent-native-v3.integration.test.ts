import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission, erpPermissionContext } from "@yummyai/authz";
import { type TenantContext, createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_FULFILLMENT_TOOL, AgentFulfillmentCallSchema, AgentFulfillmentResultSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3BindingSchema, AgentNativeV3ViewSchema, AgentNativeV3PinnedInputSchema,
  AgentNativeV3ReadKeySchema, agentNativeV3SourceBasis, type AgentNativeV3View, type CreateAgentNativeV3 } from "@yummyai/contracts/ai/agent-native-v3";
import { verifyAgentNativeV3Transport } from "@yummyai/contracts/ai/agent-native-v3-transport";
import { aiBudgetLedger, aiBudgetPolicies, agentPlanRuns, agentPlanItems, orderProtectedDetails, connectDatabase, withTenant, type TenantTransaction } from "@yummyai/database";
import * as persistence from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { agentNativeV3Protocol } from "@yummyai/workflow-core";
import { createWorkerAgentTools } from "../../../worker/src/agent-native-owners.js";
import { createWorkerAgentResources } from "../../../worker/src/agent-resources-owners.js";
import { createWorkerAgentFulfillment } from "../../../worker/src/agent-fulfillment-owners.js";
import { bounded, deferred } from "./agent-read.test-fixture.js";
import { agentNativeV3Fixture, finishNativeV3, nativeV3Sequence, nativeV3Scopes, nativeV3Hash, requireAgentNativeV3Environment } from "./agent-native-v3.test-fixture.js";

const environment = requireAgentNativeV3Environment(), database = connectDatabase(environment.url), f = agentNativeV3Fixture(database);
let source: Awaited<ReturnType<typeof f.seed>>;
const current = () => f.base.current(f.base.a), stamp = (value: TenantContext) => erpSessionAuthority(erpPermissionContext(value));
const digest = (value: unknown) => nativeV3Hash(canonicalJson(value));
const one = () => [source.bindings[1]!];
async function read(id: string, context?: TenantContext) {
  const value = AgentNativeV3ViewSchema.parse(await f.service().get(context ?? await current(), id)); await verifyAgentNativeV3Transport(value); return value;
}
async function simple(originals: typeof source.originals = [], changes: Partial<CreateAgentNativeV3> = {}, retention?: number) {
  const context = await current(); f.controls.decision = packet => nativeV3Sequence(packet, originals, source.query);
  const input = await f.request(f.base.a, { bindings: one(), allowedCommands: originals.map(original => AgentPlanCommandKeySchema.parse({ domain: original.domain, kind: original.command.kind })),
    ...(retention ? { limits: { ...((await f.request()).limits), deadlineSeconds: 30 } } : {}), ...changes });
  const created = await f.service(retention).start(context, input); await f.process(created.id); return { input, view: await read(created.id) };
}
function pgCode(error: unknown): string | null { for (let count = 0; count < 7 && error && typeof error === "object"; count++) {
  if ("code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) return error.code; error = "cause" in error ? error.cause : null;
} return null; }
async function rejected(work: (tx: TenantTransaction) => Promise<unknown>) {
  try { await withTenant(database.db, await current(), async tx => { await work(tx); await tx.execute(sql`set constraints all immediate`); }); }
  catch (error) { return pgCode(error); } throw new Error("Actual V3 SQL mutation unexpectedly committed");
}

describe.sequential("native v3 real fourteen-binding same-order fulfillment model task", () => {
  beforeAll(async () => { await f.initialize(); source = await f.seed(); }, 180_000);
  afterEach(async () => {
    vi.restoreAllMocks(); f.clear();
    for (const actor of [f.base.a, f.base.second, f.base.foreign]) { await f.base.memberActive(actor, true); await f.base.scopes(actor, nativeV3Scopes()); }
    const context = await current(), rows = await f.rows(context);
    for (const run of rows.runs.filter(row => row.ownerId === context.userId && row.version === AGENT_NATIVE_V3_VERSION && ["queued", "running", "stopping"].includes(row.status))) {
      await f.service().stop(context, run.id, { version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId }); await f.process(run.id);
    }
    await f.settlePrepared(context);
  });
  afterAll(async () => { const errors: unknown[] = []; try { await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV3 disposable integration teardown failed"); });

  it("executes all fourteen fixed bindings in one real Redis task with Worker API owner parity then individually confirms two original commands", async () => {
    const context = await current(), business = await f.business(context), fulfillment = await f.fulfillmentBusiness(context), carrier = { ...f.fulfillment.carrier.calls };
    const input = await f.request(f.base.a, { bindings: source.bindings, allowedCommands: [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }] });
    const run = await f.service().start(context, input), parent = (await f.rows(context)).runs.find(row => row.id === run.id)!;
    const pinned = f.base.vault.withSecret(parent.encryptedInput!, raw => AgentNativeV3PinnedInputSchema.parse(JSON.parse(raw)));
    expect(digest(pinned)).toBe(parent.inputChecksum); expect(pinned.request.bindings).toHaveLength(14);
    const api = { tools: f.prior.legacy.gateway, resources: f.prior.resources.service, fulfillment: f.fulfillmentService }, worker = {
      tools: createWorkerAgentTools(database, f.base.integrationVault), resources: createWorkerAgentResources(database), fulfillment: createWorkerAgentFulfillment(database, f.base.originalVault),
    };
    const parity: string[] = [];
    for (const [bindingIndex, binding] of pinned.request.bindings.entries()) {
      const selection = { kind: "read" as const, tool: binding.tool };
      const a = agentNativeV3Protocol.validateDefinition(pinned, await agentNativeV3Protocol.definition(context, selection, api), selection);
      const b = agentNativeV3Protocol.validateDefinition(pinned, await agentNativeV3Protocol.definition(context, selection, worker), selection);
      expect(b.definitionChecksum).toBe(a.definitionChecksum);
      const call = agentNativeV3Protocol.readCall(pinned, { bindingIndex, keyword: binding.tool === "knowledge.search" ? source.query : null }, a.definitionChecksum, { pageSize: 1 });
      const original = await agentNativeV3Protocol.call(context, call, api), actual = await agentNativeV3Protocol.call(context, call, worker);
      agentNativeV3Protocol.verifyReadResult(original, call); agentNativeV3Protocol.verifyReadResult(actual, call);
      expect(digest(agentNativeV3SourceBasis(actual))).toBe(digest(agentNativeV3SourceBasis(original)));
      parity.push(binding.tool === AGENT_FULFILLMENT_TOOL ? `${binding.tool}/${binding.scope.kind}` : binding.tool);
      if (call.version === "erp-agent-fulfillment-v1") await expect(worker.fulfillment.call(await f.base.current(f.base.foreign), call)).rejects.toMatchObject({ status: 404 });
    }
    expect(parity).toHaveLength(14); expect(new Set(parity).size).toBe(14);
    const calls = f.modelCalls.length, definitions = f.definitionCalls.length, reads = f.readCalls.length;
    f.controls.decision = packet => nativeV3Sequence(packet, source.originals, source.query); await f.process(run.id); const view = await read(run.id);
    expect(view.status, JSON.stringify({ status: view.status, errorCode: view.errorCode, modelTurns: view.cost.modelTurns,
      toolCalls: view.toolCalls, observedRows: view.observedRows, steps: view.steps.map(step => ({ id: step.id, sequence: step.sequence,
        kind: step.kind, phase: step.phase, errorCode: step.errorCode, submissionState: step.submissionState })) })).toBe("completed");
    expect(view.observations.map(row => row.request.bindingIndex)).toEqual(Array.from({ length: 14 }, (_, index) => index));
    expect(new Set(view.observations.map(row => row.tool))).toEqual(new Set(AgentNativeV3ReadKeySchema.options));
    expect(view.cost).toMatchObject({ modelTurns: 29, knownCostUsd: "0.006090", reservedUsd: "0.000000", coverage: "known" });
    expect(view.steps).toHaveLength(57); expect(view.toolCalls).toBe(73); expect(f.modelCalls.length - calls).toBe(29);
    // Five old-reader access probes run before later submissions, independently
    // of the 28 definition and 28 read evidence/recheck calls.
    expect({ definitions: f.definitionCalls.length - definitions, reads: f.readCalls.length - reads }).toEqual({ definitions: 148, reads: 155 });
    expect({ definitions: f.definitionCalls.length - definitions - 28 - 5, reads: f.readCalls.length - reads - 28 - 12 }).toEqual({ definitions: 115, reads: 115 });
    expect(view.definitions).toHaveLength(14); expect(view.items).toHaveLength(2);
    const fulfillmentObservations = view.observations.filter(row => row.tool === AGENT_FULFILLMENT_TOOL);
    expect(fulfillmentObservations.map(row => [row.collectionComplete, row.indexComplete])).toEqual([[null, true], [null, true], [null, true]]);
    const packets = fulfillmentObservations.map(row => AgentFulfillmentResultSchema.parse(row.results[0]));
    const production = packets.find(row => row.data.kind === "production")!, shipment = packets.find(row => row.data.kind === "shipments")!, logistics = packets.find(row => row.data.kind === "logistics")!;
    if (production.data.kind !== "production" || shipment.data.kind !== "shipments" || logistics.data.kind !== "logistics") throw new Error("Three actual same-order kinds required");
    const row = production.data.rows[0]!;
    expect(packets.map(packet => packet.data.order.id)).toEqual([source.order.id, source.order.id, source.order.id]);
    expect(packets.every(packet => packet.data.coverage.complete === false)).toBe(true);
    expect(row.quality.data?.groups.map(group => [group.quantity, group.result]).sort()).toEqual([[2, "failed"], [3, "passed"]]);
    expect(row.delivery.data).toMatchObject({ manufacturingContentChecksum: source.scene.packet.items[0]!.snapshot!.manufacturing!.sourceContentChecksum,
      manufacturingPlanChecksum: source.scene.packet.items[0]!.snapshot!.manufacturing!.plan.checksum });
    expect(row.factory.data).toMatchObject({ status: "shipped", shippedQuantity: null, exception: null, voidSummary: { pending: 0, requiresOrderHandling: 1 } });
    expect(shipment.data.rows[0]!.physicalHandover).toMatchObject({ packageCount: 1, dispatchedPackageCount: 0, allDispatched: false });
    expect(shipment.data.rows[0]!.writebacks).toEqual([]);
    expect(logistics.data.rows[0]).toMatchObject({ quotedCostMinor: 500, actualCostMinor: 600, quotedCurrency: "USD", actualCurrency: "USD", minorUnitDigits: 2 });
    const profit = view.observations.find(value => value.tool === "finance.profit_run")!.results[0]!;
    if (profit.tool !== "finance.profit_run") throw new Error("Actual original profit branch required");
    expect(profit.data.profitMinor).toBe(5300); expect(profit.data.reportingCurrency).toBe("USD");
    expect(await f.business(context)).toEqual(business); expect(await f.fulfillmentBusiness(context)).toEqual(fulfillment); expect(f.fulfillment.carrier.calls).toEqual(carrier);
    for (const item of view.items) {
      const receipt = await f.service().prepareItem(context, view.id, item.id, f.prepareInput(view, item)); expect(receipt.disposition).toBe("known");
      if (!receipt.agentCommandId || !receipt.ownerCommandId) throw new Error("Real original prepared IDs missing");
      const command = await f.prior.legacy.owners.service().get(context, receipt.agentCommandId); expect(command.snapshot?.native.view.status).toBe("prepared");
      const before = await f.business(context); await f.service().itemReceipt(context, view.id, item.id, f.prepareInput(view, item)); expect(await f.business(context)).toEqual(before);
      const confirmed = await f.prior.legacy.owners.service().confirm(context, command.id, f.confirmation(command)); expect(confirmed.snapshot?.native.view.status).toBe("succeeded");
      const stable = await f.business(context); await f.prior.legacy.owners.service().confirm(context, command.id, f.confirmation(command)); expect(await f.business(context)).toEqual(stable);
    }
    const after = await f.business(context); expect(after.inventory_procurement_requisitions!.count - business.inventory_procurement_requisitions!.count).toBe(1);
    expect(after.finance_payable_bills!.count - business.finance_payable_bills!.count).toBe(1); expect(f.modelCalls.length - calls).toBe(29);
  }, 180_000);

  it("rejects wrong quoted actual money currency unit source hashes and automatic actions while retaining all real model charges", async () => {
    const business = await f.business(await current()), fulfillment = await f.fulfillmentBusiness(await current());
    for (const variant of ["amount", "currency", "digits", "foreign_hash", "coverage", "execute"] as const) {
      f.controls.decision = packet => {
        if (variant === "execute") return { action: "execute", label: "Forbidden automatic business write", definition: null, read: null, result: null };
        const decision = nativeV3Sequence(packet); if (decision.action !== "finish") return decision;
        const claims = decision.result!.claims, claim = claims.find(value => value.path.at(-1) === "actualCostMinor");
        if (!claim) throw new Error("Actual stored logistics cost claim required"); expect(claim.value).toBe(600);
        if (variant === "amount") claim.value = 6;
        if (variant === "currency") { claim.path = ["rows", 0, "actualCurrency"]; claim.value = "EUR"; }
        if (variant === "digits") { claim.path = ["rows", 0, "minorUnitDigits"]; claim.value = 3; }
        if (variant === "foreign_hash") claim.dataChecksum = "f".repeat(64);
        if (variant === "coverage") { claim.path = ["coverage", "indexedTotal"]; claim.value = 1; }
        return decision;
      };
      const input = await f.request(f.base.a, { bindings: [source.bindings[13]!] }), run = await f.service().start(await current(), input), calls = f.modelCalls.length;
      await f.process(run.id); const failed = await read(run.id);
      expect(failed.status).toBe("failed"); expect(failed.items).toEqual([]); expect(failed.result).toBeNull();
      expect(failed.cost.knownCostUsd).toBe(((f.modelCalls.length - calls) * 210 / 1_000_000).toFixed(6)); expect(failed.cost.reservedUsd).toBe("0.000000");
      expect(await f.business(await current())).toEqual(business); expect(await f.fulfillmentBusiness(await current())).toEqual(fulfillment);
    }
  });

  it("uses genuine personal OIDC original ceilings per-bit permissions and tenant isolation then discards a late completed owner response", async () => {
    const context = await current(), origin = await f.startHttp(), token = await f.token(), input = await f.request(f.base.a, { bindings: [source.bindings[13]!] });
    const response = await fetch(origin + "/v1/agent-native-v3/runs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(201); const run = AgentNativeV3ViewSchema.parse(await response.json()); await f.process(run.id);
    for (const actor of [f.base.second, f.base.foreign]) { await expect(f.service().get(await f.base.current(actor), run.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await f.service().receipt(await f.base.current(actor), f.proof(input))).toMatchObject({ disposition: "not_found", runId: null }); }
    const self = await f.base.scopes(f.base.a, { ...nativeV3Scopes(), [Permission.WorkflowRead]: "self", [Permission.WorkflowRun]: "self", [Permission.OrderPiiRead]: "self" });
    const withoutPrivateFactory = await simple([], { bindings: [source.bindings[11]!] }); expect(withoutPrivateFactory.view.status).toBe("completed");
    const actual = withoutPrivateFactory.view.observations[0]!.results[0]!;
    if (actual.version !== "erp-agent-fulfillment-v1" || actual.data.kind !== "production") throw new Error("Actual production branch required");
    expect(actual.data.rows[0]!.factory).toEqual({ state: "unavailable", reason: "permission_required", data: null });
    const born = (await f.rows(self)).runs.find(row => row.id === withoutPrivateFactory.view.id)!; expect(born.originCeiling.permissionScopes?.[Permission.WorkflowRun]).toBe("self");
    const stable = await f.rows(self); await expect(f.service().start(self, await f.request(f.base.a, { bindings: [source.bindings[13]!] }))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.rows(self)).toEqual(stable); expect(await f.service().get(self, run.id)).toMatchObject({ privateAvailable: false, readContracts: null, steps: [], observations: [], result: null });
    expect(await f.service().stop(self, run.id, { version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId })).toMatchObject({ runId: run.id, contextAuthority: stamp(self), privateAvailable: false });
    await f.base.scopes(f.base.a, nativeV3Scopes());
    const entered = deferred(), release = deferred(); let held = false;
    f.controls.afterRead = async (_reader, _call, result) => { if (!held && result && typeof result === "object" && "tool" in result && result.tool === AGENT_FULFILLMENT_TOOL) { held = true; entered.resolve(); await release.promise; } };
    const late = await f.service().start(await current(), await f.request(f.base.a, { bindings: [source.bindings[13]!] })), pending = f.process(late.id);
    try { await bounded(entered.promise, "Actual logistics owner response did not finish"); const before = f.modelCalls.length;
      await f.base.scopes(f.base.a, { ...nativeV3Scopes(), [Permission.OrderPiiRead]: "self" }); release.resolve(); await bounded(pending, "Late original logistics read did not settle");
      expect(f.modelCalls.length - before).toBe(0);
    } finally { release.resolve(); await pending; await f.base.scopes(f.base.a, nativeV3Scopes()); f.clear(); }
    expect(await read(late.id)).toMatchObject({ status: "failed", result: null, items: [] });
    expect((await f.rows(await current())).runs.find(row => row.id === run.id)!.originCeiling).toEqual((await f.rows(context)).runs.find(row => row.id === run.id)!.originCeiling);
  });

  it("retains sealed history on normal order progress but rejects changed factory void basis and same-stamp object withdrawal before any next paid model", async () => {
    let context = await current(); const created = await simple([source.originals[0]!], { bindings: [source.bindings[11]!] });
    const parent = (await f.rows(context)).runs.find(row => row.id === created.view.id)!, sealed = created.view.observations;
    const reviewed = await f.reviewVoid(context, source.scene, source.voided);
    expect(reviewed.reviewRevision).toBe(source.reviewed.reviewRevision + 1); expect(reviewed.previousReviewId).toBe(source.reviewed.id);
    const item = created.view.items[0]!; await expect(f.service().prepareItem(context, created.view.id, item.id, f.prepareInput(created.view, item))).rejects.toBeInstanceOf(ConflictException);
    const historical = await read(created.view.id); expect(historical.privateAvailable).toBe(true); expect(historical.observations).toEqual(sealed);
    await f.fulfillment.orders.openException(context, source.scene.order.id, { category: "production", code: "SYNTHETIC_NORMAL_PROGRESS", message: "Synthetic normal original sequence advance", idempotencyKey: randomUUID() });
    expect((await read(created.view.id)).observations).toEqual(sealed);
    const retained = (await f.rows(context)).runs.find(row => row.id === created.view.id)!; expect(retained.encryptedResult).toBe(parent.encryptedResult); expect(retained.knownCostUsd).toBe(parent.knownCostUsd);
    const [privacy] = await withTenant(database.db, context, tx => tx.select({ envelopeVersion: orderProtectedDetails.envelopeVersion, retentionExpiresAt: orderProtectedDetails.retentionExpiresAt })
      .from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, source.scene.order.id)));
    if (!privacy) throw new Error("Actual fixed order privacy envelope required");
    const originalOrder = await f.fulfillment.orders.get(context, source.scene.order.id), anonymize = { expectedSequence: originalOrder.latestEventSequence,
      expectedEnvelopeVersion: privacy.envelopeVersion, reason: "Synthetic original privacy owner test clock after its stored retention boundary", idempotencyKey: randomUUID() };
    const beforeEarlyPrivacy = await f.fulfillmentBusiness(context);
    await expect(f.fulfillment.orders.anonymizeProtectedDetails(context, originalOrder.id, anonymize)).rejects.toThrow("Protected detail retention period has not expired");
    expect(await f.fulfillmentBusiness(context)).toEqual(beforeEarlyPrivacy);
    // This is the original owner's per-call test clock, not natural ninety-day
    // expiration or a modification of persisted TTL, DB or global time.
    await f.fulfillment.orders.anonymizeProtectedDetails(context, originalOrder.id, anonymize, new Date(privacy.retentionExpiresAt.getTime() + 1));
    expect(await read(created.view.id)).toMatchObject({ privateAvailable: false, readContracts: null, goal: null, contextText: null, steps: [], definitions: [], observations: [], result: null });
    const afterPrivacy = (await f.rows(context)).runs.find(row => row.id === created.view.id)!;
    expect(afterPrivacy.encryptedResult).toBe(parent.encryptedResult); expect(afterPrivacy.resultChecksum).toBe(parent.resultChecksum); expect(afterPrivacy.knownCostUsd).toBe(parent.knownCostUsd);
    const team = await f.base.team(f.base.a), memberId = await f.prior.resources.joinTeam(f.base.second, team.teamId); context = await current();
    const actualSource = await f.prior.resources.seed(context, team.teamId), peer = await f.base.scopes(f.base.second, { ...nativeV3Scopes(), [Permission.ProductRead]: "team" });
    const peerInput = await f.request(f.base.second, { bindings: [{ tool: "catalog.sku", scope: actualSource.inputs["catalog.sku"] }] });
    const spu = (await f.prior.resources.facts.development.options(context)).spus.find(row => row.id === actualSource.sku.spu.id)!;
    const update = { code: spu.code, name: spu.name, description: spu.description, ...(spu.capabilities ? { capabilities: spu.capabilities } : {}) };
    const entered = deferred(), release = deferred(); let held = false, moved: Awaited<ReturnType<typeof f.prior.resources.facts.development.updateSpu>> | undefined;
    f.controls.decision = packet => nativeV3Sequence(packet); f.controls.afterRead = async (reader, _call, result) => {
      if (!held && reader.userId === peer.userId && result && typeof result === "object" && "tool" in result && result.tool === "catalog.sku") { held = true; entered.resolve(); await release.promise; }
    };
    const late = await f.service().start(peer, peerInput), pending = f.process(late.id, f.base.second);
    try { await bounded(entered.promise, "Actual team SKU read did not reach the completed response gate");
      moved = await f.prior.resources.facts.development.updateSpu(context, spu.id, { ...update, teamId: null, expectedRevision: spu.revision, idempotencyKey: randomUUID() });
      const calls = f.modelCalls.length, paid = (await f.rows(peer)).runs.find(row => row.id === late.id)!.knownCostUsd;
      expect(stamp(await f.base.current(f.base.second))).toBe(stamp(peer)); release.resolve(); await bounded(pending, "Same-stamp object withdrawal did not settle");
      expect(f.modelCalls.length - calls).toBe(0); expect(await read(late.id, peer)).toMatchObject({ status: "failed", result: null, items: [], cost: { knownCostUsd: paid, reservedUsd: "0.000000" } });
    } finally { release.resolve(); await pending; f.controls.afterRead = undefined;
      if (moved) await f.prior.resources.facts.development.updateSpu(context, spu.id, { ...update, teamId: team.teamId, expectedRevision: moved.spu.revision, idempotencyKey: randomUUID() });
      await f.base.teamActive(f.base.second, memberId, false); }
  }, 180_000);

  it("collects original fulfillment pages beyond ten and all501 stock dimensions while preserving prefix limits and rechecking every sealed page", async () => {
    const context = await current(), scene = await f.fulfillment.seed(context, Array<number>(11).fill(1)), order = await f.fulfillment.orders.get(context, scene.order.id);
    const binding = AgentNativeV3BindingSchema.parse({ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId: order.id, expectedSequence: order.latestEventSequence, kind: "production" } });
    const complete = await simple([], { bindings: [binding] }), observation = complete.view.observations[0]!;
    expect(complete.view.status).toBe("completed"); expect(observation).toMatchObject({ observedRows: 11, collectionComplete: null, indexComplete: true, truncatedBy: null });
    expect(observation.results).toHaveLength(2); expect(observation.results.map(value => value.version === "erp-agent-fulfillment-v1" ? value.data.rows.length : -1)).toEqual([10, 1]);
    expect(new Set(observation.results.flatMap(value => value.version === "erp-agent-fulfillment-v1" ? value.data.rows.map(row => row.id) : [])).size).toBe(11);
    const prefix = await simple([], { bindings: [binding], limits: { ...(await f.request()).limits, maxRows: 1 } });
    expect(prefix.view.status).toBe("partial"); expect(prefix.view.observations[0]).toMatchObject({ observedRows: 1, collectionComplete: null, indexComplete: false, truncatedBy: "row_limit" });
    const stock = await f.base.stock(f.base.a, 501), inventory = await simple([], { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: stock.stockItemId } }] });
    expect(inventory.view.status).toBe("completed"); expect(inventory.view.observations[0]).toMatchObject({ collectionComplete: true, indexComplete: null, observedRows: 501 });
    expect(inventory.view.observations[0]!.results).toHaveLength(6);
    const originalFirst = await f.fulfillmentService.call(context, AgentFulfillmentCallSchema.parse({ version: "erp-agent-fulfillment-v1", tool: AGENT_FULFILLMENT_TOOL,
      executionContract: (await f.fulfillmentService.workspace(context)).executionContract, definitionChecksum: (await f.fulfillmentService.workspace(context)).definition.definitionChecksum,
      input: { ...binding.scope, pageSize: 10, cursor: null } }));
    expect(originalFirst.data.coverage.hasMore).toBe(true);
    // A factory review changes the original business projection independently
    // of order sequence and the production index. It must not survive finish.
    const finalPage = AgentFulfillmentResultSchema.parse(observation.results[1]);
    if (finalPage.data.kind !== "production") throw new Error("Actual second production page required");
    const secondPageProduction = finalPage.data.rows[0]!.id, selected = scene.items.find(row => row.productionOrderId === secondPageProduction)!;
    const selectedProduction = scene.productions.find(row => row.order.id === secondPageProduction)!;
    // This is an explicitly selected one-item factory row, admitted and checked
    // by the original whole-group quantity gate, not a raw status update.
    const factoryGroup = { ...scene, items: [selected], quantity: selectedProduction.quantity };
    const full = await f.fulfillment.observe(context, factoryGroup, "已作废"), beforeIndex = await f.fulfillment.production.evidenceIndex(context, scene.order.id);
    const stableFirst = await f.fulfillmentService.call(context, AgentFulfillmentCallSchema.parse({ version: "erp-agent-fulfillment-v1", tool: AGENT_FULFILLMENT_TOOL,
      executionContract: (await f.fulfillmentService.workspace(context)).executionContract, definitionChecksum: originalFirst.definitionChecksum, input: originalFirst.input }));
    const readOffset = f.readCalls.length;
    let changed = false; f.controls.afterRead = async (_reader, _call, result) => {
      if (!changed && result && typeof result === "object" && "tool" in result && result.tool === AGENT_FULFILLMENT_TOOL && "data" in result && result.data && typeof result.data === "object" && "coverage" in result.data &&
        result.data.coverage && typeof result.data.coverage === "object" && "hasMore" in result.data.coverage && result.data.coverage.hasMore === false) {
        changed = true; await f.reviewVoid(context, factoryGroup, full);
      }
    };
    f.controls.decision = packet => nativeV3Sequence(packet); const run = await f.service().start(context, await f.request(f.base.a, { bindings: [binding] })); await f.process(run.id);
    expect(changed).toBe(true); expect(await f.fulfillment.production.evidenceIndex(context, scene.order.id)).toEqual(beforeIndex);
    expect((await f.fulfillment.orders.get(context, scene.order.id)).latestEventSequence).toBe(order.latestEventSequence);
    const afterFirst = await f.fulfillmentService.call(context, AgentFulfillmentCallSchema.parse({ version: "erp-agent-fulfillment-v1", tool: AGENT_FULFILLMENT_TOOL,
      executionContract: (await f.fulfillmentService.workspace(context)).executionContract, definitionChecksum: originalFirst.definitionChecksum, input: originalFirst.input }));
    expect(digest(agentNativeV3SourceBasis(afterFirst))).toBe(digest(agentNativeV3SourceBasis(stableFirst)));
    expect(f.readCalls.slice(readOffset).filter(value => value.kind === "fulfillment" && AgentFulfillmentCallSchema.parse(value.input).input.cursor !== null)).toHaveLength(2);
    expect(await read(run.id)).toMatchObject({ status: "failed", result: null, items: [] });
  }, 240_000);

  it("keeps submitted unknown received checkpoint cancellation and mixed global budgets exact without a second provider submission", async () => {
    let context = await current(); f.controls.beforeModel = async () => { throw new TypeError("Synthetic model response lost after submission"); };
    const input = await f.request(f.base.a, { bindings: one() }), unknown = await f.service().start(context, input), calls = f.modelCalls.length; await f.process(unknown.id);
    const uncertain = await read(unknown.id); expect(uncertain).toMatchObject({ status: "uncertain", cost: { coverage: "unknown", reservedUsd: "1.000000" } });
    const stable = await f.rows(context); await f.process(unknown.id); await f.service().receipt(context, f.proof(input)); expect(await f.rows(context)).toEqual(stable); expect(f.modelCalls.length - calls).toBe(1);
    f.clear(); f.controls.unknownUsage = true; const missingFee = await simple(); expect(missingFee.view).toMatchObject({ status: "uncertain", cost: { coverage: "unknown", reservedUsd: "1.000000" } });
    f.clear(); f.controls.decision = packet => finishNativeV3(packet); const checkpointed = deferred(), release = deferred();
    f.controls.afterCheckpoint = async () => { checkpointed.resolve(); await release.promise; };
    const checkpointInput = await f.request(f.base.a, { bindings: one() }), received = await f.service().start(context, checkpointInput), count = f.modelCalls.length, pending = f.process(received.id);
    try { await bounded(checkpointed.promise, "Actual authenticated model response was not checkpointed");
      const original = (await f.rows(context)).steps.find(row => row.runId === received.id)!; expect(original).toMatchObject({ phase: "response_ready", submissionState: "received", costUsd: "0.000210" });
      await withTenant(database.db, context, tx => tx.update(agentPlanRuns).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(agentPlanRuns.id, received.id)));
      f.controls.afterCheckpoint = undefined; await f.process(received.id); release.resolve(); await bounded(pending, "Prior checkpoint Worker did not settle");
      expect(f.modelCalls.length - count).toBe(1); expect(await read(received.id)).toMatchObject({ status: "completed", cost: { knownCostUsd: "0.000210" } });
      expect((await f.rows(context)).steps.find(row => row.id === original.id)!.responseChecksum).toBe(original.responseChecksum);
    } finally { release.resolve(); await pending; }
    f.clear(); const oldInput = await f.prior.request(), old = await f.prior.service().start(context, oldInput), active: AgentNativeV3View[] = [];
    try { for (let index = 0; index < 3; index++) active.push(await f.service().start(context, await f.request(f.base.a, { bindings: one() })));
      const before = await f.rows(context); await expect(f.service().start(context, await f.request(f.base.a, { bindings: one() }))).rejects.toBeInstanceOf(ConflictException);
      await expect(f.prior.service().start(context, await f.prior.request())).rejects.toBeInstanceOf(ConflictException); expect(await f.rows(context)).toEqual(before);
      context = await f.base.scopes(f.base.a, { ...nativeV3Scopes(), [Permission.WorkflowRead]: "self", [Permission.WorkflowRun]: "self", [Permission.InventoryRead]: "self" });
      expect(await f.service().stop(context, active[0]!.id, { version: AGENT_NATIVE_V3_VERSION, requestId: active[0]!.requestId })).toMatchObject({ runId: active[0]!.id, privateAvailable: false, contextAuthority: stamp(context) });
    } finally { await f.base.scopes(f.base.a, nativeV3Scopes()); context = await current(); await f.prior.service().stop(context, old.id, { version: "erp-agent-native-v2", requestId: old.requestId }); await f.prior.process(old.id);
      for (const run of active) { await f.service().stop(context, run.id, { version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId }); await f.process(run.id); } }
    const [policy] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetPolicies)); if (!policy) throw new Error("Original initialized budget policy missing");
    try { await withTenant(database.db, context, tx => tx.update(aiBudgetPolicies).set({ monthlyCapUsd: "0.5" }).where(eq(aiBudgetPolicies.tenantId, policy.tenantId)));
      const before = await f.rows(context); await expect(f.service().start(context, await f.request(f.base.a, { bindings: one() }))).rejects.toBeInstanceOf(ConflictException); expect(await f.rows(context)).toEqual(before);
    } finally { await withTenant(database.db, context, tx => tx.update(aiBudgetPolicies).set({ monthlyCapUsd: policy.monthlyCapUsd }).where(eq(aiBudgetPolicies.tenantId, policy.tenantId))); }
  }, 120_000);

  it("restores only original parent and item receipts after lost queue or owner preparation without new paid or duplicate business writes", async () => {
    const context = await current(); f.controls.failQueue = true; const input = await f.request(f.base.a, { bindings: one() }), dispatches = f.dispatches.length;
    const created = await Promise.all([f.service().start(context, input), f.service().start(context, input)]); expect(new Set(created.map(row => row.id)).size).toBe(1); expect(f.dispatches.length - dispatches).toBe(1);
    const before = await f.rows(context), count = f.modelCalls.length; await f.service().get(context, created[0]!.id); await f.service().receipt(context, f.proof(input));
    expect(await f.rows(context)).toEqual(before); expect(f.modelCalls.length).toBe(count); await expect(f.service().start(context, { ...input, goal: "Changed body" })).rejects.toBeInstanceOf(ConflictException);
    f.clear(); await f.prior.dispatcher.enqueue({ id: created[0]!.id, tenantId: context.tenantId, userId: context.userId, expiresAt: new Date(created[0]!.expiresAt) }); await f.process(created[0]!.id);
    const completed = await simple([source.originals[0]!]), item = completed.view.items[0]!, body = f.prepareInput(completed.view, item);
    const interrupted = vi.spyOn(f.prior.legacy.owners.adapter, "prepare").mockRejectedValueOnce(new Error("Synthetic original preparation interrupted before native result"));
    try { await expect(f.service().prepareItem(context, completed.view.id, item.id, body)).rejects.toThrow("Synthetic original preparation interrupted"); } finally { interrupted.mockRestore(); }
    expect(await f.service().itemReceipt(context, completed.view.id, item.id, body)).toMatchObject({ disposition: "unknown", agentCommandId: null, ownerCommandId: null });
    const unknown = await f.rows(context); await f.service().itemReceipt(context, completed.view.id, item.id, body); expect(await f.rows(context)).toEqual(unknown);
    const known = await f.service().prepareItem(context, completed.view.id, item.id, body); expect(known.disposition).toBe("known");
    const prepared = await f.rows(context); await f.service().prepareItem(context, completed.view.id, item.id, body); await f.service().itemReceipt(context, completed.view.id, item.id, body); expect(await f.rows(context)).toEqual(prepared);
    await expect(f.service().itemReceipt(context, completed.view.id, item.id, { ...body, proposalChecksum: "f".repeat(64) })).rejects.toBeInstanceOf(ConflictException);
  });

  it("requires native177 same-transaction paid evidence and real immutable35second cleanup while retaining hashes fees and minimal receipts", async () => {
    const context = await current(), input = await f.request(f.base.a, { bindings: one() }), initial = await f.rows(context), dispatches = f.dispatches.length;
    const audit = vi.spyOn(persistence, "recordAuditInTransaction").mockRejectedValueOnce(new Error("synthetic_v3_audit_rollback"));
    try { await expect(f.service().start(context, input)).rejects.toThrow("synthetic_v3_audit_rollback"); } finally { audit.mockRestore(); }
    expect(await f.rows(context)).toEqual(initial); expect(f.dispatches.length).toBe(dispatches);
    const run = await f.service().start(context, input), parent = (await f.rows(context)).runs.find(row => row.id === run.id)!;
    expect(await rejected(tx => tx.update(agentPlanRuns).set({ version: "erp-agent-native-v2" }).where(eq(agentPlanRuns.id, run.id)))).toBe("23514");
    expect(await rejected(async tx => { await tx.execute(sql`set constraints all immediate`); await tx.update(agentPlanRuns).set({ originCeiling: f.base.foreign.context }).where(eq(agentPlanRuns.id, run.id)); })).toBe("23514");
    const stable = await f.rows(context); expect(await rejected(async tx => { await tx.update(agentPlanRuns).set({ status: "completed", completedAt: new Date() }).where(eq(agentPlanRuns.id, run.id));
      await tx.update(aiBudgetLedger).set({ state: "released" }).where(eq(aiBudgetLedger.id, parent.budgetLedgerId)); })).toBe("23514");
    expect(await rejected(tx => persistence.recordAuditInTransaction(tx, context, { action: "agent.plan.create", resourceType: "agent_plan_run", resourceId: createEntityId(), result: "success",
      metadata: { requestChecksum: parent.requestChecksum, inputChecksum: parent.inputChecksum, budgetLedgerId: parent.budgetLedgerId } }))).toBe("23514");
    expect(await rejected(tx => tx.insert(agentPlanItems).values({ id: createEntityId(), tenantId: context.tenantId, runId: run.id, modelStepId: createEntityId(), position: 0, proposalChecksum: "a".repeat(64) }))).toBe("23514");
    expect(await f.rows(context)).toEqual(stable); await f.service().stop(context, run.id, { version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId }); await f.process(run.id);
    const retained = await simple([], {}, 35), original = await f.rows(context), born = original.runs.find(row => row.id === retained.view.id)!;
    expect(born.expiresAt.getTime() - born.createdAt.getTime()).toBeGreaterThanOrEqual(35_000); expect(born.expiresAt.getTime() - born.createdAt.getTime()).toBeLessThan(36_000);
    const trace = original.steps.filter(row => row.runId === born.id).sort((a, b) => a.sequence - b.sequence), calls = f.modelCalls.length, business = await f.business(context);
    const deadline = Date.now() + 45_000;
    for (;;) { const [clock] = await withTenant(database.db, context, tx => tx.execute<{ expired: boolean }>(sql`select clock_timestamp()>${born.expiresAt.toISOString()}::timestamptz as expired`));
      if (clock?.expired) break; if (Date.now() > deadline) throw new Error("Actual immutable V3 retention did not elapse"); await delay(500); }
    await f.runtime().process(context, born.id, "expire"); const cleaned = await f.rows(context), actual = cleaned.runs.find(row => row.id === born.id)!;
    expect(actual).toMatchObject({ encryptedInput: null, encryptedResult: null, resultChecksum: null });
    const strip = (row: (typeof trace)[number]) => Object.fromEntries(Object.entries(row).filter(([key]) => !["encryptedInput", "encryptedOutput", "encryptedResponse"].includes(key)));
    const afterTrace = cleaned.steps.filter(row => row.runId === born.id).sort((a, b) => a.sequence - b.sequence);
    expect(afterTrace.every(row => row.encryptedInput === null && row.encryptedOutput === null && row.encryptedResponse === null)).toBe(true); expect(afterTrace.map(strip)).toEqual(trace.map(strip));
    expect(cleaned.ledgers).toEqual(original.ledgers); expect(cleaned.audits).toEqual(original.audits); expect(f.modelCalls.length).toBe(calls); expect(await f.business(context)).toEqual(business);
    expect(await read(born.id)).toMatchObject({ privateAvailable: false, readContracts: null, steps: [], definitions: [], observations: [], result: null });
    expect(await f.service().receipt(context, f.proof(retained.input))).toMatchObject({ disposition: "known", runId: born.id, privateAvailable: false });
  }, 70_000);
});
