import { expect, test, type Page } from "@playwright/test";
import { connectDatabase, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import type { ProductSupplyWorkspace } from "@yummyai/contracts/catalog/product-supply";
import type { ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { apiFetch } from "../src/server-api";
import { procurementCommandDialog, submitProcurementOriginal } from "./procurement-command-fixture";
import { loginErp } from "./erp-identity-fixture";

test("real products and suppliers share versioned supply records and create an FBA procurement draft", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  expect(process.env.E2E_REAL_PRODUCTS, "This fixture requires the real product API").toBe("1");
  const prefix = `QA-SUPPLY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const base = process.env.API_BASE_URL!.replace(/\/$/, "");
  let context: { tenantId: string; userId: string } | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page, "operator", "/suppliers");
    else await page.goto("/suppliers");
    await page.getByRole("button", { name: "新增供应商", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "新增供应商", exact: true });
    await dialog.getByLabel("供应商名称", { exact: true }).fill(`${prefix} Supplier A`);
    await dialog.getByRole("button", { name: "保存供应商", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const supplierRows = await (await apiFetch(`${base}/v1/sourcing/suppliers`)).json() as Array<{ id: string; name: string; tenantId: string; createdBy: string }>;
    const supplierA = supplierRows.find((item) => item.name === `${prefix} Supplier A`)!;
    context = { tenantId: supplierA.tenantId, userId: supplierA.createdBy };
    await page.getByRole("link", { name: supplierA.name, exact: true }).click();
    await expect(page.getByRole("heading", { name: supplierA.name, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("当前位置")).toContainText("供应商详情");
    await page.getByRole("button", { name: "关联产品", exact: true }).click();
    const supply = page.getByRole("dialog", { name: "关联产品", exact: true });
    await supply.getByRole("button", { name: "新增产品", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "新增产品", exact: true });
    await dialog.getByLabel("产品名称", { exact: true }).fill(`${prefix} Custom blanket`);
    await dialog.getByRole("button", { name: "保存产品", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(supply.getByLabel("产品", { exact: true })).not.toHaveValue("");
    await supply.getByLabel("FBA 备货", { exact: true }).check();
    await supply.getByLabel("供货规格 / 定制范围", { exact: true }).fill("50 × 60 英寸；可定制姓名、照片；单件包装");
    await supply.getByLabel("采购单价", { exact: true }).fill("12.50");
    await supply.getByLabel("起订量", { exact: true }).fill("5");
    await supply.getByLabel("交期（天）", { exact: true }).fill("3");
    await supply.getByLabel("供货优先级", { exact: true }).selectOption("primary");
    await supply.getByRole("button", { name: "新增库存物料", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "新增物料", exact: true });
    await dialog.getByLabel("物料名称", { exact: true }).fill(`${prefix} Blanket`);
    await dialog.getByLabel("物料编码", { exact: true }).fill(`${prefix}-MAT`);
    await dialog.getByRole("button", { name: "保存物料", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(supply.getByLabel("采购单价", { exact: true })).toHaveValue("12.50");
    await supply.getByRole("button", { name: "保存供货资料", exact: true }).click();
    await expect(supply).toHaveCount(0);
    await expect(page.getByRole("region", { name: "供应产品", exact: true })).toContainText("CNY 12.50");
    let workspace = await loadSupply(base);
    const product = workspace.products.find((item) => item.name === `${prefix} Custom blanket`)!;
    const linkA = workspace.links.find((item) => item.productPlanId === product.id)!;

    await page.getByRole("link", { name: product.name, exact: true }).click();
    const panel = page.getByRole("region", { name: "产品供应商", exact: true });
    await expect(panel).toContainText(supplierA.name);
    await panel.getByRole("button", { name: "关联供应商", exact: true }).click();
    const second = page.getByRole("dialog", { name: "关联供应商", exact: true });
    await second.getByRole("button", { name: "新增供应商", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "新增供应商", exact: true });
    await dialog.getByLabel("供应商名称", { exact: true }).fill(`${prefix} Supplier B`);
    await dialog.getByRole("button", { name: "保存供应商", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await second.getByLabel("采购单价", { exact: true }).fill("13.00");
    await second.getByRole("button", { name: "保存供货资料", exact: true }).click();
    await expect(second).toHaveCount(0);
    await expect(panel).toContainText(`${prefix} Supplier B`);
    await expect(page.locator(".product-catalog-table tr").filter({ hasText: product.name })).toContainText("2 家");
    await page.screenshot({ path: testInfo.outputPath("supply-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("supply-mobile.png") });
    const row = panel.getByRole("row").filter({ hasText: supplierA.name });
    await row.getByRole("button", { name: "创建采购草稿", exact: true }).click();
    const purchase = await procurementCommandDialog(page, "按商品供货建采购单");
    await purchase.getByLabel("采购用途", { exact: true }).selectOption("fba_replenishment");
    await purchase.getByLabel("采购单号", { exact: true }).fill(`${prefix}-PO`);
    await purchase.getByRole("button", { name: "新增收货库位", exact: true }).click();
    const loc = page.getByRole("dialog", { name: "新增库位", exact: true });
    await loc.getByLabel("库位名称", { exact: true }).fill(`${prefix} Receiving`);
    await loc.getByLabel("库位编码", { exact: true }).fill(`${prefix}-LOC`);
    await loc.getByRole("button", { name: "新增仓库", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "新增仓库", exact: true });
    await dialog.getByLabel("仓库名称", { exact: true }).fill(`${prefix} QA warehouse`);
    await dialog.getByLabel("仓库编码", { exact: true }).fill(`${prefix}-WH`);
    await dialog.getByRole("button", { name: "保存仓库", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await loc.getByRole("button", { name: "保存库位", exact: true }).click();
    await expect(loc).toHaveCount(0);
    await expect(purchase.getByLabel("收货库位", { exact: true })).not.toHaveValue("");
    await noOverflow(page);
    expect(await purchase.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("supply-purchase-mobile.png") });
    await submitProcurementOriginal(purchase);
    await expect(panel.getByRole("status")).toContainText("已创建");
    const supplySource = page.url();
    await panel.getByRole("link", { name: "查看采购草稿", exact: true }).click();
    const focusedOrder = page.locator('.procurement-order-table tr[data-focused="true"]');
    await expect(focusedOrder).toContainText(`${prefix}-PO`);
    await expect(focusedOrder).toBeInViewport();
    await page.getByRole("link", { name: "返回供货资料", exact: true }).click();
    await expect(page).toHaveURL(supplySource);

    await row.getByRole("button", { name: "维护供货 / 报价", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "维护供货与报价", exact: true });
    await dialog.getByLabel("采购单价", { exact: true }).fill("14.00");
    await dialog.getByRole("button", { name: "保存供货资料", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await row.getByRole("button", { name: "历史", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "供货与报价历史", exact: true });
    await expect(dialog).toContainText("CNY 12.50");
    await expect(dialog).toContainText("CNY 14.00");
    await dialog.getByRole("button", { name: "关闭供货与报价历史", exact: true }).click();
    const procurement = await (await apiFetch(`${base}/v1/procurement/workspace`)).json() as ProcurementWorkspaceView;
    const order = procurement.purchaseOrders.find((item) => item.code === `${prefix}-PO`)!;
    expect(order.totalMinor).toBe(6250);
    expect(order.sourceSupplyVersionId).toBe(linkA.versionId);
    expect(order.purpose).toBe("fba_replenishment");
    await page.goto(`/procurement?order=${order.id}`);
    await expect(page.locator(".procurement-order-table tr").filter({ hasText: order.code })).toContainText("FBA 备货");
    await page.goto(`/suppliers/${supplierA.id}`);
    await expect(page.getByRole("region", { name: "供应产品", exact: true })).toContainText("CNY 14.00");
    await noOverflow(page);
    expect(errors).toEqual([]);
    workspace = await loadSupply(base);
    expect(workspace.links.filter((item) => item.productPlanId === product.id)).toHaveLength(2);
  } finally {
    const workspace = await loadSupply(base);
    for (const link of workspace.links.filter((item) => item.productName.startsWith(prefix))) {
      const response = await apiFetch(`${base}/v1/product-suppliers/${link.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: link.currentVersion, terms: { ...link.terms, status: "discontinued" }, idempotencyKey: crypto.randomUUID() }) });
      expect(response.ok, "Archive QA supply link").toBe(true);
    }
    if (!context) {
      const rows = await (await apiFetch(`${base}/v1/sourcing/suppliers`)).json() as Array<{ name: string; tenantId: string; createdBy: string }>;
      const own = rows.find((item) => item.name.startsWith(prefix));
      if (own) context = { tenantId: own.tenantId, userId: own.createdBy };
    }
    if (context) {
      const database = connectDatabase();
      try { await withTenant(database.db, { ...context, permissions: [], dataScope: "tenant" }, async (tx) => {
        await tx.execute(sql`update product_plans set status = 'archived' where name like ${`${prefix}%`}`);
        await tx.execute(sql`update fulfillment_suppliers set status = 'archived' where name like ${`${prefix}%`}`);
        await tx.execute(sql`update inventory_stock_items set status = 'inactive' where code = ${`${prefix}-MAT`}`);
        await tx.execute(sql`update inventory_locations set status = 'inactive' where code = ${`${prefix}-LOC`}`);
        await tx.execute(sql`update inventory_warehouses set status = 'inactive' where code = ${`${prefix}-WH`}`);
      }); } finally { await database.client.end(); }
    }
  }
});
async function loadSupply(base: string): Promise<ProductSupplyWorkspace> {
  const response = await apiFetch(`${base}/v1/product-suppliers/workspace`);
  expect(response.ok).toBe(true);
  return response.json();
}
async function noOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll("main *")].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map((element) => ({ tag: element.tagName, className: element.className, width: element.getBoundingClientRect().width })),
  }));
  expect(result.overflow, JSON.stringify(result.offenders)).toBeLessThanOrEqual(1);
}
