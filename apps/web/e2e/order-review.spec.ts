import { expect, test } from "@playwright/test";
import { fixture, id, imageReviewFixture, imageUploadPng } from "./order-review-fixture";
import { loginErp } from "./erp-identity-fixture";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";

test("store deep link keeps its selected account after delayed options and a new query", async ({
  page,
}) => {
  const state = await fixture(page);
  let releaseOptions!: () => void;
  const pendingOptions = new Promise<void>((resolve) => {
    releaseOptions = resolve;
  });
  await page.route("**/api/order-centers/options", async (route) => {
    await pendingOptions;
    await route.fulfill({
      json: {
        profiles: [],
        stores: [
          { id: id(99), displayName: "Synthetic source store", platform: "amazon" },
          { id: id(98), displayName: "Synthetic second store", platform: "amazon" },
        ],
        suppliers: [],
        standards: [],
        preferenceScope: "synthetic-store-return",
      },
    });
  });
  await page.goto(`/orders?platform=amazon&accountId=${id(99)}`);
  const store = page.getByLabel("店铺", { exact: true });
  try {
    await expect(store).toBeDisabled();
    await expect(store).toHaveValue(id(99));
    await expect(page.getByRole("button", { name: "查询", exact: true })).toBeDisabled();
  } finally {
    releaseOptions();
  }
  await expect(store).toBeEnabled();
  await expect(store.locator("option:checked")).toHaveText("Synthetic source store");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`accountId=${id(99)}`));
  await store.selectOption(id(98));
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`accountId=${id(98)}`));
  await expect(store.locator("option:checked")).toHaveText("Synthetic second store");
  expect(state.unexpectedWrites).toEqual([]);
});

test("review stays over the same list and protects unsaved changes when switching or closing", async ({
  page,
}) => {
  const state = await fixture(page, 6);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/orders?preparation=pending_review&q=SYNTHETIC");
  const trigger = page.getByRole("button", { name: "SYNTHETIC-REVIEW-3", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  const table = await page.locator(".oc-order-list").elementHandle();
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-3" })).toBeVisible();
  await drawer.getByLabel("制作说明", { exact: true }).fill("Unsaved operator instructions");
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByLabel("制作说明", { exact: true })).toHaveValue(
    "Unsaved operator instructions",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "返回订单中心" }).click();
  await expect(drawer).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-4" })).toBeVisible();
  await drawer.getByRole("button", { name: "上一单", exact: true }).click();
  await expect(drawer.getByLabel("制作说明", { exact: true })).toHaveValue(
    "Original instructions 3",
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.getByLabel("搜索订单", { exact: true })).toHaveValue("SYNTHETIC");
  await expect(page).toHaveURL(/preparation=pending_review&q=SYNTHETIC$/);
  expect(
    await table?.evaluate((element) => element === document.querySelector(".oc-order-list")),
  ).toBe(true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scroll)).toBeLessThan(2);
  expect(state.workspaceReads()).toBe(1);
  expect(state.saves).toEqual([]);
});

