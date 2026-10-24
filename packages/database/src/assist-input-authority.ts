import { createHash } from "node:crypto";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  AssistInputAuthoritySchema,
  type AssistInputAuthority,
  type CreateAssist,
} from "@yummyai/contracts/ai/assist";
import type { TenantContext } from "@yummyai/contracts";
import type { TenantTransaction } from "./tenant-transaction.js";
import * as s from "./schema/index.js";

/** Source metadata only. Call under withTenant and current owner authorization. No business writes or calculations. */
export class AssistInputChangedError extends Error {
  constructor(readonly resources: string[]) {
    super("assist_source_changed");
    this.name = "AssistInputChangedError";
  }
}
export function assistAuthorityResourceLabel(key: string) {
  const labels: Record<string, string> = {
    order: "订单及定制资料",
    editor: "当前制作稿及素材",
    research: "研究来源",
    project: "创意项目",
    specification: "产品规格",
    listing: "Listing 及制作版本",
    template: "模板源文件",
    plan: "销售方案",
    inventory: "库存与采购依据",
    finance: "财务及关联订单",
    after_sales: "售后依据",
    knowledge: "知识发布版与来源",
    conversation: "历史对话依据",
  };
  return labels[key.split(".")[0]!] ?? "业务依据";
}
export function assertAssistInputAuthority(
  pinned: AssistInputAuthority,
  current: AssistInputAuthority,
  options: { admission?: boolean } = {},
) {
  const prior = AssistInputAuthoritySchema.parse(pinned),
    next = AssistInputAuthoritySchema.parse(current);
  const changed = [
    ...new Set([
      ...next.resources
        .filter(
          (r) =>
            (r.required && r.count === 0) ||
            ((!options.admission || !r.key.startsWith("knowledge.pinned.")) &&
              !prior.resources.some(
                (p) =>
                  p.key === r.key &&
                  p.checksum === r.checksum &&
                  p.count === r.count &&
                  p.required === r.required,
              )),
        )
        .map((r) => r.key),
      ...prior.resources
        .filter(
          (r) =>
            (!options.admission || !r.key.startsWith("knowledge.pinned.")) &&
            !next.resources.some((p) => p.key === r.key),
        )
        .map((r) => r.key),
    ]),
  ];
  if ((!options.admission && prior.fingerprint !== next.fingerprint) || changed.length)
    throw new AssistInputChangedError(changed.length ? changed : ["context"]);
}

