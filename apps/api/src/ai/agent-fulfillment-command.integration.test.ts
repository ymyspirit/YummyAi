import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION, AgentCommandConfirmationSchema, PrepareAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { AgentNativeV3DraftSchema } from "@yummyai/contracts/ai/agent-native-v3";
import {
  AGENT_FULFILLMENT_COMMAND_VERSION, AgentFulfillmentCommandViewSchema, AgentFulfillmentCommandListSchema,
  AgentFulfillmentCommandReceiptSchema, AgentFulfillmentCommandWorkspaceSchema, AgentFulfillmentConfirmationSchema,
  PrepareAgentFulfillmentCommandSchema, canonicalAgentFulfillmentOriginal, type AgentFulfillmentCommandView,
} from "@yummyai/contracts/ai/agent-fulfillment-command";
import { FulfillmentCommandKindSchema } from "@yummyai/contracts/order/fulfillment-command";
import { connectDatabase, migrateDatabase, orderFulfillmentCommandIntents, productionEditorProjects, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { agentCommandCapabilities } from "../../../../packages/workflow-core/src/agent-command-catalog.js";
import { requireAgentFulfillmentCommandEnvironment } from "../../../../tools/testing/require-agent-fulfillment-command-environment.mjs";
import { agentFulfillmentCommandFixture, agentFulfillmentBounded, agentFulfillmentHash } from "./agent-fulfillment-command.test-fixture.js";

const isolated = requireAgentFulfillmentCommandEnvironment(), database = connectDatabase(isolated.url), f = agentFulfillmentCommandFixture(database);
const proof = { scope: "new Agent protocol over actual original14 owners; synthetic source admission and physical attestations; no model, Worker or external provider execution",
  nonce: isolated.nonce, cases: [] as Array<Record<string, unknown>>, cleanupFailed: false, databaseClosed: false };
function status(error: unknown): number | null {
  if (error instanceof HttpException) return error.getStatus();
  return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
}
async function denied(operation: Promise<unknown>, expected: number) {
  expect(await operation.then(() => null, error => status(error))).toBe(expected);
}
async function get(view: AgentFulfillmentCommandView) {
  return f.service().get(await f.current(), view.native.id, f.query(view.native.orderId));
}
async function exactRead(view: AgentFulfillmentCommandView) {
  const before = await f.original.business(), attempts = f.original.calls.execute, audit = await f.original.auditState(), context = await f.current();
  const read = AgentFulfillmentCommandViewSchema.parse(await f.service().get(context, view.native.id, f.query(view.native.orderId)));
  const list = AgentFulfillmentCommandListSchema.parse(await f.service().list(context, f.query(view.native.orderId)));
  const receipt = AgentFulfillmentCommandReceiptSchema.parse(await f.service().receipt(context, f.lookup(view)));
  expect(read.native.id).toBe(view.native.id); expect(read.native.receipt).toEqual(view.native.receipt);
  expect(list.items.filter(item => item.native.id === view.native.id)).toHaveLength(1);
  expect(receipt).toMatchObject({ disposition: "known", id: view.native.id, requestId: view.native.requestId,
    requestChecksum: view.native.requestChecksum, privateAvailable: false });
  expect(f.original.calls.execute).toBe(attempts); expect(await f.original.business()).toEqual(before); expect(await f.original.auditState()).toEqual(audit);
  return read;
}
async function acknowledged(view: AgentFulfillmentCommandView) {
  const value = await f.service().acknowledge(await f.current(), view.native.id, f.acknowledgement(view));
  expect(value).toMatchObject({ privateAvailable: false, original: null, originalChecksum: null, confirmationToken: null, canConfirm: false,
    native: { id: view.native.id, acknowledged: true, status: "acknowledged", summary: null, receipt: null } });
  return value;
}

describe.sequential("Agent individual original fulfillment confirmation", () => {
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 120_000);
  afterEach(async () => { await f.settle(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { proof.cleanupFailed = true; failures.push(error); }
    try { await database.client.end(); proof.databaseClosed = true; } catch (error) { proof.cleanupFailed = true; failures.push(error); }
    const directory = join(isolated.lane, "qa"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${isolated.nonce}-current-proof.json`), JSON.stringify({ ...proof, originalCalls: f.original.calls,
      httpCalls: f.httpCalls, lostResponses: f.lostResponses, cleanupDiagnostics: f.cleanupDiagnostics, carrierCalls: f.original.owners.carrier.calls,
      shipmentEnqueues: f.original.owners.shipmentEnqueues.length, logisticsEnqueues: f.original.owners.logisticsEnqueues.length,
      modelCalls: 0, workerProcesses: 0 }, null, 2) + "\n", { flag: "wx" });
    if (failures.length) throw new AggregateError(failures, "agent_fulfillment_actual_cleanup_failed");
  });

  it.each(FulfillmentCommandKindSchema.options)("agent_fulfillment_original_owner_receipt_%s", async kind => {
    const value = await f.command(kind), before = await f.original.business(), attempts = f.original.calls.execute;
    const prepared = AgentFulfillmentCommandViewSchema.parse(await f.service().prepare(await f.current(), value.input));
    expect(prepared.native.status).toBe("prepared"); expect(prepared.native.receipt).toBeNull(); expect(prepared.canConfirm).toBe(true);
    expect(prepared.original).toEqual(value.command); expect(prepared.native.orderId).toBe(value.scene.order.id);
    expect(prepared.originalChecksum).toBe(agentFulfillmentHash(canonicalAgentFulfillmentOriginal(value.command)));
    expect(await f.original.business()).toEqual(before); expect(f.original.calls.execute).toBe(attempts);
    const journal = await f.original.intent(prepared.native.id); expect(journal?.requestChecksum).toBe(prepared.originalChecksum);
    expect(Object.hasOwn(prepared.native, "confirmationToken")).toBe(false);
    const completed = AgentFulfillmentCommandViewSchema.parse(await f.confirm(await f.current(), prepared));
    expect(completed.native.status).toBe("succeeded"); expect(completed.native.receipt?.kind).toBe(kind);
    expect(completed.native.id).toBe(prepared.native.id); expect(f.original.calls.execute - attempts).toBe(1);
    const native = await f.original.service().get(await f.current(), prepared.native.id);
    expect(native).toMatchObject({ id: prepared.native.id, requestId: prepared.native.requestId, requestChecksum: prepared.native.requestChecksum,
      summary: null, receipt: null, canExecute: false, canCancel: false });
    await exactRead(completed); await acknowledged(completed);
    proof.cases.push({ name: `agent_fulfillment_original_owner_receipt_${kind}`, intentId: prepared.native.id,
      requestId: prepared.native.requestId, requestChecksum: prepared.native.requestChecksum, kind, originalOwnerExecutions: 1,
      preparedBusinessDelta: 0, originalReceipt: completed.native.receipt });
  });

  it("legacy37_and_native_v3_keep_their_original_protocol_and_cannot_accept_fulfillment_tokens_or_drafts", async () => {
    const context = await f.current(), workspace = AgentFulfillmentCommandWorkspaceSchema.parse(await f.service().workspace(context));
    const legacy = workspace.capabilities.filter(item => item.protocol === AGENT_COMMAND_VERSION).map(({ protocol, ...item }) => {
      expect(protocol).toBe(AGENT_COMMAND_VERSION); return item;
    });
    expect(legacy).toEqual(agentCommandCapabilities(context)); expect(legacy).toHaveLength(37);
    expect(workspace.capabilities.filter(item => item.domain === "fulfillment")).toHaveLength(14);
    expect(workspace).toMatchObject({ autonomousWrites: false, modelProposalState: "not_integrated" });
    const draft = { position: 0, capability: { domain: "production", kind: "reviewed_line" }, label: "Synthetic original",
      reason: "Synthetic transport compatibility", draftJson: "{}", claimIndexes: [], missingInformation: [] };
    expect(AgentNativeV3DraftSchema.parse(draft)).toEqual(draft);
    expect(AgentNativeV3DraftSchema.safeParse({ ...draft, capability: { domain: "fulfillment", kind: "shipment_dispatch" } }).success).toBe(false);
    const value = await f.command("production_milestone"), prepared = await f.service().prepare(context, value.input);
    expect(PrepareAgentCommandSchema.safeParse({ version: AGENT_COMMAND_VERSION, requestId: value.command.requestId,
      original: { domain: "fulfillment", command: value.command } }).success).toBe(false);
    const approval = f.vault.withSecret(prepared.confirmationToken!, text => AgentFulfillmentConfirmationSchema.parse(JSON.parse(text)));
    expect(AgentCommandConfirmationSchema.safeParse(approval).success).toBe(false);
    expect(approval).toMatchObject({ purpose: "agent_fulfillment_confirm", intentId: prepared.native.id, expectedStatus: "prepared" });
    proof.cases.push({ name: "legacy37_native_v3_compatibility", legacyCapabilities: 37, newCapabilities: 14,
      compatibilityScope: "actual_current_catalog_and_strict_transport_not_a_replayed_historical_task", modelProposalState: workspace.modelProposalState });
  });

  it("lost_prepare201_recovers_the_committed_original_intent_with_fixed_token_GETs_only", async () => {
    const value = await f.command("production_milestone"), before = await f.original.business(), attempts = f.original.calls.execute, bearer = await f.token();
    const checksum = agentFulfillmentHash(canonicalAgentFulfillmentOriginal(value.command)); f.loseResponse("prepare");
    expect(await f.http(f.original.a, "/prepare", value.input).then(() => "unexpected_response", () => "actual_connection_lost")).toBe("actual_connection_lost");
    const start = f.httpCalls.length, lookup = { ...f.query(value.scene.order.id), requestId: value.command.requestId, requestChecksum: checksum };
    const response = await f.http(f.original.a, `/receipts?${new URLSearchParams(lookup)}`); expect(response.status).toBe(200);
    const receipt = AgentFulfillmentCommandReceiptSchema.parse(await response.json()); expect(receipt.disposition).toBe("known");
    if (!receipt.id) throw new Error("agent_fulfillment_original_prepare_receipt_missing");
    const read = await f.http(f.original.a, `/requests/${receipt.id}?${new URLSearchParams(f.query(value.scene.order.id))}`); expect(read.status).toBe(200);
    const prepared = AgentFulfillmentCommandViewSchema.parse(await read.json()); expect(prepared.native.status).toBe("prepared"); expect(prepared.original).toEqual(value.command);
    expect(f.httpCalls.slice(start).every(call => call.method === "GET")).toBe(true); expect(await f.token()).toBe(bearer);
    expect(f.original.calls.execute).toBe(attempts); expect(await f.original.business()).toEqual(before);
    expect(f.lostResponses.prepare).toBe(1); proof.cases.push({ name: "lost_prepare201", intentId: receipt.id, readOnlyRecovery: true });
  });

  it("lost_confirm200_reads_the_exact_original_owner_receipt_without_a_second_confirmation_or_execution", async () => {
    const value = await f.command("shipment_dispatch"), prepared = await f.service().prepare(await f.current(), value.input), attempts = f.original.calls.execute;
    f.loseResponse("confirm", prepared.native.id);
    expect(await f.http(f.original.a, `/requests/${prepared.native.id}/confirm`, f.confirmation(prepared)).then(() => "unexpected_response", () => "actual_connection_lost")).toBe("actual_connection_lost");
    const facts = await f.original.business(), start = f.httpCalls.length;
    const response = await f.http(f.original.a, `/requests/${prepared.native.id}?${new URLSearchParams(f.query(prepared.native.orderId))}`); expect(response.status).toBe(200);
    const completed = AgentFulfillmentCommandViewSchema.parse(await response.json()); expect(completed.native.status).toBe("succeeded");
    expect(completed.native.receipt?.kind).toBe("shipment_dispatch"); await exactRead(completed);
    expect(f.httpCalls.slice(start).every(call => call.method === "GET")).toBe(true); expect(f.original.calls.execute - attempts).toBe(1);
    expect(await f.original.business()).toEqual(facts); expect(f.lostResponses.confirm).toBe(1);
    proof.cases.push({ name: "lost_confirm200", intentId: prepared.native.id, receipt: completed.native.receipt, originalOwnerExecutions: 1 });
  });

  it("uncertain_original_requires_a_fresh_explicit_resume_and_GET_never_executes", async () => {
    const value = await f.command("production_milestone"), prepared = await f.service().prepare(await f.current(), value.input), facts = await f.original.business();
    f.original.hooks.beforeExecute = async () => { f.original.hooks.beforeExecute = undefined; throw new Error("synthetic_failure_before_actual_owner"); };
    const unknown = await f.confirm(await f.current(), prepared); expect(unknown.native).toMatchObject({ status: "uncertain", receipt: null });
    expect(unknown.confirmationDecision).toBe("resume_original"); const attempts = f.original.calls.execute;
    for (let index = 0; index < 3; index++) expect((await get(unknown)).native.status).toBe("uncertain");
    expect(f.original.calls.execute).toBe(attempts); expect(await f.original.business()).toEqual(facts);
    await denied(f.confirm(await f.current(), unknown, f.confirmation(prepared)), 409);
    const resumed = await f.confirm(await f.current(), await get(unknown)); expect(resumed.native.status).toBe("succeeded");
    expect(f.original.calls.ownerCompleted).toBeGreaterThan(0); await exactRead(resumed);
    proof.cases.push({ name: "explicit_uncertain_resume", intentId: prepared.native.id, lookupExecutions: 0, resumeDecision: "resume_original" });
  });

  it("fixed_body_order_actor_version_and_another_original_token_cannot_rebind_the_intent", async () => {
    const first = await f.command("production_milestone"), second = await f.command("production_milestone"), prepared = await f.service().prepare(await f.current(), first.input);
    const other = await f.service().prepare(await f.current(), second.input), before = await f.original.business(), snapshot = await f.original.intent(prepared.native.id);
    if (first.command.kind !== "production_milestone") throw new Error("agent_fulfillment_original_milestone_required");
    const changed = PrepareAgentFulfillmentCommandSchema.parse({ ...first.input, original: { ...first.command,
      input: { ...first.command.input, evidence: { ...first.command.input.evidence, note: "Different original body" } } } });
    await denied(f.service().prepare(await f.current(), changed), 409);
    await denied(f.service().prepare(await f.current(), { ...first.input, orderId: second.scene.order.id }), 404);
    await denied(f.service().get(await f.current(f.original.peer), prepared.native.id, f.query(prepared.native.orderId)), 404);
    await denied(f.service().get(await f.current(f.original.foreign), prepared.native.id, f.query(prepared.native.orderId)), 404);
    await denied(f.service().get(await f.current(), prepared.native.id, f.query(other.native.orderId)), 404);
    await denied(f.confirm(await f.current(), prepared, { ...f.confirmation(prepared), confirmationToken: other.confirmationToken! }), 409);
    const invalid = await f.http(f.original.a, `/requests/${prepared.native.id}/confirm`, { ...f.confirmation(prepared), version: AGENT_COMMAND_VERSION }); expect(invalid.status).toBe(400);
    expect(await f.original.intent(prepared.native.id)).toEqual(snapshot); expect(await f.original.business()).toEqual(before);
    const actual = await f.original.owners.production.get(await f.current(), first.command.targetId);
    await f.original.owners.production.recordMilestone(await f.current(), first.command.targetId, { ...first.command.input,
      expectedProjectionVersion: actual.productionOrder.projectionVersion, externalEventId: randomUUID() });
    const changedFacts = await f.original.business(), result = await f.confirm(await f.current(), prepared);
    expect(result.native).toMatchObject({ status: "rejected", receipt: null, errorCode: "conflict" }); expect(await f.original.business()).toEqual(changedFacts);
    proof.cases.push({ name: "fixed_original_identity", intentId: prepared.native.id, otherIntentId: other.native.id, staleOriginalRejected: true });
  });

  it("Workflow_birth_and_current_intersect_and_legacy_intents_never_gain_invented_Agent_approval", async () => {
    const value = await f.command("production_milestone"), orderBits = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead];
    const withoutWorkflow = TenantContextSchema.parse({ ...await f.current(), permissions: orderBits, permissionScopes: Object.fromEntries(orderBits.map(bit => [bit, "tenant"])) });
    const historical = await f.original.service().prepare(withoutWorkflow, value.command), prior = await f.original.intent(historical.id), facts = await f.original.business();
    await denied(f.service().get(await f.current(), historical.id, f.query(historical.orderId)), 409);
    expect(await f.original.intent(historical.id)).toEqual(prior); expect(await f.original.business()).toEqual(facts);
    await f.original.service().cancel(await f.current(), historical.id); await f.original.service().acknowledge(await f.current(), historical.id);
    const second = await f.command("production_milestone"), bits = [...orderBits, Permission.WorkflowRead, Permission.WorkflowRun];
    const incoming = TenantContextSchema.parse({ ...await f.current(), permissions: bits,
      permissionScopes: Object.fromEntries(bits.map(bit => [bit, bit === Permission.WorkflowRead || bit === Permission.WorkflowRun ? "self" : "tenant"])) });
    const waiting = await f.service().prepare(incoming, second.input), birth = await f.original.intent(waiting.native.id);
    expect(waiting.canConfirm).toBe(true); expect(birth?.authoritySnapshot.permissionScopes?.[Permission.WorkflowRun]).toBe("self");
    await denied(f.confirm(TenantContextSchema.parse({ ...await f.current(), permissions: orderBits }), waiting), 403);
    await denied(f.confirm(await f.current(), waiting), 409);
    const currentFrame = await get(waiting);
    const completed = await f.confirm(await f.current(), currentFrame); expect(completed.native.status).toBe("succeeded");
    expect((await f.original.intent(waiting.native.id))?.authoritySnapshot).toEqual(birth?.authoritySnapshot);
    proof.cases.push({ name: "workflow_birth_current", legacyIntentId: historical.id, agentIntentId: waiting.native.id, selfWorkflowAllowed: true, laterGrantExpandedBirth: false });
  });

  it.each([Permission.WorkflowRead, Permission.WorkflowRun] as const)("claim_then_revoke_%s_is_rechecked_by_the_actual_original_business_fence", async bit => {
    const value = await f.command("production_milestone"), prepared = await f.service().prepare(await f.current(), value.input), before = await f.original.business(), completed = f.original.calls.ownerCompleted;
    const gate = f.hold("beforeExecute"), pending = f.confirm(await f.current(), prepared), outcome = pending.then(view => ({ view, error: null }), error => ({ view: null, error }));
    let restore: { restore(): Promise<unknown> } | undefined;
    try {
      await agentFulfillmentBounded(gate.entered, "agent_fulfillment_original_claim_missing");
      expect((await f.original.intent(prepared.native.id))?.status).toBe("executing");
      restore = await f.original.permissions(f.original.a, f.original.allPermissions.filter(permission => permission !== bit));
      gate.release(); const late = await outcome;
      expect(status(late.error)).toBe(bit === Permission.WorkflowRead ? 403 : 409);
      if (bit === Permission.WorkflowRun) {
        expect(late.error).toBeInstanceOf(HttpException);
        if (!(late.error instanceof HttpException)) throw new Error("agent_fulfillment_expected_authority_exception");
        expect(late.error.getResponse()).toMatchObject({ code: "authority_changed" });
      }
      expect(f.original.calls.ownerCompleted).toBe(completed); expect(await f.original.business()).toEqual(before);
    } finally { gate.release(); await restore?.restore(); await outcome; }
    const read = await get(prepared); expect(read.native.receipt).toBeNull();
    if (bit === Permission.WorkflowRead) {
      expect(read.native.status).toBe("executing"); expect(read.native.leaseExpiresAt).not.toBeNull(); expect(read.canCancel).toBe(false);
      await denied(f.service().cancel(await f.current(), read.native.id, f.cancellation(read)), 409);
    }
    proof.cases.push({ name: `claim_then_revoke_${bit}`, intentId: prepared.native.id, originalOwnerCompleted: false, businessDelta: 0,
      actualActiveLeaseCannotCancel: bit === Permission.WorkflowRead, cleanupRequiresObservedDatabaseLeaseExpiry: bit === Permission.WorkflowRead });
  });

  it.each([Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead] as const)("late_%s_withdrawal_cannot_disclose_or_reexecute_an_already_committed_original_delivery", async bit => {
    const value = await f.command("delivery_create"), prepared = await f.service().prepare(await f.current(), value.input);
    const gate = f.hold("afterExecute"), pending = f.confirm(await f.current(), prepared), outcome = pending.then(view => ({ view, error: null }), error => ({ view: null, error }));
    let restore: { restore(): Promise<unknown> } | undefined;
    try {
      await agentFulfillmentBounded(gate.entered, "agent_fulfillment_original_delivery_commit_missing");
      const before = await f.original.business(), attempts = f.original.calls.execute;
      restore = await f.original.permissions(f.original.a, f.original.allPermissions.filter(permission => permission !== bit));
      gate.release(); const late = await outcome; expect(status(late.error)).toBe(403);
      expect(await f.original.business()).toEqual(before); expect(f.original.calls.execute).toBe(attempts);
    } finally { gate.release(); await restore?.restore(); await outcome; }
    const restored = await get(prepared); expect(restored.native.status).toBe("succeeded"); await exactRead(restored);
    proof.cases.push({ name: `late_${bit}_withdrawal`, intentId: prepared.native.id, recoveryIsOriginalGET: true });
  });

  it("real_source_TTL_and_specific_editor_key_clear_remove_original_text_and_all_confirmation_material", async () => {
    const value = await f.command("production_milestone"); await f.original.shortenSource(value.scene, 3);
    const prepared = await f.service().prepare(await f.current(), value.input), before = await f.original.business(); await f.original.waitExpired(prepared.native.id);
    const expired = await get(prepared); expect(expired).toMatchObject({ privateAvailable: false, original: null, originalChecksum: null,
      canConfirm: false, confirmationToken: null, native: { status: "expired", summary: null, receipt: null } });
    await denied(f.confirm(await f.current(), prepared), 409); expect(await f.original.business()).toEqual(before);
    await acknowledged(expired);
    const next = await f.command("delivery_create"), waiting = await f.service().prepare(await f.current(), next.input), gate = f.holdAgent("afterRead");
    const pending = get(waiting), project = next.scene.productions[0]; if (!project) throw new Error("agent_fulfillment_specific_project_missing");
    try {
      await agentFulfillmentBounded(gate.entered, "agent_fulfillment_actual_read_frame_missing");
      const removed = await withTenant(database.db, f.original.a, tx => tx.update(productionEditorProjects).set({ encryptedDataKey: null })
        .where(eq(productionEditorProjects.id, project.projectId)).returning({ id: productionEditorProjects.id }));
      expect(removed).toEqual([{ id: project.projectId }]);
    } finally { gate.release(); }
    const late = await pending; expect(late).toMatchObject({ privateAvailable: false, original: null, confirmationToken: null, canConfirm: false,
      native: { status: "expired", summary: null, receipt: null } });
    proof.cases.push({ name: "TTL_and_late_source_clear", expiredIntentId: prepared.native.id, redactedIntentId: waiting.native.id, projectId: project.projectId });
  });

  it("acknowledgement_during_a_completed_original_read_cannot_resurrect_private_input_or_an_old_token", async () => {
    const value = await f.command("production_milestone"), prepared = await f.service().prepare(await f.current(), value.input), completed = await f.confirm(await f.current(), prepared);
    const gate = f.holdAgent("afterRead"), pending = get(completed);
    try { await agentFulfillmentBounded(gate.entered, "agent_fulfillment_before_ack_original_frame_missing"); await acknowledged(completed); }
    finally { gate.release(); }
    const late = await pending; expect(late).toMatchObject({ privateAvailable: false, original: null, confirmationToken: null, canConfirm: false,
      native: { status: "acknowledged", summary: null, receipt: null } });
    expect(await get(completed)).toMatchObject({ original: null, native: { status: "acknowledged" } });
    proof.cases.push({ name: "late_read_after_ack", intentId: completed.native.id, oldPrivateFrameAdopted: false });
  });

  it("short_server_confirmation_expiry_rejects_the_old_token_without_expiring_or_repreparing_the_original_input", async () => {
    const value = await f.command("production_milestone"), prepared = await f.service().prepare(await f.current(), value.input);
    const short = await f.service(1).get(await f.current(), prepared.native.id, f.query(prepared.native.orderId));
    if (!short.confirmationExpiresAt) throw new Error("agent_fulfillment_short_server_confirmation_missing");
    const deadline = short.confirmationExpiresAt, originalExpiry = (await f.original.intent(short.native.id))?.expiresAt;
    await agentFulfillmentBounded((async () => {
      for (;;) {
        const [clock] = await withTenant(database.db, f.original.a, tx => tx.execute<{ expired: boolean }>(sql`select clock_timestamp()>=${deadline}::timestamptz as expired`));
        if (clock?.expired) return; await new Promise<void>(done => setTimeout(done, 20));
      }
    })(), "agent_fulfillment_confirmation_clock_not_reached", 5000);
    const before = await f.original.business(), attempts = f.original.calls.execute;
    const failure = await f.confirm(await f.current(), short).then(() => null, error => error);
    expect(status(failure)).toBe(409);
    if (!(failure instanceof HttpException)) throw new Error("agent_fulfillment_confirmation_expiry_exception_missing");
    expect(failure.getResponse()).toMatchObject({ code: "agent_fulfillment_command_confirmation_expired" });
    expect((await f.original.intent(short.native.id))?.expiresAt).toBe(originalExpiry);
    expect(f.original.calls.execute).toBe(attempts); expect(await f.original.business()).toEqual(before);
    const reread = await get(short); expect(reread.canConfirm).toBe(true); expect(reread.native.id).toBe(short.native.id);
    proof.cases.push({ name: "short_confirmation_expiry", intentId: short.native.id, realDatabaseDeadlineObserved: true, originalInputExpiryUnchanged: true });
  });

  it("concurrent_HTTP_confirm_and_managed_raw_owner_redispatch_keep_one_original_fact", async () => {
    const value = await f.command("production_milestone"), attempts = f.original.calls.execute;
    const responses = await Promise.all([f.http(f.original.a, "/prepare", value.input), f.http(f.original.a, "/prepare", value.input)]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    const views = await Promise.all(responses.map(async response => AgentFulfillmentCommandViewSchema.parse(await response.json()))), first = views[0];
    if (!first) throw new Error("agent_fulfillment_concurrent_prepare_missing"); expect(views[1]?.native.id).toBe(first.native.id);
    const context = await f.current();
    for (const operation of [() => f.original.service().execute(context, first.native.id), () => f.original.service().cancel(context, first.native.id),
      () => f.original.service().acknowledge(context, first.native.id), () => f.original.service().prepare(context, value.command)])
      await denied(operation(), 409);
    const [lineage] = await withTenant(database.db, f.original.a, tx => tx.select({ version: orderFulfillmentCommandIntents.contractVersion })
      .from(orderFulfillmentCommandIntents).where(eq(orderFulfillmentCommandIntents.id, first.native.id)));
    expect(lineage?.version).toBe(AGENT_FULFILLMENT_COMMAND_VERSION);
    if (value.command.kind !== "production_milestone") throw new Error("agent_fulfillment_managed_milestone_required");
    await denied(f.original.owners.production.recordMilestone(await f.current(), value.command.targetId, value.command.input), 409);
    const results = await Promise.all([f.http(f.original.a, `/requests/${first.native.id}/confirm`, f.confirmation(first)),
      f.http(f.original.a, `/requests/${first.native.id}/confirm`, f.confirmation(first))]);
    expect(results.some(response => response.status === 200)).toBe(true); expect(results.every(response => response.status === 200 || response.status === 409)).toBe(true);
    const complete = await get(first); expect(complete.native.status).toBe("succeeded"); expect(f.original.calls.execute - attempts).toBe(1); await exactRead(complete);
    const next = await f.command("production_milestone"), waiting = await f.service().prepare(await f.current(), next.input), facts = await f.original.business();
    const cancelled = await f.service().cancel(await f.current(), waiting.native.id, f.cancellation(waiting)); expect(cancelled.native.status).toBe("cancelled");
    await denied(f.confirm(await f.current(), waiting), 409); expect(await f.original.business()).toEqual(facts);
    proof.cases.push({ name: "concurrent_and_managed_fence", committedIntentId: first.native.id, cancelledIntentId: waiting.native.id, originalOwnerExecutions: 1 });
  });

  it("forced_RLS_hides_the_original_intent_and_original_success_audit_failure_rolls_back_business_before_GET_recovery", async () => {
    const value = await f.command("shipment_create"), prepared = await f.service().prepare(await f.current(), value.input), before = await f.original.business();
    expect(await withTenant(database.db, f.original.foreign, tx => tx.select({ id: orderFulfillmentCommandIntents.id }).from(orderFulfillmentCommandIntents)
      .where(eq(orderFulfillmentCommandIntents.id, prepared.native.id)))).toEqual([]);
    const failure = f.original.failNextAudit("shipment.create"); let result: AgentFulfillmentCommandView;
    try { result = await f.confirm(await f.current(), prepared); } finally { failure.restore(); }
    expect(failure.failed()).toBe(true); expect(result.native).toMatchObject({ status: "uncertain", receipt: null });
    expect(await f.original.business()).toEqual(before); const attempts = f.original.calls.execute; await exactRead(result); expect(f.original.calls.execute).toBe(attempts);
    proof.cases.push({ name: "RLS_original_audit_rollback", intentId: prepared.native.id, foreignRows: 0, successfulOriginalBusinessWrites: 0 });
  });

  it("preparation_and_Agent_confirmation_audits_rollback_before_any_original_business_dispatch", async () => {
    const value = await f.command("production_milestone"), facts = await f.original.business(), firstFailure = f.original.failNextAudit("order_fulfillment_command.prepare");
    try { await expect(f.service().prepare(await f.current(), value.input)).rejects.toThrow("fulfillment_synthetic_final_audit_failed"); }
    finally { firstFailure.restore(); }
    expect(firstFailure.failed()).toBe(true);
    const absent = await f.service().receipt(await f.current(), { ...f.query(value.scene.order.id), requestId: value.command.requestId,
      requestChecksum: agentFulfillmentHash(canonicalAgentFulfillmentOriginal(value.command)) });
    expect(absent).toMatchObject({ disposition: "not_found", id: null }); expect(await f.original.business()).toEqual(facts);
    const prepared = await f.service().prepare(await f.current(), value.input), intent = await f.original.intent(prepared.native.id), attempts = f.original.calls.execute;
    const failure = f.original.failNextAudit("agent.fulfillment_command.confirm");
    try { await expect(f.confirm(await f.current(), prepared)).rejects.toThrow("fulfillment_synthetic_final_audit_failed"); }
    finally { failure.restore(); }
    expect(failure.failed()).toBe(true); expect(await f.original.intent(prepared.native.id)).toEqual(intent);
    expect(f.original.calls.execute).toBe(attempts); expect(await f.original.business()).toEqual(facts);
    const read = await get(prepared); expect(read.native.status).toBe("prepared"); expect(read.native.receipt).toBeNull();
    proof.cases.push({ name: "preparation_confirmation_audit_rollback", intentId: prepared.native.id, originalDispatches: 0 });
  });
});
