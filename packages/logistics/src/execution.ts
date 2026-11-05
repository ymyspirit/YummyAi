import { createHash } from "node:crypto";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { LogisticsCredentialsSchema, LogisticsTaskSnapshotSchema, LogisticsQuoteSchema, type LogisticsQuote, type LogisticsTaskState } from "@yummyai/contracts/logistics";
import { logisticsTasks as tasks, logisticsConnectionVersions as connections, logisticsConnections, logisticsRuleVersions as rules, logisticsQuotes as quotes, logisticsEvents as events, logisticsLabels as labels, memberships,membershipRoles,roles,
  productionOrders, productionOrderVersions, orderProtectedDetails, orders, orderWorkItems, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import { logisticsCostBlocker, selectLogisticsQuote } from "./policy.js";
import type { LogisticsGateway, LogisticsProviderResult } from "./gateway.js";
import { LogisticsTransportError } from "./gateway.js";
import { purgeLogisticsTasks } from "./retention.js";
import { Permission } from "@yummyai/authz";
export const logisticsHash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const logisticsLock = (tx: TenantTransaction, context: TenantContext, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:logistics:${key}`},0))`);
type Task = typeof tasks.$inferSelect;
type Loaded = { task: Task; connection: typeof connections.$inferSelect; rule: typeof rules.$inferSelect; snapshot: ReturnType<typeof LogisticsTaskSnapshotSchema.parse>; runId: string };
export class LogisticsExecutor {
  constructor(private readonly database: DatabaseConnection, private readonly integrationVault: SecretVault, private readonly piiVault: SecretVault, private readonly storage: Storage, private readonly gateway: LogisticsGateway) {}
  async run(context: TenantContext, taskId: string, mode: "quote"|"purchase"|"reconcile") {
    await this.purge(context,taskId);
    const loaded = await this.claim(context,taskId);
    if (!loaded) return { taskId, status: "ignored" };
    const { task, connection, snapshot, rule } = loaded;
    try {
      const credentials = this.integrationVault.withSecret(connection.encryptedCredentials,s => LogisticsCredentialsSchema.parse(JSON.parse(s)));
      if (task.reservedDay || task.providerOrderId || task.labelRequestedAt || ["purchasing","created","label_requesting","reconciliation_required"].includes(task.status)) {
        const found = await this.gateway.lookup(connection.profile,credentials,task.externalReference);
        if (!found) return this.finish(context,loaded,"reconciliation_required","PROVIDER_ORDER_NOT_CONFIRMED");
        // Resume only an existing order; absence never authorizes another purchase.
        await this.acceptCreated(context,loaded,found);
        return await this.completeLabels(context,loaded,credentials,found,!!task.labelRequestedAt);
      }
      if (mode === "reconcile") return this.finish(context,loaded,"attention","NO_PURCHASE_TO_RECONCILE");
      const received = (await this.gateway.quote(connection.profile,credentials,snapshot,task.externalReference)).map(q => LogisticsQuoteSchema.parse(q));
      await this.recordQuotes(context,loaded,received);
      const selection = selectLogisticsQuote(received,rule.rule,snapshot);
      if (!selection.selected) return this.finish(context,loaded,"attention",this.rejectedCost(selection.rejected)??"NO_ELIGIBLE_CHANNEL");
      if (mode === "quote" || !rule.rule.autoPurchase) return this.finish(context,loaded,"quoted",null,selection.selected);
      // Reprice immediately before the irreversible request; select again across available services.
      const refreshed = (await this.gateway.quote(connection.profile,credentials,snapshot,task.externalReference)).map(q => LogisticsQuoteSchema.parse(q));
      await this.recordQuotes(context,loaded,refreshed);
      const rechecked = selectLogisticsQuote(refreshed,rule.rule,snapshot),selected=rechecked.selected;
      if (!selected) return this.finish(context,loaded,"attention",this.rejectedCost(rechecked.rejected)??"PRICE_OR_SERVICE_CHANGED");
      // Manual spreadsheet orders may already use this reference. Never adopt or buy over them implicitly.
      if(await this.gateway.lookup(connection.profile,credentials,task.externalReference))return this.finish(context,loaded,"attention","PROVIDER_REFERENCE_CONFLICT");
      const reserved = await this.reserve(context,loaded,selected);
      if (!reserved) return this.finish(context,loaded,"attention","DAILY_BUDGET_EXCEEDED");
      const result = await this.gateway.create(connection.profile,credentials,snapshot,task.externalReference,selected);
      await this.acceptCreated(context,loaded,result);
      return await this.completeLabels(context,loaded,credentials,result,false);
    } catch {
      const [latest] = await withTenant(this.database.db,context,tx => tx.select().from(tasks).where(eq(tasks.id,taskId)));
      const uncertain = !!latest?.reservedDay || !!latest?.providerOrderId || ["purchasing","created","label_requesting","reconciliation_required"].includes(latest?.status ?? "");
      return this.finish(context,loaded,uncertain ? "reconciliation_required" : "attention",uncertain ? "PROVIDER_RESULT_REQUIRES_RECONCILIATION" : "LOGISTICS_EXECUTION_UNAVAILABLE");
    }
  }
  purge(context:TenantContext,taskId:string){return purgeLogisticsTasks(this.database,context,this.storage,new Date(),taskId);}
  private rejectedCost(rejected:Array<{reason:string}>){
    return rejected.find(item=>["PER_ITEM_COST_EXCEEDED","PURCHASE_QUANTITY_UNAVAILABLE"].includes(item.reason))?.reason;
  }
  private async claim(context: TenantContext, id: string): Promise<Loaded|null> {
    return withTenant(this.database.db,context,async tx => {
      await logisticsLock(tx,context,`task:${id}`);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id,id));
      if (!task || ["completed","cancelled"].includes(task.status) || task.diagnostic==="PROVIDER_REFERENCE_CONFLICT" || task.leaseUntil && task.leaseUntil > new Date()) return null;
      const [connection] = await tx.select().from(connections).where(eq(connections.id,task.connectionVersionId));
      const [rule] = await tx.select().from(rules).where(eq(rules.id,task.ruleVersionId));
      if (!connection || !rule || !task.encryptedSnapshot) return null;
      const snapshot = this.piiVault.withSecret(task.encryptedSnapshot,s => LogisticsTaskSnapshotSchema.parse(JSON.parse(s)));
      if (logisticsHash(snapshot) !== task.snapshotHash) throw new Error("LOGISTICS_SNAPSHOT_CORRUPT");
      const problem = await this.blocker(tx,context,task,snapshot);
      if (problem) { await tx.update(tasks).set({ status: task.reservedDay || task.providerOrderId ? "reconciliation_required" : "attention", diagnostic:problem, leaseUntil:null, processingRunId:null, updatedAt:new Date() }).where(eq(tasks.id,id)); return null; }
      const runId=createEntityId();
      await tx.update(tasks).set({ processingRunId:runId, leaseUntil:new Date(Date.now()+600_000), updatedAt:new Date() }).where(eq(tasks.id,id));
      return { task, connection, rule, snapshot, runId };
    });
  }
  private async blocker(tx: TenantTransaction, context: TenantContext, task: Task, snapshot: Loaded["snapshot"]) {
    const [member]=await tx.select().from(memberships).where(and(eq(memberships.userId,context.userId),eq(memberships.status,"active")));
    if (!member) return "REQUESTER_MEMBERSHIP_DISABLED";
    const grants=await tx.select({permissions:roles.permissions,dataScope:roles.dataScope}).from(membershipRoles).innerJoin(roles,eq(roles.id,membershipRoles.roleId)).where(eq(membershipRoles.membershipId,member.id));
    const permissions=new Set(grants.flatMap(g=>[...g.permissions]));
    if(![Permission.OrderRead,Permission.OrderPiiRead,Permission.OrderWrite].every(p=>permissions.has(p)))return "REQUESTER_PERMISSIONS_REVOKED";
    if(!grants.some(grant=>grant.dataScope==="tenant"))return "REQUESTER_PERMISSIONS_REVOKED";
    const [order]=await tx.select().from(orders).where(eq(orders.id,task.orderId));
    const [address]=await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId,task.orderId));
    if (!order || order.sideState || order.addressStatus !== "protected") return "ORDER_CANCELLED_OR_HELD";
    if (!address || address.status!=="protected" || address.envelopeVersion!==snapshot.addressEnvelopeVersion || address.retentionExpiresAt<=new Date() || task.expiresAt<=new Date()) return "ADDRESS_CHANGED_OR_EXPIRED";
    const current=await tx.select({ production:productionOrders, version:productionOrderVersions }).from(productionOrders).innerJoin(productionOrderVersions,and(eq(productionOrderVersions.productionOrderId,productionOrders.id),eq(productionOrderVersions.versionNumber,productionOrders.currentVersionNumber))).where(inArray(productionOrders.id,snapshot.productionOrderIds));
    if(current.length!==snapshot.productionPins.length || current.some(r => ["cancel_requested","cancelled","failed","quality_hold"].includes(r.production.status) || !snapshot.productionPins.some(pin => pin.productionOrderId===r.production.id && pin.versionId===r.version.id && pin.quantity===r.version.quantity && r.version.factoryId===snapshot.factoryId && r.version.factoryVersionId===snapshot.factoryVersionId))) return "PRODUCTION_ASSIGNMENT_CHANGED";
    const works=await tx.select().from(orderWorkItems).where(inArray(orderWorkItems.id,snapshot.productionPins.map(p=>p.lineId)));
    if(works.some(w=>w.held || current.some(r=>r.production.orderLineId===w.id && (r.version.sourceWorkRevisionId!==w.pushedRevisionId || w.artwork!=="approved" || !["approved","not_required"].includes(w.proof) || r.version.sourceEditorVersionId!==w.approvedEditorVersionId)))) return "ARTWORK_CHANGED_OR_HELD";
    return null;
  }
  private async reserve(context: TenantContext,l: Loaded,quote: LogisticsQuote) {
    return withTenant(this.database.db,context,async tx => {
      const day=new Date().toISOString().slice(0,10);
      await logisticsLock(tx,context,`budget:${l.rule.rule.currency}:${day}`); await logisticsLock(tx,context,`task:${l.task.id}`);
      const [latest]=await tx.select().from(tasks).where(eq(tasks.id,l.task.id));
      if(latest?.processingRunId!==l.runId || latest.reservedDay || latest.providerOrderId || !["pending","quoted","attention"].includes(latest.status)) throw new Error("PURCHASE_INTENT_ALREADY_EXISTS");
      const problem=await this.blocker(tx,context,latest,l.snapshot); if(problem) throw new Error(problem);
      const [enabled]=await tx.select().from(logisticsConnections).where(eq(logisticsConnections.id,l.connection.connectionId));
      if (!enabled || enabled.verifiedVersionId!==l.connection.id || enabled.version!==l.connection.version || enabled.ruleVersion!==l.rule.version || l.rule.connectionVersionId!==l.connection.id || !l.rule.rule.autoPurchase) throw new Error("AUTOMATIC_PURCHASE_NOT_VERIFIED");
      if(l.rule.rule.maxDailyMinor!==null){
        const used=await tx.select().from(tasks).where(and(eq(tasks.reservedDay,day),sql`${tasks.selectedQuote}->>'currency'=${l.rule.rule.currency}`));
        const spend=used.reduce((sum,t)=>sum+Math.max(t.reservationMinor,t.actualCostMinor??0),0);
        if(spend+quote.totalMinor>l.rule.rule.maxDailyMinor) return false;
      }
      const costBlocker=logisticsCostBlocker(quote.totalMinor,l.rule.rule,l.snapshot);
      if(costBlocker)throw new Error(costBlocker);
      await tx.update(tasks).set({ status:"purchasing", selectedQuote:quote, reservationMinor:quote.totalMinor, reservedDay:day, diagnostic:null, updatedAt:new Date() }).where(eq(tasks.id,l.task.id));
      await this.event(tx,context,l.task.id,"purchase.intent",{ channelCode:quote.channelCode, totalMinor:quote.totalMinor, currency:quote.currency });
      return true;
    });
  }
  private async acceptCreated(context: TenantContext,l: Loaded,result: LogisticsProviderResult) {
    if(!result.providerOrderId || result.actualCostMinor!==null && result.actualCurrency!==l.rule.rule.currency) throw new Error("PROVIDER_IDENTITY_OR_CURRENCY_MISMATCH");
    await withTenant(this.database.db,context,async tx => {
      await logisticsLock(tx,context,`task:${l.task.id}`);
      const [current]=await tx.select().from(tasks).where(eq(tasks.id,l.task.id)); if(current?.processingRunId!==l.runId) throw new Error("TASK_LEASE_CHANGED");
      await tx.update(tasks).set({ status:"created", providerOrderId:current.providerOrderId??result.providerOrderId, trackingNumbers:[...new Set([...current.trackingNumbers,...result.trackingNumbers])], ...(result.actualCostMinor!==null ? { actualCostMinor:result.actualCostMinor,actualCurrency:result.actualCurrency } : {}),updatedAt:new Date() }).where(eq(tasks.id,l.task.id));
      await this.event(tx,context,l.task.id,"provider.order_confirmed",{ providerOrderId:result.providerOrderId, actualCostMinor:result.actualCostMinor,actualCurrency:result.actualCurrency });
    });
  }
  private async completeLabels(context: TenantContext,l: Loaded,c: ReturnType<typeof LogisticsCredentialsSchema.parse>,result: LogisticsProviderResult,requestWasUncertain: boolean) {
    let source=result;
    const shipos=l.connection.profile.provider==="shipos";
    const pending=l.task.diagnostic==="LABEL_GENERATION_PENDING";
    const waiting=l.task.diagnostic==="LABEL_GENERATION_WAITING";
    if(!source.labelUrls.length && pending && l.task.labelRequestedAt && Date.now()-l.task.labelRequestedAt.getTime()>600_000)
      return this.finish(context,l,"reconciliation_required","LABEL_GENERATION_TIMEOUT");
    if(!source.labelUrls.length) {
      if(shipos&&!l.task.providerOrderId&&!l.task.labelRequestedAt)return this.finish(context,l,"created","LABEL_GENERATION_WAITING");
      // ShipOS issuance may charge. Once issuance has an uncertain outcome, only query existing labels.
      if(requestWasUncertain && shipos && !pending) return this.finish(context,l,"reconciliation_required","LABEL_ISSUANCE_NOT_CONFIRMED");
      if((pending||waiting) && Date.now()-l.task.updatedAt.getTime()<10_000) return this.finish(context,l,pending?"label_requesting":"created",pending?"LABEL_GENERATION_PENDING":"LABEL_GENERATION_WAITING",undefined,l.task.updatedAt);
      await withTenant(this.database.db,context,async tx => { const [task]=await tx.select().from(tasks).where(and(eq(tasks.id,l.task.id),eq(tasks.processingRunId,l.runId))); if(!task) throw new Error("TASK_LEASE_CHANGED"); await tx.update(tasks).set({status:"label_requesting",diagnostic:null,labelRequestedAt:task.labelRequestedAt??new Date(),updatedAt:new Date()}).where(eq(tasks.id,l.task.id)); await this.event(tx,context,l.task.id,"label.request_intent",{}); });
      try { source=await this.gateway.labels(l.connection.profile,c,l.task.externalReference); }
      catch(error) { if(error instanceof LogisticsTransportError && error.code==="LABEL_PENDING") return this.finish(context,l,"label_requesting","LABEL_GENERATION_PENDING");throw error; }
      await this.acceptCreated(context,l,source);
    }
    if(!source.labelUrls.length) return this.finish(context,l,"attention","LABEL_UNAVAILABLE");
    if(shipos && !source.trackingNumbers.length && !l.task.trackingNumbers.length) return this.finish(context,l,"reconciliation_required","TRACKING_NUMBER_PENDING");
    if(l.connection.profile.labelMode==="factory_pull") return this.complete(context,l);
    for(const [index,url] of source.labelUrls.entries()) {
      const bytes=await this.gateway.downloadLabel(l.connection.profile,url);
      const checksum=createHash("sha256").update(bytes).digest("hex"),fileName=`${l.task.externalReference}-${index+1}.pdf`;
      const [prior]=await withTenant(this.database.db,context,tx=>tx.select().from(labels).where(and(eq(labels.taskId,l.task.id),eq(labels.fileName,fileName))));
      if(prior){if(prior.checksum!==checksum) return this.finish(context,l,"attention","LABEL_CONTENT_CHANGED");continue;}
      await withTenant(this.database.db,context,async tx=>{const [task]=await tx.select().from(tasks).where(eq(tasks.id,l.task.id));if(!task||task.processingRunId!==l.runId||await this.blocker(tx,context,task,l.snapshot))throw new Error("LABEL_ORDER_BASIS_CHANGED");});
      const stored=await this.storage.putPrivate(context,{domain:"order",fileName:`${l.task.id}-label-${index}.pdf`,mediaType:"application/pdf",body:bytes});
      try{await withTenant(this.database.db,context,async tx => { const [task]=await tx.select().from(tasks).where(eq(tasks.id,l.task.id)).for("share");if(!task?.encryptedSnapshot||task.processingRunId!==l.runId||await this.blocker(tx,context,task,l.snapshot))throw new Error("LABEL_ORDER_BASIS_CHANGED");await tx.insert(labels).values({ id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,taskId:l.task.id,objectKey:stored.objectKey,checksum:stored.checksumSha256,fileName:`${l.task.externalReference}-${index+1}.pdf`,byteSize:bytes.byteLength }).onConflictDoNothing(); });}
      catch(e){if(!stored.deduplicated)await this.storage.discardLogisticsLabel(context,l.task.id,stored.objectKey);throw e;}
    }
    return this.complete(context,l);
  }
  private async complete(context:TenantContext,l:Loaded){
    const diagnostic=await withTenant(this.database.db,context,async tx=>{
      const [latest]=await tx.select().from(tasks).where(eq(tasks.id,l.task.id));
      if(latest?.actualCostMinor!==null&&latest?.actualCostMinor!==undefined){
        const problem=logisticsCostBlocker(latest.actualCostMinor,l.rule.rule,l.snapshot);
        if(problem)return problem==="PER_ITEM_COST_EXCEEDED"?"ACTUAL_PER_ITEM_COST_EXCEEDED":"ACTUAL_COST_EXCEEDS_BUDGET";
      }
      if(latest?.reservedDay && l.rule.rule.maxDailyMinor!==null){
        await logisticsLock(tx,context,`budget:${l.rule.rule.currency}:${latest.reservedDay}`);
        const dayTasks=await tx.select().from(tasks).where(and(eq(tasks.reservedDay,latest.reservedDay),sql`${tasks.selectedQuote}->>'currency'=${l.rule.rule.currency}`));
        if(dayTasks.reduce((sum,t)=>sum+Math.max(t.reservationMinor,t.actualCostMinor??0),0)>l.rule.rule.maxDailyMinor)return "ACTUAL_DAILY_COST_EXCEEDS_BUDGET";
      }
      return null;
    });
    return this.finish(context,l,diagnostic?"attention":"completed",diagnostic);
  }
  private async recordQuotes(context: TenantContext,l: Loaded,received: LogisticsQuote[]) {
    if(!received.length) return;
    await withTenant(this.database.db,context,tx=>tx.insert(quotes).values(received.map(quote=>({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,taskId:l.task.id,roundId:l.runId,quote}))));
  }
  private async finish(context: TenantContext,l: Loaded,status: LogisticsTaskState,diagnostic: string|null,selectedQuote?: LogisticsQuote,updatedAt=new Date()) {
    return withTenant(this.database.db,context,async tx => {
      const [updated]=await tx.update(tasks).set({status,diagnostic,processingRunId:null,leaseUntil:null,updatedAt,...(selectedQuote ? {selectedQuote} : {})}).where(and(eq(tasks.id,l.task.id),eq(tasks.processingRunId,l.runId))).returning({id:tasks.id});
      if(updated) await this.event(tx,context,l.task.id,`task.${status}`,{ diagnostic });
      return { taskId:l.task.id,status:updated ? status : "ignored",...(updated&&["LABEL_GENERATION_PENDING","LABEL_GENERATION_WAITING"].includes(diagnostic??"")?{retryAfterMs:30_000}:{}) };
    });
  }
  private event(tx: TenantTransaction,c: TenantContext,taskId: string,action: string,data: Record<string,unknown>) { return tx.insert(events).values({id:createEntityId(),tenantId:c.tenantId,createdBy:c.userId,taskId,action,data}); }
}