export async function captureAssistInputAuthority(
  tx: TenantTransaction,
  context: TenantContext,
  request: CreateAssist,
  additional: AssistInputAuthority["resources"] = [],
): Promise<AssistInputAuthority> {
  const resources: AssistInputAuthority["resources"] = [...additional];
  async function stamp(key: string, query: SQL, required = false) {
    // A hard bound fails closed; a truncated projection must never approve execution.
    const [row] = await tx.execute<{ count: number; checksum: string }>(sql`
      WITH scoped AS (${query}), bounded AS (SELECT * FROM scoped LIMIT 10001)
      SELECT count(*)::int AS count,
        encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(bounded) ORDER BY to_jsonb(bounded)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS checksum
      FROM bounded`);
    if (!row || row.count > 10000) throw new Error("assist_authority_capacity_exceeded");
    resources.push({ key, required, count: row.count, checksum: row.checksum });
  }
  const plan = request.salesPlan?.id;
  if (plan) {
    await stamp(
      "plan.current",
      sql`SELECT * FROM ${s.salesPlans} WHERE ${s.salesPlans.id}=${plan}`,
      true,
    );
    await stamp(
      "plan.product",
      sql`SELECT * FROM ${s.spus} WHERE ${s.spus.id} IN (SELECT ${s.salesPlans.spuId} FROM ${s.salesPlans} WHERE ${s.salesPlans.id}=${plan})`,
      true,
    );
    await stamp(
      "plan.specifications",
      sql`SELECT row_to_json(p) AS specification,row_to_json(v) AS version FROM ${s.productSpecifications} p JOIN ${s.productSpecificationVersions} v ON v.specification_id=p.id AND v.version_number=p.version_number WHERE p.id IN (SELECT jsonb_array_elements_text(${s.salesPlans.fields}->'specificationIds')::uuid FROM ${s.salesPlans} WHERE ${s.salesPlans.id}=${plan})`,
    );
  }
  if (request.kind === "creative") {
    for (const [index, source] of request.sources.entries()) {
      const [study] =
        source.studyRevisionId === null
          ? []
          : await tx
              .select()
              .from(s.researchStudyRevisions)
              .where(
                and(
                  eq(s.researchStudyRevisions.researchItemId, source.researchItemId),
                  source.studyRevisionId
                    ? eq(s.researchStudyRevisions.id, source.studyRevisionId)
                    : undefined,
                ),
              )
              .orderBy(desc(s.researchStudyRevisions.version))
              .limit(1);
      const selected = source.snapshotId ?? study?.snapshotId;
      const [snapshot] = await tx
        .select({ id: s.captureSnapshots.id })
        .from(s.captureSnapshots)
        .where(
          and(
            eq(s.captureSnapshots.researchItemId, source.researchItemId),
            selected ? eq(s.captureSnapshots.id, selected) : undefined,
          ),
        )
        .orderBy(desc(s.captureSnapshots.capturedAt), desc(s.captureSnapshots.id))
        .limit(1);
      await stamp(
        `research.${index}.item`,
        sql`SELECT id,owner_user_id,platform,marketplace,normalized_url,archived_at FROM ${s.researchItems} WHERE ${s.researchItems.id}=${source.researchItemId}`,
        true,
      );
      await stamp(
        `research.${index}.snapshot`,
        sql`SELECT * FROM ${s.captureSnapshots} WHERE ${s.captureSnapshots.id}=${snapshot?.id ?? null}`,
        true,
      );
      await stamp(
        `research.${index}.study`,
        sql`SELECT * FROM ${s.researchStudyRevisions} WHERE ${s.researchStudyRevisions.id}=${study?.snapshotId === snapshot?.id ? (study?.id ?? null) : null}`,
      );
    }
    if (request.requirements.specificationVersionIds.length) {
      const ids = sql.join(
        request.requirements.specificationVersionIds.map((id) => sql`${id}`),
        sql`, `,
      );
      await stamp(
        "specification.selected",
        sql`SELECT row_to_json(v) AS version,row_to_json(p) AS specification,row_to_json(sp) AS product FROM ${s.productSpecificationVersions} v JOIN ${s.productSpecifications} p ON p.id=v.specification_id JOIN ${s.spus} sp ON sp.id=p.spu_id WHERE v.id IN (${ids})`,
        true,
      );
    }
    if (request.projectId) {
      await stamp(
        "project.current",
        sql`SELECT id,name,execution_mode,archived_at,canvas_workflow->'requirements' AS requirements,canvas_workflow->'researchReferences' AS research,canvas_workflow->>'analysisScopeId' AS scope FROM ${s.creativeDesignBatches} WHERE ${s.creativeDesignBatches.id}=${request.projectId}`,
        true,
      );
      await stamp(
        "project.prompt",
        sql`SELECT prompt FROM ${s.creativeDesignBatchItems} WHERE ${s.creativeDesignBatchItems.batchId}=${request.projectId} ORDER BY ordinal LIMIT 1`,
        true,
      );
    }
  } else if (request.kind === "order_review" || request.kind === "artwork_preflight") {
    await order(request.orderLineId);
  } else if (request.kind === "template_config") {
    await stamp(
      "template.inspection",
      sql`SELECT * FROM ${s.personalizationTemplateSourceInspections} WHERE ${s.personalizationTemplateSourceInspections.id}=${request.inspectionId}`,
      true,
    );
    await stamp(
      "template.asset",
      sql`SELECT * FROM ${s.assetFiles} WHERE ${s.assetFiles.id} IN (SELECT ${s.personalizationTemplateSourceInspections.sourceAssetId} FROM ${s.personalizationTemplateSourceInspections} WHERE ${s.personalizationTemplateSourceInspections.id}=${request.inspectionId})`,
      true,
    );
  } else if (request.kind === "sku_package") {
    const listing = request.listingId,
      version = request.expectedVersionId;
    const recipes = sql`SELECT DISTINCT ON (sku_id) * FROM ${s.salesRecipeVersions} WHERE sku_id IN (SELECT (v->>'skuId')::uuid FROM ${s.listingVersions},jsonb_array_elements(content->'variants') v WHERE id=${version}) ORDER BY sku_id,version_number DESC`;
    await stamp(
      "listing.current",
      sql`SELECT * FROM ${s.listings} WHERE ${s.listings.id}=${listing}`,
      true,
    );
    await stamp(
      "listing.version",
      sql`SELECT * FROM ${s.listingVersions} WHERE ${s.listingVersions.id}=${version} AND ${s.listingVersions.listingId}=${listing}`,
      true,
    );
    await stamp("listing.recipes", recipes, true);
    await stamp(
      "listing.skus",
      sql`WITH r AS (${recipes}) SELECT row_to_json(k) AS sku,row_to_json(d) AS definition FROM ${s.skus} k LEFT JOIN ${s.salesSkuDefinitions} d ON d.sku_id=k.id WHERE k.id IN (SELECT sku_id FROM r)`,
      true,
    );
    await stamp(
      "listing.specifications",
      sql`WITH r AS (${recipes}) SELECT row_to_json(v) AS version,row_to_json(p) AS specification,row_to_json(sp) AS product FROM ${s.productSpecificationVersions} v JOIN ${s.productSpecifications} p ON p.id=v.specification_id JOIN ${s.spus} sp ON sp.id=p.spu_id WHERE v.id IN (SELECT specification_version_id FROM r)`,
      true,
    );
    await stamp(
      "listing.artworks",
      sql`WITH r AS (${recipes}) SELECT row_to_json(v) AS version,row_to_json(m) AS master FROM ${s.artworkMasterVersions} v JOIN ${s.artworkMasters} m ON m.id=v.artwork_id WHERE v.id IN (SELECT artwork_version_id FROM r)`,
    );
    await stamp(
      "listing.artwork_assets",
      sql`WITH r AS (${recipes}) SELECT * FROM ${s.assetFiles} WHERE ${s.assetFiles.id} IN (SELECT ${s.artworkMasterVersions.assetId} FROM ${s.artworkMasterVersions} WHERE ${s.artworkMasterVersions.id} IN (SELECT artwork_version_id FROM r))`,
    );
    const images = sql`SELECT jsonb_array_elements_text(jsonb_build_array(content->>'mainImageId') || coalesce(content->'mediaAssetIds','[]'::jsonb))::uuid FROM ${s.listingVersions} WHERE id=${version}`;
    await stamp(
      "listing.images",
      sql`SELECT * FROM ${s.assetFiles} WHERE ${s.assetFiles.id} IN (${images})`,
    );
    await stamp(
      "listing.mockups",
      sql`SELECT row_to_json(o) AS output,row_to_json(i) AS item FROM ${s.mockupBatchOutputs} o JOIN ${s.mockupBatchItems} i ON i.id=o.item_id WHERE o.asset_id IN (${images})`,
    );
  } else if (request.kind === "procurement_review") {
    const stock = request.stockItemId,
      location = request.locationId;
    await stamp(
      "inventory.stock",
      sql`SELECT * FROM ${s.inventoryStockItems} WHERE ${s.inventoryStockItems.id}=${stock}`,
      true,
    );
    await stamp(
      "inventory.location",
      sql`SELECT * FROM ${s.inventoryLocations} WHERE ${s.inventoryLocations.id}=${location}`,
      true,
    );
    await stamp(
      "inventory.balances",
      sql`SELECT * FROM ${s.inventoryBalances} WHERE ${s.inventoryBalances.stockItemId}=${stock} AND ${s.inventoryBalances.locationId}=${location}`,
    );
    await stamp(
      "inventory.policy",
      sql`SELECT row_to_json(p) AS policy,row_to_json(v) AS version FROM ${s.inventoryReplenishmentPolicies} p JOIN ${s.inventoryReplenishmentPolicyVersions} v ON v.policy_id=p.id AND v.version_number=p.current_version WHERE p.stock_item_id=${stock} AND p.location_id=${location} AND p.status='active'`,
    );
    const purchases = sql`SELECT p.*,v.line_snapshot,v.expected_at,(v.expected_at<=clock_timestamp()) AS overdue FROM ${s.inventoryPurchaseOrders} p JOIN ${s.inventoryPurchaseOrderVersions} v ON v.purchase_order_id=p.id AND v.version_number=p.current_version WHERE p.status IN ('draft','approved','partially_received','reconciliation_required') AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.line_snapshot) l WHERE l->>'stockItemId'=${stock} AND l->>'destinationLocationId'=${location})`;
    await stamp("inventory.purchases", purchases);
    await stamp(
      "inventory.receipts",
      sql`WITH p AS (${purchases}) SELECT row_to_json(r) AS receipt,row_to_json(l) AS line FROM ${s.inventoryProcurementReceipts} r JOIN ${s.inventoryProcurementReceiptLines} l ON l.receipt_id=r.id WHERE r.purchase_order_id IN (SELECT id FROM p) AND l.stock_item_id=${stock} AND l.destination_location_id=${location}`,
    );
    await stamp(
      "inventory.quotes",
      sql`SELECT row_to_json(q) AS quote,row_to_json(r) AS rfq,row_to_json(v) AS request,s.id AS supplier_id,s.name AS supplier_name,s.status AS supplier_status,(q.valid_until>clock_timestamp()) AS usable_date FROM ${s.inventorySupplierQuoteVersions} q JOIN ${s.inventoryProcurementRfqs} r ON r.id=q.rfq_id JOIN ${s.inventoryProcurementRequisitionVersions} v ON v.id=r.requisition_version_id JOIN ${s.fulfillmentSuppliers} s ON s.id=q.supplier_id WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v.line_snapshot) l WHERE l->>'stockItemId'=${stock})`,
    );
  } else if (request.kind === "after_sales_review") {
    await afterSales(
      sql`SELECT ${s.afterSalesCases.id} FROM ${s.afterSalesCases} WHERE ${s.afterSalesCases.id}=${request.caseId}`,
    );
    await stamp(
      "after_sales.order",
      sql`SELECT o.* FROM ${s.orders} o JOIN ${s.afterSalesCases} c ON c.order_id=o.id WHERE c.id=${request.caseId}`,
      true,
    );
    await stamp(
      "after_sales.work",
      sql`SELECT w.id,w.report_line_id,w.source_version_id,w.revision,w.preparation,w.artwork,w.proof,w.held,w.archived_at,w.pushed_revision_id,w.editor_project_id,w.approved_editor_version_id,w.proof_editor_version_id,w.due_at,w.expires_at,w.expires_at>clock_timestamp() AS retained FROM ${s.orderWorkItems} w JOIN ${s.orderLines} l ON l.id=w.id JOIN ${s.afterSalesCases} c ON c.order_id=l.order_id WHERE c.id=${request.caseId}`,
    );
  } else if (request.kind === "business_review") {
    const ids = [request.runId, request.comparisonRunId].filter((v): v is string => !!v);
    const runs = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await stamp(
      "finance.runs",
      sql`SELECT * FROM ${s.financeProfitRuns} WHERE ${s.financeProfitRuns.id} IN (${runs})`,
      true,
    );
    await stamp(
      "finance.statements",
      sql`SELECT * FROM ${s.financeStatements} WHERE ${s.financeStatements.id} IN (SELECT jsonb_array_elements_text(${s.financeProfitRuns.statementIds})::uuid FROM ${s.financeProfitRuns} WHERE ${s.financeProfitRuns.id} IN (${runs}))`,
    );
    const orderIds = sql`SELECT f.order_id FROM ${s.financeProfitContributions} c JOIN ${s.financeFacts} f ON f.id=c.fact_id WHERE c.run_id IN (${runs}) AND f.order_id IS NOT NULL`;
    await stamp(
      "finance.order_workflow",
      sql`SELECT w.id,w.revision,w.preparation,w.artwork,w.proof,w.held,w.archived_at FROM ${s.orderWorkItems} w JOIN ${s.orderLines} l ON l.id=w.id WHERE l.order_id IN (${orderIds})`,
    );
    await stamp(
      "finance.production",
      sql`SELECT id,status FROM ${s.productionOrders} WHERE ${s.productionOrders.orderId} IN (${orderIds})`,
    );
    await stamp(
      "finance.after_sales",
      sql`SELECT id,type,reason_code,status,current_decision_version,updated_at FROM ${s.afterSalesCases} WHERE ${s.afterSalesCases.orderId} IN (${orderIds})`,
    );
  }
  if (request.kind === "knowledge_answer") {
    if (request.previousRunId)
      await stamp(
        "conversation.previous",
        sql`SELECT id,kind,scope,status,expires_at,expires_at>clock_timestamp() AS retained,encrypted_output IS NOT NULL AS has_output FROM ${s.aiAssistRuns} WHERE ${s.aiAssistRuns.id}=${request.previousRunId} AND ${s.aiAssistRuns.ownerId}=${context.userId}`,
        true,
      );
    if (request.evidenceStoreId) {
      await stamp(
        "knowledge.account",
        sql`SELECT id,platform,marketplace_ids,status,deleted_at FROM ${s.marketplaceAccounts} WHERE ${s.marketplaceAccounts.id}=${request.evidenceStoreId}`,
        true,
      );
    }
  }
  resources.sort((a, b) => a.key.localeCompare(b.key));
  return AssistInputAuthoritySchema.parse({
    version: "assist-input-authority-v1",
    capturedAt: new Date().toISOString(),
    resources,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          tenant: context.tenantId,
          actor: context.userId,
          kind: request.kind,
          resources,
        }),
      )
      .digest("hex"),
  });

  async function order(id: string) {
    // Revision zero is a valid unsaved order review; the canonical order remains mandatory.
    await stamp(
      "order.current",
      sql`SELECT id,report_line_id,source_version_id,revision,preparation,artwork,proof,held,archived_at,pushed_revision_id,editor_project_id,approved_editor_version_id,proof_editor_version_id,due_at,expires_at,expires_at>clock_timestamp() AS retained FROM ${s.orderWorkItems} WHERE ${s.orderWorkItems.id}=${id}`,
    );
    await stamp(
      "order.canonical",
      sql`SELECT row_to_json(l) AS line,row_to_json(o) AS order_state FROM ${s.orderLines} l JOIN ${s.orders} o ON o.id=l.order_id WHERE l.id=${id}`,
      true,
    );
    await stamp(
      "order.source",
      sql`SELECT id,state,current_version_id,version_number,expires_at,expires_at>clock_timestamp() AS retained,encrypted_source IS NOT NULL AS has_source FROM ${s.amazonOrderReportLines} WHERE ${s.amazonOrderReportLines.orderLineId}=${id}`,
    );
    await stamp(
      "order.revisions",
      sql`SELECT id,revision,source_version_id,checksum FROM ${s.orderWorkRevisions} WHERE ${s.orderWorkRevisions.workItemId}=${id}`,
    );
    await stamp(
      "editor.project",
      sql`SELECT *,expires_at>clock_timestamp() AS retained FROM ${s.productionEditorProjects} WHERE ${s.productionEditorProjects.sourceWorkItemId}=${id}`,
    );
    await stamp(
      "editor.versions",
      sql`SELECT id,project_id,version_number,checksum FROM ${s.productionEditorVersions} WHERE ${s.productionEditorVersions.projectId} IN (SELECT ${s.productionEditorProjects.id} FROM ${s.productionEditorProjects} WHERE ${s.productionEditorProjects.sourceWorkItemId}=${id})`,
    );
    await stamp(
      "editor.images",
      sql`SELECT id,project_id,checksum FROM ${s.productionEditorImages} WHERE ${s.productionEditorImages.projectId} IN (SELECT ${s.productionEditorProjects.id} FROM ${s.productionEditorProjects} WHERE ${s.productionEditorProjects.sourceWorkItemId}=${id})`,
    );
  }
  async function afterSales(ids: SQL) {
    await stamp(
      "after_sales.case",
      sql`SELECT * FROM ${s.afterSalesCases} WHERE ${s.afterSalesCases.id} IN (${ids})`,
      true,
    );
    await stamp(
      "after_sales.contacts",
      sql`SELECT id,direction,channel,occurred_at FROM ${s.customerContactRecords} WHERE ${s.customerContactRecords.caseId} IN (${ids})`,
    );
    await stamp(
      "after_sales.decisions",
      sql`SELECT * FROM ${s.afterSalesDecisions} WHERE ${s.afterSalesDecisions.caseId} IN (${ids})`,
    );
    await stamp(
      "after_sales.returns",
      sql`SELECT id,case_id,status,updated_at FROM ${s.returnShipments} WHERE ${s.returnShipments.caseId} IN (${ids})`,
    );
    await stamp(
      "after_sales.replacements",
      sql`SELECT * FROM ${s.replacementOrderLinks} WHERE ${s.replacementOrderLinks.caseId} IN (${ids})`,
    );
    await stamp(
      "after_sales.evidence",
      sql`SELECT id,case_id FROM ${s.afterSalesResponsibilityEvidence} WHERE ${s.afterSalesResponsibilityEvidence.caseId} IN (${ids})`,
    );
  }
}
