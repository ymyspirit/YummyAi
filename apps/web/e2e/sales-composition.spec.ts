import { expect, test, type Page } from "@playwright/test";
import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { withTenant, skus, salesRecipeVersions } from "@yummyai/database";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";
import { centerApi } from "./order-centers-fixture";
import { loginErp } from "./erp-identity-fixture";

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on("pageerror", (e) => list.push(e.message));
});
test.afterEach(({ page }) => expect(errors.get(page) ?? []).toEqual([]));
test("the default multi-print toggle cannot create a duplicate legacy single-print SKU", async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await salesLaunchFixture({ pillow: true });
  try {
    const before = await withTenant(f.database.db, f.context, (tx) =>
      tx.select().from(skus).where(eq(skus.spuId, f.spu.id)),
    );
    await loginErp(
      page,
      "operator",
      `/product-development?compose=1&artworkVersionId=${f.artwork.versionId}`,
    );
    const form = page.locator("form:has(fieldset.pd-combine)");
    await form
      .getByRole("combobox", { name: "选择独立印花", exact: true })
      .selectOption(f.artwork.versionId);
    await form
      .getByRole("checkbox", { name: `选择 ${f.spec.spuCode} ${f.spec.code}`, exact: true })
      .check();
    await form
      .getByRole("textbox", { name: `${f.spec.spuCode} ${f.spec.code} 销售 SKU`, exact: true })
      .fill(f.recipe.skuCode + "-ALIAS");
    await form
      .getByRole("checkbox", { name: "为同一商品配置多个印花、制作面或区域", exact: true })
      .check();
    const requests: Array<{ printBindings?: unknown; artworkVersionId?: string }> = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/api/product-development/combinations")
      )
        requests.push(request.postDataJSON());
    });
    await page.getByRole("button", { name: "生成 1 个销售 SKU", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "已存在销售 SKU" })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.printBindings).toBeDefined();
    await expect(
      form.getByRole("textbox", { name: `${f.spec.spuCode} ${f.spec.code} 销售 SKU`, exact: true }),
    ).toHaveValue(f.recipe.skuCode + "-ALIAS");
    expect(
      await withTenant(f.database.db, f.context, (tx) =>
        tx.select().from(skus).where(eq(skus.spuId, f.spu.id)),
      ),
    ).toEqual(before);
  } finally {
    await f.close();
  }
});

test("archival stops productive recipe controls; original package export and history survive a late active response", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await salesLaunchFixture({ pillow: true });
  let release: (() => void) | undefined;
  try {
    const original = await f.finish();
    await loginErp(page, "operator", `/product-development?sku=${f.recipe.skuId}`);
    await expect(page.getByRole("button", { name: "创建新版本", exact: true })).toHaveCount(1);
    let entered!: () => void,
      once = true;
    const started = new Promise<void>((resolve) => (entered = resolve)),
      held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/product-development/skus/${f.recipe.skuId}`, async (route) => {
      if (!once) return route.continue();
      once = false;
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await started;
    await centerApi(`products/plans/${f.spu.productPlanId}/transitions`, { status: "archived" });
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    const banner = page.getByRole("status").filter({ hasText: "产品或销售 SKU 已归档" });
    await expect(banner).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "创建新版本", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "审核并封存资料包", exact: true }),
    ).toBeDisabled();
    const origin = new URL(page.url()).origin;
    const base = {
      idempotencyKey: crypto.randomUUID(),
      reason: "Synthetic archived source command",
    };
    const commands: [string, unknown][] = [
      [
        `skus/${f.recipe.skuId}/revisions`,
        {
          ...base,
          artworkVersionId: f.artwork.versionId,
          specificationVersionId: f.spec.versionId,
          expectedVersion: 1,
        },
      ],
      [
        `recipes/${f.recipe.id}/actions`,
        { ...base, idempotencyKey: crypto.randomUUID(), action: "start_adaptation" },
      ],
      [
        "listings",
        {
          recipeIds: [f.recipe.id],
          platform: "amazon",
          marketplaceId: "ATVPDKIKX0DER",
          locale: "en-US",
          title: "Synthetic archived draft",
          idempotencyKey: crypto.randomUUID(),
        },
      ],
      [
        "packages",
        {
          ...base,
          idempotencyKey: crypto.randomUUID(),
          recipeId: f.recipe.id,
          listingId: original.manifest.listing.id,
          listingVersionId: original.manifest.listing.versionId,
          imageEvidence: original.manifest.imageEvidence,
        },
      ],
    ];
    for (const [path, data] of commands) {
      const denied = await page.request.post(`/api/product-development/${path}`, {
        data,
        headers: { origin },
      });
      expect(denied.status()).toBe(409);
      expect((await denied.json()).message).toContain("归档");
    }
    const before = await withTenant(f.database.db, f.context, (tx) =>
      tx.select().from(salesRecipeVersions).where(eq(salesRecipeVersions.skuId, f.recipe.skuId)),
    );
    const response = await page.request.get(
      `/api/product-development/packages/${original.packageId}/export`,
    );
    expect(response.status()).toBe(200);
    const zip = await JSZip.loadAsync(await response.body(), { checkCRC32: true });
    expect(JSON.parse(await zip.file("manifest.json")!.async("string"))).toEqual(original.manifest);
    expect(
      await withTenant(f.database.db, f.context, (tx) =>
        tx.select().from(salesRecipeVersions).where(eq(salesRecipeVersions.skuId, f.recipe.skuId)),
      ),
    ).toEqual(before);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await banner.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`archived-composition-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  } finally {
    release?.();
    await f.close();
  }
});
