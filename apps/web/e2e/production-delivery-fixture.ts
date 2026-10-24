import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createEntityId, type AmazonReportBatchView, type AmazonReportWorkspaceView, type ProductionEditorDetailView, type ProductionEditorImageView, type MarketplaceAccountView } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import type { OrderWorkDetail, PrintProfileView } from "@yummyai/contracts/order/workspace";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { centerApi, createCenterSpu } from "./order-centers-fixture";
import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures";
import type { SpecificationView } from "@yummyai/contracts/catalog/development";
import type { ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import { syntheticProductionPng } from "./production-editor-fixture";
import { createFactoryFixture } from "./factory-directory-fixture";
import { syntheticSupplierProfile, syntheticFactoryProfile } from "../../../tools/testing/factory-fixtures";
import { createCapacityFixture } from "./factory-capacity-fixture";
export async function prepareDeliveryOrder(lineCount = 1, splitFactories = false, options: { release?: boolean; materialResponsibility?: "merchant" | "factory" } = {}) {
  const suffix = createEntityId().slice(-8), externalId = `E2E-DELIVERY-${suffix}`, factoryName = `Synthetic delivery factory ${suffix}`;
  const supplier = await centerApi<{ id: string }>("sourcing/suppliers", { name: `Synthetic delivery supplier ${suffix}`, kind: "manual", regionCode: "CN", settlementCurrency: "CNY", profile: syntheticSupplierProfile });
  const factoryProfile = syntheticFactoryProfile(factoryName);
  factoryProfile.productionAddress!.postalCode = "000000";
  const factory = await createFactoryFixture(supplier.id, "shaped_pillow", factoryName, factoryProfile);
  const assignments = [factory];
  if (splitFactories && lineCount > 1) {
    const otherProfile = syntheticFactoryProfile(`${factoryName} second`); otherProfile.productionAddress!.postalCode = "000000";
    assignments.push(await createFactoryFixture(supplier.id, "shaped_pillow", `${factoryName} second`, otherProfile));
  }
  const capacities = new Map<string, Awaited<ReturnType<typeof createCapacityFixture>>>();
  for (const assigned of assignments) capacities.set(assigned.factory.id, await createCapacityFixture(assigned.factory, [assigned.capability], Math.max(10, lineCount * 8)));
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
  const spu = await createCenterSpu(`DELIVERY-SPU-${suffix}`);
  const { specification } = await centerApi<{ specification: SpecificationView }>("product-development/specifications", {
    spuId: spu.id, code: "DEFAULT", name: "Synthetic confirmed 254 mm pillow", attributes: {}, processProfileVersionId: profile.versionId,
    facts: syntheticSpecificationFacts({ physicalDimensions: { basis: "artwork_longest", unit: "mm", length: 254, width: null, height: null } }),
    expectedVersion: 0, idempotencyKey: randomUUID(),
  });
  const brief = await centerApi<{ id: string }>("canvas-bridge/briefs", { requestId: randomUUID(), name: `Synthetic delivery art ${suffix}`, prompt: "Synthetic owned reference bitmap", referenceAssetIds: [] });
  const creative = await centerApi<{ versionId: string }>(`canvas-bridge/briefs/${brief.id}/results`, {
    submissionId: randomUUID(), protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
    sourceNodeId: randomUUID(), title: "Synthetic owned delivery artwork", contentBase64: syntheticProductionPng(2048).toString("base64"),
    rightsAttested: true, sourceKind: "owned", sourceReference: "Synthetic E2E reference only",
  });
  await centerApi(`pod/creative-design-versions/${creative.versionId}/review`, { decision: "approve" });
  const { artwork } = await centerApi<{ artwork: { versionId: string } }>("product-development/artworks", {
    code: `DELIVERY-ART-${suffix}`, name: "Synthetic owned artwork assignment", mode: "fixed", creativeVersionId: creative.versionId, customization: { version: 1, fields: [] },
    layout: [], expectedVersion: 0, idempotencyKey: randomUUID(),
  });
  const stock = await centerApi<{ id: string }>("inventory/stock-items", { skuId: null, code: `DELIVERY-FABRIC-${suffix}`.toUpperCase(), name: "Synthetic factory fabric", baseUnit: "meter" });
  const { data: manufacturing } = await centerApi<{ data: ManufacturingRecipeVersionView }>("manufacturing-recipes", {
    spuId: spu.id, specificationId: specification.id, code: `DELIVERY-BOM-${suffix}`, idempotencyKey: randomUUID(),
    content: { specificationVersionId: specification.versionId, name: "Synthetic approved factory BOM", outputQuantity: 1, outputUnit: "each", notes: "Synthetic private BOM note not for factory",
      materials: [{ code: "FABRIC", name: "Synthetic factory fabric", stockItemId: stock.id, quantityNumerator: 1, quantityDenominator: 2, unit: "meter", lossBps: 0, lossBasis: "add_to_net", responsibility: options.materialResponsibility ?? "merchant", operationCode: "MAKE" }],
      operations: [{ code: "MAKE", name: "Synthetic manufacture", processCode: "make", responsibility: "factory", expectedSecondsPerOutput: null }] },
  });
  await centerApi(`manufacturing-recipes/${manufacturing.recipeId}/reviews`, { expectedVersion: 1, versionId: manufacturing.versionId, decision: "approved", note: "Synthetic operator reviewed exact material and process", idempotencyKey: randomUUID() });
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", { platform: "amazon", displayName: externalId, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] });
  const purchaseDate = new Date().toISOString();
  const rows = Array.from({ length: lineCount }, (_, index) => `${externalId}\tITEM-${suffix}-${index}\t${purchaseDate}\tDELIVERY-${suffix}\tSynthetic pillow\t2\tUSD\t20.00\tSynthetic recipient\t1 Test Street\tTest City\tCA\t00000\tUS\t1234567890`).join("\n");
  const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", { accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-delivery.txt", content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\trecipient-name\tship-address-1\tship-city\tship-state\tship-postal-code\tship-country\tbuyer-phone-number\n${rows}` });
  const workspace = await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?batchId=${batch.id}`), lines: string[] = [];
  for (const row of workspace.lines) {
    const id = row.orderLineId; lines.push(id);
    let detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`);
    detail = await centerApi(`order-centers/lines/${id}/draft`, { expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, expectedSourceVersionId: detail.report?.versionId ?? null, status: "ready_to_push", reason: "Synthetic operator reviewed manufacturing", idempotencyKey: randomUUID(),
      draft: { ...detail.draft, printProfileVersionId: profile.versionId, salesRecipeVersionId: null, salesPackageId: null, artworkVersionId: artwork.versionId, specificationVersionId: specification.versionId, designExecutor: "human", images: [], fields: [], instructions: "Synthetic print approved library artwork on shaped pillow" } });
    for (const action of ["push", "start_artwork"] as const) detail = await centerApi(`order-centers/lines/${id}/actions`, { action, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, reason: "Synthetic operator starts manual artwork", idempotencyKey: randomUUID() });
    const project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${detail.line.editorProjectId}`), document = project.version.document;
    const orderImage = await centerApi<ProductionEditorImageView>(`production-editor/projects/${project.project.id}/images`, { name: "synthetic-owned-art.png", contentBase64: syntheticProductionPng(2048).toString("base64") });
    document.layers = doc.layers.map(layer => layer.kind === "image" ? { ...layer, assetId: orderImage.id } : layer);
    document.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
    const checked = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${project.project.id}/versions`, { expectedVersionId: project.version.id, document });
    for (const action of ["submit_artwork", "approve_artwork"] as const) detail = await centerApi(`order-centers/lines/${id}/actions`, { action, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: checked.version.id, reason: "Synthetic operator reviewed fixture artwork", idempotencyKey: randomUUID() });
    let renderId = "";
    await expect.poll(async () => { const result = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${project.project.id}`); const render = result.renders.find(render => render.versionId === checked.version.id && render.purpose === "production" && render.status === "completed"); renderId = render?.id ?? ""; return !!render; }, { timeout: 60_000 }).toBe(true);
    const assigned = assignments[(lines.length - 1) % assignments.length]!;
    const capacity = capacities.get(assigned.factory.id)!;
    if (options.release !== false) await centerApi(`order-centers/lines/${id}/release`, { ...assigned.pins, capacityPlan: capacity.capacityPlan, manufacturing: { versionId: manufacturing.versionId, orderUnitConfirmed: true }, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, renderId, supplierId: supplier.id, quantity: 2, instructions: "Synthetic current approved pillow JPG; preserve pixels", expectedCompletionAt: capacity.expectedCompletionAt, idempotencyKey: randomUUID() });
  }
  return { externalId, factoryName, factoryId: factory.factory.id, supplierId: supplier.id, lines, factories: assignments.map(assigned => assigned.factory), manufacturing,
    capacity: capacities.get(factory.factory.id)!, capacities };
}
