import { randomUUID } from "node:crypto";
import { ConflictException, HttpException, Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { Permission, intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { z } from "zod";
import { OrderWorkActionInputSchema } from "@yummyai/contracts/order/workspace";
import type { SecretVault } from "@yummyai/ai-core";
import { FulfillmentFlowViewSchema, FulfillmentFlowQueueSchema, ResumeFulfillmentBatchSchema, type FulfillmentFlowStage, type FulfillmentFlowView } from "@yummyai/contracts/order/fulfillment-flow";
import { ReleaseWholeOrderInputSchema } from "@yummyai/contracts/order/whole-fulfillment";
import { CreateLogisticsTaskSchema, yunexpressStatusNames } from "@yummyai/contracts/logistics";
import { HANDOVER_POLL_MS } from "@yummyai/logistics";
import { CreateProductionDeliverySchema } from "@yummyai/contracts/order/production-delivery";
import { orderFulfillmentFlows as flows, orderFlowDispatchTenants, orderWorkItems, orderLines, orders, orderPrivateSourceAvailable,
  loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { currentOrderAuthority, OrderDocumentSourceReader } from "@yummyai/order-core";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { FulfillmentRoutesService } from "./fulfillment-routes.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { FactoryCapacityService } from "../suppliers/factory-capacity.service.js";
import { LogisticsService } from "../logistics/logistics.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { LogisticsDocumentsService } from "../logistics/logistics-documents.service.js";
import { matchFulfillmentRoute, planFlowCapacity, planFlowParcel } from "./fulfillment-flow-planning.js";
import { scheduleOrderFlow } from "./order-flow-intent.js";
import { workProjection } from "./order-workspace-query.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { pillowFactoryDeliveryProgress } from "@yummyai/contracts/order/production-delivery";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { OrderWorkspaceService } from "./order-workspace.service.js";

type Flow = typeof flows.$inferSelect;
const permissions = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead];
class FlowAttention extends Error {}
const DesignCommandSchema = z.object({ lineId: z.uuidv7(), request: OrderWorkActionInputSchema.refine(input => input.action === "push") }).strict();

/**
 * Durable continuation of approved order work. This API dispatcher coordinates
 * existing owner commands only; render, carrier I/O and marketplace I/O remain
 * on their existing Worker queues. No browser polling drives business execution.
 */
@Injectable()
export class OrderFlowService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closing = false;
  private tenantCursor?: string;
  private readonly source: OrderDocumentSourceReader;
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) vault: SecretVault,
    @Inject(FulfillmentRoutesService) private readonly routes: FulfillmentRoutesService,
    @Inject(OrderProductionService) private readonly production: OrderProductionService,
    @Inject(FactoryCapacityService) private readonly capacity: FactoryCapacityService,
    @Inject(LogisticsService) private readonly logistics: LogisticsService,
    @Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService,
    @Inject(LogisticsDocumentsService) private readonly documents: LogisticsDocumentsService,
    @Inject(OrderShipmentService) private readonly shipments: OrderShipmentService,
    @Inject(OrderWorkspaceService) private readonly work: OrderWorkspaceService) {
    this.source = new OrderDocumentSourceReader(vault);
  }
  onApplicationBootstrap() {
    if (process.env.FULFILLMENT_FLOW_COORDINATOR === "off") return;
    this.timer = setInterval(() => { void this.pulse(); }, 15_000);
    this.timer.unref();
  }
  async onApplicationShutdown() { this.closing = true; clearInterval(this.timer); await this.running; }
  pulse() {
    if (this.closing) return Promise.resolve();
    if (!this.running) this.running = this.scan().catch(() => {
      // No order identifiers, buyer data, raw owner/provider errors or secrets.
      process.stderr.write("Order fulfillment continuation unavailable; original intents retained\n");
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async queue(context: TenantContext) {
    const [workspace, rows] = await Promise.all([this.routes.workspace(context),withTenant(this.database.db,context,async tx => {
      await currentOrderAuthority(tx,context,[Permission.OrderRead,Permission.OrderPiiRead],{requireMembership:true});
      return tx.select({flow:flows,orderNumber:orders.externalOrderId,
        lineId:sql<string>`(select l.id from order_lines l join order_work_items w on w.id=l.id where l.order_id=${orders.id} and w.archived_at is null order by l.id limit 1)`})
        .from(flows).innerJoin(orders,eq(orders.id,flows.orderId))
        .where(and(orderPrivateSourceAvailable(sql`${orders.id}`),sql`exists(select 1 from order_lines l join order_work_items w on w.id=l.id where l.order_id=${orders.id} and w.archived_at is null)`))
        .orderBy(desc(flows.updatedAt),desc(flows.id)).limit(101);
    })]);
    return FulfillmentFlowQueueSchema.parse({routes:workspace.view.routes,canConfigure:workspace.view.canConfigure,
      canResume:context.permissions.includes(Permission.OrderWrite),truncated:rows.length>100,
      items:rows.slice(0,100).map(({flow,orderNumber,lineId}) => ({id:flow.id,orderId:flow.orderId,orderNumber,lineId,
        stage:flow.stage,reasons:flow.reasons,routeName:workspace.view.routes.find(route=>route.id===flow.routeId)?.profile.name??null,
        documentProfileVersionId:flow.routeSnapshot?.documentProfileVersionId??null,
        productionExportId:flow.productionExportId,deliveryPackageIds:flow.deliveryPackageIds,logisticsTaskId:flow.logisticsTaskId,updatedAt:flow.updatedAt.toISOString()}))});
  }
  async resumeBatch(context:TenantContext,raw:unknown) {
    const input=ResumeFulfillmentBatchSchema.parse(raw),results=[];
    for(const orderId of input.orderIds){
      try { await this.resume(context,orderId);results.push({orderId,resumed:true,message:"已交回自动处理"}); }
      catch(error){
        results.push({orderId,resumed:false,message:error instanceof HttpException && error.getStatus()===409
          ? error.message : "订单不可继续 请核对当前权限、状态和原操作结果"});
      }
    }
    return {results};
  }
  async view(context: TenantContext, orderId: string): Promise<FulfillmentFlowView> {
    const [data, workspace] = await Promise.all([
      this.read(context, orderId).catch(error => {
        if (error instanceof OriginalOwnerError && error.status === 409) return {source:null,flow:null,reason:error.message};
        throw error;
      }), this.routes.workspace(context),
    ]);
    const automaticDesign=workspace.view.routes.some(route=>route.profile.mode!=="disabled");
    if (!data.source) return FulfillmentFlowViewSchema.parse({orderId,id:null,stage:null,automaticDesign,route:null,reasons:[data.reason],
      productionOrderIds:[],logisticsTaskId:null,deliveryPackageIds:[],productionExportId:null,updatedAt:null});
    const matched = matchFulfillmentRoute(data.source.source, workspace.view.routes, workspace.documents.profiles);
    const route = data.flow?.routeId ? workspace.view.routes.find(route => route.id === data.flow!.routeId) ?? null : matched.route;
    return FulfillmentFlowViewSchema.parse({ orderId, id: data.flow?.id ?? null, stage: data.flow?.stage ?? null, route,automaticDesign,
      reasons: data.flow?.reasons.length ? data.flow.reasons : matched.reasons,
      productionOrderIds: data.flow?.productionOrderIds ?? [], logisticsTaskId: data.flow?.logisticsTaskId ?? null,
      productionExportId: data.flow?.productionExportId ?? null,
      deliveryPackageIds: data.flow?.deliveryPackageIds ?? [], updatedAt: data.flow?.updatedAt.toISOString() ?? null });
  }
  async resume(context: TenantContext, orderId: string) {
    await withTenant(this.database.db,context,async tx => {
      const current = await currentOrderAuthority(tx,context,permissions,{requireMembership:true});
      await this.source.read(tx,current,orderId);
      await scheduleOrderFlow(tx,current,orderId);
      const [flow] = await tx.select().from(flows).where(eq(flows.orderId,orderId)).for("update");
      if (!flow) throw new ConflictException("请先配置并启用产品与发货规则");
      if (flow.leaseUntil && flow.leaseUntil > new Date()) throw new ConflictException("订单正在自动推进 请稍后刷新");
      if (flow.stage === "completed") return;
      if (flow.pendingCommand && flow.requestedBy !== current.userId)
        throw new ConflictException("原操作结果仍待核对 请由原审核人继续 或在原生产和物流记录中处理");
      const mayReplan = !flow.pendingCommand && !flow.productionOrderIds.length && !flow.logisticsTaskId && !flow.deliveryPackageIds.length;
      if (!mayReplan && flow.routeId) {
        const workspace = await this.routes.workspace(current);
        const route = workspace.view.routes.find(item => item.id === flow.routeId);
        if (!route || route.version !== flow.routeVersion)
          throw new ConflictException("本单已有固定的生产或物流请求 规则变化后请在原任务完成核对 不会重新创建或购单");
      }
      await tx.update(flows).set({ requestedBy:current.userId,authority:current,stage:"waiting_artwork",reasons:[],retryCount:0,
        ...(mayReplan ? {routeId:null,routeVersion:null,routeSnapshot:null} : {}),
        nextRunAt:new Date(),updatedAt:new Date() }).where(eq(flows.id,flow.id));
    });
    void this.pulse();
    return this.view(context,orderId);
  }
  private async read(context: TenantContext, orderId: string) {
    return withTenant(this.database.db,context,async tx => {
      await currentOrderAuthority(tx,context,[Permission.OrderRead,Permission.OrderPiiRead]);
      const source = await this.source.read(tx,context,orderId);
      const [flow] = await tx.select().from(flows).where(eq(flows.orderId,orderId));
      return { source, flow };
    });
  }
  private async scan() {
    let cursor = this.tenantCursor;
    // Bounded pages avoid starving other API work; the next pulse continues.
    for (let page=0; page<20 && !this.closing; page++) {
      const tenants = await this.database.db.transaction(async tx => {
        await tx.execute(sql.raw("set local role yummyai_app"));
        return tx.select().from(orderFlowDispatchTenants).where(cursor ? gt(orderFlowDispatchTenants.tenantId,cursor) : undefined)
          .orderBy(asc(orderFlowDispatchTenants.tenantId)).limit(50);
      });
      if (!tenants.length) { this.tenantCursor=undefined;break; }
      for (const tenant of tenants) {
        const scope: TenantContext = {tenantId:tenant.tenantId,userId:tenant.tenantId,permissions:[],dataScope:"tenant"};
        const ids = await withTenant(this.database.db,scope,tx => tx.select({id:flows.id}).from(flows).where(and(
          sql`${flows.nextRunAt}<=clock_timestamp()`,
          sql`${flows.stage} not in ('completed','exception','paused')`,
          sql`(${flows.leaseUntil} is null or ${flows.leaseUntil}<=clock_timestamp())`,
        )).orderBy(asc(flows.nextRunAt)).limit(10));
        for (const row of ids) { if (this.closing) return; await this.advance(scope,row.id); }
      }
      cursor = tenants.at(-1)!.tenantId;this.tenantCursor=cursor;
    }
  }
  async advance(scope: TenantContext, flowId: string) {
    const token = createEntityId();
    const [flow] = await withTenant(this.database.db,scope,tx => tx.update(flows).set({
      leaseToken:token, leaseUntil:sql`clock_timestamp()+interval '2 minutes'`,
    }).where(and(eq(flows.id,flowId),sql`${flows.nextRunAt}<=clock_timestamp()`,sql`(${flows.leaseUntil} is null or ${flows.leaseUntil}<=clock_timestamp())`,
      sql`${flows.stage} not in ('completed','exception','paused')`)).returning());
    if (!flow) return;
    let context: TenantContext;
    try {
      context = await withTenant(this.database.db,scope,async tx => {
        const current = await loadCurrentMembershipContext(tx,{...scope,userId:flow.requestedBy},{lock:true});
        const authority = intersectPermissionContexts(flow.authority,current);
        return currentOrderAuthority(tx,authority,permissions,{requireMembership:true});
      });
    } catch {
      await this.finish(scope,flow,token,"exception",["原审核人的履约权限已变化 请由有权限的运营重新核对并继续"]);
      return;
    }
    try { await this.step(context,flow,token); }
    catch (error) {
      const temporary = error instanceof HttpException && error.getStatus() >= 500
        || error instanceof Error && "code" in error && ["ECONNRESET","ETIMEDOUT","ECONNREFUSED","40001","40P01"].includes(String(error.code));
      if (temporary && flow.retryCount < 3) {
        await this.patch(context,flow,token,{retryCount:flow.retryCount+1,reasons:["服务暂时不可用 已保留原请求并等待自动重试"],
          nextRunAt:new Date(Date.now()+30_000*2**flow.retryCount),leaseUntil:null,leaseToken:null});
        return;
      }
      const businessConflict=error instanceof HttpException && [409,422].includes(error.getStatus())
        || error instanceof OriginalOwnerError && error.status===409;
      await this.finish(context,flow,token,"exception",[error instanceof FlowAttention || businessConflict && error instanceof Error && error.message.length<=500 ? error.message :
        "本次自动推进未通过业务校验 原操作已保留 请核对订单、工厂能力或原任务后继续"]);
    }
  }
  private async step(context: TenantContext, flow: Flow, token: string) {
    // Do not require every item's decrypted document before all items have been
    // reviewed. A multi-item order is one continuation, never a partial parcel.
    const review = await withTenant(this.database.db,context,tx => tx.select({work:orderWorkItems})
      .from(orderLines).leftJoin(orderWorkItems,eq(orderWorkItems.id,orderLines.id)).where(eq(orderLines.orderId,flow.orderId)));
    if (!review.length || review.some(row => !row.work || !["ready_to_push","pushed"].includes(row.work.preparation)))
      return this.finish(context,flow,token,"waiting_artwork",["等待整单审单完成 全部商品确认后自动派发设计"]);
    const [data, workspace] = await Promise.all([this.read(context,flow.orderId),this.routes.workspace(context)]);
    if (data.source.blockers.length) throw new FlowAttention(data.source.blockers.join("；"));
    const matched = matchFulfillmentRoute(data.source.source,workspace.view.routes,workspace.documents.profiles);
    const route = flow.routeId ? workspace.view.routes.find(route => route.id === flow.routeId) : matched.route;
    if (!route) throw new FlowAttention(matched.reasons.join("；"));
    if (route.profile.mode === "disabled") return this.finish(context,flow,token,"paused",["此商品的自动履约规则已停用 已提交的物流任务请在原订单核对"]);
    if (flow.routeVersion && route.version !== flow.routeVersion) throw new FlowAttention("发货规则已有新版本 本单仍保留原依据 请核对后处理");
    const profile = workspace.documents.profiles.find(profile => profile.id === route.profile.documentProfileVersionId);
    const connection = workspace.connections.find(connection => connection.id === route.profile.connectionId);
    if (!profile || !connection) throw new FlowAttention("工厂包裹或物流连接已变化");
    if (matched.route?.id !== route.id) throw new FlowAttention("订单规格或收货国家已变化 不再适用原发货规则");
    if (!flow.routeId) {
      await this.patch(context,flow,token,{routeId:route.id,routeVersion:route.version,routeSnapshot:route.profile});
      flow.routeId=route.id;flow.routeVersion=route.version;flow.routeSnapshot=route.profile;
    }
    const works = await withTenant(this.database.db,context,tx => tx.select().from(orderWorkItems)
      .where(inArray(orderWorkItems.id,data.source.source.lines.map(line => line.id))));
    if (flow.pendingCommand?.kind === "design") return this.executeCommand(context,flow,token,flow.pendingCommand);
    const ready = works.find(work => work.preparation === "ready_to_push");
    if (ready) {
      const input = DesignCommandSchema.parse({lineId:ready.id,request:{action:"push",expectedRevision:ready.revision,
        expectedProjectionVersion:ready.projectionVersion,reason:"运营审单通过后由系统自动派发设计",idempotencyKey:randomUUID()}});
      await this.command(context,flow,token,"design",input);
      return this.executeCommand(context,flow,token,{kind:"design",input});
    }
    if (works.length !== data.source.source.lines.length || works.some(work => work.artwork !== "approved" || !work.approvedEditorVersionId
      || work.proof !== "not_required" && (work.proof !== "approved" || work.proofEditorVersionId !== work.approvedEditorVersionId)))
      return this.finish(context,flow,token,"waiting_artwork",["整单全部商品的当前生产图审核通过后自动继续"]);
    // Shipping setup must not block a reviewed order's design work. It is checked
    // at the shipping/production boundary, with the original owner checks intact.
    if (route.blockers.length) throw new FlowAttention(route.blockers.join("；"));
    if (flow.pendingCommand) return this.executeCommand(context,flow,token,flow.pendingCommand);
    const fulfillment = await this.production.wholeOrderFulfillment(context,flow.orderId);
    if (fulfillment.items.some(item => item.operationBlockers.length)) throw new FlowAttention([...new Set(fulfillment.items.flatMap(item => item.operationBlockers))].join("；"));
    if (!flow.productionOrderIds.length) {
      if (fulfillment.items.some(item => item.production)) throw new FlowAttention("本单已有生产安排 请核对原安排后继续 避免重复制作");
      if (fulfillment.items.some(item => item.renderFailure)) throw new FlowAttention([...new Set(fulfillment.items.flatMap(item => item.renderFailure ? [item.renderFailure] : []))].join("；"));
      if (fulfillment.items.some(item => !item.renderId)) return this.finish(context,flow,token,"waiting_render",["审核通过 正式生产文件生成成功后自动继续"]);
      if (fulfillment.items.some(item => item.productionBlockers.length)) throw new FlowAttention([...new Set(fulfillment.items.flatMap(item => item.productionBlockers))].join("；"));
      const factory = fulfillment.factories.find(factory => factory.factoryId === route.factoryId);
      if (!factory) throw new FlowAttention(fulfillment.factoryDiagnostics.find(factory => factory.factoryId === route.factoryId)?.blockers.join("；") || "该工厂尚未核验本单商品与工艺的承接能力");
      // Design revisions precede this production window; the persisted command freezes it for retries.
      const latest = new Date(Date.now()+route.profile.productionDays*86_400_000);
      const selections = [];
      for (const line of fulfillment.items) {
        const options = await this.production.manufacturingOptions(context,line.lineId,{factoryId:route.factoryId});
        const outsourced = options.items.filter(item => item.outsourcedFactoryId === route.factoryId);
        const candidates = outsourced.length ? outsourced : options.items.filter(item => !item.outsourcedFactoryId);
        if (candidates.length!==1 || options.nextCursor || options.diagnostics.length) throw new FlowAttention("本单规格需要唯一的已审核制造模板 请在商品档案中明确适用版本");
        const recipe = candidates[0]!;
        if (options.source?.packageQuantity!==1 || recipe.outputQuantity!==1 || recipe.outputUnit!=="each")
          throw new FlowAttention("此规格按套或多成品计量 请先核对订单单位与工厂制造单位的换算规则");
        selections.push({line,recipe,capabilityVersionId:factory.items.find(item=>item.lineId===line.lineId)!.capabilityVersionId});
      }
      const internal = selections.filter(item => !item.recipe.outsourcedFactoryId);
      const capacity = internal.length ? planFlowCapacity(await this.capacity.workspace(context,route.factoryId,{days:31}),
        internal.map(({line,capabilityVersionId}) => ({lineId:line.lineId,quantity:line.quantity,capabilityVersionId})),latest) : null;
      const items = selections.map(({line,recipe,capabilityVersionId}) => ({
        lineId:line.lineId,quantity:line.quantity,expectedRevision:line.expectedRevision,expectedProjectionVersion:line.expectedProjectionVersion,
        renderId:line.renderId!,capabilityVersionId,manufacturing:{versionId:recipe.versionId,orderUnitConfirmed:true as const},
        ...(!recipe.outsourcedFactoryId && capacity ? {capacityPlan:capacity.plans.get(line.lineId)!} : {}),
      }));
      const expectedCompletionAt = internal.length === selections.length ? capacity!.expectedCompletionAt : latest.toISOString();
      const input=ReleaseWholeOrderInputSchema.parse({supplierId:factory.supplierId,factoryId:factory.factoryId,factoryVersionId:factory.factoryVersionId,
        items,expectedCompletionAt,instructions:"按已审核生产文件整单合包 同一订单共用面单",idempotencyKey:randomUUID()});
      await this.command(context,flow,token,"production",input);
      return this.executeCommand(context,flow,token,{kind:"production",input});
    }
    if (fulfillment.items.some(item => !item.production || !flow.productionOrderIds.includes(item.production.id)))
      throw new FlowAttention("当前生产安排与自动履约记录不一致 请核对改稿、返工或人工调整");
    if (!flow.logisticsTaskId) {
      let parcel;
      try { parcel=planFlowParcel(data.source.source,profile,connection.profile.channelSelection); }
      catch(error) { throw new FlowAttention(error instanceof Error ? error.message : "包裹规则待完善"); }
      const options=await this.logistics.options(context,{orderId:flow.orderId});
      const candidates=options.candidates.filter(row=>flow.productionOrderIds.includes(row.productionOrderId));
      if (candidates.length!==flow.productionOrderIds.length || candidates.some(row=>row.blockers.length || row.taskId))
        throw new FlowAttention("本单已有物流任务或生产依据变化 请核对原任务 避免重复购单");
      const dates=await withTenant(this.database.db,context,tx=>tx.execute<{platformShipByAt:string|null}>(sql`select v."platformShipByAt" from (${workProjection}) v where v."orderId"=${flow.orderId}`));
      if (dates.some(row=>!row.platformShipByAt)) throw new FlowAttention("平台最晚发货时间尚未核对 请在审单时确认");
      const latestShipAt=new Date(Math.min(...dates.map(row=>new Date(row.platformShipByAt!).getTime())));
      const readyAt=new Date(Math.max(Date.now(),...candidates.map(row=>Date.parse(row.expectedCompletionAt))));
      const eligible=connection.profile.channels.filter(channel=>channel.conditionsVerified && channel.countryCodes.includes(data.source.source.address.countryCode)
        && connection.rule?.allowedChannelCodes.includes(channel.code) && (!parcel.channelCode || channel.code===parcel.channelCode));
      if (!eligible.length) throw new FlowAttention("匹配的物流渠道尚未确认适用国家和运输时效");
      if (readyAt>latestShipAt) throw new FlowAttention("预计完工已超过平台最晚发货时间 请优先处理");
      const deliverBy=new Date(latestShipAt.getTime()+Math.max(...eligible.map(channel=>channel.transitDaysMax))*86_400_000);
      const input=CreateLogisticsTaskSchema.parse({orderId:flow.orderId,productionOrderIds:flow.productionOrderIds,connectionId:connection.id,...parcel,
        readyAt:readyAt.toISOString(),latestShipAt:latestShipAt.toISOString(),deliverBy:deliverBy.toISOString(),
        deadlineSource:"平台最晚发货时间与已核验渠道时效组成内部计划 送达时间不是平台承诺",expectedOrderSequence:data.source.orderSequence,idempotencyKey:randomUUID()});
      await this.command(context,flow,token,"logistics",input);
      return this.executeCommand(context,flow,token,{kind:"logistics",input});
    }
    const logistics=await this.logistics.get(context,flow.logisticsTaskId);
    if(logistics.diagnostic==="PER_ITEM_COST_EXCEEDED")throw new FlowAttention("最低合规报价的平均每件运费超过已设阈值 已转异常且未购单 请核对包裹与报价");
    if(logistics.diagnostic==="ACTUAL_PER_ITEM_COST_EXCEEDED")throw new FlowAttention("面单已创建 但实际平均每件运费超过已设阈值 请核对账单 不会重复购买");
    if (["attention","reconciliation_required","cancelled"].includes(logistics.status))
      throw new FlowAttention(logistics.status==="reconciliation_required"?"物流返回结果不确定 已停止购单重试 请查单对账":"物流任务需要核对 请查看原订单中的具体原因");
    if (logistics.status!=="completed") {
      if (route.profile.mode==="quote" && logistics.status==="quoted") return this.finish(context,flow,token,"paused",["整单询价已完成 当前规则只询价 不会购单扣费"]);
      // Existing logistics executor owns the provider idempotency, live checks,
      // payment budget and unknown-result reconciliation.
      await this.logistics.dispatch(context,logistics.id,{mode:route.profile.mode==="purchase"?"purchase":"quote",idempotencyKey:flow.id});
      return this.finish(context,flow,token,"logistics",["物流任务正在处理 原任务会自动查重和核对价格"],60);
    }
    if (!flow.deliveryPackageIds.length) {
      const workspace=await this.delivery.workspace(context,{order:flow.orderId});
      const candidates=workspace.candidates.filter(row=>flow.productionOrderIds.includes(row.productionOrderId));
      if (candidates.length!==flow.productionOrderIds.length || candidates.some(row=>row.blockers.length)) throw new FlowAttention("当前生产文件或工厂交付条件尚未齐全");
      const existing=workspace.packages.find(packet=>packet.items.length===candidates.length
        && candidates.every(row=>packet.items.some(item=>item.productionOrderId===row.productionOrderId && item.snapshot?.productionVersionId===row.productionVersionId)));
      if (existing) {
        await this.patch(context,flow,token,{deliveryPackageIds:[existing.id]});
        return this.finish(context,flow,token,"waiting_factory",["工厂生产文件与物流资料已就绪 等待工厂接收"]);
      }
      const input=CreateProductionDeliverySchema.parse({factoryId:route.factoryId,supplierId:candidates[0]!.supplierId,
        items:candidates.map(row=>({productionOrderId:row.productionOrderId,productionVersionId:row.productionVersionId,expectedProjectionVersion:row.projectionVersion})),
        idempotencyKey:randomUUID()});
      await this.command(context,flow,token,"delivery",input);
      return this.executeCommand(context,flow,token,{kind:"delivery",input});
    }
    // Generation is a file preparation receipt; it never invents a factory
    // acceptance, production completion, physical dispatch or platform receipt.
    if (profile.profile.productionAdapter==="printeque_factory" && !flow.productionExportId) {
      const selection={profileVersionId:profile.id,adapter:"printeque_factory" as const,orderIds:[flow.orderId],overrides:[],deliveryPackageIds:flow.deliveryPackageIds};
      const preview=await this.documents.preview(context,selection);
      if (!preview.ready) throw new FlowAttention("工厂 ERP 表的当前生产文件还未通过导出校验");
      const generated=await this.documents.generate(context,{...selection,expectedFingerprint:preview.fingerprint,idempotencyKey:flow.id});
      await this.patch(context,flow,token,{productionExportId:generated.id});
    }
    const packets=await Promise.all(flow.deliveryPackageIds.map(id=>this.delivery.get(context,id)));
    if (packets.some(packet=>packet.items.some(item=>item.status==="rejected"))) throw new FlowAttention("工厂已拒收 当前订单需要处理");
    const deliveryItems=packets.flatMap(packet=>packet.items);
    const factoryRows=profile.profile.productionAdapter==="printeque_factory" ? deliveryItems.map(item=>item.factoryErp).filter(row=>!!row && !row.bindingReleased && !row.privateSourceExpired) : [];
    if(factoryRows.some(row=>row?.exception || row?.voidSummary?.requiresOrderHandling || row?.voidSummary?.pending))
      throw new FlowAttention("Printeque 出库表存在作废记录 请核对原工厂回执");
    const factoryOutbound=factoryRows.length>0 && factoryRows.length===deliveryItems.length && new Set(factoryRows.map(row=>row!.bindingId)).size===1 &&
      factoryRows.every(row=>row?.status==="shipped");
    if(factoryOutbound && factoryRows.some(row=>row!.trackingReference && !logistics.trackingNumbers.includes(row!.trackingReference)))
      throw new FlowAttention("Printeque 出库表的运单与本单面单不一致 请核对工厂整单记录");
    const yun=connection.profile.provider==="yunexpress" && connection.profile.yunexpressProtocol==="openapi";
    const observation=logistics.carrierObservation, carrierStatus=observation?.status;
    if(yun) {
      await this.logistics.requestHandoverRead(context,logistics.id);
      if (carrierStatus==="R" || carrierStatus==="C" || carrierStatus==="E") throw new FlowAttention(yunexpressStatusNames[carrierStatus]+" 请核对原运单");
      if (observation?.diagnostic==="unavailable") return this.finish(context,flow,token,"waiting_dispatch",["云途轨迹暂时无法核对 系统会再次查询原运单"],300);
      if (carrierStatus==="F" || carrierStatus==="N") return this.finish(context,flow,token,"waiting_dispatch",[yunexpressStatusNames[carrierStatus]],300);
    }
    const currentTracking=carrierStatus==="D" || (carrierStatus==="T" && observation?.verifiedAt && Date.now()-Date.parse(observation.verifiedAt)<HANDOVER_POLL_MS);
    const handover=currentTracking ? observation?.proof : null;
    if (yun && !handover && fulfillment.shipmentIds.length) return this.finish(context,flow,token,"waiting_dispatch",["等待云途核对原运单的实物轨迹"],300);
    if(yun && handover && fulfillment.shipmentIds.length) {
      if(fulfillment.shipmentIds.length!==1 || !logistics.carrierWaybill || logistics.trackingNumbers.length>1)
        throw new FlowAttention("云途已有实物轨迹 整单包裹或运单数量待核对");
      const detail=await this.shipments.get(context,fulfillment.shipmentIds[0]!);
      const version=detail.versions.find(row=>row.versionNumber===detail.shipment.currentVersionNumber);
      if(!version || detail.shipment.status==="cancelled" || version.versionNumber!==detail.shipment.approvedVersionNumber)
        throw new FlowAttention("云途已有实物轨迹 请核对本单当前包裹版本");
      const packs=detail.packages.filter(row=>row.shipmentVersionId===version.id), pack=packs[0];
      const lines=detail.packageLines.filter(row=>row.packageId===pack?.id), allocations=detail.productionAllocations.filter(row=>row.packageId===pack?.id);
      if(packs.length!==1 || !pack || (pack.trackingNumber!==logistics.carrierWaybill && !logistics.trackingNumbers.includes(pack.trackingNumber)) || version.shipFromCountryCode!==connection.profile.originCountryCode ||
        lines.length!==fulfillment.items.length || !fulfillment.items.every(item=>lines.some(line=>line.orderLineId===item.lineId && line.quantity===item.quantity)) ||
        !allocations.length || allocations.some(row=>!deliveryItems.some(item=>item.productionOrderId===row.productionOrderId &&
          item.snapshot?.productionVersionId===row.productionVersionId && item.snapshot.orderLineId===row.orderLineId)) ||
        !flow.productionOrderIds.every(id=>allocations.some(row=>row.productionOrderId===id)))
        throw new FlowAttention("云途轨迹与本单已审核的整单包裹不匹配 请核对原运单和生产来源");
      const eventId=`task:${logistics.id}:${handover.node}:${handover.occurredAt}`;
      const recorded=detail.tracking.find(event=>event.provider==="yunexpress_openapi" && event.externalEventId===eventId);
      if(recorded && recorded.packageId!==pack.id) throw new FlowAttention("该云途实物轨迹已关联原包裹 请核对包裹修订");
      if(!recorded) {
        await this.shipments.recordTrackingEvent(context,detail.shipment.id,{packageId:pack.id,provider:"yunexpress_openapi",externalEventId:eventId,
          status:handover.node==="DELIVERED"?"delivered":"in_transit",detailCode:handover.node,occurredAt:handover.occurredAt,estimatedDeliveryAt:null});
        return this.finish(context,flow,token,"waiting_dispatch",["已登记云途实物轨迹 正在核对整单回传条件"],0);
      }
    }
    if (fulfillment.shipmentIds.length && fulfillment.items.every(item=>item.shippedQuantity>=item.quantity)) {
      let confirmed=0;
      for (const id of fulfillment.shipmentIds) {
        const shipment=await this.shipments.get(context,id);
        const version=shipment.versions.find(version=>version.versionNumber===shipment.shipment.currentVersionNumber);
        if (!version || !shipment.physicalHandover.allDispatched || shipment.physicalHandover.shipmentVersionId!==version.id)
          throw new FlowAttention("包裹版本或实际交运依据不完整 请核对原发货记录");
        const request=shipment.writebacks.filter(request=>request.shipmentVersionId===version.id).at(-1);
        if (shipment.manualConfirmations.some(confirmation=>confirmation.shipmentVersionId===version.id) || request?.status==="accepted") {confirmed++;continue;}
        if (request?.status==="reconciled") {
          const receipt=await this.shipments.getWriteback(context,request.id);
          if (receipt.events.at(-1)?.action==="reconcile_accepted") {confirmed++;continue;}
        }
        if (request && ["rejected","reconciliation_required","reconciled"].includes(request.status))
          throw new FlowAttention("平台回传失败或结果不确定 请核对店铺授权及原回传结果 不会重复盲目提交");
        if (!route.profile.autoWriteback) return this.finish(context,flow,token,"waiting_dispatch",["已有真实交运记录 本规则未开启自动回传"],300);
        if (!request) await this.shipments.requestWriteback(context,id,{shipmentVersionId:version.id,idempotencyKey:`auto-fulfillment:${flow.id}:${version.id}`});
      }
      return this.finish(context,flow,token,confirmed===fulfillment.shipmentIds.length?"completed":"writeback",
        [confirmed===fulfillment.shipmentIds.length?"平台已确认本单物流跟踪号":"已提交平台回传 等待实际接口结果"],60);
    }
    if(factoryOutbound)
      return this.finish(context,flow,token,"waiting_dispatch",["Printeque 出库表已确认整单出库 逐件质检、实发数量和承运商交接分别等待原始凭据"],300);
    if(yun && handover)
      return this.finish(context,flow,token,"waiting_dispatch",[yunexpressStatusNames[carrierStatus!]+"，已核实包裹实物轨迹",
        "订单应发 "+fulfillment.items.reduce((sum,item)=>sum+item.quantity,0)+" 件，逐件质检与实发数量未提供"],300);
    if(yun && carrierStatus) return this.finish(context,flow,token,"waiting_dispatch",[yunexpressStatusNames[carrierStatus]+" 等待核实实物扫描时间"],300);
    const accepted=packets.every(packet=>packet.items.every(item=>pillowFactoryDeliveryProgress(item.status).status==="scheduled"));
    return this.finish(context,flow,token,accepted?"waiting_dispatch":"waiting_factory",
      [profile.profile.productionAdapter==="yicai_folder" ? (accepted?"已登记向义彩交付 等待云途首程实物轨迹":"义彩文件夹、尺寸和面单已备齐 待交付工厂") :
        accepted?"已提交工厂排产 等待真实生产和交运回执":"生产文件与面单已备齐 请批量提交工厂 ERP 或将交付包交给工厂"],300);
  }
  private async command(context:TenantContext,flow:Flow,token:string,kind:string,input:unknown) {
    await this.patch(context,flow,token,{pendingCommand:{kind,input}});
  }
  private async executeCommand(context:TenantContext,flow:Flow,token:string,command:{kind:string;input:unknown}) {
    if (command.kind === "design") {
      const input = DesignCommandSchema.parse(command.input);
      const [line] = await withTenant(this.database.db,context,tx => tx.select({id:orderLines.id}).from(orderLines)
        .where(and(eq(orderLines.id,input.lineId),eq(orderLines.orderId,flow.orderId))));
      if (!line) throw new FlowAttention("设计派发与本单商品不一致 请核对原审单记录");
      await this.work.action(context,input.lineId,input.request);
      await this.patch(context,flow,token,{pendingCommand:null});
      return this.finish(context,flow,token,"waiting_artwork",["审单已通过 设计已自动派发 完成后进入待审生产图"],0);
    }
    if (command.kind==="production") {
      const result=await this.production.releaseWholeOrderReceipt(context,flow.orderId,ReleaseWholeOrderInputSchema.parse(command.input));
      await this.patch(context,flow,token,{productionOrderIds:result.productionOrderIds,pendingCommand:null});
      return this.finish(context,flow,token,"logistics",[]);
    }
    if (command.kind==="logistics") {
      const result=await this.logistics.createTask(context,CreateLogisticsTaskSchema.parse(command.input),{mode:flow.routeSnapshot?.mode==="purchase"?"purchase":"quote"});
      await this.patch(context,flow,token,{logisticsTaskId:result.taskId,pendingCommand:null});
      return this.finish(context,flow,token,"logistics",[]);
    }
    if (command.kind==="delivery") {
      const result=await this.delivery.create(context,CreateProductionDeliverySchema.parse(command.input));
      await this.patch(context,flow,token,{deliveryPackageIds:[result.id],pendingCommand:null});
      return this.finish(context,flow,token,"delivery",[]);
    }
    throw new FlowAttention("自动履约原请求不可识别 请联系管理员");
  }
  private async patch(context:TenantContext,flow:Flow,token:string,patch:Partial<typeof flows.$inferInsert>) {
    const [row]=await withTenant(this.database.db,context,tx=>tx.update(flows).set({...patch,updatedAt:new Date()})
      .where(and(eq(flows.id,flow.id),eq(flows.leaseToken,token))).returning({id:flows.id}));
    if (!row) throw new ConflictException("自动履约任务已由其他执行器接管");
  }
  private async finish(context:TenantContext,flow:Flow,token:string,stage:FulfillmentFlowStage,reasons:string[],delay=15) {
    await this.patch(context,flow,token,{stage,reasons,retryCount:0,nextRunAt:new Date(Date.now()+delay*1000),leaseUntil:null,leaseToken:null});
  }
}
