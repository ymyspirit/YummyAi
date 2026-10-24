import { currentRootQualityInspection as sharedCurrentRootQualityInspection, readQualityGroupTree as sharedReadQualityGroupTree, qualityGroupWorkspace as sharedQualityGroupWorkspace } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { createHash } from "node:crypto";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { evaluateQualityGroups, type RecordQualityGroupsInput } from "@yummyai/contracts/order/quality-groups";
import { productionOrders, orderLineCatalogLinks, qualityInspections, qualityStandardVersions, qualityInspectionGroups, qualityDefects, qualityGroupDefects, qualityGroupReinspections, type TenantTransaction } from "@yummyai/database";
import { productionRemainingQuantity } from "@yummyai/order-core";
import { and, eq, sql } from "drizzle-orm";
import { assertQualityEvidenceAssets, assertQualityOrderActive } from "./quality-inspection-evidence.js";
import { readQualityScrapBasis } from "./quality-scrap-basis.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function groupInspectionChecksum(context: TenantContext, input: RecordQualityGroupsInput) {
  return sha(JSON.stringify({ actor: context.userId, input }));
}
export async function currentRootQualityInspection(tx: TenantTransaction, productionOrderId: string) { return originalOwnerOperation(() => sharedCurrentRootQualityInspection(tx, productionOrderId)); }

export async function readQualityGroupTree(tx: TenantTransaction, productionOrderId: string, vault?: SecretVault) { return originalOwnerOperation(() => sharedReadQualityGroupTree(tx, productionOrderId, vault)); }

export async function qualityGroupWorkspace(tx: TenantTransaction, productionOrderId: string, vault: SecretVault) { return originalOwnerOperation(() => sharedQualityGroupWorkspace(tx, productionOrderId, vault)); }

export async function assertRootQualityGroupingMutable(tx: TenantTransaction, productionOrderId: string) {
  const [production] = await tx.select({ tenantId: productionOrders.tenantId }).from(productionOrders).where(eq(productionOrders.id, productionOrderId));
  if (production) {
    const scrap = await readQualityScrapBasis(tx, production, productionOrderId);
    const [rootGroup] = scrap.rootInspectionId ? await tx.select({ id: qualityInspectionGroups.id }).from(qualityInspectionGroups)
      .where(and(eq(qualityInspectionGroups.tenantId, production.tenantId), eq(qualityInspectionGroups.productionOrderId, productionOrderId),
        eq(qualityInspectionGroups.inspectionId, scrap.rootInspectionId))).limit(1) : [];
    if (scrap.mappedScrappedQuantity > 0 || rootGroup && (scrap.actualScrappedQuantity ?? 0) > 0)
      throw new ConflictException({ code: "quality_scrap_root_locked", message: "原整批检验已有报废数量依据 请保留原实物组及其报废归属 不能重新划分整批" });
  }
  const rows = await tx.execute(sql`select 1 from production_recovery_groups rg join production_orders child on child.id=rg.replacement_production_order_id and child.tenant_id=rg.tenant_id
    where rg.production_order_id=${productionOrderId} and coalesce(${productionRemainingQuantity(sql`child.id`, sql`rg.replacement_production_version_id`)},rg.quantity)>0 limit 1`);
  if (rows.length) throw new ConflictException("原实物组已有补做安排 请核对原组与补做数量后再重检整批");
}

