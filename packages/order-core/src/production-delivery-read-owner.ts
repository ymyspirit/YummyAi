import { createHash } from "node:crypto";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { currentOrderAuthority } from "./order-authority.js";
import { factoryErpProgress } from "./factory-erp-projection.js";
import { factoryReceiptIds } from "./factory-task-receipt-read.js";
import { readManufacturingDelivery } from "./production-manufacturing-delivery.js";
import { authorize, ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { ProductionEditorDocumentSchema, SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";
import { ProductionDeliveryPackageViewSchema, ProductionDeliverySnapshotSchema, type ProductionDeliverySnapshot, type ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { FactoryDestinationSchema, type FactoryProductionPin } from "@yummyai/contracts/suppliers/factory-directory";
import { fulfillmentSuppliers, orderLines, orders, orderWorkItems, orderWorkRevisions, printProfileVersions, productionOrders, productionOrderVersions, productionEditorProjects, productionEditorVersions, productionEditorRenders, amazonOrderReportLines, productionDeliveryPackages as packages, productionDeliveryItems as items, productionDeliveryFeedback as feedback, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, eq } from "drizzle-orm";
import { openWork, type OrderReadVault } from "./order-private-payload.js";
import type { FactoryDirectoryReadPort } from "./factory-directory-read.js";
const sha=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
type Item=typeof items.$inferSelect;type Feedback=typeof feedback.$inferSelect;
type Source=Awaited<ReturnType<ProductionDeliveryReadOwner["source"]>>;
export class ProductionDeliveryReadOwner {
 constructor(private readonly database:DatabaseConnection,private readonly vault:OrderReadVault,private readonly factories:FactoryDirectoryReadPort){}
async get(context: TenantContext, id: string): Promise<ProductionDeliveryPackageView> {
    this.readAccess(context);
    return withTenant(this.database.db, context, async tx => {
      const factoryPermissions = [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead];
      const current = await currentOrderAuthority(tx, context, factoryPermissions);
      // The original package API also serves explicit non-membership adapters.
      // New private factory sources require a fresh member-scoped personal context.
      const canReadFactory = context.permissionScopes !== undefined &&
        factoryPermissions.every(permission => permissionScope(current, permission) === "tenant");
      const record = await this.package(tx, id);
      const rows = await tx.select().from(items).where(eq(items.packageId, id)).orderBy(asc(items.productionOrderId));
      const views = [];
      for (const item of rows) {
        const source = await this.source(tx, item.productionOrderId);
        const events = await tx.select().from(feedback).where(eq(feedback.itemId, item.id)).orderBy(asc(feedback.sequence));
        const retained = this.retained(source), snapshot = retained ? this.snapshot(source, item) : null;
        const blockers = snapshot ? this.blockers(source, false, snapshot) : ["订单资料已到期或清理"];
        const factoryIds=await factoryReceiptIds(tx,events.map(event=>event.id));
        const evidence = retained ? events.map(event => this.feedbackView(source.work!.encryptedDataKey!, event,factoryIds.has(event.id)?"factory":"operator")) : [];
        const last = [...events].reverse().find(event => event.kind !== "rework");
        views.push({ id: item.id, productionOrderId: item.productionOrderId, snapshot, blockers,
          status: last?.kind ?? "pending", sequence: events.at(-1)?.sequence ?? 0, feedback: evidence,
          factoryErp: retained && canReadFactory ? await factoryErpProgress(tx, this.vault, item.id) : null });
      }
      if (views.every(item => item.snapshot) && productionDeliveryManifestChecksum(productionDeliveryManifest(id, record.supplierId, record.supplierName, record.createdAt, views.map(item => item.snapshot!), record.schemaVersion), record.schemaVersion) !== record.checksum)
        throw new OriginalOwnerError(409, "交付清单校验失败，请保留记录并联系管理员");
      return ProductionDeliveryPackageViewSchema.parse({ id, supplierId: record.supplierId, supplierName: record.supplierName, checksum: record.checksum,
        schemaVersion: record.schemaVersion, factory: views[0]?.snapshot?.factory ? productionFactoryDestination(views[0].snapshot.factory) : null,
        createdAt: record.createdAt.toISOString(), canDownload: views.length > 0 && views.every(item => !item.blockers.length && item.status !== "rejected"), items: views });
    });
  }
async source(tx: TenantTransaction, id: string) {
    const [record] = await tx.select({ order: productionOrders, version: productionOrderVersions, supplier: fulfillmentSuppliers, businessOrder: orders, line: orderLines,
      work: orderWorkItems, revision: orderWorkRevisions, report: amazonOrderReportLines, profile: printProfileVersions, project: productionEditorProjects, editorVersion: productionEditorVersions, render: productionEditorRenders })
      .from(productionOrders).innerJoin(productionOrderVersions, and(eq(productionOrderVersions.productionOrderId, productionOrders.id), eq(productionOrderVersions.versionNumber, productionOrders.currentVersionNumber)))
      .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, productionOrders.supplierId)).innerJoin(orders, eq(orders.id, productionOrders.orderId))
      .innerJoin(orderLines, and(eq(orderLines.id, productionOrders.orderLineId), eq(orderLines.orderId, orders.id)))
      .leftJoin(orderWorkItems, eq(orderWorkItems.id, productionOrders.sourceWorkItemId))
      .leftJoin(amazonOrderReportLines, eq(amazonOrderReportLines.id, orderWorkItems.reportLineId))
      .leftJoin(orderWorkRevisions, and(eq(orderWorkRevisions.id, productionOrderVersions.sourceWorkRevisionId), eq(orderWorkRevisions.workItemId, orderWorkItems.id)))
      .leftJoin(printProfileVersions, eq(printProfileVersions.id, orderWorkRevisions.profileVersionId))
      .leftJoin(productionEditorProjects, eq(productionEditorProjects.id, productionOrderVersions.sourceEditorProjectId))
      .leftJoin(productionEditorVersions, and(eq(productionEditorVersions.id, productionOrderVersions.sourceEditorVersionId), eq(productionEditorVersions.projectId, productionEditorProjects.id)))
      .leftJoin(productionEditorRenders, and(eq(productionEditorRenders.id, productionOrderVersions.sourceRenderId), eq(productionEditorRenders.projectId, productionEditorProjects.id)))
      .where(eq(productionOrders.id, id));
    if (!record) throw new OriginalOwnerError(404, "生产单不存在");
    const factoryPin = record.version.factoryId && record.version.factoryVersionId && record.version.capabilityVersionId ? await this.factories.pinned(tx, record.version.factoryId, record.version.factoryVersionId, record.version.capabilityVersionId) : null;
    return { ...record, factoryPin, factoryBlockers: await this.factories.availability(tx, factoryPin), manufacturing: await readManufacturingDelivery(tx, record.version.id) };
  }
retained(source: Source) {
    return !!source.work?.encryptedDataKey && source.work.expiresAt > new Date() && source.businessOrder.addressStatus !== "anonymized";
  }
document(source: Source) {
    if (!this.retained(source) || !source.project?.encryptedDataKey || !source.editorVersion) return null;
    return this.withKey(source.project.encryptedDataKey, key => ProductionEditorDocumentSchema.parse(openWork(key, source.editorVersion!.encryptedDocument)));
  }
blockers(source: Source, creating: boolean, pin?: ProductionDeliverySnapshot, purpose: "delivery" | "quantity" = "delivery"): string[] {
    if (!this.retained(source)) return ["订单资料已到期或清理"];
    const result: string[] = [], { work, revision, project, editorVersion, render } = source;
    if (creating && !source.manufacturing) result.push("原生产未固定制造清单 请先补齐并审核新的生产来源 不补写旧单");
    if (pin?.manufacturing && canonicalJson(pin.manufacturing) !== canonicalJson(source.manufacturing)) result.push("制造依据与交付清单不同 请核对原版本");
    result.push(...source.factoryBlockers);
    if (source.version.factoryId !== source.order.factoryId) result.push("生产版本与工厂归属不一致");
    if (pin?.factory && (pin.factory.factoryId !== source.order.factoryId || pin.factory.factoryVersionId !== source.version.factoryVersionId || pin.factory.capabilityVersionId !== source.version.capabilityVersionId)) result.push("生产工厂与交付清单不同");
    if (work!.held || work!.archivedAt || source.businessOrder.sideState) result.push("订单已暂停、撤回或取消");
    if (source.supplier.status !== "active") result.push("工厂已停用");
    if (purpose === "quantity" ? source.order.status === "cancelled" : ["failed", "quality_hold", "cancel_requested", "cancelled"].includes(source.order.status) || creating && !["planned", "submitted", "acknowledged"].includes(source.order.status)) result.push("生产单状态不允许交付");
    if (!revision || !project || !editorVersion || !render || !project.encryptedDataKey || project.status !== "active" || project.expiresAt && project.expiresAt <= new Date()) return [...result, "正式文件或来源版本不完整"];
    if (work!.pushedRevisionId !== revision.id || work!.revision !== revision.revision || project.sourceWorkItemId !== work!.id || project.sourceWorkRevisionId !== revision.id || work!.editorProjectId !== project.id || work!.reportLineId && (!source.report || source.report.currentVersionId !== revision.sourceVersionId || source.report.expiresAt <= new Date())) result.push("审单或制图来源已改版或到期");
    if (work!.artwork !== "approved" || work!.approvedEditorVersionId !== editorVersion.id || project.reviewedVersionId !== editorVersion.id || project.currentVersionId !== editorVersion.id) result.push("当前图稿未审核，或已与交付版本不同");
    if (!["not_required", "approved"].includes(work!.proof) || work!.proof === "approved" && work!.proofEditorVersionId !== editorVersion.id) result.push("客户确认未完成或未绑定当前版本");
    if (render.status !== "completed" || render.versionId !== editorVersion.id) result.push("正式文件尚未完成");
    const document = this.document(source);
    if (document?.productType !== "shaped_pillow" || document.spec.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id || document.spec.minimumNeckBasis !== "cut_contour" || document.spec.minimumNeckMm < 50 || !document.spec.declaredLongestMm || document.spec.sizeBasis !== "artwork" || !Object.values(document.confirmations).every(Boolean)) result.push("异形抱枕的工艺、裁线最窄处或主体尺寸口径尚未确认");
    if (pin && (pin.productionVersionId !== source.version.id || pin.workRevisionId !== revision.id || pin.editorVersionId !== editorVersion.id || pin.renderId !== render.id || pin.quantity !== source.version.quantity || pin.expectedCompletionAt !== source.version.expectedCompletionAt.toISOString())) result.push("生产版本与交付清单不同");
    return result;
  }
snapshot(source: Source, item: Item) {
    const pin = this.withKey(source.work!.encryptedDataKey!, key => ProductionDeliverySnapshotSchema.parse(openWork(key, item.encryptedSnapshot)));
    if (pin.manufacturing ? item.manufacturingBindingId !== pin.manufacturing.bindingId || item.manufacturingContentChecksum !== pin.manufacturing.sourceContentChecksum ||
        item.manufacturingPlanChecksum !== pin.manufacturing.plan.checksum || pin.manufacturing.plan.quantity !== pin.quantity || pin.manufacturing.sourceWorkRevisionId !== pin.workRevisionId :
        item.manufacturingBindingId !== null || item.manufacturingContentChecksum !== null || item.manufacturingPlanChecksum !== null)
      throw new OriginalOwnerError(409, "制造交付索引校验失败");
    if (pin.productionOrderId !== item.productionOrderId || pin.orderLineId !== item.workItemId || pin.file.checksum !== item.fileChecksum || pin.file.byteSize !== item.byteSize || pin.productionVersionId !== item.productionVersionId || pin.editorProjectId !== item.editorProjectId || pin.editorVersionId !== item.editorVersionId || pin.renderId !== item.renderId || pin.workRevisionId !== item.workRevisionId) throw new OriginalOwnerError(409, "交付文件索引校验失败");
    return pin;
  }
feedbackView(encryptedKey: string, event: Feedback,origin:"operator"|"factory"="operator") {
    const evidence = this.withKey(encryptedKey, key => openWork<Record<string, unknown>>(key, event.encryptedEvidence));
    return { ...evidence,reference:evidence.reference,note:evidence.note,affectedQuantity:evidence.affectedQuantity??null,origin, id: event.id, sequence: event.sequence, kind: event.kind, occurredAt: event.occurredAt.toISOString(), recordedAt: event.recordedAt.toISOString(), recordedBy: event.recordedBy };
  }
async package(tx: TenantTransaction, id: string) {
    const [record] = await tx.select().from(packages).where(eq(packages.id, id));
    if (!record) throw new OriginalOwnerError(404, "交付包不存在"); return record;
  }
withKey<T>(encrypted: string, use: (key: Buffer) => T): T { return this.vault.withSecret(encrypted, value => { const key = Buffer.from(value, "base64"); try { return use(key); } finally { key.fill(0); } }); }
readAccess(context: TenantContext) { for (const permission of [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead]) authorize(context, permission); if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderRead, "outside_data_scope"); }
}
export function productionDeliveryManifest(id: string, supplierId: string, supplierName: string, createdAt: Date, entries: ProductionDeliverySnapshot[], schemaVersion: number) {
  if (schemaVersion === 1) return { schemaVersion: 1, id, supplier: { id: supplierId, name: supplierName }, createdAt: createdAt.toISOString(), items: entries.map(entry => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "factory"))) };
  return { schemaVersion, id, supplier: { id: supplierId, name: supplierName }, factory: productionFactoryDestination(entries[0]!.factory!), createdAt: createdAt.toISOString(), items: entries };
}
export function productionDeliveryManifestChecksum(manifest: unknown, schemaVersion: number) { return sha(schemaVersion === 3 ? canonicalJson(manifest) : JSON.stringify(manifest)); }
export function productionFactoryDestination(pin: FactoryProductionPin) {
  const { supplierId, supplierName, factoryId, factoryCode, factoryVersionId, factoryVersionNumber, factoryProfile } = pin;
  return FactoryDestinationSchema.parse({ supplierId, supplierName, factoryId, factoryCode, factoryVersionId, factoryVersionNumber, factoryProfile });
}
