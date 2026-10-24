import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  withTenant,
  marketplaceAccounts,
  salesChannelBindings,
  salesPackageVersions,
} from "@yummyai/database";
import { createEntityId } from "@yummyai/contracts";
import { OrderSalesDeliverySnapshotSchema } from "@yummyai/contracts/catalog/sales-plan-delivery";
import { Permission } from "@yummyai/authz";
import type {
  SalesPlanDelivery,
  DeliveryReview,
} from "@yummyai/contracts/catalog/sales-plan-delivery";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";
import { centerApi } from "./order-centers-fixture";
import { loginErp, changeErpRights } from "./erp-identity-fixture";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => expect(pageErrors.get(page) ?? []).toEqual([]));
async function fixture() {
  const f = await salesLaunchFixture({ pillow: true });
  try {
    await f.finish();
    const path = `sales-plans/${f.planId}/launch/delivery`,
      state = await centerApi<SalesPlanDelivery>(path);
    expect(state.issues).toEqual([]);
    const { review } = await centerApi<{ review: DeliveryReview }>(path + "/review", {
      expectedRevision: state.revision,
      expectedFingerprint: state.fingerprint,
      listingVersionId: state.listing!.versionId,
      imageEvidence: state.images.map((i) => ({
        assetId: i.id,
        kind: i.main ? "finished_photo" : "mockup",
      })),
      checks: { skuFacts: true, customization: true, images: true, copyClaims: true },
      note: "Synthetic isolated channel prerequisite; not marketplace or factory approval",
      idempotencyKey: randomUUID(),
    });
    const pack = await centerApi<{ packageId: string; checksum: string }>(path + "/seal", {
      reviewId: review.id,
      skuId: f.recipe.skuId,
      expectedFingerprint: state.fingerprint,
      idempotencyKey: randomUUID(),
    });
    const accountId = createEntityId();
    await withTenant(f.database.db, f.context, (tx) =>
      tx.insert(marketplaceAccounts).values({
        id: accountId,
        tenantId: f.context.tenantId,
        platform: "amazon",
        displayName: "Synthetic mapping shop " + accountId.slice(-6),
        region: "NA",
        authorizationMode: "amazon_private",
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdBy: f.context.userId,
      }),
    );
    const [sealed] = await withTenant(f.database.db, f.context, (tx) =>
      tx.select().from(salesPackageVersions).where(eq(salesPackageVersions.id, pack.packageId)),
    );
    const delivery = OrderSalesDeliverySnapshotSchema.parse(sealed!.snapshot.salesPlanDelivery);
    return {
      ...f,
      pack,
      accountId,
      externalSku:
        delivery.skuMapping.find((m) => m.skuId === f.recipe.skuId)?.platformSkuCode ||
        f.recipe.skuCode,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
async function open(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await loginErp(page, "operator", `/product-development?sku=${f.recipe.skuId}`);
  await expect(page.getByRole("heading", { name: f.recipe.skuCode, exact: true })).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: /^登记映射$/ })
    .click();
  const form = page.getByRole("form", { name: "登记店铺 SKU 映射" });
  await form
    .getByRole("combobox", { name: "渠道资料包", exact: true })
    .selectOption(f.pack.packageId);
  await form.getByRole("combobox", { name: "店铺", exact: true }).selectOption(f.accountId);
  await form.getByLabel("平台销售 SKU", { exact: true }).fill(f.externalSku);
  await form.getByLabel("平台 Listing 编号", { exact: true }).fill("SYNTHETIC-LISTING");
  await form.locator('input[name="effective"]').fill("2026-02-01T08:00");
  await form
    .getByLabel("登记依据", { exact: true })
    .fill("Synthetic operator record; no marketplace write");
  await expect(form.getByRole("region", { name: "映射只读预检" })).toContainText(f.pack.checksum);
  await expect(form.getByRole("button", { name: "登记映射", exact: true })).toBeEnabled();
  return form;
}
test("preflight preserves future intervals; an accepted-but-unconfirmed write retries the same key exactly once", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture();
  try {
    for (const effectiveFrom of ["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"])
      await centerApi("product-development/channels", {
        packageId: f.pack.packageId,
        accountId: f.accountId,
        externalSku: f.externalSku,
        externalListingId: "SYNTHETIC-LISTING",
        customChoice: {},
        effectiveFrom,
        evidence: "Synthetic existing timeline",
        idempotencyKey: randomUUID(),
      });
    const form = await open(page, f),
      preview = form.getByRole("region", { name: "映射只读预检" });
    await expect(preview).toContainText("随后映射");
    const bindings = () =>
      withTenant(f.database.db, f.context, (tx) =>
        tx
          .select()
          .from(salesChannelBindings)
          .where(eq(salesChannelBindings.accountId, f.accountId)),
      );
    expect(await bindings()).toHaveLength(2);
    const keys: string[] = [];
    let unknown = true;
    await page.route("**/api/product-development/channels", async (route) => {
      keys.push(route.request().postDataJSON().idempotencyKey);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (unknown) {
        unknown = false;
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic response lost after native commit" }),
        });
      } else await route.fulfill({ response });
    });
    await form.getByRole("button", { name: "登记映射", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("结果尚未确认");
    expect(await bindings()).toHaveLength(3);
    await form.getByRole("button", { name: "重试原登记请求", exact: true }).click();
    await expect(form.getByRole("button", { name: "已登记", exact: true })).toBeDisabled();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(await bindings()).toHaveLength(3);
    await expect(preview).toContainText("这个生效时间已有映射");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await form.scrollIntoViewIfNeeded();
      await form.screenshot({ path: info.outputPath(`mapping-${width}.png`) });
      const saved = form.getByRole("button", { name: "已登记", exact: true });
      await saved.scrollIntoViewIfNeeded();
      await expect(saved).toBeVisible();
      const buttonBox = await saved.boundingBox(),
        footerBox = await page.locator(".task-drawer-footer").boundingBox();
      expect(buttonBox && footerBox && buttonBox.y + buttonBox.height <= footerBox.y + 1).toBe(
        true,
      );
      await preview.screenshot({ path: info.outputPath(`mapping-preview-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  } finally {
    await f.close();
  }
});

test("a temporary detail failure preserves draft values; invalid choices and revoked read rights stop registration and late previews", async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    const form = await open(page, f);
    let fail = true;
    await page.route(`**/api/product-development/skus/${f.recipe.skuId}`, async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic temporary verification failure" }),
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(form).toBeHidden();
    await page.getByRole("button", { name: "重试资料核对", exact: true }).click();
    await expect(form).toBeVisible();
    await expect(form.getByLabel("登记依据", { exact: true })).toHaveValue(
      "Synthetic operator record; no marketplace write",
    );
    await form.getByLabel("Custom 选款字段（可留空）", { exact: true }).fill("invented");
    await form.getByLabel("Custom 选款值", { exact: true }).fill("invented");
    await expect(form.getByRole("alert")).toContainText("封存方案未配置选款");
    await expect(form.getByRole("button", { name: "登记映射", exact: true })).toBeDisabled();
    await form.getByLabel("Custom 选款字段（可留空）", { exact: true }).fill("");
    await expect(form.getByRole("region", { name: "映射只读预检" })).toContainText(f.pack.checksum);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve)),
      held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/product-development/channels/preview", async (route) => {
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await form.getByLabel("平台 Listing 编号", { exact: true }).fill("SECOND-SYNTHETIC-LISTING");
    await started;
    await changeErpRights(
      "operator",
      Object.values(Permission).filter((p) => p !== Permission.ListingRead),
    );
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await expect(form).toHaveCount(0);
    release();
    await expect(
      page.getByText("需要商品、设计与 Listing 读取权限才能查看资料包", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(f.pack.checksum, { exact: false })).toHaveCount(0);
    expect(
      await withTenant(f.database.db, f.context, (tx) =>
        tx
          .select()
          .from(salesChannelBindings)
          .where(eq(salesChannelBindings.accountId, f.accountId)),
      ),
    ).toHaveLength(0);
  } finally {
    release?.();
    await changeErpRights("operator", Object.values(Permission));
    await f.close();
  }
});
