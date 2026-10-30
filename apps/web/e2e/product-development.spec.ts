import { expect, test, type Page } from "@playwright/test";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import type {
  DevelopmentWorkspace,
  DevelopmentOptions,
} from "@yummyai/contracts/catalog/development";
import { centerApi, createCenterProfile, createCenterSpu } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import { loginErp } from "./erp-identity-fixture";
import { fillSpecificationFacts } from "./specification-facts-form";

const spuSpecificationRows = (page: Page) => page.getByRole("dialog")
  .getByRole("table", { name: "产品规格对比", exact: true })
  .locator("tbody tr")
  .filter({ has: page.getByRole("button", { name: "修改规格", exact: true }) });

test.beforeEach(async ({ page }) => { await loginErp(page); });

test("SPU owns multiple specs; an independent artwork combines across products and opens the correct production project", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase(),
    artCode = `QA-ART-${suffix}`,
    spuCodes = [`QA-SPU-A-${suffix}`, `QA-SPU-B-${suffix}`],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const profile = await createCenterProfile("tire_cover", suffix, false);
  const brief = await centerApi<{ id: string }>("canvas-bridge/briefs", {
    requestId: crypto.randomUUID(),
    name: `QA Creative ${suffix}`,
    prompt: "Synthetic independent master",
    referenceAssetIds: [],
  });
  const result = await centerApi<{ versionId: string }>(
    `canvas-bridge/briefs/${brief.id}/results`,
    {
      submissionId: crypto.randomUUID(),
      protocolVersion: 1,
      pluginVersion: CANVAS_BRIDGE.pluginVersion,
      upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      sourceNodeId: crypto.randomUUID(),
      title: `QA Creative ${suffix}`,
      contentBase64: syntheticProductionPng().toString("base64"),
      rightsAttested: true,
      sourceKind: "owned",
      sourceReference: "Synthetic QA",
    },
  );
  await centerApi(`pod/creative-design-versions/${result.versionId}/review`, {
    decision: "approve",
  });
  const spuIds: string[] = [];

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/print-library");
  await page.getByRole("button", { name: "登记印花", exact: true }).click();
  const form = page.locator(".pd-form");
  await form.getByLabel("印花 SKU", { exact: true }).fill(artCode);
  await form.getByLabel("印花名称", { exact: true }).fill(`QA Print ${suffix}`);
  await form.getByLabel("已审核创意主文件").selectOption(result.versionId);
  await page.getByRole("dialog").getByRole("button", { name: "登记印花", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("印花版本已登记");
  await page.getByLabel("搜索编号或名称").fill(artCode);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody img")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("independent-artwork-desktop.png"),
    fullPage: true,
  });
  for (const code of spuCodes) {
    await page.goto("/product-specifications");
    await page.getByRole("button", { name: "新增 SPU", exact: true }).click();
    await page.getByLabel("SPU 编号", { exact: true }).fill(code);
    await page.getByLabel("产品名称", { exact: true }).fill(code);
    await page.getByRole("button", { name: "保存 SPU 并添加规格", exact: true }).click();
    await expect(page.locator(".oc-notice")).toContainText("SPU 已建立");
    const data = await centerApi<DevelopmentOptions>("product-development/options");
    spuIds.push(data.spus.find((s) => s.code === code)!.id);
    await expect(page.getByRole("heading", { name: new RegExp(code) })).toBeVisible();
  }
  for (const [index, id] of spuIds.entries()) {
    await page.goto(`/product-specifications?spu=${id}`);
    await expect(page.getByRole("heading", { name: new RegExp(spuCodes[index]!) })).toBeVisible();
    await page.getByRole("button", { name: "绑定多个规格", exact: true }).click();
    const f = page.locator(".pd-spec-batch");
    await expect(f.getByLabel("商品 SPU", { exact: true })).toHaveValue(id);
    await f.getByLabel("尺寸选项", { exact: true }).fill("50mm");
    await f.getByRole("button", { name: "添加颜色", exact: true }).click();
    await f.getByLabel("颜色选项", { exact: true }).fill("BLUE，RED");
    await f.getByRole("button", { name: "预览规格组合", exact: true }).click();
    await f.getByLabel("规格编号 1", { exact: true }).fill("BLUE");
    await f.getByLabel("规格编号 2", { exact: true }).fill("RED");
    await fillSpecificationFacts(f, { prefix: "共用", basis: "diameter", length: "50" });
    await f.getByLabel("默认制作工艺", { exact: true }).selectOption(profile.versionId);
    await f.getByLabel("已逐项核实所选规格的完整商品资料 包括重量与包装测量").check();
    await f.getByRole("button", { name: "保存 2 个规格", exact: true }).click();
    await expect(page.locator(".oc-notice")).toContainText("所选规格已绑定");
    await expect(spuSpecificationRows(page)).toHaveCount(2);
    await page.reload();
    await expect(spuSpecificationRows(page)).toHaveCount(2);
  }
  await page.goto(`/product-specifications?q=${suffix}`);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody tr").first()).toContainText("2 个规格");
  await page.screenshot({
    path: testInfo.outputPath("spu-parent-list-desktop.png"),
    fullPage: true,
  });
  await page.locator("tbody tr").first().getByRole("button", { name: "查看产品与规格" }).click();
  await expect(spuSpecificationRows(page)).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("spu-specifications-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/product-development");
  await page.getByRole("button", { name: "组合生成 SKU", exact: true }).click();
  const combination = page.locator(".pd-combine");
  const options = await centerApi<DevelopmentOptions>("product-development/options");
  const art = options.artworks.find((a) => a.code === artCode)!;
  await combination.getByLabel("选择独立印花").selectOption(art.versionId);
  for (const code of spuCodes)
    for (const color of ["BLUE", "RED"])
      await combination.getByLabel(`选择 ${code} ${color}`, { exact: true }).check();
  await page.getByRole("dialog").getByRole("button", { name: "生成 4 个销售 SKU", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("销售 SKU 已生成");
  await page.getByLabel("搜索编号或名称").fill(artCode);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await page.getByLabel("开发状态").selectOption("pending_adaptation");
  await expect(page.locator("tbody tr")).toHaveCount(4);
  const workspace = await centerApi<DevelopmentWorkspace>(
    `product-development/workspace?q=${artCode}`,
  );
  expect(workspace.total).toBe(4);
  expect(new Set(workspace.items.map((i) => i.spuId)).size).toBe(2);
  await page.locator("tbody tr").first().getByRole("button", { name: "详情", exact: true }).click();
  await page.getByRole("button", { name: "开始制作", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "当前任务生产作图" }).locator("canvas.upper-canvas"),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "当前任务生产作图" })).toContainText(artCode);
  await page.getByRole("button", { name: "返回产品开发", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开制作文件", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "打开制作文件", exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("sales-sku-production-detail.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("multiple sizes and shapes preview, selectively bind, retain row-specific processes and detect saved combinations", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const round = await createCenterProfile("tire_cover", `ROUND-${suffix}`, false);
  const shaped = await createCenterProfile("shaped_pillow", `SHAPE-${suffix}`, false);
  const spu = await createCenterSpu(`QA-OPTIONS-${suffix}`);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/product-specifications?spu=${spu.id}`);
  await page.getByRole("button", { name: "绑定多个规格", exact: true }).click();
  const form = page.locator(".pd-spec-batch");
  await form.getByLabel("尺寸选项", { exact: true }).fill("50 mm，254 mm，50 mm");
  await form.getByRole("button", { name: "添加尺寸选项", exact: true }).click();
  await expect(form.getByLabel("尺寸已选选项").locator(".pd-option-tag")).toHaveCount(2);
  await form.getByRole("button", { name: "添加形状", exact: true }).click();
  await form.getByLabel("形状选项", { exact: true }).fill("圆形，方形");
  await form.getByRole("button", { name: "预览规格组合", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("共 4 个组合，已选 4 个新增规格");
  // Only the two combinations backed by these synthetic factory profiles are saleable.
  await form.getByLabel("选择规格 50 mm · 方形", { exact: true }).uncheck();
  await form.getByLabel("选择规格 254 mm · 圆形", { exact: true }).uncheck();
  await fillSpecificationFacts(form, { prefix: "共用", basis: "diameter", length: "50" });
  await form.getByLabel("默认制作工艺", { exact: true }).selectOption(round.versionId);
  await form.getByLabel("制作工艺 4", { exact: true }).selectOption(shaped.versionId);
  await form
    .locator(".pd-spec-preview tbody tr")
    .nth(3)
    .getByRole("button", { name: "更多设置" })
    .click();
  await fillSpecificationFacts(form.getByRole("group", { name: "规格 4 详细设置" }), { basis: "artwork_longest", length: "254" });
  await form.getByLabel("已逐项核实所选规格的完整商品资料 包括重量与包装测量").check();
  await form.getByRole("heading", { name: "1. 设置规格选项", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("multiple-spec-options-desktop.png"),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: testInfo.outputPath("multiple-spec-options-dark.png"),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page
    .getByRole("heading", { name: "1. 设置规格选项", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("multiple-spec-options-mobile.png"),
    fullPage: false,
  });
  await page
    .getByRole("heading", { name: "3. 确认需要绑定的规格", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("multiple-spec-preview-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Pending option changes cannot silently save an obsolete preview.
  await form.getByLabel("形状选项", { exact: true }).fill("心形");
  await expect(form.getByRole("button", { name: "保存 2 个规格", exact: true })).toBeDisabled();
  await form.getByLabel("形状选项", { exact: true }).fill("");
  await form.getByRole("button", { name: "保存 2 个规格", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("所选规格已绑定");
  await page.reload();
  await expect(page.getByLabel("已绑定规格选项")).toContainText("50 mm、254 mm");
  await expect(page.getByLabel("已绑定规格选项")).toContainText("圆形、方形");
  await expect(spuSpecificationRows(page)).toHaveCount(2);
  const saved = (
    await centerApi<DevelopmentOptions>("product-development/options")
  ).specifications.filter((spec) => spec.spuId === spu.id);
  expect(saved).toHaveLength(2);
  expect(saved.find((spec) => spec.attributes.形状 === "方形")).toMatchObject({
    processProfileVersionId: shaped.versionId,
    facts: {
      physicalDimensions: { basis: "artwork_longest", unit: "mm", length: 254, width: null, height: null },
      material: "Synthetic measured fabric",
      factsConfirmed: true,
    },
  });
  expect(saved.find((spec) => spec.attributes.形状 === "圆形")?.processProfileVersionId).toBe(
    round.versionId,
  );
  await page.getByRole("button", { name: "绑定多个规格", exact: true }).click();
  await form.getByRole("button", { name: "预览规格组合", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("2 个已存在");
  await expect(form.getByLabel("选择规格 50 mm · 圆形", { exact: true })).toBeDisabled();
  await expect(form.getByLabel("选择规格 254 mm · 方形", { exact: true })).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "返回 SPU 详情", exact: true }).click();
  await page
    .getByRole("dialog")
    .locator("tbody tr")
    .first()
    .getByRole("button", { name: "修改规格", exact: true })
    .click();
  await page.getByLabel("规格名称", { exact: true }).fill("Updated synthetic specification");
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("规格版本已保存");
  await expect(spuSpecificationRows(page)).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("dialog").getByRole("table", { name: "产品规格对比", exact: true })).toContainText("Updated synthetic specification");
  expect(errors).toEqual([]);
});
