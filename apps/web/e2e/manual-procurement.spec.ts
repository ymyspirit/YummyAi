import { expect, test, type Page } from "@playwright/test";
import { connectDatabase, withTenant } from "@yummyai/database";
import type { InventoryWorkspaceView } from "@yummyai/contracts/inventory";
import type { MarketplaceAccountView } from "@yummyai/contracts/marketplace/store";
import { sql } from "drizzle-orm";
import { apiFetch } from "../src/server-api";

// All business mutations use the normal Web -> authenticated API path. Local QA
// ledgers remain immutable; finally archives only this test's master records.
test("manual store and procurement flow creates related records, revises, reviews and receives real inventory", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const prefix = `QA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const base = process.env.API_BASE_URL!.replace(/\/$/, "");
  let cleanupContext: { tenantId: string; userId: string } | undefined;
  let storeId: string | undefined;
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/procurement");
    await page.getByRole("button", { name: "新增采购单", exact: true }).click();
    const purchase = page.getByRole("dialog", { name: "新增采购单", exact: true });
    await purchase.getByLabel("采购单号", { exact: true }).fill(`${prefix}-PO`);
    await purchase.getByLabel("预计到货时间", { exact: true }).fill("2026-09-25T10:30");
    await purchase.getByRole("button", { name: "新增供应商", exact: true }).click();
    const supplier = page.getByRole("dialog", { name: "新增供应商", exact: true });
    await supplier.getByLabel("供应商名称", { exact: true }).fill(`${prefix} Supplier`);
    await supplier.getByRole("button", { name: "保存供应商", exact: true }).click();
    await expect(supplier).toHaveCount(0);
    await expect(purchase.getByLabel("供应商", { exact: true })).not.toHaveValue("");
    const supplierRows = await (await apiFetch(`${base}/v1/sourcing/suppliers`)).json() as Array<{ name: string; tenantId: string; createdBy: string }>;
    const createdSupplier = supplierRows.find((row) => row.name === `${prefix} Supplier`)!;
    cleanupContext = { tenantId: createdSupplier.tenantId, userId: createdSupplier.createdBy };

    await purchase.getByRole("button", { name: "新增物料", exact: true }).click();
    const stockDialog = page.getByRole("dialog", { name: "新增物料", exact: true });
    await stockDialog.getByLabel("物料名称", { exact: true }).fill(`${prefix} Material`);
    await stockDialog.getByLabel("物料编码", { exact: true }).fill(`${prefix}-MAT`);
    await stockDialog.getByRole("button", { name: "保存物料", exact: true }).click();
    await expect(stockDialog).toHaveCount(0);
    await expect(purchase.getByLabel("物料", { exact: true })).not.toHaveValue("");

    await purchase.getByRole("button", { name: "新增收货库位", exact: true }).click();
    const location = page.getByRole("dialog", { name: "新增库位", exact: true });
    await location.getByLabel("库位名称", { exact: true }).fill(`${prefix} Location`);
    await location.getByLabel("库位编码", { exact: true }).fill(`${prefix}-LOC`);
    await location.getByRole("button", { name: "新增仓库", exact: true }).click();
    const warehouse = page.getByRole("dialog", { name: "新增仓库", exact: true });
    await warehouse.getByLabel("仓库名称", { exact: true }).fill(`${prefix} Warehouse`);
    await warehouse.getByLabel("仓库编码", { exact: true }).fill(`${prefix}-WH`);
    await warehouse.getByRole("button", { name: "保存仓库", exact: true }).click();
    await expect(warehouse).toHaveCount(0);
    await expect(location.getByLabel("库位名称", { exact: true })).toHaveValue(`${prefix} Location`);
    await expect(location.getByLabel("仓库", { exact: true })).not.toHaveValue("");
    await location.getByRole("button", { name: "保存库位", exact: true }).click();
    await expect(location).toHaveCount(0);
    await expect(purchase.getByLabel("采购单号", { exact: true })).toHaveValue(`${prefix}-PO`);
    await purchase.getByLabel("采购数量", { exact: true }).fill("10");
    await purchase.getByLabel("单价（CNY）", { exact: true }).fill("2.35");
    await expect(purchase).toContainText("CNY 23.50");
    await page.screenshot({ path: testInfo.outputPath("purchase-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await expect(purchase).toBeVisible();
    expect(await purchase.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("purchase-mobile.png") });
    await purchase.getByRole("button", { name: "保存采购草稿", exact: true }).click();
    await expect(purchase).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    const row = page.locator(".procurement-order-table tbody tr").filter({ hasText: `${prefix}-PO` });
    await expect(row).toContainText("草稿");
    await row.getByRole("button", { name: "编辑草稿" }).click();
    const edit = page.getByRole("dialog", { name: `编辑采购单 ${prefix}-PO` });
    await edit.getByLabel("采购数量", { exact: true }).fill("12");
    await edit.getByRole("button", { name: "保存采购草稿" }).click();
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText("V2");
    await row.getByRole("button", { name: "审核采购单" }).click();
    const review = page.getByRole("dialog", { name: `审核采购单 ${prefix}-PO` });
    await expect(review).toContainText("CNY 28.20");
    await review.getByRole("button", { name: "保存审核决定" }).click();
    await expect(review).toHaveCount(0);
    await row.getByRole("button", { name: "登记收货" }).click();
    const receipt = page.getByRole("dialog", { name: `登记收货 ${prefix}-PO` });
    await receipt.getByLabel("本次实收数量", { exact: true }).fill("12");
    await receipt.getByRole("button", { name: "确认收货并入库" }).click();
    await expect(receipt).toHaveCount(0);
    await expect(row).toContainText("已收货");

    let inventory = await loadInventory(base);
    const stock = inventory.stockItems.find((item) => item.code === `${prefix}-MAT`)!;
    const loc = inventory.locations.find((item) => item.code === `${prefix}-LOC`)!;
    expect(inventory.balances.filter((balance) => balance.stockItemId === stock.id).reduce((sum, balance) => sum + balance.physicalQuantity, 0)).toBe(12);
    await page.goto("/inventory");
    await page.getByRole("button", { name: "期初入库", exact: true }).click();
    const opening = page.getByRole("dialog", { name: "期初入库", exact: true });
    await opening.getByLabel("物料", { exact: true }).selectOption(stock.id);
    await opening.getByLabel("库位", { exact: true }).selectOption(loc.id);
    await opening.getByLabel("期初数量", { exact: true }).fill("3");
    await opening.getByLabel("记录原因", { exact: true }).fill(`${prefix} opening`);
    await opening.getByRole("button", { name: "确认期初入库" }).click();
    await expect(opening).toHaveCount(0);
    await page.getByRole("button", { name: "库存调整", exact: true }).click();
    const adjustment = page.getByRole("dialog", { name: "库存调整", exact: true });
    await adjustment.getByLabel("物料", { exact: true }).selectOption(stock.id);
    await adjustment.getByLabel("库位", { exact: true }).selectOption(loc.id);
    await adjustment.getByLabel("变动数量", { exact: true }).fill("-100");
    await adjustment.getByLabel("记录原因", { exact: true }).fill(`${prefix} adjustment`);
    await adjustment.getByRole("button", { name: "确认库存调整" }).click();
    await expect(adjustment.getByRole("alert")).toBeVisible();
    await expect(adjustment.getByLabel("变动数量", { exact: true })).toHaveValue("-100");
    await adjustment.getByLabel("变动数量", { exact: true }).fill("-1");
    await adjustment.getByRole("button", { name: "确认库存调整" }).click();
    await expect(adjustment).toHaveCount(0);
    inventory = await loadInventory(base);
    expect(inventory.balances.filter((balance) => balance.stockItemId === stock.id).reduce((sum, balance) => sum + balance.physicalQuantity, 0)).toBe(14);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("inventory-mobile.png") });

    await page.goto("/suppliers");
    await page.getByRole("button", { name: `编辑供应商 ${prefix} Supplier` }).click();
    const supplierEdit = page.getByRole("dialog", { name: "编辑供应商", exact: true });
    await supplierEdit.getByLabel("供应商名称", { exact: true }).fill(`${prefix} Supplier updated`);
    await supplierEdit.getByRole("button", { name: "保存供应商", exact: true }).click();
    await expect(supplierEdit).toHaveCount(0);
    await expect(page.getByRole("cell", { name: `${prefix} Supplier updated`, exact: true })).toBeVisible();
    await noOverflow(page);
    await page.goto("/stores");
    await page.getByRole("button", { name: "新增店铺", exact: true }).click();
    const store = page.getByRole("dialog", { name: "新增店铺", exact: true });
    await store.getByLabel("店铺名称", { exact: true }).fill(`${prefix} Store`);
    await store.getByLabel("站点", { exact: true }).selectOption({ label: "美国" });
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("store-mobile.png") });
    await store.getByRole("button", { name: "创建店铺档案" }).click();
    await expect(page.getByRole("heading", { name: `${prefix} Store`, exact: true })).toBeVisible();
    storeId = page.url().split("/").at(-1)!;
    const account = await (await apiFetch(`${base}/v1/marketplace-accounts/${storeId}`)).json() as MarketplaceAccountView;
    expect(account.hasCredential).toBe(false);
    expect(account.marketplaceIds).toEqual(["ATVPDKIKX0DER"]);
    await page.getByRole("button", { name: "编辑店铺资料", exact: true }).click();
    await page.getByRole("dialog").getByLabel("店铺名称", { exact: true }).fill(`${prefix} Store updated`);
    await page.getByRole("button", { name: "保存店铺资料" }).click();
    await expect(page.getByRole("heading", { name: `${prefix} Store updated`, exact: true })).toBeVisible();
    await noOverflow(page);
    expect(consoleErrors).toEqual([]);
  } finally {
    if (!cleanupContext) {
      const response = await apiFetch(`${base}/v1/sourcing/suppliers`);
      if (response.ok) {
        const rows = await response.json() as Array<{ name: string; tenantId: string; createdBy: string }>;
        const own = rows.find((row) => row.name === `${prefix} Supplier` || row.name === `${prefix} Supplier updated`);
        if (own) cleanupContext = { tenantId: own.tenantId, userId: own.createdBy };
      }
    }
    if (cleanupContext) await archiveFixture(base, prefix, cleanupContext, storeId);
  }
});

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}
async function loadInventory(base: string): Promise<InventoryWorkspaceView> {
  const response = await apiFetch(`${base}/v1/inventory/workspace`); expect(response.ok).toBe(true); return response.json();
}

async function archiveFixture(base: string, prefix: string, context: { tenantId: string; userId: string }, storeId?: string) {
  const inventory = await loadInventory(base);
  const stock = inventory.stockItems.find((item) => item.code === `${prefix}-MAT`);
  if (stock) {
    for (const balance of inventory.balances.filter((row) => row.stockItemId === stock.id && row.physicalQuantity !== 0)) {
      const response = await apiFetch(`${base}/v1/inventory/movements`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ stockItemId: stock.id, locationId: balance.locationId, lotId: balance.lotId, unit: stock.baseUnit,
          bucket: "physical", type: "adjustment", quantityDelta: -balance.physicalQuantity, occurredAt: new Date().toISOString(),
          sourceType: "adjustment", sourceId: `${prefix} test fixture cleanup`, reasonCode: "QA_FIXTURE_CLEANUP", idempotencyKey: `${prefix}:cleanup:${balance.locationId}:${balance.lotId ?? "none"}` }),
      });
      expect(response.ok, await response.text()).toBe(true);
    }
  }
  const database = connectDatabase();
  try {
    await withTenant(database.db, { ...context, permissions: [], dataScope: "tenant" }, async (tx) => {
      await tx.execute(sql`update inventory_stock_items set status = 'inactive' where code = ${`${prefix}-MAT`}`);
      await tx.execute(sql`update inventory_locations set status = 'inactive' where code = ${`${prefix}-LOC`}`);
      await tx.execute(sql`update inventory_warehouses set status = 'inactive' where code = ${`${prefix}-WH`}`);
      await tx.execute(sql`update fulfillment_suppliers set status = 'archived' where name in (${`${prefix} Supplier`}, ${`${prefix} Supplier updated`})`);
      if (storeId) await tx.execute(sql`update marketplace_accounts set status = 'disabled' where id = ${storeId} and display_name in (${`${prefix} Store`}, ${`${prefix} Store updated`})`);
    });
  } finally { await database.client.end(); }
}
