import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AGENT_FULFILLMENT_TOOL, AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema, AgentFulfillmentCandidatesSchema,
  AgentFulfillmentDefinitionSchema, AgentFulfillmentResultSchema, agentFulfillmentDataPayload } from "@yummyai/contracts/ai/agent-fulfillment";
import { verifyAgentFulfillmentCandidates, verifyAgentFulfillmentDefinition, verifyAgentFulfillmentResult } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import { AGENT_MCP_TOOL_NAMES } from "@yummyai/contracts/ai/agent-mcp";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ReviewFactoryErpVoidSchema } from "@yummyai/contracts/order/factory-erp-void-review";
import { connectDatabase, orderProtectedDetails, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentFulfillmentFixture, fulfillmentHash, requireAgentFulfillmentEnvironment } from "./agent-fulfillment.test-fixture.js";
import { openResourceMcpClient } from "./agent-resources.test-fixture.js";

requireAgentFulfillmentEnvironment();
const all = Object.values(Permission), journal = new URL("../../../../packages/database/migrations/meta/_journal.json", import.meta.url);
function status(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("getStatus" in error && typeof error.getStatus === "function") return error.getStatus();
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  return "cause" in error ? status(error.cause) : undefined;
}
function code(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  if ("getResponse" in error && typeof error.getResponse === "function") { const value: unknown = error.getResponse(); if (value && typeof value === "object" && "code" in value) return value.code; }
  return "code" in error ? error.code : "cause" in error ? code(error.cause) : undefined;
}
const denied = (expected: number, expectedCode?: string) => (error: unknown) => status(error) === expected && (expectedCode === undefined || code(error) === expectedCode);
const gate = () => { let release!: () => void; const promise = new Promise<void>(accept => { release = accept; }); return { promise, release }; };
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 30_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

