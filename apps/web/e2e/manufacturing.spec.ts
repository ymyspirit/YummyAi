import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { connectDatabase } from "@yummyai/database";
import { ManufacturingRecipeContentSchema, ManufacturingRecipeVersionViewSchema, type ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import { manufacturingBasis } from "../../api/src/catalog/manufacturing.test-fixture";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { actors, changeErpRights, identityControl, loginErp, scopedErpRole } from "./erp-identity-fixture";

const readRights = ["product:read", "design:read", "research:read", "capture:read"];
async function source() {
  requireDisposableIntegrationEnvironment();
  const db = connectDatabase(), actor = actors().operator;
  try { return await manufacturingBasis(db, { ...actor, dataScope: "tenant", permissions: Object.values(Permission) }); }
  finally { await db.client.end(); }
}
type Source = Awaited<ReturnType<typeof source>>;
function content(own: Source) {
  return ManufacturingRecipeContentSchema.parse({ specificationVersionId: own.specificationVersionId, name: "Synthetic saved manufacturing", outputQuantity: 2, outputUnit: "each",
    materials: [{ code: "FABRIC", name: "Synthetic fabric", stockItemId: own.stockId, quantityNumerator: 3, quantityDenominator: 2, unit: "meter", lossBps: 1000, lossBasis: "add_to_net", responsibility: "merchant", operationCode: "CUT" }],
    operations: [{ code: "CUT", name: "Synthetic cutting", processCode: "cut", responsibility: "factory", expectedSecondsPerOutput: null }] });
}
async function create(own: Source) {
  const { access_token: token } = await identityControl("token", { account: "operator" });
  const response = await fetch(`${process.env.API_BASE_URL}/v1/manufacturing-recipes`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ spuId: own.spuId, specificationId: own.specificationId, code: "BOM-" + randomUUID(), content: content(own), idempotencyKey: randomUUID() }),
  });
  expect(response.status).toBe(201);
  return ManufacturingRecipeVersionViewSchema.parse((await response.json()).data);
}
const location = (own: Source, version: ManufacturingRecipeVersionView) => `/manufacturing-recipes?spuId=${own.spuId}&recipe=${version.recipeId}`;
async function current(page: Page, id: string) {
  const response = await page.request.get(`/api/manufacturing-recipes/${id}`); expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function noHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>(".mf-page *")].filter(element => {
      const style = getComputedStyle(element);
      return element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && style.overflowX === "visible";
    }).map(element => ({ tag: element.tagName, class: element.className, width: element.clientWidth, scroll: element.scrollWidth })).slice(-12),
  }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
}

