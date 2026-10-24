import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AGENT_PLAN_VERSION, AgentPlanDecisionSchema, AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentCommandOriginalSchema } from "@yummyai/contracts/ai/agent-command";
import { AGENT_LOOP_VERSION } from "@yummyai/contracts/ai/agent-loop";
import * as persistence from "@yummyai/database";
import { agentPlanRuns, agentPlanSteps, agentPlanItems, agentCommandRequests, aiBudgetLedger, aiBudgetPolicies, connectDatabase, withTenant, type TenantTransaction } from "@yummyai/database";
import { agentPlanSlots } from "../../../../packages/workflow-core/src/agent-plan-model.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bounded, deferred } from "./agent-read.test-fixture.js";
import { agentLoopFixture } from "./agent-loop.test-fixture.js";
import { agentPlanFixture, finishPlan, planClaims, requireAgentPlanEnvironment } from "./agent-plan.test-fixture.js";

const environment = requireAgentPlanEnvironment(), database = connectDatabase(environment.url), f = agentPlanFixture(database);
const proof = (input: { requestId: string }) => ({ requestId: input.requestId, requestChecksum: f.checksum(input) });
const allScopes = (): Record<string, TenantContext["dataScope"]> => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
const scalarStatus = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  if ("getStatus" in error && typeof error.getStatus === "function") return error.getStatus();
  return "status" in error ? error.status : "statusCode" in error ? error.statusCode : null;
};
function postgres(error: unknown) {
  let value = error;
  for (let depth = 0; depth < 8 && value && typeof value === "object"; depth++) {
    if ("code" in value && typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code)) return value.code;
    value = "cause" in value ? value.cause : null;
  }
  throw new Error("Expected real PostgreSQL constraint failure", { cause: error });
}
async function failure(body: (tx: TenantTransaction) => Promise<unknown>) {
  try { await withTenant(database.db, f.base.a.context, body); } catch (error) { return postgres(error); }
  throw new Error("Native planning counterexample unexpectedly committed");
}
const selected = async (originals: Parameters<typeof finishPlan>[1], stockItemId: string | null = null, retentionSeconds?: number) => {
  f.controls.decision = packet => packet.collections.length ? finishPlan(packet, originals) : {
    action: "read", label: "Read actual inventory", read: { tool: "inventory.balances.page", query: { stockItemId, locationId: null } }, result: null };
  const input = await f.request(f.base.a, { contextText: "Synthetic operator-provided drafts are not source-proven: " + JSON.stringify(originals),
    ...(originals?.length ? { allowedCommands: originals.map(original => AgentPlanCommandKeySchema.parse({ domain: original.domain, kind: original.command.kind })) } : {}),
    ...(retentionSeconds === undefined ? {} : { limits: { ...(await f.request()).limits, deadlineSeconds: 30 } }) });
  const created = await f.service(retentionSeconds).start(f.base.a.context, input); await f.process(created.id);
  return f.service().get(f.base.a.context, created.id);
};

