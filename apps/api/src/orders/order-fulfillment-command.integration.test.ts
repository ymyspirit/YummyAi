import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema } from "@yummyai/contracts";
import { FulfillmentCommandKindSchema, FulfillmentCommandViewSchema, PrepareFulfillmentCommandSchema,
  fulfillmentCommandCanonicalJson, type FulfillmentCommandView } from "@yummyai/contracts/order/fulfillment-command";
import { connectDatabase, migrateDatabase, orderFulfillmentCommandIntents, productionEditorProjects, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireFulfillmentCommandEnvironment } from "../../../../tools/testing/require-fulfillment-command-environment.mjs";
import { orderFulfillmentCommandFixture, fulfillmentCommandBounded } from "./order-fulfillment-command.test-fixture.js";

const isolated = requireFulfillmentCommandEnvironment(), database = connectDatabase(isolated.url), f = orderFulfillmentCommandFixture(database);
const proof: { scope: string; nonce: string; cases: Array<Record<string, unknown>>; cleanupFailed: boolean; databaseClosed: boolean } = {
  scope: "Actual disposable non-owner RLS, original owners and original immutable receipts; synthetic identities, initial work and physical attestations; no physical factory or provider execution",
  nonce: isolated.nonce, cases: [], cleanupFailed: false, databaseClosed: false,
};
function status(error: unknown): number | null {
  if (error instanceof HttpException) return error.getStatus();
  return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
}
function stateCode(error: unknown): string | null {
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    if ("code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
    error = "cause" in error ? error.cause : undefined;
  }
  return null;
}
async function denied(operation: Promise<unknown>, expected: number) {
  const actual = await operation.then(() => null, error => status(error)); expect(actual).toBe(expected);
}
function privateFree(view: FulfillmentCommandView) {
  const text = JSON.stringify(view);
  expect(text).not.toContain("SYNTHETIC_PRIVATE_FULFILLMENT");
  for (const field of ["encryptedInput", "authoritySnapshot", "leaseToken", "productionAssetIds", "evidenceReference", "command", "input"])
    expect(Object.hasOwn(view, field)).toBe(false);
}
async function exactRead(view: FulfillmentCommandView) {
  const current = await f.current(), before = await f.business(), audits = await f.auditState(), attempts = f.calls.execute;
  const read = await f.service().get(current, view.id), list = await f.service().list(current, {
    orderId: view.orderId, requestId: view.requestId, requestChecksum: view.requestChecksum,
  });
  expect(read.receipt).toEqual(view.receipt); expect(read.id).toBe(view.id);
  expect(list.items).toHaveLength(1); expect(list.items[0]!.receipt).toEqual(view.receipt);
  expect(f.calls.execute).toBe(attempts); expect(await f.business()).toEqual(before); expect(await f.auditState()).toEqual(audits);
  privateFree(read); return read;
}

