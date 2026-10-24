import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Permission, erpPermissionContext, erpPermissions } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { requireShipmentCreateEnvironment } from "../../../../tools/testing/require-shipment-create-environment.mjs";

// The family guard executes before decorated owner imports or a connection.
const environment = requireShipmentCreateEnvironment();
const { connectDatabase, withTenant } = await import("@yummyai/database");
const { sql } = await import("drizzle-orm");
const { ShipmentCreateWorkspaceSchema, CreateShipmentInputSchema } = await import("@yummyai/contracts/order/shipment");
const { AGENT_FULFILLMENT_COMMAND_VERSION: originalVersion } = await import("@yummyai/contracts/ai/agent-fulfillment-command");
const { AgentNativeV4ItemReceiptSchema } = await import("@yummyai/contracts/ai/agent-native-v4");
const { shipmentCreateFixture } = await import("./agent-native-v4-shipment-create.test-fixture.js");
const { nativeV3Scopes } = await import("./agent-native-v3.test-fixture.js");
const { syntheticPassedProduction } = await import("../orders/shipment-production-fixture.js");
const database = connectDatabase(environment.url), f = shipmentCreateFixture(database), native = f.native;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const current = () => f.current();
type Planned = Awaited<ReturnType<typeof f.plan>>;
async function original(value: Planned, id: string) {
  return native.fulfillmentCommands.get(await current(), id, { version: originalVersion, orderId: value.scenario.scene.order.id });
}
async function originalCount(requestId: string) {
  return withTenant(database.db, await current(), async tx => {
    const [row] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from order_fulfillment_command_intents where request_id=${requestId}::uuid`);
    return row?.count ?? -1;
  });
}

describe.sequential("original partial multi-package shipment via native v4", () => {
  beforeAll(async () => { await f.initialize(); }, 240_000);
  afterEach(async () => { await native.settle(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "shipment_create_disposable_close_failed");
  });

  it("partial_multiline_two_packages_use_original_group_P_while_production_is_P_plus_1_then_create_only_a_draft", async () => {
    const value = await f.plan(), context = await current(), orderId = value.scenario.scene.order.id;
    const { aGood, aHeld, bGood } = value.scenario.groups, a = value.scenario.scene.productions[0], b = value.scenario.scene.productions[1];
    if (!a || !b) throw new Error("actual_two_original_lines_missing");
    expect(aGood.quantity).toBe(3); expect(aHeld.quantity).toBe(2); expect(bGood.quantity).toBe(1);
    expect(aGood.productionProjectionVersionAfterInspection).toBe(aGood.productionProjectionVersion + 1);
    expect(bGood.productionProjectionVersionAfterInspection).toBe(bGood.productionProjectionVersion + 1);
    expect(value.item.canPrepare).toBe(true); expect(value.item.originalChecksum).toBeNull();
    expect(value.view.result?.proposals[0]?.operatorChecks.every(check => check.state === "pending")).toBe(true);
    expect(native.modelCalls.length).toBe(4); expect(native.wire.every(row => row.path === "/v1/responses" && row.method === "POST")).toBe(true);
    expect(native.providerFailures).toEqual([]);
    const source = value.scenario.workspace.sources.find(row => row.qualityGroupId === aGood.id);
    expect(source?.projectionVersion).toBe(aGood.productionProjectionVersion); expect(source?.availableQuantity).toBe(3);
    expect(value.scenario.workspace.sources.find(row => row.qualityGroupId === aHeld.id)?.availableQuantity).toBe(0);
    const before = await f.business(), shipmentBefore = await f.shipmentState(orderId), calls = native.calls.confirm;
    const response = await f.httpWorkspace(native.base.a, orderId); expect(response.status).toBe(200);
    const workspace = ShipmentCreateWorkspaceSchema.parse(await response.json());
    expect(workspace.contextAuthority).toBe(erpSessionAuthority(erpPermissionContext(context))); expect(workspace.canCreate).toBe(true);
    expect(workspace.lines.map(line => line.quantity).sort()).toEqual([1, 5]); expect(await f.business()).toEqual(before);
    const receipt = await native.service().prepareItem(context, value.view.id, value.item.id, value.prepare);
    expect(receipt.disposition).toBe("known"); if (!receipt.fulfillmentIntentId) throw new Error("actual_partial_intent_missing");
    expect(new Set([value.view.id, value.item.id, receipt.fulfillmentIntentId]).size).toBe(3);
    const prepared = await original(value, receipt.fulfillmentIntentId);
    expect(prepared.native.kind).toBe("shipment_create"); expect(prepared.native.status).toBe("prepared");
    expect(prepared.native.requestId).toBe(value.item.id); expect(prepared.canConfirm).toBe(true);
    expect(digest(prepared.original)).toBe(digest(f.complete(value.scenario, value.item.id).original));
    expect(await f.business()).toEqual(before); expect(await f.shipmentState(orderId)).toEqual(shipmentBefore);
    expect(native.calls.confirm).toBe(calls); expect(await originalCount(value.item.id)).toBe(1);
    const confirmed = await native.fulfillmentCommands.confirm(context, prepared.native.id, native.confirmation(prepared));
    expect(confirmed.native.status).toBe("succeeded"); const actual = confirmed.native.receipt;
    if (actual?.kind !== "shipment_create") throw new Error("actual_partial_typed_receipt_missing");
    const shipment = await f.owners.shipping.get(context, actual.shipmentId);
    expect(shipment.shipment.orderId).toBe(orderId); expect(shipment.shipment.wholeOrder).toBe(false);
    expect(shipment.shipment.status).toBe("draft"); expect(shipment.shipment.approvedVersionNumber).toBeNull();
    expect(shipment.versions).toHaveLength(1); expect(shipment.packages).toHaveLength(2); expect(shipment.packageLines).toHaveLength(3);
    expect(shipment.packageLines.filter(line => line.orderLineId === a.lineId).reduce((sum, line) => sum + line.quantity, 0)).toBe(2);
    expect(shipment.packageLines.filter(line => line.orderLineId === b.lineId).reduce((sum, line) => sum + line.quantity, 0)).toBe(1);
    expect(shipment.productionAllocations).toHaveLength(3); expect(shipment.productionAllocations.every(row => row.qualityGroupId !== aHeld.id)).toBe(true);
    expect(shipment.productionAllocations.filter(row => row.qualityGroupId === aGood.id).every(row => row.productionProjectionVersion === aGood.productionProjectionVersion)).toBe(true);
    expect(shipment.reviews.length + shipment.tracking.length + shipment.writebacks.length + shipment.manualConfirmations.length).toBe(0);
    expect(shipment.physicalHandover.allDispatched).toBe(false); expect(f.owners.shipmentEnqueues).toHaveLength(0);
    expect((await f.workspace(orderId)).sources.find(row => row.qualityGroupId === aGood.id)?.allocatedQuantity).toBe(0); // Draft is not an approved reservation.
    const completed = await f.business();
    for (let index = 0; index < 2; index++) expect((await native.service().itemReceipt(context, value.view.id, value.item.id, native.itemQuery(value.view, value.item))).fulfillmentIntentId).toBe(prepared.native.id);
    expect(await f.business()).toEqual(completed); expect(native.calls.confirm).toBe(calls + 1);
  });

  it("lost201_recovers_only_the_fixed_item_by_GET_and_rejects_changed_body_order_actor_and_slot", async () => {
    const value = await f.plan(), context = await current(), before = await f.business(), writes = native.calls.prepare, paid = native.modelCalls.length;
    native.losePrepareResponse();
    await expect(native.http(native.base.a, `/runs/${value.view.id}/items/${value.item.id}/prepare`, value.prepare)).rejects.toThrow();
    const afterLost = native.httpCalls.length, lookup = native.itemQuery(value.view, value.item);
    const response = await native.http(native.base.a, `/runs/${value.view.id}/items/${value.item.id}/receipt?${new URLSearchParams(lookup)}`);
    expect(response.status).toBe(200); const receipt = AgentNativeV4ItemReceiptSchema.parse(await response.json());
    expect(receipt.disposition).toBe("known"); expect(receipt.itemId).toBe(value.item.id); expect(receipt.runId).toBe(value.view.id);
    if (!receipt.fulfillmentIntentId) throw new Error("actual_lost_partial_intent_missing");
    expect(native.httpCalls.slice(afterLost).every(row => row.method === "GET" && row.bodyChecksum === null)).toBe(true);
    expect(native.calls.prepare - writes).toBe(1); expect(await originalCount(value.item.id)).toBe(1);
    const completion = value.prepare.completion; if (!completion || completion.original.kind !== "shipment_create") throw new Error("actual_partial_completion_missing");
    for (const altered of [{ ...completion, orderId: createEntityId() }, { ...completion, original: { ...completion.original, requestId: createEntityId() } },
      { ...completion, original: { ...completion.original, input: { ...completion.original.input, shipFromCountryCode: "CA" } } }])
      await expect(native.service().prepareItem(context, value.view.id, value.item.id, { ...value.prepare, completion: altered })).rejects.toThrow();
    await expect(native.service().itemReceipt(await native.current(native.base.second), value.view.id, value.item.id, lookup)).rejects.toThrow();
    await expect(native.service().itemReceipt(await native.current(native.base.foreign), value.view.id, value.item.id, lookup)).rejects.toThrow();
    await expect(native.service().itemReceipt(context, value.view.id, createEntityId(), lookup)).rejects.toThrow();
    expect(native.modelCalls.length).toBe(paid); expect(native.calls.prepare - writes).toBe(1); expect(await f.business()).toEqual(before);
  });

  it("workspace_requires_current_tenant_PII_and_preserves_mixed_restrictions_and_legitimate_no_work_sources", async () => {
    const value = await f.scenario(), context = await current(), orderId = value.scene.order.id;
    const before = await f.business(), good = await f.httpWorkspace(native.base.a, orderId); expect(good.status).toBe(200); await good.json();
    const originalScopes = Object.fromEntries(context.permissions.map(permission => [permission, context.permissionScopes?.[permission] ?? context.dataScope]));
    const erpScopes = Object.fromEntries(Object.entries(originalScopes).filter(([permission]) => erpPermissions([permission]).length === 1));
    expect(erpPermissions([Permission.FactoryTaskRespond])).toEqual([]);
    try {
      await native.base.scopes(native.base.a, erpScopes);
      const baselineContext = await current(), baseline = await f.workspace(orderId);
      expect(baselineContext.permissions.includes(Permission.FactoryTaskRespond)).toBe(false);
      expect(baseline.canCreate).toBe(true);
      await native.base.scopes(native.base.a, { ...erpScopes, [Permission.FactoryTaskRespond]: "self" });
      const withFactory = await current();
      expect(withFactory.permissions.includes(Permission.FactoryTaskRespond)).toBe(true);
      expect(withFactory.permissionScopes?.[Permission.FactoryTaskRespond]).toBe("self");
      const projected = erpPermissionContext(withFactory), expectedStamp = erpSessionAuthority(projected);
      expect(projected.permissions.includes(Permission.FactoryTaskRespond)).toBe(false);
      expect(Object.hasOwn(projected.permissionScopes ?? {}, Permission.FactoryTaskRespond)).toBe(false);
      expect(expectedStamp === erpSessionAuthority(withFactory)).toBe(false);
      const response = await f.httpWorkspace(native.base.a, orderId); expect(response.status).toBe(200);
      const actual = ShipmentCreateWorkspaceSchema.parse(await response.json());
      expect(actual.contextAuthority).toBe(expectedStamp); expect(actual.contextAuthority).toBe(baseline.contextAuthority);
      expect(actual.canCreate).toBe(true); expect(digest(actual.sources)).toBe(digest(baseline.sources));
      expect(actual.orderId).toBe(orderId); expect(actual.orderSequence).toBe(baseline.orderSequence);
    } finally { await native.base.scopes(native.base.a, originalScopes); }
    expect((await f.httpWorkspace(native.base.a, "not-an-id")).status).toBe(400);
    expect((await f.httpWorkspace(native.base.a, orderId, "?unexpected=1")).status).toBe(400);
    expect((await f.httpWorkspace(native.base.foreign, orderId)).status).toBe(404);
    const readOnly = nativeV3Scopes(); delete readOnly[Permission.OrderWrite]; await native.base.scopes(native.base.a, readOnly);
    expect((await f.workspace(orderId)).canCreate).toBe(false);
    const noPii = nativeV3Scopes(); delete noPii[Permission.OrderPiiRead]; await native.base.scopes(native.base.a, noPii);
    try { expect((await f.httpWorkspace(native.base.a, orderId)).status).toBe(403); }
    finally { await native.base.scopes(native.base.a, nativeV3Scopes()); }
    expect(await f.business()).toEqual(before);
    const a = value.scene.productions[0], b = value.scene.productions[1]; if (!a || !b) throw new Error("actual_mixed_lines_missing");
    // Exact reversible owned metadata admission tests. These do not represent
    // a successful archive/purge workflow and never fabricate QC/production.
    async function restricted(ids: string[], mode: "held" | "archived" | "cleared" | "expired", inspect: () => Promise<void>) {
      const originals = await withTenant(database.db, context, tx => tx.execute<{ id: string; key: string | null; held: boolean; archived: string | null; expiry: string }>(sql`
        select id,encrypted_data_key as key,held,archived_at::text as archived,expires_at::text as expiry from order_work_items where id in ${sql`(${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)})`} order by id`));
      expect(originals.length).toBe(ids.length);
      const altered = originals.map(row => ({ ...row, held: mode === "held" ? true : row.held, key: mode === "cleared" ? null : row.key,
        archived: mode === "archived" ? new Date().toISOString() : row.archived, expiry: mode === "expired" ? "2000-01-01T00:00:00.000Z" : row.expiry }));
      async function replace(from: ReadonlyArray<(typeof originals)[number]>, to: ReadonlyArray<(typeof originals)[number]>) {
        await withTenant(database.db, context, async tx => {
          for (let index = 0; index < from.length; index++) {
            const previous = from[index], next = to[index]; if (!previous || !next) throw new Error("synthetic_metadata_pair_missing");
            const changed = await tx.execute<{ id: string }>(sql`update order_work_items set held=${next.held},encrypted_data_key=${next.key},
              archived_at=${next.archived}::timestamptz,expires_at=${next.expiry}::timestamptz where id=${previous.id}::uuid and held=${previous.held}
              and encrypted_data_key is not distinct from ${previous.key} and archived_at is not distinct from ${previous.archived}::timestamptz
              and expires_at=${previous.expiry}::timestamptz returning id`);
            if (changed.length !== 1) throw new Error("synthetic_owned_metadata_CAS_failed");
          }
        });
      }
      await replace(originals, altered); try { await inspect(); } finally { await replace(altered, originals); }
    }
    for (const mode of ["held", "archived", "cleared", "expired"] as const) await restricted([a.lineId], mode, async () => {
      const mixed = await f.workspace(orderId); expect(mixed.canCreate).toBe(true);
      expect(mixed.sources.filter(row => row.orderLineId === a.lineId).every(row => row.availableQuantity === 0 && row.blockers.length > 0)).toBe(true);
      expect(mixed.sources.some(row => row.orderLineId === b.lineId && row.availableQuantity === 1 && !row.blockers.length)).toBe(true);
    });
    await restricted([a.lineId, b.lineId], "held", async () => { expect((await f.workspace(orderId)).canCreate).toBe(false); });
    const initial = await f.owners.initialOrder(context, value.scene.accountId), order = await f.owners.orders.get(context, initial.id);
    await syntheticPassedProduction(database, context, initial.id, order.lines.map(line => ({ id: line.id, quantity: line.quantity })), f.owners.factories,
      { vault: native.original.base.vault, workSources: new Map() });
    const direct = await f.workspace(initial.id); expect(direct.canCreate).toBe(true); expect(direct.sources.some(row => !row.blockers.length && row.availableQuantity > 0)).toBe(true);
    const work = await withTenant(database.db, context, tx => tx.execute(sql`select id from order_work_items where id in (select id from order_lines where order_id=${initial.id}::uuid)`));
    expect(work).toHaveLength(0);
  });

  it("stale_group_projection_overallocation_and_late_Workflow_revoke_never_create_a_shipment", async () => {
    const value = await f.plan(), context = await current(), orderId = value.scenario.scene.order.id, before = await f.shipmentState(orderId);
    const input = value.scenario.command.input, first = input.packages[0]?.lines[0]?.productionAllocations?.[0];
    if (!first) throw new Error("actual_partial_allocation_missing");
    for (const replacement of [{ ...first, expectedProductionProjectionVersion: first.expectedProductionProjectionVersion + 1 },
      { ...first, qualityInspectionId: createEntityId() }, { ...first, qualityGroupId: value.scenario.groups.aHeld.id }]) {
      const invalid = structuredClone(input); const line = invalid.packages[0]?.lines[0]; if (!line) throw new Error("actual_partial_line_missing");
      line.productionAllocations = [replacement]; invalid.idempotencyKey = randomUUID();
      await expect(f.owners.shipping.create(context, orderId, CreateShipmentInputSchema.parse(invalid))).rejects.toThrow();
    }
    const excess = structuredClone(input), sourceLine = excess.packages[0]?.lines[0]; if (!sourceLine?.productionAllocations?.[0]) throw new Error("actual_partial_source_missing");
    sourceLine.quantity = 4; sourceLine.productionAllocations[0].quantity = 4; excess.idempotencyKey = randomUUID();
    await expect(f.owners.shipping.create(context, orderId, CreateShipmentInputSchema.parse(excess))).rejects.toThrow();
    expect(await f.shipmentState(orderId)).toEqual(before);
    const gate = native.hold("beforePrepare"), pending = native.service().prepareItem(context, value.view.id, value.item.id, value.prepare);
    const settled = pending.then(result => ({ result, rejected: false }), () => ({ result: null, rejected: true }));
    try {
      await native.bounded(gate.entered, "actual_shipment_original_birth_not_entered");
      const noRun = nativeV3Scopes(); delete noRun[Permission.WorkflowRun]; await native.base.scopes(native.base.a, noRun);
      gate.release(); expect((await settled).rejected).toBe(true);
    } finally { gate.release(); await settled; await native.base.scopes(native.base.a, nativeV3Scopes()); }
    expect(await originalCount(value.item.id)).toBe(0); expect(await f.shipmentState(orderId)).toEqual(before);
  });

  it("prepared_original_group_reinspection_invalidates_old_QC_pins_without_creating_a_shipment", async () => {
    const { RecordQualityGroupsInputSchema } = await import("@yummyai/contracts/order/quality-groups");
    const value = await f.plan(), context = await current(), orderId = value.scenario.scene.order.id, oldGroup = value.scenario.groups.aGood;
    const linked = await native.service().prepareItem(context, value.view.id, value.item.id, value.prepare);
    expect(linked.disposition).toBe("known"); if (!linked.fulfillmentIntentId) throw new Error("actual_reinspection_original_intent_missing");
    const intentId = linked.fulfillmentIntentId, prepared = await original(value, intentId), proof = native.confirmation(prepared);
    expect(prepared.native.status).toBe("prepared"); expect(prepared.canConfirm).toBe(true);
    expect(prepared.native.requestId).toBe(value.item.id); expect(prepared.native.receipt === null).toBe(true);
    const shipmentBefore = await f.shipmentState(orderId), paid = native.modelCalls.length, prepareCalls = native.calls.prepare;
    const ownerCompleted = native.original.calls.ownerCompleted;
    async function binding() {
      return withTenant(database.db, context, async tx => {
        const [intent] = await tx.execute<{ id: string; requestId: string; requestKey: string; requestChecksum: string; contractVersion: string; orderId: string; targetId: string }>(sql`
          select id,request_id as "requestId",request_key as "requestKey",request_checksum as "requestChecksum",contract_version as "contractVersion",
            order_id as "orderId",target_id as "targetId" from order_fulfillment_command_intents where id=${intentId}::uuid`);
        const [item] = await tx.execute<{ id: string; runId: string; originalChecksum: string | null; preparationRequestChecksum: string | null; completionChecksum: string | null; fulfillmentIntentId: string | null }>(sql`
          select id,run_id as "runId",original_checksum as "originalChecksum",preparation_request_checksum as "preparationRequestChecksum",
            completion_checksum as "completionChecksum",fulfillment_intent_id as "fulfillmentIntentId" from agent_plan_items where id=${value.item.id}::uuid`);
        if (!intent || !item) throw new Error("actual_reinspection_fixed_binding_missing"); return { intent, item };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    }
    async function qualityCounts() {
      return withTenant(database.db, context, async tx => {
        const [counts] = await tx.execute<{ inspections: number; groups: number; reinspections: number }>(sql`select
          (select count(*)::int from quality_inspections where production_order_id=${oldGroup.productionOrderId}::uuid) as inspections,
          (select count(*)::int from quality_inspection_groups where production_order_id=${oldGroup.productionOrderId}::uuid) as groups,
          (select count(*)::int from quality_group_reinspections where production_order_id=${oldGroup.productionOrderId}::uuid) as reinspections`);
        if (!counts) throw new Error("actual_reinspection_quality_counts_missing"); return counts;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    }
    const fixed = await binding(), qualityBefore = await qualityCounts();
    expect(fixed.intent.id).toBe(intentId); expect(fixed.intent.requestId).toBe(value.item.id); expect(fixed.intent.requestKey).toBe(value.item.id);
    expect(fixed.item.fulfillmentIntentId).toBe(intentId); expect(fixed.item.runId).toBe(value.view.id);
    expect(fixed.item.originalChecksum).toBe(prepared.native.requestChecksum);
    const basis = await f.owners.production.qualityGroups(context, oldGroup.productionOrderId);
    expect(basis.groups.find(group => group.id === oldGroup.id)?.active).toBe(true);
    const reinspected = await f.owners.production.inspectGroups(context, oldGroup.productionOrderId, RecordQualityGroupsInputSchema.parse({
      formatVersion: 3, productionVersionId: basis.productionVersionId, expectedProductionProjectionVersion: basis.projectionVersion,
      expectedRootInspectionId: basis.rootInspectionId, parentGroupId: oldGroup.id, qualityStandardVersionId: oldGroup.qualityStandardVersionId,
      inspectedAt: await f.owners.clock(context), segregationConfirmed: true, idempotencyKey: randomUUID(),
      groups: [{ key: "rechecked", label: "Synthetic actual reinspection passed physical bin", quantity: oldGroup.quantity,
        criterionResults: oldGroup.criterionResults, defects: [] }],
    }));
    const replacements = reinspected.workspace.groups.filter(group => group.parentGroupId === oldGroup.id && group.active);
    expect(replacements.length).toBe(1); const replacement = replacements[0]; if (!replacement) throw new Error("actual_reinspection_replacement_missing");
    expect(reinspected.workspace.groups.find(group => group.id === oldGroup.id)?.active).toBe(false);
    expect(replacement.result).toBe("passed"); expect(replacement.quantity).toBe(3); expect(replacement.id === oldGroup.id).toBe(false);
    expect(replacement.inspectionId).toBe(reinspected.inspectionId); expect(replacement.inspectionId === oldGroup.inspectionId).toBe(false);
    const fresh = await f.workspace(orderId);
    expect(fresh.canCreate).toBe(true); expect(fresh.sources.some(source => source.qualityGroupId === oldGroup.id)).toBe(false);
    expect(fresh.sources.find(source => source.qualityGroupId === replacement.id)?.availableQuantity).toBe(3);
    const qualityAfter = await qualityCounts();
    // These are real original-owner QC appends. They are intentionally separate
    // from the nine shipment tables which must have no write at either stage.
    expect(qualityAfter.inspections - qualityBefore.inspections).toBe(1);
    expect(qualityAfter.groups - qualityBefore.groups).toBe(1); expect(qualityAfter.reinspections - qualityBefore.reinspections).toBe(1);
    expect(await f.shipmentState(orderId)).toEqual(shipmentBefore); expect(await binding()).toEqual(fixed);
    const outcome = await native.fulfillmentCommands.confirm(context, intentId, proof)
      .then(result => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
    if (outcome.result) {
      expect(outcome.result.native.status).toBe("rejected"); expect(outcome.result.canConfirm).toBe(false); expect(outcome.result.native.receipt === null).toBe(true);
    } else {
      const failure = outcome.error;
      const status = failure && typeof failure === "object" && "getStatus" in failure && typeof failure.getStatus === "function"
        ? Number(failure.getStatus()) : failure && typeof failure === "object" && "status" in failure ? Number(failure.status) : null;
      expect(status === 409 || status === 422).toBe(true);
    }
    expect(await f.shipmentState(orderId)).toEqual(shipmentBefore); expect(await binding()).toEqual(fixed);
    expect(await originalCount(value.item.id)).toBe(1); expect(native.calls.prepare).toBe(prepareCalls); expect(native.modelCalls.length).toBe(paid);
    expect(native.original.calls.ownerCompleted).toBe(ownerCompleted);
  });
});
