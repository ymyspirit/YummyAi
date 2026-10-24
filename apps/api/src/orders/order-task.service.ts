import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { SecretVault } from "@yummyai/ai-core";
import type { DatabaseConnection } from "@yummyai/database";
import { OrderDesignRepository } from "@yummyai/order-design";
import { OrderTaskViewSchema, PrepareOrderTaskDeliverySchema, type BusinessTaskState } from "@yummyai/contracts/operations/business-task";
import type { ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { OrderDesignAgentViewSchema } from "@yummyai/contracts/order/design-agent";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderWholeDetailService } from "./order-whole-detail.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { LogisticsService } from "../logistics/logistics.service.js";
import { readOrderSection } from "./order-read-section.js";
import { aggregateTaskState, projectOrderTask } from "./order-task-projection.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Candidate = ProductionDeliveryWorkspace["candidates"][number];
type Group = { id: string; fingerprint: string; label: string; quantity: number; canPrepare: boolean; blockers: string[];
  package: { id: string; href: string } | null; candidates: Candidate[]; state: BusinessTaskState };

/** Existing services own business state and retries; this is a bounded coordinator. */
@Injectable()
export class OrderTaskService {
  private readonly design: OrderDesignRepository;
  constructor(
    @Inject(OrderWholeDetailService) private readonly whole: OrderWholeDetailService,
    @Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService,
    @Inject(LogisticsService) private readonly logistics: LogisticsService,
    @Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) vault: SecretVault,
  ) { this.design = new OrderDesignRepository(database, vault); }

  async get(context: TenantContext, lineId: string) {
    const { task, groups } = await this.inspect(context, lineId);
    return OrderTaskViewSchema.parse({ task, groups: groups.map(group => ({ id: group.id, fingerprint: group.fingerprint, label: group.label,
      quantity: group.quantity, canPrepare: group.canPrepare, blockers: group.blockers, package: group.package })) });
  }

  async prepareDelivery(context: TenantContext, lineId: string, raw: unknown) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.DesignRead); authorize(context, Permission.AssetRead);
    const input = PrepareOrderTaskDeliverySchema.parse(raw);
    const inspected = await this.inspect(context, lineId), group = inspected.groups.find(row => row.id === input.groupId);
    if (!group) throw new NotFoundException("本次工厂分组已变化，请重新读取原订单任务");
    if (group.fingerprint !== input.expectedFingerprint) throw new ConflictException("订单、排期或物流依据已变化，请重新核对任务");
    if (group.package && !group.blockers.length) return this.get(context, lineId);
    if (!group.canPrepare || group.blockers.length) throw new ConflictException("当前交付条件未满足，请按任务提示补齐资料");
    const first = group.candidates[0]!;
    // Same business request after refresh or lost response. Domain service owns persistence.
    const digest = hash({ domain: "order-task-delivery-v1", tenant: context.tenantId, group: group.id, basis: group.fingerprint });
    const key = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    await this.delivery.create(context, { factoryId: first.factoryId, supplierId: first.supplierId,
      items: group.candidates.map(row => ({ productionOrderId: row.productionOrderId, productionVersionId: row.productionVersionId, expectedProjectionVersion: row.projectionVersion })), idempotencyKey: key });
    return this.get(context, lineId);
  }

  private async inspect(context: TenantContext, lineId: string) {
    authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderRead);
    const whole = await this.whole.get(context, lineId), orderId = whole.orderId;
    const [delivery, logistics, design] = await Promise.all([
      readOrderSection(() => this.delivery.workspace(context, { order: orderId }), "工厂交付依据"),
      readOrderSection(async () => (await this.logistics.workspace(context, { orderId, limit: 100 })).tasks, "物流任务"),
      readOrderSection(async () => { const runs = []; for (const item of whole.items) runs.push(OrderDesignAgentViewSchema.parse(await this.design.view(context, item.line.id)).run); return runs; }, "制图执行记录"),
    ]);
    const blockedOrder = whole.items.some(item => item.line.held || item.line.archivedAt || item.line.sourceChanged || item.line.orderStatus === "voided");
    const groups: Group[] = [], plan = whole.fulfillment.data;
    const activeIds = new Set(plan?.items.flatMap(item => item.production ? [item.production.id] : []) ?? []);
    const packets = [...(delivery.data?.packages ?? [])], packetErrors: string[] = [];
    const pinnedPackages = new Set((whole.production.data ?? []).filter(row => activeIds.has(row.productionOrder.id)).flatMap(row => row.deliveryReceipt ? [row.deliveryReceipt.packageId] : []));
    for (const id of pinnedPackages) {
      if (packets.some(packet => packet.id === id)) continue;
      const packet = await readOrderSection(() => this.delivery.get(context, id), "当前生产任务的原交付包");
      if (packet.error) packetErrors.push(packet.error); else if (packet.data) packets.push(packet.data);
    }
    const candidates = (delivery.data?.candidates ?? []).filter(row => activeIds.has(row.productionOrderId));
    const byFactory = new Map<string, Candidate[]>();
    for (const candidate of candidates) { const key = hash([candidate.supplierId, candidate.factoryId, candidate.factoryVersionId]); byFactory.set(key, [...(byFactory.get(key) ?? []), candidate]); }
    let logisticsCovered = 0;
    for (const [id, rows] of byFactory) {
      rows.sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId));
      const blockers = [...packetErrors, ...rows.flatMap(row => row.blockers)];
      const logisticsPins: Array<{ productionVersionId: string; taskId: string; labels: Array<{ id: string; checksum: string }> }> = [];
      for (const candidate of rows) {
        const pin = await readOrderSection(() => this.logistics.deliveryForProduction(context, candidate.productionVersionId), "此商品的物流与面单依据");
        if (pin.error) blockers.push(pin.error);
        else if (!pin.data) blockers.push("本组商品尚未固定物流任务，请先确认包裹、交期与路线");
        else { logisticsCovered++; logisticsPins.push({ productionVersionId: candidate.productionVersionId, taskId: pin.data.taskId, labels: pin.data.labels.map(label => ({ id: label.id, checksum: label.checksum })).sort((a, b) => a.id.localeCompare(b.id)) }); }
      }
      if (blockedOrder) blockers.push("订单已暂停、归档、作废或来源变化");
      if (!plan || whole.production.error) blockers.push("生产依据暂不可用，请重新读取");
      if (logistics.error) blockers.push(logistics.error);
      if (plan?.items.some(item => !item.production)) blockers.push("本单仍有商品未固定生产排期，请先确认完整分工");
      if (delivery.data?.truncated || candidates.length !== activeIds.size) blockers.push("当前生产记录未完整覆盖，请到工厂交付页核对");
      if (rows.some(row => !row.factoryId || !row.factoryVersionId)) blockers.push("具体工厂与地址版本待确认");
      if (rows.some(row => row.parentProductionOrderId)) blockers.push("返工与部分数量交付需在原工厂交付页核对");
      if (rows.length > 50) blockers.push("本组超过单包商品上限，请在工厂交付页分包");
      const samePackage = packets.find(packet => packet.canDownload && packet.items.length === rows.length && rows.every(row => packet.items.some(item => {
        const pin = logisticsPins.find(pin => pin.productionVersionId === row.productionVersionId), sealed = item.snapshot?.logistics;
        return item.productionOrderId === row.productionOrderId && item.snapshot?.productionVersionId === row.productionVersionId && !item.blockers.length && !!pin && !!sealed && sealed.taskId === pin.taskId
          && hash(sealed.labels.map(label => ({ id: label.id, checksum: label.checksum })).sort((a, b) => a.id.localeCompare(b.id))) === hash(pin.labels);
      })));
      const rejected = packets.some(packet => rows.some(row => packet.items.some(item => item.productionOrderId === row.productionOrderId && item.snapshot?.productionVersionId === row.productionVersionId && item.status === "rejected")));
      if (rejected && !samePackage) blockers.push("本组存在拒收记录，请先核对返工或新生产版本");
      const fingerprint = hash({ orderId, work: whole.items.map(item => ({ id: item.line.id, revision: item.line.revision, editor: item.artwork.data?.versionId })).sort((a, b) => a.id.localeCompare(b.id)), rows: rows.map(row => ({ id: row.productionOrderId, version: row.productionVersionId, projection: row.projectionVersion, factory: row.factoryVersionId })), logisticsPins });
      const href = samePackage ? `/production?order=${orderId}&line=${lineId}&delivery=${samePackage.id}` : null;
      groups.push({ id, fingerprint, label: rows[0]!.factoryName ?? "工厂待确认", quantity: rows.reduce((sum, row) => sum + row.quantity, 0), blockers: [...new Set(blockers)], canPrepare: !blockers.length && !samePackage && context.permissions.includes(Permission.OrderWrite), package: samePackage && href ? { id: samePackage.id, href } : null, candidates: rows, state: blockers.length ? "blocked" : samePackage ? samePackage.items.every(item => item.status === "accepted") ? "done" : "waiting" : "pending" });
    }
    const deliveryState: BusinessTaskState = delivery.error ? "unavailable" : groups.length ? aggregateTaskState(groups.map(group => group.state)) : "pending";
    const task = projectOrderTask({ whole, design, logistics, delivery: { state: deliveryState, detail: delivery.error ?? (groups.length ? `${groups.length} 个工厂分组，${groups.filter(group => group.package).length} 组已有当前版本交付包` : "生产排期固定后按工厂准备交付文件"), href: groups.find(group => group.package)?.package?.href ?? `/production?order=${orderId}&line=${lineId}`, evidence: groups.map(group => ({ label: group.label, value: group.package ? `交付包 ${group.package.id.slice(-8)}` : `${group.quantity} 件 / 待准备` })) } });
    if (delivery.error) task.notices.push(delivery.error);
    if (plan && candidates.length !== activeIds.size) task.notices.push("当前快捷交付仅覆盖符合异形抱枕规范的生产任务，其他商品请按各自供应商规范在原业务页处理");
    if ((logistics.data?.length ?? 0) > 7) task.notices.push("费用区仅展示最近 7 个物流任务，请在物流页核对完整费用");
    if (delivery.data?.truncated || logistics.data?.length === 100) task.notices.push("部分历史超出本视图范围，请进入原业务页核对完整记录");
    const stage = task.stages.find(stage => stage.key === "logistics")!;
    if (!logistics.error && stage.state === "done" && (!activeIds.size || logisticsCovered < activeIds.size)) { stage.state = "pending"; stage.detail = "已有面单未覆盖当前全部生产版本，请按实际工厂补齐"; if (task.state === "done") task.state = "pending"; }
    for (const item of logistics.data ?? []) {
      task.metrics.push({ key: `logistics-${item.id}`, label: `${item.factoryName} 物流费用`, value: item.actualCostMinor !== null && item.actualCurrency ? `${(item.actualCostMinor / 10 ** item.minorUnitDigits).toFixed(item.minorUnitDigits)} ${item.actualCurrency}` : null, note: item.quotedCostMinor !== null && item.quotedCurrency ? `报价 ${(item.quotedCostMinor / 10 ** item.minorUnitDigits).toFixed(item.minorUnitDigits)} ${item.quotedCurrency}，实际费用以渠道回报为准` : "报价与实际费用分别记录" });
      if (task.metrics.length === 12) break;
    }
    return { task, groups };
  }
}
