import type { OrderReadVault } from "./order-private-payload.js";
import { factoryErpBindingItems, factoryErpBindings, factoryErpImports, factoryErpObservations, orderWorkItems, orders, productionDeliveryItems, productionOrders, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, sql } from "drizzle-orm";
import { FactoryErpExportRowSchema, FactoryErpStatusViewSchema } from "@yummyai/contracts/order/factory-erp-import";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { assertFactoryErpProof, factoryErpExternalKey, factoryErpRowChecksum } from "./factory-erp-evidence.js";
import { FactoryErpVoidSummarySchema } from "@yummyai/contracts/order/factory-erp-void-review";
import { factoryErpVoidSummarySql } from "./factory-erp-void-read.js";

type ObservationEvidence = Pick<typeof factoryErpObservations.$inferSelect, "id" | "bindingId" | "importId" | "rowNumber" | "rowChecksum" | "rawStatus" | "encryptedPayload"> & { createdAt: string };
type SourceEvidence = Pick<typeof factoryErpImports.$inferSelect, "id" | "tenantId" | "factoryId" | "fileChecksum" | "previewChecksum" | "sourceClaims" | "sourceProof">;
const observationEvidence = (kind: "status" | "void") => sql<ObservationEvidence>`jsonb_build_object('id',${factoryErpObservations.id},'bindingId',${factoryErpObservations.bindingId},
  'importId',${factoryErpObservations.importId},'rowNumber',${factoryErpObservations.rowNumber},'rowChecksum',${factoryErpObservations.rowChecksum},
  'rawStatus',${factoryErpObservations.rawStatus},'encryptedPayload',${factoryErpObservations.encryptedPayload},'createdAt',${factoryErpObservations.createdAt})`.as(kind === "status" ? "status_observation_evidence" : "void_observation_evidence");
const sourceEvidence = (kind: "status" | "void") => sql<SourceEvidence>`jsonb_build_object('id',${factoryErpImports.id},'tenantId',${factoryErpImports.tenantId},
  'factoryId',${factoryErpImports.factoryId},'fileChecksum',${factoryErpImports.fileChecksum},'previewChecksum',${factoryErpImports.previewChecksum},
  'sourceClaims',${factoryErpImports.sourceClaims},'sourceProof',${factoryErpImports.sourceProof})`.as(kind === "status" ? "status_source_evidence" : "void_source_evidence");

/** Call under current order/PII authority. Ordering is our observation sequence;
 * raw factory local dates never become UTC timestamps or ordering authority. */
