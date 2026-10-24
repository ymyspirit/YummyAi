import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { QualityGroupsWorkspaceSchema, QualityPhysicalGroupViewSchema } from "@yummyai/contracts/order/quality-groups";
import { productionOrders, productionOrderVersions, orders, orderWorkItems, qualityDefects, qualityGroupDefects, productionQuantityReviews, type TenantTransaction } from "@yummyai/database";
import { physicalPackageEvidence } from "./work-query.js";
import { productionRemainingQuantity } from "./production-quantity.js";
import { qualityInspectionOrder } from "./quality-quantity.js";
import { readQualityScrapBasis } from "./quality-scrap-basis.js";
import type { OrderReadVault } from "./order-private-payload.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
const scrapGroupBlocker = "原报废数量未固定实物组 请先人工核对报废与当前实物组";
export async function currentRootQualityInspection(tx: TenantTransaction, productionOrderId: string) {
  const rows = await tx.execute<{ id: string; assessmentVersion: number | null; inspectedAt: Date; productionVersionId: string | null }>(sql`
    select q.id,q.assessment_version as "assessmentVersion",q.inspected_at as "inspectedAt",q.production_version_id as "productionVersionId"
    from quality_inspections q where q.production_order_id=${productionOrderId}
      and not exists(select 1 from quality_group_reinspections r where r.inspection_id=q.id and r.tenant_id=q.tenant_id)
    order by ${qualityInspectionOrder()} limit 1`);
  return rows[0] ?? null;
}
export async function readQualityGroupTree(tx: TenantTransaction, productionOrderId: string, vault?: OrderReadVault) {
  const root = await currentRootQualityInspection(tx, productionOrderId);
  const [production] = await tx.select({ tenantId: productionOrders.tenantId }).from(productionOrders).where(eq(productionOrders.id, productionOrderId));
  const scrapBasis = production ? await readQualityScrapBasis(tx, production, productionOrderId) : null;
  const rows = await tx.execute<{
    id: string; inspectionId: string; productionOrderId: string; productionVersionId: string; parentGroupId: string | null; rootInspectionId: string;
    key: string; label: string; quantity: number; result: string; scoreBps: number; criterionResults: unknown;
    qualityStandardVersionId: string; inspectedAt: Date | string; productionProjectionVersion: number; active: boolean;
    shippedQuantity: number; remakeQuantity: number;
  }>(sql`with recursive lineage as (
    select g.id,null::uuid as parent_id,g.inspection_id as root_id,array[g.id] as visited
      from quality_inspection_groups g where g.production_order_id=${productionOrderId}
        and not exists(select 1 from quality_group_reinspections r where r.inspection_id=g.inspection_id and r.tenant_id=g.tenant_id)
    union all select child.id,parent.id,parent.root_id,parent.visited||child.id from lineage parent
      join quality_group_reinspections r on r.parent_group_id=parent.id
      join quality_inspection_groups child on child.inspection_id=r.inspection_id and child.tenant_id=r.tenant_id
      where not child.id=any(parent.visited)
  ) select g.id,g.inspection_id as "inspectionId",g.production_order_id as "productionOrderId",g.production_version_id as "productionVersionId",
    l.parent_id as "parentGroupId",l.root_id as "rootInspectionId",g.group_key as key,g.label,g.quantity,g.result,g.score_bps as "scoreBps",
    g.criterion_results as "criterionResults",q.quality_standard_version_id as "qualityStandardVersionId",q.inspected_at as "inspectedAt",
    q.production_projection_version as "productionProjectionVersion",
    (l.root_id=${root?.id ?? null}::uuid and pv.version_number=p.current_version_number and not exists(select 1 from quality_group_reinspections r where r.parent_group_id=g.id and r.tenant_id=g.tenant_id)) as active,
    (select coalesce(sum(a.quantity),0)::int from shipment_production_allocations a where a.quality_group_id=g.id and a.tenant_id=g.tenant_id and ${physicalPackageEvidence(sql`a.package_id`)}) as "shippedQuantity",
    (select coalesce(sum(coalesce(${productionRemainingQuantity(sql`child.id`, sql`rg.replacement_production_version_id`)},rg.quantity)),0)::int
      from production_recovery_groups rg join production_orders child on child.id=rg.replacement_production_order_id and child.tenant_id=rg.tenant_id
      where rg.quality_group_id=g.id and rg.tenant_id=g.tenant_id) as "remakeQuantity"
    from lineage l join quality_inspection_groups g on g.id=l.id join quality_inspections q on q.id=g.inspection_id and q.tenant_id=g.tenant_id
      join production_orders p on p.id=g.production_order_id and p.tenant_id=g.tenant_id
      join production_order_versions pv on pv.id=g.production_version_id and pv.tenant_id=g.tenant_id order by q.created_at,g.created_at,g.id`);
  const ids = rows.map(row => row.id);
  const defects = ids.length ? await tx.select({ groupId: qualityGroupDefects.qualityGroupId, id: qualityDefects.id, code: qualityDefects.code,
    severity: qualityDefects.severity, responsibility: qualityDefects.responsibility, disposition: qualityDefects.disposition,
    encryptedDetail: qualityDefects.encryptedDetail, affectedQuantity: qualityGroupDefects.affectedQuantity }).from(qualityGroupDefects)
    .innerJoin(qualityDefects, and(eq(qualityDefects.id, qualityGroupDefects.defectId), eq(qualityDefects.tenantId, qualityGroupDefects.tenantId)))
    .where(inArray(qualityGroupDefects.qualityGroupId, ids)).orderBy(asc(qualityDefects.createdAt), asc(qualityDefects.id)) : [];
  const replacements = await tx.execute<{ groupId: string; recoveryId: string; productionOrderId: string; quantity: number; caseStatus: string; status: string; reserved: boolean }>(sql`
    select rg.quality_group_id as "groupId",rg.recovery_case_id as "recoveryId",rg.replacement_production_order_id as "productionOrderId",rg.quantity,
      recovery.status as "caseStatus",child.status,(coalesce(${productionRemainingQuantity(sql`child.id`, sql`rg.replacement_production_version_id`)},rg.quantity)>0) as reserved
    from production_recovery_groups rg join production_recovery_cases recovery on recovery.id=rg.recovery_case_id and recovery.tenant_id=rg.tenant_id
    join production_orders child on child.id=rg.replacement_production_order_id and child.tenant_id=rg.tenant_id
    where rg.production_order_id=${productionOrderId} order by recovery.opened_at,recovery.id`);
  const unresolvedScrap = !!scrapBasis && scrapBasis.unassignedGroupQuantity + scrapBasis.ambiguousQuantity > 0;
  return rows.map(row => {
    const scrap = scrapBasis?.groups.find(group => group.qualityGroupId === row.id);
    return QualityPhysicalGroupViewSchema.parse({ ...row, inspectedAt: new Date(row.inspectedAt).toISOString(),
      ...(scrap && scrapBasis ? { scrappedQuantity: scrap.scrappedQuantity, reinspectableQuantity: scrap.reinspectableQuantity,
        remakeEligible: scrap.remakeEligible, remainingScrapRemakeQuantity: scrap.remainingScrapRemakeQuantity,
        scrapBasisFingerprint: scrapBasis.fingerprint,
        quantityBlockers: (row.active || scrap.remakeEligible) && unresolvedScrap ? [scrapGroupBlocker] : [],
      } : { remakeEligible: false, reinspectableQuantity: 0, remainingScrapRemakeQuantity: 0 }),
      remainingRemakeQuantity: scrap?.remainingRemakeQuantity ?? Math.max(0, row.quantity - row.remakeQuantity),
      replacements: replacements.filter(replacement => replacement.groupId === row.id).map(replacement => ({ recoveryId: replacement.recoveryId,
        productionOrderId: replacement.productionOrderId, quantity: replacement.quantity, caseStatus: replacement.caseStatus, status: replacement.status, reserved: replacement.reserved })),
      defects: defects.filter(defect => defect.groupId === row.id).map(defect => ({ id: defect.id, code: defect.code, severity: defect.severity,
        responsibility: defect.responsibility, disposition: defect.disposition, affectedQuantity: defect.affectedQuantity,
        note: vault ? vault.withSecret(defect.encryptedDetail, value => value) : "" })),
    });
  });
}
export async function qualityGroupWorkspace(tx: TenantTransaction, productionOrderId: string, vault: OrderReadVault) {
  const [production] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId));
  if (!production) throw new OriginalOwnerError(404, "生产单不存在或无权访问");
  const [version] = await tx.select().from(productionOrderVersions).where(and(eq(productionOrderVersions.productionOrderId, production.id), eq(productionOrderVersions.versionNumber, production.currentVersionNumber)));
  if (!version) throw new OriginalOwnerError(409, "当前生产版本依据缺失");
  const [order] = await tx.select().from(orders).where(eq(orders.id, production.orderId));
  const [work] = await tx.select({ held: orderWorkItems.held, archivedAt: orderWorkItems.archivedAt,
    retained: sql<boolean>`${orderWorkItems.encryptedDataKey} is not null and ${orderWorkItems.expiresAt}>clock_timestamp()` })
    .from(orderWorkItems).where(eq(orderWorkItems.id, production.orderLineId));
  const blockers: string[] = [];
  if (!order || order.sideState || order.workflowState === "completed" || order.addressStatus === "anonymized") blockers.push("订单已停止、完成或资料不可用");
  if (work && (work.held || work.archivedAt || !work.retained)) blockers.push("原订单商品已暂停、归档或资料到期");
  if (production.sourceWorkItemId && production.sourceWorkItemId !== production.orderLineId) blockers.push("原生产制作来源与当前商品不一致 请核对历史记录");
  if (!["completed", "quality_hold"].includes(production.status)) blockers.push("生产尚未完成或已停止");
  const [quantityReview] = await tx.select({ quantities: productionQuantityReviews.quantities }).from(productionQuantityReviews)
    .where(and(eq(productionQuantityReviews.productionOrderId, production.id), eq(productionQuantityReviews.productionVersionId, version.id)))
    .orderBy(sql`${productionQuantityReviews.sequence} desc`).limit(1);
  const quantity = quantityReview ? quantityReview.quantities.completedQuantity : version.quantity;
  if (quantity === null) throw new OriginalOwnerError(409, "原数量核准缺少已完成实物数量 请核对原凭证");
  const root = await currentRootQualityInspection(tx, production.id);
  return QualityGroupsWorkspaceSchema.parse({ productionOrderId: production.id, orderId: production.orderId, productionVersionId: version.id,
    projectionVersion: production.projectionVersion, quantity, rootInspectionId: root?.id ?? null,
    groups: await readQualityGroupTree(tx, production.id, vault), blockers });
}
