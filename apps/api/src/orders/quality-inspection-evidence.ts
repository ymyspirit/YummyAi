import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { physicalPackageEvidence } from "@yummyai/order-core";
import type { RecordQualityInspectionInput, TenantContext } from "@yummyai/contracts";
import { assetFiles, orders, orderWorkItems, qualityDefects, type qualityInspections, type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentAssetAuthority, requireAssetAuthority } from "../assets/asset-access.js";

export async function assertQualityOrderActive(tx: TenantTransaction, orderId: string, orderLineId: string, productionOrderId?: string, qualityGroupId?: string) {
  let parent, work;
  try {
    [parent] = await tx.select({ sideState: orders.sideState, workflowState: orders.workflowState, addressStatus: orders.addressStatus }).from(orders)
      .where(eq(orders.id, orderId)).for("share", { noWait: true });
    if (!parent || parent.sideState || parent.workflowState === "completed" || parent.addressStatus === "anonymized")
      throw new ConflictException("订单已暂停、取消或资料不可用 请核对当前订单或转售后处理");
    const [available] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${"order-work:" + orderLineId},0)) as locked`);
    if (!available?.locked) throw new ConflictException("本商品正在变更状态 请保留填写后重新核对");
    [work] = await tx.select({ held: orderWorkItems.held, archivedAt: orderWorkItems.archivedAt,
      retained: sql<boolean>`${orderWorkItems.encryptedDataKey} is not null and ${orderWorkItems.expiresAt}>clock_timestamp()` })
      .from(orderWorkItems).where(eq(orderWorkItems.id, orderLineId)).for("share", { noWait: true });
  } catch (error) {
    const code = error as { code?: string; cause?: { code?: string } };
    if (code.code === "55P03" || code.cause?.code === "55P03")
      throw new ConflictException("订单或商品正在执行其他操作 请保留填写后重新核对");
    throw error;
  }
  if (work && (work.held || work.archivedAt || !work.retained))
    throw new ConflictException("本商品已暂停、归档或资料到期 请先核对制作记录");
  const related = await tx.execute<{ id: string }>(sql`select distinct s.id from shipments s
    join shipment_versions sv on sv.shipment_id=s.id join shipment_package_lines pl on pl.shipment_version_id=sv.id
    where s.order_id=${orderId} and pl.order_line_id=${orderLineId} order by s.id`);
  for (const shipment of related) {
    const held = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${"shipment:" + shipment.id},0)) as locked`);
    if (!held[0]?.locked) throw new ConflictException("本商品正在处理发货 请保留填写后重新核对");
  }
  const dispatched = await tx.execute<{ dispatched: number; ordered: number | null }>(sql`select coalesce(sum(pl.quantity),0)::int as dispatched, max(ol.quantity)::int as ordered from shipments s
    join shipment_versions sv on sv.shipment_id=s.id join shipment_package_lines pl on pl.shipment_version_id=sv.id
    join order_lines ol on ol.id=pl.order_line_id
    where s.order_id=${orderId} and pl.order_line_id=${orderLineId} and ${physicalPackageEvidence(sql`pl.package_id`)}`);
  const quantity = dispatched[0];
  if (quantity?.ordered !== null && quantity?.ordered !== undefined && quantity.dispatched >= quantity.ordered)
    throw new ConflictException("本商品已全部实际交运 请保留原质检并转售后处理");
  if (productionOrderId) {
    const dispatchedLot = await tx.execute(sql`select 1 from shipment_production_allocations a
      where a.production_order_id=${productionOrderId} and (${qualityGroupId ?? null}::uuid is null or a.quality_group_id=${qualityGroupId ?? null}::uuid)
      and ${physicalPackageEvidence(sql`a.package_id`)} limit 1`);
    if (dispatchedLot.length) throw new ConflictException(qualityGroupId ? "该实物组已有实际交运 请保留原质检并转售后处理" : "该生产批次已有实际交运 请保留原质检并核对剩余实物或转售后处理");
    if (qualityGroupId) {
      const unspecified = await tx.execute(sql`select 1 from shipment_production_allocations a where a.production_order_id=${productionOrderId}
        and a.quality_group_id is null and ${physicalPackageEvidence(sql`a.package_id`)} limit 1`);
      if (unspecified.length) throw new ConflictException("原实际交运未固定实物组 请先核对在厂与交运实物");
    }
    const unknownLot = await tx.execute(sql`select 1 from shipment_package_lines pl join shipment_versions sv on sv.id=pl.shipment_version_id
      where pl.order_line_id=${orderLineId} and sv.production_source_version is null and ${physicalPackageEvidence(sql`pl.package_id`)} limit 1`);
    if (unknownLot.length) throw new ConflictException("本商品旧包裹未记录生产来源 请先核对已交运与仍在厂内的实物");
  }
}

