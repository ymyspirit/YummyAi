import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { RuleWorkspace } from "@yummyai/contracts/rules";
import { centerApi, createCenterSpu, createCenterProfile } from "./order-centers-fixture";

// Ordinary API + real tenant DB. The isolated runner destroys every fixture resource.
test("business directories guide edits, inherit product rules and retain version history", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const product = await createCenterSpu("E2E-RULE-NEW-PRODUCT");
  const tire = await createCenterSpu("E2E-RULE-TIRE");
  const profile = await createCenterProfile("tire_cover", "RULE-DIRECTORY", false);
  await centerApi("product-development/specifications", {
    spuId: tire.id, code: "DEFAULT", name: "Synthetic tire specification", attributes: { size: "fixture" },
    facts: syntheticSpecificationFacts({ material: "Synthetic fabric", dimensions: "50 mm", packageContents: "One item", packageQuantity: 1, factsConfirmed: true }),
    processProfileVersionId: profile.versionId, expectedVersion: 0, idempotencyKey: randomUUID(),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/rules");
  await page.getByRole("button", { name: "登记已确认的制作规范", exact: true }).click();
  const directory = page.getByRole("navigation", { name: "规则目录" });
  const drawer = page.getByRole("dialog");
  const article = (name: string) => page.getByRole("article", { name, exact: true });
  await expect(page.getByRole("heading", { name: "通用制作要求", exact: true })).toBeVisible();
  await expect(article("各模块测试完成后清理测试数据")).toHaveCount(0);
  await directory.getByRole("button", { name: /^异形抱枕/ }).click();
  const factory = article("异形抱枕工厂交付标准");
  await expect(factory.getByText("JPG · 白底 · 150 DPI", { exact: true })).toBeVisible();
  await expect(factory.getByText("600 × 200 px", { exact: true })).toBeVisible();
  await expect(factory.getByRole("button", { name: "编辑要求" })).toHaveCount(0);
  await factory.getByRole("link", { name: "前往工艺底稿" }).click();
  await expect(page.getByRole("heading", { name: "工艺底稿库" })).toBeVisible();
  await page.getByRole("link", { name: "返回原任务", exact: true }).click();
  await expect(drawer.getByText("JPG · 白底 · 150 DPI", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await directory.getByRole("button", { name: /^异形抱枕/ }).click();
  const contour = article("主体与裁剪线分开处理");
  await contour.getByRole("button", { name: "编辑要求", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "编辑要求", exact: true })).toBeVisible();
  await drawer.getByRole("textbox", { name: "制作要求 / 核验要求", exact: true }).fill("Synthetic V2: inspect the contour without changing the artwork");
  await drawer.getByLabel("变更说明", { exact: true }).fill("Synthetic manual rule revision");
  await drawer.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "启用 V2", exact: true })).toBeEnabled();
  await expect(drawer.getByText("已启用 V1 · 草稿 V2", { exact: true })).toBeVisible();
  await drawer.getByLabel("查看规则版本", { exact: true }).selectOption("1");
  await expect(drawer.getByText("Synthetic V2: inspect the contour without changing the artwork", { exact: true })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "启用 V2", exact: true })).toBeDisabled();
  await drawer.getByLabel("查看规则版本", { exact: true }).selectOption("2");
  await drawer.getByRole("button", { name: "启用 V2", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(contour).toContainText("Synthetic V2");

  await page.getByRole("textbox", { name: "搜索商品目录" }).fill("E2E-RULE-NEW-PRODUCT");
  await directory.getByRole("button", { name: /E2E-RULE-NEW-PRODUCT/ }).click();
  await expect(factory).toHaveCount(0);
  await expect(article("保留顾客原图与处理来源")).toContainText("沿用通用规则");
  await page.getByRole("button", { name: "新增专属要求", exact: true }).click();
  await expect(drawer.getByRole("combobox", { name: "适用范围", exact: true })).toHaveValue("spu");
  await expect(drawer.getByRole("combobox", { name: "指定 SPU", exact: true })).toHaveValue(product.id);
  await drawer.getByLabel("规则名称", { exact: true }).fill("Synthetic new product requirement");
  await drawer.getByRole("textbox", { name: "制作要求 / 核验要求", exact: true }).fill("Synthetic new product: inspect text direction");
  await drawer.getByRole("textbox", { name: "依据 / 来源", exact: true }).fill("Synthetic factory document");
  await drawer.getByLabel("变更说明", { exact: true }).fill("Synthetic product-specific requirement");
  await drawer.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "启用 V1", exact: true })).toBeEnabled();
  await drawer.getByRole("button", { name: "启用 V1", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(article("Synthetic new product requirement")).toContainText("已启用 V1");
  const secondContext = await browser.newContext();
  try {
    const other = await secondContext.newPage();
    await other.goto("http://localhost:3100/settings/rules?scope=spu:" + product.id);
    await expect(other.getByRole("article", { name: "Synthetic new product requirement", exact: true })).toContainText("已启用 V1");
  } finally { await secondContext.close(); }

  await page.getByRole("textbox", { name: "搜索商品目录" }).fill("E2E-RULE-TIRE");
  await directory.getByRole("button", { name: /E2E-RULE-TIRE/ }).click();
  await expect(article("Synthetic new product requirement")).toHaveCount(0);
  await expect(factory).toHaveCount(0);
  const workspace = await centerApi<RuleWorkspace>("rules/workspace");
  expect(workspace.spus.find(spu => spu.id === tire.id)?.productTypes).toEqual(["tire_cover"]);
  await directory.getByRole("button", { name: /^日常操作规范/ }).click();
  await expect(article("各模块测试完成后清理测试数据")).toBeVisible();
  await expect(article("所有顾客图片执行保真美化")).toHaveCount(0);
  await directory.getByRole("button", { name: /^异形抱枕/ }).click();
  await page.screenshot({ path: testInfo.outputPath("rules-directory-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByRole("combobox", { name: "执行方式", exact: true }).selectOption("unavailable");
  await expect(factory).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await article("有效分辨率不足时的超分处理").getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(drawer.getByText("尚未接入", { exact: true })).toBeVisible();
  const bounds = await drawer.boundingBox();
  expect(bounds?.y).toBe(0); expect(bounds?.height).toBe(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rules-directory-mobile.png") });
});
