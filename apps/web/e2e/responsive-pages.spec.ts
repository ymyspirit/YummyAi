import { expect, test, type Page } from "@playwright/test";
import { CaptureDraftSchema } from "@yummyai/contracts";
import { FUNCTION_DESTINATIONS } from "../src/features/navigation/navigation-registry";
import { centerApi } from "./order-centers-fixture";
import { syntheticSupplierProfile } from "../../../tools/testing/factory-fixtures";
import { writeFile } from "node:fs/promises";

async function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page width ${document.documentElement.scrollWidth}/${innerWidth}`);
    for (const element of document.querySelectorAll<HTMLElement>(".erp-page-content :is(button, input, select, textarea, h1, h2)")) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || element.closest('[inert], [aria-hidden="true"]')) continue;
      let parent = element.parentElement, clipped = box.left < -1 || box.right > innerWidth + 1;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        // Wide data tables and tab strips can scroll within their own region.
        if (["auto", "scroll"].includes(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) { clipped = false; break; }
        if (["hidden", "clip"].includes(style.overflowX) && (box.left < bounds.left - 1 || box.right > bounds.right + 1)) clipped = true;
        parent = parent.parentElement;
      }
      if (clipped) problems.push(`${element.tagName}.${element.className}: ${(element.textContent || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 60)}`);
    }
    return [...new Set(problems)];
  });
}

test("research actions and complete metadata fit their content region at every width", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const suffix = crypto.randomUUID().slice(0, 8), externalId = String(Date.now());
  const title = `QA Responsive ${suffix} Personalized Crystal Employee Award Retirement Appreciation Custom Company Retirement Plaque ${"LongProductName".repeat(8)}`;
  const receipt = await centerApi<{ researchItemId: string }>("captures", CaptureDraftSchema.parse({
    platform: "etsy", parserVersion: "etsy@1.0.0", extensionVersion: "0.0.0", marketplace: "www.etsy.com",
    sourceUrl: `https://www.etsy.com/listing/${externalId}/${"personalized-gift-".repeat(15)}`, externalId, title,
    domain: "research", capturedAt: new Date().toISOString(), price: { raw: "$46.60", amount: 46.6, currency: "USD" },
    rating: null, reviewCount: null, taxonomy: [{ label: "Trophies & Awards", url: "https://www.etsy.com/c/trophies" }],
    listingPublishedAt: null, favoriteCount: null, shipping: null, shop: null, reviewSummary: null, reviews: [],
    reviewCollection: { collectedCount: 0, reportedTotal: null, pageCount: 0, status: "visible", updatedAt: new Date().toISOString() },
    bullets: [], variants: [], productInformation: [], contentBlocks: [], missingFields: [], diagnostics: [], captureStatus: "complete", media: [],
  }));
  try {
    await page.goto(`/research?q=${suffix}`);
    await expect(page.getByLabel("最低价格", { exact: true })).toBeHidden();
    await page.getByText("更多筛选", { exact: true }).click();
    await expect(page.getByLabel("最低价格", { exact: true })).toBeVisible();
    await page.getByLabel("最低价格", { exact: true }).fill("10");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(page.getByLabel("最低价格", { exact: true })).toHaveValue("10");
    await expect(page.getByLabel("最低价格", { exact: true })).toBeVisible();
    await page.getByText("更多筛选 · 1 项已应用", { exact: true }).click();
    const row = page.locator(".research-summary-row").filter({ hasText: title });
    await expect(row).toBeVisible();
    for (const width of [1920, 1440, 1280, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => layoutProblems(page)).toEqual([]);
      const region = await page.locator(".research-table-scroll").boundingBox();
      for (const name of ["查看详情", "归档"]) {
        const button = row.getByRole("button", { name, exact: true });
        const bounds = await button.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(region!.x);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(region!.x + region!.width);
      }
      expect(await page.locator(".research-table-scroll").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await row.getByRole("button", { name: "查看详情", exact: true }).click();
      await expect(page.locator(".research-dossier")).toBeVisible();
      await expect.poll(() => layoutProblems(page)).toEqual([]);
      await row.getByRole("button", { name: "收起", exact: true }).click();
      await expect(row.locator(".spin")).toHaveCount(0);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`research-${width}.png`), fullPage: true, animations: "disabled", caret: "initial" });
    }
  } finally {
    await centerApi("research-items/archive", { itemIds: [receipt.researchItemId], archived: true });
  }
});

test("all registered workspaces keep controls readable on desktop tablet and phone", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors: string[] = [], audit: { route: string; width: number; problems: string[] }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const destinations = [...new Set(FUNCTION_DESTINATIONS.map(item => item.href))];
  for (const route of destinations) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(route);
    await expect(page.locator(".erp-page-content")).toBeVisible();
    await page.waitForLoadState("networkidle");
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const problems = await layoutProblems(page);
      audit.push({ route, width, problems });
      expect.soft(problems, `${route} at ${width}px`).toEqual([]);
      if (width !== 1024) await page.screenshot({ path: testInfo.outputPath(`${route.replace(/[^a-z0-9]/gi, "-") || "home"}-${width}.png`), fullPage: true, animations: "disabled", caret: "initial" });
    }
  }
  await testInfo.attach("layout-audit", { body: JSON.stringify(audit, null, 2), contentType: "application/json" });
  await writeFile(testInfo.outputPath("layout-audit.json"), JSON.stringify(audit, null, 2));
  expect(errors).toEqual([]);
});

test("populated product print order and supplier lists wrap long business values", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  const suffix = crypto.randomUUID().slice(0, 8), name = `QA ${suffix} ${"PersonalizedCustomProduct".repeat(5)}`;
  // The suite owns the disposable database and removes all records and assets in
  // its finally block, including when a browser assertion fails.
  await centerApi("product-development/spus", { code: `SPU-${suffix}`, name, idempotencyKey: crypto.randomUUID() });
  await centerApi("product-development/artworks", {
    code: `ART-${suffix}`, name, mode: "customer_image", expectedVersion: 0, idempotencyKey: crypto.randomUUID(),
    customization: { version: 1, fields: [{ key: "photo", label: "Customer image", type: "image", required: true, validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } }] }, instructions: "Synthetic layout acceptance only",
  });
  await centerApi("sourcing/suppliers", { name, profile: syntheticSupplierProfile, kind: "manual", regionCode: "CN", settlementCurrency: "USD" });
  const account = await centerApi<{ id: string }>("marketplace-accounts", { platform: "amazon", displayName: `QA ${suffix}`, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] });
  const externalId = `QA-LAYOUT-${suffix}`;
  await centerApi("orders/reports/import", {
    accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-responsive.txt",
    content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${externalId}\tITEM-${suffix}\t${new Date().toISOString()}\tSKU-${suffix}\t${name}\t2\tUSD\t40.00`,
  });
  for (const route of ["/product-specifications", "/print-library", "/suppliers", "/orders"]) {
    await page.goto(`${route}?q=${suffix}`);
    await expect(page.locator(".erp-page-content")).toContainText(route === "/orders" ? externalId : name);
    await page.waitForLoadState("networkidle");
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => layoutProblems(page), { message: `${route} at ${width}` }).toEqual([]);
      if (["/product-specifications", "/print-library"].includes(route)) {
        expect(await page.locator(".pd-record-table").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      }
      if (route === "/suppliers") {
        const region = page.locator(".record-responsive");
        expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const action = region.getByRole("button", { name: `编辑供应商 ${name}`, exact: true });
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport();
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.screenshot({ path: testInfo.outputPath(`${route.slice(1)}-${width}.png`), fullPage: true, animations: "disabled", caret: "initial" });
    }
  }
});
