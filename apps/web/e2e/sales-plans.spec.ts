import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type {
  SalesPlanDetail,
  SalesPlanList,
  SalesPlanOptions,
} from "@yummyai/contracts/catalog/sales-plan";
import type { ProductSpuView } from "@yummyai/contracts/catalog/development";
import { centerApi } from "./order-centers-fixture";

test.skip(
  process.env.E2E_REAL_PRODUCTS !== "1",
  "Use playwright.sales-plans.config.ts with real services",
);

test("one physical SPU supports independent Custom FBM and FBA sales plans across all five steps", async ({
  page,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  const suffix = randomUUID().slice(0, 8).toUpperCase(),
    code = `QA-SALES-${suffix}`;
  const directory = new URL("../../../tmp/sales-plans/", import.meta.url);
  const manifest = new URL(`browser-${suffix}.json`, directory);
  const plans: string[] = [],
    listings: string[] = [],
    errors: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let spu: ProductSpuView | undefined, failure: unknown;
  const persist = (cleanup = "pending") => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify(
        {
          code,
          spu,
          plans,
          listings,
          cleanup,
          errors,
          retainedHistory:
            "archived fixtures and immutable versions; no marketplace or model calls",
        },
        null,
        2,
      ),
    );
  };
  try {
    spu = (
      await centerApi<{ spu: ProductSpuView }>("product-development/spus", {
        code,
        name: `QA 共享商品 ${suffix}`,
        capabilities: {
          processes: "合成测试热转印",
          customizationScope: "照片、文字与固定印花",
          packaging: "单件包装",
        },
        idempotencyKey: randomUUID(),
      })
    ).spu;
    persist();
    await centerApi("product-development/specifications", {
      spuId: spu.id,
      code: `${code}-SPEC`,
      name: "合成测试 50 × 60 英寸规格",
      attributes: { size: "50x60" },
      facts: syntheticSpecificationFacts({
        material: "合成测试面料",
        dimensions: "50x60 inches",
        packageContents: "测试商品一件",
        packageQuantity: 1,
        factsConfirmed: false,
        weightGrams: 500,
        packagedWeightGrams: null,
      }),
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const mode of ["custom", "standard"] as const) {
      await page.goto(`/sales-plans?new=1&spuId=${spu.id}`);
      const form = page.getByRole("form", { name: "新建销售方案" });
      await expect(form).toBeVisible();
      await form.getByLabel("方案名称", { exact: true }).fill(`${code} ${mode}`);
      await form.getByLabel("商品模式", { exact: true }).selectOption(mode);
      if (mode === "custom")
        await expect(
          form.getByLabel("履约方式", { exact: true }).locator('option[value="fba"]'),
        ).toHaveCount(0);
      else await form.getByLabel("履约方式", { exact: true }).selectOption("fba");
      await form.getByRole("button", { name: "创建方案并准备印花" }).click();
      await expect(page).toHaveURL(/plan=[0-9a-f-]{36}/);
      const id = new URL(page.url()).searchParams.get("plan")!;
      plans.push(id);
      persist();
      await page.getByRole("button", { name: /^1\. / }).click();
      await expect(page.getByText("合成测试热转印", { exact: true })).toBeVisible();
      await expect(page.locator(".sp-specifications")).toContainText("500 g");
      await expect(page.locator(".sp-specifications")).toContainText("含包装重量：待确认");
      await page.getByRole("checkbox", { name: /合成测试 50 × 60/ }).check();
      await page.getByRole("button", { name: /^2\. / }).click();
      await page.locator("summary").filter({ hasText: "研究与定位依据" }).click();
      await page
        .getByLabel("目标人群", { exact: true })
        .fill(mode === "custom" ? "宠物主人" : "爱猫家居人群");
      await page
        .getByLabel("使用场景", { exact: true })
        .fill(mode === "custom" ? "纪念赠礼" : "日常家居");
      await page
        .getByLabel("市场调研结论", { exact: true })
        .fill(`Synthetic ${mode} research ${suffix}`);
      await page.getByLabel("核心关键词（每行一个）").fill(`${mode} pillow\ncat gift`);
      // A recoverable save failure must keep the operator's inputs.
      if (mode === "custom") {
        let failOnce = true;
        await page.route(`**/api/sales-plans/${id}`, async (route) => {
          if (route.request().method() === "POST" && failOnce) {
            failOnce = false;
            await route.fulfill({
              status: 409,
              contentType: "application/json",
              body: JSON.stringify({ message: "合成冲突：当前输入继续保留" }),
            });
          } else await route.continue();
        });
        await page.getByRole("button", { name: "保存方案", exact: true }).click();
        await expect(page.locator(".sp-editor").getByRole("alert")).toContainText(
          "当前输入继续保留",
        );
        await expect(page.getByLabel("目标人群", { exact: true })).toHaveValue("宠物主人");
      }
      await page.getByRole("button", { name: "保存方案", exact: true }).click();
      await expect(page.getByText("销售方案已保存", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: /^3\. / }).click();
      await expect(page.getByRole("heading", { name: "商品组合", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "组合印花、规格与制作区域", exact: true })).toBeVisible();
      await page.getByRole("button", { name: /^4\. / }).click();
      await page.getByLabel("标题", { exact: true }).fill(`Synthetic ${mode} pillow ${suffix}`);
      await page
        .getByLabel("五点描述（每行一点）")
        .fill("Synthetic original design\nSynthetic product facts");
      await page
        .getByLabel("商品描述", { exact: true })
        .fill(`Synthetic ${mode} product description`);
      if (mode === "custom") {
        await page.getByRole("button", { name: "添加选择字段" }).click();
        await page.getByLabel("字段名称", { exact: true }).fill("背景颜色");
        await page.getByLabel("选项名称", { exact: true }).fill("蓝色");
        await page.getByLabel("选项值", { exact: true }).fill("blue");
      } else await expect(page.getByRole("button", { name: "添加选择字段" })).toHaveCount(0);
      await page.getByRole("button", { name: "保存方案", exact: true }).click();
      await expect(page.getByText("销售方案已保存", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
        `Synthetic ${mode} pillow ${suffix}`,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: new URL(`mobile-content-${suffix}-${mode}.png`, directory).pathname.replace(
          /^\/(\w:)/,
          "$1",
        ),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: /^5\. / }).click();
      if (mode === "custom")
        await expect(page.getByRole("heading", { name: "Custom 页面配置" })).toBeVisible();
      else await expect(page.getByRole("heading", { name: "FBA 备货衔接" })).toBeVisible();
      await page.getByRole("button", { name: "创建刊登草稿", exact: true }).click();
      await expect(
        page.getByText("本地刊登草稿已保存，请进入刊登审核与平台校验", { exact: true }),
      ).toBeVisible();
      const detail = await centerApi<SalesPlanDetail>(`sales-plans/${id}`);
      listings.push(...detail.listings.map((listing) => listing.id));
      persist();
      expect(detail.plan.spuId).toBe(spu.id);
      expect(detail.plan.fields.fulfillment).toBe(mode === "custom" ? "fbm" : "fba");
      expect(detail.listings[0]?.status).toBe("draft");
      expect(detail.listings[0]?.blockers.length).toBeGreaterThan(0);
      const back = page.url();
      await page.getByRole("link", { name: "编辑、审核与平台提交", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "返回来源页面继续处理", exact: true }),
      ).toHaveAttribute("href", new URL(back).pathname + new URL(back).search);
      await page.getByRole("link", { name: "返回来源页面继续处理", exact: true }).click();
      await expect(page).toHaveURL(back);
      await expect(page.locator(".sp-editor")).toBeVisible();
      await expect(page.locator(".sp-listing")).toContainText(`Synthetic ${mode} pillow ${suffix}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("heading", { name: "上架工作台", exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: new URL(`mobile-${suffix}-${mode}.png`, directory).pathname.replace(/^\/(\w:)/, "$1"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: new URL(`desktop-${suffix}-${mode}.png`, directory).pathname.replace(
          /^\/(\w:)/,
          "$1",
        ),
        fullPage: true,
      });
    }
    expect((await centerApi<SalesPlanList>(`sales-plans?spuId=${spu.id}`)).total).toBe(2);
    expect((await centerApi<SalesPlanDetail>(`sales-plans/${plans[0]}`)).plan.fields.audience).toBe(
      "宠物主人",
    );
    expect((await centerApi<SalesPlanDetail>(`sales-plans/${plans[1]}`)).plan.fields.audience).toBe(
      "爱猫家居人群",
    );
    expect(pageErrors).toEqual([]);
  } catch (error) {
    failure = error;
  } finally {
    if (spu) {
      // Recover creations whose UI response was interrupted; scope to this exact SPU.
      try {
        const active = await centerApi<SalesPlanList>(`sales-plans?spuId=${spu.id}`);
        for (const plan of active.items) if (!plans.includes(plan.id)) plans.push(plan.id);
        persist();
      } catch (error) {
        errors.push(String(error));
      }
      for (const id of plans)
        try {
          const detail = await centerApi<SalesPlanDetail>(`sales-plans/${id}`);
          for (const listing of detail.listings) {
            if (!listings.includes(listing.id)) listings.push(listing.id);
            persist();
            await centerApi(`listings/${listing.id}/archive`, {});
          }
          if (!detail.plan.archived)
            await centerApi(`sales-plans/${id}/archive`, {
              expectedRevision: detail.plan.revision,
              idempotencyKey: randomUUID(),
            });
        } catch (error) {
          errors.push(String(error));
        }
      try {
        await centerApi(`products/plans/${spu.productPlanId}/transitions`, { status: "archived" });
        expect((await centerApi<SalesPlanList>(`sales-plans?spuId=${spu.id}`)).total).toBe(0);
        expect((await centerApi<SalesPlanList>(`sales-plans?q=${code}`)).total).toBe(0);
        expect(
          (await centerApi<SalesPlanOptions>("sales-plans/options")).spus.some(
            (item) => item.id === spu!.id,
          ),
        ).toBe(false);
        const catalog = await centerApi<{ items: Array<{ id: string }>; total: number }>(
          `listings/catalog?q=${code}`,
        );
        expect(catalog.items).toHaveLength(0);
      } catch (error) {
        errors.push(String(error));
      }
    }
    persist(errors.length ? "incomplete" : "verified-active-lists-search-and-counts-clear");
  }
  if (failure) throw failure;
  expect(errors, "Fixture teardown").toEqual([]);
});
