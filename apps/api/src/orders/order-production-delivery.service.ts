import { ProductionDeliveryReadOwner, productionDeliveryManifest as sharedProductionDeliveryManifest, productionDeliveryManifestChecksum as sharedProductionDeliveryManifestChecksum } from "@yummyai/order-core";
import { originalOwnerOperation, rethrowOriginalOwnerError } from "../shared/original-owner-error.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { withOrderAuthority } from "@yummyai/order-core";

import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext, type RecordProductionMilestoneInput } from "@yummyai/contracts";
import { OrderRuleSnapshotSchema } from "@yummyai/contracts/rules";

import { CreateProductionDeliverySchema, ProductionDeliverySnapshotSchema, ProductionDeliveryWorkspaceSchema, ProductionDeliveryQuerySchema, RecordProductionDeliveryFeedbackSchema, type ProductionDeliverySnapshot, type ProductionDeliveryPackageView, type ProductionDeliverySelection, type RecordProductionDeliveryFeedback } from "@yummyai/contracts/order/production-delivery";
import { FactoryTaskQuerySchema, FactoryTaskFeedbackSchema, FactoryWorkItemViewSchema, FactoryWorkItemListSchema } from "@yummyai/contracts/suppliers/factory-portal";
import { factoryCursor, factoryCursorBefore, factoryCursorTimestamp, nextFactoryCursor, resolveFactoryCursor } from "./factory-pagination.js";
import { requireFactoryTask, recordFactoryTaskOrigin, factoryReceiptIds } from "./factory-access.js";
import { fulfillmentSuppliers, orderWorkItems, productionOrders, productionOrderVersions, productionEditorProjects, orderDesignAgentRuns, productionDeliveryPackages as packages, productionDeliveryItems as items, productionDeliveryFeedback as feedback, factoryTaskAssignments, factoryAccessGrants, factoryTaskReceipts, memberships, fulfillmentFactories, type DatabaseConnection, type TenantTransaction, withTenant } from "@yummyai/database";
import { getProductionLayout, MAX_PRODUCTION_PIXELS } from "@yummyai/production-editor";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ilike, or, lte, sql } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AuditService } from "../audit/audit.service.js";
import { openWork, sealWork } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { LogisticsService } from "../logistics/logistics.service.js";
import { assertOrderFulfillmentCommandFence, type OrderFulfillmentCommandFence } from "./order-fulfillment-command-fence.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_FILE_BYTES = 50 * 1024 * 1024, MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
type Item = typeof items.$inferSelect;
type Feedback = typeof feedback.$inferSelect;
type Prepared = { selection: ProductionDeliverySelection; snapshot: ProductionDeliverySnapshot; supplierName: string };

