import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createEntityId, type AmazonReportBatchView, type AmazonReportWorkspaceView, type MarketplaceAccountView, type ProductionEditorRenderView } from "@yummyai/contracts";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { OrderReviewViewSchema, OrderReviewWorkspaceSchema } from "@yummyai/contracts/order/review";
import type { FinanceFactInput, FinanceProfitMetricView, FinanceStatementView } from "@yummyai/contracts/finance";
import type { ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import { shipments, shipmentVersions, shipmentPackages, shipmentPackageLines, shipmentProductionAllocations, shipmentTrackingEvents, withTenant } from "@yummyai/database";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";
import { centerApi, createCenterProfile } from "./order-centers-fixture";
import { apiFetch } from "../src/server-api";
import { loginErp } from "./erp-identity-fixture";
import { syntheticPassedProduction } from "../../api/src/orders/shipment-production-fixture";
import { createOrderPiiVault } from "../../api/src/orders/order-pii-vault";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";

test.beforeEach(async ({ page }) => { if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page); });

test("isolated production fixture worker starts and closes on owned resources", async ({ page }, testInfo) => {
  expect(new URL(page.url()).origin).toBe("http://localhost:3130");
  const worker = await startProductionEditorWorker();
  try {
    expect(worker.exitCode).toBeNull();
    expect(worker.signalCode).toBeNull();
  } finally { await stopProductionEditorWorker(worker); }
  expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
  mkdirSync(testInfo.outputDir, { recursive: true });
  writeFileSync(testInfo.outputPath("worker-boundary-proof.json"), JSON.stringify({ ready: true, stopped: true,
    ordinaryApplicationsStarted: false, modelsCalled: 0, businessFixture: "owned nonce database bucket and Redis container" }, null, 2));
});

