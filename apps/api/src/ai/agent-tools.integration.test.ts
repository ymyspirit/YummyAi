import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type * as Psd from "../../../../packages/mockup-renderer/node_modules/ag-psd/dist/index.js";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { createEntityId, CreateMockupTemplateInspectionInputSchema, type TenantContext } from "@yummyai/contracts";
import { CreateProductSpuSchema } from "@yummyai/contracts/catalog/development";
import { FactoryGrantCreateSchema, FactoryTaskAssignSchema } from "@yummyai/contracts/suppliers/factory-portal";
import { AGENT_TOOLS_VERSION, type AgentToolKey } from "@yummyai/contracts/ai/agent-tools";
import { type KnowledgeFields } from "@yummyai/contracts/knowledge";
import { connectDatabase, withTenant, memberships, factoryAccessGrants, factoryTaskAssignments, readMigrationEvidence, assertDatabaseMigrationsCurrent } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { roleBenchmarkOwners, roleEnvelope } from "../../../../tools/testing/role-benchmark-fixture.mjs";
import { MockupTemplateCompileProcessor } from "../../../worker/src/processors/pod-batch-workflow.processor.js";
import { CreativeExecutionOperatorService } from "../design/creative-execution-operator.service.js";
import { factoryErpImportFixture } from "../orders/factory-erp-import.test-fixture.js";
import { FactoryCollaborationService } from "../orders/factory-collaboration.service.js";
import { factoryCursor } from "../orders/factory-pagination.js";
import { agentReadFixture, bounded, deferred } from "./agent-read.test-fixture.js";
import { agentCommandOwners } from "./agent-command.test-fixture.js";
import { AgentToolOwners } from "./agent-tool-owners.js";
import { AgentToolsService } from "./agent-tools.service.js";

const environment = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(environment.pathname)?.[1];
const flags = ["E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_FACTORY_ERP_IMPORT_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED",
  "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED"];
const redis = process.env.E2E_DISPOSABLE_REDIS_URL;
if (!nonce || flags.some(key => process.env[key] !== "1") || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
  process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || process.env.REDIS_URL !== redis ||
  process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redis).hostname))
  throw new Error("Native Agent tools require every opted-in exact disposable nonce resource before connection");
