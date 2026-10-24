import { expect, test, type Locator } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import type JSZipType from "../../api/node_modules/jszip";
import { FACTORY_ERP_HEADERS, type FactoryErpApplyResult } from "@yummyai/contracts/order/factory-erp-import";
import type { ProductionDeliveryPackageView, ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { Permission } from "@yummyai/authz";
import { centerApi } from "./order-centers-fixture";
import { startProductionEditorWorker } from "./production-editor-fixture";
import { prepareDeliveryOrder } from "./production-delivery-fixture";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const requireFixture = createRequire(new URL("../../api/package.json", import.meta.url)), JSZip = requireFixture("jszip") as typeof JSZipType;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let worker: ChildProcess | undefined, order: Awaited<ReturnType<typeof prepareDeliveryOrder>>, packet: ProductionDeliveryPackageView;
const head = "000000000000000009001", tracking = "000000000000000009002";
const row = (status: string, id = head) => [id, "Synthetic owned export", order.externalId, tracking, "", "", "2", "4", "Synthetic carrier", "Synthetic service", status, "2026-10-21 08:09:10", "2026-10-21 09:10:11"];
const csv = (rows: string[][]) => Buffer.from([FACTORY_ERP_HEADERS, ...rows].map(r => r.map(v => `"${v.replaceAll('"', '""')}"`).join(",")).join("\r\n"));
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
async function xlsx(rows: string[][]) {
  const zip = new JSZip(), ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const put = (path: string, body: string) => zip.file(path, body, { createFolders: false });
  put("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  put("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put("xl/workbook.xml", `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Synthetic page" sheetId="1" r:id="sheet"/></sheets></workbook>`);
  put("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  put("xl/worksheets/sheet1.xml", `<worksheet xmlns="${ns}"><sheetData>${[FACTORY_ERP_HEADERS, ...rows].map((r, index) => `<row r="${index + 1}">${r.map((v, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
async function upload(area: Locator, name: string, buffer: Buffer) {
  await area.getByLabel("工厂原始文件", { exact: true }).setInputFiles({ name, mimeType: name.endsWith("xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv", buffer });
  await area.getByRole("button", { name: "上传并预览原文件", exact: true }).click();
  await expect(area.getByRole("status").filter({ hasText: "原文件与预览已保存" })).toBeVisible();
  await expect(area.getByRole("region", { name: "原工厂文件与覆盖范围", exact: true }).getByText(sha(buffer), { exact: true })).toBeVisible();
}
async function bind(area: Locator, existing = false) {
  await area.getByRole("button", { name: "核对整组绑定 第 2 行", exact: true }).click();
  const form = area.getByRole("region", { name: "核对原表整组 第 2 行", exact: true });
  if (!existing) {
    await form.getByLabel("查询已提交的原生产文件", { exact: true }).fill(order.externalId);
    await form.getByRole("button", { name: "查询原生产候选", exact: true }).click();
    for (const item of packet.items) await form.getByRole("checkbox", { name: `选择原交付项 ${item.id}`, exact: true }).check();
    await expect(form.getByText("已选原生产计数合计 4 · 原表商品总数 4", { exact: true })).toBeVisible();
  }
  await form.getByRole("checkbox", { name: new RegExp(`我已核对编号 ${head}`) }).check();
  await form.getByRole("button", { name: "确认并选择整组", exact: true }).click();
  await area.getByRole("button", { name: "核对选中整组应用（1）", exact: true }).click();
}
test.beforeAll(async () => {
  if (process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || process.env.E2E_COMPILED_WEB !== "1") throw new Error("Compiled disposable personal ERP required");
  worker = await startProductionEditorWorker(); order = await prepareDeliveryOrder(2);
  const workspace = await centerApi<ProductionDeliveryWorkspace>(`order-centers/deliveries?factory=${order.factoryId}`);
  const candidates = workspace.candidates.filter(c => order.lines.includes(c.orderLineId));
  packet = await centerApi("order-centers/deliveries", { factoryId: order.factoryId, supplierId: order.supplierId, idempotencyKey: randomUUID(),
    items: candidates.map(c => ({ productionOrderId: c.productionOrderId, productionVersionId: c.productionVersionId, expectedProjectionVersion: c.projectionVersion })) });
  expect(packet.items).toHaveLength(2);
  for (const item of packet.items) await centerApi(`order-centers/deliveries/${packet.id}/items/${item.id}/feedback`, {
    kind: "submitted", expectedSequence: 0, fileChecksum: item.snapshot!.file.checksum, manufacturingChecksum: item.snapshot!.manufacturing!.plan.checksum,
    idempotencyKey: randomUUID(), reference: "SYNTHETIC_ERP_UPLOAD_SUCCESS", note: "Synthetic operator checked actual submission of this original file", occurredAt: new Date().toISOString(), verifiedByOperator: true,
  });
});
test.afterAll(async () => { worker?.kill(); });
test("factory ERP import uses personal compiled XLSX whole-group binding, survives a lost commit response and reload, then applies CSV shipment without physical claims", async ({ page }, testInfo) => {
  test.setTimeout(240000); await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", `/production?q=${order.externalId}&line=${order.lines[0]}`);
  await page.locator("summary").filter({ hasText: /^工厂交付与回执/ }).click();
  const area = page.getByRole("region", { name: "工厂 Excel／CSV 状态同步", exact: true });
  await area.getByRole("combobox", { name: "导入工厂", exact: true }).selectOption(order.factoryId);
  await upload(area, "synthetic-original.xlsx", await xlsx([row("已审核")])); await bind(area);
  let committed: FactoryErpApplyResult | undefined;
  await page.route("**/api/factory-erp-import/imports/*/apply", async route => { const response = await route.fetch(); expect(response.status()).toBe(201); committed = await response.json(); await route.abort("failed"); }, { times: 1 });
  await area.getByRole("button", { name: "确认应用原预览", exact: true }).click();
  await expect(area.getByRole("button", { name: "重试原确认应用", exact: true })).toBeVisible(); expect(committed).toBeTruthy();
  page.once("dialog", dialog => dialog.accept()); await page.reload();
  await page.locator("summary").filter({ hasText: /^工厂交付与回执/ }).click();
  await expect(area.getByRole("button", { name: "重试原确认应用", exact: true })).toBeVisible();
  await area.getByRole("button", { name: "重试原确认应用", exact: true }).click();
  const receipt = area.getByRole("region", { name: "工厂状态应用回执", exact: true }); await expect(receipt.getByText(committed!.id, { exact: true })).toBeVisible();
  await area.getByRole("button", { name: "确认原应用回执并读取当前状态", exact: true }).click();
  await expect.poll(async () => (await centerApi<ProductionDeliveryPackageView>(`order-centers/deliveries/${packet.id}`)).items.map(i => i.factoryErp?.status)).toEqual(["scheduled", "scheduled"]);
  await upload(area, "synthetic-shipped.csv", csv([row("已出库")])); await bind(area, true);
  await area.getByRole("button", { name: "确认应用原预览", exact: true }).click(); await expect(receipt.getByRole("heading", { name: "工厂状态观察已登记" })).toBeVisible();
  await area.getByRole("button", { name: "确认原应用回执并读取当前状态", exact: true }).click();
  const saved = await centerApi<ProductionDeliveryPackageView>(`order-centers/deliveries/${packet.id}`);
  expect(saved.items.map(i => i.factoryErp?.status)).toEqual(["shipped", "shipped"]);
  for (const item of saved.items) {
    expect(item.feedback.map(f => f.kind)).toEqual(["submitted"]); expect(item.factoryErp).toMatchObject({ trackingReference: tracking, shippedQuantity: null });
    const production = await centerApi<{ productionOrder: { status: string }; milestones: { type: string }[]; inspections: unknown[] }>(`production/orders/${item.productionOrderId}`);
    expect(production.productionOrder.status).toBe("submitted"); expect(production.milestones.map(m => m.type)).toEqual(["submitted"]); expect(production.inspections).toEqual([]);
  }
  await page.reload(); await page.locator("summary").filter({ hasText: /^工厂交付与回执/ }).click();
  await expect(page.locator('[aria-label="整单下一步"]').getByText("核对工厂发货凭据", { exact: true })).toBeVisible();
  await page.locator(".oc-delivery-item-heading").first().scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("factory-erp-import-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByText("工厂跟进", { exact: false }).first().scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("factory-erp-import-mobile.png"), fullPage: false });
});
test("factory ERP import retains unknown source rows and clears private preview on current permission revocation", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const databaseUrl = new URL(process.env.DATABASE_URL!); if (!/^\/order_daily_e2e_[a-f0-9]{32}$/.test(databaseUrl.pathname)) throw new Error("Disposable role required");
  const db = createRequire(new URL("../../../packages/database/package.json", import.meta.url))("postgres")(databaseUrl.toString(), { max: 1 });
  const actor = actors().readonly, [originalRole] = await db`select permissions from roles where id=${actor.roleId} and tenant_id=${actor.tenantId}`;
  try {
    await changeErpRights("readonly", Object.values(Permission)); await loginErp(page, "readonly", `/production?q=${order.externalId}&line=${order.lines[0]}`);
    await page.locator("summary").filter({ hasText: /^工厂交付与回执/ }).click();
    const area = page.getByRole("region", { name: "工厂 Excel／CSV 状态同步", exact: true }); await area.getByRole("combobox", { name: "导入工厂" }).selectOption(order.factoryId);
    await upload(area, "synthetic-unknown.csv", csv([row("未知工厂状态", "000000000000000009999")]));
    await expect(area.getByText("本行不可应用 unknown_status", { exact: true })).toBeVisible();
    await expect(area.getByRole("button", { name: "核对整组绑定 第 2 行", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 }); await area.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("factory-erp-import-unknown-mobile.png"), fullPage: false });
    await changeErpRights("readonly", Object.values(Permission).filter(p => p !== Permission.OrderPiiRead));
    await area.getByRole("button", { name: "重新读取本页原表", exact: true }).click();
    await expect(area.getByText(/私有导入资料已隐藏/)).toBeVisible();
    await expect(area.getByText("000000000000000009999", { exact: false })).toHaveCount(0);
    await expect(area.getByRole("region", { name: "原工厂文件与覆盖范围", exact: true })).toHaveCount(0);
  } finally { await changeErpRights("readonly", originalRole.permissions); await db.end(); }
});
