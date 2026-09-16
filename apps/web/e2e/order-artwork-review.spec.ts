import { expect, test, type Page } from "@playwright/test";
import { OrderWorkActionInputSchema } from "@yummyai/contracts/order/workspace";
import {
  ProductionEditorDetailViewSchema,
  type ProductionEditorRenderView,
} from "@yummyai/contracts/pod/production-editor-api";
import { createProductionDocument } from "../src/features/production-editor/production-editor-model";
import { fixture, id } from "./order-review-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";

// Isolated in-memory transport for the real orders/artwork UI. API integration
// tests separately cover tenant permissions, immutable versions and review writes.
async function artworkFixture(page: Page, hasPreview = true) {
  const state = await fixture(page, 1);
  const record = state.records[0]!;
  Object.assign(record.line, {
    preparation: "pushed",
    artwork: "in_review",
    editorProjectId: id(200),
  });
  const now = "2026-09-15T01:00:00.000Z";
  const document = createProductionDocument("shaped_pillow");
  document.exportBackground = "white";
  const version = { id: id(202), versionNumber: 2, createdAt: now, reviewed: false };
  const composed: ProductionEditorRenderView = {
    id: id(210),
    versionId: version.id,
    purpose: "preview",
    status: "completed",
    errorCode: null,
    createdAt: now,
    files: [{ key: "result", name: "synthetic-sheet.png", mediaType: "image/png", byteSize: 100 }],
    preflight: { productionReady: true, widthPx: 3600, heightPx: 2100, issues: [] },
  };
  const editor = ProductionEditorDetailViewSchema.parse({
    project: {
      id: id(200),
      name: "Synthetic artwork review",
      productType: "shaped_pillow",
      currentVersionId: version.id,
      versionNumber: 2,
      source: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    },
    version: { ...version, document },
    versions: [version, { ...version, id: id(201), versionNumber: 1 }],
    images: [],
    fonts: [],
    renders: [
      { ...composed, id: id(211), versionId: id(201), createdAt: "2026-09-15T03:00:00.000Z" },
      { ...composed, id: id(212), purpose: "image_edit", createdAt: "2026-09-15T04:00:00.000Z" },
      ...(hasPreview ? [composed] : []),
    ],
  });
  const actions: ReturnType<typeof OrderWorkActionInputSchema.parse>[] = [];
  const renders: Array<Record<string, unknown>> = [];
  let failAction = false,
    failImage = false;
  await page.route(`**/api/production-editor/projects/${id(200)}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.includes("/files/"))
      return route.fulfill(
        failImage ? { status: 503 } : { contentType: "image/png", body: syntheticProductionPng() },
      );
    if (request.method() === "POST" && path.endsWith("/renders")) {
      renders.push(request.postDataJSON());
      editor.renders.push(composed);
      return route.fulfill({ json: composed });
    }
    if (request.method() !== "GET") throw new Error(`Unexpected synthetic editor write: ${path}`);
    return route.fulfill({ json: editor });
  });
  await page.route(`**/api/order-centers/lines/${record.line.id}/actions`, async (route) => {
    const input = OrderWorkActionInputSchema.parse(route.request().postDataJSON());
    actions.push(input);
    if (failAction) {
      failAction = false;
      return route.fulfill({ status: 409, json: { message: "版本状态已变化，请重新核对" } });
    }
    expect(input.expectedEditorVersionId).toBe(version.id);
    const from = record.line.artwork;
    record.line.artwork =
      input.action === "approve_artwork"
        ? "approved"
        : input.action === "reject_artwork"
          ? "changes_requested"
          : "in_review";
    record.line.projectionVersion += 1;
    editor.version.reviewed = input.action === "approve_artwork";
    record.events.push({
      id: id(300 + actions.length),
      action: input.action,
      from,
      to: record.line.artwork,
      revision: record.line.revision,
      reason: input.reason,
      actor: "Synthetic reviewer",
      occurredAt: now,
    });
    return route.fulfill({ json: record });
  });
  return {
    ...state,
    editor,
    actions,
    renders,
    record,
    failNextAction: () => {
      failAction = true;
    },
    failImages: (value: boolean) => {
      failImage = value;
    },
  };
}

test("operators see the current sheet on entry and reject with a reason or approve without opening the editor", async ({
  page,
}, testInfo) => {
  const state = await artworkFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseImage!: () => void;
  const imageReady = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route(`**/renders/${id(210)}/files/result*`, async (route) => {
    await imageReady;
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/orders?stage=in_review&line=${id(1)}&queue=${id(1)}&detailMode=artwork`, {
    waitUntil: "domcontentloaded",
  });
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
  releaseImage();
  const image = review.getByRole("img", { name: "当前生产图 V2" });
  await expect(image).toBeVisible();
  expect(await image.getAttribute("src")).toContain(`/renders/${id(210)}/`);
  expect((await image.boundingBox())!.y + (await image.boundingBox())!.height).toBeLessThan(1000);
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeEnabled();
  await expect(review.getByRole("button", { name: "驳回修改", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "开始分析", exact: true })).toHaveCount(0);
  await review.getByRole("button", { name: "原尺寸查看" }).click();
  await expect(review.locator(".oc-artwork-preview")).toHaveAttribute("data-zoom", "true");
  await review.getByRole("button", { name: "适应窗口" }).click();
  await page.screenshot({ path: testInfo.outputPath("review-desktop.png") });
  await review.getByLabel("驳回理由", { exact: true }).fill("裁剪线不够圆滑，请修正底部弧线。");
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
  state.failNextAction();
  await review.getByRole("button", { name: "驳回修改", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "版本状态已变化" })).toBeVisible();
  await expect(review.getByLabel("驳回理由", { exact: true })).toHaveValue(
    "裁剪线不够圆滑，请修正底部弧线。",
  );
  await review.getByRole("button", { name: "驳回修改", exact: true }).click();
  await expect(review.getByText("上次驳回：裁剪线不够圆滑，请修正底部弧线。")).toBeVisible();
  expect(state.record.line.artwork).toBe("changes_requested");
  await review.getByRole("button", { name: "提交文件审核", exact: true }).click();
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeEnabled();
  await review.getByRole("button", { name: "通过审核", exact: true }).click();
  await expect(review.getByText("运营已通过此稿，可继续生成正式生产文件。")).toBeVisible();
  expect(state.actions.map((action) => action.action)).toEqual([
    "reject_artwork",
    "reject_artwork",
    "submit_artwork",
    "approve_artwork",
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await image.scrollIntoViewIfNeeded();
  const overflow = await page
    .locator(".oc-review-body")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("review-mobile.png") });
  await review.getByLabel("驳回理由", { exact: true }).scrollIntoViewIfNeeded();
  await expect(review.getByLabel("驳回理由", { exact: true })).toBeInViewport();
  await expect(review.getByRole("button", { name: "驳回修改", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("review-mobile-controls.png") });
  expect(state.renders).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(errors).toEqual([]);
});

