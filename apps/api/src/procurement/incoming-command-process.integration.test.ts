import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SecretVault } from "@yummyai/ai-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { IncomingCommandViewSchema, type PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { connectDatabase, migrateDatabase, withTenant, memberships, membershipRoles, roles, inventoryBalances, incomingPostings, inventoryProcurementReceipts, incomingCommands } from "@yummyai/database";
import { createQueue, QueueName } from "../../../../packages/jobs/src/index.js";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { IncomingCommandService } from "./incoming-command.service.js";

if (process.env.E2E_INCOMING_PROCESS_ISOLATED !== "1")
  throw new Error("Incoming API process and database-permission fault tests require their independent disposable suite");

type Event = { type: string; phase?: string; state?: string; url?: string; pid?: number; queues?: string[]; schedulers?: string[];
  redacted?: number; failures?: number; receivedAt?: number; clean?: boolean };
type Probe = { child: ChildProcess; events: Event[]; closed: Promise<number>; wait(type: string, phase?: string, after?: number, timeoutMs?: number): Promise<Event>; stop(force?: boolean): Promise<number> };
const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));

describe.sequential("original incoming command across actual API-process exit", () => {
  const database = connectDatabase(), tenantId = createEntityId(), userId = createEntityId(), subject = `synthetic-incoming-process-${userId}`;
  const permissions = ["procurement:read", "procurement:write", "procurement:approve", "inventory:read", "inventory:write"];
  const context: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
  const audit = new AuditService(database), inventory = new InventoryService(database, audit), procurement = new ProcurementService(database, inventory, audit), incoming = new IncomingInspectionService(database, procurement, audit);
  const probes: Probe[] = [], encryptionKey = randomBytes(32).toString("base64url");
  let identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>>, locationId: string, supplierId: string;
  const occurred = "2026-10-19T02:00:00.000Z", key = () => `synthetic-process-${randomUUID()}`;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic API-process acceptance',$2)", [tenantId, `incoming-process-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic process operator')", [userId, subject, `${userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const membership = createEntityId(), role = createEntityId();
      await tx.insert(memberships).values({ id: membership, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId, name: `Synthetic process ${role}`, permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: membership, roleId: role });
    });
    supplierId = createEntityId();
    await database.client.unsafe("insert into fulfillment_suppliers(id,tenant_id,name,kind,status,region_code,settlement_currency,priority,created_by) values($1,$2,'Synthetic process supplier','manual','active','US','USD',1,$3)", [supplierId, tenantId, userId]);
    const warehouse = await inventory.createWarehouse(context, { code: "PROCESS-HOLD", name: "Synthetic process warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    locationId = (await inventory.createLocation(context, { warehouseId: warehouse.id, code: "HOLD", name: "Synthetic process hold" })).id;
    identity = await startFactoryIdentityFixture(tenantId, subject, "http://localhost:3130", { application: "erp", clientId: "yummyai-web" });
  });
  afterAll(async () => {
    const results = await Promise.allSettled(probes.map(probe => probe.stop(true)));
    await identity?.close(); await database.client.end();
    if (results.some(result => result.status === "rejected")) throw new Error("Incoming API-process cleanup incomplete");
    process.stdout.write(JSON.stringify({ type: "incoming.process.teardown", pids: probes.map(probe => probe.child.pid),
      allExited: probes.every(probe => probe.child.exitCode !== null || probe.child.signalCode !== null), identityClosed: true }) + "\n");
  });
  function launch(gate = "none", commandId?: string): Probe {
    const child = spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/incoming-api-process-fixture.mts"], {
      cwd: apiDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", NODE_ENV: "test",
        OIDC_ISSUER: identity.baseUrl, OIDC_JWKS_URI: `${identity.baseUrl}/protocol/openid-connect/certs`,
        INCOMING_COMMAND_ENCRYPTION_KEY: encryptionKey, INCOMING_FIXTURE_GATE: gate, INCOMING_FIXTURE_COMMAND_ID: commandId },
    });
    return observe(child);
  }
  function observe(child: ChildProcess): Probe {
    // Output is deliberately limited to lifecycle, never JWTs or private input.
    let exited = false, diagnostic = ""; const events: Event[] = [];
    child.stdout?.on("data", () => {}); child.stderr?.on("data", data => {
      const line = String(data).split(/\r?\n/).find(value => /Error|ERR_/.test(value));
      if (line) diagnostic = line.slice(0, 500);
    });
    const closed = new Promise<number>(resolve => { child.once("error", () => { exited = true; resolve(-1); }); child.once("exit", code => { exited = true; resolve(code ?? -1); }); });
    child.on("message", message => { if (message && typeof message === "object" && "type" in message && typeof message.type === "string") events.push({ ...message as Event, receivedAt: Date.now() }); });
    const probe: Probe = { child, events, closed,
      wait: (type, phase, after = 0, timeoutMs = 30_000) => new Promise<Event>((resolve, reject) => {
        const find = () => events.slice(after).find(item => item.type === type && (!phase || item.phase === phase || item.state === phase));
        const known = find(); if (known) { resolve(known); return; }
        if (exited) { reject(new Error(`Synthetic process exited before ${type}: ${diagnostic}`)); return; }
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Synthetic lifecycle deadline: ${type}`)); }, timeoutMs);
        const cleanup = () => { clearTimeout(timer); child.off("message", changed); child.off("exit", stopped); child.off("error", stopped); };
        const stopped = () => { cleanup(); reject(new Error(`Synthetic process exited before ${type}: ${diagnostic}`)); };
        const changed = () => { const event = find(); if (event) { cleanup(); resolve(event); } };
        child.on("message", changed); child.once("exit", stopped); child.once("error", stopped);
      }), stop: async force => {
        if (!exited) { if (force || !child.connected) child.kill("SIGKILL"); else child.send("shutdown", () => {}); }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Synthetic API stop deadline")); }, 10_000); })]); }
        finally { if (timer) clearTimeout(timer); }
      } };
    probes.push(probe); return probe;
  }
  async function request(probe: Probe, path: string, body?: unknown) {
    const ready = await probe.wait("incoming.fixture.ready");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url ?? "")) throw new Error("Unsafe synthetic API origin");
    return fetch(ready.url + "/v1/procurement/incoming/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${await identity.operatorToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
  }
  async function basis() {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const stock = await inventory.createStockItem(context, { skuId: null, code: `PROCESS-${suffix}`, name: "Synthetic process fabric", baseUnit: "meter" });
    const order = await procurement.createPurchaseOrder(context, { code: `PROCESS-${suffix}`, supplierId, requisitionId: null, quoteId: null, currency: "USD", expectedAt: "2026-10-21T00:00:00Z",
      lines: [{ lineKey: "L1", stockItemId: stock.id, destinationLocationId: locationId, quantity: 1, unit: "meter", unitCostMinor: 100 }], idempotencyKey: key() });
    await procurement.reviewPurchaseOrder(context, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: key() });
    const standard = await incoming.publishStandard(context, { code: "PROCESS", stockItemId: stock.id, expectedVersion: 0, title: "Synthetic measured width", sourceReference: "Isolated process fixture, no supplier acceptance",
      criteria: [{ code: "WIDTH", label: "实际宽度", kind: "numeric_range", unit: "mm", minimum: "10", maximum: "10" }], idempotencyKey: key() });
    const arrival = await incoming.recordArrival(context, order.id, { code: `PROCESS-${suffix}`, expectedPurchaseOrderVersion: 1, arrivedAt: occurred, externalReference: "Synthetic actual handover",
      lines: [{ lineKey: "L1", quantity: "0.35", unit: "meter", holdingLocationId: locationId, lotCode: `原批号 Ab/${suffix}`, expiresAt: null }], idempotencyKey: key() });
    const lineId = arrival.lines[0]!.id;
    const inspected = await incoming.recordInspection(context, lineId, { expectedInspectionVersion: 0, standardVersionId: standard.id, acceptedQuantity: "0.35", rejectedQuantity: 0,
      sampleQuantity: "0.01", rejectionReason: null, measuredAt: occurred, readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: key() });
    const reviewed = await incoming.reviewInspection(context, lineId, { expectedInspectionVersion: 1, inspectionId: inspected.inspections[0]!.id, decision: "approved", reason: "Synthetic actual measurement reviewed", idempotencyKey: key() });
    const original: PrepareIncomingCommand = { kind: "post_inspection", targetId: lineId, input: { expectedInspectionVersion: 1, approvalId: reviewed.inspections[0]!.review!.id,
      acceptedQuantity: "0.35", rejectedQuantity: 0, rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: occurred, idempotencyKey: key() } };
    return { stockId: stock.id, orderId: order.id, lineId, original };
  }
  async function physical(stockId: string) { return withTenant(database.db, context, async tx => sumStockQuantities((await tx.select().from(inventoryBalances).where(eq(inventoryBalances.stockItemId, stockId))).map(row => row.physicalQuantity))); }

  it("rejects malformed input at the HTTP boundary without changing original commands or facts", async () => {
    const b = await basis(), api = launch();
    try {
      const invalidPreparation = await request(api, "commands", { ...b.original, callerTenant: tenantId });
      expect(invalidPreparation.status).toBe(400);
      const prepared = IncomingCommandViewSchema.parse(await (await request(api, "commands", b.original)).json());
      for (const path of [`commands/${prepared.id}/execute`, `commands/${prepared.id}/cancel`, `commands/${prepared.id}/acknowledge`]) {
        const invalidAction = await request(api, path, { input: b.original.input });
        expect(invalidAction.status).toBe(400);
      }
      for (const path of ["commands/not-an-id", `orders/${b.orderId}/commands?before=not-an-id`, `orders/${b.orderId}/commands?callerTenant=${tenantId}`]) {
        expect((await request(api, path)).status).toBe(400);
      }
      const restored = IncomingCommandViewSchema.parse(await (await request(api, `commands/${prepared.id}`)).json());
      expect(restored.status).toBe("prepared"); expect(restored.original).toEqual(b.original);
      expect(await physical(b.stockId)).toBe(0);
      expect(await withTenant(database.db, context, tx => tx.select().from(incomingPostings).where(eq(incomingPostings.arrivalLineId, b.lineId)))).toHaveLength(0);
    } finally { await api.stop(); }
  });

  it.each(["before_commit", "after_commit"])("recovers exactly once after actual process death %s", async phase => {
    const b = await basis(), preparation = launch();
    const preparedResponse = await request(preparation, "commands", b.original); expect(preparedResponse.status).toBe(201);
    const prepared = IncomingCommandViewSchema.parse(await preparedResponse.json());
    expect(prepared.original).toEqual(b.original); await preparation.stop();
    const interrupted = launch(phase, prepared.id);
    const response = request(interrupted, `commands/${prepared.id}/execute`, {}).then(value => ({ received: true, status: value.status }), () => ({ received: false, status: 0 }));
    await interrupted.wait("incoming.fixture.barrier", phase);
    expect(await physical(b.stockId)).toBe(phase === "before_commit" ? 0 : "0.35");
    await interrupted.stop(true);
    expect((await response).received).toBe(false);
    const restarted = launch();
    try {
      const restored = IncomingCommandViewSchema.parse(await (await request(restarted, `commands/${prepared.id}`)).json());
      expect(restored.status).toBe(phase === "before_commit" ? "prepared" : "succeeded");
      if (phase === "before_commit") expect(restored.original).toEqual(b.original);
      const first = IncomingCommandViewSchema.parse(await (await request(restarted, `commands/${prepared.id}/execute`, {})).json());
      const again = IncomingCommandViewSchema.parse(await (await request(restarted, `commands/${prepared.id}/execute`, {})).json());
      expect(first.status).toBe("succeeded"); expect(again.result).toEqual(first.result);
      expect(await physical(b.stockId)).toBe("0.35");
      expect(await withTenant(database.db, context, tx => tx.select().from(incomingPostings).where(eq(incomingPostings.arrivalLineId, b.lineId)))).toHaveLength(1);
      expect(await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.purchaseOrderId, b.orderId)))).toHaveLength(1);
      process.stdout.write(JSON.stringify({ type: "incoming.process.case", phase, commandId: prepared.id,
        pids: [preparation.child.pid, interrupted.child.pid, restarted.child.pid], physicalQuantity: "0.35", postings: 1, receipts: 1, recoveredStatus: restored.status }) + "\n");
    } finally { await restarted.stop(); }
  }, 120_000);

  it("runs bounded privacy batches on real timers, defers failures and restarts with zero consumers", async () => {
    const commands = new IncomingCommandService(database, new SecretVault(Buffer.from(encryptionKey, "base64url")), incoming, audit);
    const suffix = randomUUID().slice(0, 8).toUpperCase(), dueIds: string[] = [];
    let retainedId = "";
    for (let index = 0; index < 102; index++) {
      const stock = await inventory.createStockItem(context, { skuId: null, code: `TTL-${suffix}-${index}`, name: "Synthetic private input retention", baseUnit: "meter" });
      const prepared = await commands.prepare(context, { kind: "publish_standard", targetId: stock.id, input: { stockItemId: stock.id, code: "TTL", expectedVersion: 0,
        title: "Synthetic TTL fixture", sourceReference: "Isolated expiry fixture, no actual supplier acceptance",
        criteria: [{ code: "OBSERVATION", label: "合成观测", kind: "one_of", acceptedValues: ["SYNTHETIC"] }], idempotencyKey: key() } });
      if (index < 101) dueIds.push(prepared.id); else retainedId = prepared.id;
    }
    await database.client.begin(async fixture => {
      await fixture.unsafe("set local session_replication_role=replica");
      await fixture.unsafe("update inventory_incoming_commands set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where tenant_id=$1 and id=any($2::uuid[])", [tenantId, `{${dueIds.join(",")}}`]);
    });
    let unlock!: () => void, locked!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const lockHeld = withTenant(database.db, context, async tx => {
      await tx.select({ id: incomingCommands.id }).from(incomingCommands).where(eq(incomingCommands.id, dueIds[0]!)).for("update");
      locked(); await new Promise<void>(resolve => { unlock = resolve; });
    });
    await lockReady;
    const queue = createQueue(QueueName.WorkflowNode), sentinel = await queue.add("synthetic-retention-sentinel", { fixture: "owned-disposable-only" }, { jobId: createEntityId() });
    const launchMaintenance = () => observe(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/scripts/incoming-retention-runtime.mjs"], {
      cwd: apiDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all", WORKER_STARTUP_TIMEOUT_MS: "10000", WORKER_SHUTDOWN_TIMEOUT_MS: "10000" },
    }));
    let maintenance: Probe | undefined, restarted: Probe | undefined;
    try {
      // A controlled fixture-only privilege fault proves a real deferred batch.
      await database.client.unsafe("revoke update on inventory_incoming_commands from yummyai_app");
      maintenance = launchMaintenance();
      const ready = await maintenance.wait("worker.lifecycle", "ready");
      expect(ready.queues).toEqual([]); expect(ready.schedulers).toEqual(["incomingCommandRetentionScheduler"]);
      const deferred = await maintenance.wait("worker.maintenance");
      expect(deferred.state).toBe("deferred"); expect(deferred.failures).toBeGreaterThan(0); expect(deferred.redacted).toBe(0);
      await database.client.unsafe("grant update on inventory_incoming_commands to yummyai_app");
      const first = await maintenance.wait("worker.maintenance", undefined, maintenance.events.length, 90_000);
      expect(first).toMatchObject({ state: "completed", redacted: 100, failures: 0 });
      expect(first.receivedAt! - deferred.receivedAt!).toBeGreaterThanOrEqual(50_000);
      unlock(); await lockHeld;
      const second = await maintenance.wait("worker.maintenance", undefined, maintenance.events.length, 90_000);
      expect(second).toMatchObject({ state: "completed", redacted: 1, failures: 0 });
      expect(second.receivedAt! - first.receivedAt!).toBeGreaterThanOrEqual(50_000);
      expect((await commands.get(context, dueIds[0]!)).status).toBe("expired");
      expect((await commands.get(context, retainedId)).original).not.toBeNull();
      expect(await sentinel.getState()).toBe("waiting");
      expect(await maintenance.stop()).toBe(0);
      restarted = launchMaintenance();
      const restartedReady = await restarted.wait("worker.lifecycle", "ready");
      expect(restartedReady.queues).toEqual([]); expect(restartedReady.schedulers).toEqual(["incomingCommandRetentionScheduler"]);
      expect(await restarted.wait("worker.maintenance")).toMatchObject({ state: "completed", redacted: 0, failures: 0 });
      expect(await sentinel.getState()).toBe("waiting");
      expect(await restarted.stop()).toBe(0);
      process.stdout.write(JSON.stringify({ type: "incoming.retention.case", pids: [maintenance.child.pid, restarted.child.pid],
        zeroConsumers: true, inheritedAllOverridden: true, deferredFailures: deferred.failures, realTimerBatches: [first.redacted, second.redacted],
        timerGapsMs: [first.receivedAt! - deferred.receivedAt!, second.receivedAt! - first.receivedAt!], lockedRowSkipped: true, nonDueCopyRetained: true, sentinelStillWaiting: true }) + "\n");
    } finally {
      await database.client.unsafe("grant update on inventory_incoming_commands to yummyai_app");
      unlock(); await lockHeld;
      await Promise.allSettled([maintenance?.stop(true), restarted?.stop(true)]);
      await sentinel.remove(); await queue.close();
    }
  }, 240_000);
});