export async function factoryErpProgress(tx: TenantTransaction, vault: OrderReadVault, deliveryItemId: string) {
  const statusSource = tx.select({ observation: observationEvidence("status"), source: sourceEvidence("status"),
    current: sql<boolean>`${factoryErpImports.expiresAt}>factory_erp_source_now() and ${factoryErpObservations.encryptedPayload} is not null`.as("status_source_current") })
    .from(factoryErpObservations).innerJoin(factoryErpImports, eq(factoryErpImports.id, factoryErpObservations.importId))
    .where(and(eq(factoryErpObservations.bindingId, factoryErpBindings.id), sql`${factoryErpObservations.rawStatus}<>'已作废'`))
    .orderBy(sql`case when ${factoryErpObservations.rawStatus}='已出库' then 1 else 0 end desc`, desc(factoryErpObservations.sequence)).limit(1).as("factory_erp_status_source");
  const voidSource = tx.select({ observation: observationEvidence("void"), source: sourceEvidence("void"),
    current: sql<boolean>`${factoryErpImports.expiresAt}>factory_erp_source_now() and ${factoryErpObservations.encryptedPayload} is not null`.as("void_source_current") })
    .from(factoryErpObservations).innerJoin(factoryErpImports, eq(factoryErpImports.id, factoryErpObservations.importId))
    .where(and(eq(factoryErpObservations.bindingId, factoryErpBindings.id), eq(factoryErpObservations.rawStatus, "已作废")))
    .orderBy(desc(factoryErpObservations.sequence)).limit(1).as("factory_erp_void_source");
  const [link] = await tx.select({ binding: factoryErpBindings,
    voidSummary: factoryErpVoidSummarySql(sql`${factoryErpBindings.tenantId}`, sql`${factoryErpBindings.id}`),
    statusObservation: { observation: statusSource.observation, source: statusSource.source, current: statusSource.current },
    voidObservation: { observation: voidSource.observation, source: voidSource.source, current: voidSource.current },
  }).from(factoryErpBindingItems)
    .innerJoin(factoryErpBindings, eq(factoryErpBindings.id, factoryErpBindingItems.bindingId))
    .innerJoin(productionDeliveryItems, eq(productionDeliveryItems.id, factoryErpBindingItems.deliveryItemId))
    .innerJoin(orderWorkItems, eq(orderWorkItems.id, productionDeliveryItems.workItemId))
    .innerJoin(productionOrders, eq(productionOrders.id, productionDeliveryItems.productionOrderId))
    .innerJoin(orders, eq(orders.id, productionOrders.orderId))
    .leftJoinLateral(statusSource, sql`true`).leftJoinLateral(voidSource, sql`true`)
    .where(and(eq(factoryErpBindingItems.deliveryItemId, deliveryItemId), sql`${orderWorkItems.encryptedDataKey} is not null`, sql`${orderWorkItems.expiresAt}>clock_timestamp()`, sql`${orders.addressStatus}<>'anonymized'`))
    .orderBy(sql`(${factoryErpBindings.releasedBy} is null and ${factoryErpBindingItems.releasedBy} is null) desc`, desc(factoryErpBindings.createdAt), desc(factoryErpBindings.id)).limit(1);
  if (!link) return null;
  const voidSummary = FactoryErpVoidSummarySchema.parse(link.voidSummary);
  const statusObservation = link.statusObservation?.observation?.id ? link.statusObservation : null;
  const voidObservation = link.voidObservation?.observation?.id ? link.voidObservation : null;
  const observation = statusObservation?.observation ?? voidObservation?.observation;
  if (!observation) return null;
  for (const evidence of [statusObservation, voidObservation]) {
    if (!evidence) continue;
    assertFactoryErpProof(vault, evidence.source);
    const claim = evidence.source.sourceClaims.find(c => c.rowNumber === evidence.observation.rowNumber);
    if (!claim || claim.rowChecksum !== evidence.observation.rowChecksum || claim.rawStatus !== evidence.observation.rawStatus ||
      claim.externalKey !== link.binding.externalKey || claim.quantity !== link.binding.quantity)
      throw new OriginalOwnerError(409, "工厂观察与原表来源不一致 请保留记录核对");
  }
  const current = (statusObservation ?? voidObservation)!.current;
  const row = current && observation.encryptedPayload !== null ? vault.withSecret(observation.encryptedPayload, value => FactoryErpExportRowSchema.parse(JSON.parse(value))) : null;
  if (row && (row.rowNumber !== observation.rowNumber || row.rawStatus !== observation.rawStatus || factoryErpRowChecksum(row) !== observation.rowChecksum ||
    factoryErpExternalKey(link.binding.tenantId, link.binding.factoryId, row.externalId) !== link.binding.externalKey || row.itemQuantity !== link.binding.quantity))
    throw new OriginalOwnerError(409, "工厂观察原值校验失败 请保留记录核对");
  const recordedStatus = statusObservation ? statusObservation.observation.rawStatus === "已出库" ? "shipped" : "scheduled" : null;
  const released = link.binding.releasedBy !== null;
  return FactoryErpStatusViewSchema.parse({ bindingId: link.binding.id, externalId: row?.externalId ?? "", bindingRevision: link.binding.revision,
    bindingReleased: released, bindingReleaseId: link.binding.releasedBy, historicalStatus: released ? recordedStatus : null,
    status: released ? null : recordedStatus,
    exception: !released && voidSummary.pending > 0 ? "voided_requires_review" : null, voidSummary,
    observationId: observation.id, importId: observation.importId,
    rawStatus: observation.rawStatus, updatedAtLocal: row?.updatedAtLocal ?? "", recordedAt: new Date(observation.createdAt).toISOString(),
    trackingReference: row?.trackingReference ?? "", carrier: row?.carrier ?? "", carrierService: row?.carrierService ?? "", shippedQuantity: null, privateSourceExpired: !current });
}