test("successful saves keep the order open and manual navigation preserves a stable queue", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await page.goto("/orders?preparation=pending_review&q=SYNTHETIC");
  await page.getByRole("button", { name: "开始处理订单", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await drawer.getByLabel("制作说明", { exact: true }).fill("Confirmed first-order instructions");
  state.failNextSave();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("Synthetic save conflict");
  await expect(drawer.getByLabel("制作说明", { exact: true })).toHaveValue(
    "Confirmed first-order instructions",
  );
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
  await expect(drawer.getByText("本页第 2 单 / 共 3 单", { exact: true })).toBeVisible();
  expect(state.saves[0].idempotencyKey).toBe(state.saves[1].idempotencyKey);
  await expect(page.locator(".oc-product-row")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("continuous-review-desktop.png") });
  await drawer.getByRole("button", { name: "记录待补资料", exact: true }).click();
  await expect(drawer.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-3" })).toBeVisible();
  await expect(drawer.getByText("本页第 3 单 / 共 3 单", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "返回订单中心", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByText("没有符合条件的订单。", { exact: true })).toBeVisible();
  expect(state.records.map((record) => record.line.preparation)).toEqual([
    "ready_to_push",
    "needs_information",
    "ready_to_push",
  ]);
  expect(state.saves.map((save) => save.lineId)).toEqual([id(1), id(1), id(2), id(3)]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("saving locks navigation and preserves the existing save-without-advance action", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/orders");
  await page.getByRole("button", { name: "开始处理订单", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  state.holdSave();
  try {
    await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "下一单", exact: true })).toBeDisabled();
    await expect(drawer.getByRole("button", { name: "返回订单中心" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeVisible();
  } finally {
    state.releaseSave();
  }
  await expect(drawer.getByRole("status").filter({ hasText: "审单已保存" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  expect(state.saves).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
});

test("a direct order link opens a mobile drawer with visible controls and clean boundaries", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/orders?line=${id(2)}`);
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
  await expect(drawer.getByText("本页第 2 单 / 共 3 单", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "下一单", exact: true })).toBeInViewport();
  expect(
    await drawer.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await drawer
      .locator(".oc-review-body")
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("continuous-review-mobile.png") });
  await drawer.getByRole("button", { name: "上一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "上一单", exact: true })).toBeDisabled();
  await drawer.getByRole("button", { name: "返回订单中心" }).click();
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("whole order navigation skips siblings and survives a saved order leaving the filter", async ({ page }) => {
  const state = await fixture(page, 4);
  for (const [sibling, anchor] of [[1, 0], [3, 2]] as const) {
    state.records[sibling]!.line.orderId = state.records[anchor]!.line.orderId;
    state.records[sibling]!.line.externalOrderId = state.records[anchor]!.line.externalOrderId;
    state.records[sibling]!.line.externalLineId = "2";
  }
  await page.goto("/orders?preparation=pending_review");
  await page.getByRole("button", { name: "SYNTHETIC-REVIEW-1", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  const items = drawer.getByRole("region", { name: "本单全部商品与审核稿", exact: true });
  await expect(items.locator("article")).toHaveCount(2);
  await items.getByRole("button", { name: /^商品 2 ·/ }).click();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await items.getByRole("button", { name: /^商品 1 ·/ }).click();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await expect(page.locator(".oc-order-list").getByRole("button", { name: "SYNTHETIC-REVIEW-1", exact: true })).toHaveCount(0);
  await items.getByRole("button", { name: /^商品 2 ·/ }).click();
  await expect(drawer.getByText("本页第 1 单 / 共 2 单", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-3", exact: true })).toBeVisible();
  await expect(items.locator("article")).toHaveCount(2);
  await expect(drawer.getByText("本页第 2 单 / 共 2 单", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "上一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1", exact: true })).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
});

test.describe("whole order image upload", () => {
  // Existing local-service review suites remain unchanged. This family's config
  // rejects missing isolation and its native runner supplies real personal OIDC.
  test.skip(process.env.E2E_ORDER_IMAGE_UPLOAD_ISOLATED !== "1", "Use the dedicated personal image-upload acceptance suite");
  test.beforeEach(async ({ page }) => {
    requireDisposableIntegrationEnvironment();
    expect(process.env.WEB_AUTH_MODE).toBe("personal");
    await loginErp(page, "operator", "/orders");
  });

  test("shows native original defaults and preserves a saved explicit empty selection", async ({ page }) => {
    const state = await imageReviewFixture(page);
    await page.goto(`/orders?line=${id(1)}`);
    const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
    const first = drawer.getByRole("checkbox", { name: "original-first.png", exact: true });
    const second = drawer.getByRole("checkbox", { name: "original-second.png", exact: true });
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();
    await expect(drawer.getByRole("checkbox", { name: "unlinked-buyer.png", exact: true })).not.toBeChecked();
    await expect(drawer.getByRole("checkbox", { name: "platform-preview.png", exact: true })).toHaveCount(0);
    await first.uncheck();
    await second.uncheck();
    await drawer.getByRole("button", { name: "记录待补资料", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]!.draft.images).toEqual([]);
    expect(state.records[0]!.versions).toHaveLength(1);
    await page.reload();
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    expect(state.records[0]!.line.revision).toBe(1);
    expect(state.uploads).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
  });

  test("uploads before the first save while retaining dirty fields notes and canceled originals", async ({ page }, testInfo) => {
    const state = await imageReviewFixture(page);
    await page.goto(`/orders?line=${id(1)}`);
    const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
    const first = drawer.getByRole("checkbox", { name: "original-first.png", exact: true });
    const second = drawer.getByRole("checkbox", { name: "original-second.png", exact: true });
    await first.uncheck();
    await second.uncheck();
    const check = drawer.getByRole("region", { name: "定制订单承接核对", exact: true });
    await expect(check.getByRole("list", { name: "承接待办", exact: true })).toContainText("顾客原图");
    await expect(drawer.getByRole("button", { name: "确认本件审单", exact: true })).toBeDisabled();
    expect(state.saves).toEqual([]);
    await first.check();
    await expect(check.getByRole("list", { name: "承接待办", exact: true })).toHaveCount(0);
    await drawer.locator("summary").filter({ hasText: /^高级修改与原始字段/ }).click();
    await drawer.getByRole("textbox", { name: "定制内容", exact: true }).fill("Unsaved buyer lettering");
    await drawer.getByRole("textbox", { name: "制作说明", exact: true }).fill("Unsaved operator instructions");
    await expect(drawer.getByRole("button", { name: "上传定制图片", exact: true })).toBeEnabled();
    await drawer.getByLabel("上传订单定制图片", { exact: true }).setInputFiles({
      name: "synthetic-dirty.png", mimeType: "image/png", buffer: imageUploadPng,
    });
    const uploaded = drawer.locator(".oc-image").filter({ has: page.getByRole("checkbox", { name: "synthetic-dirty.png", exact: true }) });
    await expect(uploaded.getByRole("checkbox")).toBeChecked();
    await expect(uploaded.getByRole("combobox", { name: "对应图片字段", exact: true })).toHaveValue("buyer_photo");
    await expect(first).toBeChecked();
    await expect(second).not.toBeChecked();
    await expect(drawer.getByRole("textbox", { name: "定制内容", exact: true })).toHaveValue("Unsaved buyer lettering");
    await expect(drawer.getByRole("textbox", { name: "制作说明", exact: true })).toHaveValue("Unsaved operator instructions");
    expect(state.records[0]!.line.revision).toBe(0);
    expect(state.saves).toHaveLength(0); // Preflight blocked the invalid draft before any save POST.
    await drawer.getByRole("button", { name: "记录待补资料", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
    expect(state.saves[0]!.draft).toMatchObject({
      fields: [{ key: "name", label: "Customer name", kind: "text", value: "Unsaved buyer lettering", font: "Synthetic Serif", color: "#336699" }],
      instructions: "Unsaved operator instructions",
      images: [{ origin: "report", key: "buyer-first", usage: "buyer_photo" },
        { origin: "upload", key: state.records[0]!.assets[0]!.id, usage: "buyer_photo" }],
    });
    expect(state.uploads).toHaveLength(1);
    expect(state.unexpectedWrites).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("order-image-upload-dirty-desktop.png") });
  });

  test("keeps multiple image fields pending and retries the same file after cancellation and failure", async ({ page }, testInfo) => {
    const state = await imageReviewFixture(page, { multipleFields: true, persistedEmpty: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/orders?line=${id(1)}`);
    const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
    const upload = drawer.getByRole("button", { name: "上传定制图片", exact: true });
    await expect(upload).toBeEnabled();
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    await (await chooser).setFiles([]);
    expect(state.uploads).toEqual([]);
    await expect(upload).toBeEnabled();
    await drawer.locator("summary").filter({ hasText: /^高级修改与原始字段/ }).click();
    await drawer.getByRole("textbox", { name: "定制内容", exact: true }).fill("Retain after a failed upload");
    await drawer.getByRole("textbox", { name: "制作说明", exact: true }).fill("Notes survive failed upload");
    const input = drawer.getByLabel("上传订单定制图片", { exact: true });
    const file = { name: "synthetic-retry.png", mimeType: "image/png", buffer: imageUploadPng };
    state.failNextUpload();
    await input.setInputFiles(file);
    await expect(drawer.getByRole("alert")).toHaveText("服务器暂时无法完成操作，请保留填写内容后重试。");
    await expect(input).toHaveValue("");
    await expect(drawer.getByRole("textbox", { name: "定制内容", exact: true })).toHaveValue("Retain after a failed upload");
    await expect(drawer.getByRole("textbox", { name: "制作说明", exact: true })).toHaveValue("Notes survive failed upload");
    await input.setInputFiles(file);
    const uploaded = drawer.locator(".oc-image").filter({ has: page.getByRole("checkbox", { name: file.name, exact: true }) });
    await expect(uploaded.getByRole("checkbox")).toBeChecked();
    const binding = uploaded.getByRole("combobox", { name: "对应图片字段", exact: true });
    await expect(binding).toHaveValue("");
    await expect(uploaded.getByRole("status")).toHaveText("已选此图，尚未绑定图片字段；请明确选择，原用途不会自动改写。");
    await drawer.getByRole("button", { name: "记录待补资料", exact: true }).click();
    await expect(drawer.getByRole("alert")).toHaveText("请为已选图片选择对应图片字段，再核对或保存；暂不使用的图片可取消勾选。");
    expect(state.saves).toEqual([]);
    await binding.selectOption("back_photo");
    await drawer.getByRole("button", { name: "记录待补资料", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]!.draft.images).toEqual([{ origin: "upload", key: state.records[0]!.assets[0]!.id, usage: "back_photo" }]);
    expect(state.uploads.map((item) => item.name)).toEqual([file.name, file.name]);
    expect(state.unexpectedWrites).toEqual([]);
    expect(await drawer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("order-image-upload-multiple-mobile.png") });
  });

  test("rejects late upload details for a different order revision or report source", async ({ page }) => {
    const state = await imageReviewFixture(page);
    await page.goto(`/orders?line=${id(1)}`);
    const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
    await drawer.locator("summary").filter({ hasText: /^高级修改与原始字段/ }).click();
    const originalFields = drawer.getByRole("textbox", { name: "定制内容", exact: true });
    await originalFields.fill("Local content must remain");
    await drawer.getByRole("textbox", { name: "制作说明", exact: true }).fill("Local note must remain");
    await drawer.getByRole("checkbox", { name: "original-second.png", exact: true }).uncheck();
    for (const [index, kind] of (["order", "revision", "source"] as const).entries()) {
      const name = `synthetic-stale-${kind}.png`;
      state.mismatchNextUpload(kind);
      state.holdNextUpload();
      try {
        await drawer.getByLabel("上传订单定制图片", { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer: imageUploadPng });
        await expect.poll(() => state.uploads.length).toBe(index + 1);
        await expect(drawer.getByRole("button", { name: "正在上传图片…", exact: true })).toBeDisabled();
      } finally {
        state.releaseUpload();
      }
      await expect(drawer.getByRole("button", { name: "上传定制图片", exact: true })).toBeEnabled();
      await expect(drawer.getByRole("alert")).toHaveText("上传返回的订单版本或来源已变化，当前填写仍保留；请核对原上传结果，不重复上传或自动覆盖草稿。");
      await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1", exact: true })).toBeVisible();
      await expect(originalFields).toHaveValue("Local content must remain");
      await expect(drawer.getByRole("textbox", { name: "制作说明", exact: true })).toHaveValue("Local note must remain");
      await expect(drawer.getByRole("checkbox", { name, exact: true })).toHaveCount(0);
      await expect(drawer.getByRole("checkbox", { name: "original-second.png", exact: true })).not.toBeChecked();
    }
    expect(state.saves).toEqual([]);
    expect(state.records[1]!.draft.instructions).toBe("Original instructions 2");
    expect(state.unexpectedWrites).toEqual([]);
  });
});