const database = connectDatabase(environment.href), original = factoryErpImportFixture(database), base = agentReadFixture(database);
const facts = roleBenchmarkOwners(database, original.base.vault, { assistVault: base.vault });
const creative = new CreativeExecutionOperatorService(database), commands = agentCommandOwners(database, { contentVault: base.vault });
const owners = new AgentToolOwners(base.knowledge, creative, original.base.capacity, base.gateway());
const service = () => new AgentToolsService(database, base.integrationVault, owners, commands.adapter);
const all = Object.values(Permission), letters = () => randomUUID().replace(/[0-9]/g, value => String.fromCharCode(97 + Number(value))).replaceAll("-", "");
const checksum = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const journalPath = new URL("../../../../packages/database/migrations/meta/_journal.json", import.meta.url);
let context: TenantContext, peer: TenantContext, scene: Awaited<ReturnType<typeof original.scene>>, ownInspection: string, peerInspection: string;
let ownSpu: string, peerSpu: string, stock: { id: string; locationId: string }, query: string, draftId: string, journal: string;
const published: string[] = [];
const call = async (tool: AgentToolKey, input: unknown, caller = context) => {
  const workspace = await service().workspace(caller), definition = await service().definition(caller, { version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool } });
  return { version: AGENT_TOOLS_VERSION, executionContract: workspace.executionContract, definitionChecksum: definition.definitionChecksum, tool, input };
};
const snapshot = () => withTenant(database.db, context, async tx => {
  const value: Record<string, { count: number; digest: string }> = {};
  for (const table of ["ai_budget_ledger", "ai_assist_runs", "ai_assist_executions", "agent_command_requests", "agent_loop_runs", "agent_plan_runs", "creative_executions",
    "factory_capacity_reservations", "factory_capacity_events", "production_orders", "production_delivery_feedback", "inventory_movements", "finance_original_write_proofs", "audit_events"])
    value[table] = (await tx.execute<{ count: number; digest: string }>(sql`select count(*)::int as count,
      md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from ${sql.identifier(table)} t`))[0]!;
  return { tables: value, dispatches: base.dispatches.length, providerRequests: base.providerRequests.length };
});
async function card(title: string, publish: boolean) {
  const fields: KnowledgeFields = { title, summary: title, body: query + " synthetic reviewed native evidence", topic: "operations", platform: "all", market: "ALL", spuId: null,
    sourceType: "team", sourceLabel: "Synthetic operator-reviewed source", sourceUrl: "", owner: "Synthetic reader", verifiedOn: "2026-01-01", reviewDueOn: "2099-12-31", tags: [] };
  const value = await base.knowledge.save(context, null, { fields, expectedRevision: 0, reason: "Synthetic native tool source", requestId: randomUUID() });
  if (publish) {
    await base.knowledge.change(context, value.id, "submit", { expectedRevision: 1, version: 1, reason: "Synthetic source explicitly reviewed", requestId: randomUUID() });
    await base.knowledge.change(context, value.id, "publish", { expectedRevision: 2, version: 1, reason: "Synthetic source explicitly published", requestId: randomUUID() });
  }
  return value.id;
}
async function inspection(actor: TenantContext) {
  const source = await readFile(new URL("../../../../packages/mockup-renderer/fixtures/controlled-canvas.psd", import.meta.url));
  const psd = createRequire(new URL("../../../../packages/mockup-renderer/package.json", import.meta.url))("ag-psd") as typeof Psd;
  const document = psd.readPsd(source, { useImageData: true, skipThumbnail: true }), slotKey = "main-" + actor.userId;
  const slot = document.children?.find(layer => layer.name === "@slot:main");
  if (!slot) throw new Error("Original controlled PSD slot missing");
  // A valid distinct slot name gives each actor a genuinely distinct file and
  // owner execution; uploading identical bytes would correctly reuse the first.
  slot.name = "@slot:" + slotKey;
  const bytes = psd.writePsdBuffer(document, { generateThumbnail: false });
  const asset = await facts.ownedAsset(actor, bytes, "synthetic-native-tools.psd", "image/vnd.adobe.photoshop");
  const result = await facts.mockups.createInspection(actor, CreateMockupTemplateInspectionInputSchema.parse({ sourceAssetId: asset.id,
    sourceAssetVersion: asset.version, checksumSha256: asset.checksumSha256, slotKey }));
  const [originalActor] = await withTenant(database.db, actor, tx => tx.execute<{ requestedBy: string }>(sql`select requested_by as "requestedBy" from creative_executions where inspection_id=${result.id}::uuid`));
  expect(originalActor?.requestedBy).toBe(actor.userId);
  await new MockupTemplateCompileProcessor(database, facts.storage).process(roleEnvelope(actor, { inspectionId: result.id }));
  const native = await creative.history(actor, "inspection", result.id);
  if (!native.entries.some(entry => entry.phase === "completed")) throw new Error("Actual controlled PSD compile did not produce a completed native execution");
  return result.id;
}

