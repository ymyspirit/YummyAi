import { expect, test } from "@playwright/test";
import type { DevelopmentOptions, ProductSpuView, SpecificationView } from "@yummyai/contracts/catalog/development";
import type { RuleWorkspace } from "@yummyai/contracts/rules";
import { actors, loginErp } from "./erp-identity-fixture";
import { centerApi, createCenterProfile, createCenterSpu } from "./order-centers-fixture";
import { fillSpecificationFacts } from "./specification-facts-form";

// Real personal login, source rules and business APIs, confined to the disposable runner.
// Synthetic art only establishes a fixture process; no paid model or factory release.
test("production-purpose adopts an exact factory rule without inventing net weight or size", async ({ page }, info) => {
  test.setTimeout(180_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  const profile = await createCenterProfile("shaped_pillow", suffix, false);
  const spu = await createCenterSpu("PRODUCTION-" + suffix) as ProductSpuView;
  await centerApi("rules/initialize", {});
  const rules = await centerApi<RuleWorkspace>("rules/workspace");
  const factory = rules.rules.find(row => row.code === "system:pillow-factory")!;
  expect(factory.active?.binding).toBe("pillow_factory");
  const { specification } = await centerApi<{ specification: SpecificationView }>("product-development/specifications", {
    spuId: spu.id, code: "SIZE-16IN", name: "Synthetic 16 inch source", attributes: { size: "16 inch" },
    facts: { formatVersion: 2, material: "Synthetic verified fabric", structure: "Synthetic verified two-panel construction",
      dimensions: "", physicalDimensions: null, packageContents: "One synthetic pillow", packageQuantity: 1,
      weightGrams: null, packagedWeightGrams: 390.0894382, factsConfirmed: false,
      verificationReference: "Synthetic factory evidence; disposable fixture only" },
    processProfileVersionId: profile.versionId, expectedVersion: 0, idempotencyKey: crypto.randomUUID(),
  });
  const href = (versionId: string) => `/product-specifications?spu=${spu.id}&form=1&specificationVersionId=${versionId}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", href(specification.versionId));
  const form = page.getByRole("dialog");
  const production = form.getByRole("checkbox", { name: "生产资料已核对", exact: true });
  const commercial = form.getByRole("checkbox", { name: "完整商品资料已核实 包括重量与包装测量", exact: true });
  await expect(production).toBeDisabled();
  await form.locator(".pd-production-rules > summary").click();
  const factoryArticle = form.locator(".pd-production-rule").filter({ hasText: factory.active!.name });
  await factoryArticle.getByRole("button", { name: "采用工厂尺寸口径", exact: true }).click();
  await expect(form.getByLabel("尺寸口径", { exact: true })).toHaveValue("artwork_longest");
  await expect(form.getByLabel("图案主体最长边", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("商品净重（克）", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("含包装重量（克）", { exact: true })).toHaveValue("390.0894382");
  await form.getByLabel("尺寸单位", { exact: true }).selectOption("in");
  await form.getByLabel("图案主体最长边", { exact: true }).fill("16");
  await expect(production).toBeEnabled();
  await production.check();
  await expect(commercial).not.toBeChecked();
  await form.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("规格版本已保存");
  const saved = (await centerApi<DevelopmentOptions>("product-development/options")).specifications.find(row => row.id === specification.id)!;
  const exactReference = { ruleId: factory.id, versionId: factory.active!.id, version: factory.active!.version };
  expect(saved).toMatchObject({ version: 2, facts: { factsConfirmed: false, productionConfirmed: true,
    weightGrams: null, packagedWeightGrams: 390.0894382, productionRuleReferences: [exactReference],
    physicalDimensions: { basis: "artwork_longest", unit: "in", length: 16, width: null, height: null } },
    factVerification: null, productionVerification: { confirmedByUserId: actors().operator.userId, confirmedAt: saved.createdAt } });
  await page.goto(href(saved.versionId));
  await expect(production).toBeChecked();
  await form.locator(".pd-production-fields").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("production-purpose-desktop.jpg"), type: "jpeg", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await form.locator(".pd-production-fields").scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("production-purpose-mobile.jpg"), type: "jpeg", fullPage: false });
  await form.getByLabel("含包装重量（克）", { exact: true }).fill("400");
  await expect(production).not.toBeChecked();
  await expect(commercial).not.toBeChecked();
  await expect(form.getByLabel("商品净重（克）", { exact: true })).toHaveValue("");
});

test("production-purpose batch confirms selected rows independently from commercial facts", async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  const profile = await createCenterProfile("tire_cover", suffix, false);
  const spu = await createCenterSpu("PRODUCTION-BATCH-" + suffix) as ProductSpuView;
  await loginErp(page, "operator", `/product-specifications?spu=${spu.id}&form=1`);
  const form = page.locator(".pd-spec-batch");
  await form.getByLabel("尺寸选项", { exact: true }).fill("Blue, Red");
  await form.getByRole("button", { name: "预览规格组合", exact: true }).click();
  await fillSpecificationFacts(form, { prefix: "共用", basis: "diameter", length: "50" });
  await form.getByLabel("共用商品净重（克）", { exact: true }).fill("");
  await form.getByLabel("默认制作工艺", { exact: true }).selectOption(profile.versionId);
  const production = form.getByRole("checkbox", { name: "所选规格共用生产资料已核对", exact: true });
  await expect(production).toBeEnabled();
  await production.check();
  await expect(form.getByLabel("已逐项核实所选规格的完整商品资料 包括重量与包装测量", { exact: true })).not.toBeChecked();
  await form.getByRole("button", { name: "保存 2 个规格", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("所选规格已绑定");
  const saved = (await centerApi<DevelopmentOptions>("product-development/options")).specifications.filter(row => row.spuId === spu.id);
  expect(saved).toHaveLength(2);
  expect(saved.every(row => row.version === 1 && row.facts.weightGrams === null && row.facts.productionConfirmed &&
    !row.facts.factsConfirmed && row.factVerification === null && row.productionVerification?.confirmedByUserId === actors().operator.userId)).toBe(true);
});
