import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createEntityId, type AmazonReportBatchView, type AmazonReportWorkspaceView, type ProductionEditorDetailView, type ProductionEditorImageView, type MarketplaceAccountView } from "@yummyai/contracts";
import type { OrderWorkDetail, PrintProfileView } from "@yummyai/contracts/order/workspace";
import type { ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { centerApi, createCenterSpu } from "./order-centers-fixture";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { syntheticProductionPng } from "./production-editor-fixture";
import { createFactoryFixture } from "./factory-directory-fixture";
import { syntheticSupplierProfile } from "../../../tools/testing/factory-fixtures";
import { createCapacityFixture } from "./factory-capacity-fixture";

export async function prepareWholePillows(lineCount = 3, quantityPerLine = 1) {
  if (!Number.isInteger(quantityPerLine) || quantityPerLine < 1 || quantityPerLine > 100_000) throw new Error("Invalid synthetic order quantity");
  const suffix = createEntityId().slice(-8), externalId = `E2E-WHOLE-${suffix}`, factoryName = `Synthetic delivery factory ${suffix}`;
  const supplier = await centerApi<{ id: string }>("sourcing/suppliers", { name: `Synthetic delivery supplier ${suffix}`, kind: "manual", regionCode: "CN", settlementCurrency: "CNY", profile: syntheticSupplierProfile });
  const factory = await createFactoryFixture(supplier.id, "shaped_pillow", factoryName);
  const capacity = await createCapacityFixture(factory.factory, [factory.capability], Math.max(10, lineCount * quantityPerLine * 4));
  const doc = createDefaultProductionDocument("shaped_pillow");
  if (doc.productType !== "shaped_pillow") throw new Error("Pillow fixture required");
  doc.spec = { ...doc.spec, widthMm: 1900 * 25.4 / 150, heightMm: 1900 * 25.4 / 150, declaredLongestMm: 254, sizeBasis: "artwork", minimumNeckBasis: "cut_contour", barcodeTab: { ...doc.spec.barcodeTab, centerXMm: 950 * 25.4 / 150 } };
  const edge = doc.spec.widthMm;
  doc.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: edge, yMm: 0, smooth: false }, { xMm: edge, yMm: edge, smooth: false }, { xMm: 0, yMm: edge, smooth: false }];
  doc.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
  let template = await centerApi<ProductionEditorDetailView>("production-editor/projects", { name: `Synthetic factory template ${suffix}`, document: doc });
  const asset = await centerApi<ProductionEditorImageView>(`production-editor/projects/${template.project.id}/images`, { name: "synthetic-art.png", contentBase64: syntheticProductionPng(2048).toString("base64") });
  doc.layers = [{ id: "synthetic-art", name: "Synthetic artwork", kind: "image", assetId: asset.id, assetVersion: 1, xMm: 200 * 25.4 / 150, yMm: 200 * 25.4 / 150, widthMm: 254, heightMm: 254, rotationDeg: 0, opacity: 1, visible: true, locked: true, flipX: false, flipY: false }];
  template = await centerApi(`production-editor/projects/${template.project.id}/versions`, { expectedVersionId: template.version.id, document: doc });
  await centerApi(`production-editor/projects/${template.project.id}/review`, { expectedVersionId: template.version.id });
  const profiles = await centerApi<PrintProfileView[]>("order-centers/profiles", { code: `DELIVERY-${suffix}`, name: doc.name, projectId: template.project.id, versionId: template.version.id, instructions: "Synthetic current factory standard", expectedVersion: 0, idempotencyKey: randomUUID() });
  const profile = profiles.find(row => row.projectId === template.project.id)!;
  const brief = await centerApi<{ id: string }>("canvas-bridge/briefs", { requestId: randomUUID(), name: `Whole original ${suffix}`, prompt: "Synthetic original artwork", referenceAssetIds: [] });
  const creative = await centerApi<{ versionId: string }>(`canvas-bridge/briefs/${brief.id}/results`, { submissionId: randomUUID(), protocolVersion: 1,
    pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, sourceNodeId: randomUUID(), title: `Whole original ${suffix}`,
    contentBase64: syntheticProductionPng(2048).toString("base64"), rightsAttested: true, sourceKind: "owned", sourceReference: "Synthetic whole-order fixture" });
  await centerApi(`pod/creative-design-versions/${creative.versionId}/review`, { decision: "approve" });
  const { artwork } = await centerApi<{ artwork: { versionId: string } }>("product-development/artworks", { code: `WHOLE-ART-${suffix}`, name: `Whole pillow art ${suffix}`,
    mode: "fixed", creativeVersionId: creative.versionId, expectedVersion: 0, idempotencyKey: randomUUID() });
  const spu = await createCenterSpu(`WHOLE-SPU-${suffix}`);
  const { specification } = await centerApi<{ specification: { id: string; versionId: string } }>("product-development/specifications", { spuId: spu.id, code: "PILLOW", name: "Synthetic 254 mm pillow",
    attributes: { size: "254 mm" }, facts: syntheticSpecificationFacts({ material: "Synthetic fabric", dimensions: "254 mm artwork longest side", packageContents: "One pillow", packageQuantity: 1, factsConfirmed: true }),
    processProfileVersionId: profile.versionId, expectedVersion: 0, idempotencyKey: randomUUID() });
  const stock = await centerApi<{ id: string }>("inventory/stock-items", { skuId: null, code: `WHOLE-FABRIC-${suffix}`.toUpperCase(), name: "Synthetic whole-order fabric", baseUnit: "meter" });
  const { data: manufacturing } = await centerApi<{ data: ManufacturingRecipeVersionView }>("manufacturing-recipes", {
    spuId: spu.id, specificationId: specification.id, code: `WHOLE-BOM-${suffix}`, idempotencyKey: randomUUID(),
    content: { specificationVersionId: specification.versionId, name: "Synthetic whole-order approved BOM", outputQuantity: 1, outputUnit: "each", notes: "Synthetic explicit manufacturing source only",
      materials: [{ code: "FABRIC", name: "Synthetic whole-order fabric", stockItemId: stock.id, quantityNumerator: 1, quantityDenominator: 2, unit: "meter", lossBps: 0, lossBasis: "add_to_net", responsibility: "merchant", operationCode: "MAKE" }],
      operations: [{ code: "MAKE", name: "Synthetic manufacture", processCode: "make", responsibility: "factory", expectedSecondsPerOutput: null }] },
  });
  await centerApi(`manufacturing-recipes/${manufacturing.recipeId}/reviews`, { expectedVersion: 1, versionId: manufacturing.versionId, decision: "approved", note: "Synthetic operator reviewed this exact whole-order material and process", idempotencyKey: randomUUID() });
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", { platform: "amazon", displayName: externalId, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] });
  const purchasedAt = new Date(Date.now() - 60_000).toISOString();
  const rows = Array.from({ length: lineCount }, (_, index) => `${externalId}\tITEM-${suffix}-${index}\t${purchasedAt}\tDELIVERY-${suffix}\tSynthetic pillow\t${quantityPerLine}\tUSD\t${(20 * quantityPerLine).toFixed(2)}`).join("\n");
  const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", { accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-delivery.txt", content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${rows}` });
  const workspace = await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?batchId=${batch.id}`), lines: string[] = [];
  let orderId = "";
  for (const row of workspace.lines) {
    const id = row.orderLineId; lines.push(id);
    let detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`); orderId = detail.line.orderId;
    detail = await centerApi(`order-centers/lines/${id}/draft`, { expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, expectedSourceVersionId: detail.report?.versionId ?? null, status: "ready_to_push", reason: "Synthetic operator reviewed manufacturing", idempotencyKey: randomUUID(),
      draft: { ...detail.draft, printProfileVersionId: profile.versionId, salesRecipeVersionId: null, salesPackageId: null, artworkVersionId: artwork.versionId, specificationVersionId: specification.versionId, designExecutor: "human", images: [], fields: [], instructions: "Synthetic print approved library artwork on shaped pillow" } });
    for (const action of ["push", "start_artwork"] as const) detail = await centerApi(`order-centers/lines/${id}/actions`, { action, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, reason: "Synthetic operator starts manual artwork", idempotencyKey: randomUUID() });
    const project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${detail.line.editorProjectId}`), document = project.version.document;
    document.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
    const checked = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${project.project.id}/versions`, { expectedVersionId: project.version.id, document });
    for (const action of ["submit_artwork", "approve_artwork"] as const) detail = await centerApi(`order-centers/lines/${id}/actions`, { action, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: checked.version.id, reason: "Synthetic operator reviewed fixture artwork", idempotencyKey: randomUUID() });
    await expect.poll(async () => { const result = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${project.project.id}`); const render = result.renders.find(render => render.versionId === checked.version.id && render.purpose === "production" && render.status === "completed"); return !!render; }, { timeout: 60_000 }).toBe(true);
  }
  return { externalId, factoryName, factoryId: factory.factory.id, supplierId: supplier.id, lines, orderId, externalLines: workspace.lines.map(line => line.externalLineId), manufacturing, capacity, capacityPlan: capacity.capacityPlan };
}