describe.sequential("independent Agent native reads with real owners and unchanged current history", () => {
  beforeAll(async () => {
    journal = await readFile(journalPath, "utf8");
    expect((await readMigrationEvidence(database)).actualRows).toEqual((await readMigrationEvidence(database)).canonicalRows);
    await assertDatabaseMigrationsCurrent(database); await original.initialize(); await base.initialize(); await facts.initialize();
    context = await original.base.current(); peer = await original.actor(); scene = await original.scene({ quantities: [1, 1, 1] });
    query = "Synthetic native tools " + letters();
    for (let index = 0; index < 7; index++) published.push(await card(query + " " + String.fromCharCode(97 + index), true));
    draftId = await card(query + " unpublished", false);
    ownInspection = await inspection(context); peerInspection = await inspection(peer);
    ownSpu = (await facts.development.createSpu(context, CreateProductSpuSchema.parse({ code: "SPU-" + createEntityId().slice(-12).toUpperCase(), name: "Synthetic native own SPU", idempotencyKey: randomUUID() }))).spu.id;
    peerSpu = (await facts.development.createSpu(peer, CreateProductSpuSchema.parse({ code: "SPU-" + createEntityId().slice(-12).toUpperCase(), name: "Synthetic native peer SPU", idempotencyKey: randomUUID() }))).spu.id;
    const suffix = createEntityId().slice(-12).toUpperCase(), warehouse = await base.inventory.createWarehouse(context, { code: "WH-" + suffix, name: "Synthetic native tools", type: "owned", countryCode: "US", timeZone: "UTC" });
    const item = await base.inventory.createStockItem(context, { code: "MAT-" + suffix, name: "Synthetic exact quantity", baseUnit: "meter", skuId: null });
    const location = await base.inventory.createLocation(context, { warehouseId: warehouse.id, code: "LOC-" + suffix, name: "Synthetic native location" });
    await base.inventory.recordMovement(context, { stockItemId: item.id, locationId: location.id, lotId: null, bucket: "physical", type: "opening", quantityDelta: "1.000000001",
      unit: "meter", sourceType: "opening", sourceId: "native-tools-isolated", reasonCode: "INITIAL_COUNT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    stock = { id: item.id, locationId: location.id };
  }, 120_000);
  afterEach(async () => { vi.restoreAllMocks(); await original.base.grant(); });
  afterAll(async () => {
    const errors: unknown[] = [];
    try { expect(await readFile(journalPath, "utf8")).toBe(journal); const evidence = await readMigrationEvidence(database); expect(evidence.actualRows).toEqual(evidence.canonicalRows); } catch (error) { errors.push(error); }
    try { facts.close(); original.dispose(); base.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native tool fixture validation or teardown failed");
  });

  it("discovers five actual readers and one of37 original definitions without preparing executing or altering a paid ledger or the old v1 pin", async () => {
    const before = await snapshot(), old = await base.gateway().workspace(context), workspace = await service().workspace(context);
    expect(workspace).toMatchObject({ version: AGENT_TOOLS_VERSION, modelExecution: "not_connected_to_legacy_loops", mcpState: "not_connected" });
    expect(workspace.tools).toHaveLength(5); expect(workspace.tools.every(tool => tool.available)).toBe(true); expect(workspace.commands).toHaveLength(37);
    const definition = await service().definition(context, { version: AGENT_TOOLS_VERSION, selection: { kind: "command", command: { domain: "finance", kind: "bill_record" } } });
    expect(definition).toMatchObject({ available: true, execution: "separate_original_preparation_and_confirmation", effect: "prepare_original_command" });
    const wire = JSON.stringify(definition.inputSchema); expect(wire).toContain("bill_record");
    for (const kind of ["payment_record", "purchase_create", "reviewed_order", "observation_record"]) expect(wire.includes(kind)).toBe(false);
    expect(await base.gateway().workspace(context)).toEqual(old); expect(await snapshot()).toEqual(before);
  });

  it("retrieves only actual published knowledge with original version hashes and honest topK coverage while withdrawn and draft sources remain unusable", async () => {
    const input = { query, topic: "operations", platform: "all", market: "ALL", spuIds: [] }, before = await snapshot();
    const result = await service().call(context, await call("knowledge.search", input));
    if (result.tool !== "knowledge.search") throw new Error("Wrong native result family");
    expect(result.coverage).toMatchObject({ kind: "ranked_subset", complete: false, returned: 6 }); expect(result.data.references).toHaveLength(6);
    for (const reference of result.data.references) {
      expect(published).toContain(reference.entryId); expect(reference.entryId).not.toBe(draftId);
      const [native] = await withTenant(database.db, context, tx => tx.execute<{ checksum: string }>(sql`select checksum from knowledge_versions where id=${reference.versionId}::uuid`));
      expect(reference.checksum).toBe(native?.checksum);
    }
    expect(await snapshot()).toEqual(before);
    const removed = result.data.references[0]!.entryId;
    await base.knowledge.change(context, removed, "disable", { expectedRevision: 3, version: 1, reason: "Synthetic original knowledge withdrawn", requestId: randomUUID() });
    const stable = await snapshot(), refreshed = await service().call(context, await call("knowledge.search", input));
    if (refreshed.tool !== "knowledge.search") throw new Error("Wrong native result family");
    expect(refreshed.data.references.some(reference => reference.entryId === removed || reference.entryId === draftId)).toBe(false);
    expect(refreshed.coverage.complete).toBe(false); expect(await snapshot()).toEqual(stable);
  });

  it("reads the real scanned and compiled creative execution history without generating recovering adopting or claiming image understanding", async () => {
    const before = await snapshot(), result = await service().call(context, await call("creative.history", { scope: "inspection", ownerId: ownInspection }));
    if (result.tool !== "creative.history") throw new Error("Wrong native result family");
    expect(result.data).toEqual(await creative.history(context, "inspection", ownInspection));
    expect(result.data.entries.some(entry => entry.phase === "completed" && entry.artifacts.length > 0)).toBe(true);
    expect(result.coverage).toMatchObject({ kind: "bounded_history", complete: false, returned: result.data.entries.length });
    const upper = await service().call(context, await call("creative.history", { scope: "inspection", ownerId: ownInspection.toUpperCase() }));
    if (upper.tool !== "creative.history") throw new Error("Wrong native result family");
    expect(upper.data.ownerId.toLowerCase()).toBe(ownInspection); expect(await snapshot()).toEqual(before);
  });

  it("reads genuine factory capacity in its native local-day range and accepts uppercase UUID semantics without reserving capacity or releasing production", async () => {
    const factoryId = scene.site.factory.id, input = { factoryId, query: { from: scene.site.capacity.localDate, days: 2 } }, before = await snapshot();
    const result = await service().call(context, await call("factory.capacity", input));
    if (result.tool !== "factory.capacity") throw new Error("Wrong native result family");
    expect(result.data.pools.length).toBeGreaterThan(0); expect(result.data.calendar.length).toBe(result.data.pools.length * 2);
    expect(result.coverage).toEqual({ kind: "bounded_snapshot", complete: false, from: input.query.from, days: 2, pools: result.data.pools.length });
    const upper = await service().call(context, await call("factory.capacity", { ...input, factoryId: factoryId.toUpperCase() }));
    if (upper.tool !== "factory.capacity") throw new Error("Wrong native result family");
    expect(upper.data.factoryId).toBe(factoryId); expect(upper.data.calendar).toEqual(result.data.calendar); expect(await snapshot()).toEqual(before);
  });

  it("preserves native self object access and explicit SPU filters while hiding peer and foreign sources after only relevant domain scopes narrow", async () => {
    await service().call(context, await call("creative.history", { scope: "inspection", ownerId: peerInspection }));
    const narrowBits: Permission[] = [Permission.WorkflowRead, Permission.DesignRead, Permission.AssetRead, Permission.ProductRead];
    await original.base.grant(narrowBits, "self", all.filter(bit => !narrowBits.includes(bit))); const narrow = await original.base.current();
    const before = await snapshot();
    const own = await service().call(narrow, await call("creative.history", { scope: "inspection", ownerId: ownInspection }, narrow));
    expect(own.tool).toBe("creative.history");
    await expect(service().call(narrow, await call("creative.history", { scope: "inspection", ownerId: peerInspection }, narrow))).rejects.toBeInstanceOf(ForbiddenError);
    await service().call(narrow, await call("knowledge.search", { query, topic: "operations", platform: "all", market: "ALL", spuIds: [ownSpu] }, narrow));
    await expect(service().call(narrow, await call("knowledge.search", { query, topic: "operations", platform: "all", market: "ALL", spuIds: [peerSpu] }, narrow))).rejects.toBeInstanceOf(NotFoundException);
    const foreign = original.base.foreignContext;
    await expect(service().call(foreign, await call("creative.history", { scope: "inspection", ownerId: ownInspection }, foreign))).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().call(foreign, await call("factory.capacity", { factoryId: scene.site.factory.id, query: { days: 2 } }, foreign))).rejects.toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a late successful real creative owner response after domain revocation without returning private history or writing a paid attempt", async () => {
    const entered = deferred(), release = deferred(), actual = creative.history.bind(creative);
    vi.spyOn(creative, "history").mockImplementationOnce(async (...args) => { const value = await actual(...args); entered.resolve(); await release.promise; return value; });
    const input = await call("creative.history", { scope: "inspection", ownerId: ownInspection }), before = await snapshot();
    const pending = service().call(context, input), settled = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await bounded(entered.promise, "Real creative history did not reach its completed I/O gate");
      await original.base.grant(all.filter(bit => bit !== Permission.DesignRead)); release.resolve();
      const result = await bounded(settled, "Late native history failed to settle"); expect(result.value).toBeNull();
      expect(result.error).toBeInstanceOf(ConflictException); expect(result.error.getResponse()).toMatchObject({ code: "authority_changed" });
      expect(await snapshot()).toEqual(before);
    } finally { release.resolve(); await settled; }
  });

  it("reuses the two old strict readers and rejects altered definitions pins and dynamic write calls without new queues budgets or native business facts", async () => {
    const before = await snapshot(), inventory = await service().call(context, await call("inventory.balances.page", { stockItemId: stock.id, pageSize: 1, cursor: null }));
    if (inventory.tool !== "inventory.balances.page") throw new Error("Wrong native result family");
    expect(inventory.data.items[0]).toMatchObject({ stockItemId: stock.id, unit: "meter", physicalQuantity: "1.000000001" });
    expect(inventory.coverage).toMatchObject({ complete: true, total: 1, readCount: 1, nextCursor: null });
    const exceptions = await service().call(context, await call("orders.exceptions.page", { pageSize: 1, cursor: null, status: "all" })); expect(exceptions.tool).toBe("orders.exceptions.page");
    const input = await call("knowledge.search", { query, topic: "operations", platform: "all", market: "ALL", spuIds: [] });
    for (const invalid of [{ ...input, definitionChecksum: "f".repeat(64) }, { ...input, executionContract: { ...input.executionContract, checksum: "f".repeat(64) } },
      { ...input, tool: "procurement.command.execute" }, { ...input, input: { query, topic: "operations", platform: "all", market: "ALL", spuIds: [], tenantId: createEntityId() } }])
      await expect(service().call(context, invalid)).rejects.toSatisfy((error: unknown) => error instanceof BadRequestException || error instanceof ConflictException);
    expect(await snapshot()).toEqual(before);
  });

  it("paginates real grants assignments and factory-person tasks across exact microseconds and safely resolves legacy millisecond anchors in each visible filter", async () => {
    const collaboration = new FactoryCollaborationService(database, original.base.audit, original.delivery), factoryId = scene.site.factory.id;
    const readers = [peer];
    for (let index = 0; index < 99; index++) readers.push(await original.actor());
    const grants: Array<typeof factoryAccessGrants.$inferInsert> = [];
    for (const reader of readers) {
      const [member] = await withTenant(database.db, context, tx => tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, reader.userId)));
      const input = FactoryGrantCreateSchema.parse({ factoryId, membershipId: member!.id, canRespond: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: randomUUID() });
      grants.push({ ...input, id: createEntityId(), tenantId: context.tenantId, expiresAt: new Date(input.expiresAt), createdBy: context.userId,
        requestChecksum: checksum(JSON.stringify({ actor: context.userId, ...input })) });
    }
    // Synthetic initial collaboration admissions use the application role and every
    // original125 guard. The guard itself supplies clock_timestamp per row. No
    // immutable timestamp, approved source or business state is changed.
    await withTenant(database.db, context, tx => tx.insert(factoryAccessGrants).values(grants));
    type ExactRow = { id: string; at: string };
    const exactRows = (table: "factory_access_grants" | "factory_task_assignments", where: ReturnType<typeof sql>) => withTenant(database.db, context,
      tx => tx.execute<ExactRow>(sql`select id,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
        from ${sql.identifier(table)} where ${where} order by created_at desc,id desc`));
    const sameMillisecond = (rows: ExactRow[]) => rows.findIndex((row, index) => index < rows.length - 1 &&
      row.at.slice(0, 23) === rows[index + 1]!.at.slice(0, 23) && row.at !== rows[index + 1]!.at);
    const grantRows = await exactRows("factory_access_grants", sql`factory_id=${factoryId}::uuid`);
    expect(grantRows).toHaveLength(grants.length); expect(sameMillisecond(grantRows)).toBeGreaterThanOrEqual(0);
    const grantId = grants[0]!.id!, foreignGrantId = grants[1]!.id!;
    let currentRows: ExactRow[] = [];
    for (let attempt = 0; attempt < 24; attempt++) {
      for (const row of currentRows) await collaboration.revokeAssignment(context, row.id, { idempotencyKey: randomUUID(), reason: "Synthetic precision resampling preserves original immutable history" });
      const batch = scene.packet.items.map(item => {
        const input = FactoryTaskAssignSchema.parse({ deliveryItemId: item.id, fileChecksum: item.snapshot!.file.checksum,
          packageChecksum: scene.packet.checksum, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: randomUUID() });
        return { id: createEntityId(), tenantId: context.tenantId, grantId, deliveryItemId: input.deliveryItemId, fileChecksum: input.fileChecksum,
          expiresAt: new Date(input.expiresAt), idempotencyKey: input.idempotencyKey, createdBy: context.userId,
          requestChecksum: checksum(JSON.stringify({ actor: context.userId, grantId, ...input })) };
      });
      await withTenant(database.db, context, tx => tx.insert(factoryTaskAssignments).values(batch));
      currentRows = await exactRows("factory_task_assignments", sql`grant_id=${grantId}::uuid and revoked_at is null`);
      if (sameMillisecond(currentRows) >= 0) break;
    }
    expect(currentRows).toHaveLength(3); expect(sameMillisecond(currentRows)).toBeGreaterThanOrEqual(0);
    const assignmentRows = await exactRows("factory_task_assignments", sql`grant_id=${grantId}::uuid`);
    const foreignAssignment = await collaboration.assign(context, foreignGrantId, { deliveryItemId: scene.packet.items[0]!.id,
      fileChecksum: scene.packet.items[0]!.snapshot!.file.checksum, packageChecksum: scene.packet.checksum, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: randomUUID() });
    const alternate = await original.site(), otherGrant = await collaboration.createGrant(context, { factoryId: alternate.factory.id,
      membershipId: grants[0]!.membershipId, canRespond: false, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: randomUUID() });
    const scan = async (read: (cursor?: string) => Promise<{ ids: string[]; nextCursor: string | null }>, rows: ExactRow[]) => {
      const found: string[] = []; let cursor: string | undefined;
      for (let index = 0; index < rows.length + 1; index++) { const page = await read(cursor); found.push(...page.ids); if (!page.nextCursor) break;
        expect(factoryCursor(page.nextCursor)?.at).toMatch(/\.\d{6}Z$/); cursor = page.nextCursor; }
      expect(found).toEqual(rows.map(row => row.id)); expect(new Set(found).size).toBe(rows.length);
      const index = sameMillisecond(rows); expect(index).toBeGreaterThanOrEqual(0); const anchor = rows[index]!;
      const legacy = Buffer.from(JSON.stringify({ id: anchor.id, at: anchor.at.slice(0, 23) + "Z" })).toString("base64url"), next = await read(legacy);
      expect(next.ids).toEqual([rows[index + 1]!.id]);
    };
    const before = await snapshot();
    await scan(async cursor => { const page = await collaboration.workspace(context, { factoryId, limit: 1, ...(cursor ? { cursor } : {}) }); return { ids: page.grants.map(row => row.id), nextCursor: page.nextCursor }; }, grantRows);
    await scan(async cursor => { const page = await collaboration.assignmentList(context, grantId, { limit: 1, ...(cursor ? { cursor } : {}) }); return { ids: page.items.map(row => row.id), nextCursor: page.nextCursor }; }, assignmentRows);
    await scan(async cursor => { const page = await original.delivery.factoryTasks(peer, { limit: 1, ...(cursor ? { cursor } : {}) }); return { ids: page.items.map(row => row.id), nextCursor: page.nextCursor }; }, currentRows);
    const wrong = Buffer.from(JSON.stringify({ id: foreignAssignment.id, at: foreignAssignment.createdAt })).toString("base64url");
    await expect(collaboration.assignmentList(context, grantId, { limit: 1, cursor: wrong })).rejects.toBeInstanceOf(BadRequestException);
    await expect(original.delivery.factoryTasks(peer, { limit: 1, cursor: wrong })).rejects.toBeInstanceOf(BadRequestException);
    const foreignGrantCursor = Buffer.from(JSON.stringify({ id: otherGrant.id, at: otherGrant.createdAt })).toString("base64url");
    await expect(collaboration.workspace(context, { factoryId, limit: 1, cursor: foreignGrantCursor })).rejects.toBeInstanceOf(BadRequestException);
    expect(await snapshot()).toEqual(before);
    expect(checksum(await readFile(journalPath))).toBe(checksum(journal));
  });
});
