import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission, erpPermissionContext } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_NATIVE_VERSION, AgentNativeDecisionSchema, AgentNativePinnedInputSchema } from "@yummyai/contracts/ai/agent-native";
import { CreateProductSpuSchema } from "@yummyai/contracts/catalog/development";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentToolCallSchema } from "@yummyai/contracts/ai/agent-tools";
import * as persistence from "@yummyai/database";
import { agentPlanRuns, agentPlanItems, aiBudgetLedger, aiBudgetPolicies, connectDatabase, withTenant, type TenantTransaction } from "@yummyai/database";
import { agentNativeSlots, agentNativeChecksum } from "../../../../packages/workflow-core/src/agent-native-model.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bounded, deferred } from "./agent-read.test-fixture.js";
import { agentNativeFixture, finishNative, nativeSequence, requireAgentNativeEnvironment } from "./agent-native.test-fixture.js";

const environment = requireAgentNativeEnvironment(), database = connectDatabase(environment.url), f = agentNativeFixture(database);
const allScopes = (): Record<string, TenantContext["dataScope"]> => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
const proof = (input: { requestId: string }) => ({ requestId: input.requestId, requestChecksum: f.checksum(input) });
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
function postgres(error: unknown) {
  let value = error;
  for (let depth = 0; depth < 8 && value && typeof value === "object"; depth++) {
    if ("code" in value && typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code)) return value.code;
    value = "cause" in value ? value.cause : null;
  }
  throw new Error("Expected actual PostgreSQL constraint failure", { cause: error });
}
async function failure(body: (tx: TenantTransaction) => Promise<unknown>) {
  try { await withTenant(database.db, f.base.a.context, body); } catch (error) { return postgres(error); }
  throw new Error("Native Agent raw counterexample unexpectedly committed");
}
let source: Awaited<ReturnType<typeof f.source>>;
const oneBinding = () => [{ tool: "inventory.balances.page" as const, scope: { stockItemId: source.stockItemId } }];
async function simple(originals: typeof source.originals = [], retentionSeconds?: number) {
  f.controls.decision = packet => nativeSequence(packet, originals, source.query);
  const input = await f.request(f.base.a, { bindings: oneBinding(), allowedCommands: originals.map(original => AgentPlanCommandKeySchema.parse({ domain: original.domain, kind: original.command.kind })),
    ...(retentionSeconds === undefined ? {} : { limits: { ...(await f.request()).limits, deadlineSeconds: 30 } }) });
  const created = await f.service(retentionSeconds).start(f.base.a.context, input); await f.process(created.id);
  return { input, view: await f.service().get(f.base.a.context, created.id) };
}