test("artwork center refuses stale images and failed loads, generates only the current white preview, and shows quality blockers", async ({
  page,
}) => {
  const state = await artworkFixture(page, false);
  state.failImages(true);
  await page.goto(`/order-artwork?line=${id(1)}&queue=${id(1)}`);
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  await expect(review.getByText("当前版本尚无可查看的生产图")).toBeVisible();
  await expect(review.getByRole("img")).toHaveCount(0);
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
  await review.getByRole("button", { name: "生成当前预览", exact: true }).click();
  await expect(review.getByText("生产图加载失败")).toBeVisible();
  expect(state.renders).toEqual([
    {
      expectedVersionId: id(202),
      purpose: "preview",
      format: "png",
      background: "white",
      previewFullResolution: true,
    },
  ]);
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
  state.failImages(false);
  await review.getByRole("button", { name: "重新加载图片", exact: true }).click();
  await expect(review.getByRole("img", { name: "当前生产图 V2" })).toBeVisible();
  const composed = state.editor.renders.find((render) => render.id === id(210))!;
  composed.preflight = {
    productionReady: false,
    widthPx: 3600,
    heightPx: 2100,
    issues: [
      { code: "physical_size", severity: "manual", message: "请核对实际尺寸。" },
      {
        code: "insufficient_image_resolution",
        severity: "error",
        message: "图片实际清晰度 122 PPI，低于要求 150 DPI。",
      },
    ],
  };
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(review.getByText("图片实际清晰度 122 PPI，低于要求 150 DPI。")).toBeVisible();
  await expect(review.locator(".oc-artwork-issues li").first()).toContainText("122 PPI");
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
  expect(state.actions).toEqual([]);
});