export async function assertQualityEvidenceAssets(tx: TenantTransaction, context: TenantContext, input: Pick<RecordQualityInspectionInput, "evidenceAssetIds" | "defects" | "assessment">) {
  const unique = [...new Set([...input.evidenceAssetIds, ...input.defects.flatMap(defect => defect.evidenceAssetIds),
    ...(input.assessment?.criterionResults.flatMap(result => result.evidenceAssetIds) ?? [])])].sort();
  if (!unique.length) return;
  const authority = await currentAssetAuthority(tx, context, Permission.AssetRead);
  const files = await tx.select().from(assetFiles)
    .where(and(inArray(assetFiles.id, unique), isNull(assetFiles.deletedAt))).orderBy(asc(assetFiles.id)).for("share");
  if (files.length !== unique.length || files.some(file => file.assetDomain !== "authorized" || file.rightsStatus !== "approved"))
    throw new ConflictException("Production evidence must use tenant-owned authorized assets with approved rights");
  for (const file of files) requireAssetAuthority(authority, Permission.AssetRead, file);
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ids = (values: string[]) => [...values].sort();
const defects = (values: Array<{
  code: string; severity: string; responsibility: string; disposition: string; detailChecksum: string; evidenceAssetIds: string[];
}>) => values.map(value => ({
  code: value.code, severity: value.severity, responsibility: value.responsibility,
  disposition: value.disposition, detailChecksum: value.detailChecksum, evidenceAssetIds: ids(value.evidenceAssetIds),
})).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

export function inspectionRequestChecksum(context: TenantContext, input: RecordQualityInspectionInput) {
  return sha(JSON.stringify({
    actor: context.userId, qualityStandardVersionId: input.qualityStandardVersionId,
    result: input.result, scoreBps: input.scoreBps, inspectedAt: new Date(input.inspectedAt).toISOString(),
    evidenceAssetIds: ids(input.evidenceAssetIds),
    defects: defects(input.defects.map(defect => ({ ...defect, detailChecksum: sha(defect.note) }))),
    expectedProductionProjectionVersion: input.expectedProductionProjectionVersion ?? null,
    assessment: input.assessment ? {
      formatVersion: input.assessment.formatVersion,
      criterionResults: input.assessment.criterionResults.map(result => ({ ...result, evidenceAssetIds: ids(result.evidenceAssetIds) }))
        .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    } : null,
  }));
}

/** Original history can replay only its own payload; it is never upgraded by a retry. */
export async function assertInspectionReplay(
  tx: TenantTransaction,
  context: TenantContext,
  saved: typeof qualityInspections.$inferSelect,
  input: RecordQualityInspectionInput,
) {
  if (saved.requestChecksum) {
    if (saved.requestChecksum !== inspectionRequestChecksum(context, input))
      throw new ConflictException("同一次质检重试的内容或操作员不能改变");
    return;
  }
  const storedDefects = await tx.select().from(qualityDefects)
    .where(eq(qualityDefects.inspectionId, saved.id)).orderBy(asc(qualityDefects.id));
  if (input.assessment || input.expectedProductionProjectionVersion !== undefined ||
      saved.inspectedBy !== context.userId || saved.qualityStandardVersionId !== input.qualityStandardVersionId ||
      saved.result !== input.result || saved.scoreBps !== input.scoreBps ||
      saved.inspectedAt.getTime() !== new Date(input.inspectedAt).getTime() ||
      JSON.stringify(ids(saved.evidenceAssetIds)) !== JSON.stringify(ids(input.evidenceAssetIds)) ||
      JSON.stringify(defects(storedDefects)) !== JSON.stringify(defects(input.defects.map(defect => ({
        ...defect, detailChecksum: sha(defect.note),
      })))))
    throw new ConflictException("历史质检回执只允许原内容重试 请使用新请求记录新的核验");
}
