import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION, AgentCommandOriginalSchema, AgentCommandViewSchema, canonicalAgentCommandOriginal } from "@yummyai/contracts/ai/agent-command";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { agentCommandRequests, connectDatabase, withTenant, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentCommandFixture, agentCommandSha, commandPermissions, requireAgentCommandEnvironment } from "./agent-command.test-fixture.js";

const isolated = requireAgentCommandEnvironment(), database = connectDatabase(isolated.url), f = agentCommandFixture(database);
const pg = (error: unknown): { code?: string; message?: string } => {
  if (!error || typeof error !== "object") return {};
  const row = error as { code?: string; message?: string; cause?: unknown }; return row.cause ? pg(row.cause) : row;
};
const scalarStatus = (error: unknown) => error && typeof error === "object" ? (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode : undefined;
const withoutCoordination = (state: Awaited<ReturnType<typeof f.state>>) => Object.fromEntries(Object.entries(state)
  .filter(([name]) => !["agent_command_requests", "audit_events"].includes(name)));
const businessOnly = (state: Awaited<ReturnType<typeof f.state>>) => Object.fromEntries(Object.entries(withoutCoordination(state))
  .filter(([name]) => !["inventory_procurement_commands", "finance_commands", "inventory_incoming_commands", "production_command_intents", "advertising_commands"].includes(name)));

describe.sequential("Agent coordination delegates exact human-confirmed originals to native business owners", () => {
  beforeAll(() => f.initialize());
  afterEach(async () => {
    vi.restoreAllMocks(); await f.restore();
    const rows = await withTenant(database.db, f.context, tx => tx.select().from(agentCommandRequests));
    for (const row of rows) {
      if (row.ownerId !== f.context.userId) continue;
      const view = await f.service().get(f.context, row.id);
      if (!view.ownerCommandId) continue;
      const input = { version: AGENT_COMMAND_VERSION, requestId: view.requestId, ownerCommandId: view.ownerCommandId };
      if (view.canCancel) await f.service().cancel(f.context, view.id, input);
      const current = await f.service().get(f.context, view.id);
      if (current.snapshot && current.snapshot.native.view.status !== "prepared" && !current.snapshot.native.view.acknowledged)
        await f.service().acknowledge(f.context, view.id, input);
    }
  });
  afterAll(async () => { await database.client.end(); });

  it("lists37 real owner capabilities without opening autonomous model writes or inventing a private command body table", async () => {
    const before = await f.state(), workspace = await f.service().workspace(f.context);
    expect(workspace.capabilities).toHaveLength(37);
    expect(new Set(workspace.capabilities.map(row => row.domain + ":" + row.kind)).size).toBe(37);
    expect(workspace).toMatchObject({ autonomousModelWrites: false, mcpState: "not_connected", readLoopVersion: "erp-agent-loop-v1", recentLimit: 20 });
    expect(workspace.capabilities.every(row => row.execution === "exact_operator_confirmation")).toBe(true);
    expect(await f.state()).toEqual(before);
    try {
      await f.grant(f.context, commandPermissions.filter(bit => bit !== Permission.WorkflowRun));
      const readonly = await f.service().workspace(await f.current());
      expect(readonly.capabilities).toHaveLength(37);
      expect(readonly.capabilities.every(row => row.available === false && row.blockReason === "workflow_run_required")).toBe(true);
    } finally { await f.restore(); }
    const columns = await database.client.unsafe("select column_name from information_schema.columns where table_schema='public' and table_name='agent_command_requests' order by column_name");
    expect(columns.some(row => /encrypted|prompt|body|secret|token/.test(String(row.column_name)))).toBe(false);
  });

  it("prepares and explicitly confirms same-person procurement and finance once with the actual immutable owner proof", async () => {
    for (const original of [await f.procurementOriginal(), f.billOriginal()]) {
      const before = businessOnly(await f.state()), input = f.prepare(original), prepared = AgentCommandViewSchema.parse(await f.service().prepare(f.context, input));
      expect(prepared).toMatchObject({ state: "prepared", canConfirm: true, domain: original.domain });
      expect(prepared.snapshot?.original).toEqual(original); expect(businessOnly(await f.state())).toEqual(before);
      const confirmation = f.confirmation(prepared), done = await f.service().confirm(f.context, prepared.id, confirmation);
      expect(done).toMatchObject({ id: prepared.id, ownerCommandId: prepared.ownerCommandId, state: "succeeded", canConfirm: false });
      const actual = await f.state(); expect(actual.ai_budget_ledger).toEqual(before.ai_budget_ledger);
      expect(await f.service().confirm(f.context, done.id, confirmation)).toMatchObject({ id: done.id, state: "succeeded" });
      expect(await f.state()).toEqual(actual);
      if (done.snapshot?.native.domain === "finance") {
        const result = await f.finance.recordedResult(f.context, done.ownerCommandId!);
        expect(result.commandId).toBe(done.ownerCommandId);
        const proof = await withTenant(database.db, f.context, tx => tx.execute<{ count: number }>(sql`
          select count(*)::int as count from finance_original_write_proofs where command_id=${done.ownerCommandId}::uuid`));
        expect(proof[0]?.count).toBe(1);
      } else {
        expect(done.snapshot?.native.view.status).toBe("succeeded");
        expect((await f.state()).inventory_procurement_requisitions.count).toBe(before.inventory_procurement_requisitions.count + 1);
      }
    }
  });

  it("recovers a preparation committed before response loss through GET and exact metadata location without re-preparing or executing", async () => {
    const body = f.prepare(await f.procurementOriginal()), real = f.adapter.prepare.bind(f.adapter);
    const failed = vi.spyOn(f.adapter, "prepare").mockImplementationOnce(async (context, original) => { await real(context, original); throw new Error("synthetic_lost_prepare_response"); });
    await expect(f.service().prepare(f.context, body)).rejects.toThrow("synthetic_lost_prepare_response"); failed.mockRestore();
    const before = withoutCoordination(await f.state()), prepare = vi.spyOn(f.adapter, "prepare"), execute = vi.spyOn(f.adapter, "execute");
    const receipt = await f.service().receipt(f.context, f.receipt("prepare", body));
    expect(receipt).toMatchObject({ disposition: "known", privateAvailable: false }); expect(receipt.ownerCommandId).not.toBeNull();
    expect(await f.service().get(f.context, receipt.id!)).toMatchObject({ state: "prepared", ownerCommandId: receipt.ownerCommandId });
    expect(withoutCoordination(await f.state())).toEqual(before); expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    const missing = await f.service().receipt(f.context, { requestId: randomUUID(), requestChecksum: "a".repeat(64) });
    expect(missing).toMatchObject({ disposition: "not_found", id: null, ownerCommandId: null });
  });

  it("recovers the actual committed finance execution after a lost response using only original GETs and a reconstructed coordinator", async () => {
    const body = f.prepare(f.billOriginal()), prepared = await f.service().prepare(f.context, body), actual = f.adapter.execute.bind(f.adapter);
    const lost = vi.spyOn(f.adapter, "execute").mockImplementationOnce(async (context, reference) => { await actual(context, reference); throw new Error("synthetic_lost_execute_response"); });
    await expect(f.service().confirm(f.context, prepared.id, f.confirmation(prepared))).rejects.toThrow("synthetic_lost_execute_response"); lost.mockRestore();
    const before = await f.state(), execute = vi.spyOn(f.adapter, "execute"), recovered = await f.service().receipt(f.context, f.receipt("prepare", body));
    const result = await f.service().get(f.context, recovered.id!);
    expect(result).toMatchObject({ state: "succeeded", ownerCommandId: prepared.ownerCommandId });
    expect(result.snapshot?.native.domain).toBe("finance"); expect(execute).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before);
  });

  it("binds specific confirmation tokens to actor request original checksum and real short server expiry without changing the native seven-day input", async () => {
    const service = f.service(1), prepared = await service.prepare(f.context, f.prepare(await f.procurementOriginal())), input = f.confirmation(prepared), before = await f.state();
    for (const invalid of [{ ...input, requestId: randomUUID() }, { ...input, ownerCommandId: createEntityId() },
      { ...input, originalChecksum: "b".repeat(64) }, { ...input, confirmationToken: input.confirmationToken + "x" }])
      await expect(service.confirm(f.context, prepared.id, invalid)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.confirm(f.coworker, prepared.id, input)).rejects.toSatisfy((error: unknown) => scalarStatus(error) === 404);
    expect(await f.state()).toEqual(before);
    const deadline = new Date(prepared.confirmationExpiresAt!).getTime();
    const timeout = Date.now() + 5_000;
    while (true) {
      const [clock] = await database.client.unsafe("select floor(extract(epoch from clock_timestamp())*1000)::text as ms");
      if (Number(clock?.ms) > deadline) break;
      if (Date.now() > timeout) throw new Error("Real confirmation deadline did not advance within the bounded gate");
      await new Promise(done => setTimeout(done, 50));
    }
    await expect(service.confirm(f.context, prepared.id, input)).rejects.toMatchObject({ status: 409, response: { code: "agent_command_confirmation_expired_or_changed" } });
    expect(await f.state()).toEqual(before);
    expect(new Date(prepared.snapshot!.native.view.expiresAt).getTime() - new Date(prepared.snapshot!.native.view.createdAt).getTime()).toBeGreaterThan(6 * 86_400_000);
  });

  it("serializes concurrent original confirmations and a direct native execute into one real business result", async () => {
    const prepared = await f.service().prepare(f.context, f.prepare(await f.procurementOriginal())), confirmation = f.confirmation(prepared);
    const results = await Promise.all([f.service().confirm(f.context, prepared.id, confirmation), f.service().confirm(f.context, prepared.id, confirmation),
      f.procurement.execute(f.context, prepared.ownerCommandId!)]);
    expect(results.map(row => "state" in row ? row.state : row.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    const native = await f.procurement.get(f.context, prepared.ownerCommandId!);
    expect(native.result?.id).toBe((results[2] as typeof native).result?.id);
    const rows = await withTenant(database.db, f.context, tx => tx.execute<{ count: number }>(sql`
      select count(*)::int as count from inventory_procurement_requisitions where id=${native.result!.id}::uuid`));
    expect(rows[0]?.count).toBe(1);
    expect((await withTenant(database.db, f.context, tx => tx.select().from(agentCommandRequests).where(eq(agentCommandRequests.id, prepared.id))))).toHaveLength(1);
  });

  it("keeps a prepared purchase pinned when an actual newer supplier quote invalidates its basis and never substitutes today's body", async () => {
    const b = await f.source.quoted(f.context), original = { domain: "procurement" as const,
      command: { kind: "purchase_create" as const, targetId: null, input: b.quotedPurchaseInput } };
    const prepared = await f.service().prepare(f.context, f.prepare(original)), confirmation = f.confirmation(prepared);
    await f.procurementOwner.recordSupplierQuote(f.context, b.rfq.id, { ...b.quoteInput,
      lines: b.quoteInput.lines.map(row => ({ ...row, unitCostMinor: 456 })), idempotencyKey: randomUUID() });
    const before = await f.state(), read = await f.service().get(f.context, prepared.id);
    expect(read).toMatchObject({ state: "prepared", canConfirm: false }); expect(read.snapshot?.original).toEqual(original);
    await expect(f.service().confirm(f.context, prepared.id, confirmation)).rejects.toMatchObject({ status: 409 });
    expect(await f.state()).toEqual(before);
  });

  it("rechecks original ceilings and current membership without leaking another actor's request or letting a new grant expand a failed preparation", async () => {
    const body = f.prepare(await f.procurementOriginal());
    await f.grant(f.context, commandPermissions.filter(bit => bit !== Permission.ProcurementWrite));
    const narrow = await f.current(); await expect(f.service().prepare(narrow, body)).rejects.toSatisfy((error: unknown) => scalarStatus(error) === 403);
    const receipt = await f.service().receipt(narrow, f.receipt("prepare", body)); expect(receipt.disposition).toBe("known");
    await f.restore(); const before = await f.state();
    await expect(f.service().prepare(f.context, body)).rejects.toSatisfy((error: unknown) => scalarStatus(error) === 403);
    expect(businessOnly(await f.state())).toEqual(businessOnly(before));
    expect(await f.service().receipt(f.coworker, f.receipt("prepare", body))).toMatchObject({ disposition: "not_found", id: null });
    expect(await f.service().receipt(f.outsider, f.receipt("prepare", body))).toMatchObject({ disposition: "not_found", id: null });
    await expect(f.service().prepare(f.context, { ...body, original: await f.procurementOriginal() })).rejects.toMatchObject({ status: 409 });
  });

  it("uses actual incoming and advertising adapters and preserves the real production source and permission gates", async () => {
    for (const original of [await f.incomingOriginal(), await f.advertisingOriginal()]) {
      const prepared = await f.service().prepare(f.context, f.prepare(original));
      const done = await f.service().confirm(f.context, prepared.id, f.confirmation(prepared));
      expect(done).toMatchObject({ domain: original.domain, state: "succeeded", ownerCommandId: prepared.ownerCommandId });
      expect(done.snapshot?.native.view.status).toBe("succeeded");
    }
    // This is an actual native production refusal, not an approved-design fixture.
    // No artwork, supplier acceptance, production file or production approval is manufactured.
    const lineId = createEntityId(), original = { domain: "production" as const, command: { kind: "approved_design" as const, targetId: createEntityId(),
      input: { orderLineId: lineId, factoryId: createEntityId(), factoryVersionId: createEntityId(), capabilityVersionId: createEntityId(),
        routingDecisionId: createEntityId(), purchaseOrderVersionId: createEntityId(), expectedCompletionAt: "2027-01-01T00:00:00.000Z",
        instructions: "Synthetic nonexistent source must not be admitted", idempotencyKey: randomUUID() } } };
    const before = businessOnly(await f.state());
    await expect(f.adapter.prepare(f.context, AgentCommandOriginalSchema.parse(original))).rejects.toSatisfy((error: unknown) => [404, 409, 422].includes(scalarStatus(error) ?? 0));
    expect(businessOnly(await f.state())).toEqual(before);
  });

  it("rolls preparation and confirmation audits back before any native business dispatch and retains a committed confirmation if the later owner audit fails", async () => {
    const original = await f.procurementOriginal(), record = f.audit.recordInTransaction.bind(f.audit), before = await f.state();
    const failCreate = vi.spyOn(f.audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === "agent.command.create") throw new Error("synthetic_create_audit_failure"); return record(tx, actor, event);
    });
    await expect(f.service().prepare(f.context, f.prepare(original))).rejects.toThrow("synthetic_create_audit_failure"); failCreate.mockRestore();
    expect(await f.state()).toEqual(before);
    const prepared = await f.service().prepare(f.context, f.prepare(original)), pending = await f.state();
    const failConfirm = vi.spyOn(f.audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === "agent.command.confirm") throw new Error("synthetic_confirm_audit_failure"); return record(tx, actor, event);
    });
    await expect(f.service().confirm(f.context, prepared.id, f.confirmation(prepared))).rejects.toThrow("synthetic_confirm_audit_failure"); failConfirm.mockRestore();
    expect(await f.state()).toEqual(pending);
    const failOwner = vi.spyOn(f.audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === "procurement.command.execute") throw new Error("synthetic_owner_outcome_failure"); return record(tx, actor, event);
    });
    await expect(f.service().confirm(f.context, prepared.id, f.confirmation(prepared))).rejects.toThrow("synthetic_owner_outcome_failure"); failOwner.mockRestore();
    expect(businessOnly(await f.state())).toEqual(businessOnly(pending));
    const [row] = await withTenant(database.db, f.context, tx => tx.select().from(agentCommandRequests).where(eq(agentCommandRequests.id, prepared.id)));
    expect(row?.confirmedAt).toBeInstanceOf(Date); expect(row?.confirmationTransactionId).not.toBeNull();
  });

  it("requires actual actor full-transaction audits and immutable binding even after an early constraint flush", async () => {
    const original = await f.procurementOriginal(), binding = f.adapter.binding(original), before = await f.state();
    const values = () => ({ id: createEntityId(), tenantId: f.context.tenantId, ownerId: f.context.userId, requestId: randomUUID(), operation: "prepare" as const,
      requestChecksum: agentCommandSha(canonicalJson({ synthetic: true })), originalChecksum: agentCommandSha(canonicalAgentCommandOriginal(original)),
      binding, originCeiling: f.context, expiresAt: new Date(Date.now() + 7 * 86_400_000) });
    await expect(withTenant(database.db, f.context, async tx => {
      const input = values(), [actual] = await tx.insert(agentCommandRequests).values(input).returning();
      await f.audit.recordInTransaction(tx, f.context, { action: "agent.command.create", resourceType: "agent_command_request", resourceId: input.id,
        result: "success", metadata: { requestChecksum: input.requestChecksum, originalChecksum: input.originalChecksum, ownerCommandId: null } });
      await tx.execute(sql`set constraints all immediate`);
      expect(actual?.creationTransactionId).not.toBeNull();
      throw new Error("synthetic_legitimate_control_rollback");
    })).rejects.toThrow("synthetic_legitimate_control_rollback");
    expect(await f.state()).toEqual(before);
    for (const early of [false, true]) await expect(withTenant(database.db, f.context, async tx => {
      if (early) await tx.execute(sql`set constraints all immediate`);
      await tx.insert(agentCommandRequests).values(values());
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514");
    const prepared = await f.service().prepare(f.context, f.prepare(original)), stable = await f.state();
    for (const early of [false, true]) await expect(withTenant(database.db, f.context, async tx => {
      if (early) await tx.execute(sql`set constraints all immediate`);
      await tx.update(agentCommandRequests).set({ confirmedAt: new Date(), confirmationChecksum: "a".repeat(64) }).where(eq(agentCommandRequests.id, prepared.id));
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514");
    for (const change of [{ requestChecksum: "b".repeat(64) }, { ownerId: f.coworker.userId }, { binding: { ...binding, requestKeyHash: "b".repeat(64) } }])
      await expect(withTenant(database.db, f.context, tx => tx.update(agentCommandRequests).set(change).where(eq(agentCommandRequests.id, prepared.id))))
        .rejects.toSatisfy((error: unknown) => ["23514", "42501"].includes(pg(error).code ?? ""));
    await expect(withTenant(database.db, f.context, tx => f.audit.recordInTransaction(tx, f.context, { action: "agent.command.confirm",
      resourceType: "agent_command_request", resourceId: createEntityId(), result: "success", metadata: { requestChecksum: "a".repeat(64), originalChecksum: "b".repeat(64), ownerCommandId: createEntityId() } })))
      .rejects.toSatisfy((error: unknown) => pg(error).code === "23514");
    expect(await f.state()).toEqual(stable); expect(businessOnly(stable)).toEqual(businessOnly(before));
  });

  it("adopts the original Review command without a JSON copy and separates cancellation and acknowledgement from actual business effects", async () => {
    const source = await f.procurementOriginal(), native = await f.adapter.prepare(f.context, source), before = businessOnly(await f.state());
    const input = { version: AGENT_COMMAND_VERSION, requestId: randomUUID(), reference: native.reference };
    const adopted = await f.service().adopt(f.context, input);
    expect(adopted).toMatchObject({ ownerCommandId: native.reference.commandId, state: "prepared", canConfirm: true });
    expect(adopted.snapshot?.original).toEqual(source); expect(businessOnly(await f.state())).toEqual(before);
    const action = { version: AGENT_COMMAND_VERSION, requestId: adopted.requestId, ownerCommandId: adopted.ownerCommandId };
    expect(await f.service().cancel(f.context, adopted.id, action)).toMatchObject({ state: "cancelled", canConfirm: false });
    expect(await f.service().acknowledge(f.context, adopted.id, action)).toMatchObject({ state: "cancelled" });
    expect(businessOnly(await f.state())).toEqual(before);
    expect(await f.service().receipt(f.context, f.receipt("adopt", input))).toMatchObject({ id: adopted.id, ownerCommandId: adopted.ownerCommandId, disposition: "known" });
    expect(await f.service().adopt(f.context, input)).toMatchObject({ id: adopted.id, state: "cancelled", canConfirm: false });
  });

  it("pins native membership permissions scopes and teams at raw coordination birth instead of accepting caller-invented future authority", async () => {
    const original = await f.procurementOriginal(), body = f.prepare(original), binding = f.adapter.binding(original);
    const birth = async (tx: TenantTransaction, ceiling: unknown, fixedBinding: unknown = binding, audit = false) => {
      const id = createEntityId();
      await tx.execute(sql`insert into agent_command_requests(id,tenant_id,owner_id,request_id,request_checksum,operation,original_checksum,binding,origin_ceiling,expires_at)
        values(${id}::uuid,${f.context.tenantId}::uuid,${f.context.userId}::uuid,${body.requestId}::uuid,${f.receipt("prepare", body).requestChecksum},'prepare',
        ${agentCommandSha(canonicalAgentCommandOriginal(original))},${canonicalJson(fixedBinding)}::jsonb,${canonicalJson(ceiling)}::jsonb,clock_timestamp()+interval '7 days')`);
      if (audit) await f.audit.recordInTransaction(tx, f.context, { action: "agent.command.create", resourceType: "agent_command_request", resourceId: id,
        result: "success", metadata: { requestChecksum: f.receipt("prepare", body).requestChecksum, originalChecksum: agentCommandSha(canonicalAgentCommandOriginal(original)), ownerCommandId: null } });
    };
    const full = await f.current(), before = await f.state();
    await expect(withTenant(database.db, f.context, async tx => {
      await birth(tx, full, binding, true); await tx.execute(sql`set constraints all immediate`);
      throw new Error("synthetic_valid_membership_birth_control_rollback");
    })).rejects.toThrow("synthetic_valid_membership_birth_control_rollback");
    expect(await f.state()).toEqual(before);
    const minimum = [Permission.WorkflowRead, Permission.WorkflowRun, Permission.ProcurementRead];
    try {
      await f.grant(f.context, minimum, "self");
      const narrow = await f.current(), scopes = narrow.permissionScopes ?? Object.fromEntries(narrow.permissions.map(bit => [bit, "self"]));
      const forged = [
        { ...narrow, permissions: [...narrow.permissions, Permission.FinanceReview], permissionScopes: { ...scopes, [Permission.FinanceReview]: "tenant" } },
        { ...narrow, permissionScopes: { ...scopes, [Permission.ProcurementRead]: "tenant" } },
        { ...narrow, teamIds: [createEntityId()] },
        { ...narrow, permissions: "workflow:read" },
        { ...narrow, permissionScopes: [] },
      ];
      for (const ceiling of forged) await expect(withTenant(database.db, f.context, tx => birth(tx, ceiling, binding, true)))
        .rejects.toSatisfy((error: unknown) => pg(error).code === "23514");
      const noKey = Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "requestKeyHash"));
      await expect(withTenant(database.db, f.context, tx => birth(tx, narrow, noKey, true))).rejects.toSatisfy((error: unknown) => pg(error).code === "23514");
      expect(await f.state()).toEqual(before);
    } finally { await f.restore(); }
  });
});
