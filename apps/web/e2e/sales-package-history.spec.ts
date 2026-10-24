import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { withTenant, salesPackageVersions } from "@yummyai/database";
import { createEntityId } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz";
import type {
  SalesPlanDelivery,
  DeliveryReview,
} from "@yummyai/contracts/catalog/sales-plan-delivery";
import type { SalesPlanDetail } from "@yummyai/contracts/catalog/sales-plan";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";
import { centerApi } from "./order-centers-fixture";
import { changeErpRights, identityControl, loginErp } from "./erp-identity-fixture";

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on("pageerror", (error) => list.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page) ?? []).toEqual([]));
const region = (page: Page) =>
  page.getByRole("region", { name: "刊登与定制交付核对", exact: true });
const history = (page: Page) => page.getByRole("region", { name: "历史封存资料包", exact: true });
async function sealedFixture() {
  const fixture = await salesLaunchFixture({ pillow: true });
  try {
    await fixture.finish();
    const path = `sales-plans/${fixture.planId}/launch/delivery`,
      state = await centerApi<SalesPlanDelivery>(path);
    expect(state.issues).toEqual([]);
    const { review } = await centerApi<{ review: DeliveryReview }>(path + "/review", {
      expectedRevision: state.revision,
      expectedFingerprint: state.fingerprint,
      listingVersionId: state.listing!.versionId,
      imageEvidence: state.images.map((image) => ({
        assetId: image.id,
        kind: image.main ? "finished_photo" : "mockup",
      })),
      checks: { skuFacts: true, customization: true, images: true, copyClaims: true },
      note: "Synthetic isolated operator attestation; not marketplace or factory approval",
      idempotencyKey: randomUUID(),
    });
    const pack = await centerApi<{ packageId: string; checksum: string }>(path + "/seal", {
      reviewId: review.id,
      skuId: fixture.recipe.skuId,
      expectedFingerprint: state.fingerprint,
      idempotencyKey: randomUUID(),
    });
    return { ...fixture, path, review, pack };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
async function download(
  page: Page,
  info: TestInfo,
  link: ReturnType<Page["getByRole"]>,
  name: string,
) {
  const waiting = page.waitForEvent("download");
  await link.click();
  const result = await waiting;
  const file = info.outputPath(name);
  await result.saveAs(file);
  expect(await result.failure()).toBeNull();
  return JSZip.loadAsync(readFileSync(file), { checkCRC32: true });
}

test("original reviewed package survives SKU removal and downloads exact pinned files; failures remain in the workbench", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await sealedFixture();
  try {
    await loginErp(
      page,
      "operator",
      `/sales-plans?plan=${f.planId}&view=tasks#sales-plan-delivery`,
    );
    await expect(region(page).getByRole("link", { name: /下载当前交付包/ })).toBeVisible();
    const original = await centerApi<SalesPlanDelivery>(f.path),
      pinned = original.packages.find((p) => p.id === f.pack.packageId)!;
    const currentZip = await download(
      page,
      info,
      region(page).getByRole("link", { name: /下载当前交付包/ }),
      "current.zip",
    );
    const manifest = JSON.parse(await currentZip.file("manifest.json")!.async("string"));
    expect(manifest.salesPlanDelivery.review.id).toBe(f.review.id);
    const current = await centerApi<SalesPlanDetail>(`sales-plans/${f.planId}`);
    await centerApi(`sales-plans/${f.planId}`, {
      fields: { ...current.plan.fields, skuIds: [], patternChoices: undefined },
      expectedRevision: current.plan.revision,
      idempotencyKey: randomUUID(),
    });
    await region(page).getByRole("button", { name: "刷新交付核对", exact: true }).click();
    const row = history(page).getByRole("row").filter({ hasText: pinned.checksum });
    await expect(row).toContainText("历史封存");
    await expect(row).toContainText(f.recipe.skuCode);
    await expect(region(page).getByRole("link", { name: /下载当前交付包/ })).toHaveCount(0);
    const link = row.getByRole("link", { name: "下载原包", exact: true }),
      href = await link.getAttribute("href");
    expect(href).toContain("basis=history");
    let failed = false;
    await page.route(
      `**/api/sales-plans/${f.planId}/launch/delivery/packages/${pinned.id}/export?basis=history`,
      async (route) => {
        if (failed) return route.continue();
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic temporary history transport failure" }),
        });
      },
    );
    await link.click();
    await expect(region(page).getByRole("alert")).toContainText(
      "Synthetic temporary history transport failure",
    );
    expect(page.url()).toContain(`/sales-plans?plan=${f.planId}`);
    const archived = await download(page, info, link, "historical.zip");
    expect(JSON.parse(await archived.file("manifest.json")!.async("string"))).toEqual(manifest);
    for (const name of Object.keys(currentZip.files).filter((name) => !currentZip.files[name]!.dir))
      expect(await archived.file(name)!.async("nodebuffer")).toEqual(
        await currentZip.file(name)!.async("nodebuffer"),
      );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await history(page).scrollIntoViewIfNeeded();
      await history(page).screenshot({ path: info.outputPath(`history-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await f.mutateAsset();
    await link.click();
    await expect(region(page).getByRole("alert")).toContainText("封存素材不可用");
    await expect(row).toBeVisible();
  } finally {
    await f.close();
  }
});

test("history paginates independently from current package and a late page cannot populate another plan", async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await sealedFixture();
  try {
    const [pack] = await withTenant(f.database.db, f.context, (tx) =>
      tx.select().from(salesPackageVersions).where(eq(salesPackageVersions.id, f.pack.packageId)),
    );
    if (!pack) throw Error("Synthetic sealed source missing");
    // Extra immutable prior snapshots exist solely to exercise the page boundary, not new operator approvals.
    await withTenant(f.database.db, f.context, (tx) =>
      tx.insert(salesPackageVersions).values(
        Array.from({ length: 27 }, (_, i) => ({
          ...pack,
          id: createEntityId(),
          versionNumber: pack.versionNumber + i + 1,
          createdAt: new Date(Date.now() + i * 1000),
        })),
      ),
    );
    await loginErp(
      page,
      "operator",
      `/sales-plans?plan=${f.planId}&view=tasks#sales-plan-delivery`,
    );
    const current = region(page).getByRole("link", { name: /下载当前交付包/ });
    await expect(current).toContainText("V29");
    await expect(history(page).getByRole("row")).toHaveCount(26);
    await history(page).getByRole("button", { name: "下一页", exact: true }).click();
    await expect(history(page)).toContainText("第 2 页");
    await expect(history(page).getByRole("row")).toHaveCount(5);
    await expect(current).toContainText("V29");
    await history(page).getByRole("button", { name: "上一页", exact: true }).click();
    await expect(history(page)).toContainText("第 1 页");
    const second = await centerApi<SalesPlanDetail>("sales-plans", {
      spuId: f.spu.id,
      fields: { name: "Synthetic independent history plan", mode: "custom", fulfillment: "fbm" },
      idempotencyKey: randomUUID(),
    });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    await page.route(
      `**/api/sales-plans/${f.planId}/launch/delivery?packagePage=2`,
      async (route) => {
        const response = await route.fetch();
        entered();
        await held;
        await route.fulfill({ response }).catch(() => {});
      },
    );
    await history(page).getByRole("button", { name: "下一页", exact: true }).click();
    await started;
    await page.evaluate(
      (id) => window.history.pushState(null, "", `/sales-plans?plan=${id}&view=tasks`),
      second.plan.id,
    );
    await expect(history(page)).toContainText("本方案还没有封存资料包");
    release();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(history(page)).toContainText("本方案还没有封存资料包");
    await expect(history(page)).not.toContainText(f.recipe.skuCode);
  } finally {
    await f.close();
  }
});

test("current identity withdrawal clears history and cancels late private download bytes", async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await sealedFixture(),
    received: string[] = [];
  page.on("download", (d) => received.push(d.suggestedFilename()));
  let release: (() => void) | undefined;
  try {
    await loginErp(
      page,
      "operator",
      `/sales-plans?plan=${f.planId}&view=tasks#sales-plan-delivery`,
    );
    const row = history(page).getByRole("row").filter({ hasText: f.pack.checksum });
    await expect(row).toBeVisible();
    let entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    await page.route(
      `**/api/sales-plans/${f.planId}/launch/delivery/packages/${f.pack.packageId}/export?basis=history`,
      async (route) => {
        const response = await route.fetch();
        entered();
        await held;
        await route.fulfill({ response }).catch(() => {});
      },
    );
    await row.getByRole("link", { name: "下载原包", exact: true }).click();
    await started;
    await changeErpRights("operator", [Permission.ProductRead]);
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await expect(history(page)).toHaveCount(0);
    release();
    const { access_token: token } = await identityControl("token", { account: "operator" });
    const denied = await fetch(
      `${process.env.API_BASE_URL}/v1/${f.path}/packages/${f.pack.packageId}/export?basis=history`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(denied.status).toBe(403);
    // A scope refresh may navigate; wait for the newly authorized DOM, not an old window callback.
    await expect(region(page)).toContainText("读取交付核对需要商品、设计、素材和刊登读取权限");
    expect(received).toEqual([]);
    await expect(region(page)).not.toContainText(f.pack.checksum);
  } finally {
    release?.();
    await changeErpRights("operator", Object.values(Permission));
    await f.close();
  }
});
