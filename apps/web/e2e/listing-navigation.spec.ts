import { expect, test } from "@playwright/test";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, listings, productPlans, spus, withTenant } from "@yummyai/database";
import { inArray } from "drizzle-orm";
import { centerApi, createCenterSpu } from "./order-centers-fixture";

test("Listing queue saves a real version and preserves edits on a concurrent version conflict", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const database = connectDatabase();
  const context: TenantContext = {
    tenantId: "019f7600-0000-7000-8000-000000000001",
    userId: "019f7600-0000-7000-8000-000000000002",
    dataScope: "tenant",
    permissions: [],
  };
  const prefix = `E2E-NAV-${createEntityId().slice(-8)}`;
  const spuIds: string[] = [],
    listingIds: string[] = [];
  const content = (n: number) => ({
    platform: "etsy",
    locale: "en-US",
    title: `${prefix}-${n}`,
    description: "Synthetic navigation fixture",
    bullets: [],
    tags: [],
    mediaAssetIds: [],
    variants: [],
    attributes: {},
    compliance: {},
  });
  try {
    for (const n of [1, 2]) {
      const spu = await createCenterSpu(`${prefix}-${n}`);
      spuIds.push(spu.id);
      const result = await centerApi<{ listing: { id: string } }>("listings", {
        spuId: spu.id,
        platform: "etsy",
        marketplaceId: "US",
        locale: "en-US",
        content: content(n),
      });
      listingIds.push(result.listing.id);
    }
    await page.route("**/api/ai-assists/**", (route) => route.fulfill({ json: [] }));
    await page.goto(`/listings?q=${prefix}&sort=title&direction=asc`);
    await page.getByRole("link", { name: "连续修订", exact: true }).click();
    const title = page.getByRole("textbox", { name: /^商品标题/ });
    await expect(title).toHaveValue(`${prefix}-1`);
    await title.fill(`${prefix}-1 revised`);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "下一条", exact: true }).click();
    await expect(title).toHaveValue(`${prefix}-1 revised`);
    await page.getByRole("button", { name: "保存并下一条", exact: true }).click();
    await expect(title).toHaveValue(`${prefix}-2`);
    const versions = await centerApi<unknown[]>(`listings/${listingIds[0]}/versions`);
    expect(versions).toHaveLength(2);
    await centerApi(`listings/${listingIds[1]}/versions`, {
      ...content(2),
      description: "A concurrent synthetic version",
    });
    await title.fill(`${prefix}-2 keep this edit`);
    await page.getByRole("button", { name: "保存并返回列表", exact: true }).click();
    await expect(page.locator(".listing-save-notice.error")).toBeVisible();
    await expect(title).toHaveValue(`${prefix}-2 keep this edit`);
    await expect(page.getByText("本页 2 / 2", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("listing-queue-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("listing-queue-mobile.png") });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("link", { name: "返回来源页面继续处理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Listing 目录", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("q")).toBe(prefix);
  } finally {
    await withTenant(database.db, context, async (tx) => {
      if (listingIds.length)
        await tx
          .update(listings)
          .set({ status: "archived" })
          .where(inArray(listings.id, listingIds));
      if (spuIds.length) {
        const rows = await tx
          .select({ plan: spus.productPlanId })
          .from(spus)
          .where(inArray(spus.id, spuIds));
        await tx.update(spus).set({ status: "archived" }).where(inArray(spus.id, spuIds));
        if (rows.length)
          await tx
            .update(productPlans)
            .set({ status: "archived" })
            .where(
              inArray(
                productPlans.id,
                rows.map((row) => row.plan),
              ),
            );
      }
    });
    await database.client.end();
  }
});