describe.sequential("same-order original fulfillment command recovery", () => {
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 120_000);
  afterEach(async () => { await f.settle(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { proof.cleanupFailed = true; failures.push(error); }
    try { await database.client.end(); proof.databaseClosed = true; } catch (error) { proof.cleanupFailed = true; failures.push(error); }
    await mkdir(isolated.lane, { recursive: true });
    await writeFile(join(isolated.lane, `${isolated.nonce}-current-proof.json`), JSON.stringify({ ...proof, calls: f.calls,
      carrierCalls: f.owners.carrier.calls, shipmentEnqueues: f.owners.shipmentEnqueues.length,
      logisticsEnqueues: f.owners.logisticsEnqueues.length, modelCalls: 0, workerProcesses: 0 }, null, 2) + "\n", { flag: "wx" });
    if (failures.length) throw new AggregateError(failures, "fulfillment_command_actual_cleanup_failed");
  });

  it.each(FulfillmentCommandKindSchema.options)("original_owner_receipt_%s", async kind => {
    const prepared = await f.command(kind), before = await f.business(), count = f.calls.execute;
    const waiting = await f.service().prepare(await f.current(), prepared.command);
    expect(waiting.status).toBe("prepared"); expect(waiting.receipt).toBeNull(); expect(await f.business()).toEqual(before);
    expect(waiting.requestChecksum).toBe(createHash("sha256").update(fulfillmentCommandCanonicalJson(prepared.command)).digest("hex"));
    // Lose only the adapter's in-memory return after the actual owner committed.
    // The service must locate its real rows, never invent a saved journal result.
    f.hooks.afterExecute = async () => { f.hooks.afterExecute = undefined; throw new Error("synthetic_original_owner_return_lost"); };
    const completed = await f.execute(await f.current(), waiting.id);
    expect(completed.status).toBe("succeeded"); expect(completed.receipt?.kind).toBe(kind); expect(f.calls.execute - count).toBe(1);
    expect(await f.business()).not.toEqual(before); privateFree(completed);
    const journal = await f.intent(waiting.id); expect(journal?.status).toBe("uncertain");
    expect(journal?.encryptedInputPresent).toBe(true); expect(journal?.leasePresent).toBe(false);
    const read = await exactRead(completed);
    const repeated = await f.service().prepare(await f.current(), prepared.command);
    expect(repeated.id).toBe(waiting.id); expect(repeated.receipt).toEqual(read.receipt); expect(f.calls.execute - count).toBe(1);
    const acknowledged = await f.service().acknowledge(await f.current(), waiting.id);
    expect(acknowledged).toMatchObject({ status: "acknowledged", acknowledged: true, summary: null, receipt: null, canExecute: false });
    expect(await f.intent(waiting.id)).toMatchObject({ encryptedInputPresent: false, acknowledged: true, redacted: true });
    proof.cases.push({ name: `original_owner_receipt_${kind}`, requestId: waiting.requestId, intentId: waiting.id, kind,
      receipt: completed.receipt, originalOwnerAttempts: 1, readOnlyRecovery: true, journalStoresSuccess: false, acknowledgedBodyCleared: true });
  });

  it("http_commit_disconnect_restores_original_receipt_using_only_fixed_token_GETs", async () => {
    const { command } = await f.command("production_milestone"), bearer = await f.token();
    const prepared = await f.http(f.a, "", command); expect(prepared.status).toBe(201);
    const waiting = FulfillmentCommandViewSchema.parse(await prepared.json()), beforeAttempts = f.calls.execute;
    f.loseExecuteResponse(waiting.id);
    expect(await f.http(f.a, `/${waiting.id}/execute`, {}).then(() => "unexpected_response", () => "actual_connection_lost")).toBe("actual_connection_lost");
    const committed = await f.business(), audits = await f.auditState();
    const exact = new URLSearchParams({ orderId: waiting.orderId, requestId: waiting.requestId, requestChecksum: waiting.requestChecksum });
    for (const suffix of [`/${waiting.id}`, `?${exact}`]) {
      const response = await f.http(f.a, suffix); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      const raw: unknown = await response.json(), view = suffix.startsWith("?")
        ? (await f.service().list(await f.current(), { orderId: waiting.orderId, requestId: waiting.requestId, requestChecksum: waiting.requestChecksum })).items[0]!
        : FulfillmentCommandViewSchema.parse(raw);
      if (suffix.startsWith("?")) expect(raw).toEqual({ items: [view], truncated: false });
      expect(view.status).toBe("succeeded"); expect(view.receipt?.kind).toBe("production_milestone"); privateFree(view);
    }
    expect(await f.token()).toBe(bearer); expect(f.calls.execute - beforeAttempts).toBe(1); expect(f.calls.lostExecuteResponses).toBe(1);
    expect(await f.business()).toEqual(committed); expect(await f.auditState()).toEqual(audits);
    const invalid = await f.http(f.a, "?" + new URLSearchParams({ orderId: waiting.orderId, requestId: waiting.requestId })); expect(invalid.status).toBe(400);
    proof.cases.push({ name: "http_commit_disconnect", intentId: waiting.id, originalExecutionPOSTs: 1, responseDestroyedAfterActualOwner: true, fixedToken: true, recoveryGETOnly: true });
  });

  it("before_owner_disconnect_GET_never_executes_or_manufactures_a_receipt", async () => {
    const { command } = await f.command("production_milestone"), before = await f.business(), complete = f.calls.ownerCompleted;
    const waiting = await f.service().prepare(await f.current(), command);
    f.hooks.beforeExecute = async () => { f.hooks.beforeExecute = undefined; throw new Error("synthetic_transport_lost_before_owner"); };
    const unknown = await f.execute(await f.current(), waiting.id);
    expect(unknown).toMatchObject({ status: "uncertain", receipt: null, errorCode: "unknown" });
    const attempts = f.calls.execute;
    for (let index = 0; index < 3; index++) expect(await f.service().get(await f.current(), waiting.id)).toMatchObject({ status: "uncertain", receipt: null });
    expect(f.calls.ownerCompleted).toBe(complete); expect(f.calls.execute).toBe(attempts); expect(await f.business()).toEqual(before);
    proof.cases.push({ name: "before_owner_disconnect", intentId: waiting.id, ownerCompletions: 0, readOnlyAttempts: 3, businessUnchanged: true });
  });

  it("original_request_identity_body_actor_and_version_are_never_rebound", async () => {
    const { command, scene } = await f.command("production_milestone");
    if (command.kind !== "production_milestone") throw new Error("Synthetic original milestone command required");
    const waiting = await f.service().prepare(await f.current(), command), before = await f.intent(waiting.id), business = await f.business();
    const changed = PrepareFulfillmentCommandSchema.parse({ ...command, input: { ...command.input, evidence: { ...command.input.evidence, note: "Different original note" } } });
    await denied(f.service().prepare(await f.current(), changed), 409);
    await denied(f.service().prepare(await f.current(), { ...command, requestId: randomUUID() }), 409);
    await denied(f.service().prepare(await f.current(f.peer), command), 409);
    await denied(f.service().get(await f.current(f.peer), waiting.id), 404);
    await denied(f.service().get(await f.current(f.foreign), waiting.id), 404);
    const rejected = await f.service().list(await f.current(), { orderId: scene.order.id, requestId: waiting.requestId, requestChecksum: "0".repeat(64) });
    expect(rejected.items).toEqual([]); expect(await f.intent(waiting.id)).toEqual(before); expect(await f.business()).toEqual(business);
    // A genuine intervening owner event changes the target projection. The old
    // body remains fixed and is rejected rather than patched to the new version.
    await f.owners.production.recordMilestone(await f.current(), command.targetId, { ...command.input, externalEventId: randomUUID() });
    const current = await f.business(), result = await f.execute(await f.current(), waiting.id);
    expect(result).toMatchObject({ status: "rejected", receipt: null, errorCode: "conflict" }); expect(await f.business()).toEqual(current);
    expect((await f.intent(waiting.id))?.requestChecksum).toBe(waiting.requestChecksum);
    proof.cases.push({ name: "original_identity_body_actor_version", intentId: waiting.id, originalChecksum: waiting.requestChecksum, staleRejected: true });
  });

  it("concurrent_original_HTTP_prepare_execute_and_resource_overlap_keep_one_owner_fact", async () => {
    const { command } = await f.command("production_milestone"), before = f.calls.execute;
    const responses = await Promise.all([f.http(f.a, "", command), f.http(f.a, "", command)]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    const [first, second] = await Promise.all(responses.map(async response => FulfillmentCommandViewSchema.parse(await response.json())));
    expect(first!.id).toBe(second!.id);
    const overlap = { ...command, requestId: randomUUID(), input: { ...command.input, externalEventId: randomUUID() } };
    await denied(f.service().prepare(await f.current(), overlap), 409);
    const results = await Promise.all([f.http(f.a, `/${first!.id}/execute`, {}), f.http(f.a, `/${first!.id}/execute`, {})]);
    expect(results.filter(response => response.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every(response => response.status === 200 || response.status === 409)).toBe(true);
    const read = await f.service().get(await f.current(), first!.id); expect(read.status).toBe("succeeded");
    expect(f.calls.execute - before).toBe(1); await exactRead(read);
    proof.cases.push({ name: "concurrent_original_HTTP", intentId: first!.id, preparePOSTs: 2, executePOSTs: 2, originalOwnerAttempts: 1 });
  });

  it("current_permissions_and_incoming_birth_ceiling_intersect_without_expanding_to_a_later_grant", async () => {
    const { command } = await f.command("production_milestone"), minimal = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead];
    const narrow = TenantContextSchema.parse({ ...await f.current(), permissions: minimal,
      permissionScopes: Object.fromEntries(minimal.map(bit => [bit, "tenant"])) });
    const waiting = await f.service().prepare(narrow, command), journal = await f.intent(waiting.id);
    expect([...(journal?.authoritySnapshot.permissions ?? [])].sort()).toEqual([...minimal].sort());
    await denied(f.service().execute(TenantContextSchema.parse({ ...await f.current(), permissions: [Permission.OrderRead, Permission.OrderPiiRead] }), waiting.id), 403);
    const revoked = await f.permissions(f.a, [Permission.OrderRead, Permission.OrderPiiRead]);
    try { await denied(f.execute(f.a, waiting.id), 403); } finally { await revoked.restore(); }
    const completed = await f.execute(await f.current(), waiting.id); expect(completed.status).toBe("succeeded");
    expect([...(await f.intent(waiting.id))!.authoritySnapshot.permissions].sort()).toEqual([...minimal].sort());
    const readOnly = await f.permissions(f.a, [Permission.OrderRead, Permission.OrderPiiRead]);
    try { expect((await f.service().get(f.a, waiting.id)).receipt).toEqual(completed.receipt); } finally { await readOnly.restore(); }
    const token = await f.token(); await f.membership(f.a, "disabled");
    try { expect((await f.http(f.a, `/${waiting.id}`)).status).toBe(403); expect(await f.token()).toBe(token); }
    finally { await f.membership(f.a, "active"); }
    await exactRead(completed);
    proof.cases.push({ name: "current_birth_and_fixed_token", intentId: waiting.id, originalPermissionCount: minimal.length, laterGrantDidNotRewriteBirth: true });
  });

  it.each([Permission.DesignRead, Permission.AssetRead] as const)("late_%s_withdrawal_hides_original_delivery_and_never_reexecutes_committed_owner", async bit => {
    const { command } = await f.command("delivery_create"), waiting = await f.service().prepare(await f.current(), command);
    const hold = f.hold("afterExecute"), pending = f.execute(await f.current(), waiting.id), outcome = pending.then(value => ({ view: value, status: null }), error => ({ view: null, status: status(error) }));
    await fulfillmentCommandBounded(hold.entered, "fulfillment_actual_owner_commit_gate_missing");
    const committed = await f.business(), attempts = f.calls.execute, revoked = await f.permissions(f.a, f.allPermissions.filter(permission => permission !== bit));
    try {
      const hidden = await f.service().get(f.a, waiting.id);
      expect(hidden).toMatchObject({ summary: null, receipt: null, canExecute: false, errorCode: "forbidden" }); privateFree(hidden);
      hold.release(); const finished = await outcome; expect(finished.status).toBe(403);
      expect(await f.business()).toEqual(committed); expect(f.calls.execute).toBe(attempts);
    } finally { hold.release(); await revoked.restore(); await outcome; }
    const restored = await f.service().get(await f.current(), waiting.id); expect(restored.status).toBe("succeeded"); await exactRead(restored);
    proof.cases.push({ name: `late_${bit}_withdrawal`, intentId: waiting.id, originalOwnerCommitted: true, hiddenPrivateResult: true, noSecondOwner: true });
  });

  it("forced_RLS_and_SQL_identity_success_guards_cannot_forge_a_business_receipt", async () => {
    const { command } = await f.command("production_milestone"), waiting = await f.service().prepare(await f.current(), command), before = await f.intent(waiting.id);
    expect(await withTenant(database.db, f.foreign, tx => tx.select({ id: orderFulfillmentCommandIntents.id }).from(orderFulfillmentCommandIntents)
      .where(eq(orderFulfillmentCommandIntents.id, waiting.id)))).toEqual([]);
    for (const mutation of [sql`update order_fulfillment_command_intents set request_checksum=${"0".repeat(64)} where id=${waiting.id}::uuid`,
      sql`update order_fulfillment_command_intents set status='succeeded' where id=${waiting.id}::uuid`]) {
      const code = await withTenant(database.db, f.a, tx => tx.execute(mutation)).then(() => null, error => stateCode(error));
      expect(["23514", "42501"]).toContain(code);
    }
    expect(await f.intent(waiting.id)).toEqual(before); expect((await f.service().get(await f.current(), waiting.id)).receipt).toBeNull();
    proof.cases.push({ name: "forced_RLS_SQL_guards", intentId: waiting.id, foreignRows: 0, forgedSuccessRejected: true });
  });

  it("cancellation_blocks_managed_raw_redispatch_and_cannot_erase_an_inflight_commit", async () => {
    const first = await f.command("production_milestone"), waiting = await f.service().prepare(await f.current(), first.command), before = await f.business();
    const cancelled = await f.service().cancel(await f.current(), waiting.id); expect(cancelled.status).toBe("cancelled");
    if (first.command.kind !== "production_milestone") throw new Error("Synthetic exact milestone expected");
    await denied(f.owners.production.recordMilestone(await f.current(), first.command.targetId, first.command.input), 409);
    await denied(f.execute(await f.current(), waiting.id), 409); expect(await f.business()).toEqual(before);
    await f.service().acknowledge(await f.current(), waiting.id);
    const second = await f.command("production_milestone"), active = await f.service().prepare(await f.current(), second.command), gate = f.hold("beforeExecute");
    const pending = f.execute(await f.current(), active.id); await fulfillmentCommandBounded(gate.entered, "fulfillment_actual_claim_missing");
    try { await denied(f.service().cancel(await f.current(), active.id), 409); }
    finally { gate.release(); }
    const completed = await pending; expect(completed.status).toBe("succeeded"); expect((await f.service().cancel(await f.current(), active.id)).receipt).toEqual(completed.receipt);
    await exactRead(completed);
    proof.cases.push({ name: "cancel_and_active_claim", cancelledIntent: waiting.id, committedIntent: active.id, rawRedispatchRejected: true });
  });

  it("real_source_expiry_retires_the_claim_and_rejects_a_late_original_writer", async () => {
    const { command, scene } = await f.command("production_milestone"); await f.shortenSource(scene, 3);
    const waiting = await f.service().prepare(await f.current(), command), before = await f.business(), completedOwners = f.calls.ownerCompleted;
    const gate = f.hold("beforeExecute"), pending = f.execute(await f.current(), waiting.id);
    await fulfillmentCommandBounded(gate.entered, "fulfillment_expiring_claim_gate_missing");
    try {
      await f.waitExpired(waiting.id); const expired = await f.service().get(await f.current(), waiting.id);
      expect(expired).toMatchObject({ status: "expired", summary: null, receipt: null, canExecute: false });
      expect(await f.intent(waiting.id)).toMatchObject({ encryptedInputPresent: false, leasePresent: false, redacted: true });
    } finally { gate.release(); }
    const late = await pending; expect(late.status).toBe("expired"); expect(f.calls.ownerCompleted).toBe(completedOwners);
    expect(await f.business()).toEqual(before);
    proof.cases.push({ name: "real_source_expiry", intentId: waiting.id, actualDatabaseDeadlineObserved: true, lateOwnerRejected: true, leaseCleared: true });
  });

  it("late_specific_editor_key_clear_after_original_locate_cannot_restore_summary_or_receipt", async () => {
    const { command, scene } = await f.command("delivery_create"), waiting = await f.service().prepare(await f.current(), command);
    const committed = await f.execute(await f.current(), waiting.id);
    expect(committed.status).toBe("succeeded"); expect(committed.receipt?.kind).toBe("delivery_create");
    const facts = await f.business(), attempts = f.calls.execute, project = scene.productions[0];
    if (!project) throw new Error("fulfillment_exact_owned_editor_source_missing");
    const gate = f.hold("afterLocate"), pending = f.service().get(await f.current(), waiting.id);
    const outcome = pending.then(view => ({ view, error: null }), error => ({ view: null, error }));
    try {
      await fulfillmentCommandBounded(gate.entered, "fulfillment_actual_original_locate_gate_missing");
      // Only this owned scene's private source is removed. The real immutable
      // delivery facts remain intact; the late reader must enforce source life.
      const removed = await withTenant(database.db, f.a, tx => tx.update(productionEditorProjects).set({ encryptedDataKey: null })
        .where(eq(productionEditorProjects.id, project.projectId)).returning({ id: productionEditorProjects.id }));
      expect(removed).toEqual([{ id: project.projectId }]);
    } finally { gate.release(); }
    const late = await outcome;
    expect(late.error).toBeNull(); expect(late.view).toMatchObject({ status: "expired", summary: null, receipt: null, canExecute: false, errorCode: "source_unavailable" });
    if (!late.view) throw new Error("fulfillment_late_source_result_missing"); privateFree(late.view);
    expect(await f.intent(waiting.id)).toMatchObject({ encryptedInputPresent: false, leasePresent: false, redacted: true });
    const again = await f.service().get(await f.current(), waiting.id), listed = await f.service().list(await f.current(), {
      orderId: waiting.orderId, requestId: waiting.requestId, requestChecksum: waiting.requestChecksum,
    });
    expect(again).toMatchObject({ status: "expired", summary: null, receipt: null }); expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ status: "expired", summary: null, receipt: null });
    expect(f.calls.execute).toBe(attempts); expect(await f.business()).toEqual(facts);
    proof.cases.push({ name: "late_specific_editor_key_clear", intentId: waiting.id, projectId: project.projectId,
      actualOriginalReceiptObservedBeforeMutation: true, privateBodyCleared: true, originalBusinessFactsUnchanged: true, recoveryExecutedOwners: 0 });
  });

  it.each([
    { kind: "delivery_create", action: "production_delivery.create" },
    { kind: "shipment_create", action: "shipment.create" },
    { kind: "shipment_version", action: "shipment.version.append" },
  ] as const)("final_audit_rollback $kind preserves_original_facts_and_GET_does_not_retry", async ({ kind, action }) => {
    const { command } = await f.command(kind), waiting = await f.service().prepare(await f.current(), command), before = await f.business();
    const originalAudits = (await f.auditState()).find(row => row.action === action)?.count ?? 0, failure = f.failNextAudit(action);
    let result: FulfillmentCommandView;
    try { result = await f.execute(await f.current(), waiting.id); } finally { failure.restore(); }
    expect(failure.failed()).toBe(true); expect(result.receipt).toBeNull(); expect(result.status).toBe("uncertain"); expect(await f.business()).toEqual(before);
    const attempts = f.calls.execute; expect((await f.service().get(await f.current(), waiting.id)).receipt).toBeNull(); expect(f.calls.execute).toBe(attempts);
    expect((await f.auditState()).find(row => row.action === action)?.count ?? 0).toBe(originalAudits);
    proof.cases.push({ name: `final_audit_rollback_${kind}`, intentId: waiting.id, businessUnchanged: true, originalSuccessAuditAbsent: true, recoveryReadOnly: true });
  });
});
