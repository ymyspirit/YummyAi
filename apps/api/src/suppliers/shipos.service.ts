import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SaveShiposConnectionSchema, SyncShiposOrdersSchema, TestShiposConnectionSchema, ShiposConnectionViewSchema, ShiposRunViewSchema, ShiposRecordViewSchema, ShiposWorkspaceSchema,
  type ShiposOrderEvidence, type ShiposRecordView, type ShiposRunView } from "@yummyai/contracts/suppliers/shipos";
import { ShiposShipmentSelectionSchema, ShiposShipmentSourceSchema, ShiposOrderShipmentEvidenceSchema, type ShiposCarrierMapping } from "@yummyai/contracts/suppliers/shipos";
import { fulfillmentSuppliers, orders, orderLines, orderWorkItems, orderProtectedDetails, amazonOrderReportLines, shiposConnections as connections, shiposSyncRuns as runs, shiposOrderSnapshots as snapshots,
  type DatabaseConnection, type TenantTransaction, withTenant } from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, INTEGRATION_SECRET_VAULT } from "../platform.tokens.js";
import { ShiposReadGateway, ShiposIdentityError, type ShiposCredentials } from "./shipos-read.gateway.js";

type Connection = typeof connections.$inferSelect;
type Run = typeof runs.$inferSelect;
type Snapshot = typeof snapshots.$inferSelect;
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const blankEvidence = (orderNumber: string, diagnostic: "query_failed" | "not_returned"): ShiposOrderEvidence => ({ orderNumber, trackingNumber: null, labelAvailable: false,
  statusCode: null, cancelStatusCode: null, labelStatusCode: null, settlementStatusCode: null, channel: null, fee: null, currency: null, diagnostics: [diagnostic] });

