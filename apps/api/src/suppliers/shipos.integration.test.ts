import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, withTenant, fulfillmentSuppliers, marketplaceAccounts, orderSourceSnapshots, orders, orderLines, orderWorkItems, orderProtectedDetails, shiposConnections, shiposSyncRuns, shiposOrderSnapshots } from "@yummyai/database";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { ShiposService } from "./shipos.service.js";
import { ShiposReadGateway } from "./shipos-read.gateway.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Use the disposable shipos-integration runner");
describe("tenant-safe ShipOS existing-order evidence", () => {
  const database = connectDatabase(), tenantId = createEntityId(), foreignTenant = createEntityId(), userId = createEntityId(), supplierId = createEntityId(), accountId = createEntityId(), secondAccountId = createEntityId();
  const context: TenantContext = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" }, other = { ...context, tenantId: foreignTenant };
  const vault = new SecretVault(Buffer.alloc(32, 17)), gateway = new ShiposReadGateway();
  const query = vi.spyOn(gateway, "orders"), detail = vi.spyOn(gateway, "detail"), channels = vi.spyOn(gateway, "channels"), label = vi.spyOn(gateway, "existingLabel");
  const service = new ShiposService(database, vault, gateway, new AuditService(database));
  const refs: Record<string, { orderId: string; lineId: string }> = {};
  let version = 0;
  const save = (extra: Record<string, unknown> = {}) => service.save(context, supplierId, { name: "Synthetic ShipOS", status: "active", expectedVersion: version, idempotencyKey: randomUUID(), ...extra });
  const sync = (numbers: string[], key = randomUUID()) => service.sync(context, supplierId, { orderNumbers: numbers, expectedVersion: version, idempotencyKey: key });
  function mock() {
    query.mockImplementation(async (_credentials, numbers) => numbers.filter(n => n !== "MISSING-REMOTE").map(orderNumber => ({ orderNumber, trackingNumber: `TRACK-${orderNumber}`, labelAvailable: true, statusCode: 14, labelStatusCode: 2, cancelStatusCode: 0, settlementStatusCode: 1, channel: null, fee: null, currency: null, diagnostics: [] })));
    detail.mockImplementation(async (_credentials, number) => { if (number === "DETAIL-FAIL") throw new Error("private vendor payload synthetic-secret"); return { trackingNumber: `TRACK-${number}`, labelUrl: "https://shipease.oss-cn-hangzhou.aliyuncs.com/pdfs/synthetic.pdf", channel: "Synthetic channel", fee: number === "MATCHED" ? "0.00" : null, currency: number === "MATCHED" ? "CAD" : null }; });
    channels.mockResolvedValue({ channelCount: 3 }); label.mockResolvedValue(Buffer.from("%PDF-1.7 synthetic"));
  }
  async function activeConnection() {
    const connection = (await service.workspace(context, supplierId)).connection;
    version = connection?.version ?? 0;
    if (!connection?.credentialsConfigured || connection.status !== "active") {
      version = (await save({ status: "active", appKey: "synthetic-appkey", appSecret: "synthetic-secret" })).version;
    }
    return (await service.workspace(context, supplierId)).connection!;
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic ShipOS',$2),($3,'Synthetic other ShipOS',$4)", [tenantId, `shipos-${tenantId}`, foreignTenant, `shipos-${foreignTenant}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic ShipOS operator')", [userId, `shipos-${userId}`, `${userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId, name: "Synthetic ShipOS supplier", kind: "manual", regionCode: "", settlementCurrency: "USD", createdBy: userId });
      await tx.insert(marketplaceAccounts).values([accountId, secondAccountId].map((id, index) => ({ id, tenantId, platform: "amazon", displayName: `Synthetic ShipOS shop ${index}`, region: "NA", authorizationMode: "amazon_private", marketplaceIds: ["ATVPDKIKX0DER"], createdBy: userId })));
      for (const [number, account, expired] of [["MATCHED", accountId, false], ["EXPIRED", accountId, true], ["AMBIGUOUS", accountId, false], ["AMBIGUOUS", secondAccountId, false], ["UNINITIALIZED", accountId, false]] as const) {
        const orderId = createEntityId(), lineId = createEntityId(), snapshotId = createEntityId();
        await tx.insert(orderSourceSnapshots).values({ id: snapshotId, tenantId, accountId: account, platform: "amazon", externalEventId: `event-${orderId}`, externalOrderId: number, normalizedOrderId: orderId, redactedPayload: {}, payloadChecksum: "a".repeat(64) });
        await tx.insert(orders).values({ id: orderId, tenantId, accountId: account, sourceSnapshotId: snapshotId, platform: "amazon", externalOrderId: number, providerStatus: "synthetic", lineCount: 1, placedAt: new Date(), addressStatus: "protected" });
        await tx.insert(orderLines).values({ id: lineId, tenantId, orderId, externalLineId: `line-${lineId}`, title: "Synthetic item", quantity: 1 });
        if (number === "UNINITIALIZED") await tx.insert(orderProtectedDetails).values({ id: createEntityId(), tenantId, orderId, encryptedEnvelope: vault.encrypt("synthetic protected source"), retentionExpiresAt: new Date(Date.now() + 86400_000) });
        else await tx.insert(orderWorkItems).values({ id: lineId, tenantId, encryptedDataKey: vault.encrypt(Buffer.alloc(32, 8).toString("base64url")), expiresAt: expired ? new Date(0) : new Date(Date.now() + 86400_000) });
        refs[number] = { orderId, lineId };
      }
    });
    mock();
  });
  afterAll(async () => { await database.client.end(); }); // The runner's failure-safe finally destroys the complete fixture database and storage.
  it("saves a name-only draft, encrypts replacement credentials, masks all responses and enforces revisions", async () => {
    const draft = await service.save(context, supplierId, { name: "Synthetic ShipOS", status: "draft", expectedVersion: 0, idempotencyKey: randomUUID() }); version = draft.version;
    expect(draft.credentialsConfigured).toBe(false);
    await expect(save()).rejects.toBeInstanceOf(ConflictException);
    const input = { appKey: "synthetic-appkey", appSecret: "synthetic-secret", idempotencyKey: randomUUID() }, saved = await save(input); version = saved.version;
    expect(saved.appKeyHint).toBe("••••pkey"); expect(JSON.stringify(saved)).not.toMatch(/synthetic-secret|encryptedCredentials|synthetic-appkey/);
    expect((await service.save(context, supplierId, { name: "Synthetic ShipOS", status: "active", expectedVersion: version - 1, ...input })).id).toBe(saved.id);
    const [row] = await withTenant(database.db, context, tx => tx.select().from(shiposConnections));
    expect(row!.encryptedCredentials).not.toContain("synthetic-secret");
    expect(vault.withSecret(row!.encryptedCredentials!, JSON.parse)).toEqual({ appKey: "synthetic-appkey", appSecret: "synthetic-secret" });
    await expect(service.save(context, supplierId, { name: "Changed", status: "active", expectedVersion: version - 1, ...input })).rejects.toBeInstanceOf(ConflictException);
    await expect(save({ expectedVersion: version - 1 })).rejects.toBeInstanceOf(ConflictException);
    const tested = await service.test(context, supplierId, { expectedVersion: version }); expect(tested).toMatchObject({ success: true, channelCount: 3 });
  });
  it("isolates tenant data, denies insufficient permissions, refuses charged commands and never queries on validation errors", async () => {
    await expect(service.workspace(other, supplierId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, other, tx => tx.select().from(shiposConnections))).toEqual([]);
    await expect(service.workspace({ ...context, dataScope: "self" }, supplierId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.save({ ...context, permissions: [Permission.OrderRead] }, supplierId, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.sync({ ...context, permissions: [Permission.OrderRead, Permission.IntegrationManage, Permission.OrderWrite] }, supplierId, {})).rejects.toBeInstanceOf(ForbiddenError);
    const before = query.mock.calls.length;
    await expect(service.sync(context, supplierId, { orderNumbers: ["MATCHED"], expectedVersion: version, idempotencyKey: randomUUID(), action: "createOrder" })).rejects.toThrow();
    await expect(service.sync(context, supplierId, { orderNumbers: ["MATCHED"], expectedVersion: version, idempotencyKey: randomUUID(), tenantId: foreignTenant })).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(before);
    const [role] = await withTenant(database.db, context, tx => tx.execute(sql`select current_user as role`)); expect(role!.role).toBe("yummyai_app");
  });
  it("stores immutable partial evidence, handles absent and ambiguous matches, and leaves local workflow unchanged", async () => {
    const run = await sync(["MATCHED", "NO-LOCAL", "AMBIGUOUS", "EXPIRED", "DETAIL-FAIL"]);
    expect(run.status).toBe("partial");
    expect(run.records.find(row => row.orderNumber === "MATCHED")).toMatchObject({ match: "matched", localLineId: refs.MATCHED!.lineId, fee: "0.00", currency: "CAD" });
    expect(run.records.find(row => row.orderNumber === "NO-LOCAL")).toMatchObject({ match: "missing", localOrderId: null, fee: null, currency: null });
    expect(run.records.find(row => row.orderNumber === "AMBIGUOUS")).toMatchObject({ match: "ambiguous", localOrderId: null });
    expect(run.records.find(row => row.orderNumber === "EXPIRED")).toMatchObject({ match: "expired", localLineId: null });
    expect(run.records.find(row => row.orderNumber === "DETAIL-FAIL")!.diagnostics).toContain("detail_unavailable");
    expect(JSON.stringify(run)).not.toContain("synthetic-secret");
    const calls = query.mock.calls.length;
    const local = await service.orderEvidence(context, refs.MATCHED!.orderId);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ supplierId, record: { localOrderId: refs.MATCHED!.orderId, localLineId: refs.MATCHED!.lineId, match: "matched" } });
    expect(query).toHaveBeenCalledTimes(calls);
    await expect(service.orderEvidence(other, refs.MATCHED!.orderId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.orderEvidence({ ...context, permissions: ["order:read"] }, refs.MATCHED!.orderId)).rejects.toBeInstanceOf(ForbiddenError);
    const business = await withTenant(database.db, context, tx => tx.select().from(orders)); expect(business.every(order => order.workflowState === "pending")).toBe(true);
    await expect(withTenant(database.db, context, tx => tx.update(shiposOrderSnapshots).set({ match: "missing" }).where(eq(shiposOrderSnapshots.id, run.records[0]!.id)))).rejects.toThrow();
    await expect(withTenant(database.db, context, tx => tx.delete(shiposOrderSnapshots).where(eq(shiposOrderSnapshots.id, run.records[0]!.id)))).rejects.toThrow();
    expect(await withTenant(database.db, other, tx => tx.select().from(shiposOrderSnapshots))).toEqual([]);
  });
  it("replays concurrent retries without another external query and preserves newer observations", async () => {
    const key = randomUUID(), before = query.mock.calls.length;
    const [a, b] = await Promise.all([sync(["MATCHED"], key), sync(["MATCHED"], key)]);
    expect(a.id).toBe(b.id); expect(query).toHaveBeenCalledTimes(before + 1);
    expect((await sync(["MATCHED"], key)).id).toBe(a.id);
    await expect(sync(["NO-LOCAL"], key)).rejects.toBeInstanceOf(ConflictException);
    const newest = await sync(["MATCHED"]);
    expect((await service.workspace(context, supplierId)).recent.find(row => row.orderNumber === "MATCHED")!.runId).toBe(newest.id);
    expect((await sync(["MISSING-REMOTE"])).records[0]!.diagnostics).toEqual(["not_returned"]);
  });
  it("pins only current tenant-retained evidence and saved channel mappings without vendor calls", async () => {
    const mapping = { channel: "Synthetic channel", carrierCode: "UPS", carrierName: "Synthetic UPS", carrierService: "Synthetic ground", shipFromCountryCode: "CN" };
    version = (await save({ channelMappings: [mapping] })).version;
    expect((await service.workspace(context, supplierId)).connection!.channelMappings).toEqual([mapping]);
    const run = await sync(["MATCHED"]), record = run.records[0]!;
    const observations = await withTenant(database.db, context, tx => tx.select({
      id: shiposOrderSnapshots.id, runId: shiposOrderSnapshots.runId,
      databaseFetchedAt: sql<string>`${shiposOrderSnapshots.fetchedAt}::text`,
    }).from(shiposOrderSnapshots).where(eq(shiposOrderSnapshots.localOrderId, refs.MATCHED!.orderId))
      .orderBy(desc(shiposOrderSnapshots.fetchedAt), desc(shiposOrderSnapshots.id)));
    expect((await service.orderEvidence(context, refs.MATCHED!.orderId))[0]?.record.id,
      JSON.stringify({ currentRun: run.id, currentRecord: record.id, observations })).toBe(record.id);
    const selection = { supplierId, recordId: record.id, expectedConnectionVersion: version };
    const fields = { ...mapping, trackingNumber: record.trackingNumber! };
    const pin = (ctx = context, orderId = refs.MATCHED!.orderId, input = selection, parcel = fields) => withTenant(database.db, ctx, tx => service.pinShipmentEvidence(ctx, tx, orderId, input, parcel));
    const calls = query.mock.calls.length, details = detail.mock.calls.length;
    expect(await pin()).toMatchObject({ recordId: record.id, carrierMapping: mapping, connectionVersion: version, labelAvailable: true });
    expect((await service.orderEvidence(context, refs.MATCHED!.orderId))[0]).toMatchObject({ carrierMapping: mapping, blockers: [] });
    await expect(pin(other)).rejects.toBeInstanceOf(ConflictException);
    await expect(pin({ ...context, permissions: [Permission.OrderRead] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(pin(context, refs.UNINITIALIZED!.orderId)).rejects.toBeInstanceOf(ConflictException);
    await expect(pin(context, undefined, { ...selection, expectedConnectionVersion: version + 1 })).rejects.toBeInstanceOf(ConflictException);
    await expect(pin(context, undefined, undefined, { ...fields, trackingNumber: "WRONG" })).rejects.toBeInstanceOf(ConflictException);
    await expect(pin(context, undefined, undefined, { ...fields, carrierCode: "WRONG" })).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(calls); expect(detail).toHaveBeenCalledTimes(details);
    await sync(["MATCHED"]); await expect(pin()).rejects.toBeInstanceOf(ConflictException);
    query.mockResolvedValueOnce([{ orderNumber: "MATCHED", trackingNumber: "TRACK-MATCHED", labelAvailable: true, statusCode: 13,
      labelStatusCode: 2, cancelStatusCode: 1, settlementStatusCode: 1, channel: null, fee: null, currency: null, diagnostics: [] }]);
    const cancelled = await sync(["MATCHED"]);
    expect((await service.orderEvidence(context, refs.MATCHED!.orderId))[0]!.blockers.join()).toContain("取消标记");
    await expect(pin(context, undefined, { ...selection, recordId: cancelled.records[0]!.id })).rejects.toBeInstanceOf(ConflictException);
    await sync(["MATCHED"]);
  });
  it("keeps a later sync current when retained historical timestamps are ahead of the database clock", async () => {
    const connection = await activeConnection();
    const templateRun = await sync(["MATCHED"]);
    const [template] = await withTenant(database.db, context, tx => tx.select().from(shiposOrderSnapshots).where(eq(shiposOrderSnapshots.runId, templateRun.id)));
    const historicalRunId = createEntityId(), historicalRecordId = createEntityId();
    // Retain an immutable historical observation from a different wall-clock
    // epoch. Do not edit an existing snapshot or change the system clock.
    await withTenant(database.db, context, async tx => {
      await tx.insert(shiposSyncRuns).values({ id: historicalRunId, tenantId, connectionId: connection.id,
        connectionVersion: version, idempotencyKey: randomUUID(), requestChecksum: "c".repeat(64), orderNumbers: ["MATCHED"],
        status: "completed", createdBy: userId, createdAt: sql`clock_timestamp() + interval '1 day'`, completedAt: sql`clock_timestamp() + interval '1 day'` });
      await tx.insert(shiposOrderSnapshots).values({ id: historicalRecordId, tenantId, runId: historicalRunId,
        evidence: { ...template!.evidence, trackingNumber: "TRACK-HISTORICAL-EPOCH" },
        localOrderId: refs.MATCHED!.orderId, localLineId: refs.MATCHED!.lineId, match: "matched", fetchedAt: sql`clock_timestamp() + interval '1 day'` });
    });
    const fresh = await sync(["MATCHED"]), freshRecord = fresh.records[0]!;
    expect((await service.orderEvidence(context, refs.MATCHED!.orderId))[0]!.record.id).toBe(freshRecord.id);
    const workspace = await service.workspace(context, supplierId);
    expect(workspace.runs[0]!.id).toBe(fresh.id);
    expect(workspace.recent.find(row => row.orderNumber === "MATCHED")!.runId).toBe(fresh.id);
    const fields = { ...(connection.channelMappings[0] ?? { carrierCode: "UPS", carrierName: "Synthetic UPS", carrierService: "Synthetic ground", shipFromCountryCode: "CN" }), trackingNumber: freshRecord.trackingNumber! };
    const calls = query.mock.calls.length;
    const pin = (recordId: string) => withTenant(database.db, context, tx => service.pinShipmentEvidence(context, tx, refs.MATCHED!.orderId,
      { supplierId, recordId, expectedConnectionVersion: version }, fields));
    expect(await pin(freshRecord.id)).toMatchObject({ recordId: freshRecord.id });
    await expect(pin(historicalRecordId)).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(calls);
    const [retained] = await withTenant(database.db, context, tx => tx.select({ id: shiposOrderSnapshots.id }).from(shiposOrderSnapshots).where(eq(shiposOrderSnapshots.id, historicalRecordId)));
    expect(retained?.id).toBe(historicalRecordId);
  });

  it.each(["admission", "completion"] as const)("keeps a validated pin stable through its caller transaction during sync %s", async phase => {
    const connection = await activeConnection(), baseline = await sync(["MATCHED"]), record = baseline.records[0]!;
    const fields = { ...(connection.channelMappings[0] ?? { carrierCode: "UPS", carrierName: "Synthetic UPS", carrierService: "Synthetic ground", shipFromCountryCode: "CN" }), trackingNumber: record.trackingNumber! };
    const remoteEntered = deferred<void>(), releaseRemote = deferred<void>(), pinned = deferred<number>(), releasePin = deferred<void>();
    const pending: Promise<unknown>[] = [], provider = query.getMockImplementation()!;
    let syncing: ReturnType<typeof sync> | undefined;
    try {
      if (phase === "completion") {
        query.mockImplementationOnce(async (...args) => { remoteEntered.resolve(); await releaseRemote.promise; return provider(...args); });
        syncing = sync(["MATCHED"]); pending.push(syncing); void syncing.catch(() => {});
        await Promise.race([remoteEntered.promise, syncing.then(() => { throw new Error("Sync ended before the controlled gateway returned"); })]);
      }
      const holder = withTenant(database.db, context, async tx => {
        const source = await service.pinShipmentEvidence(context, tx, refs.MATCHED!.orderId, { supplierId, recordId: record.id, expectedConnectionVersion: version }, fields);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pinned.resolve(backend!.pid); await releasePin.promise; return source;
      });
      pending.push(holder); void holder.catch(() => {});
      const pinPid = await Promise.race([pinned.promise, holder.then(() => { throw new Error("Pin transaction ended before its checkpoint"); })]);
      if (!syncing) { syncing = sync(["MATCHED"]); pending.push(syncing); }
      let settled = false;
      void syncing.then(() => { settled = true; }, () => { settled = true; });
      releaseRemote.resolve();
      let waiters = 0;
      await vi.waitFor(async () => {
        const waiting = await database.client<{ pid: number }[]>`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and ${pinPid}=any(pg_blocking_pids(pid))`;
        waiters = waiting.length; expect(settled || waiters > 0).toBe(true);
      }, { timeout: 10_000, interval: 10 });
      expect(settled).toBe(false); expect(waiters).toBe(1);
      releasePin.resolve();
      expect(await holder).toMatchObject({ recordId: record.id });
      const fresh = await syncing;
      expect((await service.orderEvidence(context, refs.MATCHED!.orderId))[0]!.record.id).toBe(fresh.records[0]!.id);
    } finally {
      releaseRemote.resolve(); releasePin.resolve(); await Promise.allSettled(pending);
      query.mockReset(); query.mockImplementation(provider);
    }
  });

  it("returns a retryable pin conflict instead of reversing the shipment order and connection locks", async () => {
    const connection = await activeConnection(), baseline = await sync(["MATCHED"]), record = baseline.records[0]!;
    const fields = { ...(connection.channelMappings[0] ?? { carrierCode: "UPS", carrierName: "Synthetic UPS", carrierService: "Synthetic ground", shipFromCountryCode: "CN" }), trackingNumber: record.trackingNumber! };
    const locked = deferred<number>(), attemptPin = deferred<void>(), pending: Promise<unknown>[] = [];
    const holder = withTenant(database.db, context, async tx => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, refs.MATCHED!.orderId)).for("update");
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      locked.resolve(backend!.pid); await attemptPin.promise;
      return service.pinShipmentEvidence(context, tx, refs.MATCHED!.orderId, { supplierId, recordId: record.id, expectedConnectionVersion: version }, fields);
    });
    pending.push(holder); void holder.catch(() => {});
    try {
      const orderPid = await Promise.race([locked.promise, holder.then(() => { throw new Error("Order control transaction ended early"); })]);
      const syncing = sync(["MATCHED"]); pending.push(syncing); void syncing.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await database.client<{ pid: number }[]>`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and ${orderPid}=any(pg_blocking_pids(pid)) and query like 'insert into "shipos_order_snapshots"%'`;
        expect(waiting).toHaveLength(1);
      }, { timeout: 10_000, interval: 10 });
      attemptPin.resolve();
      await expect(holder).rejects.toMatchObject({ message: expect.stringContaining("正在提交") });
      const fresh = await syncing;
      expect(fresh.status).toBe("completed");
      expect((await service.orderEvidence(context, refs.MATCHED!.orderId))[0]!.record.id).toBe(fresh.records[0]!.id);
    } finally { attemptPin.resolve(); await Promise.allSettled(pending); }
  });

  it("offers existing labels only for retained matched orders and rechecks retention after fetching", async () => {
    const imported = await sync(["UNINITIALIZED"]);
    expect(imported.records[0]).toMatchObject({ match: "matched", localLineId: refs.UNINITIALIZED!.lineId });
    expect((await service.label(context, supplierId, imported.records[0]!.id)).toString()).toContain("%PDF-");
    expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, refs.UNINITIALIZED!.lineId)))).toEqual([]);
    await withTenant(database.db, context, tx => tx.update(orderProtectedDetails).set({ retentionExpiresAt: new Date(0) }).where(eq(orderProtectedDetails.orderId, refs.UNINITIALIZED!.orderId)));
    await expect(service.label(context, supplierId, imported.records[0]!.id)).rejects.toBeInstanceOf(ConflictException);
    const run = await sync(["MATCHED", "NO-LOCAL", "EXPIRED"]), matched = run.records.find(row => row.orderNumber === "MATCHED")!;
    expect((await service.label(context, supplierId, matched.id)).toString()).toContain("%PDF-");
    const before = label.mock.calls.length;
    for (const number of ["NO-LOCAL", "EXPIRED"]) await expect(service.label(context, supplierId, run.records.find(row => row.orderNumber === number)!.id)).rejects.toBeInstanceOf(ConflictException);
    expect(label).toHaveBeenCalledTimes(before);
    await expect(service.label(other, supplierId, matched.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.label({ ...context, permissions: [Permission.OrderRead] }, supplierId, matched.id)).rejects.toBeInstanceOf(ForbiddenError);
    label.mockImplementationOnce(async () => { await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ expiresAt: new Date(0), encryptedDataKey: null }).where(eq(orderWorkItems.id, refs.MATCHED!.lineId))); return Buffer.from("%PDF-1.7 synthetic"); });
    await expect(service.label(context, supplierId, matched.id)).rejects.toBeInstanceOf(ConflictException);
    const recent = (await service.workspace(context, supplierId)).recent.find(row => row.orderNumber === "MATCHED")!;
    expect(recent).toMatchObject({ match: "expired", labelAvailable: false, trackingNumber: null, localLineId: null });
  });
  it("retains safe query failures, recovers interrupted requests and rejects changed connections during a sync", async () => {
    query.mockRejectedValueOnce(new Error("synthetic-secret private buyer"));
    const failed = await sync(["NO-LOCAL"]); expect(failed.status).toBe("failed"); expect(JSON.stringify(failed)).not.toMatch(/private buyer|synthetic-secret/);
    const interrupted = createEntityId();
    const [connection] = await withTenant(database.db, context, tx => tx.select().from(shiposConnections));
    await withTenant(database.db, context, async tx => {
      const [reserved] = await tx.update(shiposConnections).set({ syncSequence: sql`${shiposConnections.syncSequence}+1` }).where(eq(shiposConnections.id, connection!.id)).returning();
      await tx.insert(shiposSyncRuns).values({ id: interrupted, tenantId, connectionId: connection!.id, connectionVersion: version, syncSequence: reserved!.syncSequence,
        idempotencyKey: randomUUID(), requestChecksum: "a".repeat(64), orderNumbers: ["NO-LOCAL"], status: "running", createdBy: userId, createdAt: sql`clock_timestamp()-interval '100 seconds'` });
    });
    expect((await service.workspace(context, supplierId)).runs.find(run => run.id === interrupted)).toMatchObject({ status: "failed", diagnostic: "interrupted" });
    query.mockImplementationOnce(async () => { const saved = await save({ status: "paused" }); version = saved.version; return []; });
    expect(await sync(["NO-LOCAL"])).toMatchObject({ status: "failed", diagnostic: "connection_changed" });
    const before = query.mock.calls.length; await expect(sync(["NO-LOCAL"])).rejects.toBeInstanceOf(ConflictException); expect(query).toHaveBeenCalledTimes(before);
    const cleared = await save({ status: "draft", clearCredentials: true }); version = cleared.version; expect(cleared).toMatchObject({ credentialsConfigured: false, appKeyHint: null });
  });
});