describe.sequential("model planning through authentic read and original command owners", () => {
  beforeAll(async () => { await f.initialize(); });
  afterEach(async () => { f.clear(); vi.restoreAllMocks(); await f.base.scopes(f.base.a, allScopes()); await f.settlePrepared(); });
  afterAll(async () => {
    const errors: unknown[] = []; try { f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Agent plan fixture teardown failed");
  });

  it("reads real source fields then seals two unapproved native drafts and settles model cost before separate item preparation and individual human confirmations", async () => {
    const source = await f.source(), before = await f.business(), calls = f.modelCalls.length;
    const run = await selected(source.originals, source.stockItemId);
    expect(run).toMatchObject({ status: "completed", businessExecution: "separate_original_confirmation", verification: "cited_fields_and_collection_versions_only",
      cost: { knownCostUsd: "0.000420", reservedUsd: "0.000000", modelTurns: 2 } });
    expect(run.items).toHaveLength(2); expect(run.items.every(item => item.preparationState === "not_requested" && item.agentCommandId === null)).toBe(true);
    expect(await f.business()).toEqual(before); expect(f.modelCalls.length - calls).toBe(2);
    expect(run.result?.proposals.map(item => item.id)).toEqual(agentPlanSlots(run.id, run.limits.maxProposals).slice(0, 2).map(slot => slot.id));
    expect(f.wire.slice(-2).every(value => value.schemaBytes > 80_000 && value.bodyBytes > value.schemaBytes)).toBe(true);
    const finalStep = (await f.rows()).steps.filter(step => step.runId === run.id && step.kind === "model").sort((a, b) => a.sequence - b.sequence).at(-1)!;
    const raw = f.base.vault.withSecret(finalStep.encryptedResponse!, text => JSON.parse(text));
    expect(f.checksum(raw)).toBe(finalStep.responseChecksum);
    const decision = f.base.vault.withSecret(finalStep.encryptedOutput!, text => AgentPlanDecisionSchema.parse(JSON.parse(text)));
    expect(f.checksum(decision)).toBe(finalStep.outputChecksum); expect(f.checksum(run.result)).not.toBe(finalStep.outputChecksum);
    for (const [position, item] of run.items.entries()) {
      const beforePreparation = await f.business();
      const receipt = await f.service().prepareItem(f.base.a.context, run.id, item.id, f.prepareInput(run, item));
      expect(receipt).toMatchObject({ disposition: "known", runId: run.id, itemId: item.id, preparationRequestChecksum: item.preparationRequestChecksum });
      expect(await f.business()).toEqual(beforePreparation);
      const original = await f.owners.service().get(f.base.a.context, receipt.agentCommandId!);
      expect(original).toMatchObject({ requestId: item.id, state: "prepared", canConfirm: true, originalChecksum: item.originalChecksum });
      expect(original.snapshot?.original?.command.input.idempotencyKey).toBe(item.id);
      const prior = await f.business(); const done = await f.owners.service().confirm(f.base.a.context, original.id, f.confirmation(original));
      expect(done).toMatchObject({ ownerCommandId: receipt.ownerCommandId, state: "succeeded", canConfirm: false });
      const after = await f.business();
      if (position === 0) expect(after.inventory_procurement_requisitions!.count).toBe(prior.inventory_procurement_requisitions!.count + 1);
      else { expect(after.finance_payable_bills!.count).toBe(prior.finance_payable_bills!.count + 1); expect(after.finance_original_write_proofs!.count).toBe(prior.finance_original_write_proofs!.count + 1); }
      const stable = await f.business(); await f.owners.service().confirm(f.base.a.context, original.id, f.confirmation(original)); expect(await f.business()).toEqual(stable);
    }
    expect(f.modelCalls.length - calls).toBe(2);
    expect((await f.rows()).ledgers.filter(row => row.requestId === run.id)).toMatchObject([{ taskType: "erp_agent_plan", state: "committed", amountUsd: "0.000420" }]);
  });

  it("rejects wrong cited quantity unit foreign source unselected commands invented keys and direct model execution without saving preparable items", async () => {
    const source = await f.source(), before = await f.business();
    for (const variant of ["quantity", "unit", "source", "key", "capability", "execute"] as const) {
      f.controls.decision = packet => {
        if (!packet.collections.length) return { action: "read", label: "Read actual source", read: { tool: "inventory.balances.page", query: { stockItemId: source.stockItemId, locationId: null } }, result: null };
        const decision = finishPlan(packet, [source.requisition]); if (!decision.result) throw new Error("Synthetic planner result missing");
        if (variant === "execute") return { ...decision, action: "execute" };
        const claim = decision.result.proposals[0]!.claims.find(value => value.field === (variant === "unit" ? "unit" : "physicalQuantity"))!;
        if (variant === "quantity") claim.value = "999"; if (variant === "unit") claim.value = "each"; if (variant === "source") claim.sourceId = createEntityId();
        if (variant === "key") decision.result.proposals[0]!.original!.command.input.idempotencyKey = createEntityId();
        if (variant === "capability") return { ...decision, result: { ...decision.result, proposals: [{ ...decision.result.proposals[0], capability: { domain: "finance", kind: "bill_record" }, original: AgentCommandOriginalSchema.parse({ ...source.bill,
          command: { ...source.bill.command, input: { ...source.bill.command.input, idempotencyKey: packet.slots[0]!.id } } }) }] } };
        return decision;
      };
      const input = await f.request(f.base.a, { allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] }), created = await f.service().start(f.base.a.context, input);
      await f.process(created.id); const view = await f.service().get(f.base.a.context, created.id);
      expect(view.status).toBe("failed"); expect(view.items).toEqual([]); expect(view.result).toBeNull();
    }
    expect(await f.business()).toEqual(before);
  });

  it("uses all501 original records for complete evidence while a capped prefix cannot invent total claims or silently prepare a complete-source proposal", async () => {
    const source = await f.base.stock(f.base.a, 501), before = await f.business();
    f.controls.decision = packet => packet.collections.length ? finishPlan(packet) : { action: "read", label: "Read all original rows",
      read: { tool: "inventory.balances.page", query: { stockItemId: source.stockItemId, locationId: null } }, result: null };
    const input = await f.request(f.base.a, { limits: { ...(await f.request()).limits, maxRows: 1000 } }), created = await f.service().start(f.base.a.context, input);
    await f.process(created.id); const full = await f.service().get(f.base.a.context, created.id);
    expect(full.status).toBe("completed"); expect(full.collections[0]).toMatchObject({ total: 501, readCount: 501, complete: true });
    expect(new Set(full.collections[0]!.rows.map(row => row.sourceId)).size).toBe(501); expect(full.result?.claims.find(claim => claim.sourceId === "$collection")?.value).toBe(501);
    const limitedInput = await f.request(f.base.a, { limits: { ...input.limits, maxRows: 20 } }), limited = await f.service().start(f.base.a.context, limitedInput);
    await f.process(limited.id); const partial = await f.service().get(f.base.a.context, limited.id);
    expect(partial.collections[0]).toMatchObject({ total: 501, readCount: 20, complete: false, limitReason: "row_limit" });
    expect(partial.result?.claims.some(claim => claim.sourceId === "$collection")).not.toBe(true); expect(await f.business()).toEqual(before);
  });

  it("rechecks actual source versions before explicit preparation and never substitutes a new body after the original collection changed", async () => {
    const source = await f.source(), run = await selected([source.requisition], source.stockItemId), item = run.items[0]!;
    const fixed = run.result?.proposals[0], calls = f.modelCalls.length;
    await f.base.inventory.recordMovement(f.base.a.context, { stockItemId: source.stockItemId, locationId: source.locations[0]!, lotId: null,
      bucket: "physical", type: "adjustment", quantityDelta: "1", unit: "meter", sourceType: "manual", sourceId: "synthetic-plan-current",
      reasonCode: "PHYSICAL_COUNT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    const before = await f.business();
    await expect(f.service().prepareItem(f.base.a.context, run.id, item.id, f.prepareInput(run, item))).rejects.toBeInstanceOf(ConflictException);
    const current = await f.service().get(f.base.a.context, run.id); expect(current.result?.proposals[0]).toEqual(fixed);
    expect(await f.business()).toEqual(before); expect(f.modelCalls.length).toBe(calls);
    if (source.requisition.domain !== "procurement" || source.requisition.command.kind !== "requisition_create") throw new Error("Synthetic source lacks its real requisition input");
    const requisition = await f.owners.procurementOwner.createRequisition(f.base.a.context, source.requisition.command.input);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const rfq = await f.owners.procurementOwner.createRfq(f.base.a.context, requisition.id, { expectedRequisitionVersion: 1, supplierIds: [source.supplierId], responseDueAt: future, idempotencyKey: randomUUID() });
    const quoteInput = { supplierId: source.supplierId, currency: "USD", validUntil: future,
      lines: [{ lineKey: "LINE-1", unitCostMinor: 200, minimumOrderQuantity: 1, leadTimeDays: 2 }], idempotencyKey: randomUUID() };
    const quote = await f.owners.procurementOwner.recordSupplierQuote(f.base.a.context, rfq.id, quoteInput);
    const purchase = AgentCommandOriginalSchema.parse({ domain: "procurement", command: { kind: "purchase_create", targetId: null, input: {
      code: "PLAN-QUOTE-" + createEntityId().slice(-8).toUpperCase(), supplierId: source.supplierId, requisitionId: requisition.id, quoteId: quote.id,
      currency: "USD", expectedAt: future, lines: source.requisition.command.input.lines.map(line => ({ ...line, unitCostMinor: 200 })), idempotencyKey: randomUUID() } } });
    const purchasePlan = await selected([purchase], source.stockItemId), purchaseItem = purchasePlan.items[0]!;
    const receipt = await f.service().prepareItem(f.base.a.context, purchasePlan.id, purchaseItem.id, f.prepareInput(purchasePlan, purchaseItem));
    const prepared = await f.owners.service().get(f.base.a.context, receipt.agentCommandId!), confirmation = f.confirmation(prepared);
    await f.owners.procurementOwner.recordSupplierQuote(f.base.a.context, rfq.id, { ...quoteInput, lines: quoteInput.lines.map(line => ({ ...line, unitCostMinor: 400 })), idempotencyKey: randomUUID() });
    const changedBasis = await f.business(); expect(await f.owners.service().get(f.base.a.context, prepared.id)).toMatchObject({ state: "prepared", canConfirm: false, originalChecksum: purchaseItem.originalChecksum });
    await expect(f.owners.service().confirm(f.base.a.context, prepared.id, confirmation)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.business()).toEqual(changedBasis);
  });

  it("retains parent permission ceilings for later preparation and enforces current per-bit actor tenant and late source-response authority", async () => {
    const source = await f.source(), limitedScopes = allScopes(); delete limitedScopes[Permission.ProcurementWrite];
    const request = await f.request(f.base.a, { allowedReads: [], allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] });
    const limited = await f.base.scopes(f.base.a, limitedScopes);
    const prior = await f.rows();
    await expect(f.service().start(limited, request)).rejects.toSatisfy((error: unknown) => [403, 409].includes(Number(scalarStatus(error))));
    expect(await f.rows()).toEqual(prior);
    await f.base.scopes(f.base.a, allScopes());
    f.controls.decision = packet => finishPlan(packet, [source.requisition]);
    const input = await f.request(f.base.a, { allowedReads: [], allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] });
    const original = await f.service().start(f.base.a.context, input); await f.process(original.id);
    const run = await f.service().get(f.base.a.context, original.id), item = run.items[0]!, before = await f.business();
    const currentLimited = await f.base.scopes(f.base.a, limitedScopes);
    await expect(f.service().prepareItem(currentLimited, run.id, item.id, f.prepareInput(run, item))).rejects.toSatisfy((error: unknown) => [403, 409].includes(Number(scalarStatus(error))));
    await f.base.scopes(f.base.a, allScopes());
    for (const peer of [f.base.second.context, f.base.foreign.context]) {
      await expect(f.service().get(peer, run.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.service().itemReceipt(peer, run.id, item.id, f.prepareInput(run, item))).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await f.business()).toEqual(before);
    const entered = deferred(), release = deferred(); f.controls.decision = packet => packet.collections.length ? finishPlan(packet) : {
      action: "read", label: "Read original tenant inventory", read: { tool: "inventory.balances.page", query: { stockItemId: source.stockItemId, locationId: null } }, result: null };
    f.controls.afterRead = async () => { entered.resolve(); await release.promise; };
    const lateInput = await f.request(), late = await f.service().start(f.base.a.context, lateInput), pending = f.process(late.id);
    try {
      await bounded(entered.promise, "Original planner owner response did not reach late gate");
      const scopes = allScopes(); scopes[Permission.InventoryRead] = "self"; const narrow = await f.base.scopes(f.base.a, scopes);
      release.resolve(); await bounded(pending, "Late revoked planner did not settle");
      expect(await f.service().get(narrow, late.id)).toMatchObject({ privateAvailable: false, goal: null, contextText: null, result: null, collections: [], steps: [] });
      expect(await f.service().receipt(narrow, proof(lateInput))).toMatchObject({ runId: late.id, privateAvailable: false });
      expect(await f.service().stop(narrow, late.id, { version: AGENT_PLAN_VERSION, requestId: lateInput.requestId })).toMatchObject({ runId: late.id, privateAvailable: false });
    } finally { release.resolve(); await pending; }
  });

  it("recovers an original preparation committed before response loss after actual private expiration using the same item receipt without another model or owner prepare", async () => {
    const source = await f.source(), run = await selected([source.requisition], source.stockItemId, 35), item = run.items[0]!, calls = f.modelCalls.length;
    const actual = f.owners.adapter.prepare.bind(f.owners.adapter), loss = vi.spyOn(f.owners.adapter, "prepare").mockImplementationOnce(async (context, original) => {
      await actual(context, original); throw new Error("synthetic_plan_prepare_response_lost");
    });
    await expect(f.service().prepareItem(f.base.a.context, run.id, item.id, f.prepareInput(run, item))).rejects.toThrow("synthetic_plan_prepare_response_lost"); loss.mockRestore();
    const before = await f.business(), paid = (await f.rows()).ledgers.find(row => row.requestId === run.id)!;
    await withTenant(database.db, f.base.a.context, tx => tx.execute(sql`select pg_sleep(greatest(0,extract(epoch from (
      (select expires_at from agent_plan_runs where id=${run.id}::uuid)-clock_timestamp())))+0.05)`));
    await f.runtime().process(f.base.a.context, run.id, "expire");
    const expired = await f.service().get(f.base.a.context, run.id); expect(expired).toMatchObject({ privateAvailable: false, goal: null, contextText: null, result: null, collections: [], steps: [] });
    const physical = await f.rows(), parent = physical.runs.find(row => row.id === run.id)!;
    expect(parent.encryptedInput === null && parent.encryptedResult === null).toBe(true);
    expect(physical.steps.filter(step => step.runId === run.id).every(step => step.encryptedInput === null && step.encryptedOutput === null && step.encryptedResponse === null)).toBe(true);
    expect(physical.ledgers.find(row => row.requestId === run.id)).toEqual(paid);
    const prepare = vi.spyOn(f.owners.adapter, "prepare"), execute = vi.spyOn(f.owners.adapter, "execute");
    const recovered = await f.service().itemReceipt(f.base.a.context, run.id, item.id, f.prepareInput(run, item));
    expect(recovered).toMatchObject({ disposition: "known", itemId: item.id, preparationRequestChecksum: item.preparationRequestChecksum });
    const native = await f.owners.service().get(f.base.a.context, recovered.agentCommandId!); expect(native).toMatchObject({ requestId: item.id, state: "prepared", canConfirm: true });
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(f.modelCalls.length).toBe(calls); expect(await f.business()).toEqual(before);
  });

  it("serializes concurrent preparation and native confirmation into one original intent and business proof while another proposal still needs its own explicit confirmation", async () => {
    const source = await f.source(), run = await selected(source.originals, source.stockItemId), item = run.items[0]!, body = f.prepareInput(run, item), before = await f.business();
    const results = await Promise.all(Array.from({ length: 3 }, () => f.service().prepareItem(f.base.a.context, run.id, item.id, body)));
    expect(new Set(results.map(result => result.agentCommandId)).size).toBe(1); expect(await f.business()).toEqual(before);
    const rows = await withTenant(database.db, f.base.a.context, tx => tx.select().from(agentCommandRequests).where(eq(agentCommandRequests.requestId, item.id)));
    expect(rows).toHaveLength(1);
    const ready = await f.owners.service().get(f.base.a.context, results[0]!.agentCommandId!), confirmation = f.confirmation(ready);
    const another = run.items[1]!;
    const otherReceipt = await f.service().prepareItem(f.base.a.context, run.id, another.id, f.prepareInput(run, another));
    await expect(f.owners.service().confirm(f.base.a.context, otherReceipt.agentCommandId!, confirmation)).rejects.toBeInstanceOf(ConflictException);
    await Promise.all([f.owners.service().confirm(f.base.a.context, ready.id, confirmation), f.owners.adapter.execute(f.base.a.context, ready.snapshot!.reference)]);
    const after = await f.business(); expect(after.inventory_procurement_requisitions!.count).toBe(before.inventory_procurement_requisitions!.count + 1);
    expect(after.finance_payable_bills).toEqual(before.finance_payable_bills);
    expect((await f.owners.service().get(f.base.a.context, otherReceipt.agentCommandId!)).state).toBe("prepared");
  });

  it("preserves unknown paid submission or missing usage without rerouting generating again or preparing drafts and keeps the full original cap", async () => {
    for (const variant of ["submission", "usage"] as const) {
      const before = await f.business(), calls = f.modelCalls.length; f.controls.unknownUsage = variant === "usage";
      f.controls.beforeModel = variant === "submission" ? async () => { throw new TypeError("Synthetic submitted model response lost"); } : undefined;
      const input = await f.request(), created = await f.service().start(f.base.a.context, input); await f.process(created.id);
      const actual = await f.service().get(f.base.a.context, created.id);
      expect(actual).toMatchObject({ status: "uncertain", errorCode: variant === "submission" ? "agent_submission_unknown" : "agent_cost_unknown",
        result: null, items: [], cost: { knownCostUsd: "0.000000", reservedUsd: "1.000000", coverage: "unknown" } });
      const stable = await f.rows(); await f.process(created.id); await f.service().receipt(f.base.a.context, proof(input));
      expect(f.modelCalls.length - calls).toBe(1); expect(await f.business()).toEqual(before);
      expect((await f.rows()).ledgers.find(row => row.requestId === created.id)).toEqual(stable.ledgers.find(row => row.requestId === created.id)); f.clear();
    }
  });

  it("adopts an authenticated response-ready decision after lease handoff once and keeps raw response parsed decision and normalized proposal hashes distinct", async () => {
    const source = await f.source(), saved = deferred(), release = deferred(), calls = f.modelCalls.length;
    f.controls.decision = packet => finishPlan(packet, [source.requisition]); f.controls.afterCheckpoint = async () => { saved.resolve(); await release.promise; };
    const input = await f.request(f.base.a, { allowedReads: [] }), created = await f.service().start(f.base.a.context, input), pending = f.process(created.id);
    try {
      await bounded(saved.promise, "Actual planning provider checkpoint was not saved");
      const checkpoint = (await f.rows()).steps.find(step => step.runId === created.id)!;
      expect(checkpoint).toMatchObject({ phase: "response_ready", submissionState: "received", costUsd: "0.000210" });
      await withTenant(database.db, f.base.a.context, tx => tx.update(agentPlanRuns).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(agentPlanRuns.id, created.id)));
      f.controls.afterCheckpoint = undefined; await f.runtime().process(f.base.a.context, created.id); release.resolve(); await bounded(pending, "Old planner worker failed to settle");
      const done = await f.service().get(f.base.a.context, created.id); expect(done).toMatchObject({ status: "completed", cost: { knownCostUsd: "0.000210", modelTurns: 1 } });
      expect(done.items).toHaveLength(1); expect(done.items[0]?.agentCommandId).toBeNull(); expect(f.modelCalls.length - calls).toBe(1);
      const final = (await f.rows()).steps.find(step => step.id === checkpoint.id)!; expect(final.responseChecksum).toBe(checkpoint.responseChecksum); expect(final.outputChecksum).not.toBe(final.responseChecksum);
    } finally { release.resolve(); await pending; }
  });

  it("requires same-transaction admission audit immutable parent and authentic terminal items even after an early constraint flush", async () => {
    const input = await f.request(), before = await f.rows(), dispatches = f.dispatcherCalls.length;
    const broken = vi.spyOn(persistence, "recordAuditInTransaction").mockRejectedValueOnce(new Error("synthetic_plan_audit_failure"));
    await expect(f.service().start(f.base.a.context, input)).rejects.toThrow("synthetic_plan_audit_failure"); broken.mockRestore();
    expect(await f.rows()).toEqual(before); expect(f.dispatcherCalls.length).toBe(dispatches);
    const created = await f.service().start(f.base.a.context, input), original = (await f.rows()).runs.find(run => run.id === created.id)!;
    const born = await withTenant(database.db, f.base.a.context, tx => tx.execute<{ same: boolean }>(sql`
      select (r.creation_transaction_id::numeric%4294967296)::text=l.xmin::text
        and (r.creation_transaction_id::numeric%4294967296)::text=a.xmin::text as same
      from agent_plan_runs r join ai_budget_ledger l on l.id=r.budget_ledger_id
      join audit_events a on a.entity_id=r.id and a.action='agent.plan.create' where r.id=${created.id}::uuid`));
    expect(born).toEqual([{ same: true }]);
    const stable = await f.rows();
    expect(await failure(tx => tx.update(agentPlanRuns).set({ originCeiling: f.base.second.context }).where(eq(agentPlanRuns.id, created.id)))).toBe("23514");
    expect(await failure(async tx => { await tx.execute(sql`set constraints all immediate`); await tx.update(agentPlanRuns).set({ requestChecksum: "f".repeat(64) }).where(eq(agentPlanRuns.id, created.id)); })).toBe("23514");
    expect(await failure(async tx => { await tx.update(agentPlanRuns).set({ status: "completed", completedAt: new Date() }).where(eq(agentPlanRuns.id, created.id));
      await tx.update(aiBudgetLedger).set({ state: "released" }).where(eq(aiBudgetLedger.id, original.budgetLedgerId)); await tx.execute(sql`set constraints all immediate`); })).toBe("23514");
    expect(await failure(tx => persistence.recordAuditInTransaction(tx, f.base.a.context, { action: "agent.plan.create", resourceType: "agent_plan_run", resourceId: createEntityId(), result: "success",
      metadata: { requestChecksum: original.requestChecksum, inputChecksum: original.inputChecksum, budgetLedgerId: original.budgetLedgerId } }))).toBe("23514");
    expect(await failure(tx => tx.insert(agentPlanItems).values({ id: createEntityId(), tenantId: f.base.a.tenantId, runId: created.id,
      modelStepId: createEntityId(), position: 0, proposalChecksum: "a".repeat(64) }))).toBe("23514");
    expect(await failure(tx => tx.insert(agentPlanSteps).values({ id: createEntityId(), tenantId: f.base.a.tenantId, runId: created.id,
      sequence: 1, kind: "read", label: "Unexecuted child cannot be an original source", tool: "inventory.balances.page",
      inputChecksum: "a".repeat(64), previousChecksum: original.inputChecksum, encryptedInput: "synthetic-unauthenticated-envelope" }))).toBe("23514");
    expect(await f.rows()).toEqual(stable);
    await f.service().stop(f.base.a.context, created.id, { version: AGENT_PLAN_VERSION, requestId: input.requestId }); await f.process(created.id);

    const raceInput = await f.request(), race = await f.service().start(f.base.a.context, raceInput);
    const entered = deferred(), release = deferred(); let firstTransactionId: string | undefined;
    const pending = withTenant(database.db, f.base.a.context, async tx => {
      const [transaction] = await tx.execute<{ id: string }>(sql`select pg_current_xact_id()::text as id`);
      firstTransactionId = transaction!.id; entered.resolve();
      await bounded(release.promise, "Actual later stop did not release the earlier transaction");
      await tx.update(agentPlanRuns).set({ dispatchCount: sql`${agentPlanRuns.dispatchCount}+1`, lastDispatchedAt: sql`clock_timestamp()` }).where(eq(agentPlanRuns.id, race.id));
      await persistence.recordAuditInTransaction(tx, f.base.a.context, { action: "agent.plan.stop", resourceType: "agent_plan_run", resourceId: race.id,
        result: "success", metadata: { requestChecksum: race.requestChecksum } });
    });
    const observed = pending.then(() => ({ committed: true as const, error: null }), error => ({ committed: false as const, error }));
    try {
      await bounded(entered.promise, "The earlier real transaction did not obtain its full transaction ID");
      await f.service().stop(f.base.a.context, race.id, { version: AGENT_PLAN_VERSION, requestId: raceInput.requestId });
      const stopped = await f.rows(), parent = stopped.runs.find(row => row.id === race.id)!;
      expect(parent.stopTransactionId).toMatch(/^[0-9]+$/); expect(parent.stopTransactionId).not.toBe(firstTransactionId);
      release.resolve(); const outcome = await bounded(observed, "The earlier forged stop audit did not settle");
      expect(outcome.committed).toBe(false); expect(postgres(outcome.error)).toBe("23514");
      let cause: unknown = outcome.error;
      for (let depth = 0; depth < 8 && cause && typeof cause === "object" && !("code" in cause && cause.code === "23514"); depth++) cause = "cause" in cause ? cause.cause : null;
      expect(cause).toMatchObject({ message: "agent_audit_stop_invalid" });
      expect(await f.rows()).toEqual(stopped);
    } finally { release.resolve(); await observed; }
    await f.process(race.id);
  });

  it("shares four-active admission with old read-v1 and native Assist and does not dispatch from receipts or repeat an original key after queue loss", async () => {
    const input = await f.request(), count = f.dispatcherCalls.length; f.controls.failQueue = true;
    const [a, b] = await Promise.all([f.service().start(f.base.a.context, input), f.service().start(f.base.a.context, input)]);
    expect(a.id).toBe(b.id); expect(f.dispatcherCalls.length - count).toBe(1);
    const untouched = f.dispatcherCalls.length; await f.service().receipt(f.base.a.context, proof(input)); expect(f.dispatcherCalls.length).toBe(untouched); f.controls.failQueue = false;
    const old = agentLoopFixture(database, { contentVault: f.base.vault, modelVault: f.base.modelVault });
    const readWorkspace = await old.service().workspace(f.base.a.context);
    const oldLimits = { maxModelTurns: input.limits.maxModelTurns, maxToolCalls: input.limits.maxToolCalls, maxRows: input.limits.maxRows,
      maxOutputTokens: input.limits.maxOutputTokens, maxPromptBytes: input.limits.maxPromptBytes, deadlineSeconds: input.limits.deadlineSeconds };
    const oldInput = { version: AGENT_LOOP_VERSION, requestId: randomUUID(), modelId: f.base.modelId, goal: "Original v1 remains read-only",
      allowedTools: ["inventory.balances.page"], limits: oldLimits, maxCostUsd: 0.1, executionContract: readWorkspace.executionContract };
    const active = [a];
    try {
      const legacy = await old.service().start(f.base.a.context, oldInput);
      for (let index = 0; index < 2; index++) active.push(await f.service().start(f.base.a.context, { ...input, requestId: randomUUID() }));
      await expect(f.service().start(f.base.a.context, { ...input, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      await expect(old.service().start(f.base.a.context, { ...oldInput, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      const nativeInput = await f.base.knowledgeRequest(); await expect(f.base.assists.create(f.base.a.context, nativeInput)).rejects.toBeInstanceOf(ConflictException);
      await old.service().stop(f.base.a.context, legacy.id, { version: AGENT_LOOP_VERSION, requestId: legacy.requestId }); await old.runtime().process(f.base.a.context, legacy.id);
    } finally { for (const run of active) { await f.service().stop(f.base.a.context, run.id, { version: AGENT_PLAN_VERSION, requestId: run.requestId }); await f.process(run.id); } old.close(); }
    const [priorPolicy] = await withTenant(database.db, f.base.a.context, tx => tx.select().from(aiBudgetPolicies));
    if (!priorPolicy) throw new Error("Synthetic default budget policy must already exist for exact restoration");
    try {
      const update = async (monthlyCapUsd: string, taskCapsUsd: Record<string, number>) => withTenant(database.db, f.base.a.context, tx => tx.insert(aiBudgetPolicies).values({
        tenantId: f.base.a.tenantId, monthlyCapUsd, defaultTaskCapUsd: "1", taskCapsUsd }).onConflictDoUpdate({ target: aiBudgetPolicies.tenantId, set: { monthlyCapUsd, defaultTaskCapUsd: "1", taskCapsUsd } }));
      await update("100", { erp_agent: 0.01 }); const beforeCap = await f.rows(), beforeDispatch = f.dispatcherCalls.length;
      await expect(f.service().start(f.base.a.context, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ response: { code: "agent_budget_limit" } });
      expect(await f.rows()).toEqual(beforeCap); expect(f.dispatcherCalls.length).toBe(beforeDispatch);
      await update("0.000001", { erp_agent: 1 });
      await expect(f.service().start(f.base.a.context, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ response: { code: "agent_monthly_budget_limit" } });
      expect(await f.rows()).toEqual(beforeCap); expect(f.dispatcherCalls.length).toBe(beforeDispatch);
    } finally {
      await withTenant(database.db, f.base.a.context, async tx => {
        await tx.update(aiBudgetPolicies).set({ monthlyCapUsd: priorPolicy.monthlyCapUsd, defaultTaskCapUsd: priorPolicy.defaultTaskCapUsd,
          taskCapsUsd: priorPolicy.taskCapsUsd }).where(eq(aiBudgetPolicies.tenantId, f.base.a.tenantId));
      });
    }
  });

  it("retains missing-source drafts as blocked leaves and stops before paid submission without changing original production approval or inferring a new request from not-found", async () => {
    f.controls.decision = packet => ({ action: "finish", label: "Missing real production source", read: null, result: { summary: "Actual original production basis is absent", claims: [], missingInformation: ["No approved production source"],
      proposals: [{ position: 0, capability: { domain: "production", kind: "approved_design" }, label: "No executable production draft", reason: "Actual source owner has no original approval",
        original: null, claims: planClaims(packet), missingInformation: ["No real pinned production source"] }] } });
    const input = await f.request(f.base.a, { allowedReads: [], allowedCommands: [{ domain: "production", kind: "approved_design" }] }), created = await f.service().start(f.base.a.context, input);
    const before = await f.business(); await f.process(created.id); const done = await f.service().get(f.base.a.context, created.id), item = done.items[0]!;
    expect(item).toMatchObject({ canPrepare: false, blockReason: "missing_information", originalChecksum: null, preparationRequestChecksum: null });
    await expect(f.service().prepareItem(f.base.a.context, done.id, item.id, f.prepareInput(done, item))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.business()).toEqual(before);
    const missing = await f.service().receipt(f.base.a.context, { requestId: randomUUID(), requestChecksum: "f".repeat(64) }); expect(missing).toMatchObject({ disposition: "not_found", runId: null });
    const nextInput = await f.request(), next = await f.service().start(f.base.a.context, nextInput), calls = f.modelCalls.length;
    await f.service().stop(f.base.a.context, next.id, { version: AGENT_PLAN_VERSION, requestId: nextInput.requestId }); await f.process(next.id);
    expect((await f.service().get(f.base.a.context, next.id)).status).toBe("stopped"); expect(f.modelCalls.length).toBe(calls);
  });

  it("does not treat a born child coordinator as a prepared native command after a real owner conflict and permits only an explicit same-item same-key retry", async () => {
    const source = await f.source(), blocker = await f.owners.procurement.prepare(f.base.a.context, source.requisition.command);
    const run = await selected([source.requisition], source.stockItemId), item = run.items[0]!, input = f.prepareInput(run, item), calls = f.modelCalls.length;
    const before = await f.business();
    await expect(f.service().prepareItem(f.base.a.context, run.id, item.id, input)).rejects.toBeInstanceOf(ConflictException);
    const [child] = await withTenant(database.db, f.base.a.context, tx => tx.select().from(agentCommandRequests).where(eq(agentCommandRequests.requestId, item.id)));
    expect(child).toMatchObject({ requestId: item.id, ownerCommandId: null, requestChecksum: item.preparationRequestChecksum });
    const prepare = vi.spyOn(f.owners.adapter, "prepare");
    expect(await f.service().itemReceipt(f.base.a.context, run.id, item.id, input)).toMatchObject({ disposition: "unknown", agentCommandId: null, ownerCommandId: null });
    expect((await f.service().get(f.base.a.context, run.id)).items[0]).toMatchObject({ preparationState: "requested_unknown", agentCommandId: null });
    expect(prepare).not.toHaveBeenCalled(); expect(await f.business()).toEqual(before); prepare.mockRestore();
    await f.owners.procurement.cancel(f.base.a.context, blocker.id); await f.owners.procurement.acknowledge(f.base.a.context, blocker.id);
    const recovered = await f.service().prepareItem(f.base.a.context, run.id, item.id, input);
    expect(recovered).toMatchObject({ disposition: "known", itemId: item.id, agentCommandId: child!.id }); expect(recovered.ownerCommandId).not.toBeNull();
    const native = await f.owners.service().get(f.base.a.context, recovered.agentCommandId!);
    expect(native.requestId).toBe(item.id); expect(native.snapshot?.original?.command.input.idempotencyKey).toBe(item.id);
    expect(await f.business()).toEqual(before); expect(f.modelCalls.length).toBe(calls);
  });
});