/** A download and an operator's factory receipt do not authorize production. */
@Injectable()
export class OrderProductionDeliveryService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
    @Inject(OrderProductionService) private readonly production: OrderProductionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FactoryDirectoryService) private readonly factories: FactoryDirectoryService,
    @Inject(LogisticsService) private readonly logistics?: LogisticsService,
  ) {}

  async workspace(context: TenantContext, raw: unknown) {
    this.readAccess(context);
    const query = ProductionDeliveryQuerySchema.parse(raw);
    const data = await withTenant(this.database.db, context, async tx => {
      const rows = await tx.select({ id: productionOrders.id }).from(productionOrders)
        .innerJoin(productionOrderVersions, and(eq(productionOrderVersions.productionOrderId, productionOrders.id), eq(productionOrderVersions.versionNumber, productionOrders.currentVersionNumber)))
        .innerJoin(productionEditorProjects, eq(productionEditorProjects.id, productionOrderVersions.sourceEditorProjectId))
        .where(and(isNotNull(productionOrders.sourceWorkItemId), eq(productionEditorProjects.name, "shaped_pillow"), query.order ? eq(productionOrders.orderId, query.order) : undefined, query.line ? eq(productionOrders.orderLineId, query.line) : undefined, query.supplier ? eq(productionOrders.supplierId, query.supplier) : undefined, query.factory ? eq(productionOrders.factoryId, query.factory) : undefined, query.dueBefore ? lte(productionOrders.expectedCompletionAt, new Date(query.dueBefore)) : undefined))
        .orderBy(desc(productionOrders.createdAt), asc(productionOrders.id)).limit(101);
      const candidates = [];
      for (const { id } of rows.slice(0, 100)) {
        const source = await this.source(tx, id);
        const retained = this.retained(source);
        candidates.push({ productionOrderId: id, productionVersionId: source.version.id, projectionVersion: source.order.projectionVersion,
          supplierId: source.supplier.id, supplierName: source.supplier.name, orderLineId: source.order.orderLineId,
          factoryId: source.order.factoryId, factoryName: source.factoryPin?.factoryProfile.name ?? null, factoryVersionId: source.version.factoryVersionId,
          orderNumber: retained ? source.businessOrder.externalOrderId : "资料已到期", quantity: source.version.quantity,
          expectedCompletionAt: source.version.expectedCompletionAt.toISOString(), editorVersionId: source.version.sourceEditorVersionId,
          status: source.order.status, blockers: this.blockers(source, true), parentProductionOrderId: source.order.parentProductionOrderId });
      }
      const recent = await tx.selectDistinct({ id: packages.id, createdAt: packages.createdAt }).from(packages)
        .innerJoin(items, eq(items.packageId, packages.id)).innerJoin(productionOrderVersions, eq(productionOrderVersions.id, items.productionVersionId))
        .innerJoin(productionOrders, eq(productionOrders.id, items.productionOrderId))
        .where(and(query.order ? eq(productionOrders.orderId, query.order) : undefined, query.line ? eq(items.workItemId, query.line) : undefined, query.supplier ? eq(packages.supplierId, query.supplier) : undefined, query.factory ? eq(packages.factoryId, query.factory) : undefined,
          query.dueBefore ? lte(productionOrderVersions.expectedCompletionAt, new Date(query.dueBefore)) : undefined))
        .orderBy(desc(packages.createdAt), desc(packages.id)).limit(21);
      return { candidates, ids: recent.slice(0, 20).map(row => row.id), truncated: rows.length > 100 || recent.length > 20 };
    });
    const result = [];
    for (const id of data.ids) result.push(await this.get(context, id));
    return ProductionDeliveryWorkspaceSchema.parse({ candidates: data.candidates, packages: result, truncated: data.truncated });
  }

  /** Internal assignment validation; original production/file checks stay owned here. */
  async factoryErpItemsInTransaction(tx: TenantTransaction, context: TenantContext, ids: string[], lock = false) {
    this.readAccess(context);
    const pins: ProductionDeliverySnapshot[] = [];
    const load = async (id: string) => {
      const [item] = await tx.select().from(items).where(eq(items.id, id));
      if (!item) throw new NotFoundException("原交付文件不存在");
      const record = await this.package(tx, item.packageId), source = await this.source(tx, item.productionOrderId);
      if (!this.retained(source)) throw new ConflictException("原订单资料已到期或清理");
      const pin = this.snapshot(source, item); this.assertSource(source, undefined, false, pin);
      if (!record.factoryId || record.factoryId !== pin.factory?.factoryId || !item.manufacturingPlanChecksum)
        throw new ConflictException("原交付缺少固定工厂或制造版本");
      const events = await tx.select().from(feedback).where(eq(feedback.itemId, id)).orderBy(desc(feedback.sequence));
      const submitted = events.find(e => e.kind === "submitted"), last = events.find(e => e.kind !== "rework");
      if (!submitted || last?.kind === "rejected") throw new ConflictException("原文件尚未提交成功或已拒收");
      return { selection: { deliveryItemId: id, productionOrderId: item.productionOrderId, productionVersionId: item.productionVersionId,
        fileChecksum: item.fileChecksum, manufacturingChecksum: item.manufacturingPlanChecksum }, quantity: pin.quantity, snapshot: pin,
        factoryId: record.factoryId, packageId: record.id, submittedFeedbackId: submitted.id, submittedAt: submitted.occurredAt.toISOString() };
    };
    for (const id of ids) pins.push((await load(id)).snapshot);
    if (lock && pins.length) await this.lockSources(tx, pins);
    const result = []; for (const id of ids) result.push(await load(id)); return result;
  }

  async assertFactoryAssignableInTransaction(tx:TenantTransaction,context:TenantContext,itemId:string){
    this.writeAccess(context);
    const [item]=await tx.select().from(items).where(eq(items.id,itemId));
    if(!item)throw new NotFoundException("交付文件不存在");
    const record=await this.package(tx,item.packageId),source=await this.source(tx,item.productionOrderId);
    const pin=this.snapshot(source,item);this.assertSource(source,undefined,false,pin);
    if(!record.factoryId||record.factoryId!==source.order.factoryId)throw new ConflictException("交付文件没有有效的固定工厂");
    const [last]=await tx.select({kind:feedback.kind}).from(feedback).where(and(eq(feedback.itemId,item.id),sql`${feedback.kind}<>'rework'`)).orderBy(desc(feedback.sequence)).limit(1);
    if(last?.kind==="rejected")throw new ConflictException("原文件已拒收，请为返工单创建新交付包");
    return{factoryId:record.factoryId,fileChecksum:item.fileChecksum,packageChecksum:record.checksum};
  }

  async factoryTasks(context:TenantContext,raw:unknown){
    authorize(context,Permission.FactoryTaskRead);const input=FactoryTaskQuerySchema.parse(raw),cursor=factoryCursor(input.cursor),search=input.q?`%${input.q.replace(/^FC-/i,"")}%`:undefined;
    return withTenant(this.database.db,context,async tx=>{
      const status=sql<string>`coalesce((select f.kind from production_delivery_feedback f where f.tenant_id=${items.tenantId} and f.item_id=${items.id} and f.kind<>'rework' order by f.sequence desc limit 1),'pending')`;
      const visible=and(eq(memberships.userId,context.userId),eq(memberships.status,"active"),eq(fulfillmentFactories.status,"active"),eq(fulfillmentSuppliers.status,"active"),isNull(factoryAccessGrants.revokedAt),isNull(factoryTaskAssignments.revokedAt),sql`${factoryAccessGrants.expiresAt}>clock_timestamp()`,sql`${factoryTaskAssignments.expiresAt}>clock_timestamp()`,eq(factoryTaskAssignments.fileChecksum,items.fileChecksum),input.status!=="all"?sql`${status}=${input.status}`:undefined,search?or(ilike(fulfillmentFactories.name,search),sql`${factoryTaskAssignments.id}::text ilike ${search}`):undefined);
      const selectTasks=()=>tx.select({id:factoryTaskAssignments.id,createdAtExact:factoryCursorTimestamp(factoryTaskAssignments.createdAt)}).from(factoryTaskAssignments)
        .innerJoin(factoryAccessGrants,eq(factoryAccessGrants.id,factoryTaskAssignments.grantId)).innerJoin(memberships,eq(memberships.id,factoryAccessGrants.membershipId))
        .innerJoin(fulfillmentFactories,eq(fulfillmentFactories.id,factoryAccessGrants.factoryId)).innerJoin(fulfillmentSuppliers,eq(fulfillmentSuppliers.id,fulfillmentFactories.supplierId))
        .innerJoin(items,eq(items.id,factoryTaskAssignments.deliveryItemId)).innerJoin(packages,and(eq(packages.id,items.packageId),eq(packages.factoryId,fulfillmentFactories.id)));
      const [anchor]=cursor?await selectTasks().where(and(visible,eq(factoryTaskAssignments.id,cursor.id))).limit(1):[];
      const position=resolveFactoryCursor(cursor,anchor);
      const rows=await selectTasks().where(and(visible,factoryCursorBefore(factoryTaskAssignments.createdAt,factoryTaskAssignments.id,position)))
        .orderBy(desc(factoryTaskAssignments.createdAt),desc(factoryTaskAssignments.id)).limit(input.limit+1);
      const views=[];for(const row of rows.slice(0,input.limit)){try{views.push(await this.factoryTaskInTransaction(tx,context,row.id));}catch(error){if(!(error instanceof NotFoundException))throw error;}}
      return FactoryWorkItemListSchema.parse({items:views,nextCursor:nextFactoryCursor(rows[Math.min(rows.length,input.limit)-1],rows.length>input.limit)});
    });
  }
  async factoryTask(context:TenantContext,assignmentId:string){authorize(context,Permission.FactoryTaskRead);return withTenant(this.database.db,context,tx=>this.factoryTaskInTransaction(tx,context,assignmentId));}
  /** Internal quantity source. No independent transaction, private DTO or file I/O. */
  async factoryQuantitySourceInTransaction(tx:TenantTransaction,context:TenantContext,assignmentId:string,respond=false){
    authorize(context,Permission.FactoryTaskRead);
    const scope=await requireFactoryTask(tx,context,assignmentId,respond);
    await tx.select({id:orderWorkItems.id}).from(orderWorkItems).where(eq(orderWorkItems.id,scope.item.workItemId)).for("share");
    const source=await this.source(tx,scope.item.productionOrderId);
    const privateCurrent=await this.factoryPrivateCurrent(tx,source)&&source.work?.pushedRevisionId===scope.item.workRevisionId;
    const pin=privateCurrent?this.snapshot(source,scope.item):null;
    const blockers=pin?this.blockers(source,false,pin,"quantity"):["制作资料已到期、清理或来源已更新 请联系运营重新交付"];
    const [acceptedFeedback]=await tx.select().from(feedback).where(and(eq(feedback.itemId,scope.item.id),sql`${feedback.kind}<>'rework'`)).orderBy(desc(feedback.sequence)).limit(1);
    const selfAccepted=acceptedFeedback?.kind==="accepted"&&acceptedFeedback.recordedBy===context.userId&&
      (await tx.select({id:factoryTaskReceipts.id}).from(factoryTaskReceipts).where(and(
        eq(factoryTaskReceipts.assignmentId,assignmentId),eq(factoryTaskReceipts.feedbackId,acceptedFeedback.id),
        eq(factoryTaskReceipts.recordedBy,context.userId)))).length===1;
    return {scope,source,pin,blockers,privateCurrent,acceptedFeedback:acceptedFeedback??null,selfAccepted};
  }
  private async factoryTaskInTransaction(tx:TenantTransaction,context:TenantContext,assignmentId:string){
    const scope=await requireFactoryTask(tx,context,assignmentId);
    await tx.select({id:orderWorkItems.id}).from(orderWorkItems).where(eq(orderWorkItems.id,scope.item.workItemId)).for("share");
    const source=await this.source(tx,scope.item.productionOrderId);
    const allEvents=await tx.select().from(feedback).where(eq(feedback.itemId,scope.item.id)).orderBy(desc(feedback.sequence)).limit(1001),events=allEvents.slice(0,1000).reverse();
    const [latest]=await tx.select({kind:feedback.kind}).from(feedback).where(and(eq(feedback.itemId,scope.item.id),sql`${feedback.kind}<>'rework'`)).orderBy(desc(feedback.sequence)).limit(1);
    const privateCurrent=await this.factoryPrivateCurrent(tx,source)&&source.work?.pushedRevisionId===scope.item.workRevisionId;
    const pin=privateCurrent?this.snapshot(source,scope.item):null,blockers=pin?this.blockers(source,false,pin):["制作资料已到期、清理或来源已更新，请联系运营重新交付"];
    const origins=await factoryReceiptIds(tx,events.map(event=>event.id));
    const receipts=privateCurrent?events.filter(event=>["received","accepted","rejected"].includes(event.kind)).map(event=>{
      const evidence=this.feedbackView(source.work!.encryptedDataKey!,event,origins.has(event.id)?"factory":"operator"),direct=origins.has(event.id);
      return{id:event.id,sequence:event.sequence,kind:event.kind,reference:direct?evidence.reference:"运营登记",note:direct?evidence.note:"该状态由运营登记，内部说明不向工厂展示",affectedQuantity:evidence.affectedQuantity,occurredAt:event.occurredAt.toISOString(),recordedAt:event.recordedAt.toISOString(),origin:direct?"factory":"operator"};
    }):[];
    const stillCurrent=privateCurrent&&await this.factoryPrivateCurrent(tx,source);
    return FactoryWorkItemViewSchema.parse({id:scope.assignment.id,reference:`FC-${scope.assignment.id.slice(-8)}`,factoryName:scope.factoryName,expiresAt:scope.assignment.expiresAt.toISOString(),createdAt:scope.assignment.createdAt.toISOString(),status:latest?.kind??"pending",sequence:allEvents[0]?.sequence??0,canRespond:scope.grant.canRespond&&stillCurrent&&!blockers.length&&latest?.kind!=="rejected",blockers:stillCurrent?blockers:["制作资料已失效或到期，请联系运营"],manufacturing:stillCurrent&&pin?{factoryStandardId:pin.factoryStandardId,quantity:pin.quantity,sizeMm:pin.sizeMm,sizeBasis:pin.sizeBasis,sideMode:pin.sideMode,minimumNeckMm:pin.minimumNeckMm,minimumNeckBasis:pin.minimumNeckBasis,expectedCompletionAt:pin.expectedCompletionAt,instructions:pin.instructions,recipe:pin.manufacturing?.plan??null}:null,file:stillCurrent&&pin?{checksum:pin.file.checksum,byteSize:pin.file.byteSize,name:`factory-task-${assignmentId}.jpg`,mediaType:"image/jpeg"}:null,receipts:stillCurrent?receipts:[],receiptsTruncated:allEvents.length>1000});
  }
  async factoryFile(context:TenantContext,assignmentId:string){
    authorize(context,Permission.FactoryTaskRead);
    const validate=(audit=false)=>withTenant(this.database.db,context,async tx=>{const scope=await requireFactoryTask(tx,context,assignmentId);await this.lock(tx,`order-work:${scope.item.workItemId}`);await this.lock(tx,`production-order:${scope.item.productionOrderId}`);await tx.select({id:orderWorkItems.id}).from(orderWorkItems).where(eq(orderWorkItems.id,scope.item.workItemId)).for("share");await tx.select({id:productionEditorProjects.id}).from(productionEditorProjects).where(eq(productionEditorProjects.id,scope.item.editorProjectId)).for("share");const source=await this.source(tx,scope.item.productionOrderId);if(!await this.factoryPrivateCurrent(tx,source))throw new NotFoundException("工厂制作文件已到期或清理");const pin=this.snapshot(source,scope.item);this.assertSource(source,undefined,false,pin);const [last]=await tx.select({kind:feedback.kind}).from(feedback).where(and(eq(feedback.itemId,scope.item.id),sql`${feedback.kind}<>'rework'`)).orderBy(desc(feedback.sequence)).limit(1);if(last?.kind==="rejected")throw new ConflictException("原文件已拒收，请联系运营处理返工");if(audit)await this.audit.recordInTransaction(tx,context,{action:"factory_portal.download",resourceType:"factory_task",resourceId:assignmentId,result:"success",metadata:{}});return pin;});
    const original=await validate(),result=await this.editor.factoryTaskFile(context,assignmentId,original.file.key);
    try{if(result.body.byteLength!==original.file.byteSize||sha(result.body)!==original.file.checksum)throw new ConflictException("工厂文件与原交付字节不同");const current=await validate(true);if(current.file.checksum!==original.file.checksum||current.renderId!==original.renderId)throw new ConflictException("工厂文件来源已变化");return result;}catch(error){result.body.fill(0);throw error;}
  }
  async factoryFeedback(context:TenantContext,assignmentId:string,raw:unknown){
    authorize(context,Permission.FactoryTaskRespond);const input=FactoryTaskFeedbackSchema.parse(raw),requestChecksum=sha(JSON.stringify({actor:context.userId,assignmentId,...input}));
    await withTenant(this.database.db,context,async tx=>{const scope=await requireFactoryTask(tx,context,assignmentId,true),source=await this.source(tx,scope.item.productionOrderId);if(!await this.factoryPrivateCurrent(tx,source))throw new NotFoundException("制作资料已到期或清理");const saved=await this.saveFeedbackInTransaction(tx,context,scope.package.id,scope.item.id,{kind:input.kind,expectedSequence:input.expectedSequence,fileChecksum:input.fileChecksum,idempotencyKey:input.idempotencyKey,reference:input.reference,note:input.note,occurredAt:input.occurredAt,affectedQuantity:input.affectedQuantity,cost:null,replacementProductionOrderId:null,manufacturingChecksum:input.manufacturingChecksum},requestChecksum,assignmentId);if(!saved.replayed){await recordFactoryTaskOrigin(tx,context,assignmentId,saved.id);await this.audit.recordInTransaction(tx,context,{action:"factory_portal.feedback",resourceType:"factory_task",resourceId:assignmentId,result:"success",metadata:{kind:input.kind}});}});
    return this.factoryTask(context,assignmentId);
  }
  private async factoryPrivateCurrent(tx:TenantTransaction,source:Source){
    if(!this.retained(source)||!source.project?.encryptedDataKey)return false;
    const rows=await tx.execute(sql`select ${source.work!.expiresAt.toISOString()}::timestamptz>clock_timestamp() and (${source.project.expiresAt?.toISOString()??null}::timestamptz is null or ${source.project.expiresAt?.toISOString()??null}::timestamptz>clock_timestamp()) as valid`);return rows[0]?.valid===true;
  }

  async create(context: TenantContext, raw: unknown, fence?: OrderFulfillmentCommandFence, orderId?: string) {
    this.writeAccess(context);
    const input = CreateProductionDeliverySchema.parse(raw);
    // Canonical selection order makes a retry independent of table sort order.
    input.items.sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId));
    const requestChecksum = sha(JSON.stringify(input));
    const replay = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead], async tx => {
      await this.commandFence(tx, context, input, fence, orderId);
      return this.replay(tx, input.idempotencyKey, requestChecksum, context.userId);
    });
    if (replay) return this.get(context, replay);
    const prepared: Prepared[] = [];
    let totalBytes = 0;
    for (const selection of input.items) {
      const source = await withTenant(this.database.db, context, tx => this.source(tx, selection.productionOrderId));
      this.assertSource(source, selection, true);
      if (source.supplier.id !== input.supplierId) throw new ConflictException("一个交付包只能包含同一家工厂的订单");
      if (source.order.factoryId !== input.factoryId) throw new ConflictException("同一供应商的不同工厂必须分别交付");
      const snapshot = await this.prepare(context, source);
      const logistics = await this.logistics?.deliveryForProduction(context,selection.productionVersionId);
      if(logistics) snapshot.logistics=logistics;
      totalBytes += snapshot.file.byteSize;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new ConflictException("交付包超过 256 MiB，请分批交付");
      prepared.push({ selection, snapshot, supplierName: source.supplier.name });
      if (prepared.some(entry => entry.snapshot.factory!.factoryVersionId !== snapshot.factory!.factoryVersionId)) throw new ConflictException("工厂地址或联系人版本不同，请按工厂资料版本分别打包");
    }
    const id = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead], async tx => {
      await this.lock(tx, `production-delivery-create:${input.idempotencyKey}`);
      await this.commandFence(tx, context, input, fence, orderId);
      const existing = await this.replay(tx, input.idempotencyKey, requestChecksum, context.userId);
      if (existing) return existing;
      await this.lockSources(tx, prepared.map(p => p.snapshot));
      for (const entry of prepared) this.assertSource(await this.source(tx, entry.selection.productionOrderId), entry.selection, true, entry.snapshot);
      const id = createEntityId(), createdAt = new Date(), supplierName = prepared[0]!.supplierName;
      const checksum = manifestChecksum(deliveryManifest(id, input.supplierId, supplierName, createdAt, prepared.map(p => p.snapshot), 3), 3);
      await tx.insert(packages).values({ id, tenantId: context.tenantId, supplierId: input.supplierId, supplierName, idempotencyKey: input.idempotencyKey,
        schemaVersion: 3, factoryId: input.factoryId, factoryVersionId: prepared[0]!.snapshot.factory!.factoryVersionId,
        requestChecksum, checksum, createdAt, createdBy: context.userId });
      for (const entry of prepared) {
        const source = await this.source(tx, entry.selection.productionOrderId), pin = entry.snapshot;
        await tx.insert(items).values({ id: createEntityId(), tenantId: context.tenantId, packageId: id, productionOrderId: pin.productionOrderId,
          productionVersionId: pin.productionVersionId, workItemId: pin.orderLineId, workRevisionId: pin.workRevisionId,
          editorProjectId: pin.editorProjectId, editorVersionId: pin.editorVersionId, renderId: pin.renderId,
          fileChecksum: pin.file.checksum, byteSize: pin.file.byteSize,
          manufacturingBindingId: pin.manufacturing!.bindingId, manufacturingContentChecksum: pin.manufacturing!.sourceContentChecksum,
          manufacturingPlanChecksum: pin.manufacturing!.plan.checksum,
          encryptedSnapshot: this.withKey(source.work!.encryptedDataKey!, key => sealWork(key, pin)) });
      }
      await this.audit.recordInTransaction(tx, context, { action: "production_delivery.create", resourceType: "production_delivery", resourceId: id, result: "success", metadata: { itemCount: input.items.length } });
      return id;
    });
    return this.get(context, id);
  }

  async get(context: TenantContext, id: string): Promise<ProductionDeliveryPackageView> { return originalOwnerOperation(() => new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).get(context, id)); }

  async download(context: TenantContext, id: string) {
    this.readAccess(context);
    const view = await this.get(context, id);
    if (!view.canDownload) throw new ConflictException("该交付包已阻止下载，请核对订单、文件版本及工厂拒收记录");
    const zip = new JSZip(), buffers: Buffer[] = [];
    let totalBytes = 0;
    try {
      for (const item of view.items) {
        const pin = item.snapshot!;
        const file = await this.editor.renderFile(context, pin.editorProjectId, pin.renderId, pin.file.key);
        const bytes = Buffer.from(file.body); buffers.push(bytes);
        if (bytes.length !== pin.file.byteSize || sha(bytes) !== pin.file.checksum || file.mediaType !== "image/jpeg") throw new ConflictException("正式文件内容与交付包不一致，已阻止下载");
        totalBytes += bytes.byteLength;
        if(totalBytes > MAX_PACKAGE_BYTES) throw new ConflictException("交付文件与面单超过 256 MiB，请拆分交付包");
        zip.file(pin.file.path, bytes, { date: new Date(view.createdAt), createFolders: false });
        for(const label of pin.logistics?.labels ?? []) {
          if(!this.logistics) throw new ConflictException("物流面单读取不可用");
          const result=await this.logistics.label(context,pin.logistics!.taskId,label.id);
          if(sha(result.body)!==label.checksum) throw new ConflictException("面单版本与封存交付清单不一致");
          totalBytes += result.body.byteLength;
          if(totalBytes > MAX_PACKAGE_BYTES) throw new ConflictException("交付文件与面单超过 256 MiB，请拆分交付包");
          zip.file(label.path,result.body,{date:new Date(view.createdAt),createFolders:false});
        }
      }
      const manifest = deliveryManifest(id, view.supplierId, view.supplierName, new Date(view.createdAt), view.items.map(item => item.snapshot!), view.schemaVersion);
      zip.file("manifest.json", view.schemaVersion === 3 ? canonicalJson(manifest) : JSON.stringify(manifest, null, 2), { date: new Date(view.createdAt) });
      const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""').replace(/^(?=[\s]*[=+@-])/, "'")}"`;
      zip.file("商品交付清单.csv", "\uFEFF" + ["订单号,订单商品,SKU,商品名称,数量,工厂,预计完工,制作文件,SHA256,物流账户,物流订单,面单交接", ...view.items.map(({ snapshot: pin }) => [pin!.orderNumber,pin!.orderLineId,pin!.skuCode,pin!.productTitle,pin!.quantity,pin!.factory?.factoryProfile.name,pin!.expectedCompletionAt,pin!.file.path,pin!.file.checksum,pin!.logistics?.provider,pin!.logistics?.externalReference,pin!.logistics?.labelMode === "factory_pull" ? "工厂从 ShipOS 拉取" : pin!.logistics?.labels.map(l => l.path).join(" | ")].map(cell).join(","))].join("\r\n"), {date: new Date(view.createdAt)});
      if (view.schemaVersion === 3) {
        const materialRows: unknown[][] = [], operationRows: unknown[][] = [];
        for (const { snapshot: entry } of view.items) {
          const plan = entry!.manufacturing!.plan, prefix = [entry!.orderNumber, entry!.file.path, plan.code, plan.versionNumber, plan.checksum, plan.quantity, plan.unit];
          for (const material of plan.materials) materialRows.push([...prefix, material.code, material.name, material.plannedNumerator, material.plannedDenominator, material.unit,
            material.responsibility === "factory" ? "工厂供料" : "商家供料", material.operationCode, material.lossBps, material.lossBasis]);
          for (const [index, operation] of plan.operations.entries()) operationRows.push([...prefix, index + 1, operation.code, operation.name, operation.processCode,
            operation.responsibility === "factory" ? "工厂执行" : "商家执行"]);
        }
        const csv = (header: string, rows: unknown[][]) => "\uFEFF" + [header, ...rows.map(row => row.map(cell).join(","))].join("\r\n");
        const prefix = "订单号,制作文件,制造编号,制造版本,制造清单校验值,订购数量,订购单位";
        zip.file("制造材料清单.csv", csv(prefix + ",材料编码,材料名称,计划用量分子,计划用量分母,基本单位,供料责任,关联工序,损耗基点,损耗口径", materialRows), { date: new Date(view.createdAt) });
        zip.file("制造工序清单.csv", csv(prefix + ",顺序,工序编码,工序名称,加工代码,执行责任", operationRows), { date: new Date(view.createdAt) });
        zip.file("本单生产说明.csv", csv("订单号,制作文件,制造清单校验值,生产说明", view.items.map(({ snapshot: entry }) => [entry!.orderNumber, entry!.file.path, entry!.manufacturing!.plan.checksum, entry!.instructions])), { date: new Date(view.createdAt) });
      }
      zip.file("交付说明.txt", "本包包含已审核版本的正式 JPG 及不可变交付清单。请按订单分目录核对数量、尺寸、单双面及文件 SHA-256；不得缩放、改 DPI 或改动图案。规则标记 legacy_missing 的订单没有历史规则快照，须按已审核工艺人工核对。下载不代表工厂已接单或已经开产，工厂回复须由运营逐文件登记。", { date: new Date(view.createdAt) });
      const body = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
      try {
        // Recheck after all private reads and ZIP assembly. Never serve a revoked file.
        await withTenant(this.database.db, context, async tx => {
          await this.lockSources(tx, view.items.map(item => item.snapshot!));
          for (const item of view.items) {
            const source = await this.source(tx, item.productionOrderId);
            this.assertSource(source, undefined, false, item.snapshot!);
            const [latest] = await tx.select().from(feedback).where(and(eq(feedback.itemId, item.id), sql`${feedback.kind} <> 'rework'`)).orderBy(desc(feedback.sequence)).limit(1);
            if (latest?.kind === "rejected") throw new ConflictException("工厂已拒收该文件，请处理返工后创建新交付包");
          }
        });
      } catch (error) { body.fill(0); throw error; }
      return { body, name: `pillow-delivery-${id}.zip`, mediaType: "application/zip", inline: false };
    } finally { buffers.forEach(buffer => buffer.fill(0)); }
  }

  async recordFeedback(context: TenantContext, packageId: string, itemId: string, raw: unknown, fence?: OrderFulfillmentCommandFence) {
    this.writeAccess(context);
    const input = RecordProductionDeliveryFeedbackSchema.parse(raw), requestChecksum = sha(JSON.stringify(input));
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead], async tx => {
      const saved = await this.saveFeedbackInTransaction(tx,context,packageId,itemId,input,requestChecksum,undefined,fence);
      if (!saved.replayed) await this.audit.recordInTransaction(tx, context, { action: "production_delivery.feedback", resourceType: "production_delivery", resourceId: packageId, result: "success", metadata: { itemId, kind: input.kind } });
    });
    return this.get(context, packageId);
  }

  private async saveFeedbackInTransaction(tx:TenantTransaction,context:TenantContext,packageId:string,itemId:string,input:Omit<RecordProductionDeliveryFeedback,"verifiedByOperator">,requestChecksum:string,factoryAssignmentId?:string,fence?:OrderFulfillmentCommandFence){
      await this.lock(tx, `production-delivery-item:${itemId}`);
      const record = await this.package(tx, packageId);
      const [item] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.packageId, packageId)));
      if (!item) throw new NotFoundException("交付文件不存在");
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "delivery_feedback", targetId: itemId, packageId,
        input: { ...input, verifiedByOperator: true } }, fence);
      const [replayed] = await tx.select().from(feedback).where(and(eq(feedback.itemId, itemId), eq(feedback.idempotencyKey, input.idempotencyKey)));
      if (replayed) { if (replayed.requestChecksum !== requestChecksum || replayed.recordedBy !== context.userId) throw new ConflictException("同一次工厂回执的重试内容或操作员不能改变"); return { id: replayed.id, replayed: true }; }
      await this.lock(tx, `order-work:${item.workItemId}`);
      for (const id of [...new Set([item.productionOrderId, input.replacementProductionOrderId].filter((value): value is string => !!value))].sort()) await this.lock(tx, `production-order:${id}`);
      if(factoryAssignmentId)await tx.select({id:orderWorkItems.id}).from(orderWorkItems).where(eq(orderWorkItems.id,item.workItemId)).for("share");
      const source = await this.source(tx, item.productionOrderId);
      if (!this.retained(source)) throw new ConflictException("订单资料已到期或清理，不能登记私人回执");
      if(factoryAssignmentId&&!await this.factoryPrivateCurrent(tx,source))throw new ConflictException("制作资料已到期，不能登记工厂回执");
      const pin = this.snapshot(source, item);
      if (input.fileChecksum !== pin.file.checksum) throw new ConflictException("工厂回执未绑定本次交付的文件校验值");
      if (input.manufacturingChecksum !== undefined && input.manufacturingChecksum !== pin.manufacturing?.plan.checksum ||
          input.kind === "accepted" && pin.manufacturing && input.manufacturingChecksum !== pin.manufacturing.plan.checksum)
        throw new ConflictException("请核对本次制造清单的版本与校验值后再接受文件");
      const events = await tx.select().from(feedback).where(eq(feedback.itemId, itemId)).orderBy(asc(feedback.sequence));
      const sequence = events.at(-1)?.sequence ?? 0, status = [...events].reverse().find(event => event.kind !== "rework")?.kind ?? "pending";
      if (sequence !== input.expectedSequence) throw new ConflictException("工厂回执已更新，请刷新后核对");
      if (input.kind === "submitted" && status !== "pending" || input.kind === "received" && !["pending","submitted"].includes(status) || input.kind === "accepted" && status !== "received" || input.kind === "rejected" && status === "rejected" || input.kind === "rework" && status !== "rejected")
        throw new ConflictException("请按收到文件、接受或拒收、返工的顺序登记");
      if (input.kind === "accepted"||factoryAssignmentId) this.assertSource(source, undefined, false, pin);
      if (input.affectedQuantity !== null && input.affectedQuantity > pin.quantity) throw new ConflictException("返工数量不能超过该交付文件的生产数量");
      const occurred = new Date(input.occurredAt);
      if (occurred.getTime() > Date.now() + 60_000 || occurred.getTime() < record.createdAt.getTime() - 60_000) throw new ConflictException("回执发生时间须在创建交付包之后，且不能是未来时间");
      let replacementEditorVersionId: string | null = null;
      let replacementEditorVersionNumber: number | null = null;
      if (input.replacementProductionOrderId) {
        const replacement = await this.source(tx, input.replacementProductionOrderId);
        if (replacement.order.parentProductionOrderId !== item.productionOrderId || replacement.order.orderLineId !== pin.orderLineId) throw new ConflictException("请关联本生产单的返工单，不能关联其他订单");
        this.assertSource(replacement, undefined, true);
        if (replacement.version.quantity < input.affectedQuantity!) throw new ConflictException("关联返工单的数量不足");
        replacementEditorVersionId = replacement.version.sourceEditorVersionId;
        replacementEditorVersionNumber = replacement.editorVersion!.versionNumber;
      }
      const feedbackId=createEntityId();
      await tx.insert(feedback).values({ id: feedbackId, tenantId: context.tenantId, itemId, sequence: sequence + 1, kind: input.kind,
        idempotencyKey: input.idempotencyKey, requestChecksum, recordedBy: context.userId, occurredAt: occurred,
        encryptedEvidence: this.withKey(source.work!.encryptedDataKey!, key => sealWork(key, { reference: input.reference, note: input.note,
          affectedQuantity: input.affectedQuantity, cost: input.cost, replacementProductionOrderId: input.replacementProductionOrderId, replacementEditorVersionId, replacementEditorVersionNumber })) });
      const milestone = ["submitted","received"].includes(input.kind) && source.order.status === "planned" ? "submitted"
        : input.kind === "accepted" && source.order.status === "submitted" ? "acknowledged"
        : input.kind === "rejected" && ["planned", "submitted", "acknowledged", "in_production"].includes(source.order.status) ? "failed" : null;
      const event:RecordProductionMilestoneInput={type:milestone!,expectedProjectionVersion:source.order.projectionVersion,
        externalEventId: `DELIVERY:${item.id}:${sequence + 1}`, occurredAt: input.occurredAt,
        evidence: { code: `DELIVERY_${input.kind.toUpperCase()}`, note: null, assetIds: [] } };
      if(milestone){if(factoryAssignmentId)await this.production.recordFactoryDeliveryMilestoneInTransaction(tx,context,factoryAssignmentId,event);else await this.production.recordMilestoneInTransaction(tx,context,source.order.id,event,true);}
      if(factoryAssignmentId&&!await this.factoryPrivateCurrent(tx,source))throw new ConflictException("制作资料已到期，本次工厂回执未提交");
      return { id: feedbackId, replayed: false };
  }

  private async prepare(context: TenantContext, source: Source): Promise<ProductionDeliverySnapshot> {
    const document = this.document(source)!;
    if (document.productType !== "shaped_pillow") throw new ConflictException("当前交付模块只处理异形抱枕");
    const render = await this.editor.getRender(context, source.project!.id, source.version.sourceRenderId!);
    const file = render.files.find(file => file.key === "result");
    if (render.purpose !== "production" || !render.preflight?.productionReady || render.versionId !== source.version.sourceEditorVersionId || !file || file.mediaType !== "image/jpeg") throw new ConflictException("需要已审核版本通过服务端检查的正式 JPG");
    if (file.byteSize > MAX_FILE_BYTES) throw new ConflictException("正式文件超过 50 MiB，请先检查尺寸或分开交付");
    const actual = await this.editor.renderFile(context, source.project!.id, render.id, file.key), bytes = Buffer.from(actual.body);
    try {
      const metadata = await sharp(bytes, { limitInputPixels: MAX_PRODUCTION_PIXELS }).metadata(), layout = getProductionLayout(document);
      if (bytes.length !== file.byteSize || bytes.length > MAX_FILE_BYTES || metadata.format !== "jpeg" || actual.mediaType !== "image/jpeg" || metadata.channels !== 3 || metadata.hasAlpha || metadata.density !== 150 || metadata.space !== "srgb" || !metadata.icc || metadata.chromaSubsampling !== "4:4:4" || metadata.width !== layout.widthPx || metadata.height !== layout.heightPx)
        throw new ConflictException("正式 JPG 的尺寸、150 DPI、RGB/sRGB 或色度采样检查未通过，请回制图中心修正");
      let ruleSnapshotChecksum: string | null = null, designRunId: string | null = null, designRunInputChecksum: string | null = null;
      await withTenant(this.database.db, context, async tx => {
        const [run] = await tx.select().from(orderDesignAgentRuns).where(and(eq(orderDesignAgentRuns.workItemId, source.work!.id), eq(orderDesignAgentRuns.workRevisionId, source.revision!.id)));
        if (run) {
          designRunId = run.id; designRunInputChecksum = run.inputChecksum;
          const pinned = this.withKey(source.work!.encryptedDataKey!, key => openWork<{ ruleSnapshot?: unknown }>(key, run.encryptedSnapshot)).ruleSnapshot;
          if (pinned) { const parsed = OrderRuleSnapshotSchema.parse(pinned); ruleSnapshotChecksum = sha(JSON.stringify(parsed)); }
        }
      });
      return ProductionDeliverySnapshotSchema.parse({ orderNumber: source.businessOrder.externalOrderId, orderLineId: source.order.orderLineId, quantity: source.version.quantity,
        skuCode: source.line.skuCode, productTitle: source.line.title,
        factory: source.factoryPin,
        instructions: this.vault.withSecret(source.version.encryptedInstructions, value => value), productionOrderId: source.order.id, productionVersionId: source.version.id,
        workRevisionId: source.revision!.id, workRevision: source.revision!.revision, editorProjectId: source.project!.id, editorVersionId: source.editorVersion!.id,
        editorVersionNumber: source.editorVersion!.versionNumber, renderId: render.id, templateVersionId: source.profile?.sourceVersionId ?? null,
        sourceVersionId: source.revision!.sourceVersionId, ruleSnapshotChecksum, ruleSnapshotStatus: ruleSnapshotChecksum ? "pinned" : "legacy_missing", designRunId, designRunInputChecksum,
        factoryStandardId: document.spec.factoryStandardId, sizeMm: document.spec.declaredLongestMm, sizeBasis: document.spec.sizeBasis, sideMode: document.spec.sideMode,
        minimumNeckMm: document.spec.minimumNeckMm, minimumNeckBasis: document.spec.minimumNeckBasis, expectedCompletionAt: source.version.expectedCompletionAt.toISOString(),
        file: { key: file.key, path: deliveryFilePath(source.work!.id, source.order.id, source.businessOrder.externalOrderId), checksum: sha(bytes), byteSize: bytes.length,
          width: metadata.width, height: metadata.height, dpi: 150, mediaType: "image/jpeg" }, manufacturing: source.manufacturing! });
    } finally { bytes.fill(0); }
  }

  private async source(tx: TenantTransaction, id: string) { return originalOwnerOperation(() => new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).source(tx, id)); }
  private retained(source: Source) { try { return new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).retained(source); } catch(error) { rethrowOriginalOwnerError(error); } }
  private document(source: Source) { try { return new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).document(source); } catch(error) { rethrowOriginalOwnerError(error); } }
  private blockers(source: Source, creating: boolean, pin?: ProductionDeliverySnapshot, purpose: "delivery" | "quantity" = "delivery"): string[] { try { return new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).blockers(source, creating, pin, purpose); } catch(error) { rethrowOriginalOwnerError(error); } }
  private assertSource(source: Source, selection?: ProductionDeliverySelection, creating = false, pin?: ProductionDeliverySnapshot) {
    if (selection && (selection.productionVersionId !== source.version.id || selection.expectedProjectionVersion !== source.order.projectionVersion)) throw new ConflictException("生产单已更新，请刷新后选择");
    const blockers = this.blockers(source, creating, pin);
    if (blockers.length) throw new ConflictException(blockers.join("；"));
  }
  private snapshot(source: Source, item: Item) { try { return new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).snapshot(source, item); } catch(error) { rethrowOriginalOwnerError(error); } }

  private async commandFence(tx: TenantTransaction, context: TenantContext,
    input: ReturnType<typeof CreateProductionDeliverySchema.parse>, fence?: OrderFulfillmentCommandFence, expectedOrderId?: string) {
    const sources = await tx.select({ orderId: productionOrders.orderId }).from(productionOrders)
      .where(inArray(productionOrders.id, input.items.map(item => item.productionOrderId)));
    const orderIds = [...new Set(sources.map(source => source.orderId))].sort();
    if (sources.length !== input.items.length || (fence || expectedOrderId) && (orderIds.length !== 1 || expectedOrderId !== orderIds[0]))
      throw new ConflictException("履约提交必须固定同一原订单的生产文件");
    // Legacy multi-order factory packets remain supported. Any managed target
    // sharing this native key still requires its exact fenced command.
    for (const targetId of orderIds) await assertOrderFulfillmentCommandFence(tx, context, { kind: "delivery_create", targetId, input }, fence);
  }
  private feedbackView(encryptedKey: string, event: Feedback,origin:"operator"|"factory"="operator") { try { return new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).feedbackView(encryptedKey, event, origin); } catch(error) { rethrowOriginalOwnerError(error); } }
  private async package(tx: TenantTransaction, id: string) { return originalOwnerOperation(() => new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).package(tx, id)); }
  private async replay(tx: TenantTransaction, key: string, requestChecksum: string, actor: string) {
    const [record] = await tx.select().from(packages).where(eq(packages.idempotencyKey, key));
    if (record && (record.requestChecksum !== requestChecksum || record.createdBy !== actor)) throw new ConflictException("同一次创建交付包的重试内容或操作员不能改变");
    return record?.id;
  }
  private async lockSources(tx: TenantTransaction, pins: ProductionDeliverySnapshot[]) {
    for (const id of [...new Set(pins.map(pin => pin.orderLineId))].sort()) await this.lock(tx, `order-work:${id}`);
    for (const id of [...new Set(pins.map(pin => pin.productionOrderId))].sort()) await this.lock(tx, `production-order:${id}`);
    await this.factories.lockPins(tx, pins.flatMap(pin => pin.factory ? [pin.factory] : []));
    await tx.select({ id: productionEditorProjects.id }).from(productionEditorProjects).where(inArray(productionEditorProjects.id, [...new Set(pins.map(pin => pin.editorProjectId))].sort())).orderBy(asc(productionEditorProjects.id)).for("update");
  }
  private async lock(tx: TenantTransaction, name: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`); }
  private withKey<T>(encrypted: string, use: (key: Buffer) => T): T { try { return new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).withKey(encrypted, use); } catch(error) { rethrowOriginalOwnerError(error); } }
  private readAccess(context: TenantContext) { try { return new ProductionDeliveryReadOwner(this.database,this.vault,this.factories).readAccess(context); } catch(error) { rethrowOriginalOwnerError(error); } }
  private writeAccess(context: TenantContext) { this.readAccess(context); authorize(context, Permission.OrderWrite); }
}
type Source = Awaited<ReturnType<OrderProductionDeliveryService["source"]>>;

export function deliveryFilePath(workId: string, productionId: string, orderNumber: string) {
  const name = orderNumber.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "order";
  return `orders/${workId}/${productionId}/${name}.jpg`;
}
function deliveryManifest(id: string, supplierId: string, supplierName: string, createdAt: Date, entries: ProductionDeliverySnapshot[], schemaVersion: number) { try { return sharedProductionDeliveryManifest(id, supplierId, supplierName, createdAt, entries, schemaVersion); } catch(error) { rethrowOriginalOwnerError(error); } }
function manifestChecksum(manifest: unknown, schemaVersion: number) { try { return sharedProductionDeliveryManifestChecksum(manifest, schemaVersion); } catch(error) { rethrowOriginalOwnerError(error); } }
