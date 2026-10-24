import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { authorize, Permission, ForbiddenError } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SaveLogisticsConnectionSchema, SaveLogisticsRuleSchema, CreateLogisticsTaskSchema, LogisticsCredentialsSchema, LogisticsTaskSnapshotSchema, LogisticsAddressSchema,
  LogisticsOptionsSchema, type LogisticsConnectionView, type LogisticsTaskView } from "@yummyai/contracts/logistics";
import { logisticsConnections as connections, logisticsConnectionVersions as versions, logisticsRuleVersions as rules, logisticsTasks as tasks, logisticsTaskProductions as pins, logisticsLabels as labels, logisticsEvents as events,
  fulfillmentFactories, fulfillmentFactoryVersions, productionOrders, productionOrderVersions, orderLines, orders, orderProtectedDetails, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { logisticsHash, logisticsLock, HttpLogisticsGateway,purgeLogisticsTasks, LogisticsReadOwner, LogisticsReadQuerySchema } from "@yummyai/logistics";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import { z } from "zod";
import { DATABASE_CONNECTION, INTEGRATION_SECRET_VAULT, ORDER_PII_VAULT, PRIVATE_STORAGE } from "../platform.tokens.js";
import { OrderService } from "../orders/order.service.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
export abstract class LogisticsEnqueuer { abstract enqueue(input: { taskId: string; tenantId: string; requestedBy: string; mode: "quote"|"purchase"|"reconcile"|"retention"; requestKey: string; delayMs?:number }): Promise<void>; }
@Injectable()
export class LogisticsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection, @Inject(INTEGRATION_SECRET_VAULT) private readonly vault: SecretVault,
    @Inject(ORDER_PII_VAULT) private readonly pii: SecretVault, @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(HttpLogisticsGateway) private readonly gateway: HttpLogisticsGateway, @Inject(OrderService) private readonly orderService: OrderService, @Inject(LogisticsEnqueuer) private readonly queue: LogisticsEnqueuer) {}
  async connections(context: TenantContext): Promise<{ connections: LogisticsConnectionView[] }> {
    this.tenantAccess(context);
    authorize(context,Permission.IntegrationRead);
    return withTenant(this.database.db,context,async tx => {
      const rows=await tx.select().from(connections).orderBy(desc(connections.createdAt)).limit(200);
      return { connections: await Promise.all(rows.map(async row => { const v=await this.connection(tx,row.id); const rule=await this.rule(tx,row.id,row.ruleVersion); return { id:row.id,version:row.version,versionId:v.id,profile:v.profile,verifiedAt:row.verifiedVersionId===v.id ? row.verifiedAt?.toISOString() ?? null : null,rule:rule?.rule??null,ruleVersion:row.ruleVersion,ruleVersionId:rule?.id??null }; })) };
    });
  }
  async saveConnection(context: TenantContext, raw: unknown) {
    this.tenantAccess(context);
    authorize(context,Permission.IntegrationManage); const input=SaveLogisticsConnectionSchema.parse(raw);
    this.gateway.assertProfile(input.profile);
    const digest=logisticsHash(input);
    return withTenant(this.database.db,context,async tx => {
      await logisticsLock(tx,context,"connections");
      const [replay]=await tx.select().from(versions).where(eq(versions.requestKey,input.idempotencyKey));
      if(replay) { if(replay.requestHash!==digest) throw new ConflictException("请求编号已用于其他连接配置"); return {connectionId:replay.connectionId,version:replay.version}; }
      const id=input.connectionId??createEntityId();
      await logisticsLock(tx,context,`connection:${id}`);
      const [current]=await tx.select().from(connections).where(eq(connections.id,id));
      if((current?.version??0)!==input.expectedVersion || current && current.factoryId!==input.profile.factoryId) throw new ConflictException("连接版本或工厂已变化");
      const [factory]=await tx.select({ factory:fulfillmentFactories,version:fulfillmentFactoryVersions }).from(fulfillmentFactories).innerJoin(fulfillmentFactoryVersions,and(eq(fulfillmentFactoryVersions.factoryId,fulfillmentFactories.id),eq(fulfillmentFactoryVersions.versionNumber,fulfillmentFactories.currentVersionNumber))).where(eq(fulfillmentFactories.id,input.profile.factoryId));
      if(!factory || factory.factory.status!=="active") throw new ConflictException("请先确认有效的生产工厂");
      const origin=factory.version.profile.pickupAddress??factory.version.profile.productionAddress;
      if(!origin || origin.countryCode!==input.profile.originCountryCode || origin.street!==input.profile.sender.address1 || origin.city!==input.profile.sender.city || origin.postalCode!==input.profile.sender.postalCode) throw new ConflictException("发货路线须使用工厂版本中的实际发货地址");
      const prior=current ? await this.connection(tx,id) : null;
      const credentials=input.credentials ?? (prior ? this.vault.withSecret(prior.encryptedCredentials,s=>LogisticsCredentialsSchema.parse(JSON.parse(s))) : null);
      if(!credentials || credentials.provider!==input.profile.provider) throw new ConflictException("请配置此物流账户的 API 凭据");
      const number=(current?.version??0)+1,versionId=createEntityId();
      if(!current) await tx.insert(connections).values({id,tenantId:context.tenantId,createdBy:context.userId,factoryId:input.profile.factoryId,version:number});
      await tx.insert(versions).values({id:versionId,tenantId:context.tenantId,createdBy:context.userId,connectionId:id,version:number,profile:input.profile,encryptedCredentials:this.vault.encrypt(JSON.stringify(credentials)),requestKey:input.idempotencyKey,requestHash:digest});
      if(current) await tx.update(connections).set({version:number,verifiedAt:null,verifiedVersionId:null}).where(eq(connections.id,id));
      return {connectionId:id,version:number};
    });
  }
  async verify(context: TenantContext,id: string,raw: unknown) {
    this.tenantAccess(context);
    authorize(context,Permission.IntegrationManage);
    const input=z.object({expectedVersion:z.int().positive(),idempotencyKey:z.uuid()}).strict().parse(raw);
    const v=await withTenant(this.database.db,context,tx=>this.connection(tx,id));
    if(v.version!==input.expectedVersion) throw new ConflictException("连接版本已变化");
    let result: Array<{code:string;name:string}>;
    try { const credentials=this.vault.withSecret(v.encryptedCredentials,s=>LogisticsCredentialsSchema.parse(JSON.parse(s))); result=await this.gateway.channels(v.profile,credentials); }
    catch { throw new ConflictException("物流账户读取核验失败，请核对当前账户 API 版本、权限及地址"); }
    if(!v.profile.channels.length || v.profile.channels.some(c=>!result.some(r=>r.code===c.code))) throw new ConflictException("配置的服务渠道尚未由当前账户确认");
    return withTenant(this.database.db,context,async tx=>{
      await logisticsLock(tx,context,`connection:${id}`); const current=await this.connection(tx,id);
      if(current.id!==v.id) throw new ConflictException("连接已更新，请重新核验");
      await tx.update(connections).set({verifiedVersionId:v.id,verifiedAt:new Date()}).where(eq(connections.id,id));
      await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,connectionId:id,action:"connection.verified",data:{versionId:v.id,channelCodes:result.map(r=>r.code),idempotencyKey:input.idempotencyKey}});
      return {verified:true,channels:result};
    });
  }
  async saveRule(context: TenantContext,raw: unknown) {
    this.tenantAccess(context);
    authorize(context,Permission.IntegrationManage); const input=SaveLogisticsRuleSchema.parse(raw),digest=logisticsHash(input);
    return withTenant(this.database.db,context,async tx=>{
      await logisticsLock(tx,context,`connection:${input.connectionId}`);
      const [replay]=await tx.select().from(rules).where(eq(rules.requestKey,input.idempotencyKey));
      if(replay) {if(replay.requestHash!==digest) throw new ConflictException("请求编号已用于其他预算规则");return {ruleVersion:replay.version};}
      const [current]=await tx.select().from(connections).where(eq(connections.id,input.connectionId)); const v=await this.connection(tx,input.connectionId);
      if(!current || current.ruleVersion!==input.expectedVersion) throw new ConflictException("预算规则版本已变化");
      if(input.rule.currency!==v.profile.currency || input.rule.allowedChannelCodes.some(code=>!v.profile.channels.some(c=>c.code===code))) throw new ConflictException("预算币种和渠道须与已配置的账户一致");
      if(input.rule.autoPurchase && (current.verifiedVersionId!==v.id || v.profile.channels.filter(c=>input.rule.allowedChannelCodes.includes(c.code)).some(c=>!c.conditionsVerified))) throw new ConflictException("启用自动购单前须核验当前账户、渠道条件、币种及购单权限依据");
      const version=current.ruleVersion+1;
      await tx.insert(rules).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,connectionId:current.id,version,connectionVersionId:v.id,rule:input.rule,requestKey:input.idempotencyKey,requestHash:digest});
      await tx.update(connections).set({ruleVersion:version}).where(eq(connections.id,current.id)); return {ruleVersion:version};
    });
  }
  async createTask(context: TenantContext,raw: unknown) {
    this.write(context); const input=CreateLogisticsTaskSchema.parse(raw),digest=logisticsHash(input);
    const fulfillment=await this.orderService.fulfillmentDetails(context,input.orderId,"fulfillment");
    if(!fulfillment.protectedDetails) throw new ConflictException("订单缺少有效的收件地址和联系方式");
    const {shippingAddress:a,buyer}=fulfillment.protectedDetails;
    const recipientResult=LogisticsAddressSchema.safeParse({name:a.recipient,address1:a.lines[0],address2:a.lines.slice(1).join(" "),city:a.city,region:a.region,postalCode:a.postalCode,countryCode:a.countryCode,phone:buyer.phone,email:buyer.email});
    if(!recipientResult.success) throw new ConflictException("收件地址或联系方式不完整，请先审单核对");
    const outcome=await withTenant(this.database.db,context,async tx=>{
      await logisticsLock(tx,context,`order:${input.orderId}`);
      const [replay]=await tx.select().from(tasks).where(eq(tasks.requestKey,input.idempotencyKey));
      if(replay) {if(replay.requestHash!==digest) throw new ConflictException("请求编号已用于其他物流任务");return {taskId:replay.id,replayed:true};}
      const [order]=await tx.select().from(orders).where(eq(orders.id,input.orderId)).for("share");
      const [address]=await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId,input.orderId)).for("share");
      if(!order || order.latestEventSequence!==input.expectedOrderSequence || order.sideState || order.addressStatus!=="protected" || !address || address.status!=="protected" || address.retentionExpiresAt<=new Date()) throw new ConflictException("订单、地址或审核状态已变化");
      const currentDetails=this.pii.withSecret(address.encryptedEnvelope!,s=>JSON.parse(s));
      if(logisticsHash(currentDetails)!==logisticsHash(fulfillment.protectedDetails)) throw new ConflictException("收件地址已更新，请重新创建物流任务");
      const rows=await tx.select({production:productionOrders,version:productionOrderVersions,line:orderLines}).from(productionOrders).innerJoin(productionOrderVersions,and(eq(productionOrderVersions.productionOrderId,productionOrders.id),eq(productionOrderVersions.versionNumber,productionOrders.currentVersionNumber))).innerJoin(orderLines,eq(orderLines.id,productionOrders.orderLineId)).where(and(eq(productionOrders.orderId,input.orderId),inArray(productionOrders.id,input.productionOrderIds))).for("share",{of:productionOrders});
      const first=rows[0];
      if(rows.length!==input.productionOrderIds.length || !first?.version.factoryId || !first.version.factoryVersionId || rows.some(r=>r.version.factoryId!==first.version.factoryId || r.version.factoryVersionId!==first.version.factoryVersionId || ["cancelled","cancel_requested","failed"].includes(r.production.status) || r.version.expectedCompletionAt>new Date(input.readyAt))) throw new ConflictException("请按已确认工厂拆分物流任务，并核对数量和预计完工时间");
      const connection=await this.connection(tx,input.connectionId); const [parent]=await tx.select().from(connections).where(eq(connections.id,input.connectionId));
      const rule=await this.rule(tx,input.connectionId,parent!.ruleVersion); if(!rule || rule.connectionVersionId!==connection.id) throw new ConflictException("请为当前发货连接设置预算和时效规则");
      if(parent!.factoryId!==first.version.factoryId) throw new ConflictException("物流路线须属于生产任务的实际工厂");
      const [factory]=await tx.select().from(fulfillmentFactoryVersions).where(eq(fulfillmentFactoryVersions.id,first.version.factoryVersionId));
      const origin=factory?.profile.pickupAddress??factory?.profile.productionAddress;
      if(!origin || origin.countryCode!==connection.profile.originCountryCode || origin.street!==connection.profile.sender.address1 || origin.city!==connection.profile.sender.city || origin.postalCode!==connection.profile.sender.postalCode) throw new ConflictException("已固定工厂的实际发货地址与物流连接不一致");
      const requestedQuantities=new Map<string,number>();for(const row of rows){const sku=row.line.skuCode;if(!sku)throw new ConflictException("订单商品缺少可核对的 SKU");requestedQuantities.set(sku,(requestedQuantities.get(sku)??0)+row.version.quantity);}
      const declared=new Map<string,number>();for(const d of input.packages.flatMap(p=>p.declarations))declared.set(d.sku,(declared.get(d.sku)??0)+d.quantity);
      if(logisticsHash([...requestedQuantities].sort())!==logisticsHash([...declared].sort()))throw new ConflictException("包裹申报清单与本次生产商品及数量不一致");
      const existing=await tx.select().from(pins).where(inArray(pins.productionVersionId,rows.map(r=>r.version.id)));
      if(existing.length){
        const ids=[...new Set(existing.map(p=>p.taskId))];const [prior]=ids.length===1?await tx.select().from(tasks).where(eq(tasks.id,ids[0]!)):[];
        if(prior?.identityKey===logisticsHash(rows.map(r=>r.version.id).sort())&&existing.length===rows.length&&prior.encryptedSnapshot){
          const pinned=this.pii.withSecret(prior.encryptedSnapshot,s=>LogisticsTaskSnapshotSchema.parse(JSON.parse(s)));
          const {idempotencyKey:_key,...requested}=input;void _key;
          const previous=Object.fromEntries(Object.keys(requested).map(key=>[key,pinned[key as keyof typeof pinned]]));
          if(logisticsHash(previous)!==logisticsHash(requested))throw new ConflictException("物流任务的包裹、路线或交期已固定，请核对原任务；不能用重试覆盖");
          return {taskId:prior.id,replayed:true};
        }
        throw new ConflictException("商品已属于其他物流任务，请先读取原任务及完整包裹清单");
      }
      const priorPins=await tx.select({task:tasks}).from(pins).innerJoin(productionOrderVersions,eq(productionOrderVersions.id,pins.productionVersionId)).innerJoin(tasks,eq(tasks.id,pins.taskId)).where(inArray(productionOrderVersions.productionOrderId,input.productionOrderIds));
      if(priorPins.some(p=>p.task.status!=="cancelled"))throw new ConflictException("生产任务的旧版本已有物流任务，请先查单核对或取消未购单任务，再处理新版");
      const { idempotencyKey: _requestKey, ...basis }=input;
      void _requestKey;
      const snapshot=LogisticsTaskSnapshotSchema.parse({...basis,factoryId:first.version.factoryId,factoryVersionId:first.version.factoryVersionId,connectionVersionId:connection.id,ruleVersionId:rule.id,recipient:recipientResult.data,
        productionPins:rows.map(r=>({productionOrderId:r.production.id,versionId:r.version.id,lineId:r.line.id,quantity:r.version.quantity})),addressEnvelopeVersion:address.envelopeVersion,retentionExpiresAt:address.retentionExpiresAt.toISOString()});
      const id=createEntityId();
      await tx.insert(tasks).values({id,tenantId:context.tenantId,createdBy:context.userId,orderId:input.orderId,factoryId:snapshot.factoryId,connectionVersionId:connection.id,ruleVersionId:rule.id,identityKey:logisticsHash(rows.map(r=>r.version.id).sort()),requestKey:input.idempotencyKey,requestHash:digest,externalReference:`YMY${id.replaceAll("-","")}`,encryptedSnapshot:this.pii.encrypt(JSON.stringify(snapshot)),snapshotHash:logisticsHash(snapshot),expiresAt:address.retentionExpiresAt});
      await tx.insert(pins).values(rows.map(r=>({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,taskId:id,productionVersionId:r.version.id})));
      await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,taskId:id,action:"task.created",data:{productionOrderIds:input.productionOrderIds,ruleVersionId:rule.id,connectionVersionId:connection.id}});
      return {taskId:id,replayed:false};
    });
    await this.queue.enqueue({taskId:outcome.taskId,tenantId:context.tenantId,requestedBy:context.userId,mode:"purchase",requestKey:input.idempotencyKey});
    const [task]=await withTenant(this.database.db,context,tx=>tx.select().from(tasks).where(eq(tasks.id,outcome.taskId)));
    if(task)await this.queue.enqueue({taskId:task.id,tenantId:context.tenantId,requestedBy:context.userId,mode:"retention",requestKey:task.id,delayMs:Math.max(0,task.expiresAt.getTime()-Date.now())});
    return outcome;
  }
  async options(context: TenantContext,raw: unknown) {
    this.read(context);const query=z.object({orderId:z.uuidv7().optional()}).strict().parse(raw);
    return withTenant(this.database.db,context,async tx=>{
      const factories=await tx.select({factory:fulfillmentFactories,version:fulfillmentFactoryVersions}).from(fulfillmentFactories).innerJoin(fulfillmentFactoryVersions,and(eq(fulfillmentFactoryVersions.factoryId,fulfillmentFactories.id),eq(fulfillmentFactoryVersions.versionNumber,fulfillmentFactories.currentVersionNumber))).where(eq(fulfillmentFactories.status,"active")).limit(200);
      const rows=await tx.select({production:productionOrders,version:productionOrderVersions,line:orderLines,order:orders}).from(productionOrders).innerJoin(productionOrderVersions,and(eq(productionOrderVersions.productionOrderId,productionOrders.id),eq(productionOrderVersions.versionNumber,productionOrders.currentVersionNumber))).innerJoin(orderLines,eq(orderLines.id,productionOrders.orderLineId)).innerJoin(orders,eq(orders.id,productionOrders.orderId)).where(and(query.orderId?eq(orders.id,query.orderId):undefined,notInArray(productionOrders.status,["cancelled","failed"]))).orderBy(desc(productionOrders.createdAt)).limit(101);
      const mapped=rows.length?await tx.select().from(pins).where(inArray(pins.productionVersionId,rows.map(r=>r.version.id))):[];
      return LogisticsOptionsSchema.parse({canConfigure:context.permissions.includes(Permission.IntegrationManage),canCreate:context.permissions.includes(Permission.OrderWrite),truncated:rows.length>100,
        factories:factories.map(f=>({id:f.factory.id,name:f.factory.name,origin:f.version.profile.pickupAddress??f.version.profile.productionAddress})),
        candidates:rows.slice(0,100).filter(r=>r.version.factoryId).map(r=>({productionOrderId:r.production.id,versionId:r.version.id,orderId:r.order.id,orderNumber:r.order.externalOrderId,orderSequence:r.order.latestEventSequence,factoryId:r.version.factoryId,factoryName:factories.find(f=>f.factory.id===r.version.factoryId)?.factory.name??"工厂不可用",sku:r.line.skuCode,quantity:r.version.quantity,expectedCompletionAt:r.version.expectedCompletionAt.toISOString(),status:r.production.status,taskId:mapped.find(p=>p.productionVersionId===r.version.id)?.taskId??null,
          blockers:[...(r.order.sideState?["订单已暂停或取消"]:[]),...(r.order.addressStatus!=="protected"?["有效收件资料缺失"]:[]),...(["cancel_requested","quality_hold"].includes(r.production.status)?["生产任务暂不可购单"]:[])]})),
      });
    });
  }
  async dispatch(context: TenantContext,id: string,raw: unknown) {
    this.write(context);const input=z.object({mode:z.enum(["quote","purchase","reconcile"]),idempotencyKey:z.uuid()}).strict().parse(raw);
    await this.get(context,id);
    await this.queue.enqueue({taskId:id,tenantId:context.tenantId,requestedBy:context.userId,mode:input.mode,requestKey:input.idempotencyKey});return {taskId:id,queued:true};
  }
  async workspace(context: TenantContext,raw: unknown={}) {
    this.read(context);const query=LogisticsReadQuerySchema.parse(raw);
    await purgeLogisticsTasks(this.database,context,this.storage);
    return originalOwnerOperation(()=>new LogisticsReadOwner(this.database,this.pii).workspace(context,query));
  }
  async get(context: TenantContext,id: string): Promise<LogisticsTaskView> { this.read(context);await purgeLogisticsTasks(this.database,context,this.storage,new Date(),id);return originalOwnerOperation(()=>new LogisticsReadOwner(this.database,this.pii).get(context,id)); }
  async label(context: TenantContext,id: string,labelId: string) {
    this.read(context);const found=await withTenant(this.database.db,context,async tx=>{const [task]=await tx.select().from(tasks).where(eq(tasks.id,id));const [order]=task?await tx.select().from(orders).where(eq(orders.id,task.orderId)):[];if(!task?.encryptedSnapshot || task.expiresAt<=new Date() || order?.addressStatus!=="protected")throw new NotFoundException("面单资料已到期或已清理");const [label]=await tx.select().from(labels).where(and(eq(labels.taskId,id),eq(labels.id,labelId)));if(!label)throw new NotFoundException("面单不存在");return label;});
    const body=await this.storage.readPrivate(context,{id:found.id,tenantId:context.tenantId,assetDomain:"order",objectKey:found.objectKey},{requiredDomain:"order"});
    if(createHashBytes(body)!==found.checksum)throw new ConflictException("面单文件校验失败");return {body,name:found.fileName};
  }
  async deliveryForProduction(context: TenantContext,productionVersionId: string) {
    this.read(context);
    return withTenant(this.database.db,context,async tx=>{
      const [pin]=await tx.select().from(pins).where(eq(pins.productionVersionId,productionVersionId));if(!pin)return null;
      const [task]=await tx.select().from(tasks).where(eq(tasks.id,pin.taskId));
      if(!task || task.status!=="completed" || !task.encryptedSnapshot || task.expiresAt<=new Date())throw new ConflictException("此商品的物流任务尚未完成，请先核对购单和面单结果");
      const [connection]=await tx.select().from(versions).where(eq(versions.id,task.connectionVersionId));if(!connection)throw new ConflictException("物流连接版本不可用");
      const files=await tx.select().from(labels).where(eq(labels.taskId,task.id));
      if(connection.profile.labelMode==="include"&&!files.length)throw new ConflictException("云途或随包交付路线缺少面单");
      return {taskId:task.id,externalReference:task.externalReference,provider:connection.profile.provider,labelMode:connection.profile.labelMode,trackingNumbers:task.trackingNumbers,labels:files.map(f=>({id:f.id,fileName:f.fileName,path:`logistics/${task.id}/${f.fileName}`,checksum:f.checksum}))};
    });
  }
  async cancel(context: TenantContext,id: string,raw: unknown) {
    this.write(context);const input=z.object({reason:z.string().trim().min(5).max(1000)}).strict().parse(raw);
    return withTenant(this.database.db,context,async tx=>{await logisticsLock(tx,context,`task:${id}`);const [task]=await tx.select().from(tasks).where(eq(tasks.id,id));if(!task)throw new NotFoundException("物流任务不存在");if(task.reservedDay || task.providerOrderId || task.leaseUntil && task.leaseUntil>new Date())throw new ConflictException("任务已开始购单或正在处理，请先查单核对；本操作不向物流账户撤单");await tx.update(tasks).set({status:"cancelled",diagnostic:"OPERATOR_CANCELLED",updatedAt:new Date()}).where(eq(tasks.id,id));await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,taskId:id,action:"task.cancelled",data:{reason:input.reason}});return {taskId:id,status:"cancelled"};});
  }
  private async connection(tx: TenantTransaction,id: string) { const [row]=await tx.select({v:versions}).from(connections).innerJoin(versions,and(eq(versions.connectionId,connections.id),eq(versions.version,connections.version))).where(eq(connections.id,id));if(!row)throw new NotFoundException("物流连接不存在");return row.v; }
  private async rule(tx: TenantTransaction,id: string,version: number) {const [row]=await tx.select().from(rules).where(and(eq(rules.connectionId,id),eq(rules.version,version)));return row??null;}
  private tenantAccess(context:TenantContext){if(context.dataScope!=="tenant")throw new ForbiddenError(Permission.OrderRead,"outside_data_scope");}
  private read(context: TenantContext) {this.tenantAccess(context);authorize(context,Permission.OrderRead);authorize(context,Permission.OrderPiiRead);}
  private write(context: TenantContext) {this.read(context);authorize(context,Permission.OrderWrite);}
}
import { createHash } from "node:crypto";
const createHashBytes=(body: Uint8Array)=>createHash("sha256").update(body).digest("hex");