test("synthetic pillow center completes real scanned adaptation and verifies its production JPEG bytes", async ({ page }, testInfo) => {
  expect(new URL(page.url()).origin).toBe("http://localhost:3130");
  const profile = await createCenterProfile("shaped_pillow", `REVIEW-${randomUUID().slice(0,8)}`, true);
  expect(profile.adaptation).not.toBeNull();
  const basis = profile.adaptation!;
  const render = await centerApi<ProductionEditorRenderView>(`production-editor/projects/${basis.projectId}/renders/${basis.renderId}`);
  expect(render).toMatchObject({ id: basis.renderId, versionId: basis.versionId, status: "completed", purpose: "production" });
  expect(render.preflight?.productionReady).toBe(true);
  expect(render.preflight?.issues.filter(issue => issue.severity === "error")).toEqual([]);
  const file = render.files.find(entry => entry.mediaType === "image/jpeg");
  expect(file).toBeTruthy();
  const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${basis.projectId}/renders/${basis.renderId}/files/${file!.key}`);
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");
  const bytes = Buffer.from(await response.arrayBuffer());expect(bytes.length).toBe(file!.byteSize);
  const sharp = createRequire(new URL("../../../packages/production-editor/package.json",import.meta.url))("sharp");
  const metadata = await sharp(bytes).metadata() as {format:string;space:string;density:number;width:number;height:number;icc?:Buffer};
  expect(metadata).toMatchObject({format:"jpeg",space:"srgb",density:150,width:render.preflight!.widthPx,height:render.preflight!.heightPx});
  expect(metadata.icc?.length).toBeGreaterThan(0);
  mkdirSync(testInfo.outputDir, { recursive: true });
  writeFileSync(testInfo.outputPath("production-jpeg-proof.json"),JSON.stringify({profileId:profile.id,recipeId:profile.recipeId,...basis,
    mediaType:file!.mediaType,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),
    width:metadata.width,height:metadata.height,dpi:metadata.density,space:metadata.space,iccEmbedded:!!metadata.icc,
    productionReady:render.preflight!.productionReady,syntheticOnly:true,factoryAccepted:false},null,2));
});

test("controlled order review traces two pillow SKUs and preserves missing, shared and stale financial evidence", async ({ page }, testInfo) => {
  test.setTimeout(300000); page.setDefaultTimeout(25000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const fixture = await salesLaunchFixture({ pillow: true });
  mkdirSync(testInfo.outputDir, { recursive: true });
  const proof: Record<string, unknown> = { fixtureIds: fixture.ids, modelCalls: 0, externalActions: 0, cleanup: "disposable runner" };
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && !/\/order-centers\/(summaries|selection|bulk\/preview)$/.test(path)) writes.push(path); });
  try {
    const sibling = await fixture.addSibling(), recipes = [fixture.recipe, sibling.recipe];
    // These are explicit synthetic stock-history prerequisites. Pin the saved
    // work revision and its exact existing specification, never replace it with
    // a new native-product confirmation merely to make a shipment fixture pass.
    const manufacturing = new Map<string, {versionId:string;orderUnitConfirmed:true}>();
    const material=await centerApi<{id:string}>("inventory/stock-items",{skuId:null,code:`REVIEW-${randomUUID()}`.toUpperCase(),
      name:"Synthetic read-fixture fabric",baseUnit:"meter"});
    for (const recipe of recipes) {
      const {data:bom}=await centerApi<{data:ManufacturingRecipeVersionView}>("manufacturing-recipes",{
        spuId:fixture.spu.id,specificationId:recipe.specification.id,code:`REVIEW-${randomUUID()}`,idempotencyKey:randomUUID(),
        content:{specificationVersionId:recipe.specification.versionId,name:"Synthetic review stock provenance",outputQuantity:1,outputUnit:"each",
          materials:[{code:"FABRIC",name:"Synthetic read-fixture fabric",stockItemId:material.id,quantityNumerator:1,quantityDenominator:2,unit:"meter",
            lossBps:0,lossBasis:"add_to_net",responsibility:"merchant",operationCode:"MAKE"}],
          operations:[{code:"MAKE",name:"Synthetic historical manufacture",processCode:"make",responsibility:"factory",expectedSecondsPerOutput:null}],
          notes:"Disposable read fixture only; no physical production or factory acceptance"},
      });
      await centerApi(`manufacturing-recipes/${bom.recipeId}/reviews`,{expectedVersion:1,versionId:bom.versionId,decision:"approved",
        note:"Explicit synthetic BOM for the exact saved specification only",idempotencyKey:randomUUID()});
      manufacturing.set(recipe.specification.versionId,{versionId:bom.versionId,orderUnitConfirmed:true});
    }
    const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", { platform: "amazon", displayName: "Synthetic order review account",
      region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] });
    const suffix = fixture.planId.slice(-8), external = ["A", "B", "C", "D"].map(letter => `REVIEW-${suffix}-${letter}`);
    const now = Date.now(), placedAt = new Date(now - 12 * 3600000).toISOString(), deadline = new Date(now - 4 * 3600000).toISOString();
    const sources = [{ order: 0, sku: 0, quantity: 1 }, { order: 1, sku: 1, quantity: 1 }, { order: 2, sku: 0, quantity: 2 },
      { order: 2, sku: 1, quantity: 2 }, { order: 3, sku: 0, quantity: 1 }];
    const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", { accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-review.txt",
      content: "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n" + sources.map((source, index) =>
        `${external[source.order]}\tREVIEW-LINE-${index}\t${placedAt}\t${recipes[source.sku]!.skuCode}\tSynthetic pillow review fixture\t${source.quantity}\tUSD\t50.00`).join("\n") });
    const imported = await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?batchId=${batch.id}`);
    const details: OrderWorkDetail[] = [];
    for (const [index, source] of sources.entries()) {
      const id = imported.lines.find(line => line.externalLineId === `REVIEW-LINE-${index}`)!.orderLineId;
      const recipe = recipes[source.sku]!;
      let detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`);
      detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}/draft`, { expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion, expectedSourceVersionId: detail.report?.versionId ?? null,
        draft: { ...detail.draft, salesRecipeVersionId: recipe.id, artworkVersionId: recipe.artwork.versionId,
          specificationVersionId: recipe.specification.versionId, printProfileVersionId: recipe.specification.processProfileVersionId,
          designExecutor: "human", fields: [], images: [], instructions: "Synthetic saved basis for read-only review; no customer or production approval" },
        status: "pending_review", reason: "Synthetic report review only; incomplete buyer inputs remain pending", idempotencyKey: randomUUID() });
      if (source.order !== 3) detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}/platform-deadline`, {
        expectedProjectionVersion: detail.line.projectionVersion, shipByAt: deadline, evidenceReference: "Synthetic platform deadline", idempotencyKey: randomUUID() });
      details.push(detail);
    }
    proof.lines = details.map(detail => detail.line.id); proof.accountId = account.id;
    const packets: string[] = [];
    const stockByLine = new Map<string, Awaited<ReturnType<typeof syntheticPassedProduction>>[number]>();
    for (let index = 0; index < 4; index++) {
      const items = details.filter(detail => detail.line.externalOrderId === external[index]);
      const workSources=new Map(items.map(detail=>{
        const revision=detail.versions.find(version=>version.revision===detail.line.revision),bom=manufacturing.get(detail.draft.specificationVersionId!);
        if(!revision||!bom)throw new Error("Synthetic review requires its exact saved work revision and approved specification BOM");
        return[detail.line.id,{revisionId:revision.id,manufacturing:bom}]as const;
      }));
      const stock = await syntheticPassedProduction(fixture.database, fixture.context, items[0]!.line.orderId,
        items.map(detail => ({ id: detail.line.id, quantity: detail.line.quantity })),undefined,
        {vault:createOrderPiiVault(),workSources});
      for (const source of stock) stockByLine.set(source.orderLineId, source);
    }
    // Explicit synthetic stock provenance for this read fixture; no factory release or carrier call.
    await withTenant(fixture.database.db, fixture.context, async tx => {
      for (let index = 0; index < 4; index++) {
        const shipmentId = createEntityId(), versionId = createEntityId(), packetId = createEntityId(); packets.push(packetId);
        const orderLines = details.filter(detail => detail.line.externalOrderId === external[index]);
        await tx.insert(shipments).values({ id: shipmentId, tenantId: fixture.context.tenantId, orderId: orderLines[0]!.line.orderId,
          status: index === 3 ? "draft" : "approved", currentVersionNumber: 1, approvedVersionNumber: index === 3 ? null : 1, idempotencyKey: randomUUID() });
        await tx.insert(shipmentVersions).values({ id: versionId, tenantId: fixture.context.tenantId, shipmentId, versionNumber: 1,
          shipDate: new Date(placedAt), shipFromCountryCode: "CN", idempotencyKey: randomUUID(), productionSourceVersion: 2, requestChecksum: "b".repeat(64), createdBy: fixture.context.userId });
        await tx.insert(shipmentPackages).values({ id: packetId, tenantId: fixture.context.tenantId, shipmentId, shipmentVersionId: versionId,
          packageReferenceId: `SYNTHETIC-${index}`, trackingNumber: `SYNTHETIC-TRACK-${index}`, carrierCode: "MANUAL", carrierName: "Synthetic carrier",
          carrierService: "Synthetic FBM", labelCostMinor: index === 3 ? null : 200, labelCurrency: index === 3 ? null : "USD" });
        for (const detail of orderLines) {
          const packageLineId = createEntityId(), source = stockByLine.get(detail.line.id)!;
          await tx.insert(shipmentPackageLines).values({ id: packageLineId, tenantId: fixture.context.tenantId,
            shipmentId, shipmentVersionId: versionId, packageId: packetId, orderLineId: detail.line.id, quantity: 1 });
          await tx.insert(shipmentProductionAllocations).values({ id: createEntityId(), tenantId: fixture.context.tenantId, shipmentId, shipmentVersionId: versionId,
            packageId: packetId, packageLineId, orderLineId: detail.line.id, productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
            qualityInspectionId: source.qualityInspectionId, productionProjectionVersion: 5, quantity: 1 });
        }
        if (index !== 3) await tx.insert(shipmentTrackingEvents).values({ id: createEntityId(), tenantId: fixture.context.tenantId, shipmentId, packageId: packetId,
          status: "picked_up", provider: "synthetic", externalEventId: randomUUID(), detailCode: "SYNTHETIC_PICKUP",
          occurredAt: new Date(now - (index === 0 ? 5 : 2) * 3600000) });
      }
    });
    proof.packages = packets;
    const facts: FinanceFactInput[] = [];
    for (const [index, detail] of details.entries()) {
      const source = sources[index]!; if (source.order === 3) continue;
      const recipe = recipes[source.sku]!;
      for (const [factType, amountMinor] of [["sale_revenue", 5000], ["production_cost", 1000], ["marketplace_commission", 500]] as const)
        facts.push({ lineKey: `${index}-${factType}`, sourceEntryId: `synthetic-review:${account.id}:${detail.line.id}:${factType}`, factType, direction: factType === "sale_revenue" ? "credit" : "debit", amountMinor,
          currency: "USD", occurredAt: placedAt, externalReference: `SYNTHETIC-${index}-${factType}`, orderId: detail.line.orderId,
          orderLineId: detail.line.id, skuId: recipe.skuId, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null });
    }
    for (let index = 0; index < 3; index++) {
      const detail = details.find(detail => detail.line.externalOrderId === external[index])!;
      facts.push({ lineKey: `freight-${index}`, sourceEntryId: `synthetic-review:${account.id}:freight:${index}`, factType: "carrier_cost", direction: "debit", amountMinor: 200, currency: "USD", occurredAt: placedAt,
        externalReference: `shipment-package:${packets[index]}`, orderId: detail.line.orderId, orderLineId: index === 2 ? null : detail.line.id,
        skuId: index === 2 ? null : recipes[index]!.skuId, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null });
    }
    const statement = await centerApi<FinanceStatementView>("finance/statements", { accountId: null, provider: "manual", statementKind: "operational_cost",
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-ORDER-REVIEW" },
      externalStatementId: `SYNTHETIC-REVIEW-${suffix}`, periodStart: placedAt, periodEnd: new Date(now).toISOString(), sourceCurrency: "USD",
      observedAt: new Date(now).toISOString(), idempotencyKey: randomUUID(), lines: facts });
    const metric = await centerApi<FinanceProfitMetricView>("finance/profit-metrics", { metricId: null, name: "Synthetic pillow complete contribution", reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost", "carrier_cost", "marketplace_commission", "refund", "other_fee"],
      requiredFactTypes: ["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"], reasonCode: "SYNTHETIC_ONLY", idempotencyKey: randomUUID() });
    await centerApi("finance/profit-runs", { metricId: metric.id, expectedMetricVersion: 1, statementIds: [statement.id], fxRateIds: [], coverageDimension: "order", idempotencyKey: randomUUID() });
    const first = OrderReviewViewSchema.parse(await centerApi(`order-centers/lines/${details[0]!.line.id}/review`));
    expect(first.profit).toMatchObject({ status: "verified", profitMinor: 3300 }); expect(first.lines[0]!.deadline.status).toBe("on_time");
    expect(first.lines[0]!.specificationVersionId).toBe(recipes[0]!.specification.versionId);
    const mixed = OrderReviewViewSchema.parse(await centerApi(`order-centers/lines/${details[2]!.line.id}/review`));
    expect(mixed.profit).toMatchObject({ status: "verified", profitMinor: 6800, lines: [] });
    expect(mixed.lines.every(line => line.deadline.status === "overdue" && line.deadline.handedOverQuantity === 1)).toBe(true);
    const unknown = OrderReviewViewSchema.parse(await centerApi(`order-centers/lines/${details[4]!.line.id}/review`));
    expect(unknown.costs).toEqual(expect.arrayContaining([expect.objectContaining({ source: "shipment", basis: "unknown" })])); expect(unknown.profit.profitMinor).toBeNull();
    const financePage = await page.goto("/finance"); expect(financePage?.status()).toBe(200);
    await page.getByRole("link", { name: /定制订单履约与利润复盘/ }).click();
    await expect(page.getByRole("navigation", { name: "当前位置" }).getByText("定制订单履约与利润复盘", { exact: true })).toBeVisible();
    await expect(page.locator('.erp-navigation-group[data-active="true"] > button')).toContainText("研究与经营");
    const panel = page.getByRole("region", { name: "SKU 履约与利润复盘" }); await expect(panel.getByText(/期间共有 \d+ 单/)).toBeVisible();
    await panel.getByLabel("销售 SKU", { exact: true }).fill(recipes[1]!.skuCode);
    await panel.getByRole("button", { name: "读取复盘", exact: true }).click();
    await expect(panel.getByText("期间共有 2 单", { exact: false })).toBeVisible();
    await expect(panel.getByRole("cell", { name: /准时 0.0%/ })).toBeVisible();
    await panel.getByLabel("销售 SKU", { exact: true }).fill(recipes[0]!.skuCode);
    await panel.getByRole("button", { name: "读取复盘", exact: true }).click();
    await expect(panel.getByText("期间共有 3 单", { exact: false })).toBeVisible();
    await expect(panel.getByRole("cell", { name: /Synthetic 10 inch pillow/ })).toBeVisible(); await expect(panel.getByRole("cell", { name: /Synthetic 12 inch pillow/ })).toBeVisible();
    await expect(panel.getByRole("cell", { name: /准时 100.0%/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: testInfo.outputPath("dark.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 1440, height: 960 });
    await panel.getByRole("link", { name: external[0], exact: true }).click();
    await page.locator("details.oc-whole-records > summary").filter({ hasText: "履约与利润复盘" }).click();
    const single = page.getByRole("region", { name: "履约与利润复盘", exact: true });
    await expect(single.getByText("所选口径已核验", { exact: true })).toBeVisible(); await expect(single.getByText("按时交运", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("order.png"), fullPage: true });
    await centerApi("finance/statements", { accountId: null, provider: "manual", statementKind: "operational_cost", externalStatementId: `SYNTHETIC-LATE-${suffix}`,
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-ORDER-REVIEW" },
      periodStart: placedAt, periodEnd: placedAt, sourceCurrency: "USD", observedAt: new Date().toISOString(), idempotencyKey: randomUUID(),
      lines: [{ ...facts[0]!, lineKey: "late-fee", sourceEntryId: `synthetic-review:${account.id}:late-fee`, factType: "other_fee", direction: "debit", amountMinor: 25 }] });
    await single.getByRole("button", { name: "重新读取复盘" }).click(); await expect(single.getByText("利润待核对", { exact: true })).toBeVisible();
    await expect(single.getByText(/旧利润不能代表现有账本/)).toBeVisible();
    const rejected = await page.request.get(`/api/order-centers/review?tenantId=${fixture.context.tenantId}`); expect(rejected.status()).toBe(400);
    const from = new Date(Date.parse(placedAt) - 1000).toISOString(), to = new Date(Date.parse(placedAt) + 1000).toISOString();
    const summary = OrderReviewWorkspaceSchema.parse(await centerApi(`order-centers/review?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
    expect(summary.groups.reduce((sum, group) => sum + group.lineCount, 0)).toBe(5);
    expect(new Set(summary.groups.map(group => group.specificationVersionId))).toEqual(new Set(recipes.map(recipe => recipe.specification.versionId)));
    proof.summary = summary; proof.readWrites = writes; proof.errors = errors;
    expect(writes).toEqual([]); expect(errors).toEqual([]);
  } finally { writeFileSync(testInfo.outputPath("review-proof.json"), JSON.stringify(proof, null, 2)); await fixture.database.client.end(); }
});