export async function recordQualityGroupInspection(tx: TenantTransaction, context: TenantContext, productionOrderId: string, input: RecordQualityGroupsInput, vault: SecretVault) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"production-order:" + productionOrderId},0))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"production-inspection:" + productionOrderId},0))`);
  const allAssets = [...input.evidenceAssetIds, ...input.groups.flatMap(group => [...group.criterionResults.flatMap(criterion => criterion.evidenceAssetIds), ...group.defects.flatMap(defect => defect.evidenceAssetIds)])];
  await assertQualityEvidenceAssets(tx, context, { evidenceAssetIds: allAssets, defects: [] });
  const [replay] = await tx.select().from(qualityInspections).where(and(eq(qualityInspections.productionOrderId, productionOrderId), eq(qualityInspections.idempotencyKey, input.idempotencyKey)));
  if (replay) {
    if (replay.assessmentVersion !== 3 || replay.inspectedBy !== context.userId || replay.requestChecksum !== groupInspectionChecksum(context, input))
      throw new ConflictException("同一次分组检验的内容或操作员不能改变");
    return { inspectionId: replay.id, orderId: "", failed: replay.result === "failed", replayed: true };
  }
  const workspace = await qualityGroupWorkspace(tx, productionOrderId, vault);
  if (workspace.blockers.length) throw new ConflictException(workspace.blockers.join("；"));
  if (workspace.productionVersionId !== input.productionVersionId || workspace.projectionVersion !== input.expectedProductionProjectionVersion || workspace.rootInspectionId !== input.expectedRootInspectionId)
    throw new ConflictException("原生产版本或检验依据已变化 请保留分组填写并重新核对");
  const [production] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId));
  const selected = input.parentGroupId ? workspace.groups.find(group => group.id === input.parentGroupId && group.active) : null;
  if (input.parentGroupId && !selected) throw new ConflictException("原实物组已被复检替代或不属于当前生产依据 请重新核对");
  if (selected?.quantityBlockers?.length)
    throw new ConflictException({ code: "production_quantity_scrap_group_unresolved", message: selected.quantityBlockers.join("；") });
  const expectedQuantity = selected ? selected.reinspectableQuantity ?? selected.quantity : workspace.quantity;
  if (expectedQuantity === 0)
    throw new ConflictException({ code: "quality_scrap_no_reinspectable_quantity", message: "当前没有可复检的未报废实物 请保留原组与报废凭证" });
  await assertQualityOrderActive(tx, production!.orderId, production!.orderLineId, productionOrderId, selected?.id);
  if (selected?.remakeQuantity) throw new ConflictException("该实物组已有补做数量占用 请先核对不用的补做单");
  if (!selected) {
    await assertRootQualityGroupingMutable(tx, productionOrderId);
    const replacements = await tx.execute(sql`select 1 from production_orders child where child.parent_production_order_id=${productionOrderId} and coalesce(${productionRemainingQuantity(sql`child.id`)},1)>0
      and not exists(select 1 from production_recovery_groups rg where rg.replacement_production_order_id=child.id and rg.tenant_id=child.tenant_id) limit 1`);
    if (replacements.length) throw new ConflictException("原生产批次已有未分组的补做安排 请先核对");
  }
  const [standard] = await tx.select().from(qualityStandardVersions).where(eq(qualityStandardVersions.id, input.qualityStandardVersionId));
  if (!standard) throw new NotFoundException("检验标准版本不存在");
  const [catalog] = await tx.select({ skuId: orderLineCatalogLinks.skuId }).from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, production!.orderLineId));
  if (standard.supplierId && standard.supplierId !== production!.supplierId || standard.skuId && standard.skuId !== catalog?.skuId)
    throw new UnprocessableEntityException("所选标准不适用于本次工厂或商品");
  const evaluation = evaluateQualityGroups(standard, input.groups, expectedQuantity);
  if (evaluation.problems.length || evaluation.scoreBps === null || evaluation.result === null)
    throw new UnprocessableEntityException(evaluation.problems.join("；") || "分组检验尚未完成");
  const clock = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
  const occurredAt = new Date(input.inspectedAt);
  if (occurredAt > new Date(clock[0]!.now)) throw new UnprocessableEntityException("检验时间不能晚于数据库当前时间");
  const root = await currentRootQualityInspection(tx, productionOrderId);
  const previousTime = selected ? new Date(selected.inspectedAt) : root ? new Date(root.inspectedAt) : null;
  if (previousTime && occurredAt < previousTime) throw new UnprocessableEntityException("新检验时间不能早于原组或原整批检验");
  const inspectionId = createEntityId();
  await tx.insert(qualityInspections).values({ id: inspectionId, tenantId: context.tenantId, productionOrderId, qualityStandardVersionId: standard.id,
    assessmentVersion: 3, criterionResults: null, result: evaluation.result, scoreBps: evaluation.scoreBps,
    productionVersionId: workspace.productionVersionId, productionProjectionVersion: workspace.projectionVersion, requestChecksum: groupInspectionChecksum(context, input),
    inspectedAt: occurredAt, inspectedBy: context.userId, idempotencyKey: input.idempotencyKey, evidenceAssetIds: input.evidenceAssetIds });
  for (const group of input.groups) {
    const assessed = evaluation.groups.find(result => result.key === group.key)!;
    const groupId = createEntityId();
    await tx.insert(qualityInspectionGroups).values({ id: groupId, tenantId: context.tenantId, productionOrderId, productionVersionId: workspace.productionVersionId,
      inspectionId, groupKey: group.key, label: group.label, quantity: group.quantity, segregationConfirmed: input.segregationConfirmed,
      result: assessed.result!, scoreBps: assessed.scoreBps!, criterionResults: group.criterionResults });
    for (const defect of group.defects) {
      const id = createEntityId();
      await tx.insert(qualityDefects).values({ id, tenantId: context.tenantId, productionOrderId, inspectionId, code: defect.code,
        severity: defect.severity, responsibility: defect.responsibility, disposition: defect.disposition,
        encryptedDetail: vault.encrypt(defect.note), detailChecksum: sha(defect.note), evidenceAssetIds: defect.evidenceAssetIds });
      await tx.insert(qualityGroupDefects).values({ defectId: id, tenantId: context.tenantId, qualityGroupId: groupId, productionOrderId, inspectionId, affectedQuantity: group.quantity });
    }
  }
  if (selected) await tx.insert(qualityGroupReinspections).values({ tenantId: context.tenantId, parentGroupId: selected.id, inspectionId, productionOrderId, productionVersionId: workspace.productionVersionId });
  const current = await readQualityGroupTree(tx, productionOrderId);
  await tx.update(productionOrders).set({ status: current.filter(group => group.active).every(group => group.result === "passed") ? "completed" : "quality_hold",
    projectionVersion: workspace.projectionVersion + 1, updatedAt: new Date() }).where(eq(productionOrders.id, productionOrderId));
  return { inspectionId, orderId: production!.orderId, failed: evaluation.result === "failed", replayed: false };
}