test("SPU specification to unknown draft, approved exact demand, next draft and immutable history at desktop and mobile widths", async ({ page }, info) => {
  const own = await source();
  await page.setViewportSize({ width: 1440, height: 960 });
  await loginErp(page, "operator", `/product-specifications?spu=${own.spuId}`);
  await page.getByRole("link", { name: "本规格制造模板", exact: true }).click();
  const form = page.getByRole("form", { name: "制造模板编辑" });
  await expect(form.getByLabel("所用产品规格", { exact: true })).toHaveValue(own.specificationVersionId);
  await form.getByLabel("制造模板编号", { exact: true }).fill("BOM-" + randomUUID().slice(0, 8));
  await form.getByLabel("制造名称", { exact: true }).fill("Synthetic unknown draft");
  await form.getByLabel("下列用量对应产出数量", { exact: true }).fill("2");
  await form.getByLabel("产出单位", { exact: true }).selectOption("each");
  await form.getByRole("button", { name: "增加工序", exact: true }).click();
  const op = form.getByRole("group", { name: "工序 1", exact: true });
  await op.getByLabel("工序编号", { exact: true }).fill("CUT");
  await op.getByLabel("工序名称", { exact: true }).fill("Synthetic cutting");
  await op.getByLabel("加工代码", { exact: true }).fill("cut");
  await form.getByRole("button", { name: "增加材料", exact: true }).click();
  const material = form.getByRole("group", { name: "材料 1", exact: true });
  await material.getByLabel("材料行编号", { exact: true }).fill("FABRIC");
  await material.getByLabel("库存物料", { exact: true }).selectOption(own.stockId);
  await material.getByLabel("关联工序", { exact: true }).selectOption({ label: "1 CUT Synthetic cutting" });
  await form.getByRole("button", { name: "保存制造模板", exact: true }).click();
  await expect(page).toHaveURL(/manufacturing-recipes\?spuId=.*recipe=/);
  await expect(page.getByRole("group", { name: "制造版本状态" })).toContainText("V1 · 未审核");
  await expect(page.getByRole("button", { name: "批准当前版本", exact: true })).toBeDisabled();
  await expect(material.getByLabel("净用量", { exact: true })).toHaveValue("");
  await material.getByLabel("净用量", { exact: true }).fill("1.5");
  await material.getByLabel("损耗比例 %", { exact: true }).fill("10");
  await material.getByLabel("损耗计算口径", { exact: true }).selectOption("add_to_net");
  await material.getByLabel("谁提供材料", { exact: true }).selectOption("merchant");
  await op.getByLabel("由谁执行", { exact: true }).selectOption("factory");
  await form.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(page.getByRole("group", { name: "制造版本状态" })).toContainText("V2 · 未审核");
  await page.getByLabel("本次审核说明", { exact: true }).fill("Synthetic technical review only");
  await page.getByRole("button", { name: "批准当前版本", exact: true }).click();
  await expect(page.getByRole("group", { name: "制造版本状态" })).toContainText("V2 · 已批准");
  await page.getByLabel("计划产出数量", { exact: true }).fill("3");
  await page.getByRole("button", { name: "生成备料建议", exact: true }).click();
  await expect(page.getByRole("region", { name: "精确备料汇总" })).toContainText("精确需求 2.475 米");
  await form.getByLabel("制造名称", { exact: true }).fill("Synthetic next draft " + "Long material source reference ".repeat(5));
  await form.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(page.getByRole("group", { name: "制造版本状态" })).toContainText("V3 · 未审核");
  await expect(page.getByRole("group", { name: "制造版本状态" })).toContainText("已批准版本V2");
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page.getByRole("button", { name: "V1 Synthetic unknown draft · 未审核", exact: true }).click();
  await expect(page.locator('[aria-label="历史制造版本V1"]')).toContainText("净用量 待确认");
  await page.getByRole("group", { name: "制造版本状态" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("manufacturing-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("manufacturing-mobile.png") });
  await material.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("manufacturing-material-mobile.png") });
  const recipeId = new URL(page.url()).searchParams.get("recipe")!;
  const stored = await current(page, recipeId);
  expect(stored.currentVersion.versionNumber).toBe(3); expect(stored.releasedVersion.versionNumber).toBe(2);
  await page.reload();
  await expect(form.getByLabel("净用量", { exact: true })).toHaveValue("1.5");
});

for (const failure of ["network", "authority"] as const) test(`an uncertain successful revision restores its original request across reload without another version: ${failure}`, async ({ page }) => {
  const own = await source(), first = await create(own);
  await loginErp(page, "operator", location(own, first));
  await page.getByLabel("制造名称", { exact: true }).fill("Synthetic recovered version");
  const requests: unknown[] = []; let lost = true;
  await page.route(`**/api/manufacturing-recipes/${first.recipeId}/versions`, async route => {
    requests.push(route.request().postDataJSON());
    if (!lost) { await route.continue(); return; }
    lost = false; const response = await route.fetch(); expect(response.status()).toBe(201);
    if (failure === "network") await route.abort("failed");
    else await route.fulfill({ status: 409, json: { message: "Synthetic authority changed after command", code: "authority_changed" } });
  });
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  if (failure === "network") await expect(page.getByRole("button", { name: "恢复本次提交结果", exact: true })).toBeEnabled();
  else await expect(page.getByRole("button", { name: "重新核对身份与资料", exact: true })).toBeVisible();
  expect((await current(page, first.recipeId)).currentVersion.versionNumber).toBe(2);
  await page.reload();
  await expect(page.getByRole("button", { name: "恢复本次提交结果", exact: true })).toBeEnabled();
  await expect(page.getByLabel("制造名称", { exact: true })).toHaveValue("Synthetic recovered version");
  await page.getByRole("button", { name: "恢复本次提交结果", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复本次提交结果", exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect((await current(page, first.recipeId)).currentVersion.versionNumber).toBe(2);
  const history = await (await page.request.get(`/api/manufacturing-recipes/${first.recipeId}/history`)).json();
  expect(history.data.items).toHaveLength(2);
});

test("an uncertain successful creation restores the same original template from the cached creation form", async ({ page }) => {
  const own = await source();
  await loginErp(page, "operator", `/manufacturing-recipes?spuId=${own.spuId}&specificationId=${own.specificationId}&new=1`);
  await page.getByLabel("制造模板编号", { exact: true }).fill("BOM-" + randomUUID().slice(0, 8));
  await page.getByLabel("制造名称", { exact: true }).fill("Synthetic original creation");
  await page.getByLabel("下列用量对应产出数量", { exact: true }).fill("2");
  await page.getByLabel("产出单位", { exact: true }).selectOption("each");
  const requests: unknown[] = []; let lost = true, originalId = "";
  await page.route("**/api/manufacturing-recipes", async route => {
    requests.push(route.request().postDataJSON());
    if (!lost) { await route.continue(); return; }
    lost = false; const response = await route.fetch(); expect(response.status()).toBe(201);
    originalId = (await response.json()).data.recipeId; await route.abort("failed");
  });
  await page.getByRole("button", { name: "保存制造模板", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复本次提交结果", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "恢复本次提交结果", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "恢复本次提交结果", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`recipe=${originalId}`));
  await expect(page.getByRole("group", { name: "制造版本状态" })).toContainText("V1 · 未审核");
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  const listing = await (await page.request.get(`/api/manufacturing-recipes?spuId=${own.spuId}`)).json();
  expect(listing.data.items.map((row: { id: string }) => row.id)).toEqual([originalId]);
});

test("temporary source failure preserves typing while a newer saved basis requires explicit reconciliation", async ({ page }) => {
  const own = await source(), first = await create(own);
  await loginErp(page, "operator", location(own, first));
  await page.getByLabel("制造说明", { exact: true }).fill("Synthetic private unsaved description");
  let failing = true;
  await page.route("**/api/manufacturing-recipes/references?**", async route => {
    if (failing) await route.fulfill({ status: 503, json: { message: "Synthetic temporary source failure" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试资料读取", exact: true })).toBeVisible();
  await expect(page.getByLabel("制造说明", { exact: true })).toHaveValue("Synthetic private unsaved description");
  await expect(page.getByRole("button", { name: "保存为新版本", exact: true })).toBeDisabled();
  failing = false; await page.getByRole("button", { name: "重试资料读取", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存为新版本", exact: true })).toBeEnabled();
  const changed = await page.request.post(`/api/manufacturing-recipes/${first.recipeId}/versions`, {
    headers: { origin: "http://localhost:3130" }, data: { expectedVersion: 1, content: { ...first.content, name: "Synthetic concurrent version" }, idempotencyKey: randomUUID() },
  });
  expect(changed.status()).toBe(201);
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.getByText("填写基于V1 服务器当前为V2 本次填写已保留 请核对后继续", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存为新版本", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "以当前版本继续核对", exact: true }).click();
  await expect(page.getByLabel("制造说明", { exact: true })).toHaveValue("Synthetic private unsaved description");
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(page.getByRole("group", { name: "制造版本状态" })).toContainText("V3 · 未审核");
  expect((await current(page, first.recipeId)).currentVersion.content.notes).toBe("Synthetic private unsaved description");
});

test("write permission cannot approve and a narrower current read scope removes private typing and late responses", async ({ page }) => {
  const own = await source(), first = await create(own);
  const role = await scopedErpRole(["product:read", "product:write", "inventory:read"], "tenant");
  let release = () => {};
  try {
    await changeErpRights("readonly", readRights.filter(p => p !== "product:read"));
    await loginErp(page, "readonly", location(own, first));
    await expect(page.getByRole("button", { name: "保存为新版本", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "批准当前版本", exact: true })).toBeDisabled();
    await page.getByLabel("制造名称", { exact: true }).fill("Synthetic private scope draft");
    let ready!: () => void, once = true;
    const captured = new Promise<void>(resolve => { ready = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/manufacturing-recipes/references?**", async route => {
      if (!once) { await route.continue(); return; }
      once = false; const response = await route.fetch(); ready(); await hold;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await captured;
    await role.setScope("self");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByLabel("制造名称", { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByText("Synthetic private scope draft", { exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/manufacturing-recipes/${first.recipeId}`)).status()).toBe(404);
  } finally { release(); await changeErpRights("readonly", readRights); await role.remove(); }
});