describe.sequential("same-order original fulfillment tools with no business or paid side effects", () => {
  const database = connectDatabase(), f = agentFulfillmentFixture(database);
  let journalBefore: string;
  beforeAll(async () => { journalBefore = fulfillmentHash(await readFile(journal)); await f.initialize(); }, 180_000);
  afterEach(async () => { vi.restoreAllMocks(); await f.grant(); });
  afterAll(async () => {
    vi.restoreAllMocks(); const errors: unknown[] = [];
    try { expect(fulfillmentHash(await readFile(journal))).toBe(journalBefore); } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Fulfillment acceptance cleanup or unchanged migration proof failed");
  });
  type Scene = Awaited<ReturnType<typeof f.owners.seed>>;
  async function read(context: TenantContext, scene: Scene, kind: "production" | "shipments" | "logistics", size = 5) {
    const call = await f.request(context, scene.order.id, kind, size), value = AgentFulfillmentResultSchema.parse(await f.service().call(context, call));
    await verifyAgentFulfillmentResult(value, call); return { call, value };
  }

  it("reads the actual formal JPG release and submitted original without inventing factory acceptance or internal completion", async () => {
    const context = await f.current(), scene = await f.owners.seed(context), before = await f.owners.state(context);
    const actualItems = await f.owners.work.orderItems(context, scene.order.lines[0]!.id);
    expect(actualItems.orderSequence).toBe((await f.owners.orders.get(context, scene.order.id)).latestEventSequence);
    const workspace = await f.service().workspace(context), definition = await f.service().definition(context, { version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL });
    await verifyAgentFulfillmentDefinition(definition); expect(definition.definitionChecksum).toBe(workspace.definition.definitionChecksum);
    const query = { version: AGENT_FULFILLMENT_VERSION, filters: { accountId: scene.accountId, limit: 50 } } as const;
    const candidates = AgentFulfillmentCandidatesSchema.parse(await f.service().candidates(context, query)); await verifyAgentFulfillmentCandidates(candidates, query);
    expect(candidates.items.map(item => item.id)).toEqual([scene.order.id]); expect(candidates.coverage.complete).toBe(false);
    const { value } = await read(context, scene, "production"); if (value.data.kind !== "production") throw new Error("Actual production page expected");
    expect(value.data.rows).toHaveLength(1); const row = value.data.rows[0]!, original = scene.productions[0]!, item = scene.packet.items[0]!;
    expect(row).toMatchObject({ id: original.order.id, orderId: scene.order.id, orderLineId: original.lineId, quantity: 5,
      currentVersionId: original.version.id, status: "submitted", delivery: { state: "read", data: { status: "submitted", sequence: 1, fileChecksum: item.snapshot!.file.checksum,
        manufacturingContentChecksum: item.snapshot!.manufacturing!.sourceContentChecksum, manufacturingPlanChecksum: item.snapshot!.manufacturing!.plan.checksum, fileSourceAvailable: true } },
      factory: { state: "not_present", data: null } });
    expect(row.milestones.map(event => event.type)).toEqual(["submitted"]);
    expect(row.quality.data?.groups).toEqual([]); expect(value.data.coverage).toMatchObject({ indexedTotal: 1, returned: 1, complete: false, hasMore: false });
    expect(row.manufacturing?.productionVersionId).toBe(original.version.id);
    expect(await f.owners.state(context)).toEqual(before); expect(f.owners.carrier.calls.creates).toBe(0);
  }, 180_000);

  it("preserves exact Excel observation provenance and void anomalies without fabricating QC actual quantity or carrier handover", async () => {
    const context = await f.current(), scene = await f.owners.seed(context), production = scene.productions[0]!;
    const physicalBefore = await f.facts.physicalState();
    const scheduled = await f.owners.observe(context, scene, "已审核");
    let result = (await read(context, scene, "production")).value; if (result.data.kind !== "production") throw new Error("Actual production page expected");
    expect(result.data.rows[0]!.factory.data).toMatchObject({ status: "scheduled", rawStatus: "已审核", importId: scheduled.view.id, shippedQuantity: null });
    const shipped = await f.owners.observe(context, scene, "已出库");
    await f.owners.observe(context, scene, "已审核"); const voided = await f.owners.observe(context, scene, "已作废");
    result = (await read(context, scene, "production")).value; if (result.data.kind !== "production") throw new Error("Actual production page expected");
    expect(result.data.rows[0]!.factory.data).toMatchObject({ status: "shipped", exception: "voided_requires_review", rawStatus: "已出库", importId: shipped.view.id, shippedQuantity: null });
    expect(result.sources.some(source => source.owner === "factory_erp" && source.versionId === shipped.view.id)).toBe(true);
    expect(voided.application.observations[0]!.disposition).toBe("exception");
    const originalVoid = voided.application.observations[0]!;
    const detail = await f.owners.imports.voidObservation(context, originalVoid.bindingId, originalVoid.observationId);
    const { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt } = detail.observation;
    const review = await f.owners.imports.reviewVoid(context, originalVoid.bindingId, ReviewFactoryErpVoidSchema.parse({
      expectedBindingRevision: detail.basis.bindingRevision, expectedItemsChecksum: detail.basis.itemsChecksum,
      expectedObservationSequence: detail.basis.observationSequence,
      observation: { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt },
      expectedPreviousReviewId: detail.observation.latestReview?.id ?? null,
      source: { importId: voided.view.id, rowNumber, fileChecksum: voided.view.fileChecksum, previewChecksum: voided.view.previewChecksum },
      outcome: "confirmed_voided", reasonCode: "factory_contact", provenance: "operator_attested", confirmed: true, idempotencyKey: createEntityId(),
    }));
    const reviewedState = await f.owners.state(context);
    result = (await read(context, scene, "production")).value; if (result.data.kind !== "production") throw new Error("Actual production page expected");
    expect(result.data.rows[0]!.factory.data).toMatchObject({ status: "shipped", exception: null, rawStatus: "已出库", importId: shipped.view.id, shippedQuantity: null,
      voidSummary: { total: 1, pending: 0, requiresOrderHandling: 1, nextPending: null,
        latest: { id, latestReview: { id: review.id, outcome: "confirmed_voided", reasonCode: "factory_contact", provenance: "operator_attested" } } } });
    expect(result.sources).toEqual(expect.arrayContaining([
      { owner: "factory_erp", kind: "factory_void_observation", id, versionId: importId, revision: sequence, checksum: rowChecksum },
      { owner: "factory_erp", kind: "factory_void_review", id: review.id, versionId: id, revision: review.reviewRevision, checksum: review.requestChecksum },
    ]));
    expect(await f.owners.state(context)).toEqual(reviewedState);
    expect(result.data.rows[0]!.status).toBe("submitted"); expect(result.data.rows[0]!.quality.data?.groups).toEqual([]);
    expect((await f.owners.production.get(context, production.order.id)).milestones.map(event => event.type)).toEqual(["submitted"]);
    expect((await read(context, scene, "shipments")).value.data.rows).toEqual([]);
    expect(await f.facts.physicalState()).toEqual(physicalBefore);
  }, 180_000);

  it("keeps original quality groups physical shipment and stored logistics money separate on the same actual order", async () => {
    const context = await f.current(), scene = await f.owners.seed(context, [5], { usLogistics: true });
    const task = await f.owners.logisticsTask(context, scene), logisticsBefore = await read(context, scene, "logistics");
    if (logisticsBefore.value.data.kind !== "logistics") throw new Error("Actual logistics page expected");
    expect(logisticsBefore.value.data.rows[0]).toMatchObject({ id: task.taskId, status: "completed", quotedCostMinor: 500, actualCostMinor: 600,
      quotedCurrency: "USD", actualCurrency: "USD", minorUnitDigits: 2, trackingCount: 1, labelCount: 0 });
    expect((await read(context, scene, "shipments")).value.data.rows).toEqual([]);
    const quality = await f.owners.quality(context, scene, 3), shipment = await f.owners.shipment(context, scene);
    const beforeRejectedWriteback = await f.owners.state(context), enqueuesBeforeRejectedWriteback = f.owners.shipmentEnqueues.length;
    await expect(f.owners.shipping.requestWriteback(context, shipment.shipment.id, { shipmentVersionId: shipment.versions[0]!.id, idempotencyKey: randomUUID() }))
      .rejects.toSatisfy(error => status(error) === 409 && error instanceof Error && error.message === "Order is not eligible for shipment writeback");
    expect(await f.owners.state(context)).toEqual(beforeRejectedWriteback); expect(f.owners.shipmentEnqueues.length).toBe(enqueuesBeforeRejectedWriteback);
    expect((await f.owners.orders.get(context, scene.order.id)).workflowState).toBe("in_production");
    let shipmentPage = (await read(context, scene, "shipments")).value;
    if (shipmentPage.data.kind !== "shipments") throw new Error("Actual shipment page expected");
    expect(shipmentPage.data.rows[0]!.physicalHandover).toMatchObject({ dispatchedPackageCount: 0, allDispatched: false });
    expect(shipmentPage.data.rows[0]!.writebacks).toEqual([]);
    await f.owners.shipping.dispatch(context, shipment.shipment.id, { expectedVersion: 1, reason: "Synthetic operator observed this original package pickup", occurredAt: await f.owners.clock(context), idempotencyKey: randomUUID() });

    // A separate fully passed order can advance through the original transition gates.
    // Its platform acknowledgement remains independent of the primary order's physical pickup.
    const acceptedScene = await f.owners.seed(context, [3]);
    await f.owners.quality(context, acceptedScene, 3);
    let acceptedOrder = await f.owners.orders.get(context, acceptedScene.order.id);
    for (const toState of ["awaiting_quality_control", "awaiting_shipment"] as const)
      acceptedOrder = await f.owners.orders.transition(context, acceptedOrder.id, { toState, expectedSequence: acceptedOrder.latestEventSequence,
        idempotencyKey: randomUUID(), reason: "Synthetic operator verified every original production and quality group passed" });
    expect(acceptedOrder.workflowState).toBe("awaiting_shipment");
    const acceptedShipment = await f.owners.shipment(context, acceptedScene);
    const submitted = await f.owners.shipping.requestWriteback(context, acceptedShipment.shipment.id, { shipmentVersionId: acceptedShipment.versions[0]!.id, idempotencyKey: randomUUID() });
    await f.owners.shipping.recordWritebackEvent(context, submitted.request.id, { action: "dispatched", expectedProjectionVersion: 1, providerCode: "SYNTHETIC_HTTP_200", externalReference: "synthetic-platform-submission", occurredAt: await f.owners.clock(context) });
    await f.owners.shipping.recordWritebackEvent(context, submitted.request.id, { action: "accepted", expectedProjectionVersion: 2, providerCode: "SYNTHETIC_HTTP_200", externalReference: "synthetic-platform-ack", occurredAt: await f.owners.clock(context) });
    const before = await f.owners.state(context), carrierBefore = { ...f.owners.carrier.calls }, enqueuesBefore = [f.owners.logisticsEnqueues.length, f.owners.shipmentEnqueues.length];
    const acceptedPage = (await read(context, acceptedScene, "shipments")).value; if (acceptedPage.data.kind !== "shipments") throw new Error("Actual acknowledged shipment page expected");
    expect(acceptedPage.data.rows[0]!.writebacks[0]!.status).toBe("accepted");
    expect(acceptedPage.data.rows[0]!.physicalHandover).toMatchObject({ packageCount: 1, dispatchedPackageCount: 0, allDispatched: false });
    const production = (await read(context, scene, "production")).value; shipmentPage = (await read(context, scene, "shipments")).value;
    if (production.data.kind !== "production" || shipmentPage.data.kind !== "shipments") throw new Error("Actual same-order pages expected");
    expect(production.data.rows[0]!.quality.data?.groups.map(group => [group.quantity, group.result]).sort()).toEqual([[2, "failed"], [3, "passed"]]);
    expect(production.data.rows[0]!.quality.data?.rootInspectionId).toBe(quality.inspectionId);
    expect(shipmentPage.data.rows[0]!.allocations[0]).toMatchObject({ productionOrderId: scene.productions[0]!.order.id, productionVersionId: scene.productions[0]!.version.id,
      qualityInspectionId: quality.inspectionId, quantity: 3 });
    expect(shipmentPage.data.rows[0]!.physicalHandover).toMatchObject({ packageCount: 1, dispatchedPackageCount: 1, allDispatched: true });
    await read(context, scene, "logistics");
    expect(await f.owners.state(context)).toEqual(before); expect(f.owners.carrier.calls).toEqual(carrierBefore);
    expect([f.owners.logisticsEnqueues.length, f.owners.shipmentEnqueues.length]).toEqual(enqueuesBefore);
  }, 180_000);

  it("pages all three real same-order indexes beyond ten without duplicate omissions or complete claims and rejects changed continuations", async () => {
    const context = await f.current(), scene = await f.owners.seed(context, [35, ...Array<number>(10).fill(1)], { usLogistics: true });
    await f.owners.quality(context, scene, 35);
    for (let index = 0; index < 11; index++) { await f.owners.shipment(context, scene); await f.owners.logisticsTask(context, scene, false, index); }
    const before = await f.owners.state(context);
    for (const kind of ["production", "shipments", "logistics"] as const) {
      const first = await read(context, scene, kind, 10); expect(first.value.data.rows).toHaveLength(10);
      expect(first.value.data.coverage).toMatchObject({ indexedTotal: 11, complete: false, hasMore: true });
      const continuation = AgentFulfillmentCallSchema.parse({ ...first.call, input: { ...first.call.input, cursor: first.value.data.coverage.nextCursor } });
      const second = AgentFulfillmentResultSchema.parse(await f.service().call(context, continuation)); await verifyAgentFulfillmentResult(second, continuation);
      expect(second.data.rows).toHaveLength(1); expect(second.data.coverage).toMatchObject({ indexedTotal: 11, complete: false, hasMore: false, nextCursor: null });
      expect(new Set([...first.value.data.rows, ...second.data.rows].map(row => row.id)).size).toBe(11);
      for (const altered of [{ ...continuation, input: { ...continuation.input, pageSize: 5 } },
        { ...continuation, input: { ...continuation.input, kind: kind === "production" ? "shipments" : "production" } },
        { ...continuation, input: { ...continuation.input, cursor: "malformed-original-cursor" } }])
        await expect(f.service().call(context, altered)).rejects.toSatisfy(error => [400, 409].includes(status(error) ?? 0));
    }
    expect(await f.owners.state(context)).toEqual(before);
    const original = await f.request(context, scene.order.id, "production");
    await f.owners.orders.openException(context, scene.order.id, { category: "production", code: "SYNTHETIC_SEQUENCE_ADVANCED", message: "Synthetic original order evidence advanced", idempotencyKey: randomUUID() });
    await expect(f.service().call(context, original)).rejects.toSatisfy(denied(409, "agent_fulfillment_source_changed"));
  }, 240_000);

  it("enforces fresh per-bit tenant membership and cross-tenant RLS then discards a real late owner response after authority narrows", async () => {
    const context = await f.current(), scene = await f.owners.seed(context); await f.owners.observe(context, scene, "已出库");
    const original = await f.request(context, scene.order.id, "production");
    await expect(f.service().call(await f.current(f.facts.base.foreign), original)).rejects.toSatisfy(denied(404));
    for (const bit of [Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead]) {
      await f.grant([bit], "self", all.filter(value => value !== bit)); const current = await f.current();
      expect(current.dataScope).toBe("tenant"); const packet = AgentFulfillmentResultSchema.parse(await f.service().call(current, original));
      if (packet.data.kind !== "production") throw new Error("Actual production page expected");
      expect(packet.data.rows[0]!.factory).toEqual({ state: "unavailable", reason: "permission_required", data: null });
      if (bit === Permission.OrderPiiRead) await expect(f.service().call(current, { ...original, input: { ...original.input, kind: "logistics" } })).rejects.toSatisfy(denied(403));
    }
    await f.grant([Permission.OrderRead], "self", all.filter(value => value !== Permission.OrderRead));
    await expect(f.service().call(await f.current(), original)).rejects.toSatisfy(denied(403)); await f.grant();
    const entered = gate(), release = gate(), nativeGet = f.owners.production.get.bind(f.owners.production); let held = false;
    vi.spyOn(f.owners.production, "get").mockImplementation(async (...args) => { const actual = await nativeGet(...args); if (!held) { held = true; entered.release(); await release.promise; } return actual; });
    const pending = f.service().call(context, original); void pending.catch(() => {});
    try { await bounded(entered.promise, "actual_owner_response_gate_not_reached"); await f.grant([Permission.OrderRead], "self", all.filter(value => value !== Permission.OrderRead)); release.release();
      await expect(pending).rejects.toSatisfy(denied(409, "authority_changed")); }
    finally { release.release(); await pending.catch(() => {}); await f.grant(); }
  }, 180_000);

  it("rechecks actual changed factory evidence after owner I/O and preserves original sealed projections instead of substituting newer facts", async () => {
    const context = await f.current(), scene = await f.owners.seed(context); await f.owners.observe(context, scene, "已审核");
    const original = await read(context, scene, "production"), sealed = canonicalJson(agentFulfillmentDataPayload(original.value));
    const entered = gate(), release = gate(), nativeGet = f.owners.delivery.get.bind(f.owners.delivery); let held = false;
    vi.spyOn(f.owners.delivery, "get").mockImplementation(async (...args) => { const actual = await nativeGet(...args); if (!held) { held = true; entered.release(); await release.promise; } return actual; });
    const pending = f.service().call(context, original.call); void pending.catch(() => {});
    try { await bounded(entered.promise, "actual_delivery_response_gate_not_reached"); await f.owners.observe(context, scene, "已出库"); const changed = await f.owners.state(context); release.release();
      await expect(pending).rejects.toSatisfy(denied(409, "agent_fulfillment_source_changed")); expect(await f.owners.state(context)).toEqual(changed); }
    finally { release.release(); await pending.catch(() => {}); }
    vi.restoreAllMocks(); expect(canonicalJson(agentFulfillmentDataPayload(original.value))).toBe(sealed);
    const current = (await read(context, scene, "production")).value; if (current.data.kind !== "production") throw new Error("Actual production page expected");
    expect(current.data.rows[0]!.factory.data?.status).toBe("shipped"); expect(original.value.dataChecksum).not.toBe(current.dataChecksum);
    const restarted = f.service(); expect((await restarted.call(context, original.call)).dataChecksum).toBe(current.dataChecksum);
  }, 180_000);

  it("uses official MCP stdio with real OIDC and only discovered fulfillment schema candidates and contract while disabled startup never reaches the owner", async () => {
    const context = await f.current(), scene = await f.owners.seed(context), origin = await f.startHttp(), token = await f.token();
    const identityResponse = await fetch(origin + "/v1/identity/session", { headers: { authorization: `Bearer ${token}` } });
    expect(identityResponse.status).toBe(200); const identity = ErpSessionViewSchema.parse(await identityResponse.json());
    expect([identity.userId, identity.tenantId, erpSessionAuthority(identity)]).toEqual([context.userId, context.tenantId, f.stamp(context)]);
    const disabled = await openResourceMcpClient(origin, token), index = vi.spyOn(f.owners.production, "evidenceIndex");
    try { expect((await disabled.client.listTools()).tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(AGENT_MCP_TOOL_NAMES).sort());
      const result = await disabled.client.callTool({ name: AGENT_MCP_TOOL_NAMES.schema, arguments: { key: "fulfillment/orders.fulfillment" } });
      expect(result.isError === true).toBe(true); expect(index).not.toHaveBeenCalled(); }
    finally { await disabled.close(); }
    const sdk = await openResourceMcpClient(origin, token, ["--allow-fulfillment"]), before = await f.owners.state(context);
    try {
      const schema = await sdk.call(AGENT_MCP_TOOL_NAMES.schema, { key: "fulfillment/orders.fulfillment" }); expect(schema.isError).toBe(false);
      const definition = AgentFulfillmentDefinitionSchema.parse(schema.packet.data.definition); await verifyAgentFulfillmentDefinition(definition);
      const query = { version: AGENT_FULFILLMENT_VERSION, filters: { accountId: scene.accountId, limit: 50 } } as const;
      const candidateResult = await sdk.call(AGENT_MCP_TOOL_NAMES.execute, { operation: "read", requestJson: JSON.stringify({ version: AGENT_FULFILLMENT_VERSION, kind: "candidates", query }) });
      expect(candidateResult.isError).toBe(false); const candidates = AgentFulfillmentCandidatesSchema.parse(candidateResult.packet.data); await verifyAgentFulfillmentCandidates(candidates, query);
      const selected = candidates.items.find(item => item.id === scene.order.id); expect(selected !== undefined).toBe(true);
      const call = AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL,
        executionContract: schema.packet.data.executionContract, definitionChecksum: definition.definitionChecksum,
        input: { orderId: selected!.id, expectedSequence: selected!.expectedSequence, kind: "production", cursor: null, pageSize: 5 } });
      const actual = await sdk.call(AGENT_MCP_TOOL_NAMES.execute, { operation: "read", requestJson: JSON.stringify(call) }); expect(actual.isError).toBe(false);
      const result = AgentFulfillmentResultSchema.parse(actual.packet.data); await verifyAgentFulfillmentResult(result, call); expect(result.data.rows).toHaveLength(1);
      expect(result.modelCalled).toBe(false); expect(result.businessExecuted).toBe(false); expect(await f.owners.state(context)).toEqual(before);
    } finally { await sdk.close(); }
    expect(sdk.evidence).toMatchObject({ closed: true, processExited: true, credentialLeaked: false });
    const expired = await f.token(f.facts.base.owner, -1), deniedResponse = await fetch(origin + "/v1/agent-fulfillment/workspace", { headers: { authorization: `Bearer ${expired}` } });
    expect(deniedResponse.status).toBe(401);
  }, 180_000);

  it("distinguishes empty unavailable and anonymized original sources and rejects malformed write-shaped calls without mutation or migration", async () => {
    const context = await f.current(), scene = await f.owners.seed(context, [5], { usLogistics: true }), original = await f.request(context, scene.order.id, "production");
    const initial = await f.owners.initialOrder(context, scene.accountId);
    // The original DB constraint requires >0 and its default is 1; no illegal sequence-zero history is fabricated.
    expect(initial.latestEventSequence).toBe(1);
    const candidates = AgentFulfillmentCandidatesSchema.parse(await f.service().candidates(context, { version: AGENT_FULFILLMENT_VERSION, filters: { accountId: scene.accountId, limit: 50 } }));
    expect(candidates.items.map(item => item.id).sort()).toEqual([scene.order.id, initial.id].sort());
    expect(candidates.items.find(item => item.id === initial.id)?.expectedSequence).toBe(1);
    for (const kind of ["shipments", "logistics"] as const) { const value = (await read(context, scene, kind)).value;
      expect(value.data.rows).toEqual([]); expect(value.data.coverage).toMatchObject({ indexedTotal: 0, returned: 0, complete: false, hasMore: false }); }
    const before = await f.owners.state(context);
    for (const invalid of [{ ...original, execute: true }, { ...original, input: { ...original.input, pageSize: 11 } },
      { ...original, input: { ...original.input, expectedSequence: 0 } }, { ...original, input: { ...original.input, url: "https://synthetic.invalid" } },
      { ...original, definitionChecksum: "0".repeat(64) }, { ...original, executionContract: { ...original.executionContract, checksum: "0".repeat(64) } }])
      await expect(f.service().call(context, invalid)).rejects.toSatisfy(error => [400, 409].includes(status(error) ?? 0));
    await expect(f.service().call(context, { ...original, input: { ...original.input, orderId: createEntityId() } })).rejects.toSatisfy(denied(404));
    expect(await f.owners.state(context)).toEqual(before);
    const task = await f.owners.logisticsTask(context, scene);
    const [protectedRow] = await withTenant(database.db, context, tx => tx.select({ envelopeVersion: orderProtectedDetails.envelopeVersion,
      retentionExpiresAt: orderProtectedDetails.retentionExpiresAt }).from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, scene.order.id)));
    const order = await f.owners.orders.get(context, scene.order.id);
    const anonymize = { expectedSequence: order.latestEventSequence, expectedEnvelopeVersion: protectedRow!.envelopeVersion,
      reason: "Synthetic original privacy owner clock boundary after its actual retention deadline", idempotencyKey: randomUUID() };
    const beforePrematurePrivacy = await f.owners.state(context);
    await expect(f.owners.orders.anonymizeProtectedDetails(context, scene.order.id, anonymize))
      .rejects.toSatisfy(error => status(error) === 409 && error instanceof Error && error.message === "Protected detail retention period has not expired");
    expect(await f.owners.state(context)).toEqual(beforePrematurePrivacy);
    // Only the original privacy owner's existing test clock advances; no DB, DDL or global clock is changed.
    await f.owners.orders.anonymizeProtectedDetails(context, scene.order.id, anonymize, new Date(protectedRow!.retentionExpiresAt.getTime() + 1));
    const state = await f.owners.state(context), hidden = (await read(context, scene, "logistics")).value;
    if (hidden.data.kind !== "logistics") throw new Error("Actual logistics page expected");
    expect(hidden.data.rows[0]).toMatchObject({ id: task.taskId, privateAvailable: false, trackingCount: null, labelCount: null });
    const text = JSON.stringify(hidden); expect(text.includes("SYNTHETIC_PRIVATE_FULFILLMENT")).toBe(false); expect(text.includes("synthetic-fulfillment-secret")).toBe(false);
    expect(await f.owners.state(context)).toEqual(state); expect(fulfillmentHash(await readFile(journal))).toBe(journalBefore);
  }, 180_000);
});
