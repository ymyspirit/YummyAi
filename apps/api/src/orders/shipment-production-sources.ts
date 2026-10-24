import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { ShipmentPackageInput, ShipmentProductionSource } from "@yummyai/contracts/order/shipment";
import { ShipmentProductionSourceSchema, shipmentProductionSourceKey } from "@yummyai/contracts/order/shipment";
import { orders, orderLines, shipmentPackageLines, shipmentProductionAllocations, shipmentVersions, type TenantTransaction } from "@yummyai/database";
import { physicalPackageEvidence, qualityInspectionOrder, productionInspectedQuantity } from "@yummyai/order-core";
import { asc, eq, sql } from "drizzle-orm";
import { lockWholeOrderProduction } from "./whole-order-fulfillment.js";
import { readQualityGroupTree } from "./quality-groups.js";

/** Same order -> work -> production -> shipment order as whole-order fulfillment. */
export async function lockShipmentOrder(tx: TenantTransaction, orderId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id') || ':whole-order:' || ${orderId},0))`);
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  if (!order) throw new NotFoundException("订单不存在或无权访问");
  const lines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.id));
  for (const line of lines) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"order-work:" + line.id},0))`);
  await lockWholeOrderProduction(tx, orderId);
  return order;
}

export async function readShipmentProductionSources(tx: TenantTransaction, orderId: string, excludeShipmentId?: string, excludeVersionId?: string): Promise<ShipmentProductionSource[]> {
  const rows = await tx.execute<{
    orderLineId: string; productionOrderId: string; productionVersionId: string; versionNumber: number;
    projectionVersion: number; source: string; status: string; quantity: number; qualityInspectionId: string | null;
    inspectedAt: Date | string | null; qualityResult: string | null; assessmentVersion: number | null; inspectedVersionId: string | null;
    allocatedQuantity: number; replacement: boolean; unknownSource: boolean;
  }>(sql`select p.order_line_id as "orderLineId",p.id as "productionOrderId",pv.id as "productionVersionId",
      pv.version_number as "versionNumber",p.projection_version as "projectionVersion",p.source,p.status,
      case when qi.id is null then pv.quantity else ${productionInspectedQuantity(sql`p.id`, sql`qi.created_at`)} end as quantity,
      qi.id as "qualityInspectionId",qi.inspected_at as "inspectedAt",qi.result as "qualityResult",
      qi.assessment_version as "assessmentVersion",qi.production_version_id as "inspectedVersionId",
      (select coalesce(sum(a.quantity),0)::int from shipment_production_allocations a
        join shipment_versions sv on sv.id=a.shipment_version_id join shipments s on s.id=sv.shipment_id
        where a.production_order_id=p.id and (
          ((${excludeShipmentId ?? null}::uuid is null or s.id<>${excludeShipmentId ?? null}::uuid) and s.status<>'cancelled' and sv.version_number=s.approved_version_number)
          or ((${excludeVersionId ?? null}::uuid is null or sv.id<>${excludeVersionId ?? null}::uuid) and ${physicalPackageEvidence(sql`a.package_id`)}))) as "allocatedQuantity",
      exists(select 1 from production_orders child where child.parent_production_order_id=p.id and child.status<>'cancelled') as replacement,
      exists(select 1 from shipment_package_lines pl join shipment_versions sv on sv.id=pl.shipment_version_id join shipments s on s.id=sv.shipment_id
        where pl.order_line_id=p.order_line_id and sv.production_source_version is null
          and (((${excludeShipmentId ?? null}::uuid is null or s.id<>${excludeShipmentId ?? null}::uuid) and s.status<>'cancelled' and sv.version_number=s.approved_version_number)
            or ((${excludeVersionId ?? null}::uuid is null or sv.id<>${excludeVersionId ?? null}::uuid) and ${physicalPackageEvidence(sql`pl.package_id`)}))) as "unknownSource"
    from production_orders p join production_order_versions pv on pv.production_order_id=p.id and pv.version_number=p.current_version_number
    left join lateral (select q.* from quality_inspections q where q.production_order_id=p.id
      and not exists(select 1 from quality_group_reinspections r where r.inspection_id=q.id and r.tenant_id=q.tenant_id)
      order by ${qualityInspectionOrder()} limit 1) qi on true
    where p.order_id=${orderId} order by p.order_line_id,p.created_at,p.id`);
  const result: ShipmentProductionSource[] = [];
  for (const row of rows) {
    if (row.assessmentVersion === 3) {
      const groups = (await readQualityGroupTree(tx, row.productionOrderId)).filter(group => group.active);
      const occupied = await tx.execute<{ groupId: string; quantity: number }>(sql`select a.quality_group_id as "groupId",coalesce(sum(a.quantity),0)::int as quantity
        from shipment_production_allocations a join shipment_versions sv on sv.id=a.shipment_version_id join shipments s on s.id=sv.shipment_id
        where a.production_order_id=${row.productionOrderId} and a.quality_group_id is not null and (
          ((${excludeShipmentId ?? null}::uuid is null or s.id<>${excludeShipmentId ?? null}::uuid) and s.status<>'cancelled' and sv.version_number=s.approved_version_number)
          or ((${excludeVersionId ?? null}::uuid is null or sv.id<>${excludeVersionId ?? null}::uuid) and ${physicalPackageEvidence(sql`a.package_id`)})) group by a.quality_group_id`);
      const unknown = await tx.execute(sql`select 1 from shipment_production_allocations a join shipment_versions sv on sv.id=a.shipment_version_id join shipments s on s.id=sv.shipment_id
        where a.production_order_id=${row.productionOrderId} and a.quality_group_id is null and (
          ((${excludeShipmentId ?? null}::uuid is null or s.id<>${excludeShipmentId ?? null}::uuid) and s.status<>'cancelled' and sv.version_number=s.approved_version_number)
          or ((${excludeVersionId ?? null}::uuid is null or sv.id<>${excludeVersionId ?? null}::uuid) and ${physicalPackageEvidence(sql`a.package_id`)})) limit 1`);
      const legacyReplacement = await tx.execute(sql`select 1 from production_orders child where child.parent_production_order_id=${row.productionOrderId} and child.status<>'cancelled'
        and not exists(select 1 from production_recovery_groups rg where rg.replacement_production_order_id=child.id and rg.tenant_id=child.tenant_id) limit 1`);
      for (const group of groups) {
        const blockers: string[] = [];
        if (!["completed", "quality_hold"].includes(row.status)) blockers.push("原生产批次尚未完工或已停止");
        if (group.result !== "passed") blockers.push("该实物组尚未通过当前逐项检验");
        if (group.remakeQuantity || legacyReplacement.length) blockers.push("原实物组或未分组批次已有补做占用 请核对补做来源");
        if (row.unknownSource || unknown.length) blockers.push("原包裹未固定实物组 请先核对原发货来源");
        const allocatedQuantity = occupied.find(item => item.groupId === group.id)?.quantity ?? 0;
        result.push(ShipmentProductionSourceSchema.parse({ orderLineId: row.orderLineId, productionOrderId: row.productionOrderId,
          productionVersionId: row.productionVersionId, versionNumber: row.versionNumber, projectionVersion: group.productionProjectionVersion,
          source: row.source, status: row.status, quantity: group.quantity, qualityGroupId: group.id, groupLabel: group.label,
          qualityInspectionId: group.inspectionId, inspectedAt: group.inspectedAt, allocatedQuantity,
          availableQuantity: blockers.length ? 0 : Math.max(0, group.quantity - allocatedQuantity), blockers }));
      }
      continue;
    }
    const blockers: string[] = [];
    if (row.status !== "completed") blockers.push("该生产批次尚未完工或正处于质检异常");
    if (row.qualityResult !== "passed") blockers.push("该生产批次尚无当前通过质检");
    if (row.qualityInspectionId && (row.assessmentVersion !== 2 || row.inspectedVersionId !== row.productionVersionId))
      blockers.push("原质检未固定当前生产版本 请按原实物重新逐项检验");
    if (row.replacement) blockers.push("原批次已有补做安排 请核对补做批次");
    if (row.unknownSource) blockers.push("本商品有已审核或已交运的旧包裹未记录生产来源 请先核对原包裹");
    result.push(ShipmentProductionSourceSchema.parse({
      orderLineId: row.orderLineId, productionOrderId: row.productionOrderId, productionVersionId: row.productionVersionId,
      versionNumber: row.versionNumber, projectionVersion: row.projectionVersion, source: row.source, status: row.status, quantity: row.quantity,
      qualityInspectionId: row.qualityInspectionId, inspectedAt: row.inspectedAt === null ? null : new Date(row.inspectedAt).toISOString(),
      allocatedQuantity: row.allocatedQuantity, availableQuantity: blockers.length ? 0 : Math.max(0, row.quantity - row.allocatedQuantity), blockers,
    }));
  }
  return result;
}

export async function assertShipmentProductionSources(
  tx: TenantTransaction, orderId: string, packages: Array<{ lines: ShipmentPackageInput["lines"] }>,
  excludeShipmentId?: string, reserve = false, excludeVersionId?: string,
) {
  const [order] = await tx.select({ sideState: orders.sideState, addressStatus: orders.addressStatus }).from(orders).where(eq(orders.id, orderId));
  if (!order || order.sideState || order.addressStatus === "anonymized") throw new ConflictException("订单已暂停、作废或资料不可用 请保留填写后重新核对");
  const held = await tx.execute(sql`select 1 from order_work_items w join order_lines ol on ol.id=w.id where ol.order_id=${orderId}
    and w.id in (${sql.join(packages.flatMap(pkg => pkg.lines).map(line => sql`${line.orderLineId}::uuid`), sql`,`)})
    and (w.held or w.archived_at is not null or w.encrypted_data_key is null or w.expires_at<=now()) limit 1`);
  if (held.length) throw new ConflictException("装箱商品已暂停、归档或资料不可用 请核对原商品");
  const sources = new Map((await readShipmentProductionSources(tx, orderId, excludeShipmentId, excludeVersionId)).map(row => [shipmentProductionSourceKey(row), row]));
  const totals = new Map<string, number>();
  for (const pkg of packages) for (const line of pkg.lines) {
    if (!line.productionAllocations?.length) throw new UnprocessableEntityException("请核对并明确分配每件商品的生产批次、生产版本与通过质检");
    if (line.productionAllocations.reduce((sum, source) => sum + source.quantity, 0) !== line.quantity)
      throw new UnprocessableEntityException("生产来源分配总数必须等于装箱数量");
    for (const allocation of line.productionAllocations) {
      const sourceKey = shipmentProductionSourceKey(allocation);
      const source = sources.get(sourceKey);
      if (!source || source.orderLineId !== line.orderLineId) throw new UnprocessableEntityException("生产来源不属于该订单商品或无权访问");
      if (source.productionVersionId !== allocation.productionVersionId || source.qualityInspectionId !== allocation.qualityInspectionId
        || source.projectionVersion !== allocation.expectedProductionProjectionVersion)
        throw new ConflictException("生产来源或质检已变化 请保留填写并重新核对原批次");
      if (source.blockers.length) throw new ConflictException(source.blockers.join("；"));
      totals.set(sourceKey, (totals.get(sourceKey) ?? 0) + allocation.quantity);
    }
  }
  for (const [id, quantity] of totals) {
    const source = sources.get(id)!;
    if (quantity > (reserve ? source.availableQuantity : source.quantity))
      throw new ConflictException(reserve ? "生产批次的可发数量已被其他已审核或实际交运包裹占用 请保留填写并重新分配" : "来源分配超过该生产批次的数量");
  }
}

export async function assertStoredShipmentProductionSources(tx: TenantTransaction, orderId: string, shipmentId: string, versionId: string) {
  const [version] = await tx.select().from(shipmentVersions).where(eq(shipmentVersions.id, versionId));
  if (![1, 2].includes(version?.productionSourceVersion ?? 0)) throw new ConflictException("旧发货版本未记录生产来源 请建立新版本并核对实际批次后再审核或出库");
  const lines = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, versionId));
  const allocations = await tx.select().from(shipmentProductionAllocations).where(eq(shipmentProductionAllocations.shipmentVersionId, versionId));
  await assertShipmentProductionSources(tx, orderId, [{ lines: lines.map(line => ({ orderLineId: line.orderLineId, quantity: line.quantity,
    productionAllocations: allocations.filter(source => source.packageLineId === line.id).map(source => ({
      productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
      ...(source.qualityGroupId ? { qualityGroupId: source.qualityGroupId } : {}),
      expectedProductionProjectionVersion: source.productionProjectionVersion, quantity: source.quantity,
    })),
  })) }], shipmentId, true, versionId);
}