describe.sequential("independent native Agent decisions through five authentic owners and separate original confirmation", () => {
  beforeAll(async () => { await f.initialize(); source = await f.source(); }, 120_000);
  afterEach(async () => {
    f.clear(); vi.restoreAllMocks(); await f.base.scopes(f.base.a, allScopes());
    const context = await f.base.current(f.base.a), rows = await f.rows(context);
    for (const run of rows.runs.filter(run => run.version === AGENT_NATIVE_VERSION && ["queued", "running", "stopping"].includes(run.status))) {
      await f.service().stop(context, run.id, { version: AGENT_NATIVE_VERSION, requestId: run.requestId }); await f.runtime().process(context, run.id);
    }
    await f.settlePrepared();
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try { f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native Agent fixture teardown failed");
  });

  it("loads five genuine native definitions reads their real sources then seals unapproved drafts before separately confirmed procurement and finance facts", async () => {
    const before = await f.business(), models = f.modelCalls.length, definitions = f.definitionCalls.length, reads = f.readCalls.length;
    f.controls.decision = packet => nativeSequence(packet, source.originals, source.query);
    const input = await f.request(f.base.a, { bindings: source.bindings, contextText: source.contextText,
      allowedCommands: [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }] });
    const created = await f.service().start(f.base.a.context, input); await f.process(created.id); const view = await f.service().get(f.base.a.context, created.id);
    expect(view).toMatchObject({ version: AGENT_NATIVE_VERSION, status: "completed", verification: "native_scalar_values_and_current_source_basis_only", businessExecution: "separate_original_confirmation",
      cost: { knownCostUsd: "0.002730", reservedUsd: "0.000000", modelTurns: 13, coverage: "known" } });
    expect(view.observations.map(value => value.tool)).toEqual(source.bindings.map(value => value.tool));
    expect(view.observations.map(value => value.collectionComplete)).toEqual([true, true, null, null, null]);
    const kb = view.observations.find(value => value.tool === "knowledge.search")!.results[0]!;
    if (kb.tool !== "knowledge.search") throw new Error("Missing actual knowledge result");
    expect(kb.coverage).toMatchObject({ kind: "ranked_subset", complete: false, returned: 6 });
    for (const reference of kb.data.references) {
      expect(source.published).toContain(reference.entryId); expect(reference.entryId).not.toBe(source.draftId);
      const [native] = await withTenant(database.db, f.base.a.context, tx => tx.execute<{ checksum: string }>(sql`select checksum from knowledge_versions where id=${reference.versionId}::uuid`));
      expect(reference.checksum).toBe(native?.checksum);
    }
    expect(view.items).toHaveLength(2); expect(view.items.every(item => item.preparationState === "not_requested" && item.agentCommandId === null)).toBe(true);
    expect(view.result?.proposals.map(value => value.id)).toEqual(agentNativeSlots(view.id, view.limits.maxProposals).slice(0, 2).map(value => value.id));
    expect(f.modelCalls.length - models).toBe(13); expect(f.definitionCalls.length - definitions).toBe(14); expect(f.readCalls.length - reads).toBe(10);
    expect(f.wire.slice(-13).every(value => value.schemaBytes < 40_000 && value.bodyBytes > value.schemaBytes)).toBe(true);
    const finalModel = (await f.rows()).steps.filter(step => step.runId === view.id && step.kind === "model").sort((a, b) => a.sequence - b.sequence).at(-1)!;
    const rawResponse = f.base.vault.withSecret(finalModel.encryptedResponse!, text => JSON.parse(text)); expect(agentNativeChecksum(rawResponse)).toBe(finalModel.responseChecksum);
    const decision = f.base.vault.withSecret(finalModel.encryptedOutput!, text => AgentNativeDecisionSchema.parse(JSON.parse(text))); expect(agentNativeChecksum(decision)).toBe(finalModel.outputChecksum);
    expect(finalModel.outputChecksum).not.toBe(finalModel.responseChecksum); expect(agentNativeChecksum(view.result)).not.toBe(finalModel.outputChecksum);
    expect(await f.business()).toEqual(before);
    for (const [position, item] of view.items.entries()) {
      const stable = await f.business(), prepared = await f.service().prepareItem(f.base.a.context, view.id, item.id, f.prepareInput(view, item));
      expect(prepared).toMatchObject({ disposition: "known", runId: view.id, itemId: item.id, preparationRequestChecksum: item.preparationRequestChecksum });
      expect(Boolean(prepared.ownerCommandId)).toBe(true); expect(await f.business()).toEqual(stable);
      const native = await f.owners.service().get(f.base.a.context, prepared.agentCommandId!);
      expect(native).toMatchObject({ state: "prepared", canConfirm: true, requestId: item.id, originalChecksum: item.originalChecksum });
      const actual = await f.owners.service().confirm(f.base.a.context, native.id, f.confirmation(native)); expect(actual.state).toBe("succeeded");
      const after = await f.business();
      if (position === 0) expect(after.inventory_procurement_requisitions!.count).toBe(stable.inventory_procurement_requisitions!.count + 1);
      else { expect(after.finance_payable_bills!.count).toBe(stable.finance_payable_bills!.count + 1); expect(after.finance_original_write_proofs!.count).toBe(stable.finance_original_write_proofs!.count + 1); }
      await f.owners.service().confirm(f.base.a.context, native.id, f.confirmation(native)); expect(await f.business()).toEqual(after);
    }
    expect(f.modelCalls.length - models).toBe(13);
  });

  it("rejects false quantity unit checksum path missing definition wrong native key and execution decisions while retaining every incurred paid turn", async () => {
    const before = await f.business();
    for (const variant of ["quantity", "unit", "checksum", "path", "definition", "key", "execute"] as const) {
      f.controls.decision = packet => {
        const next = nativeSequence(packet, [source.requisition], source.query); if (next.action !== "finish" || !next.result) return next;
        const actual = next.result.claims.find(value => value.path.at(-1) === (variant === "unit" ? "unit" : "physicalQuantity"))!;
        if (variant === "quantity") actual.value = "999"; if (variant === "unit") actual.value = "USD";
        if (variant === "checksum") actual.dataChecksum = "f".repeat(64); if (variant === "path") actual.path = ["contextAuthority"];
        if (variant === "key") {
          const draft = JSON.parse(next.result.proposals[0]!.draftJson!) as { command: { input: { idempotencyKey: string } } };
          draft.command.input.idempotencyKey = createEntityId(); next.result.proposals[0]!.draftJson = JSON.stringify(draft);
        }
        return variant === "execute" ? { ...next, action: "execute" } : next;
      };
      if (variant === "definition") f.controls.decision = packet => packet.observations.length ? finishNative(packet, [source.requisition]) : nativeSequence(packet);
      const request = await f.request(f.base.a, { bindings: oneBinding(), allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] });
      const created = await f.service().start(f.base.a.context, request); await f.process(created.id); const actual = await f.service().get(f.base.a.context, created.id);
      expect(actual.status).toBe("failed"); expect(actual.items).toEqual([]); expect(actual.result).toBeNull();
      expect(Number(actual.cost.knownCostUsd)).toBeGreaterThan(0); expect(actual.cost.reservedUsd).toBe("0.000000");
    }
    expect(await f.business()).toEqual(before);
  });

  it("collects all501 actual owner records with authenticated pages and counts final source checks while bounded prefixes cannot claim collection totals", async () => {
    const large = await f.base.stock(f.base.a, 501), binding = [{ tool: "inventory.balances.page" as const, scope: { stockItemId: large.stockItemId } }];
    const before = await f.business(), reads = f.readCalls.length; f.controls.decision = packet => nativeSequence(packet);
    const input = await f.request(f.base.a, { bindings: binding, limits: { ...(await f.request()).limits, maxRows: 1000 } });
    const created = await f.service().start(f.base.a.context, input); await f.process(created.id); const full = await f.service().get(f.base.a.context, created.id);
    expect(full).toMatchObject({ status: "completed", observedRows: 501, cost: { modelTurns: 3, knownCostUsd: "0.000630" } });
    const collection = full.observations[0]!; expect(collection).toMatchObject({ observedRows: 501, collectionComplete: true, truncatedBy: null });
    const allIds = collection.results.flatMap(result => result.tool === "inventory.balances.page" ? result.data.items.map(row => row.id) : []);
    expect(allIds).toHaveLength(501); expect(new Set(allIds).size).toBe(501); expect(f.readCalls.length - reads).toBe(7); expect(full.toolCalls).toBe(9);
    const capped = await f.request(f.base.a, { bindings: binding, limits: { ...input.limits, maxRows: 30 } });
    const second = await f.service().start(f.base.a.context, capped); await f.process(second.id); const prefix = await f.service().get(f.base.a.context, second.id);
    expect(prefix.status).toBe("partial"); expect(prefix.items).toEqual([]); expect(prefix.observations[0]).toMatchObject({ observedRows: 30, collectionComplete: false, truncatedBy: "row_limit" });
    expect(prefix.result?.claims.some(claim => claim.path[0] === "total") ?? false).toBe(false); expect(await f.business()).toEqual(before);
  });

  it("rechecks real withdrawn published knowledge before accepting finish and before explicit preparation without altering sealed old facts", async () => {
    const query = "Synthetic source withdrawal " + createEntityId().replace(/[0-9-]/g, "a"), card = await f.card(f.base.a.context, query, true);
    const bindings = [{ tool: "knowledge.search" as const, scope: { topic: "operations" as const, platform: "all" as const, market: "ALL", spuIds: [] } }];
    f.controls.decision = packet => nativeSequence(packet, [source.requisition], query);
    let removed = false; f.controls.afterRead = async result => { if (result.tool === "knowledge.search" && !removed) { removed = true;
      await f.base.knowledge.change(f.base.a.context, card, "disable", { expectedRevision: 3, version: 1, reason: "Actual source withdrawn after original read", requestId: randomUUID() }); } };
    const input = await f.request(f.base.a, { bindings, allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] }), created = await f.service().start(f.base.a.context, input);
    await f.process(created.id); const stale = await f.service().get(f.base.a.context, created.id);
    expect(stale.status).toBe("failed"); expect(stale.items).toEqual([]); f.clear();
    const secondQuery = query + " next", secondCard = await f.card(f.base.a.context, secondQuery, true);
    f.controls.decision = packet => nativeSequence(packet, [source.requisition], secondQuery);
    const next = await f.request(f.base.a, { bindings, allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] }), born = await f.service().start(f.base.a.context, next);
    await f.process(born.id); const completed = await f.service().get(f.base.a.context, born.id); expect(completed.status).toBe("completed");
    const before = await f.business(), rows = await f.rows(), original = rows.runs.find(run => run.id === born.id)!;
    await f.base.knowledge.change(f.base.a.context, secondCard, "disable", { expectedRevision: 3, version: 1, reason: "Actual source withdrawn before operator prepares", requestId: randomUUID() });
    await expect(f.service().prepareItem(f.base.a.context, born.id, completed.items[0]!.id, f.prepareInput(completed, completed.items[0]!))).rejects.toBeInstanceOf(ConflictException);
    const after = (await f.rows()).runs.find(run => run.id === born.id)!;
    expect(after.encryptedResult).toBe(original.encryptedResult); expect(after.resultChecksum).toBe(original.resultChecksum); expect(after.knownCostUsd).toBe(original.knownCostUsd);
    expect(await f.business()).toEqual(before);
  });

  it("honors actual Workflow self current scopes original ceilings peer and tenant isolation and discards a late native result after relevant domain loss", async () => {
    const actor = await f.base.actor(f.base.a.tenantId), own = await f.base.stock(actor, 1), grants = { [Permission.WorkflowRead]: "self" as const, [Permission.WorkflowRun]: "self" as const, [Permission.InventoryRead]: "tenant" as const };
    const context = await f.base.scopes(actor, grants), input = await f.request(actor, { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: own.stockItemId } }] });
    f.controls.decision = packet => nativeSequence(packet); const created = await f.service().start(context, input), pin = (await f.rows(context)).runs.find(run => run.id === created.id)!;
    const expanded = await f.base.scopes(actor, { ...grants, [Permission.FinanceRead]: "tenant" }); await f.runtime().process(expanded, created.id);
    expect(await f.service().get(expanded, created.id)).toMatchObject({ status: "completed", contextAuthority: stamp(expanded), privateAvailable: true });
    expect((await f.rows(expanded)).runs.find(run => run.id === created.id)!.originCeiling).toEqual(pin.originCeiling);
    expect(f.readCalls.filter(row => row.input.tool === "inventory.balances.page" && row.input.input.stockItemId === own.stockItemId).every(row => !row.context.permissions.includes(Permission.FinanceRead))).toBe(true);
    await expect(f.service().get(f.base.second.context, created.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service().get(f.base.foreign.context, created.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.service().receipt(f.base.second.context, proof(input))).toMatchObject({ disposition: "not_found", runId: null });
    const entered = deferred(), release = deferred(); let held = false;
    f.controls.afterRead = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
    const fresh = await f.request(actor, { bindings: input.bindings }), late = await f.service().start(expanded, fresh), pending = f.runtime().process(expanded, late.id);
    try {
      await bounded(entered.promise, "Actual native owner did not finish its late response gate");
      const narrowed = await f.base.scopes(actor, { ...grants, [Permission.InventoryRead]: "self", [Permission.FinanceRead]: "tenant" }); release.resolve();
      await bounded(pending, "Late native runtime did not settle");
      const hidden = await f.service().get(narrowed, late.id); expect(hidden).toMatchObject({ privateAvailable: false, steps: [], observations: [], definitions: [], result: null });
      expect(await f.service().receipt(narrowed, proof(fresh))).toMatchObject({ runId: late.id, privateAvailable: false, contextAuthority: stamp(narrowed) });
      await f.service().stop(narrowed, late.id, { version: AGENT_NATIVE_VERSION, requestId: fresh.requestId });
      await expect(f.service().stop(f.base.second.context, late.id, { version: AGENT_NATIVE_VERSION, requestId: fresh.requestId })).rejects.toBeInstanceOf(NotFoundException);
    } finally { release.resolve(); await pending; }
    const peer = await f.inspection(f.base.second.context), all = await f.base.current(f.base.a);
    const cross = await f.request(f.base.a, { bindings: [{ tool: "creative.history", scope: { scope: "inspection", ownerId: peer.id } }] });
    f.clear(); f.controls.decision = packet => nativeSequence(packet);
    const born = await f.service().start(all, cross); await f.process(born.id); expect((await f.service().get(all, born.id)).privateAvailable).toBe(true);
    const narrowed = await f.base.scopes(f.base.a, { ...allScopes(), [Permission.DesignRead]: "self", [Permission.AssetRead]: "self" });
    const stable = await f.rows(), calls = f.modelCalls.length;
    expect(await f.service().get(narrowed, born.id)).toMatchObject({ privateAvailable: false, steps: [], definitions: [], observations: [], result: null });
    expect(await f.service().receipt(narrowed, proof(cross))).toMatchObject({ runId: born.id, privateAvailable: false });
    expect(await f.rows()).toEqual(stable); expect(f.modelCalls.length).toBe(calls);
    await f.base.scopes(f.base.a, allScopes());
    const spu = await f.facts.development.createSpu(f.base.second.context, CreateProductSpuSchema.parse({ code: "SPU-" + createEntityId().slice(-12).toUpperCase(), name: "Synthetic peer source SPU", idempotencyKey: randomUUID() }));
    const keyword = "Synthetic peer knowledge " + createEntityId().replace(/[0-9-]/g, "a"); await f.card(f.base.second.context, keyword, true, spu.spu.id);
    f.controls.decision = packet => nativeSequence(packet, [], keyword);
    const selected = await f.request(f.base.a, { bindings: [{ tool: "knowledge.search", scope: { topic: "operations", platform: "all", market: "ALL", spuIds: [spu.spu.id] } }] });
    const selectedRun = await f.service().start(all, selected); await f.process(selectedRun.id); expect((await f.service().get(all, selectedRun.id)).privateAvailable).toBe(true);
    const productSelf = await f.base.scopes(f.base.a, { ...allScopes(), [Permission.ProductRead]: "self" });
    expect(await f.service().get(productSelf, selectedRun.id)).toMatchObject({ privateAvailable: false, steps: [], observations: [], result: null });
    expect(await f.service().receipt(productSelf, proof(selected))).toMatchObject({ runId: selectedRun.id, privateAvailable: false });
  });

  it("recovers only original parent and child receipts after queue loss or a born coordinator without an original preparation and never reenters paid work on GET", async () => {
    f.controls.failQueue = true; const input = await f.request(f.base.a, { bindings: oneBinding() }), before = await f.rows(), dispatches = f.dispatcherCalls.length;
    const created = await Promise.all([f.service().start(f.base.a.context, input), f.service().start(f.base.a.context, input)]);
    expect(new Set(created.map(run => run.id)).size).toBe(1); expect(f.dispatcherCalls.length - dispatches).toBe(1);
    expect((await f.rows()).runs.length).toBe(before.runs.length + 1);
    const stable = await f.rows(), calls = f.modelCalls.length;
    for (let repeat = 0; repeat < 2; repeat++) { await f.service().get(f.base.a.context, created[0]!.id); await f.service().receipt(f.base.a.context, proof(input)); }
    expect(await f.rows()).toEqual(stable); expect(f.modelCalls.length).toBe(calls);
    await expect(f.service().start(f.base.a.context, { ...input, contextText: "Altered same original request" })).rejects.toBeInstanceOf(ConflictException);
    f.clear(); f.controls.decision = packet => nativeSequence(packet, [source.requisition]); await f.process(created[0]!.id);
    // This run has no allowed command, so it must not acquire a proposal from
    // a later model response that was outside its original request ceiling.
    expect(await f.service().get(f.base.a.context, created[0]!.id)).toMatchObject({ status: "failed", items: [] });
    f.clear(); const completed = (await simple([source.requisition])).view, item = completed.items[0]!;
    const spy = vi.spyOn(f.owners.adapter, "prepare").mockRejectedValueOnce(new Error("Synthetic native preparation interrupted before original owner result"));
    await expect(f.service().prepareItem(f.base.a.context, completed.id, item.id, f.prepareInput(completed, item))).rejects.toThrow("Synthetic native preparation interrupted"); spy.mockRestore();
    const unknown = await f.service().itemReceipt(f.base.a.context, completed.id, item.id, f.prepareInput(completed, item));
    expect(unknown).toMatchObject({ disposition: "unknown", agentCommandId: null, ownerCommandId: null });
    const pending = await f.rows(); await f.service().get(f.base.a.context, completed.id); await f.service().itemReceipt(f.base.a.context, completed.id, item.id, f.prepareInput(completed, item));
    expect(await f.rows()).toEqual(pending);
    const known = await f.service().prepareItem(f.base.a.context, completed.id, item.id, f.prepareInput(completed, item)); expect(known.disposition).toBe("known");
    expect(Boolean(known.agentCommandId && known.ownerCommandId)).toBe(true);
    const ready = await f.rows(); await f.service().prepareItem(f.base.a.context, completed.id, item.id, f.prepareInput(completed, item)); expect(await f.rows()).toEqual(ready);

    f.clear();
    const advancingInput = await f.request(f.base.a, { bindings: oneBinding() }), queued = await f.service().start(f.base.a.context, advancingInput);
    expect(queued).toMatchObject({ status: "queued", privateAvailable: true, steps: [], observations: [], result: null,
      cost: { knownCostUsd: "0.000000", reservedUsd: "1.000000", modelTurns: 0 } });
    const businessBefore = await f.business(), modelCalls = f.modelCalls.length, queuedDispatches = f.dispatcherCalls.length;
    const reachedOwner = deferred(), releaseGet = deferred(), actualRead = f.gateway.call.bind(f.gateway);
    let gated = false;
    const readGate = vi.spyOn(f.gateway, "call").mockImplementation(async (context, raw) => {
      const result = await actualRead(context, raw), call = AgentToolCallSchema.parse(raw);
      // GET has already captured its authentic parent/step/budget snapshot and
      // completed the original owning reader. The Worker still uses real I/O.
      if (!gated && call.tool === "inventory.balances.page" && call.input.pageSize === 1) {
        gated = true; reachedOwner.resolve(); await releaseGet.promise;
      }
      return result;
    });
    const reading = f.service().get(f.base.a.context, queued.id);
    try {
      await bounded(reachedOwner.promise, "Original GET owning-reader authorization did not reach its pageSize1 gate");
      await bounded(f.process(queued.id), "Actual native Worker did not complete while GET awaited its authorization result");
      const advanced = await f.rows(), row = advanced.runs.find(run => run.id === queued.id)!;
      expect(row.status).toBe("completed"); expect(row.revision).toBeGreaterThan(queued.revision);
      expect(row.resultChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(f.modelCalls.length - modelCalls).toBe(3); expect(await f.business()).toEqual(businessBefore);
      releaseGet.resolve();
      const originalSnapshot = await bounded(reading, "Concurrent GET rejected or did not return its consistent original snapshot");
      expect(originalSnapshot).toEqual(queued);
      expect(f.modelCalls.length - modelCalls).toBe(3); expect(f.dispatcherCalls.length).toBe(queuedDispatches);
      expect(await f.rows()).toEqual(advanced); expect(await f.business()).toEqual(businessBefore);
    } finally { releaseGet.resolve(); await reading.catch(() => undefined); readGate.mockRestore(); }
  });

  it("keeps unknown model submission or unknown fee on its original cap and resumes an authenticated response-ready checkpoint once after lease handoff", async () => {
    for (const variant of ["submission", "usage"] as const) {
      f.controls.unknownUsage = variant === "usage"; f.controls.beforeModel = variant === "submission" ? async () => { throw new TypeError("Synthetic submitted native model response lost"); } : undefined;
      const calls = f.modelCalls.length, input = await f.request(f.base.a, { bindings: oneBinding() }), created = await f.service().start(f.base.a.context, input);
      await f.process(created.id); const actual = await f.service().get(f.base.a.context, created.id);
      expect(actual).toMatchObject({ status: "uncertain", errorCode: variant === "submission" ? "agent_submission_unknown" : "agent_cost_unknown", items: [],
        cost: { knownCostUsd: "0.000000", reservedUsd: "1.000000", coverage: "unknown" } });
      const stable = await f.rows(); await f.process(created.id); await f.service().receipt(f.base.a.context, proof(input));
      expect(f.modelCalls.length - calls).toBe(1); expect(await f.rows()).toEqual(stable); f.clear();
    }
    const saved = deferred(), release = deferred(), calls = f.modelCalls.length; f.controls.decision = packet => finishNative(packet);
    f.controls.afterCheckpoint = async () => { saved.resolve(); await release.promise; };
    const input = await f.request(f.base.a, { bindings: oneBinding() }), created = await f.service().start(f.base.a.context, input), pending = f.process(created.id);
    try {
      await bounded(saved.promise, "Actual native provider checkpoint was not saved");
      const checkpoint = (await f.rows()).steps.find(step => step.runId === created.id)!;
      expect(checkpoint).toMatchObject({ phase: "response_ready", submissionState: "received", costUsd: "0.000210" });
      await withTenant(database.db, f.base.a.context, tx => tx.update(agentPlanRuns).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(agentPlanRuns.id, created.id)));
      f.controls.afterCheckpoint = undefined; await f.runtime().process(f.base.a.context, created.id); release.resolve(); await bounded(pending, "Original checkpoint worker did not settle");
      const result = await f.service().get(f.base.a.context, created.id); expect(result).toMatchObject({ status: "completed", cost: { knownCostUsd: "0.000210", modelTurns: 1 } });
      expect(f.modelCalls.length - calls).toBe(1);
      const final = (await f.rows()).steps.find(step => step.id === checkpoint.id)!; expect(final.responseChecksum).toBe(checkpoint.responseChecksum); expect(final.outputChecksum).not.toBe(final.responseChecksum);
    } finally { release.resolve(); await pending; }
  });

  it("requires175 authentic versioned native birth immutable pins completion and reverse audit closure even after early constraint flush", async () => {
    const input = await f.request(f.base.a, { bindings: oneBinding() }), before = await f.rows(), dispatches = f.dispatcherCalls.length;
    const broken = vi.spyOn(persistence, "recordAuditInTransaction").mockRejectedValueOnce(new Error("synthetic_native_audit_failure"));
    await expect(f.service().start(f.base.a.context, input)).rejects.toThrow("synthetic_native_audit_failure"); broken.mockRestore();
    expect(await f.rows()).toEqual(before); expect(f.dispatcherCalls.length).toBe(dispatches);
    const created = await f.service().start(f.base.a.context, input), original = (await f.rows()).runs.find(run => run.id === created.id)!;
    expect(original.version).toBe(AGENT_NATIVE_VERSION);
    const pinned = f.base.vault.withSecret(original.encryptedInput!, text => AgentNativePinnedInputSchema.parse(JSON.parse(text)));
    expect(agentNativeChecksum(pinned)).toBe(original.inputChecksum); expect(pinned.request.bindings).toEqual(input.bindings);
    expect(await failure(tx => tx.update(agentPlanRuns).set({ originCeiling: f.base.second.context }).where(eq(agentPlanRuns.id, created.id)))).toBe("23514");
    expect(await failure(async tx => { await tx.execute(sql`set constraints all immediate`); await tx.update(agentPlanRuns).set({ version: "erp-agent-plan-v1" }).where(eq(agentPlanRuns.id, created.id)); })).toBe("23514");
    const stable = await f.rows();
    expect(await failure(async tx => { await tx.update(agentPlanRuns).set({ status: "completed", completedAt: new Date() }).where(eq(agentPlanRuns.id, created.id));
      await tx.update(aiBudgetLedger).set({ state: "released" }).where(eq(aiBudgetLedger.id, original.budgetLedgerId)); await tx.execute(sql`set constraints all immediate`); })).toBe("23514");
    expect(await failure(tx => persistence.recordAuditInTransaction(tx, f.base.a.context, { action: "agent.plan.create", resourceType: "agent_plan_run", resourceId: createEntityId(), result: "success",
      metadata: { requestChecksum: original.requestChecksum, inputChecksum: original.inputChecksum, budgetLedgerId: original.budgetLedgerId } }))).toBe("23514");
    expect(await failure(tx => tx.insert(agentPlanItems).values({ id: createEntityId(), tenantId: f.base.a.tenantId, runId: created.id, modelStepId: createEntityId(), position: 0, proposalChecksum: "a".repeat(64) }))).toBe("23514");
    expect(await f.rows()).toEqual(stable);
  });

  it("shares the real original global active and monthly budget admission instead of opening another native paid slot or replacing a failed reservation", async () => {
    const context = f.base.a.context, before = await f.business(), original = await f.prior.request(f.base.a, { allowedReads: [] });
    const old = await f.prior.service().start(context, original), natives = [];
    try {
      for (let index = 0; index < 3; index++) { const input = await f.request(f.base.a, { bindings: oneBinding() }); natives.push(await f.service().start(context, input)); }
      const stable = await f.rows(), dispatches = f.dispatcherCalls.length;
      await expect(f.service().start(context, await f.request(f.base.a, { bindings: oneBinding() }))).rejects.toBeInstanceOf(ConflictException);
      await expect(f.prior.service().start(context, await f.prior.request())).rejects.toBeInstanceOf(ConflictException);
      expect(await f.rows()).toEqual(stable); expect(f.dispatcherCalls.length).toBe(dispatches); expect(await f.business()).toEqual(before);
    } finally {
      await f.prior.service().stop(context, old.id, { version: "erp-agent-plan-v1", requestId: original.requestId }); await f.prior.runtime().process(context, old.id);
      for (const run of natives) { await f.service().stop(context, run.id, { version: AGENT_NATIVE_VERSION, requestId: run.requestId }); await f.process(run.id); }
    }
    const [policy] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetPolicies)); if (!policy) throw new Error("Actual initialized budget policy missing");
    try {
      await withTenant(database.db, context, tx => tx.update(aiBudgetPolicies).set({ monthlyCapUsd: "0.5" }).where(eq(aiBudgetPolicies.tenantId, policy.tenantId)));
      const stable = await f.rows(), calls = f.modelCalls.length;
      try { await f.service().start(context, await f.request(f.base.a, { bindings: oneBinding() })); throw new Error("Actual monthly budget admission unexpectedly succeeded"); }
      catch (error) { expect(error).toBeInstanceOf(ConflictException); expect((error as ConflictException).getResponse()).toMatchObject({ code: "agent_monthly_budget_limit" }); }
      expect(await f.rows()).toEqual(stable); expect(f.modelCalls.length).toBe(calls);
    } finally { await withTenant(database.db, context, tx => tx.update(aiBudgetPolicies).set({ monthlyCapUsd: policy.monthlyCapUsd }).where(eq(aiBudgetPolicies.tenantId, policy.tenantId))); }
  });

  it("expires real35second native private bodies without mutating original trace hashes budgets business facts or metadata-only recovery", async () => {
    const { input, view } = await simple([], 35); expect(view.status).toBe("completed");
    const born = (await f.rows()).runs.find(run => run.id === view.id)!;
    expect(born.expiresAt.getTime() - born.createdAt.getTime()).toBeGreaterThanOrEqual(35_000);
    expect(born.expiresAt.getTime() - born.createdAt.getTime()).toBeLessThan(36_000);
    const defaults = await f.service().start(f.base.a.context, await f.request(f.base.a, { bindings: oneBinding() }));
    const normal = (await f.rows()).runs.find(run => run.id === defaults.id)!; expect(normal.expiresAt.getTime() - normal.createdAt.getTime()).toBeGreaterThanOrEqual(86_400_000);
    await f.service().stop(f.base.a.context, normal.id, { version: AGENT_NATIVE_VERSION, requestId: normal.requestId }); await f.process(normal.id);
    const original = await f.rows(), trace = original.steps.filter(step => step.runId === view.id).sort((a, b) => a.sequence - b.sequence), calls = f.modelCalls.length, business = await f.business();
    const limit = Date.now() + 45_000;
    while (true) {
      const [clock] = await withTenant(database.db, f.base.a.context, tx => tx.execute<{ elapsed: boolean }>(sql`select clock_timestamp()>${born.expiresAt.toISOString()}::timestamptz as elapsed`));
      if (clock?.elapsed) break; if (Date.now() >= limit) throw new Error("Actual immutable native retention deadline did not pass"); await delay(500);
    }
    await f.runtime().process(f.base.a.context, view.id, "expire"); const cleaned = await f.rows(), parent = cleaned.runs.find(run => run.id === view.id)!;
    expect(parent.encryptedInput === null).toBe(true); expect(parent.encryptedResult === null).toBe(true); expect(parent.inputChecksum).toBe(born.inputChecksum);
    const strip = (step: (typeof trace)[number]) => Object.fromEntries(Object.entries(step).filter(([key]) => !["encryptedInput", "encryptedResponse", "encryptedOutput"].includes(key)));
    const actual = cleaned.steps.filter(step => step.runId === view.id).sort((a, b) => a.sequence - b.sequence);
    expect(actual.every(step => step.encryptedInput === null && step.encryptedResponse === null && step.encryptedOutput === null)).toBe(true);
    expect(actual.map(strip)).toEqual(trace.map(strip)); expect(cleaned.ledgers).toEqual(original.ledgers);
    const unavailable = await f.service().get(f.base.a.context, view.id); expect(unavailable).toMatchObject({ privateAvailable: false, goal: null, contextText: null, steps: [], definitions: [], observations: [], result: null });
    expect(await f.service().receipt(f.base.a.context, proof(input))).toMatchObject({ disposition: "known", runId: view.id, privateAvailable: false });
    expect(f.modelCalls.length).toBe(calls); expect(await f.business()).toEqual(business);
  }, 65_000);
});
