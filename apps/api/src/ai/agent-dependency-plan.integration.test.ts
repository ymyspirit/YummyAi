import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import { AGENT_DEPENDENCY_PLAN_VERSION, AgentDependencyPlanViewSchema, AgentDependencyPlanReceiptSchema,
  AgentDependencyPlanPageSchema } from "@yummyai/contracts/ai/agent-dependency-plan";
import { agentDependencyPlans, connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { requireAgentDependencyPlanEnvironment } from "../../../../tools/testing/require-agent-dependency-plan-environment.mjs";
import { agentDependencyPlanFixture, dependencyAuthority, dependencyErrorCode, dependencyErrorStatus, dependencyHash, dependencyPermissions } from "./agent-dependency-plan.test-fixture.js";

const isolated = requireAgentDependencyPlanEnvironment(), database = connectDatabase(isolated.url), f = agentDependencyPlanFixture(database);
type Plan = Awaited<ReturnType<ReturnType<typeof f.service>["get"]>>;
function rejectCode(code: string) { return (error: unknown) => dependencyErrorStatus(error) === 409 && dependencyErrorCode(error) === code; }
const cancelInput = (view: Plan) => ({ version: AGENT_DEPENDENCY_PLAN_VERSION, requestId: view.requestId });
async function ready() {
  const basis = await f.basis(), input = f.request(basis.parent), waiting = await f.service().create(await f.current(), input);
  await f.completeParent(basis.parent); const view = await f.service().get(await f.current(), waiting.id);
  expect(view.state).toBe("ready_to_prepare"); expect(view.source).not.toBeNull(); expect(view.childDraft).not.toBeNull();
  return { basis, input, view };
}
function identity(row: typeof agentDependencyPlans.$inferSelect) {
  return { id: row.id, tenantId: row.tenantId, ownerId: row.ownerId, requestId: row.requestId, requestChecksum: row.requestChecksum,
    kind: row.kind, version: row.version, parentAgentCommandId: row.parentAgentCommandId, childRequestId: row.childRequestId,
    childNativeKey: row.childNativeKey, originCeiling: row.originCeiling, dueAt: row.dueAt, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

describe.sequential("fixed original invoice to payable dependency", () => {
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 90_000);
  afterEach(async () => { vi.restoreAllMocks(); await f.settle(); }, 60_000);
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "dependency_integration_teardown_failed");
  });

  it("dependency_positive uses the actual invoice result before separate original finance preparation and a second specific confirmation", async () => {
    const basis = await f.basis(), input = f.request(basis.parent), before = await f.business();
    const waiting = AgentDependencyPlanViewSchema.parse(await f.service().create(await f.current(), input));
    expect(waiting.state).toBe("waiting_predecessor"); expect(waiting.canPrepare).toBe(false); expect(waiting.source).toBeNull();
    expect(waiting.childAgentCommandId).toBeNull(); expect(waiting.childDraft).toBeNull(); expect(await f.business()).toEqual(before);
    const born = (await f.rows()).plans.find(row => row.id === waiting.id)!;
    expect(born.childRequestId).not.toBe(input.requestId); expect(born.childNativeKey).not.toBe(born.childRequestId);
    const parent = await f.completeParent(basis.parent);
    expect(parent.state).toBe("succeeded"); const ready = await f.service().get(await f.current(), waiting.id);
    expect(ready.state).toBe("ready_to_prepare"); expect(ready.canPrepare).toBe(true);
    const source = ready.source!, draft = ready.childDraft!;
    expect(source.invoiceId).toBe(ready.parent.resultId); expect(source.purchaseOrderId).toBe(basis.order.id);
    expect(draft.command.input).toMatchObject({ kind: "procurement_invoice", procurementInvoiceId: source.invoiceId,
      supplierId: source.supplierId, currency: source.currency, amountMinor: source.totalMinor, externalBillId: source.invoiceNumber, issuedAt: source.issuedAt,
      idempotencyKey: born.childNativeKey, dueAt: null });
    const afterParent = await f.business(), prepared = await f.service().prepare(await f.current(), ready.id, f.prepareInput(ready));
    expect(prepared.state).toBe("child_prepared"); expect(prepared.child?.state).toBe("prepared"); expect(await f.business()).toEqual(afterParent);
    expect(identity((await f.rows()).plans.find(row => row.id === ready.id)!)).toEqual(identity(born));
    const child = await f.commands.get(await f.current(), prepared.childAgentCommandId!);
    expect(child.canConfirm).toBe(true); expect(child.originalChecksum).toBe(dependencyHash(canonicalAgentCommandOriginal(draft)));
    expect(child.requestId).toBe(born.childRequestId); expect(child.requestChecksum).toBe(prepared.childPreparationRequestChecksum);
    expect(prepared.childPreparationRequestChecksum).toBe(dependencyHash(canonicalAgentCommandRequest("prepare", { version: AGENT_COMMAND_VERSION, requestId: born.childRequestId, original: draft })));
    const confirmed = await f.commands.confirm(await f.current(), child.id, f.confirmation(child)); expect(confirmed.state).toBe("succeeded");
    const done = await f.service().get(await f.current(), ready.id), facts = await f.result(done);
    expect(done.state).toBe("succeeded"); expect(done.child?.resultId).toBe(facts.bill?.id);
    expect(facts.proof?.invoice_id).toBe(source.invoiceId); expect(facts.proof?.id).toBe(source.procurementProofId);
    expect(facts.bill).toMatchObject({ procurement_invoice_id: source.invoiceId, procurement_proof_id: source.procurementProofId,
      supplier_id: source.supplierId, currency: source.currency, amount_minor: String(source.totalMinor), request_key: born.childNativeKey, recorded_by: f.a.userId });
    const after = await f.business(); expect(after.tables.finance_payable_bills!.count).toBe(afterParent.tables.finance_payable_bills!.count + 1);
    expect(after.tables.finance_original_write_proofs!.count).toBe(afterParent.tables.finance_original_write_proofs!.count + 1);
    for (const table of Object.keys(afterParent.tables).filter(table => !["finance_payable_bills", "finance_original_write_proofs"].includes(table))) expect(after.tables[table]).toEqual(afterParent.tables[table]);
    await f.commands.confirm(await f.current(), child.id, f.confirmation(child)); await f.service().receipt(await f.current(), f.receipt(input));
    expect(await f.business()).toEqual(after); expect(done.businessExecution).toBe("separate_original_confirmation"); expect(done.modelCalls).toBe(0); expect(done.queueDispatches).toBe(0);
  });

  it("dependency_blocked_predecessor cannot prepare from a merely prepared or cancelled native parent and plan cancellation never confirms either owner", async () => {
    for (const variant of ["prepared", "cancelled", "plan_cancelled"] as const) {
      const basis = await f.basis(), input = f.request(basis.parent), plan = await f.service().create(await f.current(), input);
      if (variant === "cancelled") await f.commands.cancel(await f.current(), basis.parent.id, { version: AGENT_COMMAND_VERSION, requestId: basis.parent.requestId, ownerCommandId: basis.parent.ownerCommandId });
      if (variant === "plan_cancelled") await f.service().cancel(await f.current(), plan.id, cancelInput(plan));
      const before = await f.business(), view = await f.service().get(await f.current(), plan.id);
      expect(view.canPrepare).toBe(false); expect(view.source).toBeNull(); expect(view.childAgentCommandId).toBeNull();
      expect(view.state).toBe(variant === "prepared" ? "waiting_predecessor" : variant === "cancelled" ? "predecessor_blocked" : "cancelled");
      const code = variant === "prepared" ? "agent_dependency_plan_parent_not_succeeded" : variant === "cancelled" ? "agent_dependency_plan_parent_terminal" : "agent_dependency_plan_cancelled";
      await expect(f.service().prepare(await f.current(), plan.id, { version: AGENT_DEPENDENCY_PLAN_VERSION, requestId: plan.requestId, sourceChecksum: "0".repeat(64) })).rejects.toSatisfy(rejectCode(code));
      expect(await f.business()).toEqual(before); expect((await f.rows()).plans.find(row => row.id === plan.id)?.preparationRequestedAt).toBeNull();
      if (variant !== "cancelled") expect((await f.commands.get(await f.current(), basis.parent.id)).state).toBe("prepared");
    }
  });

  it("dependency_original_recovery locates a committed child and completed native bill after response loss using reconstructed coordinators and original GET receipts only", async () => {
    const { input, view } = await ready(), actual = f.commands.prepare.bind(f.commands);
    const lost = vi.spyOn(f.commands, "prepare").mockImplementationOnce(async (context, raw) => { await actual(context, raw); throw new Error("synthetic_dependency_preparation_response_lost"); });
    await expect(f.service().prepare(await f.current(), view.id, f.prepareInput(view))).rejects.toThrow("synthetic_dependency_preparation_response_lost"); lost.mockRestore();
    const pending = (await f.rows()).plans.find(row => row.id === view.id)!;
    expect(pending.preparationRequestedAt).not.toBeNull(); expect(pending.childPreparationRequestChecksum).not.toBeNull(); expect(pending.childOwnerCommandId).toBeNull();
    const before = await f.business(), prepare = vi.spyOn(f.commands, "prepare"), execute = vi.spyOn(f.owners.adapter, "execute");
    const recovered = AgentDependencyPlanReceiptSchema.parse(await f.service().receipt(await f.current(), f.receipt(input)));
    expect(recovered.disposition).toBe("known"); expect(recovered.id).toBe(view.id);
    const linked = await f.service().get(await f.current(), view.id); expect(linked.state).toBe("child_prepared");
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(await f.business()).toEqual(before);
    expect((await f.rows()).commands.filter(row => row.requestId === pending.childRequestId)).toHaveLength(1);
    prepare.mockRestore(); execute.mockRestore();
    const child = await f.commands.get(await f.current(), linked.childAgentCommandId!), realExecute = f.owners.adapter.execute.bind(f.owners.adapter);
    const lostExecution = vi.spyOn(f.owners.adapter, "execute").mockImplementationOnce(async (context, reference) => { await realExecute(context, reference); throw new Error("synthetic_dependency_execution_response_lost"); });
    await expect(f.commands.confirm(await f.current(), child.id, f.confirmation(child))).rejects.toThrow("synthetic_dependency_execution_response_lost"); lostExecution.mockRestore();
    const committed = await f.business(), paid = vi.spyOn(f.owners.adapter, "execute"), againPrepare = vi.spyOn(f.commands, "prepare");
    const receipt = await f.service().receipt(await f.current(), f.receipt(input)), done = await f.service().get(await f.current(), receipt.id!);
    expect(done.state).toBe("succeeded"); expect(done.child?.agentCommandId).toBe(child.id); expect(done.child?.ownerCommandId).toBe(child.ownerCommandId);
    expect(paid).not.toHaveBeenCalled(); expect(againPrepare).not.toHaveBeenCalled(); expect(await f.business()).toEqual(committed);
  });

  it("dependency_same_key serializes original births and child preparations while rejecting a changed parent due date checksum or caller-invented business field", async () => {
    const basis = await f.basis(), input = f.request(basis.parent), before = await f.business();
    const made = await Promise.all(Array.from({ length: 3 }, () => f.service().create(f.a, input)));
    expect(new Set(made.map(view => view.id)).size).toBe(1); expect((await f.rows()).plans.filter(row => row.requestId === input.requestId)).toHaveLength(1);
    expect(await f.business()).toEqual(before);
    const another = await f.basis();
    for (const changed of [{ ...input, parentAgentCommandId: another.parent.id }, { ...input, dueAt: "2027-01-01T00:00:00.000Z" }])
      await expect(f.service().create(await f.current(), changed)).rejects.toSatisfy(rejectCode("agent_dependency_plan_request_mismatch"));
    await expect(f.service().create(await f.current(), { ...input, amountMinor: 0 })).rejects.toSatisfy((error: unknown) => dependencyErrorStatus(error) === 400);
    await expect(f.service().receipt(await f.current(), { ...f.receipt(input), requestChecksum: "a".repeat(64) })).rejects.toSatisfy(rejectCode("agent_dependency_plan_request_mismatch"));
    await f.completeParent(basis.parent); const ready = await f.service().get(await f.current(), made[0]!.id), inputPrepare = f.prepareInput(ready);
    const originals = await f.business(), prepared = await Promise.all(Array.from({ length: 3 }, () => f.service().prepare(f.a, ready.id, inputPrepare)));
    expect(new Set(prepared.map(value => value.childAgentCommandId)).size).toBe(1); expect(new Set(prepared.map(value => value.childOwnerCommandId)).size).toBe(1);
    const row = (await f.rows()).plans.find(value => value.id === ready.id)!;
    expect((await f.rows()).commands.filter(value => value.requestId === row.childRequestId)).toHaveLength(1); expect(await f.business()).toEqual(originals);
  });

  it("dependency_confirmation_binding refuses predecessor tokens other actors and changed original checksums then preserves one real result under concurrent native confirmation", async () => {
    const { view, basis } = await ready(), originalParent = await f.commands.get(await f.current(), basis.parent.id);
    const prepared = await f.service().prepare(await f.current(), view.id, f.prepareInput(view));
    const child = await f.commands.get(await f.current(), prepared.childAgentCommandId!), body = f.confirmation(child), before = await f.business();
    for (const wrong of [{ ...body, requestId: originalParent.requestId }, { ...body, ownerCommandId: originalParent.ownerCommandId },
      { ...body, originalChecksum: "f".repeat(64) }, { ...body, confirmationToken: body.confirmationToken + "x" }])
      await expect(f.commands.confirm(await f.current(), child.id, wrong)).rejects.toSatisfy((error: unknown) => dependencyErrorStatus(error) === 409);
    await expect(f.commands.confirm(await f.current(f.peer), child.id, body)).rejects.toSatisfy((error: unknown) => dependencyErrorStatus(error) === 404);
    expect(await f.business()).toEqual(before);
    await Promise.all([f.commands.confirm(f.a, child.id, body), f.commands.confirm(f.a, child.id, body), f.owners.finance.execute(f.a, child.ownerCommandId!)]);
    const after = await f.business(); expect(after.tables.finance_payable_bills!.count).toBe(before.tables.finance_payable_bills!.count + 1);
    expect(after.tables.finance_original_write_proofs!.count).toBe(before.tables.finance_original_write_proofs!.count + 1);
    expect((await f.service().get(await f.current(), view.id)).state).toBe("succeeded");
    const acknowledged = await f.commands.acknowledge(await f.current(), child.id, { version: AGENT_COMMAND_VERSION, requestId: child.requestId, ownerCommandId: child.ownerCommandId! });
    expect(acknowledged.snapshot?.native.view.acknowledged).toBe(true); expect(acknowledged.snapshot?.original).toBeNull(); expect(await f.business()).toEqual(after);
    const short = f.owners.service(1), { view: other } = await ready(), pending = await f.service().prepare(await f.current(), other.id, f.prepareInput(other));
    const old = await short.get(await f.current(), pending.childAgentCommandId!), confirmation = f.confirmation(old), timeout = Date.now() + 5_000;
    while ((await f.invoices.clock()).getTime() <= Date.parse(old.confirmationExpiresAt!)) {
      if (Date.now() >= timeout) throw new Error("dependency_confirmation_real_clock_not_elapsed");
      await new Promise<void>(done => setTimeout(done, 25));
    }
    const unchanged = await f.business();
    await expect(short.confirm(await f.current(), old.id, confirmation)).rejects.toSatisfy((error: unknown) => dependencyErrorCode(error) === "agent_command_confirmation_expired_or_changed");
    expect(await f.business()).toEqual(unchanged);
  });

  it("dependency_authority uses real fixed-token OIDC fresh members tenant isolation and the born scope ceiling while rejecting a late completed source read", async () => {
    const { view } = await ready(), token = await f.token(f.a), before = await f.business();
    const response = await f.http(f.a, "/v1/agent-dependency-plans/requests/" + view.id); expect(response.status).toBe(200);
    expect(AgentDependencyPlanViewSchema.parse(await response.json()).contextAuthority).toBe(dependencyAuthority(await f.current()));
    for (const actor of [f.peer, f.foreign]) {
      const denied = await f.http(actor, "/v1/agent-dependency-plans/requests/" + view.id); expect(denied.status).toBe(404);
      const lookup = await f.http(actor, "/v1/agent-dependency-plans/receipts?" + new URLSearchParams({ requestId: view.requestId, requestChecksum: view.requestChecksum }));
      expect(lookup.status).toBe(200); expect(AgentDependencyPlanReceiptSchema.parse(await lookup.json()).disposition).toBe("not_found");
    }
    const held = f.holdSource(), pending = f.service().get(await f.current(), view.id); const settled = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await held.entered; await f.permissions(f.a, dependencyPermissions.filter(bit => bit !== Permission.ProcurementRead)); held.release();
      const late = await settled; expect(late.value).toBeNull(); expect(dependencyErrorCode(late.error)).toBe("authority_changed");
    } finally { held.clear(); await settled; await f.permissions(f.a, dependencyPermissions); }
    const fresh = await f.service().get(await f.current(), view.id); expect(fresh.state).toBe("ready_to_prepare");
    await f.permissions(f.a, dependencyPermissions.filter(bit => bit !== Permission.WorkflowRead));
    const refused = await f.http(f.a, "/v1/agent-dependency-plans/requests/" + view.id); expect(refused.status).toBe(403); expect(await f.token(f.a)).toBe(token);
    await f.permissions(f.a, dependencyPermissions);
    const basis = await f.basis(), full = await f.current(), bornSelf: TenantContext = TenantContextSchema.parse({ ...full, permissionScopes: { ...full.permissionScopes, [Permission.ProcurementRead]: "self" } });
    const born = await f.service().create(bornSelf, f.request(basis.parent)); await f.completeParent(basis.parent);
    const actual = await f.service().get(await f.current(), born.id), made = await f.service().prepare(await f.current(), born.id, f.prepareInput(actual));
    const rows = await f.rows(), parentRow = rows.plans.find(row => row.id === born.id)!, childRow = rows.commands.find(row => row.id === made.childAgentCommandId)!;
    expect(parentRow.originCeiling.permissionScopes?.[Permission.ProcurementRead]).toBe("self"); expect(childRow.originCeiling.permissionScopes?.[Permission.ProcurementRead]).toBe("self");
    const page = AgentDependencyPlanPageSchema.parse(await f.service().list(await f.current(), { limit: 1 })); expect(page.items.length).toBe(1); expect(page.scope).toBe("personal");
    expect((await f.business()).tables.finance_payable_payments).toEqual(before.tables.finance_payable_payments);
    const foreignRows = await withTenant(database.db, f.foreign, tx => tx.select().from(agentDependencyPlans).where(eq(agentDependencyPlans.id, view.id))); expect(foreignRows).toEqual([]);
  });

  it("dependency_source_changed rejects another checksum and an actual invalid due date without substituting source money currency invoice identity or native key", async () => {
    const { view } = await ready(), before = await f.business(), original = (await f.rows()).plans.find(row => row.id === view.id)!;
    await expect(f.service().prepare(await f.current(), view.id, { ...f.prepareInput(view), sourceChecksum: "b".repeat(64) })).rejects.toSatisfy(rejectCode("agent_dependency_plan_source_changed"));
    expect(await f.business()).toEqual(before); expect(identity((await f.rows()).plans.find(row => row.id === view.id)!)).toEqual(identity(original));
    expect((await f.rows()).plans.find(row => row.id === view.id)?.preparationRequestedAt).toBeNull();
    const after = await f.service().prepare(await f.current(), view.id, f.prepareInput(view));
    expect(after.source?.sourceChecksum).toBe(view.source?.sourceChecksum); expect(after.childDraft).toEqual(view.childDraft);
    const draft = after.childDraft!; expect(draft.command.input.amountMinor).toBe(view.source!.totalMinor); expect(draft.command.input.idempotencyKey).toBe(original.childNativeKey);
    const basis = await f.basis(), input = f.request(basis.parent, "2020-01-01T00:00:00.000Z"), waiting = await f.service().create(await f.current(), input); await f.completeParent(basis.parent);
    const invalid = await f.service().get(await f.current(), waiting.id), saved = await f.business();
    expect(invalid.state).toBe("blocked"); expect(invalid.blockReason).toBe("finance_input_invalid"); expect(invalid.canPrepare).toBe(false); expect(invalid.childDraft).toBeNull();
    await expect(f.service().prepare(await f.current(), invalid.id, { version: AGENT_DEPENDENCY_PLAN_VERSION, requestId: invalid.requestId, sourceChecksum: invalid.source!.sourceChecksum })).rejects.toSatisfy(rejectCode("agent_dependency_plan_finance_input_invalid"));
    expect(await f.business()).toEqual(saved); expect((await f.rows()).plans.find(row => row.id === invalid.id)?.childOwnerCommandId).toBeNull();
  });

  it("dependency_atomic_link rolls back failed native coordination audits and forbids rewritten identities while GET repairs only the already committed original child link", async () => {
    const basis = await f.basis(), input = f.request(basis.parent), originalAudit = f.owners.audit.recordInTransaction.bind(f.owners.audit);
    const failBirth = vi.spyOn(f.owners.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      if (event.action === "agent.dependency_plan.create") throw new Error("synthetic_dependency_birth_audit_failure"); return originalAudit(tx, context, event);
    });
    await expect(f.service().create(await f.current(), input)).rejects.toThrow("synthetic_dependency_birth_audit_failure"); failBirth.mockRestore();
    expect((await f.rows()).plans.filter(row => row.requestId === input.requestId)).toEqual([]);
    const plan = await f.service().create(await f.current(), input); await f.completeParent(basis.parent); const actual = await f.service().get(await f.current(), plan.id);
    const failLink = vi.spyOn(f.owners.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      if (event.action === "agent.dependency_plan.link") throw new Error("synthetic_dependency_link_audit_failure"); return originalAudit(tx, context, event);
    });
    await expect(f.service().prepare(await f.current(), actual.id, f.prepareInput(actual))).rejects.toThrow("synthetic_dependency_link_audit_failure"); failLink.mockRestore();
    const staged = (await f.rows()).plans.find(row => row.id === actual.id)!; expect(staged.preparationTransactionId).not.toBeNull(); expect(staged.childOwnerCommandId).toBeNull();
    const before = await f.business(), prepare = vi.spyOn(f.commands, "prepare"), execute = vi.spyOn(f.owners.adapter, "execute");
    const receipt = await f.service().receipt(await f.current(), f.receipt(input)), recovered = await f.service().get(await f.current(), receipt.id!);
    expect(recovered.state).toBe("child_prepared"); expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(await f.business()).toEqual(before);
    const saved = (await f.rows()).plans.find(row => row.id === actual.id)!; expect(saved.linkTransactionId).not.toBeNull(); expect(identity(saved)).toEqual(identity(staged));
    for (const mutation of [{ childRequestId: randomUUID() }, { requestChecksum: "c".repeat(64) }, { childOwnerCommandId: basis.parent.ownerCommandId }])
      await expect(withTenant(database.db, f.a, async tx => { await tx.execute(sql`set constraints all immediate`); await tx.update(agentDependencyPlans).set(mutation).where(eq(agentDependencyPlans.id, saved.id)); })).rejects.toSatisfy((error: unknown) => dependencyErrorCode(error) === "23514");
    // The ordinary role has no DELETE grant; this rejects before the history trigger.
    await expect(withTenant(database.db, f.a, tx => tx.delete(agentDependencyPlans).where(eq(agentDependencyPlans.id, saved.id)))).rejects.toSatisfy((error: unknown) => dependencyErrorCode(error) === "42501");
    expect(canonicalJson(identity((await f.rows()).plans.find(row => row.id === saved.id)!))).toBe(canonicalJson(identity(saved)));
    const evidence = (await f.rows()).audits.filter(row => row.entity_id === saved.id);
    expect(evidence.filter(row => row.action === "agent.dependency_plan.create")).toHaveLength(1); expect(evidence.filter(row => row.action === "agent.dependency_plan.prepare")).toHaveLength(1); expect(evidence.filter(row => row.action === "agent.dependency_plan.link")).toHaveLength(1);
    const cancelled = await f.service().cancel(await f.current(), saved.id, cancelInput(recovered)); expect(cancelled.state).toBe("cancelled");
    expect((await f.commands.get(await f.current(), recovered.childAgentCommandId!)).state).toBe("prepared"); expect(await f.business()).toEqual(before);
  });
});