@Injectable()
export class ShiposService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(INTEGRATION_SECRET_VAULT) private readonly vault: SecretVault,
    @Inject(ShiposReadGateway) private readonly gateway: ShiposReadGateway,
    @Inject(AuditService) private readonly audit: AuditService) {}

  /** Local immutable query evidence only; never calls the ShipOS gateway. */
  async orderEvidence(context: TenantContext, orderId: string) {
    this.read(context); authorize(context, Permission.OrderPiiRead);
    return withTenant(this.database.db, context, async tx => {
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
      if (!order) throw new NotFoundException("订单不存在或无权访问");
      const rows = await tx.select({ snapshot: snapshots, sequence: runs.syncSequence, connection: connections, supplierId: connections.supplierId, supplierName: fulfillmentSuppliers.name })
        .from(snapshots).innerJoin(runs, eq(runs.id, snapshots.runId))
        .innerJoin(connections, eq(connections.id, runs.connectionId))
        .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, connections.supplierId))
        .where(eq(snapshots.localOrderId, orderId)).orderBy(...observationOrder());
      const seen = new Set<string>(), result = [];
      for (const row of rows) {
        if (seen.has(row.supplierId)) continue;
        seen.add(row.supplierId);
        const record = await this.recordView(tx, row.snapshot);
        result.push(ShiposOrderShipmentEvidenceSchema.parse({ supplierId: row.supplierId, supplierName: row.supplierName, record,
          connectionVersion: row.connection.version, carrierMapping: row.connection.channelMappings.find(mapping => mapping.channel === record.channel) ?? null,
          blockers: [...shipmentEvidenceBlockers(record, row.connection), ...(row.sequence === null ? ["历史记录缺少可靠同步顺序，请重新同步后选择运单"] : [])] }));
      }
      return result;
    });
  }

  /** Pin cached evidence inside the caller's shipment transaction; no vendor operation. */
  async pinShipmentEvidence(context: TenantContext, tx: TenantTransaction, orderId: string, raw: unknown,
    fields: Pick<ShiposCarrierMapping, "carrierCode" | "carrierName" | "carrierService" | "shipFromCountryCode"> & { trackingNumber: string }) {
    this.read(context); authorize(context, Permission.OrderPiiRead);
    const input = ShiposShipmentSelectionSchema.parse(raw);
    let connection: Connection | undefined;
    try {
      [connection] = await tx.select().from(connections).where(eq(connections.supplierId, input.supplierId)).for("share", { noWait: true });
    } catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      if (failure.code === "55P03" || failure.cause?.code === "55P03") throw new ConflictException("ShipOS 同步或配置正在提交，请保留填写并刷新后重试");
      throw error;
    }
    if (!connection || connection.version !== input.expectedConnectionVersion) throw new ConflictException("ShipOS 连接或渠道配置已变更，请刷新后重新选择运单");
    const [latest] = await tx.select({ snapshot: snapshots, sequence: runs.syncSequence }).from(snapshots).innerJoin(runs, eq(runs.id, snapshots.runId))
      .where(and(eq(runs.connectionId, connection.id), eq(snapshots.localOrderId, orderId))).orderBy(...observationOrder()).limit(1);
    if (!latest || latest.snapshot.id !== input.recordId) throw new ConflictException("运单不是本单最新关联记录，请刷新后重新选择");
    if (latest.sequence === null) throw new ConflictException("历史记录缺少可靠同步顺序，请重新同步后选择运单");
    const record = await this.recordView(tx, latest.snapshot), blockers = shipmentEvidenceBlockers(record, connection);
    if (blockers.length) throw new ConflictException(blockers.join("；"));
    if (record.trackingNumber !== fields.trackingNumber) throw new ConflictException("运单号与 ShipOS 记录不一致；如需手填，请先取消带入来源");
    const mapping = connection.channelMappings.find(mapping => mapping.channel === record.channel) ?? null;
    if (mapping && ["carrierCode", "carrierName", "carrierService", "shipFromCountryCode"].some(key => mapping[key as keyof ShiposCarrierMapping] !== fields[key as keyof typeof fields]))
      throw new ConflictException("承运信息与已保存的渠道配置不一致，请刷新配置或取消带入来源后核对填写");
    return ShiposShipmentSourceSchema.parse({ supplierId: input.supplierId, recordId: record.id, connectionVersion: connection.version,
      fetchedAt: record.fetchedAt, labelAvailable: record.labelAvailable, channel: record.channel, carrierMapping: mapping });
  }

  async workspace(context: TenantContext, supplierId: string) {
    this.read(context);
    return withTenant(this.database.db, context, async tx => {
      await this.parent(tx, supplierId);
      const connection = await this.connection(tx, supplierId);
      if (!connection) return ShiposWorkspaceSchema.parse({ connection: null, runs: [], recent: [], truncated: false });
      await this.recover(tx, connection.id);
      const history = await tx.select().from(runs).where(eq(runs.connectionId, connection.id)).orderBy(sql`${runs.syncSequence} desc nulls last`, desc(runs.createdAt), desc(runs.id)).limit(21);
      const savedRows = history.length ? await tx.select({ snapshot: snapshots }).from(snapshots).innerJoin(runs, eq(runs.id, snapshots.runId))
        .where(inArray(snapshots.runId, history.slice(0, 20).map(run => run.id))).orderBy(...observationOrder()) : [];
      const saved = savedRows.map(row => row.snapshot);
      const views: ShiposRecordView[] = [];
      for (const snapshot of saved) views.push(await this.recordView(tx, snapshot));
      const seen = new Set<string>();
      const recent = views.filter(view => { if (seen.has(view.orderNumber)) return false; seen.add(view.orderNumber); return true; });
      return ShiposWorkspaceSchema.parse({ connection: this.connectionView(connection), runs: history.slice(0, 20).map(run => this.runView(run, views.filter(v => v.runId === run.id))), recent, truncated: history.length > 20 });
    });
  }
  async save(context: TenantContext, supplierId: string, raw: unknown) {
    this.manage(context); const input = SaveShiposConnectionSchema.parse(raw), checksum = hash({ supplierId, input });
    return withTenant(this.database.db, context, async tx => {
      await this.lock(tx, supplierId); await this.parent(tx, supplierId);
      const current = await this.connection(tx, supplierId);
      if (current?.lastRequestKey === input.idempotencyKey) {
        if (current.lastRequestChecksum !== checksum) throw new ConflictException("相同保存请求的内容发生变化");
        return this.connectionView(current);
      }
      if ((current?.version ?? 0) !== input.expectedVersion) throw new ConflictException("连接已更新，请刷新后重试");
      const encryptedCredentials = input.clearCredentials ? null : input.appKey ? this.vault.encrypt(JSON.stringify({ appKey: input.appKey, appSecret: input.appSecret })) : current?.encryptedCredentials ?? null;
      if (input.status === "active" && !encryptedCredentials) throw new ConflictException("启用连接须先填写 AppKey 与 AppSecret；也可以保存草稿");
      const values = { name: input.name, status: input.status, version: input.expectedVersion + 1, encryptedCredentials,
        channelMappings: input.channelMappings ?? current?.channelMappings ?? [],
        appKeyHint: input.clearCredentials ? null : input.appKey ? `••••${input.appKey.slice(-4)}` : current?.appKeyHint ?? null,
        lastRequestKey: input.idempotencyKey, lastRequestChecksum: checksum, lastTestAt: null, lastTestResult: null, updatedAt: new Date() };
      const [saved] = current ? await tx.update(connections).set(values).where(eq(connections.id, current.id)).returning() : await tx.insert(connections).values({ ...values, id: createEntityId(), tenantId: context.tenantId, supplierId, createdBy: context.userId }).returning();
      await this.audit.recordInTransaction(tx, context, { action: "shipos.connection.save", resourceType: "shipos_connection", resourceId: saved!.id, result: "success", metadata: { version: saved!.version, status: saved!.status } });
      return this.connectionView(saved!);
    });
  }
  async test(context: TenantContext, supplierId: string, raw: unknown) {
    this.manage(context); const input = TestShiposConnectionSchema.parse(raw);
    const connection = await withTenant(this.database.db, context, tx => this.requiredConnection(tx, supplierId, input.expectedVersion, false));
    let result: { channelCount: number } | null = null;
    try { result = await this.withCredentials(connection, credentials => this.gateway.channels(credentials)); } catch { /* No vendor body, key, or personal data is logged. */ }
    return withTenant(this.database.db, context, async tx => {
      await this.lock(tx, supplierId); await this.requiredConnection(tx, supplierId, input.expectedVersion, false);
      const [updated] = await tx.update(connections).set({ lastTestAt: new Date(), lastTestResult: result ? "success" : "failed" }).where(eq(connections.id, connection.id)).returning();
      await this.audit.recordInTransaction(tx, context, { action: "shipos.connection.test", resourceType: "shipos_connection", resourceId: connection.id, result: result ? "success" : "failure" });
      return { connection: this.connectionView(updated!), success: !!result, channelCount: result?.channelCount ?? null };
    });
  }
  async sync(context: TenantContext, supplierId: string, raw: unknown): Promise<ShiposRunView> {
    this.manage(context); authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    const input = SyncShiposOrdersSchema.parse(raw); input.orderNumbers.sort();
    const checksum = hash({ supplierId, input });
    const prepared = await withTenant(this.database.db, context, async tx => {
      await this.lock(tx, supplierId); await this.parent(tx, supplierId);
      const connection = await this.connection(tx, supplierId); if (!connection) throw new NotFoundException("ShipOS 连接未配置");
      await this.recover(tx, connection.id);
      const [replay] = await tx.select().from(runs).where(eq(runs.idempotencyKey, input.idempotencyKey));
      if (replay) {
        if (replay.requestChecksum !== checksum || replay.connectionId !== connection.id) throw new ConflictException("相同同步请求的内容发生变化");
        return { replay: await this.loadRun(tx, replay), connection, run: replay };
      }
      await this.requiredConnection(tx, supplierId, input.expectedVersion, true);
      if ((await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.connectionId, connection.id), eq(runs.status, "running")))).length) throw new ConflictException("该连接已有同步正在进行，请稍后刷新");
      const [reserved] = await tx.update(connections).set({ syncSequence: sql`${connections.syncSequence} + 1` })
        .where(eq(connections.id, connection.id)).returning({ sequence: connections.syncSequence });
      const [run] = await tx.insert(runs).values({ id: createEntityId(), tenantId: context.tenantId, connectionId: connection.id, connectionVersion: connection.version, idempotencyKey: input.idempotencyKey,
        requestChecksum: checksum, orderNumbers: input.orderNumbers, syncSequence: reserved!.sequence, status: "running", createdBy: context.userId }).returning();
      return { replay: null, connection, run: run! };
    });
    if (prepared.replay) return prepared.replay;
    let evidence: ShiposOrderEvidence[];
    try {
      evidence = await this.withCredentials(prepared.connection, async credentials => {
        const queried = await this.gateway.orders(credentials, input.orderNumbers);
        return Promise.all(input.orderNumbers.map(async number => {
          const record = queried.find(row => row.orderNumber === number); if (!record) return blankEvidence(number, "not_returned");
          try {
            const detail = await this.gateway.detail(credentials, number);
            return { ...record, trackingNumber: detail.trackingNumber ?? record.trackingNumber, labelAvailable: record.labelAvailable || !!detail.labelUrl, channel: detail.channel, fee: detail.fee, currency: detail.currency };
          } catch (error) { return { ...record, diagnostics: [...record.diagnostics, error instanceof ShiposIdentityError ? "detail_mismatch" as const : "detail_unavailable" as const] }; }
        }));
      });
    } catch { evidence = input.orderNumbers.map(number => blankEvidence(number, "query_failed")); }
    return withTenant(this.database.db, context, async tx => {
      await this.lock(tx, supplierId);
      const [run] = await tx.select().from(runs).where(eq(runs.id, prepared.run.id));
      if (!run || run.status !== "running") { if (run) return this.loadRun(tx, run); throw new NotFoundException("同步记录不存在"); }
      // Pinning holds FOR SHARE through its shipment transaction. Serialize the
      // observation commit with it; the pin uses NOWAIT to avoid an inverse
      // order-header/connection wait while the evidence FK is being checked.
      const [current] = await tx.select().from(connections).where(eq(connections.supplierId, supplierId)).for("no key update");
      if (!current || current.version !== prepared.connection.version || current.status !== "active") {
        const [failed] = await tx.update(runs).set({ status: "failed", diagnostic: "connection_changed", completedAt: new Date() }).where(eq(runs.id, run.id)).returning();
        return this.loadRun(tx, failed!);
      }
      let successes = 0, complete = true;
      for (const record of evidence) {
        const available = !record.diagnostics.some(d => d === "query_failed" || d === "not_returned");
        const match = available ? await this.match(tx, record.orderNumber) : { localOrderId: null, localLineId: null, match: "unavailable" as const, diagnostic: null };
        if (available) successes++;
        if (record.diagnostics.length || match.match !== "matched") complete = false;
        await tx.insert(snapshots).values({ id: createEntityId(), tenantId: context.tenantId, runId: run.id, evidence: { ...record, diagnostics: match.diagnostic ? [...record.diagnostics, match.diagnostic] : record.diagnostics },
          localOrderId: match.localOrderId, localLineId: match.localLineId, match: match.match });
      }
      const [finished] = await tx.update(runs).set({ status: successes === 0 ? "failed" : complete ? "completed" : "partial", diagnostic: successes === 0 ? "query_failed" : null, completedAt: new Date() }).where(eq(runs.id, run.id)).returning();
      await this.audit.recordInTransaction(tx, context, { action: "shipos.orders.sync", resourceType: "shipos_sync_run", resourceId: run.id, result: successes ? "success" : "failure", metadata: { requestedCount: input.orderNumbers.length, fetchedCount: successes } });
      return this.loadRun(tx, finished!);
    });
  }
  async label(context: TenantContext, supplierId: string, snapshotId: string) {
    this.read(context); authorize(context, Permission.OrderPiiRead);
    const read = () => withTenant(this.database.db, context, async tx => {
      await this.parent(tx, supplierId);
      const connection = await this.connection(tx, supplierId); if (!connection || connection.status !== "active" || !connection.encryptedCredentials) throw new ConflictException("连接未启用");
      const [row] = await tx.select({ snapshot: snapshots }).from(snapshots).innerJoin(runs, eq(runs.id, snapshots.runId)).where(and(eq(snapshots.id, snapshotId), eq(runs.connectionId, connection.id)));
      if (!row) throw new NotFoundException("同步记录不存在");
      const snapshot = row.snapshot;
      if (snapshot.match !== "matched" || !snapshot.evidence.labelAvailable || !snapshot.localOrderId || !snapshot.localLineId || !await this.retained(tx, snapshot.localOrderId, snapshot.localLineId)) throw new ConflictException("面单需关联有效的本地订单；未关联、歧义或资料到期时不可下载");
      return { connection, snapshot };
    });
    const { connection, snapshot } = await read();
    let bytes: Buffer;
    try { bytes = await this.withCredentials(connection, credentials => this.gateway.existingLabel(credentials, snapshot.evidence.orderNumber, snapshot.evidence.trackingNumber)); }
    catch { throw new ConflictException("现有面单暂时无法读取；本功能不会请求生成或购买面单"); }
    const latest = await read();
    if (latest.connection.version !== connection.version) throw new ConflictException("连接已更新，请重试");
    await this.audit.record(context, { action: "shipos.label.read", resourceType: "shipos_order_snapshot", resourceId: snapshotId, result: "success" });
    return bytes;
  }
  private async match(tx: TenantTransaction, number: string) {
    const found = await tx.select({ id: orders.id }).from(orders).where(eq(orders.externalOrderId, number)).limit(2);
    if (!found.length) return { match: "missing" as const, localOrderId: null, localLineId: null, diagnostic: "no_local_order" as const };
    if (found.length > 1) return { match: "ambiguous" as const, localOrderId: null, localLineId: null, diagnostic: "ambiguous_local_order" as const };
    const lines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, found[0]!.id)).orderBy(asc(orderLines.id)).limit(100);
    for (const line of lines) if (await this.retained(tx, found[0]!.id, line.id)) return { match: "matched" as const, localOrderId: found[0]!.id, localLineId: line.id, diagnostic: null };
    return { match: "expired" as const, localOrderId: found[0]!.id, localLineId: null, diagnostic: "retention_expired" as const };
  }
  private async retained(tx: TenantTransaction, orderId: string, lineId: string) {
    const [row] = await tx.select({ addressStatus: orders.addressStatus,
      workId: orderWorkItems.id, workLive: sql<boolean>`${orderWorkItems.encryptedDataKey} is not null AND ${orderWorkItems.expiresAt}>now() AND ${orderWorkItems.archivedAt} is null`,
      reportId: amazonOrderReportLines.id, reportLive: sql<boolean>`${amazonOrderReportLines.encryptedSource} is not null AND ${amazonOrderReportLines.expiresAt}>now() AND ${amazonOrderReportLines.state}<>'expired'`,
      protectedId: orderProtectedDetails.id, protectedLive: sql<boolean>`${orderProtectedDetails.encryptedEnvelope} is not null AND ${orderProtectedDetails.retentionExpiresAt}>now() AND ${orderProtectedDetails.status}='protected'`,
    }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId)).leftJoin(orderWorkItems, eq(orderWorkItems.id, orderLines.id))
      .leftJoin(amazonOrderReportLines, eq(amazonOrderReportLines.orderLineId, orderLines.id)).leftJoin(orderProtectedDetails, eq(orderProtectedDetails.orderId, orders.id))
      .where(and(eq(orders.id, orderId), eq(orderLines.id, lineId)));
    if (!row || row.addressStatus === "anonymized" || row.workId && !row.workLive || row.reportId && !row.reportLive || row.protectedId && !row.protectedLive) return false;
    // An imported/API order may not have a saved production work item yet. Its retained
    // encrypted source is sufficient for an external label read; no production task is created.
    return !!(row.workId && row.workLive || row.reportId && row.reportLive || row.protectedId && row.protectedLive);
  }
  private async recordView(tx: TenantTransaction, row: Snapshot) {
    const expired = row.match === "matched" && (!row.localOrderId || !row.localLineId || !await this.retained(tx, row.localOrderId, row.localLineId));
    return ShiposRecordViewSchema.parse({ ...row.evidence, id: row.id, runId: row.runId, fetchedAt: row.fetchedAt.toISOString(), localOrderId: row.localOrderId, localLineId: expired ? null : row.localLineId,
      match: expired ? "expired" : row.match, ...(expired ? { trackingNumber: null, labelAvailable: false, diagnostics: [...new Set([...row.evidence.diagnostics, "retention_expired"])] } : {}) });
  }
  private runView(run: Run, records: ShiposRecordView[]) { return ShiposRunViewSchema.parse({ id: run.id, status: run.status, orderNumbers: run.orderNumbers, diagnostic: run.diagnostic, createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null, records }); }
  private async loadRun(tx: TenantTransaction, run: Run) { const saved = await tx.select().from(snapshots).where(eq(snapshots.runId, run.id)); const views = []; for (const row of saved) views.push(await this.recordView(tx, row)); return this.runView(run, views); }
  private connectionView(row: Connection) { return ShiposConnectionViewSchema.parse({ id: row.id, supplierId: row.supplierId, name: row.name, status: row.status, version: row.version, channelMappings: row.channelMappings, credentialsConfigured: !!row.encryptedCredentials, appKeyHint: row.appKeyHint, lastTestAt: row.lastTestAt?.toISOString() ?? null, lastTestResult: row.lastTestResult, updatedAt: row.updatedAt.toISOString() }); }
  private connection(tx: TenantTransaction, supplierId: string) { return tx.select().from(connections).where(eq(connections.supplierId, supplierId)).then(rows => rows[0]); }
  private async requiredConnection(tx: TenantTransaction, supplierId: string, version: number, active: boolean) {
    await this.parent(tx, supplierId); const row = await this.connection(tx, supplierId);
    if (!row || row.version !== version) throw new ConflictException("连接已更新或尚未配置，请刷新");
    if (!row.encryptedCredentials || row.status === "paused" || active && row.status !== "active") throw new ConflictException("请填写凭据并启用连接；暂停状态不可查询");
    return row;
  }
  private async parent(tx: TenantTransaction, id: string) { const [row] = await tx.select({ id: fulfillmentSuppliers.id }).from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, id)); if (!row) throw new NotFoundException("供应商不存在"); }
  private withCredentials<T>(row: Connection, callback: (credentials: ShiposCredentials) => Promise<T>) { return this.vault.withSecret(row.encryptedCredentials!, raw => callback(JSON.parse(raw) as ShiposCredentials)); }
  private lock(tx: TenantTransaction, id: string) { return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id') || ':shipos:' || ${id},0))`); }
  private recover(tx: TenantTransaction, id: string) { return tx.update(runs).set({ status: "failed", diagnostic: "interrupted", completedAt: new Date() }).where(and(eq(runs.connectionId, id), eq(runs.status, "running"), sql`${runs.createdAt}<now()-interval '90 seconds'`)); }
  private read(context: TenantContext) { authorize(context, Permission.OrderRead); if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderRead, "outside_data_scope"); }
  private manage(context: TenantContext) { this.read(context); authorize(context, Permission.IntegrationManage); }
}
function observationOrder() {
  return [sql`${runs.syncSequence} desc nulls last`, desc(snapshots.fetchedAt), desc(snapshots.id)];
}
function shipmentEvidenceBlockers(record: ShiposRecordView, connection: Connection): string[] {
  const blockers: string[] = [];
  if (connection.status !== "active") blockers.push("ShipOS 连接未启用，请先核对连接配置");
  if (record.match !== "matched") blockers.push("ShipOS 记录未明确关联本地订单，或制作资料已不可访问");
  if (!record.trackingNumber) blockers.push("该记录尚未返回运单号");
  if (record.cancelStatusCode !== 0) blockers.push("取消标记尚未明确为 0，请重新同步并核对原运单");
  if (record.statusCode === 22) blockers.push("该记录已退款，不能带入有效包裹");
  if (record.diagnostics.some(code => ["query_failed", "not_returned", "detail_mismatch"].includes(code))) blockers.push("运单查询或身份核对未通过，请重新同步");
  return blockers;
}
