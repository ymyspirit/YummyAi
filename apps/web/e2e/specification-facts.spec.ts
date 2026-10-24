import { expect, test } from "@playwright/test";
import type { DevelopmentOptions, ProductSpuView, SpecificationView } from "@yummyai/contracts/catalog/development";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { Permission } from "@yummyai/authz/permissions";
import { centerApi, createCenterProfile, createCenterSpu } from "./order-centers-fixture";
import { fillSpecificationFacts } from "./specification-facts-form";

// Real business API and personal Web identity, confined to the disposable runner.
test("measured specification facts preserve unknown drafts and pin an actual confirmation actor", async ({ page }, info) => {
  test.setTimeout(180000);
  const suffix = crypto.randomUUID().slice(0, 8), profile = await createCenterProfile("tire_cover", suffix, false);
  const spu = await createCenterSpu("FACTS-" + suffix) as ProductSpuView;
  const { specification } = await centerApi<{ specification: SpecificationView }>("product-development/specifications", {
    spuId: spu.id, code: "UNMEASURED", name: "Synthetic unmeasured blue", attributes: { color: "Blue" },
    facts: { formatVersion: 2, material: "", dimensions: "", packageContents: "", packageQuantity: null, factsConfirmed: false },
    processProfileVersionId: profile.versionId, expectedVersion: 0, idempotencyKey: crypto.randomUUID(),
  });
  const href = (versionId: string) => "/product-specifications?spu=" + spu.id + "&form=1&specificationVersionId=" + versionId;
  await loginErp(page, "operator", href(specification.versionId));
  const form = page.getByRole("dialog");
  await expect(form.getByLabel("尺寸口径", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("每份件数", { exact: true })).toHaveValue("");
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/api\/product-development\/specifications$/.test(request.url())) writes++; });
  await form.getByRole("checkbox", { name: "已核实材质、尺寸和包装内容", exact: true }).check();
  await form.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("尺寸");
  expect(writes).toBe(0);
  await fillSpecificationFacts(form, { basis: "diameter", length: "50" });
  const confirmation = form.getByRole("checkbox", { name: "已核实材质、尺寸和包装内容", exact: true });
  await expect(confirmation).not.toBeChecked();
  await confirmation.check();
  await form.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("规格版本已保存");
  const options = await centerApi<DevelopmentOptions>("product-development/options");
  const saved = options.specifications.find(row => row.id === specification.id)!;
  expect(saved.version).toBe(2);
  expect(saved.facts).toMatchObject({ physicalDimensions: { basis: "diameter", unit: "mm", length: 50 }, packageQuantity: 1, factsConfirmed: true });
  expect(saved.factVerification).toMatchObject({ confirmedByUserId: actors().operator.userId, confirmedAt: saved.createdAt });
  const savedFacts = page.getByRole("dialog").locator("tbody");
  await expect(savedFacts).toContainText("Synthetic measured fabric");
  await expect(savedFacts).toContainText("50 mm");
  await expect(savedFacts).toContainText("事实已核实");
  await expect(savedFacts).toContainText("确认于");
  await expect(savedFacts).toContainText("V2");
  await page.screenshot({ path: info.outputPath("measured-facts-desktop.png"), fullPage: false });
  await page.goto(href(saved.versionId));
  await expect(confirmation).toBeChecked();
  await form.getByLabel("产品结构", { exact: true }).fill("Synthetic revised construction awaiting confirmation");
  await expect(confirmation).not.toBeChecked();
  await page.reload();
  await expect(form.getByLabel("产品结构", { exact: true })).toHaveValue("Synthetic revised construction awaiting confirmation");
  await expect(confirmation).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await form.getByLabel("实际直径", { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("measured-facts-mobile.png"), fullPage: false });
  await form.getByLabel("核验依据", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("measured-facts-packaging-mobile.png"), fullPage: false });
  await form.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("规格版本已保存");
  const changed = (await centerApi<DevelopmentOptions>("product-development/options")).specifications.find(row => row.id === saved.id)!;
  expect(changed).toMatchObject({ version: 3, facts: { factsConfirmed: false }, factVerification: null });
  expect(writes).toBe(2);
});

test("batch specification labels do not invent measurements or package counts", async ({ page }, info) => {
  test.setTimeout(180000);
  const suffix = crypto.randomUUID().slice(0, 8), profile = await createCenterProfile("tire_cover", suffix, false);
  const spu = await createCenterSpu("FACTS-BATCH-" + suffix) as ProductSpuView;
  await loginErp(page, "operator", "/product-specifications?spu=" + spu.id + "&form=1");
  const form = page.locator(".pd-spec-batch");
  await form.getByLabel("尺寸选项", { exact: true }).fill("Blue, Red");
  await form.getByRole("button", { name: "预览规格组合", exact: true }).click();
  await expect(form.getByText("口径与测量值待填写", { exact: true })).toHaveCount(2);
  await expect(form.getByLabel("共用每份件数", { exact: true })).toHaveValue("");
  await form.getByLabel("默认制作工艺", { exact: true }).selectOption(profile.versionId);
  await form.getByLabel("已逐项核实所选规格的产品事实 核验依据与工艺", { exact: true }).check();
  await form.getByRole("button", { name: "保存 2 个规格", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("尺寸");
  expect((await centerApi<DevelopmentOptions>("product-development/options")).specifications.some(row => row.spuId === spu.id)).toBe(false);
  await fillSpecificationFacts(form, { prefix: "共用", basis: "diameter", length: "50" });
  await form.getByLabel("已逐项核实所选规格的产品事实 核验依据与工艺", { exact: true }).check();
  await form.getByRole("button", { name: "保存 2 个规格", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("所选规格已绑定");
  const saved = (await centerApi<DevelopmentOptions>("product-development/options")).specifications.filter(row => row.spuId === spu.id);
  expect(saved).toHaveLength(2);
  expect(saved.every(row => row.facts.physicalDimensions?.length === 50 && row.facts.packageQuantity === 1 && row.factVerification?.confirmedByUserId === actors().operator.userId)).toBe(true);
  await page.screenshot({ path: info.outputPath("batch-facts-saved.png"), fullPage: true });
});

test("losing ERP access clears an unsaved product session draft before redirecting", async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8), spu = await createCenterSpu("FACTS-PRIVATE-" + suffix) as ProductSpuView;
  const { specification } = await centerApi<{ specification: SpecificationView }>("product-development/specifications", {
    spuId: spu.id, code: "PRIVATE", name: "Synthetic draft", attributes: { sample: "A" },
    facts: { formatVersion: 2, material: "", dimensions: "", packageContents: "", packageQuantity: null, factsConfirmed: false },
    processProfileVersionId: null, expectedVersion: 0, idempotencyKey: crypto.randomUUID(),
  });
  await loginErp(page, "operator", "/product-specifications?spu=" + spu.id + "&form=1&specificationVersionId=" + specification.versionId);
  await page.getByRole("dialog").getByLabel("实际材质", { exact: true }).fill("Synthetic private unsaved product data");
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("yummyai:product-task-draft:v1:")).length)).toBeGreaterThan(0);
  try {
    await changeErpRights("operator", []);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("yummyai:product-task-draft:v1:")).length)).toBe(0);
  } finally { await changeErpRights("operator", Object.values(Permission)); }
});
